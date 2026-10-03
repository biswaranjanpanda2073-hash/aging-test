"""
Aging-Test  -  Firebase Cloud Functions  (Python 2nd-gen)
==========================================================
Exposes one HTTP function  `api`  that handles ALL /api/* routes:

  GET  /api/health
  GET  /api/config
  POST /api/captures
  POST /api/readings/<action>        register|start-aging|h1|h2|h3|h4|post-aging
  GET  /api/devices/<serial>
  POST /api/devices/<serial>/restart
  DELETE /api/devices/<serial>
  POST /api/devices/<serial>/delete
  POST /api/ocr                      multipart/form-data, field=image

All persistent state lives in Cloud Firestore.
OCR uses the embedded RapidOCR/ONNX engine (same as the old FastAPI backend).
"""
from __future__ import annotations

import hashlib, json, logging, re, secrets, threading, time
from datetime import datetime, timezone, timedelta
from typing import Any

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options as fn_options

# ── init ──────────────────────────────────────────────────────────────────────
if not firebase_admin._apps:
    firebase_admin.initialize_app()

db = firestore.client()
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# ── config ────────────────────────────────────────────────────────────────────
SERIAL_REGEX        = r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
CAPTURE_TTL         = 180    # seconds
CHECKPOINT_SECONDS  = 3600   # 1 hour

_CORS = fn_options.CorsOptions(
    cors_origins=["*"],
    cors_methods=["GET", "POST", "DELETE", "OPTIONS"],
)

# ── OCR singleton ─────────────────────────────────────────────────────────────
_ocr: Any       = None
_ocr_ready      = threading.Event()
_ocr_error: str | None = None


