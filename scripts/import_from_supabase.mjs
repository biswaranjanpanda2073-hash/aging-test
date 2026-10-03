#!/usr/bin/env node
/**
 * import_from_supabase.mjs
 *
 * Non-destructive import of a Supabase "devices" table CSV or JSON export
 * into Cloud Firestore.
 *
 * Usage:
 *   node scripts/import_from_supabase.mjs --file export.json [--dry-run]
 *   node scripts/import_from_supabase.mjs --file export.csv  [--dry-run]
 *
 * Requirements:
 *   npm install -g firebase-admin
 *   GOOGLE_APPLICATION_CREDENTIALS  or  gcloud auth application-default login
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const admin   = require('firebase-admin');
const fs      = require('fs');
const path    = require('path');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const fileArg  = args.indexOf('--file');

if (fileArg === -1) {
  console.error('Usage: node scripts/import_from_supabase.mjs --file <export.json|export.csv> [--dry-run]');
  process.exit(1);
}

const filePath = args[fileArg + 1];
if (!fs.existsSync(filePath)) { console.error(`Not found: ${filePath}`); process.exit(1); }

admin.initializeApp();
const db = admin.firestore();

function parseFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.json') {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(raw) ? raw : [raw];
  }
  // Simple CSV: first row = headers
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).filter(Boolean).map(line => {
    const cols = line.split(',');
    const obj = {};
    headers.forEach((h,i) => { obj[h] = (cols[i]||'').trim().replace(/^"|"$/g,'') || null; });
    return obj;
  });
}

function tryNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function mapRow(row) {
  const obs = (() => {
    try { return typeof row.observations === 'string' ? JSON.parse(row.observations) : (row.observations || {}); } catch { return {}; }
  })();
  return {
    serial_number:        row.serial_number,
    status:               row.status || 'UNKNOWN',
    pending_restart:      row.pending_restart != null ? Number(row.pending_restart) : null,
    next_checkpoint:      tryNum(row.next_checkpoint) ?? 1,
    aging_started:        row.aging_started || null,
    next_due:             row.next_due || null,
    last_server_received: row.last_server_received || new Date().toISOString(),
    last_device_time:     row.last_device_time || null,
    last_battery:         tryNum(row.last_battery),
    registration_time:    row.registration_time || null,
    registration_battery: tryNum(row.registration_battery),
    h1_battery: tryNum(row.h1_battery), h1_timestamp: row.h1_timestamp||null, h1_server_time: row.h1_server_time||null,
    h2_battery: tryNum(row.h2_battery), h2_timestamp: row.h2_timestamp||null, h2_server_time: row.h2_server_time||null,
    h3_battery: tryNum(row.h3_battery), h3_timestamp: row.h3_timestamp||null, h3_server_time: row.h3_server_time||null,
    h4_battery: tryNum(row.h4_battery), h4_timestamp: row.h4_timestamp||null, h4_server_time: row.h4_server_time||null,
    post_aging_battery:   tryNum(row.post_aging_battery),
    post_aging_timestamp: row.post_aging_timestamp || null,
    post_aging_server_time: row.post_aging_server_time || null,
    observations:         obs,
    power_test_result:    row.power_test_result || null,
    events:               (() => { try { return typeof row.events==='string' ? JSON.parse(row.events) : (row.events||[]); } catch { return []; } })(),
  };
}

async function run() {
  const rows = parseFile(filePath);
  let imported = 0, skipped = 0;

  for (const row of rows) {
    const serial = row.serial_number?.trim();
    if (!serial) { console.warn('  WARN: row missing serial_number, skipping'); continue; }
    const ref  = db.collection('devices').doc(serial);
    const snap = await ref.get();
    if (snap.exists) { console.log(`  SKIP (exists): ${serial}`); skipped++; continue; }

    const doc = mapRow(row);
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
