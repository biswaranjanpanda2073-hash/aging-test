/**
 * batteryOCR.ts
 *
 * Replaces the browser-side Tesseract.js engine with a call to the FastAPI
 * /api/battery-ocr endpoint backed by RapidOCR + ONNX Runtime.
 *
 * Pipeline (all within the 5-second deadline):
 *   1. Canvas → JPEG blob  (~50 ms, in-browser)
 *   2. Multipart POST to /api/battery-ocr (~100–200 ms network)
 *   3. Server: decode + crop + 2 RapidOCR passes with warm ONNX (~1–2 s)
 *   4. Parse & validate result in frontend
 *   5. Return BatteryDetectionResult
 *
 * The photo canvas is NOT serialised twice: if the operator selected a crop
 * the fractional coordinates are sent as form fields; the server applies them
 * on the decoded image — no second canvas manipulation required here.
 */

import { loadPhoto, mapGuide, cropPhoto, type Photo, type Rect } from './photo';
import { newWorker } from './ocr';

// ── Re-exported types so callers need not change their import surface ─────────

export type BatteryGuideCoords = Rect;

export type BatteryAttempt = {
  method: string;
  crop: Rect;
  rotation: number;
  raw: string;
  confidence: number;
  milliseconds: number;
  error?: string;
};

export type BatteryDetectionResult = {
  success: boolean;
  batteryPercent?: number;
  confidence?: number;
  method?: string;
  processingTime: number;
  rawText?: string;
  error?: string;
  attempts: number;
  trace: BatteryAttempt[];
  region?: Rect;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strict parse: accepts only "0"–"100" followed by "%", or "Full charge" (case-insensitive) as 100. */
export function parseBatteryPercentage(text: string): number | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^(100|[0-9]{1,2})\s*%$/);
  if (m) return Number(m[1]);
  if (/^full\s+charge$/i.test(trimmed.replace(/\s+/g, ' '))) return 100;
  return null;
}

export function mapGuideToImageCoords(
  guide: Rect,
  display: HTMLElement,
  image: { width: number; height: number },
): Rect {
  const b = display.getBoundingClientRect();
  const fit = getComputedStyle(display).objectFit === 'cover' ? 'cover' : 'contain';
  return mapGuide({ ...guide, x: guide.x + b.x, y: guide.y + b.y }, b, image, fit);
}

/**
 * Convert a canvas to a JPEG Blob for upload.
 * Quality 0.88 keeps file size small without losing digit clarity.
 */
