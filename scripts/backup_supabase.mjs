#!/usr/bin/env node
/**
 * backup_supabase.mjs
 *
 * Creates a timestamped JSON snapshot of the live Supabase "devices" table.
 * Run this BEFORE the migration cutover.  It does not modify any data.
 *
 * Usage:
 *   node scripts/backup_supabase.mjs [--out backups/]
 *
 * Env vars required  (copy from your Supabase project settings):
 *   SUPABASE_URL       e.g. https://nufzfmkplcspwhwnarbc.supabase.co
 *   SUPABASE_SERVICE_KEY  (service_role key — never commit to git)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs   = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://nufzfmkplcspwhwnarbc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_KEY env var is required.');
  console.error('  export SUPABASE_SERVICE_KEY=<service_role key from Supabase dashboard>');
  process.exit(1);
}

const args   = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = outArg !== -1 ? args[outArg + 1] : 'backups';

fs.mkdirSync(outDir, { recursive: true });

async function fetchAll(table) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.asc&offset=${from}&limit=${PAGE}`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Range-Unit': 'items',
        'Range': `${from}-${from + PAGE - 1}`,
      }
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase error ${res.status}: ${t}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function run() {
  console.log('Connecting to Supabase...');
  const devices = await fetchAll('devices');
  console.log(`Fetched ${devices.length} device records.`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `supabase_backup_${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ exported_at: new Date().toISOString(), count: devices.length, devices }, null, 2));
  console.log(`\nBackup saved to: ${outFile}`);
  console.log('Keep this file safe — it is the source for the Firestore import.');
}

run().catch(err => { console.error(err); process.exit(1); });
