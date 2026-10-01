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

import cv2
import numpy as np

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
        from rapidocr import RapidOCR  # noqa: PLC0415

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


def _parse_battery(text: str) -> int | None:
    """Return the first strictly valid battery percentage, or None."""
    for m in _PERCENT_RE.finditer(text):
        value = int(m.group(1))
        if 0 <= value <= 100:
            return value
    return None


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

_TARGET_SHORT_SIDE = 96   # min height after resize
_MAX_LONG_SIDE = 1280     # cap width to bound inference time


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
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

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

# Frontend 5 s deadline; allow backend 3.5 s so the round-trip fits.
_BACKEND_BUDGET_S = 3.5
_OCR_READY_WAIT_S = 8.0


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

    # 1. Wait for engine (only blocks on first-ever request after startup).
    if not _ocr_ready.wait(timeout=_OCR_READY_WAIT_S):
        return fail("OCR engine is still initialising. Retry in a moment.")
    if _ocr is None:
        return fail(f"OCR engine failed to load: {_ocr_error or 'unknown error'}")

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

    # 3. Build candidate regions (priority: operator crop > top strip > full).
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
        top_h = max(40, int(full_h * 0.25))
        candidates.append((img[0:top_h, :], "status-bar-top"))
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
                result = _ocr(variant_img)
                attempts += 1
            except Exception as exc:
                logger.warning("Inference error (%s): %s", method_tag, exc)
                attempts += 1
                continue

            if not result.txts:
                continue

            raw = " ".join(result.txts)
            score = float(max(result.scores)) if result.scores else 0.0

            value = _parse_battery(raw)
            if value is None:
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
                "raw_text": raw,
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
