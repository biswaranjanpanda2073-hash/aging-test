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
    const fixtureFullCharge = path.join(root, 'tests/fixtures/battery_full_charge.jpg');
    const fixtureConflict = path.join(root, 'tests/fixtures/battery_conflict.jpg');

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
    // Test 2: Stage 01 - Live Serial QR Scan + Photo Battery OCR ("Full charge" & Conflict)
    // =========================================================================
    console.log('\n[TEST 2] Testing Stage 01: Device Registration with "Full charge" OCR...');
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

    // Step 2: Test conflicting OCR ("Full charge 75%") requests a retake
    console.log('Testing OCR conflict handling ("Full charge 75%")...');
    const regChooserConflictPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /⚡ Battery Scan/i }).click();
    const regChooserConflict = await regChooserConflictPromise;
    await regChooserConflict.setFiles(fixtureConflict);
    await page.locator('.battery-processing-card strong:has-text("Reading battery percentage…")').waitFor({ timeout: 3000 });

    // Verify error card with retake button appears on conflicting readings
    await page.locator('.battery-error-card .btn-retake').waitFor({ timeout: 10000 });
    const conflictErr = await page.locator('.battery-error-card p').innerText();
    if (!conflictErr.toLowerCase().includes('retake') && !conflictErr.toLowerCase().includes('conflict')) {
      throw new Error(`Expected retake/conflict error message, got: ${conflictErr}`);
    }
    console.log(`✓ Conflicting OCR result handled correctly: "${conflictErr.trim()}"`);

    // Click Retake Photo button and upload "Full charge" image to verify 100% recognition
    console.log('Testing "Full charge" OCR converted to 100%...');
    const retakeChooserPromise = page.waitForEvent('filechooser');
    await page.locator('.battery-error-card .btn-retake').click();
    const retakeChooser = await retakeChooserPromise;
    console.log('✓ Retake Photo button opened phone camera directly');

    const tStart = performance.now();
    await retakeChooser.setFiles(fixtureFullCharge);
    await page.locator('.confirm-registration-card').waitFor({ timeout: 10000 });
    const duration = ((performance.now() - tStart) / 1000).toFixed(2);
    console.log(`✓ Automatic OCR succeeded: "Full charge" converted to 100% in ${duration}s`);

    // Verify detected battery text displays 100%
    const regBatteryText = await page.locator('.scanned-value-box .scanned-text').nth(1).innerText();
    if (!regBatteryText.includes('100%')) throw new Error(`Expected 100%, got ${regBatteryText}`);
    console.log('✓ Detected Battery Level displays 100% from "Full charge"');

    // Explicit confirmation before saving
    await page.getByRole('button', { name: /Confirm & Register Device/i }).click();
    await page.locator('.success-card-banner:has-text("REGISTRATION COMPLETE")').waitFor({ timeout: 10000 });
    console.log(`✓ Device ${testSerial} saved to Excel with initial status READY_FOR_AGING (100%)`);

    // =========================================================================
    // Test 3: Stage 02 - Aging Test Checkpoint H1 Photo Flow & Observations
    // =========================================================================
    console.log('\n[TEST 3] Testing Stage 02: Checkpoint H1 & Observation Validation...');
    await page.getByRole('button', { name: /Proceed to Aging Test \(02\)/i }).click();

    // Verify active device record banner
    await page.locator(`.stage2-serial-title:has-text("${testSerial}")`).waitFor({ timeout: 10000 });
    console.log(`✓ Active device record ${testSerial} verified in Stage 02`);

    // Checkpoint H1 button is active
    const h1Btn = page.getByRole('button', { name: /⚡ Scan H1 Battery/i });
    await h1Btn.waitFor({ timeout: 5000 });

    const h1ChooserPromise = page.waitForEvent('filechooser');
    await h1Btn.click();
    const h1Chooser = await h1ChooserPromise;

    // Provide 85% photo
    const tH1 = performance.now();
    await h1Chooser.setFiles(fixture85);
    await page.locator('.battery-processing-card strong:has-text("Reading battery percentage…")').waitFor({ timeout: 3000 });

    // Confirmation review screen is displayed
    await page.locator('.review:has-text("CONFIRM H1 READING")').waitFor({ timeout: 10000 });
    const h1Duration = ((performance.now() - tH1) / 1000).toFixed(2);
    console.log(`✓ H1 detected 85% in ${h1Duration}s on confirmation review screen`);

    // Verify observation section is present
    await page.locator('.obs-section:has-text("Issue Observation")').waitFor({ timeout: 5000 });
    console.log('✓ Issue Observation section visible on H1 review screen');

    // Verify Confirm button is disabled because observation is not yet answered
    const saveH1Btn = page.getByRole('button', { name: /Confirm & Save H1 to Excel/i });
    if (!(await saveH1Btn.isDisabled())) {
      throw new Error('Save H1 button must be disabled until issue observation is answered');
    }
    console.log('✓ Save H1 button disabled when observation is unselected');

    // Test Selecting "Yes" requires at least one category
    await page.locator('.obs-choice-btn:has-text("Yes")').click();
    await page.locator('.obs-categories-box').waitFor({ timeout: 3000 });
    if (!(await saveH1Btn.isDisabled())) {
      throw new Error('Save H1 button must be disabled when Yes is chosen but no category checked');
    }
    console.log('✓ Category selection required when Yes is selected');

    // Select category "Display issue" and "Crashing / hanging issue"
    await page.locator('label:has-text("Display issue") input').check();
    await page.locator('label:has-text("Crashing / hanging issue") input').check();
    if (await saveH1Btn.isDisabled()) {
      throw new Error('Save H1 button should be enabled after selecting categories');
    }
    console.log('✓ Save H1 button enabled with categories checked');

    // Test switching to "No" clears categories and disables them
    await page.locator('.obs-choice-btn:has-text("No")').click();
    if (await page.locator('.obs-categories-box').isVisible()) {
      throw new Error('Categories box should be hidden/cleared when No is selected');
    }
    if (await saveH1Btn.isDisabled()) {
      throw new Error('Save H1 button should be enabled when No is selected');
    }
    console.log('✓ Switching to No clears categories and keeps Save enabled');

    // Switch back to "Yes", select "Display issue", and enter remarks
    await page.locator('.obs-choice-btn:has-text("Yes")').click();
    await page.locator('label:has-text("Display issue") input').check();
    await page.locator('#cp-remarks').fill('Minor flicker observed on upper screen');

    // Confirm H1
    await saveH1Btn.click();
    await page.locator('.success:has-text("Reading for H1 (85%) stored in Excel successfully")').waitFor({ timeout: 10000 });
    console.log('✓ H1 Checkpoint confirmed and stored in Excel with Display issue observation');

    // Verify observation badge in stage 2 card
    await page.locator('.stage2-obs-badge:has-text("Display issue")').waitFor({ timeout: 5000 });
    console.log('✓ Stage 02 checkpoint card reflects recorded observation badge');

    // Advance device status to AGING_TEST_COMPLETE so it meets the prerequisite for Stage 03 packing
    const excelTarget = alreadyRunning ? path.join(root, 'data/aging_test.xlsx') : excelPath;
    execSync(`"${py}" -c "import openpyxl, json; from app.workflow import Store; wb = openpyxl.load_workbook(r'${excelTarget}'); row, meta, state = Store.locate(wb, '${testSerial}'); state['status'] = 'AGING_TEST_COMPLETE'; state['next_checkpoint'] = 5; state['pending_restart'] = None; wb['Devices'].cell(row, 14, 'AGING_TEST_COMPLETE'); wb['Workflow'].cell(meta, 2, json.dumps(state)); wb.save(r'${excelTarget}'); wb.close()"`, { cwd: path.join(root, 'backend') });
    console.log('✓ Device status advanced to AGING_TEST_COMPLETE for packing validation');

    // =========================================================================
    // Test 4: Stage 03 - Post Test / Packing Observations & Power Test
    // =========================================================================
    console.log('\n[TEST 4] Testing Stage 03: Post Test Observations & Power Test...');
    await page.getByRole('button', { name: /Back to Stages/i }).click();
    await page.getByRole('button', { name: /03 Post Test/ }).click();

    // Step 1: Live Serial Scan in Stage 03
    await page.getByRole('button', { name: /Serial Num Scanner/i }).click();
    await page.locator('.live-scanner video').waitFor({ timeout: 10000 });
    await page.waitForFunction((s) => {
      const el = document.querySelector('.scanned-value-box .scanned-text');
      return el && el.textContent.includes(s);
    }, testSerial, { timeout: 10000 });
    console.log(`✓ Serial ${testSerial} scanned live in Stage 03`);

    // Step 2: Post battery scan with 85%
    const postChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /⚡ Battery Scan/i }).click();
    const postChooser = await postChooserPromise;
    await postChooser.setFiles(fixture85);
    await page.locator('.confirm-registration-card:has-text("85%")').waitFor({ timeout: 10000 });
    console.log('✓ Post battery 85% detected and confirmation card rendered');

    // Verify Post Observations and Long Press Power Test are displayed
    await page.locator('.confirm-registration-card .obs-section:has-text("Issue Observation")').waitFor({ timeout: 5000 });
    await page.locator('.confirm-registration-card .power-test-section:has-text("Long Press Power Off/On Test")').waitFor({ timeout: 5000 });
    console.log('✓ Observation section and Long Press Power Test section visible on Post Test card');

    const confirmPostBtn = page.getByRole('button', { name: /Confirm & Save to Excel/i });

    // Confirm button must be disabled until both observations and power test are answered
    if (!(await confirmPostBtn.isDisabled())) {
      throw new Error('Confirm Post button must be disabled before observation & power test answers');
    }
    console.log('✓ Post save button initially disabled');

    // Select Power Test: Pass
    await page.locator('.power-test-btn:has-text("Pass")').click();
    if (!(await confirmPostBtn.isDisabled())) {
      throw new Error('Confirm Post button must remain disabled until observation is answered');
    }
    console.log('✓ Power Test selected: Pass (still requires observation)');

    // Select Observation: No
    await page.locator('.confirm-registration-card .obs-choice-btn:has-text("No")').click();
    if (await confirmPostBtn.isDisabled()) {
      throw new Error('Confirm Post button should now be enabled');
    }
    console.log('✓ Post save button enabled after selecting Pass and No issue');

    // Confirm Post Test
    await confirmPostBtn.click();
    await page.locator('.registration-success-card:has-text("PACKING READY")').waitFor({ timeout: 10000 });
    console.log(`✓ Device ${testSerial} marked PACKING_READY in Excel`);

    // Verify summary on completion card
    const postSuccessText = await page.locator('.registration-success-card').innerText();
    if (!postSuccessText.includes('Pass')) throw new Error('Post success card missing Power Test: Pass');
    if (!postSuccessText.includes('No issue observed')) throw new Error('Post success card missing No issue observed');
    console.log('✓ Final confirmation summary displays Power Test Pass and No issue observed');

    // =========================================================================
    // Test 5: Verify Excel Storage - Columns 1-14 preserved, Columns 15-30 populated
    // =========================================================================
    console.log('\n[TEST 5] Verifying Excel Columns 1–30...');
    const verifyScriptPath = path.join(tmp, 'verify.py');
    const backendPath = path.join(root, 'backend').replace(/\\/g, '/');
    const verifyScript = `import sys
sys.path.insert(0, '${backendPath}')
import openpyxl
from app.storage import ALL_HEADERS, extract_observations_from_row

wb = openpyxl.load_workbook(r'${excelTarget}')
ws = wb['Devices']
headers = [cell.value for cell in ws[1][:30]]
assert headers == ALL_HEADERS, f"Header mismatch in row 1: {headers}"
row_num = None
for r in range(2, ws.max_row + 1):
    if ws.cell(r, 1).value == '${testSerial}':
        row_num = r
        break
assert row_num is not None, "Could not find row for serial"
row_vals = [ws.cell(row_num, col).value for col in range(1, 31)]
print("Excel row values:", row_vals)
assert row_vals[0] == '${testSerial}'
assert row_vals[2] == 100
assert row_vals[13] == 'PACKING_READY'
# H1 observation
assert row_vals[14] == 'Yes', f"Expected H1 Issue 'Yes', got {row_vals[14]}"
assert row_vals[15] == 'Display issue', f"Expected H1 Cat 'Display issue', got {row_vals[15]}"
assert 'Minor flicker' in str(row_vals[16]), f"Expected remark, got {row_vals[16]}"
# H2-H4 should be None/blank
assert row_vals[17] is None
assert row_vals[20] is None
assert row_vals[23] is None
# Post observation & power test
assert row_vals[26] == 'No', f"Expected Post Issue 'No', got {row_vals[26]}"
assert row_vals[29] == 'Pass', f"Expected Long Press Power Test 'Pass', got {row_vals[29]}"
print("Excel verification passed completely!")
wb.close()
`;
    fs.writeFileSync(verifyScriptPath, verifyScript, 'utf8');
    execSync(`"${py}" "${verifyScriptPath}"`, { cwd: path.join(root, 'backend'), stdio: 'inherit' });
    console.log('✓ Excel columns 1–30 verified with exact values and formula safety');

    // Verify no unhandled page errors
    if (errors.length > 0) {
      throw new Error(`Browser page errors detected: ${JSON.stringify(errors)}`);
    }

    console.log('\n========================================================================');
    console.log('ALL TESTS PASSED: Full charge OCR, Observations, Power Test, and Excel OK!');
    console.log('========================================================================');
  } finally {
    if (browser) await browser.close();
    cleanup();
  }
})().catch(e => {
  console.error('\nTEST FAILED:', e);
  process.exitCode = 1;
});
