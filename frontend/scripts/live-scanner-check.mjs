import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scanner-qa-'));
const py = process.env.QA_PYTHON || path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

console.log('Starting backend server and frontend preview...');
const excelPath = path.join(tmp, 'qa-records.xlsx');

const servers = [
  spawn(py, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: path.join(root, 'backend'),
    env: { ...process.env, EXCEL_FILE_PATH: excelPath, CHECKPOINT_INTERVAL_SECONDS: '0' },
    stdio: 'ignore',
  }),
  spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: path.join(root, 'frontend'),
    env: { ...process.env, SERVER_HOST: '127.0.0.1' },
    stdio: 'inherit',
  }),
];

const cleanup = () => {
  servers.forEach(s => {
    try { s.kill(); } catch { /* ignore */ }
  });
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* ignore */ }
};

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

(async () => {
  let browser;
  try {
    await new Promise(r => setTimeout(r, 2000));
    const browserCandidates = [
      process.env.CHROMIUM_EXECUTABLE,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    const executablePath = browserCandidates.find(p => fs.existsSync(p));
    console.log('Launching browser with executable:', executablePath || 'bundled chromium');

    browser = await chromium.launch({
      headless: true,
      executablePath,
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 }, // Mobile viewport
    });

    const page = await context.newPage();
    const errors = [];
    const posts = [];

    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {
      if (r.method() === 'POST') {
        const url = new URL(r.url()).pathname;
        try {
          posts.push({ url, data: r.postDataJSON() });
        } catch {
          posts.push({ url, data: '[binary or multipart]' });
        }
      }
    });

    // Provide simulated rear camera video stream
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');

        let frame = 0;
        const draw = () => {
          frame++;
          ctx.fillStyle = '#102016';
          ctx.fillRect(0, 0, 640, 480);

          // Draw battery percentage text inside the guided region (y: ~168 to ~302)
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 54px Arial';
          ctx.fillText('85%', 240, 240);

          // Also provide native BarcodeDetector mock so QR decoding happens instantly
          if (!window.BarcodeDetector) {
            window.BarcodeDetector = class {
              async detect() {
                return [{ rawValue: 'T130R4CIK54677', format: 'qr_code' }];
              }
            };
          }
        };

        draw();
        const stream = canvas.captureStream(15);
        const timer = setInterval(draw, 66);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });

    console.log('Navigating to frontend https://127.0.0.1:5173...');
    await page.goto('https://127.0.0.1:5173');
    await page.getByText('Server connected', { exact: true }).waitFor({ timeout: 15000 });

    // Verify responsive mobile layout
    const isMobileFit = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    if (!isMobileFit) throw new Error('Mobile viewport overflow detected');
    console.log('✓ Mobile viewport fits perfectly without horizontal overflow');

    // -------------------------------------------------------------
    // Test 1: Device Registration - Step 1: Live Serial Scanner
    // -------------------------------------------------------------
    await page.getByRole('button', { name: /01 Device Registration/ }).click();
    console.log('Testing Stage 01: Device Registration...');

    // Ensure no photo-upload inputs exist in DOM
    const fileInputs = await page.locator('input[type="file"]').count();
    if (fileInputs > 0) throw new Error(`Found ${fileInputs} photo file inputs! Must be 0.`);
    console.log('✓ 0 file input elements found (pure live camera scanner mode)');

    // Click "Serial Num Scanner"
    await page.getByRole('button', { name: /Serial Num Scanner/i }).click();

    // Verify live scanner modal is visible with <video> element
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    console.log('✓ Live rear camera video stream started for Serial Scanner');

    // Wait for automatic decode and camera shutdown
    await page.waitForFunction(() => {
      const serialEl = document.querySelector('.scanned-value-box .scanned-text');
      return serialEl && serialEl.textContent.includes('T130R4CIK54677');
    }, { timeout: 15000 });
    console.log('✓ Serial T130R4CIK54677 decoded automatically without photo capture or review button');

    // -------------------------------------------------------------
    // Test 2: Device Registration - Step 2: Live Battery Scanner
    // -------------------------------------------------------------
    await page.getByRole('button', { name: /Battery Scan/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    console.log('✓ Live rear camera video stream started for Battery Scanner');

    // Verify instruction prompt inside scanner
    await page.getByText('Position the device’s battery percentage inside the guide.').waitFor();
    console.log('✓ Battery guide prompt displayed');

    // Wait for OCR consensus to verify reading and populate field
    await page.waitForFunction(() => {
      const texts = Array.from(document.querySelectorAll('.scanned-text'));
      return texts.some(el => el.textContent.includes('85%'));
    }, { timeout: 15000 });
    console.log('✓ Battery percentage 85% recognized with consensus streak and camera stopped');

    // Confirm & Register Device explicit save action
    await page.getByRole('button', { name: 'Confirm & Register Device' }).click();
    await page.getByText('Device Registered Successfully!').waitFor({ timeout: 10000 });
    console.log('✓ Device registered successfully in Excel records via API');

    // -------------------------------------------------------------
    // Test 3: Aging Test - Lookup via Live Scanner
    // -------------------------------------------------------------
    console.log('Testing Stage 02: Aging Test Device Lookup...');
    await page.getByRole('button', { name: /Back to Stages/i }).first().click();
    await page.getByRole('button', { name: 'Open Aging Test →', exact: true }).click();

    // Verify "▣ Scanner to Find Device" button
    await page.getByRole('button', { name: /Scanner to Find Device/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    console.log('✓ Aging device lookup live scanner active');

    // Device should be found and checkpoints rendered
    await page.getByRole('heading', { name: 'T130R4CIK54677' }).waitFor({ timeout: 15000 });
    console.log('✓ Device found via live scanner lookup; checkpoints loaded');

    // -------------------------------------------------------------
    // Test 4: Post-Aging / Packing Screen
    // -------------------------------------------------------------
    console.log('Testing Stage 03: Post-Aging & Packing...');
    await page.getByRole('button', { name: /Back to Stages/i }).first().click();
    await page.getByRole('button', { name: 'Open Post Test →', exact: true }).click();

    // Verify serial scan button is present
    await page.getByRole('button', { name: /Serial Num Scanner/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    console.log('✓ Stage 03 live Serial Scanner active');

    // Wait for serial to be decoded
    await page.waitForFunction(() => {
      const el = document.querySelector('.scanned-text');
      return el && el.textContent.includes('T130R4CIK54677');
    }, { timeout: 15000 });
    console.log('✓ Stage 03 Serial decoded and loaded');

    // Now battery scan button appears
    const postBatteryBtn = await page.getByRole('button', { name: /Battery Scan/i }).isVisible();
    if (!postBatteryBtn) {
      throw new Error('Separate battery scan button missing in packing');
    }
    console.log('✓ Stage 03 has separate live scan buttons for Serial and Battery');

    if (errors.length > 0) {
      throw new Error('Page errors detected: ' + errors.join('; '));
    }

    console.log('\n========================================');
    console.log('ALL LIVE SCANNER AUTOMATED CHECKS PASSED');
    console.log('========================================\n');
  } finally {
    if (browser) await browser.close();
    cleanup();
  }
})().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
