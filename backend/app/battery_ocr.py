"""Battery OCR module using RapidOCR (ONNX Runtime backend, no PaddlePaddle required).

The RapidOCR instance is created once at module import time and reused across
requests (warm inference).  Model files are bundled inside the rapidocr package
and validated on first import; no network access occurs during capture requests.

Changes (v2):
  B  - Fast path: operator/live-crop regions use use_det=False first, retry once with det.
  C  - Det limit_type changed to "max" (stop upscaling small crops) at limit_side_len=960.
  D  - Budget reduced to 7 s; contrast variant replaced with CLAHE; INTER_CUBIC/INTER_AREA.
  E  - Per-stage timings logged and returned under "timings_ms" key.
  F  - ONNX intra_op threads capped; worker recommendation documented.
  G  - Full-resolution decode kept; crop computed against full-res pixels.
  H  - "mode" field from frontend used directly; no aspect-ratio guessing.
  I  - Confidence from matched box(es) only, not global max; min conf = 0.65.
  J  - Conflict continues to next variant instead of failing immediately; voting logic.
  K  - Screen-ROI rejects background blobs touching most of the border.

Fixes (v3):
  1  - _confidence_of_match takes int value, returns LOWEST matching-box score.
  2  - conflict_seen flag: no early accept while conflict active; conflict error returned.
  3  - Voting: single vote below 0.80 does not succeed; raw_text stored and returned.
  4  - mode=None: fall back to old aspect-ratio heuristic.
  5  - No crop fractions sent when mode=guide (image is already the crop).
  6  - async route uses run_in_executor to avoid blocking the event loop.
  7  - Removed: import math, _parse_battery, ambiguous_only, use_det_first,
       unused _screen_det. _prepare_crop caps long side even after upscale.
"""
from __future__ import annotations

import asyncio
import os
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
# F: cap ONNX intra_op_num_threads to avoid oversubscribing the CPU when
#    multiple uvicorn workers run concurrently.
#    Recommended worker count for this 12-core machine: 4 workers
#    (leaves 2 logical CPUs per worker × 4 workers, with room for the OS).
#    Launch with: uvicorn app.main:app --workers 4 --host 0.0.0.0 --port 8000
# ---------------------------------------------------------------------------

