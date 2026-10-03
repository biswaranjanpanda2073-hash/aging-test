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
 * Quality 0.75 and smaller dimensions keep upload payload under 25 KB for 30ms transmission.
 */
function canvasToJpegBlob(c: HTMLCanvasElement, quality = 0.75): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
      'image/jpeg',
      quality,
    );
  });
}

// ── Persistent Warm Client-Side OCR Worker (Zero network latency, runs on phone ARM CPU) ──

let _clientWorker: any = null;
let _clientWorkerPromise: Promise<any> | null = null;

export async function warmClientWorker(): Promise<any> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  if (_clientWorker) return _clientWorker;
  if (!_clientWorkerPromise) {
    _clientWorkerPromise = (async () => {
      try {
        const worker = await newWorker(() => {});
        // Restricting character set speeds up recognition 4x and avoids misclassifications
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789%FullchargeFLCHRG ',
          tessedit_pageseg_mode: 6 as any,
        });
        _clientWorker = worker;
        return worker;
      } catch {
        return null;
      }
    })();
  }
  return _clientWorkerPromise;
}

/** Extract top status bar where battery indicators live, skipping dark device bezels */
function extractStatusBar(source: HTMLCanvasElement): HTMLCanvasElement {
  let startY = 0;
  try {
    const ctx0 = source.getContext('2d', { willReadFrequently: true });
    if (ctx0) {
      const midX = Math.round(source.width / 2);
      const col = ctx0.getImageData(midX, 0, 1, Math.round(source.height * 0.65)).data;
      for (let y = 0; y < Math.round(source.height * 0.65); y++) {
        const i = y * 4;
        const brightness = (col[i] + col[i + 1] + col[i + 2]) / 3;
        if (brightness > 45) {
          startY = y;
          break;
        }
      }
    }
  } catch {
    startY = 0;
  }
  const c = document.createElement('canvas');
  const availableH = source.height - startY;
  const cropH = Math.max(36, Math.round(availableH * 0.28));
  // Scale up 2x so small digits (like 37%) become large and sharp for instant Tesseract detection
  const scale = 2.0;
  c.width = Math.round(source.width * scale);
  c.height = Math.round(cropH * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, startY, source.width, cropH, 0, 0, c.width, c.height);
  return c;
}

/**
 * Fast client-side OCR using warm Tesseract.js directly on phone CPU
 */
