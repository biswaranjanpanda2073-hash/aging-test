import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cropVideoFrame, assessCropQuality, type NormalizedRect } from './camera';
import { decodeCodeFromCanvas, parseQRSerial } from './qr';
import { recognizeBatteryFromCanvas } from './batteryOCR';

function createMockCanvas(width = 100, height = 100, pixelGenerator?: (x: number, y: number, idx: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (pixelGenerator) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const [r, g, b, a = 255] = pixelGenerator(x, y, idx);
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = a;
      }
    }
  }

  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data, width, height }),
  };

  return {
    width,
    height,
    getContext: vi.fn().mockReturnValue(ctx),
    toBlob: vi.fn().mockImplementation((callback: (b: Blob) => void) => {
      callback(new Blob(['mock-jpeg-bytes'], { type: 'image/jpeg' }));
    }),
  } as unknown as HTMLCanvasElement;
}

describe('Live Scanner - Video Frame Cropping & Quality Assessment', () => {
  beforeEach(() => {
    // Provide a mock document.createElement for canvas creation in Node test environment
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return createMockCanvas(100, 100);
        }
        return {};
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('crops video frame using normalized coordinates and clamps properly', () => {
    const mockVideo = {
      videoWidth: 1920,
      videoHeight: 1080,
    } as HTMLVideoElement;

    const guide: NormalizedRect = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
    const canvas = cropVideoFrame(mockVideo, guide, 640);

    expect(canvas).toBeDefined();
    expect(canvas.width).toBeLessThanOrEqual(640);
    expect(canvas.height).toBeLessThanOrEqual(640);
    // Aspect ratio of crop: (1920 * 0.8) / (1080 * 0.6) = 1536 / 648 ≈ 2.37
    expect(canvas.width / canvas.height).toBeCloseTo(1536 / 648, 1);
  });

  it('detects low lighting and returns appropriate guidance', () => {
    // Fill with very dark pixels (avg brightness < 35)
    const canvas = createMockCanvas(100, 100, () => [15, 15, 15]);
    const quality = assessCropQuality(canvas);
    expect(quality.brightness).toBeLessThan(35);
    expect(quality.guidance).toContain('lighting');
  });

  it('detects glare / washed out reflections and returns guidance', () => {
    // 50% pure white (glare > 40%), 50% mid-gray
    const canvas = createMockCanvas(100, 100, (_x, y) => {
      return y < 50 ? [255, 255, 255] : [100, 100, 100];
    });

    const quality = assessCropQuality(canvas);
    expect(quality.guidance).toContain('glare');
  });

  it('detects excessive motion blur and asks user to hold steady', () => {
    const canvas1 = createMockCanvas(100, 100, () => [128, 128, 128]);
    const initial = assessCropQuality(canvas1);
    expect(initial.guidance).toBeNull();

    // Frame with drastically different pixels simulates motion blur
    const canvas2 = createMockCanvas(100, 100, () => [20, 20, 20]);
    const moving = assessCropQuality(canvas2, initial.pixels);
    expect(moving.motion).toBeGreaterThan(20);
    expect(moving.guidance).toContain('Hold steady');
  });
});

describe('Live Scanner - Barcode & QR Code Decoding', () => {
  const serialRegex = '^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$';

  it('decodes barcode via native BarcodeDetector when available', async () => {
    const canvas = createMockCanvas(200, 200);

    const mockDetect = vi.fn().mockResolvedValue([{ rawValue: 'T130R4CIK54677' }]);
    class MockBarcodeDetector {
      detect = mockDetect;
    }

    (globalThis as unknown as Record<string, unknown>).BarcodeDetector = MockBarcodeDetector;

    const result = await decodeCodeFromCanvas(canvas);
    expect(result).toBe('T130R4CIK54677');
    expect(mockDetect).toHaveBeenCalled();

    delete (globalThis as unknown as Record<string, unknown>).BarcodeDetector;
  });

  it('rejects invalid or ambiguous barcode content without picking arbitrary serial', () => {
    expect(() => parseQRSerial('INVALID_CODE_123', serialRegex)).toThrow();
    expect(() => parseQRSerial('{"random_key":"T130R4CIK54677"}', serialRegex)).toThrow();
    expect(() => parseQRSerial('{"serial_number":"T130R4CIK54677","device_id":"T999R9AAA99999"}', serialRegex)).toThrow();
  });

  it('accepts valid serial number from QR or 1D barcode', () => {
    const serial = parseQRSerial('T130R4CIK54677', serialRegex);
    expect(serial).toBe('T130R4CIK54677');
  });
});

describe('Live Scanner - Transient Battery OCR Client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends transient crop to /api/battery-ocr and parses percentage 0-100', async () => {
    const canvas = createMockCanvas(100, 50);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        battery_percent: 85,
        confidence: 0.96,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await recognizeBatteryFromCanvas(canvas);
    expect(result.success).toBe(true);
    expect(result.batteryPercent).toBe(85);
    expect(result.confidence).toBe(0.96);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/battery-ocr',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    );
  });

  it('rejects out of bounds battery values (<0 or >100)', async () => {
    const canvas = createMockCanvas(100, 50);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        battery_percent: 150,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await recognizeBatteryFromCanvas(canvas);
    expect(result.success).toBe(false);
  });

  it('handles backend error responses gracefully without throwing', async () => {
    const canvas = createMockCanvas(100, 50);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ detail: 'Unclear battery display' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await recognizeBatteryFromCanvas(canvas);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unclear battery display');
  });
});
