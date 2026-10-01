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