_CPU_COUNT = os.cpu_count() or 4
# Leave at least 1 core free; scale threads per worker so total ≤ CPU_COUNT.
_ONNX_THREADS = max(1, min(2, _CPU_COUNT // 4))

_ocr: Any = None
_ocr_ready = threading.Event()
_ocr_error: str | None = None


def _init_ocr() -> None:
    """Background thread: create and warm up the RapidOCR instance."""
    global _ocr, _ocr_error
    try:
        from rapidocr import RapidOCR  # type: ignore  # noqa: PLC0415

        # C: Set Det limit_type="max" so the detector never upscales a small
        #    crop (the default "min" would pad/upscale, wasting time + accuracy).
        # F: Cap ONNX threads to avoid CPU oversubscription across workers.
        engine = RapidOCR(params={
            "Det.limit_type": "max",
            "Det.limit_side_len": 960,
            "EngineConfig.onnxruntime.intra_op_num_threads": _ONNX_THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": _ONNX_THREADS,
        })
        # Warm-up: run one dummy inference so ONNX session graph is compiled.
        dummy = np.full((64, 256, 3), 255, dtype=np.uint8)
        cv2.putText(dummy, "84%", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
        engine(dummy)
        _ocr = engine
        logger.info("RapidOCR warm and ready (threads=%d)", _ONNX_THREADS)
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

# I / Fix 1: Minimum confidence for accepting a digit reading.
_MIN_DIGIT_CONFIDENCE = 0.65

# J: Minimum confidence to accept immediately without a second confirming pass.
_HIGH_CONFIDENCE_THRESHOLD = 0.90

# Fix 3: A lone vote must have at least this confidence to succeed after the loop.
_VOTE_MIN_CONFIDENCE = 0.80


def _sort_ocr_reading_order(
    txts: tuple[str, ...],
    scores: tuple[float, ...],
    boxes: Any,
) -> tuple[str, float]:
    """Sort RapidOCR results into natural reading order and return (text, max_score).

    B: Works correctly when boxes is None (use_det=False path).
    """
    if not txts:
        return "", 0.0
    if boxes is None or len(boxes) != len(txts):
        # use_det=False path: no spatial boxes, just concatenate.
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


def _confidence_of_match(
    txts: tuple[str, ...],
    scores: tuple[float, ...],
    boxes: Any,
    value: int,
) -> float:
    """Fix 1: Return the LOWEST score among boxes whose text actually contains value.

    For numeric values, matches boxes containing \"<value>%\".
    For value == 100 that came from a full-charge match, also matches boxes
    containing \"full charge\" (case-insensitive).
    Falls back to min(scores) when no specific box is found.
    """
    if not txts or not scores:
        return 0.0

    pct_pattern = re.compile(
        r"(?<!\d)" + str(value) + r"\s*%(?!\d)"
    )
    is_full_charge_value = (value == 100)

    matching_scores: list[float] = []
    for txt, score in zip(txts, scores):
        if pct_pattern.search(txt):
            matching_scores.append(float(score))
        elif is_full_charge_value and _FULL_CHARGE_RE.search(txt):
            matching_scores.append(float(score))

    if matching_scores:
        return min(matching_scores)  # conservative: use the lowest of matched boxes

    # Fallback: no box specifically contained value — use global min.
    return float(min(scores))


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

_TARGET_SHORT_SIDE = 48   # min height after resize
_MAX_LONG_SIDE = 960      # cap width — matches Det.limit_side_len above


def _prepare_crop(img: np.ndarray) -> list[tuple[np.ndarray, str]]:
    """Return 2 preprocessed variants: original (resized) and CLAHE-enhanced.

    D: Use INTER_CUBIC when enlarging, INTER_AREA when shrinking.
    D: Replace the "contrast" min-max normalize with CLAHE.
    Fix 7: After upscaling a short side, also cap the long side at _MAX_LONG_SIDE.
    """
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return []

    short = min(h, w)
    long_ = max(h, w)

    if short < _TARGET_SHORT_SIDE:
        scale = _TARGET_SHORT_SIDE / short
        interp = cv2.INTER_CUBIC          # D: enlarge with INTER_CUBIC
    elif long_ > _MAX_LONG_SIDE:
        scale = _MAX_LONG_SIDE / long_
        interp = cv2.INTER_AREA           # D: shrink with INTER_AREA
    else:
        scale = 1.0
        interp = cv2.INTER_LINEAR

    if scale != 1.0:
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        img = cv2.resize(img, (new_w, new_h), interpolation=interp)
        # Fix 7: After upscaling, the long side may now exceed the cap — clamp it.
        h2, w2 = img.shape[:2]
        long2 = max(h2, w2)
        if long2 > _MAX_LONG_SIDE:
            scale2 = _MAX_LONG_SIDE / long2
            img = cv2.resize(
                img,
                (max(1, round(w2 * scale2)), max(1, round(h2 * scale2))),
                interpolation=cv2.INTER_AREA,
            )

    variants: list[tuple[np.ndarray, str]] = [
        (img, "original"),
    ]

    # D: CLAHE variant — handles glare and dark-room conditions better than
    #    min-max normalise which is often a no-op on already-stretched histograms.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    enhanced = clahe.apply(gray)
    variants.append((cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR), "clahe"))

    return variants


# ---------------------------------------------------------------------------
# Screen ROI detection
# ---------------------------------------------------------------------------

def _detect_screen_roi(
    img: np.ndarray,
) -> tuple[np.ndarray, int, int, int, int]:
    """K: Detect lit display screen inside dark device casing.

    Returns (cropped_img, x, y, w, h) in input-image coordinates.
    Rejects candidates:
      - whose bounding box covers >= 96% of the image in both dimensions
        (likely a plain background, not a device screen)
      - with unusual aspect ratios (< 0.2 or > 5) that can't be a phone screen
    Falls back to full image when detection is unreliable.
    """
    full_h, full_w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best: tuple[np.ndarray, int, int, int, int] | None = None
    best_area = 0

    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cw * ch
        if area < full_h * full_w * 0.10:
            continue  # too small
        if cw >= full_w * 0.96 and ch >= full_h * 0.96:
            continue  # K: likely background blob, not a screen
        ar = cw / max(1, ch)
        if ar < 0.2 or ar > 5.0:
            continue  # K: implausible aspect ratio for a phone
        if area > best_area:
            best_area = area
            best = (img[y:y + ch, x:x + cw], x, y, cw, ch)

    if best is not None:
        return best
    return img, 0, 0, full_w, full_h  # fallback: full image


# ---------------------------------------------------------------------------
# Public inference function
# ---------------------------------------------------------------------------

_BACKEND_BUDGET_S = 7.0    # D: reduced from 18 s
_OCR_READY_WAIT_S = 35.0

# Fix 2: conflict error message (shared between early-exit and post-loop).
_CONFLICT_MSG = (
    "Conflicting readings on the display (e.g. 'Full charge' with a lower %). "
    "Retake the photo or drag a box around the digits."
)


def run_battery_ocr(
    image_bytes: bytes,
    *,
    crop_x: float | None = None,
    crop_y: float | None = None,
    crop_w: float | None = None,
    crop_h: float | None = None,
    mode: str | None = None,
) -> dict:
    """Run battery OCR and return a structured result dict.

    Optional crop_ parameters are fractional image coordinates [0..1].
    When provided, only the operator-selected region is scanned.

    H: mode='guide' means the image is already a guide-box crop.
       mode='photo' means the image is a full camera photo (screen detection applies).
    Fix 4: mode=None falls back to the old heuristic (height<=300 or w/h>=2 → pre-cropped).
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
            "timings_ms": {},
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
            "timings_ms": {},
        }

    t0 = time.perf_counter()
    timings: dict[str, float] = {}

    def elapsed() -> float:
        return time.perf_counter() - t0

    def ms(label: str, start: float) -> None:
        timings[label] = round((time.perf_counter() - start) * 1000, 1)

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
            "timings_ms": timings,
        }

    # 2. Decode image bytes — keep full resolution.
    t_decode = time.perf_counter()
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("imdecode returned None")
    except Exception as exc:
        return fail(f"Image decode failed: {exc}")
    ms("decode", t_decode)

    full_h, full_w = img.shape[:2]
    if full_h == 0 or full_w == 0:
        return fail("Image has zero dimension.")

    # G: Keep full-resolution image; do NOT downscale before cropping.

    # 3. Build candidate regions (priority: operator crop > detected screen status bar > full).
    candidates: list[tuple[np.ndarray, str, bool]] = []  # (img, name, is_crop_region)

    has_crop = (
        crop_x is not None
        and crop_y is not None
        and crop_w is not None
        and crop_h is not None
        and crop_w > 0.005  # type: ignore[operator]
        and crop_h > 0.005  # type: ignore[operator]
    )

    # Fix 4 / H: Determine whether we are in guide/crop mode.
    if mode == "guide":
        is_guide_mode = True
    elif mode == "photo":
        is_guide_mode = False
    else:
        # Fix 4: mode=None — fall back to original heuristic.
        # A horizontal strip (height<=300) or wide aspect ratio (w/h>=2) is
        # treated as a pre-cropped live-guide frame; otherwise it is a full photo.
        is_guide_mode = has_crop or (full_h <= 300) or (full_w / max(1, full_h) >= 2.0)

    if has_crop:
        t_roi = time.perf_counter()
        margin = 0.05
        # G: crop coordinates computed against full-resolution dimensions.
        x0 = max(0, int((crop_x - crop_w * margin) * full_w))   # type: ignore[operator]
        y0 = max(0, int((crop_y - crop_h * margin) * full_h))   # type: ignore[operator]
        x1 = min(full_w, int((crop_x + crop_w * (1 + margin)) * full_w))  # type: ignore[operator]
        y1 = min(full_h, int((crop_y + crop_h * (1 + margin)) * full_h))  # type: ignore[operator]
        region = img[y0:y1, x0:x1]
        candidates.append((region, "operator-crop", True))
        ms("roi_detection", t_roi)
    elif is_guide_mode:
        # H: Frontend sent mode="guide" — image is already the cropped region.
        candidates.append((img, "live-crop", True))
    else:
        # Full camera photo: locate screen, then extract from full-res.
        t_roi = time.perf_counter()

        # G: Downscale a copy just for screen detection, then map back to full-res.
        max_dim = max(full_h, full_w)
        if max_dim > 640:
            det_scale = 640.0 / max_dim
            det_img = cv2.resize(
                img,
                (int(full_w * det_scale), int(full_h * det_scale)),
                interpolation=cv2.INTER_AREA,
            )
        else:
            det_scale = 1.0
            det_img = img

        _, det_x, det_y, det_cw, det_ch = _detect_screen_roi(det_img)

        # Map detected rectangle back to full-resolution coordinates.
        rx = int(det_x / det_scale)
        ry = int(det_y / det_scale)
        rcw = int(det_cw / det_scale)
        rch = int(det_ch / det_scale)
        screen = img[ry:ry + rch, rx:rx + rcw]
        sh, sw = screen.shape[:2]
        ms("roi_detection", t_roi)

        # Candidate 1: top 28% of the full-res screen (status bar)
        top_h = max(36, int(sh * 0.28))
        candidates.append((screen[0:top_h, :], "screen-status-bar", False))

        # Candidate 2: Full screen if screen was smaller than full image
        if sh < full_h or sw < full_w:
            candidates.append((screen, "screen-full", False))

        # Candidate 3: Full camera image fallback
        candidates.append((img, "full-image", False))

    # 4. Run inference over bounded candidate × variant matrix.
    attempts = 0

    # Fix 2: track if a genuine conflict was observed across passes.
    conflict_seen = False

    # J / Fix 3: Voting — collect (value, confidence) + last matching raw text.
    vote_counts: dict[int, int] = {}
    vote_best_conf: dict[int, float] = {}
    vote_last_raw: dict[int, str] = {}

    for region_img, region_name, is_crop_region in candidates:
        if elapsed() > _BACKEND_BUDGET_S:
            break

        for variant_img, variant_name in _prepare_crop(region_img):
            if elapsed() > _BACKEND_BUDGET_S:
                break

            method_tag = f"{region_name}-{variant_name}"

            # B: First attempt without detector for crop regions.
            ocr_passes: list[tuple[bool, str]] = []
            if is_crop_region:
                ocr_passes = [(False, "nodet"), (True, "det")]
            else:
                ocr_passes = [(True, "det")]

            for use_det, pass_tag in ocr_passes:
                if elapsed() > _BACKEND_BUDGET_S:
                    break

                full_method_tag = f"{method_tag}-{pass_tag}"
                t_ocr = time.perf_counter()
                try:
                    result = _ocr(variant_img, use_det=use_det, use_cls=False, use_rec=True)
                    attempts += 1
                except Exception as exc:
                    logger.warning("Inference error (%s): %s", full_method_tag, exc)
                    attempts += 1
                    ms(full_method_tag, t_ocr)
                    continue
                ms(full_method_tag, t_ocr)
                logger.debug("OCR %s timings_ms=%s", full_method_tag, timings)

                if not result.txts:
                    continue

                raw, _ = _sort_ocr_reading_order(
                    result.txts, result.scores, getattr(result, "boxes", None)
                )
                normalized_raw = " ".join(raw.split())

                all_pcts = [
                    int(m.group(1))
                    for m in _PERCENT_RE.finditer(normalized_raw)
                    if 0 <= int(m.group(1)) <= 100
                ]
                has_full_charge = bool(_FULL_CHARGE_RE.search(normalized_raw))

                # Fix 1: Determine value first, then compute matched-box confidence.
                if has_full_charge:
                    conflicting = [p for p in all_pcts if p < 100]
                    if conflicting:
                        # Fix 2: genuine conflict — record it, skip this pass.
                        conflict_seen = True
                        logger.debug(
                            "%s: Full-charge conflicts with %s%%; marking conflict",
                            full_method_tag, conflicting[0],
                        )
                        continue
                    value = 100
                elif any(p < 100 for p in all_pcts) and re.search(r"\bfull\b", normalized_raw, re.IGNORECASE):
                    # Fix 2: "Full" seen alongside a lower percentage (e.g. 'Full chge 75%') is a conflict.
                    conflict_seen = True
                    logger.debug(
                        "%s: Full conflicts with %s%%; marking conflict",
                        full_method_tag, all_pcts,
                    )
                    continue
                elif all_pcts:
                    if len(set(all_pcts)) > 1:
                        # Fix 2: multiple different percentages in one pass — conflict.
                        conflict_seen = True
                        logger.debug(
                            "%s: Ambiguous percentages %s; marking conflict",
                            full_method_tag, all_pcts,
                        )
                        continue
                    if not use_det and re.search(r"[a-zA-Z]", normalized_raw):
                        # Text contains words/letters without detection (nodet cannot segment multi-word lines).
                        # Do not accept as clean isolated percentage; fall through to det pass.
                        continue
                    value = all_pcts[0]
                else:
                    continue  # no usable percentage found

                # Fix 1: confidence is the LOWEST score among boxes matching value.
                score = _confidence_of_match(
                    result.txts, result.scores, getattr(result, "boxes", None), value
                )

                # I: Require minimum confidence.
                if score < _MIN_DIGIT_CONFIDENCE:
                    continue

                # Fix 3: accumulate vote + remember last raw text.
                vote_counts[value] = vote_counts.get(value, 0) + 1
                prev_conf = vote_best_conf.get(value, 0.0)
                vote_best_conf[value] = max(prev_conf, score)
                vote_last_raw[value] = normalized_raw

                logger.info(
                    "%s → %d%% (conf=%.4f, votes=%d)",
                    full_method_tag, value, score, vote_counts[value],
                )

                # Fix 2: Do NOT early-accept while a conflict has been observed.
                if not conflict_seen:
                    # J: Accept immediately if confidence is very high.
                    if score >= _HIGH_CONFIDENCE_THRESHOLD:
                        return {
                            "success": True,
                            "battery_percent": value,
                            "confidence": round(score, 4),
                            "raw_text": normalized_raw,
                            "method": full_method_tag,
                            "processing_time_ms": round(elapsed() * 1000, 1),
                            "error": None,
                            "attempts": attempts,
                            "timings_ms": timings,
                        }

                    # J: Also accept if the same value appeared in 2 independent passes.
                    if vote_counts[value] >= 2:
                        return {
                            "success": True,
                            "battery_percent": value,
                            "confidence": round(vote_best_conf[value], 4),
                            "raw_text": normalized_raw,
                            "method": full_method_tag,
                            "processing_time_ms": round(elapsed() * 1000, 1),
                            "error": None,
                            "attempts": attempts,
                            "timings_ms": timings,
                        }

                # B: If this no-det pass found a valid value, stop the inner pass loop.
                if not use_det:
                    break

    # ── Post-loop resolution ─────────────────────────────────────────────────

    # Fix 2: If any conflict was observed across passes, return the conflict error.
    if conflict_seen:
        return fail(_CONFLICT_MSG, attempts)

    if vote_counts:
        if len(vote_counts) > 1:
            # Multiple different clean values seen — truly ambiguous.
            return fail(
                "Ambiguous: conflicting percentages detected. "
                "Drag a green box around the battery digits to isolate.",
                attempts,
            )

        best_value = next(iter(vote_counts))
        best_conf = vote_best_conf.get(best_value, 0.0)
        best_raw = vote_last_raw.get(best_value)

        # Fix 3: A lone vote below _VOTE_MIN_CONFIDENCE does not succeed.
        if vote_counts[best_value] == 1 and best_conf < _VOTE_MIN_CONFIDENCE:
            logger.info(
                "Single vote for %d%% with conf=%.4f below %.2f threshold; failing.",
                best_value, best_conf, _VOTE_MIN_CONFIDENCE,
            )
            return fail(
                "Could not read clearly. Retake the photo or select the battery area.",
                attempts,
            )

        # Fix 2: A conflict was seen but one value survived — still report conflict.
        if conflict_seen:
            return fail(_CONFLICT_MSG, attempts)

        return {
            "success": True,
            "battery_percent": best_value,
            "confidence": round(best_conf, 4),
            "raw_text": best_raw,            # Fix 3: return stored raw_text not None
            "method": "voted",
            "processing_time_ms": round(elapsed() * 1000, 1),
            "error": None,
            "attempts": attempts,
            "timings_ms": timings,
        }

    logger.info("All passes exhausted. timings=%s", timings)
    return fail(
        "Could not read clearly. Retake the photo or select the battery area.",
        attempts,
    )
