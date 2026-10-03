#!/usr/bin/env node
/**
 * import_from_excel.mjs
 *
 * Non-destructive import from the legacy Excel workbook into Cloud Firestore.
 *
 * Usage:
 *   node scripts/import_from_excel.mjs [--file path/to/aging_test.xlsx] [--dry-run]
 *
 * Requirements:
 *   npm install -g firebase-admin xlsx
 *   Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON, OR run with
 *   "gcloud auth application-default login".
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX   = require('xlsx');
const admin  = require('firebase-admin');
const path   = require('path');
const fs     = require('fs');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const fileArg  = args.indexOf('--file');
const filePath = fileArg !== -1 ? args[fileArg + 1] : path.resolve('data/aging_test.xlsx');

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();

function toIso(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string' && val.includes('T')) return val;
  // Excel serial date
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0)).toISOString();
  }
  return String(val);
}

async function run() {
  const wb  = XLSX.readFile(filePath);
  const ws  = wb.Sheets['Devices'];
  if (!ws) { console.error('Sheet "Devices" not found.'); process.exit(1); }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let imported = 0, skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const serial = String(r[0]).trim();
    const ref  = db.collection('devices').doc(serial);
    const snap = await ref.get();
    if (snap.exists) { console.log(`  SKIP (exists): ${serial}`); skipped++; continue; }

    const doc = {
      serial_number: serial,
      registration_time:    toIso(r[1]),
      registration_battery: r[2] ?? null,
      h1_battery: r[3] ?? null,  h1_timestamp: r[4] ? String(r[4]) : null,  h1_server_time: null,
      h2_battery: r[5] ?? null,  h2_timestamp: r[6] ? String(r[6]) : null,  h2_server_time: null,
      h3_battery: r[7] ?? null,  h3_timestamp: r[8] ? String(r[8]) : null,  h3_server_time: null,
      h4_battery: r[9] ?? null,  h4_timestamp: r[10] ? String(r[10]) : null, h4_server_time: null,
      post_aging_battery: r[11] ?? null, post_aging_timestamp: r[12] ? String(r[12]) : null, post_aging_server_time: null,
      status: r[13] ?? 'UNKNOWN',
      observations: {
        h1:   r[14] != null ? { has_issue: r[14]==='Yes'?'yes':'no', categories: r[15] ? r[15].split(', ') : [], remarks: r[16] || '' } : null,
        h2:   r[17] != null ? { has_issue: r[17]==='Yes'?'yes':'no', categories: r[18] ? r[18].split(', ') : [], remarks: r[19] || '' } : null,
        h3:   r[20] != null ? { has_issue: r[20]==='Yes'?'yes':'no', categories: r[21] ? r[21].split(', ') : [], remarks: r[22] || '' } : null,
        h4:   r[23] != null ? { has_issue: r[23]==='Yes'?'yes':'no', categories: r[24] ? r[24].split(', ') : [], remarks: r[25] || '' } : null,
        post: r[26] != null ? { has_issue: r[26]==='Yes'?'yes':'no', categories: r[27] ? r[27].split(', ') : [], remarks: r[28] || '' } : null,
      },
      power_test_result: r[29] ?? null,
      last_battery: r[11] ?? r[9] ?? r[7] ?? r[5] ?? r[3] ?? r[2] ?? null,
      last_device_time: null, last_server_received: new Date().toISOString(),
      next_checkpoint: 1, pending_restart: null, aging_started: null, next_due: null,
      events: [{ action: 'imported_from_excel', server_received: new Date().toISOString() }],
    };

    if (DRY_RUN) {
      console.log(`  DRY-RUN: would import ${serial}`);
    } else {
      await ref.set(doc);
      console.log(`  IMPORTED: ${serial}`);
    }
    imported++;
  }

  console.log(`\nDone. Imported: ${imported}, Skipped: ${skipped}${DRY_RUN ? ' (dry run)' : ''}`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
