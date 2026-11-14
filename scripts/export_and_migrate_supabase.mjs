#!/usr/bin/env node
/**
 * scripts/export_and_migrate_supabase.mjs
 *
 * 1. Fetches all historical device records from Supabase REST API
 * 2. Saves local backups to backups/supabase_devices.json & backups/supabase_devices.csv
 * 3. Generates backups/neon_historical_devices.sql (ready to paste into Neon SQL Editor)
 * 4. (Optional) Directly upserts into Neon PostgreSQL via HTTP API or DATABASE_URL
 *
 * Usage:
 *   node scripts/export_and_migrate_supabase.mjs [--neon-db "<POSTGRES_OR_NEON_URL>"]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nufzfmkplcspwhwnarbc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51ZnpmbWtwbGNzcHdod25hcmJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NDU1OTIsImV4cCI6MjEwNjQyMTU5Mn0.3gZJWDJwGy7QVirYaiW_erpXlsx2TohKrqRieLqT9c8';

// Extract arguments
const args = process.argv.slice(2);
let neonDbUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '';
const neonIdx = args.indexOf('--neon-db');
if (neonIdx !== -1 && args[neonIdx + 1]) {
  neonDbUrl = args[neonIdx + 1];
}

function escapeSqlString(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

function toCsvValue(val) {
  if (val === null || val === undefined) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

async function fetchSupabaseDevices() {
  console.log(`Connecting to Supabase at ${SUPABASE_URL}...`);
  const allDevices = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/devices?select=*&order=created_at.asc&offset=${offset}&limit=${limit}`;
    const resp = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Supabase returned HTTP ${resp.status}: ${errText}`);
    }

    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    allDevices.push(...batch);
    console.log(`  Fetched ${allDevices.length} devices...`);
    if (batch.length < limit) break;
    offset += limit;
  }

  return allDevices;
}

function generateSql(devices) {
  const lines = [
    '--',
    '-- Neon PostgreSQL Historical Devices Migration Script',
    `-- Exported: ${new Date().toISOString()}`,
    `-- Total devices: ${devices.length}`,
    '--',
    'BEGIN;',
    ''
  ];

  for (const dev of devices) {
    const serial = escapeSqlString(dev.serial_number);
    const status = escapeSqlString(dev.status || 'WAITING_FOR_100_PERCENT_CHARGE');
    const pendingRestart = dev.pending_restart !== null && dev.pending_restart !== undefined ? dev.pending_restart : 'NULL';
    const nextCheckpoint = dev.next_checkpoint || 1;
    const agingStarted = escapeSqlString(dev.aging_started);
    const nextDue = escapeSqlString(dev.next_due);
    const lastServerReceived = escapeSqlString(dev.last_server_received || new Date().toISOString());
    const lastDeviceTime = escapeSqlString(dev.last_device_time);
    const lastBattery = typeof dev.last_battery === 'number' ? dev.last_battery : 0;
    const regTime = escapeSqlString(dev.registration_time || dev.last_server_received || new Date().toISOString());
    const regBattery = typeof dev.registration_battery === 'number' ? dev.registration_battery : lastBattery;

    const h1Bat = dev.h1_battery !== null && dev.h1_battery !== undefined ? dev.h1_battery : 'NULL';
    const h1Ts = escapeSqlString(dev.h1_timestamp);
    const h1St = escapeSqlString(dev.h1_server_time);

    const h2Bat = dev.h2_battery !== null && dev.h2_battery !== undefined ? dev.h2_battery : 'NULL';
    const h2Ts = escapeSqlString(dev.h2_timestamp);
    const h2St = escapeSqlString(dev.h2_server_time);

    const h3Bat = dev.h3_battery !== null && dev.h3_battery !== undefined ? dev.h3_battery : 'NULL';
    const h3Ts = escapeSqlString(dev.h3_timestamp);
    const h3St = escapeSqlString(dev.h3_server_time);

    const h4Bat = dev.h4_battery !== null && dev.h4_battery !== undefined ? dev.h4_battery : 'NULL';
    const h4Ts = escapeSqlString(dev.h4_timestamp);
    const h4St = escapeSqlString(dev.h4_server_time);

    const postBat = dev.post_aging_battery !== null && dev.post_aging_battery !== undefined ? dev.post_aging_battery : 'NULL';
    const postTs = escapeSqlString(dev.post_aging_timestamp);
    const postSt = escapeSqlString(dev.post_aging_server_time);

    const obs = escapeSqlString(dev.observations || { h1: null, h2: null, h3: null, h4: null, post: null });
    const pwr = escapeSqlString(dev.power_test_result);
    const evts = escapeSqlString(dev.events || []);

    const sql = `INSERT INTO public.devices (
    serial_number, status, pending_restart, next_checkpoint, aging_started, next_due,
    last_server_received, last_device_time, last_battery, registration_time, registration_battery,
    h1_battery, h1_timestamp, h1_server_time,
    h2_battery, h2_timestamp, h2_server_time,
    h3_battery, h3_timestamp, h3_server_time,
    h4_battery, h4_timestamp, h4_server_time,
    post_aging_battery, post_aging_timestamp, post_aging_server_time,
    observations, power_test_result, events
) VALUES (
    ${serial}, ${status}, ${pendingRestart}, ${nextCheckpoint}, ${agingStarted}, ${nextDue},
    ${lastServerReceived}, ${lastDeviceTime}, ${lastBattery}, ${regTime}, ${regBattery},
    ${h1Bat}, ${h1Ts}, ${h1St},
    ${h2Bat}, ${h2Ts}, ${h2St},
    ${h3Bat}, ${h3Ts}, ${h3St},
    ${h4Bat}, ${h4Ts}, ${h4St},
    ${postBat}, ${postTs}, ${postSt},
    ${obs}::jsonb, ${pwr}, ${evts}::jsonb
)
ON CONFLICT (serial_number) DO UPDATE SET
    status = EXCLUDED.status,
    pending_restart = EXCLUDED.pending_restart,
    next_checkpoint = EXCLUDED.next_checkpoint,
    aging_started = COALESCE(EXCLUDED.aging_started, devices.aging_started),
    next_due = EXCLUDED.next_due,
    last_server_received = EXCLUDED.last_server_received,
    last_device_time = EXCLUDED.last_device_time,
    last_battery = EXCLUDED.last_battery,
    h1_battery = COALESCE(EXCLUDED.h1_battery, devices.h1_battery),
    h1_timestamp = COALESCE(EXCLUDED.h1_timestamp, devices.h1_timestamp),
    h2_battery = COALESCE(EXCLUDED.h2_battery, devices.h2_battery),
    h2_timestamp = COALESCE(EXCLUDED.h2_timestamp, devices.h2_timestamp),
    h3_battery = COALESCE(EXCLUDED.h3_battery, devices.h3_battery),
    h3_timestamp = COALESCE(EXCLUDED.h3_timestamp, devices.h3_timestamp),
    h4_battery = COALESCE(EXCLUDED.h4_battery, devices.h4_battery),
    h4_timestamp = COALESCE(EXCLUDED.h4_timestamp, devices.h4_timestamp),
    post_aging_battery = COALESCE(EXCLUDED.post_aging_battery, devices.post_aging_battery),
    post_aging_timestamp = COALESCE(EXCLUDED.post_aging_timestamp, devices.post_aging_timestamp),
    observations = EXCLUDED.observations,
    power_test_result = COALESCE(EXCLUDED.power_test_result, devices.power_test_result),
    events = EXCLUDED.events,
    updated_at = NOW();`;

    lines.push(sql);
    lines.push('');
  }

  lines.push('COMMIT;');
  return lines.join('\n');
}

async function executeNeonHttpSql(query, neonUrl) {
  const parsed = new URL(neonUrl);
  const host = parsed.hostname;
  const user = parsed.username;
  const pass = parsed.password;
  const dbName = parsed.pathname.replace(/^\//, '');

  const httpUrl = `https://${host}/sql`;
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Neon-Database-Name': dbName,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Neon HTTP SQL failed (${res.status}): ${txt}`);
  }
  return await res.json();
}

async function main() {
  const backupsDir = path.join(ROOT, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  // 1. Fetch devices from Supabase
  const devices = await fetchSupabaseDevices();
  console.log(`\n✅ Successfully downloaded ${devices.length} historical devices from Supabase!`);

  // 2. Save JSON backup
  const jsonPath = path.join(backupsDir, 'supabase_devices_backup.json');
  fs.writeFileSync(jsonPath, JSON.stringify(devices, null, 2), 'utf8');
  console.log(`📁 JSON Backup saved to: ${jsonPath}`);

  // 3. Save CSV backup
  if (devices.length > 0) {
    const keys = Object.keys(devices[0]);
    const csvHeader = keys.map((k) => `"${k}"`).join(',');
    const csvRows = devices.map((d) => keys.map((k) => toCsvValue(d[k])).join(','));
    const csvContent = [csvHeader, ...csvRows].join('\n');
    const csvPath = path.join(backupsDir, 'supabase_devices_backup.csv');
    fs.writeFileSync(csvPath, csvContent, 'utf8');
    console.log(`📁 CSV Backup saved to: ${csvPath}`);
  }

  // 4. Generate SQL Script
  const sqlContent = generateSql(devices);
  const sqlPath = path.join(backupsDir, 'neon_historical_devices.sql');
  fs.writeFileSync(sqlPath, sqlContent, 'utf8');
  console.log(`📁 Neon Migration SQL saved to: ${sqlPath}`);

  // 5. If Neon URL supplied, run migration directly
  if (neonDbUrl) {
    console.log(`\nPushing ${devices.length} devices into Neon PostgreSQL...`);
    try {
      await executeNeonHttpSql(sqlContent, neonDbUrl);
      console.log(`🎉 SUCCESS: All ${devices.length} devices have been imported into Neon PostgreSQL!`);
    } catch (err) {
      console.error(`⚠️ Direct Neon HTTP upload encountered: ${err.message}`);
      console.log(`💡 You can also copy and paste ${sqlPath} directly into the Neon SQL Editor!`);
    }
  } else {
    console.log(`\n💡 To complete migration into Neon:`);
    console.log(`   Option A: Open Neon SQL Editor and paste contents of:`);
    console.log(`             ${sqlPath}`);
    console.log(`   Option B: Run: node scripts/export_and_migrate_supabase.mjs --neon-db "<YOUR_NEON_CONNECTION_STRING>"`);
  }
}

main().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