def _init_ocr() -> None:
    global _ocr, _ocr_error
    try:
        import numpy as np, cv2
        from rapidocr import RapidOCR
        engine = RapidOCR()
        dummy = np.full((64, 256, 3), 255, dtype=np.uint8)
        cv2.putText(dummy, "84%", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
        engine(dummy)
        _ocr = engine
        logger.info("RapidOCR warm and ready")
    except Exception as exc:
        _ocr_error = str(exc)
        logger.error("RapidOCR init failed: %s", exc)
    finally:
        _ocr_ready.set()


threading.Thread(target=_init_ocr, name="rapidocr-init", daemon=True).start()

# ── generic helpers ───────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp() -> str:
    return _now().isoformat()


def _json(data: dict, status: int = 200) -> https_fn.Response:
    resp = https_fn.Response(
        json.dumps(data), status=status, mimetype="application/json"
    )
    resp.headers["Access-Control-Allow-Origin"]  = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp


def _err(msg: str, status: int = 400) -> https_fn.Response:
    return _json({"error": msg}, status)


def _ok_serial(serial: str) -> bool:
    return bool(re.fullmatch(SERIAL_REGEX, serial)) and len(serial) <= 64


def _sanitize(text: str | None) -> str | None:
    if text and text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text
    return text

# ── Firestore helpers ─────────────────────────────────────────────────────────

def _ref(serial: str):
    return db.collection("devices").document(serial)


def _get(serial: str) -> dict | None:
    doc = _ref(serial).get()
    return doc.to_dict() if doc.exists else None


def _values(d: dict) -> list:
    obs = d.get("observations") or {}
    h1o = obs.get("h1") or {}
    h2o = obs.get("h2") or {}
    h3o = obs.get("h3") or {}
    h4o = obs.get("h4") or {}
    po  = obs.get("post") or {}

    def flag(o): return "Yes" if o.get("has_issue") == "yes" else ("No" if o else None)
    def cats(o): return (", ".join(o.get("categories") or [])) or None
    def rem(o):  return o.get("remarks") or None

    reg = d.get("registration_time")
    reg_ts = reg.replace("T", " ")[:19] if reg else None

    return [
        d.get("serial_number"),         # 0
        reg_ts,                          # 1
        d.get("registration_battery"),   # 2
        d.get("h1_battery"),             # 3
        d.get("h1_timestamp"),           # 4
        d.get("h2_battery"),             # 5
        d.get("h2_timestamp"),           # 6
        d.get("h3_battery"),             # 7
        d.get("h3_timestamp"),           # 8
        d.get("h4_battery"),             # 9
        d.get("h4_timestamp"),           # 10
        d.get("post_aging_battery"),     # 11
        d.get("post_aging_timestamp"),   # 12
        d.get("status"),                 # 13
        flag(h1o), cats(h1o), rem(h1o), # 14-16
        flag(h2o), cats(h2o), rem(h2o), # 17-19
        flag(h3o), cats(h3o), rem(h3o), # 20-22
        flag(h4o), cats(h4o), rem(h4o), # 23-25
        flag(po),  cats(po),  rem(po),  # 26-28
        d.get("power_test_result"),      # 29
    ]


def _resp(d: dict) -> dict:
    return {
        "serial_number":       d.get("serial_number"),
        "status":              d.get("status"),
        "pending_restart":     d.get("pending_restart"),
        "next_checkpoint":     d.get("next_checkpoint"),
        "aging_started":       d.get("aging_started"),
        "next_due":            d.get("next_due"),
        "last_server_received":d.get("last_server_received"),
        "last_device_time":    d.get("last_device_time"),
        "last_battery":        d.get("last_battery"),
        "values":              _values(d),
        "observations":        d.get("observations"),
        "power_test_result":   d.get("power_test_result"),
    }

# ── OCR (ported from backend/app/battery_ocr.py) ─────────────────────────────
_PCT_RE       = re.compile(r"(?<!\d)(100|[1-9][0-9]|[0-9])\s*%(?!\d)")
_FULL_CHG_RE  = re.compile(r"\bfull\s+charge\b", re.IGNORECASE)
_OCR_BUDGET   = 18.0
_OCR_WAIT     = 35.0


def _prepare_crop(img):
    import cv2, numpy as np
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return []
    scale = max(48 / min(h, w), 1.0)
    scale = min(scale, 480 / max(h, w))
    if scale != 1.0:
        img = cv2.resize(img, (max(1, round(w*scale)), max(1, round(h*scale))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    norm = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    return [(img, "original"), (cv2.cvtColor(norm, cv2.COLOR_GRAY2BGR), "contrast")]


def _screen_roi(img):
    import cv2
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        c = max(cnts, key=cv2.contourArea)
        x, y, cw, ch = cv2.boundingRect(c)
        if cw*ch > w*h*0.10 and (cw < w*0.98 or ch < h*0.98):
            return img[y:y+ch, x:x+cw]
    return img


def _sort_boxes(txts, scores, boxes):
    import numpy as np
    if not txts:
        return "", 0.0
    if boxes is None or len(boxes) != len(txts):
        return " ".join(txts), float(max(scores)) if scores else 0.0
    items = []
    for t, s, b in zip(txts, scores, boxes):
        ba = np.array(b)
        ys = ba[:, 1]
        xs = ba[:, 0]
        items.append({"t": t, "s": float(s), "x": float(xs.min()), "y": float(ys.min()), "h": float(ys.max()-ys.min())})
    lines: list[dict] = []
    for it in sorted(items, key=lambda i: i["y"]):
        placed = False
        for ln in lines:
            if abs(it["y"]-ln["y"]) < min(it["h"], ln["h"])*0.6:
                ln["items"].append(it); ln["y"] = min(ln["y"], it["y"]); ln["h"] = max(ln["h"], it["h"]); placed = True; break
        if not placed:
            lines.append({"y": it["y"], "h": it["h"], "items": [it]})
    out, sc = [], []
    for ln in sorted(lines, key=lambda l: l["y"]):
        for it in sorted(ln["items"], key=lambda i: i["x"]):
            out.append(it["t"]); sc.append(it["s"])
    return " ".join(out), float(max(sc)) if sc else 0.0


def _run_ocr(image_bytes: bytes, crop_x=None, crop_y=None, crop_w=None, crop_h=None) -> dict:
    import cv2, numpy as np
    if not _ocr_ready.wait(timeout=_OCR_WAIT):
        return {"success": False, "error": "OCR engine still initialising.", "battery_percent": None, "confidence": None, "raw_text": None, "method": None, "processing_time_ms": 0.0, "attempts": 0}
    if _ocr is None:
        return {"success": False, "error": f"OCR failed: {_ocr_error}", "battery_percent": None, "confidence": None, "raw_text": None, "method": None, "processing_time_ms": 0.0, "attempts": 0}

    t0 = time.perf_counter()
    def el(): return time.perf_counter()-t0
    def fail(msg, att=0):
        return {"success": False, "error": msg, "battery_percent": None, "confidence": None, "raw_text": None, "method": None, "processing_time_ms": round(el()*1000,1), "attempts": att}

    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None: raise ValueError("imdecode returned None")
    except Exception as exc:
        return fail(f"Decode failed: {exc}")

    fh, fw = img.shape[:2]
    if fh == 0 or fw == 0: return fail("Zero-dimension image.")
    mx = max(fh, fw)
    if mx > 640:
        sc = 640/mx
        img = cv2.resize(img, (int(fw*sc), int(fh*sc)), interpolation=cv2.INTER_AREA)
        fh, fw = img.shape[:2]

    has_crop = all(v is not None for v in [crop_x, crop_y, crop_w, crop_h]) and crop_w > 0.005 and crop_h > 0.005
    candidates = []
    if has_crop:
        m=0.05
        x0=max(0,int((crop_x-crop_w*m)*fw)); y0=max(0,int((crop_y-crop_h*m)*fh))
        x1=min(fw,int((crop_x+crop_w*(1+m))*fw)); y1=min(fh,int((crop_y+crop_h*(1+m))*fh))
        candidates.append((img[y0:y1,x0:x1], "operator-crop"))
    elif fh <= 300 or fw/max(1,fh) >= 2.0:
        candidates.append((img, "live-crop"))
    else:
        screen = _screen_roi(img)
        sh, sw = screen.shape[:2]
        top_h = max(36, int(sh*0.28))
        candidates.append((screen[0:top_h,:], "screen-status-bar"))
        if sh < fh or sw < fw: candidates.append((screen, "screen-full"))
        candidates.append((img, "full-image"))

    attempts, seen = 0, set()
    for rim, rn in candidates:
        if el() > _OCR_BUDGET: break
        for vim, vn in _prepare_crop(rim):
            if el() > _OCR_BUDGET: break
            tag = f"{rn}-{vn}"
            try:
                res = _ocr(vim, use_det=True, use_cls=False, use_rec=True); attempts += 1
            except Exception as exc:
                logger.warning("OCR error (%s): %s", tag, exc); attempts += 1; continue
            if not res.txts: continue
            raw, score = _sort_boxes(res.txts, res.scores, getattr(res, "boxes", None))
            nr = " ".join(raw.split())
            pcts = [int(m.group(1)) for m in _PCT_RE.finditer(nr) if 0<=int(m.group(1))<=100]
            has_full = bool(_FULL_CHG_RE.search(nr))
            if score < 0.50: continue
            if has_full:
                cf = [p for p in pcts if p < 100]
                if cf: return fail(f"Conflicting: 'Full charge' + {cf[0]}%. Retake.", attempts)
                val = 100
            elif pcts:
                if len(set(pcts)) > 1: return fail("Ambiguous percentages. Drag a guide box.", attempts)
                val = pcts[0]
            else: continue
            seen.add(val)
            if len(seen) > 1: return fail("Ambiguous percentages. Drag a guide box.", attempts)
            return {"success": True, "battery_percent": val, "confidence": round(score,4), "raw_text": nr, "method": tag, "processing_time_ms": round(el()*1000,1), "error": None, "attempts": attempts}

    if len(seen) > 1: return fail("Conflicting readings. Drag a guide box.", attempts)
    return fail("Could not read clearly. Retake or select battery area.", attempts)

# ── validation ────────────────────────────────────────────────────────────────
ALLOWED_ACTIONS  = {"register","start-aging","h1","h2","h3","h4","post-aging"}
ALLOWED_CATS     = {"Display issue","Crashing / hanging issue","Other issue"}
ALLOWED_PWR      = {"Pass","Fail","Hold"}


def _validate_reading(body: dict):
    serial = body.get("serial_number","")
    if not _ok_serial(serial): return None,"Invalid serial number format"
    bat = body.get("battery_percent")
    if bat is None or not isinstance(bat,int) or not 0<=bat<=100: return None,"battery_percent must be integer 0-100"
    tok = body.get("capture_token","")
    if not tok or len(tok)<20: return None,"capture_token missing or invalid"
    dt = body.get("device_timestamp")
    if dt is not None and not re.fullmatch(r'(?:0?[1-9]|1[0-2]):[0-5][0-9] (?:AM|PM)', str(dt)):
        return None,"device_timestamp must be HH:MM AM/PM"
    hi = body.get("has_issue")
    if hi not in (None,"yes","no"): return None,"has_issue must be yes/no/null"
    cats = body.get("issue_categories")
    if cats is not None:
        if not isinstance(cats,list): return None,"issue_categories must be a list"
        for c in cats:
            if c not in ALLOWED_CATS: return None,f"Invalid category: {c}"
    if hi=="yes" and not cats: return None,"At least one category required when has_issue=yes"
    if hi=="no" and cats:      return None,"issue_categories must be empty when has_issue=no"
    pwr = body.get("power_test_result")
    if pwr is not None and pwr not in ALLOWED_PWR: return None,f"power_test_result must be one of {ALLOWED_PWR}"
    return {"serial_number":serial.strip(),"battery_percent":bat,"capture_token":tok,"device_timestamp":dt,
            "has_issue":hi,"issue_categories":cats,"remarks":_sanitize(body.get("remarks")),"power_test_result":pwr}, None

# ── capture tokens ────────────────────────────────────────────────────────────

def _issue_capture(action: str, serial: str | None) -> dict:
    cutoff = (_now()-timedelta(seconds=CAPTURE_TTL)).isoformat()
    old = db.collection("captures").where("created_at","<",cutoff).limit(50).stream()
    for doc in old: doc.reference.delete()
    pending = db.collection("captures").where("used","==",False).count().get()
    if pending[0][0].value > 500:
        raise ValueError("Too many pending captures. Wait and retry.")
    revision = None
    if serial:
        device = _get(serial)
        if not device: raise LookupError("Device not registered.")
        revision = hashlib.sha256(json.dumps(device, sort_keys=True, default=str).encode()).hexdigest()
    token = secrets.token_urlsafe(32)
    db.collection("captures").document(token).set({
        "token":token,"action":action,"serial_number":serial,
        "created_at":_stamp(),"used":False,"revision":revision,
    })
    return {"capture_token":token,"expires_in":CAPTURE_TTL}


def _consume_capture(token: str, action: str, serial: str | None) -> str | None:
    ref = db.collection("captures").document(token)
    doc = ref.get()
    if not doc.exists: return "Capture expired or unavailable. Please capture again."
    cap = doc.to_dict()
    if cap.get("used"):               return "Capture already used. Capture again."
    if cap.get("action") != action:   return "Capture belongs to a different action."
    if cap.get("serial_number") != serial: return "Capture belongs to a different device."
    age = (_now()-datetime.fromisoformat(cap["created_at"])).total_seconds()
    if age < 0 or age > CAPTURE_TTL: return "Capture expired. Please capture a fresh reading."
    if serial:
        device = _get(serial)
        stored = cap.get("revision")
        if stored:
            cur = hashlib.sha256(json.dumps(device or {}, sort_keys=True, default=str).encode()).hexdigest()
            if cur != stored: return "Device changed since capture began. Refresh and capture again."
    ref.update({"used":True})
    return None

# ── workflow ──────────────────────────────────────────────────────────────────

def _empty_doc(serial, battery, dt, stamp):
    return {
        "serial_number":serial,"status":"READY_FOR_AGING" if battery==100 else "WAITING_FOR_100_PERCENT_CHARGE",
        "registration_battery":battery,"registration_time":stamp,
        "last_battery":battery,"last_device_time":dt,"last_server_received":stamp,
        "next_checkpoint":1,"pending_restart":None,"aging_started":None,"next_due":None,
        "h1_battery":None,"h1_timestamp":None,"h1_server_time":None,
        "h2_battery":None,"h2_timestamp":None,"h2_server_time":None,
        "h3_battery":None,"h3_timestamp":None,"h3_server_time":None,
        "h4_battery":None,"h4_timestamp":None,"h4_server_time":None,
        "post_aging_battery":None,"post_aging_timestamp":None,"post_aging_server_time":None,
        "observations":{"h1":None,"h2":None,"h3":None,"h4":None,"post":None},
        "power_test_result":None,
        "events":[{"action":"register","battery":battery,"device_time":dt,"server_received":stamp}],
    }


def _do_register(r: dict) -> dict:
    serial = r["serial_number"]
    if _get(serial): raise ValueError(f"Device already registered. Current status: {_get(serial)['status']}")
    stamp = _stamp(); doc = _empty_doc(serial, r["battery_percent"], r["device_timestamp"], stamp)
    _ref(serial).set(doc); return doc


def _do_start_aging(dev: dict, r: dict) -> dict:
    if dev["status"] not in ("READY_FOR_AGING","WAITING_FOR_100_PERCENT_CHARGE"):
        raise ValueError("Aging has already started or is unavailable.")
    if r["battery_percent"] != 100:
        raise ValueError("Charge to 100% and capture a fresh reading before starting aging.")
    stamp = _stamp()
    events = list(dev.get("events") or [])
    events.append({"action":"start-aging","battery":100,"device_time":r["device_timestamp"],"server_received":stamp})
    up = {"status":"AGING_HOUR_1","aging_started":stamp,
          "next_due":(_now()+timedelta(seconds=CHECKPOINT_SECONDS)).isoformat(),
          "last_battery":100,"last_device_time":r["device_timestamp"],"last_server_received":stamp,
          "next_checkpoint":1,"events":events}
    _ref(r["serial_number"]).update(up); return {**dev,**up}


def _do_checkpoint(n: int, dev: dict, r: dict) -> dict:
    stamp = _stamp(); serial = r["serial_number"]
    aging_started = dev.get("aging_started")
    # H1 shortcut: allow H1 directly from registered state (matching original Python workflow)
    if n == 1 and dev["status"] in ("READY_FOR_AGING","WAITING_FOR_100_PERCENT_CHARGE"):
        aging_started = stamp
    elif dev["status"] != f"AGING_HOUR_{n}" or dev.get("next_checkpoint") != n:
        raise ValueError("Checkpoints must follow H1, H2, H3, H4 in order.")
    nd = dev.get("next_due")
    if nd and _now() < datetime.fromisoformat(nd):
        raise ValueError("This hourly checkpoint is not due yet.")
    obs = dict(dev.get("observations") or {})
    if r.get("has_issue"):
        obs[f"h{n}"] = {"has_issue":r["has_issue"],"categories":r.get("issue_categories") or [],"remarks":r.get("remarks") or ""}
    events = list(dev.get("events") or [])
    ev = {"action":f"h{n}","battery":r["battery_percent"],"device_time":r["device_timestamp"],"server_received":stamp}
    if r.get("has_issue"): ev.update({"has_issue":r["has_issue"],"issue_categories":r.get("issue_categories") or [],"remarks":r.get("remarks")})
    events.append(ev)
    up: dict = {f"h{n}_battery":r["battery_percent"],f"h{n}_timestamp":r["device_timestamp"],f"h{n}_server_time":stamp,
                "observations":obs,"pending_restart":n,"next_due":None,
                "last_battery":r["battery_percent"],"last_device_time":r["device_timestamp"],"last_server_received":stamp,"events":events}
    if aging_started: up["aging_started"] = aging_started
    _ref(serial).update(up); return {**dev,**up}


def _do_post_aging(dev: dict, r: dict) -> dict:
    if dev["status"] not in ("AGING_TEST_COMPLETE","POST_AGING_CHARGE"):
        raise ValueError("Complete H4 and confirm restart before post-aging check.")
    stamp = _stamp(); serial = r["serial_number"]
    obs = dict(dev.get("observations") or {})
    if r.get("has_issue"):
        obs["post"] = {"has_issue":r["has_issue"],"categories":r.get("issue_categories") or [],"remarks":r.get("remarks") or ""}
    new_status = "PACKING_READY" if r["battery_percent"] >= 70 else "POST_AGING_CHARGE"
    events = list(dev.get("events") or [])
    ev = {"action":"post-aging","battery":r["battery_percent"],"device_time":r["device_timestamp"],"server_received":stamp}
    if r.get("has_issue"): ev.update({"has_issue":r["has_issue"],"issue_categories":r.get("issue_categories") or [],"remarks":r.get("remarks")})
    if r.get("power_test_result"): ev["power_test_result"] = r["power_test_result"]
    events.append(ev)
    up = {"post_aging_battery":r["battery_percent"],"post_aging_timestamp":r["device_timestamp"],"post_aging_server_time":stamp,
          "status":new_status,"observations":obs,
          "last_battery":r["battery_percent"],"last_device_time":r["device_timestamp"],"last_server_received":stamp,"events":events}
    if r.get("power_test_result"): up["power_test_result"] = r["power_test_result"]
    _ref(serial).update(up); return {**dev,**up}

# ── main function ─────────────────────────────────────────────────────────────

@https_fn.on_request(cors=_CORS, memory=fn_options.MemoryOption.MB_512, timeout_sec=120)
def api(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        r = https_fn.Response("", status=204)
        r.headers["Access-Control-Allow-Origin"]  = "*"
        r.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
        r.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
        return r

    path = req.path
    if path.startswith("/api"): path = path[4:]
    if not path: path = "/"
    method = req.method.upper()

    try:
        # health
        if path == "/health" and method == "GET":
            return _json({"status":"ok"})

        # config
        if path == "/config" and method == "GET":
            return _json({"serial_regex":SERIAL_REGEX,"checkpoint_interval_seconds":CHECKPOINT_SECONDS})

        # captures
        if path == "/captures" and method == "POST":
            body   = req.get_json(silent=True) or {}
            action = body.get("action","")
            serial = body.get("serial_number")
            if action not in ALLOWED_ACTIONS: return _err("Invalid action.",400)
            if (action=="register") != (serial is None): return _err("Registration has no target; other actions require a serial.",400)
            if serial and not _ok_serial(serial): return _err("Invalid serial number.",400)
            try:   result = _issue_capture(action, serial)
            except LookupError as e: return _err(str(e),404)
            except ValueError  as e: return _err(str(e),429)
            return _json(result)

        # OCR
        if path in ("/ocr", "/battery-ocr") and method == "POST":
            f = req.files.get("image")
            if not f: return _err("No image file provided.",400)
            result = _run_ocr(f.read(),
                req.form.get("crop_x",type=float), req.form.get("crop_y",type=float),
                req.form.get("crop_w",type=float), req.form.get("crop_h",type=float))
            return _json(result)

        # readings
        rm = re.match(r'^/readings/([a-z0-9-]+)$', path)
        if rm and method == "POST":
            action = rm.group(1)
            if action not in ALLOWED_ACTIONS: return _err(f"Unknown action: {action}",404)
            body = req.get_json(silent=True) or {}
            reading, err = _validate_reading(body)
            if err: return _err(err,422)
            serial = reading["serial_number"]
            cap_target = None if action=="register" else serial
            ce = _consume_capture(reading["capture_token"], action, cap_target)
            if ce: return _err(ce,409)
            try:
                if action == "register":     dev = _do_register(reading)
                elif action == "start-aging":
                    dev = _get(serial)
                    if not dev: return _err("Device not registered.",404)
                    dev = _do_start_aging(dev, reading)
                elif action in ("h1","h2","h3","h4"):
                    dev = _get(serial)
                    if not dev: return _err("Device not registered.",404)
                    dev = _do_checkpoint(int(action[1]), dev, reading)
                elif action == "post-aging":
                    dev = _get(serial)
                    if not dev: return _err("Device not registered.",404)
                    dev = _do_post_aging(dev, reading)
                else: return _err(f"Unknown action: {action}",400)
            except ValueError as e: return _err(str(e),409)
            return _json(_resp(dev))

        # get device
        dm = re.match(r'^/devices/([^/]+?)(?:/status)?$', path)
        if dm and method == "GET":
            dev = _get(dm.group(1))
            if not dev: return _err("Device not registered.",404)
            return _json(_resp(dev))

        # restart
        rsm = re.match(r'^/devices/([^/]+)/restart$', path)
        if rsm and method == "POST":
            serial = rsm.group(1)
            body = req.get_json(silent=True) or {}
            n = body.get("checkpoint"); confirmed = body.get("confirmed")
            if not isinstance(n,int) or not 1<=n<=4: return _err("checkpoint must be 1-4.",422)
            if confirmed is not True:               return _err("confirmed=true required.",422)
            dev = _get(serial)
            if not dev: return _err("Device not registered.",404)
            if dev.get("pending_restart") != n: return _err("No matching restart awaiting confirmation.",409)
            stamp  = _stamp()
            events = list(dev.get("events") or [])
            events.append({"action":"operator_restart_confirmation","checkpoint":n,"server_received":stamp})
            ns   = "AGING_TEST_COMPLETE" if n==4 else f"AGING_HOUR_{n+1}"
            nd   = None if n==4 else (_now()+timedelta(seconds=CHECKPOINT_SECONDS)).isoformat()
            up   = {"pending_restart":None,"next_checkpoint":n+1,"status":ns,"next_due":nd,"last_server_received":stamp,"events":events}
            _ref(serial).update(up)
            return _json(_resp({**dev,**up}))

        # delete
        delm = re.match(r'^/devices/([^/]+?)(?:/delete)?$', path)
        if delm and (method=="DELETE" or path.endswith("/delete")):
            serial = delm.group(1)
            if not _get(serial): return _err("Device not registered.",404)
            _ref(serial).delete()
            return _json({"status":"deleted","serial_number":serial})

        return _err(f"Not found: {method} {path}",404)

    except Exception as exc:
        logger.exception("Unhandled error: %s", exc)
        return _err("Internal server error.",500)
