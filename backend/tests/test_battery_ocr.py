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

