#!/usr/bin/env node
/**
 * verify_migration.mjs
 *
 * Reads the Supabase backup JSON and a live Firestore export (or live Firestore)
 * and compares serial numbers, statuses, and battery values.
 *
 * Usage (after importing to Firestore):
 *   node scripts/verify_migration.mjs --backup backups/supabase_backup_XXX.json
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

const args    = process.argv.slice(2);
const bkIdx   = args.indexOf('--backup');
if (bkIdx === -1) { console.error('--backup <file> required'); process.exit(1); }
const bkFile  = args[bkIdx + 1];

if (!fs.existsSync(bkFile)) { console.error(`Backup not found: ${bkFile}`); process.exit(1); }

admin.initializeApp();
const db = admin.firestore();

async function run() {
  const backup   = JSON.parse(fs.readFileSync(bkFile,'utf8'));
  const expected = backup.devices;
  console.log(`Backup: ${expected.length} records from ${backup.exported_at}`);

  const snap = await db.collection('devices').get();
  const actual = {};
  snap.docs.forEach(d => { actual[d.id] = d.data(); });
  console.log(`Firestore: ${snap.size} records`);

  let ok = 0, missing = 0, mismatch = 0;
  const issues = [];

  for (const row of expected) {
    const s = row.serial_number;
    if (!actual[s]) {
      missing++;
      issues.push(`MISSING  ${s}`);
      continue;
    }
    const fs_doc = actual[s];
    const checks = [
      ['status',               row.status,               fs_doc.status],
      ['registration_battery', row.registration_battery, fs_doc.registration_battery],
      ['h1_battery',           row.h1_battery,           fs_doc.h1_battery],
      ['h2_battery',           row.h2_battery,           fs_doc.h2_battery],
      ['h3_battery',           row.h3_battery,           fs_doc.h3_battery],
      ['h4_battery',           row.h4_battery,           fs_doc.h4_battery],
      ['post_aging_battery',   row.post_aging_battery,   fs_doc.post_aging_battery],
    ];
    const bad = checks.filter(([,a,b]) => String(a ?? '') !== String(b ?? ''));
    if (bad.length) {
      mismatch++;
      bad.forEach(([field,a,b]) => issues.push(`MISMATCH ${s} .${field}: supabase=${a} firestore=${b}`));
    } else {
      ok++;
    }
  }

  // Check for extra records in Firestore (imported elsewhere)
  const extras = Object.keys(actual).filter(s => !expected.find(r => r.serial_number === s));
  if (extras.length) console.log(`\nFirestore has ${extras.length} extra record(s) not in backup (OK if added during migration window): ${extras.slice(0,5).join(', ')}`);

  console.log(`\n=== Results ===`);
  console.log(`  OK:       ${ok}`);
  console.log(`  Missing:  ${missing}`);
  console.log(`  Mismatch: ${mismatch}`);
  if (issues.length) {
    console.log('\nIssues:');
    issues.forEach(i => console.log(' ', i));
    process.exit(1);
  } else {
    console.log('\nAll records match. Migration verified. ✓');
    process.exit(0);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