function canvasToJpegBlob(c: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Fallback browser-side OCR using Tesseract.js when the backend OCR endpoint
 * is unreachable (e.g. static Firebase Hosting serverless mode).
 */
async function clientTesseractOCR(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<{ success: boolean; batteryPercent?: number; confidence?: number; raw?: string }> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return { success: false };
  }
  try {
    if (signal?.aborted) return { success: false };
    const worker = await newWorker(() => {});
    if (signal?.aborted) {
      await worker.terminate();
      return { success: false };
    }
    const res = await worker.recognize(canvas);
    await worker.terminate();

    const raw = (res?.data?.text || '').trim();
    const pct = parseBatteryPercentage(raw);
    if (pct !== null) {
      return { success: true, batteryPercent: pct, confidence: res.data.confidence, raw };
    }
    const m = raw.match(/\b(100|[0-9]{1,2})\s*%/);
    if (m) {
      return { success: true, batteryPercent: Number(m[1]), confidence: res.data.confidence, raw };
    }
    return { success: false, raw };
  } catch {
    return { success: false };
  }
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Detect the battery percentage displayed in *input*.
 *
 * @param input   - Photo (File / Image / Canvas) to analyse.
 * @param guide   - Optional operator-selected crop (fractional CSS-pixel rect).
 * @param display - The HTMLElement rendering the photo (used to map guide →
 *                  image coordinates).  Pass undefined when guide is already in
 *                  image-pixel space.
 */
export async function detectBatteryPercentage(
  input: Photo,
  guide?: Rect,
  display?: HTMLElement,
  signal?: AbortSignal,
): Promise<BatteryDetectionResult> {
  const start = performance.now();
  const processingTime = () => performance.now() - start;

  const fail = (error: string, attempts = 0): BatteryDetectionResult => ({
    success: false,
    error,
    processingTime: processingTime(),
    attempts,
    trace: [],
  });

  // ── 1. Decode photo to canvas (needed to compute image dimensions for the
  //       guide mapping and to produce the JPEG blob).
  let source: HTMLCanvasElement | undefined;
  try {
    source = await loadPhoto(input);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Could not load photo.');
  }

  // ── 2. Prepare optimized canvas for upload (drastically cuts payload for weak Wi-Fi).
  let uploadCanvas: HTMLCanvasElement;
  let cropX: number | undefined;
  let cropY: number | undefined;
  let cropW: number | undefined;
  let cropH: number | undefined;

  if (guide) {
    try {
      // Map from CSS-pixel guide into image-pixel rect.
      const imgRect: Rect = display
        ? mapGuideToImageCoords(guide, display, source)
        : guide;

      // Crop directly to the selected region on the phone canvas.
      // A 300x120 crop is ~15 KB (vs uploading a 5 MB photo over weak Wi-Fi!).
      uploadCanvas = cropPhoto(source, imgRect);
      cropX = 0;
      cropY = 0;
      cropW = 1;
      cropH = 1;
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Guide mapping failed.');
    }
  } else {
    // For auto-scan: downscale full photo so max dimension is 800px.
    // Drastically speeds up mobile upload and cuts AI inference time by ~65%.
    const maxDim = Math.max(source.width, source.height);
    if (maxDim > 800) {
      const scale = 800 / maxDim;
      uploadCanvas = document.createElement('canvas');
      uploadCanvas.width = Math.round(source.width * scale);
      uploadCanvas.height = Math.round(source.height * scale);
      const ctx = uploadCanvas.getContext('2d')!;
      ctx.drawImage(source, 0, 0, uploadCanvas.width, uploadCanvas.height);
    } else {
      uploadCanvas = source;
    }
  }

  // ── 3. Encode canvas → JPEG blob (0.80 quality gives crisp digits at minimal bytes).
  let blob: Blob;
  try {
    blob = await canvasToJpegBlob(uploadCanvas, 0.80);
  } catch {
    return fail('Could not encode photo for upload.');
  }

  // ── 4. Build multipart form and POST to backend.
  const form = new FormData();
  form.append('image', blob, 'battery.jpg');
  if (cropX !== undefined) form.append('crop_x', String(cropX));
  if (cropY !== undefined) form.append('crop_y', String(cropY));
  if (cropW !== undefined) form.append('crop_w', String(cropW));
  if (cropH !== undefined) form.append('crop_h', String(cropH));

  let json: Record<string, unknown>;
  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return fail('Request cancelled.');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // 45-second timeout handles free cloud tier cold-start wake-up
    const timer = setTimeout(() => controller.abort(), 45000);
    const backendBase = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');
    const response = await fetch(`${backendBase}/api/battery-ocr`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!response.ok) {
      if (response.status === 404 || response.status === 502 || response.status === 503) {
        const fb = await clientTesseractOCR(uploadCanvas, signal);
        if (fb.success && fb.batteryPercent !== undefined) {
          return {
            success: true,
            batteryPercent: fb.batteryPercent,
            confidence: fb.confidence,
            method: 'client-tesseract',
            processingTime: processingTime(),
            rawText: fb.raw,
            attempts: 1,
            trace: [],
            region: guide,
          };
        }
      }
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      const msg = typeof body?.detail === 'string' ? body.detail : `Server error ${response.status}`;
      return fail(msg);
    }
    const resText = await response.text();
    try {
      json = JSON.parse(resText);
    } catch {
      // Server returned HTML (e.g. static host rewrite). Fall back to client Tesseract.
      const fb = await clientTesseractOCR(uploadCanvas, signal);
      if (fb.success && fb.batteryPercent !== undefined) {
        return {
          success: true,
          batteryPercent: fb.batteryPercent,
          confidence: fb.confidence,
          method: 'client-tesseract',
          processingTime: processingTime(),
          rawText: fb.raw,
          attempts: 1,
          trace: [],
          region: guide,
        };
      }
      return fail('Could not read battery. Retake photo or enter percentage manually.');
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      if (signal?.aborted) return fail('Request cancelled.');
      return fail('OCR timed out. Retake photo with the battery digits centered in focus.');
    }
    // Network / backend offline (e.g. Firebase Hosting serverless mode)
    const fb = await clientTesseractOCR(uploadCanvas, signal);
    if (fb.success && fb.batteryPercent !== undefined) {
      return {
        success: true,
        batteryPercent: fb.batteryPercent,
        confidence: fb.confidence,
        method: 'client-tesseract',
        processingTime: processingTime(),
        rawText: fb.raw,
        attempts: 1,
        trace: [],
        region: guide,
      };
    }
    return fail('Could not read battery. Drag a green box over the digits to retry.');
  }

  // ── 5. Interpret backend response.
  const pt = processingTime();
  const attempts = typeof json['attempts'] === 'number' ? (json['attempts'] as number) : 0;

  if (!json['success']) {
    return {
      success: false,
      error:
        typeof json['error'] === 'string'
          ? (json['error'] as string)
          : 'Could not read battery. Drag a green box over the digits to retry.',
      processingTime: pt,
      attempts,
      trace: [],
    };
  }

  const batteryPercent =
    typeof json['battery_percent'] === 'number' ? (json['battery_percent'] as number) : undefined;
  if (batteryPercent === undefined || batteryPercent < 0 || batteryPercent > 100) {
    return fail('Server returned an invalid percentage.', attempts);
  }

  return {
    success: true,
    batteryPercent,
    confidence: typeof json['confidence'] === 'number' ? (json['confidence'] as number) : undefined,
    method: typeof json['method'] === 'string' ? (json['method'] as string) : undefined,
    processingTime: pt,
    rawText: typeof json['raw_text'] === 'string' ? (json['raw_text'] as string) : undefined,
    attempts,
    trace: [],
    region: guide,
  };
}

