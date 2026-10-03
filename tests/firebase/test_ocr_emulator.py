"""
tests/firebase/test_ocr_emulator.py

OCR endpoint tests against the Firebase Functions emulator.
Tests verify the /api/ocr endpoint accepts images and returns structured results.
Does NOT require a real camera image — uses synthetic test images.

Run with: pytest tests/firebase/test_ocr_emulator.py -v
(emulators must be started first: firebase emulators:start)
"""
import io
import os
import pytest
import requests
import struct
import zlib

PROJECT   = os.getenv("FIREBASE_PROJECT", "agingtest-57600")
FUNC_PORT = int(os.getenv("FUNCTIONS_EMULATOR_PORT", "5001"))
BASE = f"http://127.0.0.1:{FUNC_PORT}/{PROJECT}/us-central1/api/ocr"


def _make_png_1x1_white():
    """Create a minimal 1x1 white PNG in memory."""
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)
    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
    raw  = b'\x00\xff\xff\xff'
    comp = zlib.compress(raw, 9)
    idat = chunk(b'IDAT', comp)
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend


def _post_image(img_bytes, filename="test.png", extra=None):
    files = {"image": (filename, io.BytesIO(img_bytes), "image/png")}
    data  = extra or {}
    return requests.post(BASE, files=files, data=data, timeout=90)


def test_ocr_endpoint_reachable():
    r = _post_image(_make_png_1x1_white())
    # 200 with success=False is fine — the image is blank
    assert r.status_code == 200
    j = r.json()
    assert "success" in j
    assert "battery_percent" in j
    assert "error" in j
    assert "processing_time_ms" in j


def test_ocr_no_image_returns_400():
    r = requests.post(BASE, data={}, timeout=30)
    assert r.status_code == 400


def test_ocr_blank_image_returns_structured_failure():
    r = _post_image(_make_png_1x1_white())
    j = r.json()
    assert j["success"] is False
    assert j["battery_percent"] is None
    assert isinstance(j["error"], str)
    assert len(j["error"]) > 5


def test_ocr_with_crop_params():
    """Sending crop params with a blank image should still return a structured response."""
    r = _post_image(_make_png_1x1_white(), extra={
        "crop_x": "0.1", "crop_y": "0.0", "crop_w": "0.5", "crop_h": "0.1"
    })
    assert r.status_code == 200
    assert "success" in r.json()


def test_ocr_response_fields():
    r = _post_image(_make_png_1x1_white())
    j = r.json()
    required = {"success", "battery_percent", "confidence", "raw_text", "method", "processing_time_ms", "error", "attempts"}
    assert required.issubset(j.keys()), f"Missing fields: {required - j.keys()}"
