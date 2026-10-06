import io
import cv2
import numpy as np
from fastapi.testclient import TestClient
from app.main import create_app


def _make_image_bytes(text: str = '84%') -> bytes:
    img = np.full((200, 600, 3), 255, dtype=np.uint8)
    cv2.putText(img, text, (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 3.5, (0, 0, 0), 4)
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return buf.tobytes()


def test_battery_ocr_endpoint_success(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    image_bytes = _make_image_bytes('84%')
    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['success'] is True
    assert data['battery_percent'] == 84
    assert '84%' in data['raw_text']


def test_battery_ocr_with_crop(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    image_bytes = _make_image_bytes('95%')
    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
        data={'crop_x': '0.0', 'crop_y': '0.0', 'crop_w': '1.0', 'crop_h': '1.0'},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['success'] is True
    assert data['battery_percent'] == 95


def test_battery_ocr_invalid_content_type(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.txt', b'not-an-image', 'text/plain')},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 415


def _make_pil_image_bytes(text: str) -> bytes:
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (520, 120), color=(255, 255, 255))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('arial.ttf', 32)
    except Exception:
        font = ImageFont.load_default()
    d.text((30, 35), text, fill=(0, 0, 0), font=font)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=95)
    return buf.getvalue()


def test_battery_ocr_recognizes_full_charge_as_100(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    image_bytes = _make_pil_image_bytes('Full charge')
    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['success'] is True
    assert data['battery_percent'] == 100
    assert 'full charge' in data['raw_text'].lower()


def test_battery_ocr_recognizes_full_charge_with_100(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    image_bytes = _make_pil_image_bytes('Full charge 100%')
    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['success'] is True
    assert data['battery_percent'] == 100


def test_battery_ocr_full_charge_conflicting_retake(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    image_bytes = _make_pil_image_bytes('Full charge 75%')
    response = client.post(
        '/api/battery-ocr',
        files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
        headers={'Origin': 'https://localhost:5173'},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['success'] is False
    assert data['battery_percent'] is None
    assert 'conflicting readings' in data['error'].lower() or 'retake' in data['error'].lower()


def test_battery_ocr_does_not_treat_charging_or_full_as_100(tmp_path):
    workbook = tmp_path / 'test.xlsx'
    app = create_app(str(workbook))
    client = TestClient(app, base_url='http://localhost:8000')

    for phrase in ['Charging', 'Charge', 'Full']:
        image_bytes = _make_pil_image_bytes(phrase)
        response = client.post(
            '/api/battery-ocr',
            files={'image': ('battery.jpg', image_bytes, 'image/jpeg')},
            headers={'Origin': 'https://localhost:5173'},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data['success'] is False
        assert data['battery_percent'] is None


# ---------------------------------------------------------------------------
# New tests for Fix 1, 2, 4
# ---------------------------------------------------------------------------

def test_full_charge_75_conflict_is_returned_as_failure():
    """Fix 2: 'Full charge 75%' must fail with the conflict message even when a
    later CLAHE pass reads only '75%' cleanly — conflict_seen must block acceptance."""
    from app.battery_ocr import run_battery_ocr
    image_bytes = _make_pil_image_bytes('Full charge 75%')
    result = run_battery_ocr(image_bytes)
    assert result['success'] is False
    assert result['battery_percent'] is None
    # Must carry the conflict message, not the generic "could not read" text.
    err = result['error'].lower()
    assert 'conflict' in err or 'retake' in err, f"Unexpected error: {result['error']!r}"


def test_confidence_of_match_uses_lowest_matching_box_score():
    """Fix 1: _confidence_of_match must return the LOWEST score among boxes that
    contain the matched value, not the global max or first box."""
    from app.battery_ocr import _confidence_of_match

    # Two synthetic 'boxes' worth of data (no-det path → boxes=None):
    # "10:45" at score 0.30, "84%" at score 0.95.
    txts = ('10:45', '84%')
    scores = (0.30, 0.95)

    # Looking for value=84 → should return 0.95 (the high-confidence % box).
    score_84 = _confidence_of_match(txts, scores, None, 84)
    assert score_84 == 0.95, f"Expected 0.95, got {score_84}"

    # When the % box has low confidence, the returned score must also be low.
    txts2 = ('84%', '10:45')
    scores2 = (0.30, 0.95)
    score_low = _confidence_of_match(txts2, scores2, None, 84)
    assert score_low == 0.30, f"Expected 0.30, got {score_low}"


def test_mode_none_wide_strip_does_not_run_screen_detection():
    """Fix 4: When mode=None and the image is wide (w/h >= 2), the backend
    must use the live-crop heuristic and skip screen ROI detection entirely."""
    from app.battery_ocr import run_battery_ocr

    # Wide horizontal strip — same shape as a live-scanner guide crop.
    img = np.full((80, 640, 3), 255, dtype=np.uint8)
    cv2.putText(img, '73%', (200, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (0, 0, 0), 3)
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    image_bytes = buf.tobytes()

    result = run_battery_ocr(image_bytes)  # mode=None → heuristic
    timings = result.get('timings_ms', {})

    # Screen-detection stages would produce keys starting with "screen-".
    screen_stages = [k for k in timings if k.startswith('screen-')]
    assert screen_stages == [], (
        f"Wide-strip with mode=None should not run screen detection; "
        f"found stages: {screen_stages}"
    )
    # If OCR succeeded it must be 73%.
    if result['success']:
        assert result['battery_percent'] == 73
