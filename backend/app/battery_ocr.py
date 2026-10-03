"""Battery OCR module using RapidOCR (ONNX Runtime backend, no PaddlePaddle required).

The RapidOCR instance is created once at module import time and reused across
requests (warm inference).  Model files are bundled inside the rapidocr package
and validated on first import; no network access occurs during capture requests.
"""
from __future__ import annotations

import re
import threading
import time
import logging
from typing import Any

import cv2  # type: ignore
import numpy as np  # type: ignore

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Singleton warm OCR engine - initialised exactly once per process.
# ---------------------------------------------------------------------------

_ocr: Any = None
_ocr_ready = threading.Event()
_ocr_error: str | None = None


def _init_ocr() -> None:
    """Background thread: create and warm up the RapidOCR instance."""
    global _ocr, _ocr_error
    try:
        from rapidocr import RapidOCR  # type: ignore  # noqa: PLC0415

        engine = RapidOCR()
        # Warm-up: run one dummy inference so ONNX session graph is compiled.
        dummy = np.full((64, 256, 3), 255, dtype=np.uint8)
        cv2.putText(dummy, "84%", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
        engine(dummy)
        _ocr = engine
        logger.info("RapidOCR warm and ready")
    except Exception as exc:  # pragma: no cover
        _ocr_error = str(exc)
        logger.error("RapidOCR failed to initialise: %s", exc)
    finally:
        _ocr_ready.set()


# Start warm-up immediately when the module is imported (background thread).
threading.Thread(target=_init_ocr, name="rapidocr-init", daemon=True).start()


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

# Matches 0-100 followed by % — the complete token.
# Prevents "184%" from matching as "84%".
_PERCENT_RE = re.compile(r"(?<!\d)(100|[1-9][0-9]|[0-9])\s*%(?!\d)")

# Matches "full charge" case-insensitively with normalized whitespace.
# Isolated "Full", "Charging", or "Charge" must NOT match.
_FULL_CHARGE_RE = re.compile(r"\bfull\s+charge\b", re.IGNORECASE)


def _parse_battery(text: str) -> int | None:
    """Return the first strictly valid battery percentage, or None."""
    for m in _PERCENT_RE.finditer(text):
        value = int(m.group(1))
        if 0 <= value <= 100:
            return value
    return None


def _sort_ocr_reading_order(txts: tuple[str, ...], scores: tuple[float, ...], boxes: Any) -> tuple[str, float]:
    """Sort RapidOCR results into natural reading order and calculate confidence."""
    if not txts:
        return "", 0.0
    if boxes is None or len(boxes) != len(txts):
        raw = " ".join(txts)
        score = float(max(scores)) if scores else 0.0
        return raw, score

    items = []
    for txt, score, box in zip(txts, scores, boxes):
        box_arr = np.array(box)
        min_x = float(np.min(box_arr[:, 0]))
        min_y = float(np.min(box_arr[:, 1]))
        max_y = float(np.max(box_arr[:, 1]))
        h = max(1.0, max_y - min_y)
        items.append({"txt": txt, "score": float(score), "x": min_x, "y": min_y, "h": h})

    # Group into lines by vertical proximity
    lines: list[dict] = []
    for it in sorted(items, key=lambda i: i["y"]):
        placed = False
        for l in lines:
            if abs(it["y"] - l["y"]) < min(it["h"], l["h"]) * 0.6:
                l["items"].append(it)
                l["y"] = min(l["y"], it["y"])
                l["h"] = max(l["h"], it["h"])
                placed = True
                break
        if not placed:
            lines.append({"y": it["y"], "h": it["h"], "items": [it]})

    ordered_txts: list[str] = []
    all_scores: list[float] = []
    for l in sorted(lines, key=lambda l: l["y"]):
        for it in sorted(l["items"], key=lambda i: i["x"]):
            ordered_txts.append(it["txt"])
            all_scores.append(it["score"])

    raw = " ".join(ordered_txts)
    score = float(max(all_scores)) if all_scores else 0.0
    return raw, score


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

_TARGET_SHORT_SIDE = 48   # min height after resize
_MAX_LONG_SIDE = 480     # cap width to 480px for sub-second neural inference

def _prepare_crop(img: np.ndarray) -> list[tuple[np.ndarray, str]]:
    """Return at most 2 preprocessed variants: original and contrast-enhanced."""
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return []

    scale = max(_TARGET_SHORT_SIDE / min(h, w), 1.0)
    scale = min(scale, _MAX_LONG_SIDE / max(h, w))
    if scale != 1.0:
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    variants: list[tuple[np.ndarray, str]] = [
        (img, "original"),
    ]

    # Contrast-normalised variant handles glare and dark-room conditions.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    norm = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
    variants.append((cv2.cvtColor(norm, cv2.COLOR_GRAY2BGR), "contrast"))

    return variants


# ---------------------------------------------------------------------------
# Public inference function
# ---------------------------------------------------------------------------

_BACKEND_BUDGET_S = 18.0
_OCR_READY_WAIT_S = 35.0


def _detect_screen_roi(img: np.ndarray) -> np.ndarray:
    """Detect lit display screen area inside dark device casing/bezel."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        c = max(cnts, key=cv2.contourArea)
        x, y, cw, ch = cv2.boundingRect(c)
        if cw * ch > (w * h * 0.10) and (cw < w * 0.98 or ch < h * 0.98):
            return img[y:y+ch, x:x+cw]
    return img


def run_battery_ocr(
    image_bytes: bytes,
    *,
    crop_x: float | None = None,
    crop_y: float | None = None,
    crop_w: float | None = None,
    crop_h: float | None = None,
) -> dict:
    """Run battery OCR and return a structured result dict.

    Optional crop_ parameters are fractional image coordinates [0..1].
    When provided, only the operator-selected region is scanned.
    """
    # 1. Wait for engine (only blocks on first-ever request after startup).
    if not _ocr_ready.wait(timeout=_OCR_READY_WAIT_S):
        return {
            "success": False,
            "battery_percent": None,
            "confidence": None,
            "raw_text": None,
            "method": None,
            "processing_time_ms": 0.0,
            "error": "OCR engine is still initialising. Retry in a moment.",
            "attempts": 0,
        }
    if _ocr is None:
        return {
            "success": False,
            "battery_percent": None,
            "confidence": None,
            "raw_text": None,
            "method": None,
            "processing_time_ms": 0.0,
            "error": f"OCR engine failed to load: {_ocr_error or 'unknown error'}",
            "attempts": 0,
        }

    t0 = time.perf_counter()

    def elapsed() -> float:
        return time.perf_counter() - t0

    def fail(error: str, attempts: int = 0) -> dict:
        return {
            "success": False,
            "battery_percent": None,
            "confidence": None,
            "raw_text": None,
            "method": None,
            "processing_time_ms": round(elapsed() * 1000, 1),
            "error": error,
            "attempts": attempts,
        }

    # 2. Decode image bytes.
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("imdecode returned None")
    except Exception as exc:
        return fail(f"Image decode failed: {exc}")

    full_h, full_w = img.shape[:2]
    if full_h == 0 or full_w == 0:
        return fail("Image has zero dimension.")

    # Downscale large input to max 640px for near-instant tensor allocation
    max_dim = max(full_h, full_w)
    if max_dim > 640:
        scale = 640.0 / max_dim
        img = cv2.resize(img, (int(full_w * scale), int(full_h * scale)), interpolation=cv2.INTER_AREA)
        full_h, full_w = img.shape[:2]

    # 3. Build candidate regions (priority: operator crop > detected screen status bar > full).
    candidates: list[tuple[np.ndarray, str]] = []

    has_crop = (
        crop_x is not None
        and crop_y is not None
        and crop_w is not None
        and crop_h is not None
        and crop_w > 0.005
        and crop_h > 0.005
    )

    if has_crop:
        margin = 0.05
        x0 = max(0, int((crop_x - crop_w * margin) * full_w))   # type: ignore[operator]
        y0 = max(0, int((crop_y - crop_h * margin) * full_h))   # type: ignore[operator]
        x1 = min(full_w, int((crop_x + crop_w * (1 + margin)) * full_w))  # type: ignore[operator]
        y1 = min(full_h, int((crop_y + crop_h * (1 + margin)) * full_h))  # type: ignore[operator]
        candidates.append((img[y0:y1, x0:x1], "operator-crop"))
    elif full_h <= 300 or (full_w / max(1, full_h)) >= 2.0:
        # Frame is already a pre-cropped horizontal region from the live scanner guide
        candidates.append((img, "live-crop"))
    else:
        # Automatically detect screen boundaries to discard black device bezels
        screen = _detect_screen_roi(img)
        sh, sw = screen.shape[:2]

        # Candidate 1: Real status bar of the screen (top 28%)
        top_h = max(36, int(sh * 0.28))
        candidates.append((screen[0:top_h, :], "screen-status-bar"))

        # Candidate 2: Full screen if bezel was cropped
        if sh < full_h or sw < full_w:
            candidates.append((screen, "screen-full"))

        # Candidate 3: Full camera image fallback
        candidates.append((img, "full-image"))

    # 4. Run inference over bounded candidate * variant matrix.
    attempts = 0
    seen: set[int] = set()

    for region_img, region_name in candidates:
        if elapsed() > _BACKEND_BUDGET_S:
            break

        for variant_img, variant_name in _prepare_crop(region_img):
            if elapsed() > _BACKEND_BUDGET_S:
                break

            method_tag = f"{region_name}-{variant_name}"
            try:
                result = _ocr(variant_img, use_det=True, use_cls=False, use_rec=True)
                attempts += 1
            except Exception as exc:
                logger.warning("Inference error (%s): %s", method_tag, exc)
                attempts += 1
                continue

            if not result.txts:
                continue

            raw, score = _sort_ocr_reading_order(result.txts, result.scores, getattr(result, "boxes", None))
            normalized_raw = " ".join(raw.split())

            # Check for numerical percentages
            all_pcts = [int(m.group(1)) for m in _PERCENT_RE.finditer(normalized_raw) if 0 <= int(m.group(1)) <= 100]
            has_full_charge = bool(_FULL_CHARGE_RE.search(normalized_raw))

            # Require sufficient OCR confidence
            if score < 0.50:
                continue

            if has_full_charge:
                # If a full-charge phrase conflicts with a numerical percentage below 100%, request a retake
                conflicting = [p for p in all_pcts if p < 100]
                if conflicting:
                    return fail(
                        f"Conflicting readings: 'Full charge' detected alongside a lower percentage ({conflicting[0]}%). Please retake photo.",
                        attempts,
                    )
                value = 100
            elif all_pcts:
                if len(set(all_pcts)) > 1:
                    return fail(
                        "Ambiguous: conflicting percentages detected. "
                        "Drag a green box around the battery digits to isolate.",
                        attempts,
                    )
                value = all_pcts[0]
            else:
                # Do not treat "Charging", "Charge", or isolated "Full" as 100%
                continue

            seen.add(value)
            if len(seen) > 1:
                return fail(
                    "Ambiguous: conflicting percentages detected. "
                    "Drag a green box around the battery digits to isolate.",
                    attempts,
                )

            return {
                "success": True,
                "battery_percent": value,
                "confidence": round(score, 4),
                "raw_text": normalized_raw,
                "method": method_tag,
                "processing_time_ms": round(elapsed() * 1000, 1),
                "error": None,
                "attempts": attempts,
            }

    if len(seen) > 1:
        return fail("Conflicting readings. Please drag a guide box.", attempts)

    return fail(
        "Could not read clearly. Retake the photo or select the battery area.",
        attempts,
    )
