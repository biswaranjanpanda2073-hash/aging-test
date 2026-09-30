import { createWorker, PSM, type Worker } from 'tesseract.js';
import { loadPhoto, canvas, clear, cropPhoto, rotate, mapGuide, type Photo, type Rect } from './photo';
import { greenPanel, extractPanel } from './greenRegion';
export type BatteryGuideCoords = Rect;
export type BatteryAttempt = { method: string; crop: Rect; rotation: number; raw: string; confidence: number; milliseconds: number; error?: string };
export type BatteryDetectionResult = { success: boolean; batteryPercent?: number; confidence?: number; method?: string; processingTime: number; rawText?: string; error?: string; attempts: number; trace: BatteryAttempt[]; region?: Rect };
export function parseBatteryPercentage(text: string): number | null { const m = text.trim().match(/^(100|[0-9]{1,2})\s*%$/); return m ? Number(m[1]) : null; }
export function mapGuideToImageCoords(guide: Rect, display: HTMLElement, image: { width: number; height: number }) { const b = display.getBoundingClientRect(); const fit = getComputedStyle(display).objectFit === 'cover' ? 'cover' : 'contain'; return mapGuide({ ...guide, x: guide.x + b.x, y: guide.y + b.y }, b, image, fit); }
// Four variants to cover the range of battery display conditions:
// contrast   – normalises uneven lighting (dark room, glare)
// threshold  – binarises for dark-background dark text
// inverted   – binarises for WHITE text on dark background (the battery icon bar)
// original   – upscaled colour, catches cases where binarisation hurts thin anti-aliased digits
type Variant = 'contrast' | 'threshold' | 'inverted' | 'original';
function processCrop(input: HTMLCanvasElement, variant: Variant) {
    // Upscale to at least 150px tall so Tesseract can reliably identify short glyphs.
    const scale = Math.min(3, Math.max(1, 150 / input.height, 1200 / input.width));
    const out = canvas(input.width * scale + 40, input.height * scale + 40), ctx = out.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(input, 20, 20, out.width - 40, out.height - 40);
    if (variant === 'original') return out;
    const pixels = ctx.getImageData(0, 0, out.width, out.height), d = pixels.data, gray = new Uint8ClampedArray(out.width * out.height);
    for (let i = 0; i < gray.length; i++)gray[i] = d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114;
    const hist = new Uint32Array(256); let count = 0; for (let y = 20; y < out.height - 20; y++)for (let x = 20; x < out.width - 20; x++) { hist[gray[y * out.width + x]]++; count++; } let sum = 0, low = 0, high = 255; for (let v = 0; v < 256; v++) { sum += hist[v]; if (sum < count * .02) low = v; if (sum < count * .98) high = v; } const span = Math.max(1, high - low), mid = (low + high) / 2;
    for (let i = 0; i < gray.length; i++) {
        const v = gray[i];
        // threshold: dark text on light background; inverted: white text on dark background
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = variant === 'inverted' ? (v <= mid ? 255 : 0) : variant === 'threshold' ? (v > mid ? 255 : 0) : Math.min(255, Math.max(0, (v - low) * 255 / span));
    }
    ctx.putImageData(pixels, 0, 0); d.fill(0); gray.fill(0); return out;
}
function timeout<T>(p: Promise<T>, ms: number, message: string) { let t: ReturnType<typeof setTimeout>; return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(t)); }
export async function detectBatteryPercentage(input: Photo, guide?: Rect, display?: HTMLElement): Promise<BatteryDetectionResult> {
    const start = performance.now(), trace: BatteryAttempt[] = [];
    const evidence = new Set<number>();
    let source: HTMLCanvasElement | undefined, worker: Worker | undefined;
    const temps: HTMLCanvasElement[] = [];
    const candidates: { image: HTMLCanvasElement; crop: Rect; rotation: number; name: string }[] = [];
    const fail = (error: string): BatteryDetectionResult => ({ success: false, error, processingTime: performance.now() - start, attempts: trace.length, trace });
    try {
        source = await loadPhoto(input);
        if (guide) {
            const r = display ? mapGuideToImageCoords(guide, display, source) : guide;
            const c = cropPhoto(source, r, 1100); temps.push(c);
            candidates.push({ image: c, crop: r, rotation: 0, name: 'operator-guide' });
        } else {
            const panel = greenPanel(source);
            if (panel) {
                const aligned = extractPanel(source, panel); temps.push(aligned);
                for (const angle of [0, 90, 180, 270]) {
                    const c = rotate(aligned, angle); temps.push(c);
                    const r = { x: c.width * .12, y: c.height * .035, width: c.width * .20, height: c.height * .11 };
                    const strip = cropPhoto(c, r, 420); temps.push(strip);
                    candidates.push({ image: strip, crop: panel.bounds, rotation: angle - panel.angle * 180 / Math.PI, name: 'green-panel-top-strip' });
                }
            }
            // Top status bar candidates
            const topH = Math.max(40, Math.min(source.height, Math.round(source.height * 0.25)));

            // 1. Status bar top-left (where Tohands shows "84%")
            const rTopLeft = { x: 0, y: 0, width: Math.round(source.width * 0.50), height: topH };
            const stripTopLeft = cropPhoto(source, rTopLeft, 800); temps.push(stripTopLeft);
            candidates.push({ image: stripTopLeft, crop: rTopLeft, rotation: 0, name: 'status-bar-top-left' });

            // 2. Full photo (scaled to max 1200) - for close-up shots
            const rFull = { x: 0, y: 0, width: source.width, height: source.height };
            const stripFull = cropPhoto(source, rFull, 1200); temps.push(stripFull);
            candidates.push({ image: stripFull, crop: rFull, rotation: 0, name: 'close-up-full' });

            // 3. Status bar full top
            const rTop = { x: 0, y: 0, width: source.width, height: topH };
            const stripTop = cropPhoto(source, rTop, 1200); temps.push(stripTop);
            candidates.push({ image: stripTop, crop: rTop, rotation: 0, name: 'status-bar-full-top' });

            // 4. Center crop (for close-up shots centered on the battery percentage)
            const rCenter = { x: Math.round(source.width * 0.05), y: Math.round(source.height * 0.15), width: Math.round(source.width * 0.90), height: Math.round(source.height * 0.70) };
            const stripCenter = cropPhoto(source, rCenter, 1000); temps.push(stripCenter);
            candidates.push({ image: stripCenter, crop: rCenter, rotation: 0, name: 'center-crop' });

            // 5. Status bar top-right
            const rTopRight = { x: Math.round(source.width * 0.50), y: 0, width: Math.round(source.width * 0.50), height: topH };
            const stripTopRight = cropPhoto(source, rTopRight, 800); temps.push(stripTopRight);
            candidates.push({ image: stripTopRight, crop: rTopRight, rotation: 0, name: 'status-bar-top-right' });
        }
        if (candidates.length === 0) {
            return fail('No battery regions detected. Please drag a green box around the digits and % symbol to retry.');
        }
        const init = createWorker('eng', 1, { workerPath: '/ocr/worker.min.js', langPath: '/ocr', corePath: '/ocr/core', workerBlobURL: false, cacheMethod: 'none', errorHandler: () => { } });
        let expired = false; init.then(w => { if (expired) void w.terminate(); }).catch(() => { });
        try { worker = await timeout(init, 30000, 'OCR initialization timeout. Reload and check local OCR assets.'); } catch (e) { expired = true; throw e; }
        // Restrict to digits and % only. This eliminates letter-for-digit substitutions (O->0, l->1, S->5)
        // and allows Tesseract to converge much faster on short crops.
        // NOTE: with a character whitelist Tesseract's confidence scores are unreliable (artificially low),
        // so we do NOT gate on confidence — parseBatteryPercentage + the strict whitelist IS the gate.
        await worker.setParameters({
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist: '0123456789%',
        });
        // Four variants × each candidate image-crop.
        // Prioritize most likely candidate crops first (e.g. status-bar-top-left, close-up-full)
        // with contrast and inverted variants first.
        const variants: Variant[] = ['contrast', 'inverted', 'threshold', 'original'];
        for (const c of candidates) {
            for (const variant of variants) {
                if (performance.now() - start > 25000) return fail('OCR time limit reached. Please drag a green guide box over the battery digits and % symbol to retry.');
                for (const psm of [PSM.SINGLE_WORD, PSM.SINGLE_LINE]) {
                    await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: '0123456789%' });
                    const processed = processCrop(c.image, variant), at = performance.now();
                    try {
                        const { data } = await timeout(worker.recognize(processed, {}, { text: true, blocks: false }), 6000, 'OCR recognition timeout');
                        const raw = data.text.trim();
                        trace.push({ method: `${c.name}-${variant}-psm${psm}`, crop: c.crop, rotation: c.rotation, raw, confidence: data.confidence, milliseconds: performance.now() - at });
                        const tokens = raw.split(/\s+/).filter(Boolean);
                        const rawMatches = [...raw.matchAll(/(?:^|\D)(100|[0-9]{1,2})\s*%(?!\d)/g)].map(m => Number(m[1]));
                        const valid = rawMatches.length > 0 ? rawMatches : tokens.map(parseBatteryPercentage).filter((v): v is number => v !== null);
                        // With the character whitelist, parseBatteryPercentage is the only guard needed;
                        // confidence is not checked because whitelisted short crops have unreliable confidence scores.
                        if (valid.length !== 1) continue;
                        const value = valid[0];
                        evidence.add(value);
                        if (evidence.size > 1) return fail('Ambiguous OCR: conflicting credible percentages. Drag a green box around the battery digits to isolate.');
                        // Accept on the very first valid parse — whitelist + strict regex is sufficient protection.
                        // For guided crops the operator has selected the region; for auto-detection the green panel
                        // detection already localises the strip, so a single valid read is reliable.
                        return { success: true, batteryPercent: value, confidence: data.confidence, method: `${c.name}-${variant}-psm${psm}`, processingTime: performance.now() - start, rawText: raw, attempts: trace.length, trace, region: c.crop };
                    } finally { clear(processed); }
                }
            }
        }
        if (evidence.size > 1) return fail('Ambiguous OCR: conflicting credible percentages. Retake or tighten the crop.');
        return fail(guide ? 'Could not detect battery digits inside the selected box. Please adjust the green box carefully over only the digits and % symbol, or rotate if text is sideways.' : 'Could not scan battery automatically. Please drag a green guide box over the battery digits and % symbol to retry.');
    } catch (e) { return fail(e instanceof Error ? e.message : 'Image/OCR engine failure'); }
    finally { if (worker) await worker.terminate().catch(() => { }); for (const c of temps) clear(c); if (source && source !== input) clear(source); }
}
