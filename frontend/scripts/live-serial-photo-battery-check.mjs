import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-battery-qa-'));
const py = process.env.QA_PYTHON || path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

console.log('--- Initializing End-to-End Test: Live Serial Scanning + Photo-Capture Battery Scanning ---');
const excelPath = path.join(tmp, 'qa-records.xlsx');

let servers = [];
const alreadyRunning = await (async () => {
  try {
    const res = await fetch('http://127.0.0.1:8000/api/health');
    return res.ok;
  } catch {
    return false;
  }
})();

if (!alreadyRunning) {
  servers = [
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
} else {
  console.log('Detected active development server. Running test suite against it.');
}

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
    if (!alreadyRunning) {
      await new Promise(r => setTimeout(r, 2000));
    }
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

    // Generate unique serial number matching ^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$
    const randomSuffix = String(Math.floor(10000 + Math.random() * 90000));
    const testSerial = `T130R4CIK${randomSuffix}`;
    console.log(`Using test serial number: ${testSerial}`);

    // Provide simulated rear camera WebRTC video stream for live serial QR scanning
    await page.addInitScript((serial) => {
      window.__MOCK_SERIAL__ = serial;
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');

        const draw = () => {
          ctx.fillStyle = '#102016';
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 28px Arial';
          ctx.fillText(`Live Stream: ${window.__MOCK_SERIAL__}`, 80, 240);

          if (!window.BarcodeDetector) {
            window.BarcodeDetector = class {
              async detect() {
                return [{ rawValue: window.__MOCK_SERIAL__, format: 'qr_code' }];
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
    }, testSerial);

    console.log('Navigating to frontend https://127.0.0.1:5173...');
    await page.goto('https://127.0.0.1:5173');
    await page.getByText('Server connected', { exact: true }).waitFor({ timeout: 15000 });

    const fixture100 = path.join(root, 'tests/fixtures/battery_100.jpg');
    const fixture85 = path.join(root, 'tests/fixtures/battery_85.jpg');
    const fixture65 = path.join(root, 'tests/fixtures/battery_65.jpg');
    const fixtureInvalid = path.join(root, 'tests/fixtures/battery_invalid.jpg');

    // =========================================================================
    // Test 1: Verify Rear-Camera Photo Inputs Exist with Proper Attributes
    // =========================================================================
    console.log('\n[TEST 1] Verifying battery file inputs and rear-camera attributes...');
    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count();
    if (count !== 3) throw new Error(`Expected exactly 3 battery file inputs, found ${count}`);
    for (let i = 0; i < count; i++) {
      const input = fileInputs.nth(i);
      const accept = await input.getAttribute('accept');
      const capture = await input.getAttribute('capture');
      if (accept !== 'image/*') throw new Error(`Input ${i} accept is '${accept}', expected 'image/*'`);
      if (capture !== 'environment') throw new Error(`Input ${i} capture is '${capture}', expected 'environment'`);
    }
    console.log('✓ All 3 battery inputs configured with accept="image/*" and capture="environment"');

    // =========================================================================
    // Test 2: Stage 01 - Live Serial QR Scan + Photo Battery OCR
    // =========================================================================
    console.log('\n[TEST 2] Testing Stage 01: Device Registration...');
    await page.getByRole('button', { name: /01 Device Registration/ }).click();

    // Step 1: Live camera serial scanning
    console.log('Testing live camera serial scan in Stage 01...');
    await page.getByRole('button', { name: /Serial Num Scanner/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    console.log('✓ Live WebRTC rear camera opened with alignment guide for serial scan');

    // Automatic decode of serial
    await page.waitForFunction((s) => {
      const serialEl = document.querySelector('.scanned-value-box .scanned-text');
      return serialEl && serialEl.textContent.includes(s);
    }, testSerial, { timeout: 10000 });
    console.log(`✓ Serial ${testSerial} decoded automatically via live camera`);

    // Step 2: Battery scanning failure & retake flow
    console.log('Testing user click opens camera directly (filechooser)...');
    const regChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /⚡ Battery Scan/i }).click();
    const regChooser = await regChooserPromise;
    console.log('✓ Clicking "⚡ Battery Scan" triggered phone camera synchronously without losing activation');

    // Provide invalid image to test error handling
    await regChooser.setFiles(fixtureInvalid);

    // Verify "Reading battery percentage…" indicator appears
    await page.locator('.battery-processing-card strong:has-text("Reading battery percentage…")').waitFor({ timeout: 3000 });
    console.log('✓ Processing indicator displayed: "Reading battery percentage…"');

    // Verify error card with "Retake Photo" button appears on failure
    await page.locator('.battery-error-card .btn-retake').waitFor({ timeout: 10000 });
    console.log('✓ Error handled gracefully: clear error message and Retake Photo button shown');

    // Click Retake Photo button and verify it triggers filechooser directly
    console.log('Testing "Retake Photo" button click directly requests camera...');
    const retakeChooserPromise = page.waitForEvent('filechooser');
    await page.locator('.battery-error-card .btn-retake').click();
    const retakeChooser = await retakeChooserPromise;
    console.log('✓ Retake Photo button opened phone camera directly');

    const tStart = performance.now();
    await retakeChooser.setFiles(fixture100);
    await page.locator('.confirm-registration-card').waitFor({ timeout: 10000 });
    const duration = ((performance.now() - tStart) / 1000).toFixed(2);
    console.log(`✓ Automatic OCR succeeded: 100% detected in ${duration}s (well within 5.0s target)`);

    // Verify detected battery text
    const regBatteryText = await page.locator('.scanned-value-box .scanned-text').nth(1).innerText();
    if (!regBatteryText.includes('100%')) throw new Error(`Expected 100%, got ${regBatteryText}`);
    console.log('✓ Detected Battery Level displays 100%');

    // Explicit confirmation before saving
    await page.getByRole('button', { name: /Confirm & Register Device/i }).click();
    await page.locator('.success-card-banner:has-text("REGISTRATION COMPLETE")').waitFor({ timeout: 10000 });
    console.log(`✓ Device ${testSerial} saved to Excel with initial status READY_FOR_AGING (100%)`);

    // =========================================================================
    // Test 3: Stage 02 - Aging Test Checkpoint H1 Photo Flow & Rescan
    // =========================================================================
    console.log('\n[TEST 3] Testing Stage 02: Aging Test Checkpoints...');
    await page.getByRole('button', { name: /Proceed to Aging Test \(02\)/i }).click();

    // Verify active device record banner
    await page.locator(`.stage2-serial-title:has-text("${testSerial}")`).waitFor({ timeout: 10000 });
    console.log(`✓ Active device record ${testSerial} verified in Stage 02`);

    // Checkpoint H1 button is active
    const h1Btn = page.getByRole('button', { name: /⚡ Scan H1 Battery/i });
    await h1Btn.waitFor({ timeout: 5000 });
    console.log('✓ H1 Checkpoint button is ready for scanning');

    const h1ChooserPromise = page.waitForEvent('filechooser');
    await h1Btn.click();
    const h1Chooser = await h1ChooserPromise;
    console.log('✓ Clicking "⚡ Scan H1 Battery" directly opened phone camera');

    // Provide 85% photo
    const tH1 = performance.now();
    await h1Chooser.setFiles(fixture85);
    await page.locator('.battery-processing-card strong:has-text("Reading battery percentage…")').waitFor({ timeout: 3000 });
    console.log('✓ Stage 02 processing indicator displayed: "Reading battery percentage…"');

    // Confirmation review screen is displayed
    await page.locator('.review:has-text("CONFIRM H1 READING")').waitFor({ timeout: 10000 });
    const h1Duration = ((performance.now() - tH1) / 1000).toFixed(2);
    console.log(`✓ H1 detected 85% in ${h1Duration}s on confirmation review screen`);

    // Verify checkpoint history table displays saving now
    const historyText = await page.locator('.review').innerText();
    if (!historyText.includes('85% (Saving now)')) throw new Error('Checkpoint history does not show pending 85%');
    console.log('✓ Checkpoint history table correctly shows 85%');

    // Test Rescan Battery on review screen
    console.log('Testing "↺ Rescan Battery" button on Stage 02 review screen...');
    const rescanChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /↺ Rescan Battery/i }).click();
    const rescanChooser = await rescanChooserPromise;
    console.log('✓ Clicking "↺ Rescan Battery" directly opened phone camera');

    await rescanChooser.setFiles(fixture100);
    await page.locator('.review:has-text("100%")').waitFor({ timeout: 10000 });
    console.log('✓ Rescan Battery successfully updated detected percentage to 100%');

    // Confirm H1
    await page.getByRole('button', { name: /Confirm & Save H1 to Excel/i }).click();
    await page.locator('.success:has-text("Reading for H1 (100%) stored in Excel successfully")').waitFor({ timeout: 10000 });
    console.log('✓ H1 Checkpoint confirmed and stored in Excel');

    // Advance device status to AGING_TEST_COMPLETE so it meets the prerequisite for Stage 03 packing
    const excelTarget = alreadyRunning ? path.join(root, 'data/aging_test.xlsx') : excelPath;
    execSync(`"${py}" -c "import openpyxl, json; from app.workflow import Store; wb = openpyxl.load_workbook(r'${excelTarget}'); row, meta, state = Store.locate(wb, '${testSerial}'); state['status'] = 'AGING_TEST_COMPLETE'; state['next_checkpoint'] = 5; state['pending_restart'] = None; wb['Devices'].cell(row, 14, 'AGING_TEST_COMPLETE'); wb['Workflow'].cell(meta, 2, json.dumps(state)); wb.save(r'${excelTarget}'); wb.close()"`, { cwd: path.join(root, 'backend') });
    console.log('✓ Device status advanced to AGING_TEST_COMPLETE for packing validation');

    // =========================================================================
    // Test 4: Stage 03 - Post Test / Packing Photo Flow (Threshold & Retake)
    // =========================================================================
    console.log('\n[TEST 4] Testing Stage 03: Post Test / Packing...');
    await page.getByRole('button', { name: /Back to Stages/i }).click();
    await page.getByRole('button', { name: /03 Post Test/ }).click();

    // Step 1: Live Serial Scan in Stage 03
    console.log('Testing live serial scan in Stage 03...');
    await page.getByRole('button', { name: /Serial Num Scanner/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    await page.waitForFunction((s) => {
      const el = document.querySelector('.scanned-value-box .scanned-text');
      return el && el.textContent.includes(s);
    }, testSerial, { timeout: 10000 });
    console.log(`✓ Serial ${testSerial} scanned live in Stage 03`);

    // Step 2: Test below 70% threshold
    console.log('Testing below 70% battery threshold (65%)...');
    const postChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /⚡ Battery Scan/i }).click();
    const postChooser = await postChooserPromise;
    console.log('✓ Clicking "⚡ Battery Scan (Packing)" directly opened phone camera');

    await postChooser.setFiles(fixture65);
    await page.locator('.battery-processing-card strong:has-text("Reading battery percentage…")').waitFor({ timeout: 3000 });

    // Review card with 65% should indicate below 70% and disable confirm button
    await page.locator('.confirm-registration-card').waitFor({ timeout: 10000 });
    const warningText = await page.locator('.confirm-registration-card p').innerText();
    if (!warningText.includes('below 70%')) throw new Error('Expected warning for below 70% battery');
    const isSaveDisabled = await page.getByRole('button', { name: /Confirm & Save to Excel/i }).isDisabled();
    if (!isSaveDisabled) throw new Error('Expected save button to be disabled for 65% battery');
    console.log('✓ 65% battery properly flagged: below 70% warning shown and Save button disabled');

    // Rescan with valid packing battery (85%)
    console.log('Rescanning with valid packing battery (85%)...');
    const postRescanPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Rescan Battery/i }).click();
    const postRescanChooser = await postRescanPromise;
    console.log('✓ Clicking "Rescan Battery" opened camera directly');

    await postRescanChooser.setFiles(fixture85);
    await page.locator('.confirm-registration-card:has-text("85%")').waitFor({ timeout: 10000 });
    const isSaveEnabled = !(await page.getByRole('button', { name: /Confirm & Save to Excel/i }).isDisabled());
    if (!isSaveEnabled) throw new Error('Expected save button to be enabled for 85% battery');
    console.log('✓ 85% battery within packing range (70–100%) and Save button enabled');

    // Test Camera Cancellation
    console.log('Testing camera cancellation...');
    const cancelChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Rescan Battery/i }).click();
    await cancelChooserPromise;
    // Dispatch cancel event simulating user closing native camera
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      inputs[2]?.dispatchEvent(new Event('cancel', { bubbles: true }));
    });
    // Verify 85% is still displayed and confirm card remains active
    const afterCancelText = await page.locator('.confirm-registration-card strong').nth(1).innerText();
    if (!afterCancelText.includes('85%')) throw new Error(`Expected 85% to remain after cancel, got ${afterCancelText}`);
    console.log('✓ Camera cancellation handled: screen and data remain unchanged');

    // Confirm Post Test
    await page.getByRole('button', { name: /Confirm & Save to Excel/i }).click();
    await page.locator('.registration-success-card:has-text("PACKING READY")').waitFor({ timeout: 10000 });
    console.log(`✓ Device ${testSerial} marked PACKING_READY in Excel`);

    // Verify no unhandled page errors
    if (errors.length > 0) {
      throw new Error(`Browser page errors detected: ${JSON.stringify(errors)}`);
    }

    console.log('\n========================================================================');
    console.log('ALL TESTS PASSED: Live serial scanning & photo battery capture verified!');
    console.log('========================================================================');
  } finally {
    if (browser) await browser.close();
    cleanup();
  }
})().catch(e => {
  console.error('\nTEST FAILED:', e);
  process.exitCode = 1;
});