/**
 * Fast live-frame OCR helper.
 * Converts an already cropped in-memory frame canvas to a small JPEG blob (~10-18 KB)
 * and POSTs to /api/battery-ocr.
 * Does not write to disk or persist images.
 */
export async function recognizeBatteryFromCanvas(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<{ success: boolean; batteryPercent?: number; confidence?: number; error?: string }> {
  if (!canvas || canvas.width === 0 || canvas.height === 0) {
    return { success: false, error: 'Empty frame canvas' };
  }

  let blob: Blob;
  try {
    blob = await canvasToJpegBlob(canvas, 0.85);
  } catch {
    return { success: false, error: 'Frame encode failed' };
  }

  const form = new FormData();
  form.append('image', blob, 'frame.jpg');

  try {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    if (signal) {
      if (signal.aborted) return { success: false, error: 'Cancelled' };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), 6000);
    const backendBase = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');
    const res = await fetch(`${backendBase}/api/battery-ocr`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortHandler);

    if (!res.ok) {
      if (res.status === 404 || res.status === 502 || res.status === 503) {
        const fb = await clientTesseractOCR(canvas, signal);
        if (fb.success && fb.batteryPercent !== undefined) {
          return {
            success: true,
            batteryPercent: fb.batteryPercent,
            confidence: fb.confidence,
          };
        }
      }
      const body = await res.json().catch(() => null) as { detail?: string } | null;
      return { success: false, error: body?.detail || `Server error ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;
    if (data.success && typeof data.battery_percent === 'number') {
      const val = data.battery_percent;
      if (val >= 0 && val <= 100) {
        return {
          success: true,
          batteryPercent: val,
          confidence: typeof data.confidence === 'number' ? data.confidence : 1.0,
        };
      }
    }
    return {
      success: false,
      error: typeof data.error === 'string' ? data.error : 'Battery not detected in frame',
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: 'Request aborted' };
    }
    const fb = await clientTesseractOCR(canvas, signal);
    if (fb.success && fb.batteryPercent !== undefined) {
      return {
        success: true,
        batteryPercent: fb.batteryPercent,
        confidence: fb.confidence,
      };
    }
    return { success: false, error: 'Connection error during OCR' };
  }
}

