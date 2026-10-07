import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCameraCapabilities,
  applyCameraZoom,
  applyMacroFocus,
  applyTorch,
  captureFrameFromVideo,
  type NormalizedRect,
} from './camera';

describe('Battery Scanner - Camera Capabilities & Macro Zoom', () => {
  it('returns safe fallback capabilities when track is null or lacks getCapabilities', () => {
    const capsNull = getCameraCapabilities(null);
    expect(capsNull.hasZoom).toBe(false);
    expect(capsNull.hasMacro).toBe(false);
    expect(capsNull.minZoom).toBe(1);
    expect(capsNull.maxZoom).toBe(1);

    const capsNoMethod = getCameraCapabilities({} as MediaStreamTrack);
    expect(capsNoMethod.hasZoom).toBe(false);
  });

  it('correctly detects zoom, macro focus, and torch capabilities from track', () => {
    const mockTrack = {
      getCapabilities: () => ({
        zoom: { min: 1, max: 8, step: 0.1 },
        focusMode: ['continuous', 'macro'],
        focusDistance: { min: 0.05, max: 3 },
        torch: true,
      }),
      getSettings: () => ({ zoom: 2.0 }),
    } as unknown as MediaStreamTrack;

    const caps = getCameraCapabilities(mockTrack);
    expect(caps.hasZoom).toBe(true);
    expect(caps.minZoom).toBe(1);
    expect(caps.maxZoom).toBe(8);
    expect(caps.hasMacro).toBe(true);
    expect(caps.hasTorch).toBe(true);
    expect(caps.currentZoom).toBe(2.0);
  });

  it('applies hardware zoom constraints to video track', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const mockTrack = { applyConstraints } as unknown as MediaStreamTrack;

    const result = await applyCameraZoom(mockTrack, 2.5);
    expect(result).toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ zoom: 2.5 }],
    });
  });

  it('gracefully handles zoom constraint rejection without throwing', async () => {
    const applyConstraints = vi.fn().mockRejectedValue(new Error('Overconstrained'));
    const mockTrack = { applyConstraints } as unknown as MediaStreamTrack;

    const result = await applyCameraZoom(mockTrack, 10.0);
    expect(result).toBe(false);
  });

  it('applies macro focus mode and distance when available', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const mockTrack = {
      getCapabilities: () => ({
        focusMode: ['macro'],
        focusDistance: { min: 0.05 },
      }),
      applyConstraints,
    } as unknown as MediaStreamTrack;

    const result = await applyMacroFocus(mockTrack);
    expect(result).toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: 'macro', focusDistance: 0.05 }],
    });
  });

  it('toggles torch constraint when supported', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const mockTrack = { applyConstraints } as unknown as MediaStreamTrack;

    const result = await applyTorch(mockTrack, true);
    expect(result).toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ torch: true }],
    });
  });
});

describe('Battery Scanner - Frame Capture with Zoom Crop', () => {
  beforeEach(() => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: vi.fn(),
            }),
          };
        }
        return {};
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('captures full video frame when digitalZoom is 1.0', () => {
    const mockVideo = {
      videoWidth: 1920,
      videoHeight: 1080,
    } as HTMLVideoElement;

    const canvas = captureFrameFromVideo(mockVideo, { digitalZoom: 1.0, maxDimension: 1280 });
    expect(canvas).toBeDefined();
    expect(canvas.width).toBeLessThanOrEqual(1280);
    expect(canvas.height).toBeLessThanOrEqual(1280);
  });

  it('crops center region when digitalZoom is 2.0 (Macro magnification)', () => {
    const mockVideo = {
      videoWidth: 1920,
      videoHeight: 1080,
    } as HTMLVideoElement;

    const canvas = captureFrameFromVideo(mockVideo, { digitalZoom: 2.0, maxDimension: 1280 });
    expect(canvas).toBeDefined();
    // At 2x zoom on 1920x1080, source crop is 960x540. Scaled up to maxDimension (1280):
    // 960 is <= 1280, so canvas width is 960, height is 540.
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
  });

  it('crops according to guideRect when specified', () => {
    const mockVideo = {
      videoWidth: 1000,
      videoHeight: 1000,
    } as HTMLVideoElement;

    const guide: NormalizedRect = { x: 0.2, y: 0.3, width: 0.6, height: 0.4 };
    const canvas = captureFrameFromVideo(mockVideo, { guideRect: guide });
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
  });
});
