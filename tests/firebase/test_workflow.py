"""
tests/firebase/test_workflow.py

Integration tests for the Firebase Cloud Function workflow.
Runs against the Firebase Functions + Firestore EMULATORS.

Prerequisites:
  1. Start emulators:  firebase emulators:start
  2. Install pytest:   pip install pytest requests
  3. Run:              pytest tests/firebase/ -v

The FUNCTIONS_EMULATOR_BASE is constructed from the standard emulator port.
"""
import os
import re
import time
import json
import pytest
import requests

# ── Emulator base URL ─────────────────────────────────────────────────────────
PROJECT   = os.getenv("FIREBASE_PROJECT", "agingtest-57600")
FUNC_PORT = int(os.getenv("FUNCTIONS_EMULATOR_PORT", "5001"))
BASE = f"http://127.0.0.1:{FUNC_PORT}/{PROJECT}/us-central1/api"

SESSION = "T001RTEST00001"   # unique serial for this test run


def _post(path, data=None, form=None):
    if form:
        return requests.post(BASE + path, data=form[0], files=form[1], timeout=60)
    return requests.post(BASE + path, json=data, timeout=60)


def _get(path):
    return requests.get(BASE + path, timeout=30)


def _delete(path):
    return requests.delete(BASE + path, timeout=30)


def _capture(action, serial=None):
    body = {"action": action}
    if serial:
        body["serial_number"] = serial
    r = _post("/captures", body)
    assert r.status_code == 200, f"capture failed: {r.text}"
    tok = r.json()["capture_token"]
    assert len(tok) >= 20
    return tok


def _reading(action, serial, battery, token, **kw):
    body = {
        "serial_number": serial,
        "battery_percent": battery,
        "device_timestamp": "9:00 AM",
        "capture_token": token,
        **kw,
    }
    r = _post(f"/readings/{action}", body)
    return r


# ── health / config ───────────────────────────────────────────────────────────

def test_health():
    r = _get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_config():
    r = _get("/config")
    assert r.status_code == 200
    j = r.json()
    assert "serial_regex" in j
    assert j["checkpoint_interval_seconds"] > 0


# ── capture validation ────────────────────────────────────────────────────────

def test_capture_register_has_no_serial():
    r = _post("/captures", {"action": "register", "serial_number": SESSION})
    assert r.status_code == 400   # register must NOT supply serial

def test_capture_h1_requires_serial():
    r = _post("/captures", {"action": "h1"})
    assert r.status_code == 400   # non-register MUST supply serial

def test_capture_invalid_action():
    r = _post("/captures", {"action": "bad-action"})
    assert r.status_code == 400

def test_capture_unregistered_serial():
    r = _post("/captures", {"action": "h1", "serial_number": "NOTREGISTERED"})
    assert r.status_code == 404


# ── full happy-path workflow ──────────────────────────────────────────────────

def test_register():
    tok = _capture("register")
    r = _reading("register", SESSION, 100, tok)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["serial_number"] == SESSION
    assert d["status"] == "READY_FOR_AGING"
    assert d["last_battery"] == 100


def test_register_duplicate_rejected():
    tok = _capture("register")
    r = _reading("register", SESSION, 100, tok)
    assert r.status_code == 409
    assert "already registered" in r.json()["error"].lower()


def test_start_aging():
    tok = _capture("start-aging", SESSION)
    r = _reading("start-aging", SESSION, 100, tok)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "AGING_HOUR_1"
    assert d["aging_started"] is not None
    assert d["next_due"] is not None


def test_h1_timing_too_early():
    """H1 is due in 1 hour — should be rejected immediately."""
    tok = _capture("h1", SESSION)
    r = _reading("h1", SESSION, 90, tok)
    assert r.status_code == 409
    assert "not due yet" in r.json()["error"].lower()


def test_start_aging_wrong_battery():
    """start-aging at 85% should fail."""
    # register a fresh device first
    serial = SESSION + "B"
    tok = _capture("register")
    _reading("register", serial, 85, tok)
    tok2 = _capture("start-aging", serial)
    r = _reading("start-aging", serial, 85, tok2)
    assert r.status_code == 409
    assert "100%" in r.json()["error"]
    # cleanup
    _delete(f"/devices/{serial}")


def test_token_replay_rejected():
    """Using the same token twice must be rejected."""
    tok = _capture("start-aging", SESSION)
    # Use it once (will fail timing, but token check happens first)
    r1 = _post("/readings/start-aging", {
        "serial_number": SESSION, "battery_percent": 100,
        "device_timestamp": "9:00 AM", "capture_token": tok,
    })
    # Regardless of outcome, reusing the same token must now fail with 409
    r2 = _post("/readings/start-aging", {
        "serial_number": SESSION, "battery_percent": 100,
        "device_timestamp": "9:00 AM", "capture_token": tok,
    })
    assert r2.status_code == 409
    err = r2.json()["error"].lower()
    assert "already used" in err or "expired" in err


def test_wrong_action_for_token():
    """A token created for register must not be usable for h1."""
    tok = _capture("register")
    r = _post("/readings/h1", {
        "serial_number": SESSION, "battery_percent": 85,
        "device_timestamp": "9:00 AM", "capture_token": tok,
    })
    assert r.status_code == 409
    assert "different action" in r.json()["error"].lower()


def test_lookup_device():
    r = _get(f"/devices/{SESSION}")
    assert r.status_code == 200
    d = r.json()
    assert d["serial_number"] == SESSION
    assert len(d["values"]) == 30


def test_lookup_missing_device():
    r = _get("/devices/NOTEXIST12345")
    assert r.status_code == 404


def test_out_of_order_checkpoint_rejected():
    """H2 before H1 should fail."""
    tok = _capture("h2", SESSION)
    r = _reading("h2", SESSION, 80, tok)
    assert r.status_code == 409
    assert "order" in r.json()["error"].lower()


def test_delete_device():
    # Register a throwaway device
    serial = SESSION + "DEL"
    tok = _capture("register")
    _reading("register", serial, 100, tok)
    r = _delete(f"/devices/{serial}")
    assert r.status_code == 200
    assert r.json()["status"] == "deleted"
    # Confirm gone
    r2 = _get(f"/devices/{serial}")
    assert r2.status_code == 404


def test_delete_then_cleanup():
    """Clean up the main test device at end of suite."""
    r = _delete(f"/devices/{SESSION}")
    assert r.status_code == 200


# ── reading validation ────────────────────────────────────────────────────────

def test_invalid_battery():
    tok = _capture("register")
    r = _post("/readings/register", {
        "serial_number": SESSION + "V",
        "battery_percent": 150,
        "device_timestamp": "9:00 AM",
        "capture_token": tok,
    })
    assert r.status_code == 422


def test_invalid_device_timestamp():
    tok = _capture("register")
    r = _post("/readings/register", {
        "serial_number": SESSION + "V",
        "battery_percent": 100,
        "device_timestamp": "25:99",
        "capture_token": tok,
    })
    assert r.status_code == 422


def test_issue_yes_requires_categories():
    tok = _capture("register")
    r = _post("/readings/register", {
        "serial_number": SESSION + "V",
        "battery_percent": 100,
        "device_timestamp": "9:00 AM",
        "capture_token": tok,
        "has_issue": "yes",
        "issue_categories": [],
    })
    assert r.status_code == 422


def test_invalid_serial_rejected():
    tok = _capture("register")
    r = _post("/readings/register", {
        "serial_number": "bad serial!",
        "battery_percent": 100,
        "device_timestamp": "9:00 AM",
        "capture_token": tok,
    })
    assert r.status_code == 422