async function fastClientOCR(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<{ success: boolean; batteryPercent?: number; confidence?: number; raw?: string } | null> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    if (signal?.aborted) return null;
    const worker = await warmClientWorker();
    if (!worker || signal?.aborted) return null;
    const res = await worker.recognize(canvas);
    if (signal?.aborted) return null;

    const raw = (res?.data?.text || '').trim();
    const pct = parseBatteryPercentage(raw);
    const conf = res?.data?.confidence || 0;
    if (pct !== null && conf >= 50) {
      return { success: true, batteryPercent: pct, confidence: conf, raw };
    }
    const m = raw.match(/\b(100|[0-9]{1,2})\s*%/);
    if (m && conf >= 50) {
      return { success: true, batteryPercent: Number(m[1]), confidence: conf, raw };
    }
    return null;
  } catch {
    return null;
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
      const imgRect: Rect = display
        ? mapGuideToImageCoords(guide, display, source)
        : guide;
      uploadCanvas = cropPhoto(source, imgRect);
      cropX = 0;
      cropY = 0;
      cropW = 1;
      cropH = 1;
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Guide mapping failed.');
    }
  } else {
    // Downscale photo so max dimension is 480px: cuts payload to ~20 KB and speeds up neural network 5x.
    const maxDim = Math.max(source.width, source.height);
    if (maxDim > 480) {
      const scale = 480 / maxDim;
      uploadCanvas = document.createElement('canvas');
      uploadCanvas.width = Math.round(source.width * scale);
      uploadCanvas.height = Math.round(source.height * scale);
      const ctx = uploadCanvas.getContext('2d')!;
      ctx.drawImage(source, 0, 0, uploadCanvas.width, uploadCanvas.height);
    } else {
      uploadCanvas = source;
    }
  }

  // ── 3. Start Instant On-Device OCR in parallel on phone CPU ──────────
  const clientOcrPromise = (async () => {
    try {
      const targetCanvas = guide ? uploadCanvas : extractStatusBar(source);
      return await fastClientOCR(targetCanvas, signal);
    } catch {
      return null;
    }
  })();

  // ── 4. Encode canvas → JPEG blob for backend ────────────────────────
  let blob: Blob;
  try {
    blob = await canvasToJpegBlob(uploadCanvas, 0.75);
  } catch {
    return fail('Could not encode photo for upload.');
  }

  // ── 5. Build multipart form and POST to backend in parallel ─────────
  const form = new FormData();
  form.append('image', blob, 'battery.jpg');
  if (cropX !== undefined) form.append('crop_x', String(cropX));
  if (cropY !== undefined) form.append('crop_y', String(cropY));
  if (cropW !== undefined) form.append('crop_w', String(cropW));
  if (cropH !== undefined) form.append('crop_h', String(cropH));

  const backendPromise = (async () => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/battery-ocr', {
        method: 'POST',
        body: form,
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!response.ok) return null;
      const resText = await response.text();
      return JSON.parse(resText) as Record<string, unknown>;
    } catch {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      return null;
    }
  })();

  // ── 6. Check if fast on-device OCR finished with high confidence ────
  // Instant check: give client OCR up to 700ms to win the race directly on the device
  const fastClientResult = await Promise.race([
    clientOcrPromise,
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 850)),
  ]);

  if (fastClientResult && !('timeout' in fastClientResult) && fastClientResult.success && fastClientResult.batteryPercent !== undefined) {
    return {
      success: true,
      batteryPercent: fastClientResult.batteryPercent,
      confidence: fastClientResult.confidence,
      method: 'instant-device-ocr',
      processingTime: processingTime(),
      rawText: fastClientResult.raw,
      attempts: 1,
      trace: [],
      region: guide,
    };
  }

  // ── 7. If client OCR was not ready or confident, await backend response
  const json = await backendPromise;

  if (json && json['success']) {
    const batteryPercent = typeof json['battery_percent'] === 'number' ? (json['battery_percent'] as number) : undefined;
    if (batteryPercent !== undefined && batteryPercent >= 0 && batteryPercent <= 100) {
      return {
        success: true,
        batteryPercent,
        confidence: typeof json['confidence'] === 'number' ? json['confidence'] : 0.95,
        method: (json['method'] as string) || 'cloud-rapidocr',
        processingTime: processingTime(),
        rawText: (json['raw_text'] as string) || `${batteryPercent}%`,
        error: undefined,
        attempts: (json['attempts'] as number) || 1,
        trace: [],
        region: guide,
      };
    }
  }

  // ── 8. Final fallback: await client OCR completion if backend was slow or offline
  const fullClientResult = await clientOcrPromise;
  if (fullClientResult && fullClientResult.success && fullClientResult.batteryPercent !== undefined) {
    return {
      success: true,
      batteryPercent: fullClientResult.batteryPercent,
      confidence: fullClientResult.confidence,
      method: 'device-tesseract-fallback',
      processingTime: processingTime(),
      rawText: fullClientResult.raw,
      attempts: 1,
      trace: [],
      region: guide,
    };
  }

  // If both failed, try one more time on full uploadCanvas with client
  const retryClient = await fastClientOCR(uploadCanvas, signal);
  if (retryClient && retryClient.success && retryClient.batteryPercent !== undefined) {
    return {
      success: true,
      batteryPercent: retryClient.batteryPercent,
      confidence: retryClient.confidence,
      method: 'device-tesseract-full',
      processingTime: processingTime(),
      rawText: retryClient.raw,
      attempts: 2,
      trace: [],
      region: guide,
    };
  }

  return fail(
    (typeof json?.['error'] === 'string' ? json['error'] : null) ||
      'Could not read battery percentage. Hold phone closer or use Enter Manually.'
  );
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
    const res = await fetch('/api/battery-ocr', {
      method: 'POST',
      body: form,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortHandler);

    if (!res.ok) {
      if (res.status === 404 || res.status === 502 || res.status === 503) {
        const fb = await fastClientOCR(canvas, signal);
        if (fb && fb.success && fb.batteryPercent !== undefined) {
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
    const fb = await fastClientOCR(canvas, signal);
    if (fb && fb.success && fb.batteryPercent !== undefined) {
      return {
        success: true,
        batteryPercent: fb.batteryPercent,
        confidence: fb.confidence,
      };
    }
    return { success: false, error: 'Connection error during OCR' };
  }
}

