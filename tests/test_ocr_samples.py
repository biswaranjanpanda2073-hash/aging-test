"""
test_ocr_samples.py  —  Run run_battery_ocr() on every sample image in
tests/fixtures/ and print battery_percent, confidence, method, and timings_ms.

Usage (from project root):
    python tests/test_ocr_samples.py

No network, no server — calls the module directly.
"""
import sys
import json
from pathlib import Path

# Make sure the backend package is importable.
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.battery_ocr import run_battery_ocr, _ocr_ready  # noqa: E402

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def main() -> None:
    sample_files = sorted(FIXTURE_DIR.glob("*.jpg")) + sorted(FIXTURE_DIR.glob("*.png"))
    if not sample_files:
        print(f"No sample images found in {FIXTURE_DIR}")
        sys.exit(1)

    # Wait for engine warm-up (happens in background thread at import time).
    print("Waiting for RapidOCR to warm up …")
    _ocr_ready.wait(timeout=40)
    print("Engine ready.\n")

    header = f"{'Image':<35} {'Success':<8} {'Pct':>4}  {'Conf':>6}  {'Time_ms':>8}  Method"
    print(header)
    print("-" * len(header))

    for path in sample_files:
        image_bytes = path.read_bytes()
        result = run_battery_ocr(image_bytes)

        success = result["success"]
        pct = result.get("battery_percent")
        conf = result.get("confidence")
        time_ms = result.get("processing_time_ms")
        method = result.get("method") or result.get("error") or "—"
        timings = result.get("timings_ms", {})

        pct_str = str(pct) if pct is not None else "—"
        conf_str = f"{conf:.4f}" if conf is not None else "—"
        time_str = f"{time_ms:.1f}" if time_ms is not None else "—"

        print(
            f"{path.name:<35} {str(success):<8} {pct_str:>4}  {conf_str:>6}  {time_str:>8}  {method}"
        )
        if timings:
            for stage, ms_val in timings.items():
                print(f"    timings_ms.{stage} = {ms_val}")
        print()


if __name__ == "__main__":
    main()
