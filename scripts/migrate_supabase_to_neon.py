#!/usr/bin/env python3
"""
migrate_supabase_to_neon.py

Fetches all historical device records from Supabase (REST API)
and migrates them into Neon PostgreSQL.

Usage:
    python scripts/migrate_supabase_to_neon.py [--supabase-url ...] [--supabase-key ...] [--neon-db ...]
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
from pathlib import Path
from dotenv import load_dotenv

try:
    import psycopg2
    from psycopg2.extras import Json
except ImportError:
    psycopg2 = None

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / 'backend' / '.env')


def fetch_all_supabase_devices(supabase_url: str, supabase_key: str):
    devices = []
    limit = 500
    offset = 0
    headers = {
        'apikey': supabase_key,
        'Authorization': f'Bearer {supabase_key}',
        'Content-Type': 'application/json',
    }

    print(f"Fetching devices from Supabase ({supabase_url})...")
    while True:
        url = f"{supabase_url.rstrip('/')}/rest/v1/devices?select=*&order=created_at.asc&offset={offset}&limit={limit}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 200:
                    batch = json.loads(resp.read().decode('utf-8'))
                    if not batch:
                        break
                    devices.extend(batch)
                    print(f"  Fetched {len(devices)} devices so far...")
                    if len(batch) < limit:
                        break
                    offset += limit
                else:
                    print(f"ERROR: Supabase returned status {resp.status}")
                    break
        except Exception as e:
            print(f"ERROR fetching from Supabase: {e}")
            print("Note: If Supabase is currently paused, please click 'Restore project' in the Supabase Dashboard first.")
            break
    return devices


def main():
    parser = argparse.ArgumentParser(description="Migrate Supabase data to Neon PostgreSQL")
    parser.add_argument('--supabase-url', default=os.getenv('SUPABASE_URL', 'https://nufzfmkplcspwhwnarbc.supabase.co'))
    parser.add_argument('--supabase-key', default=os.getenv('SUPABASE_SERVICE_KEY', os.getenv('SUPABASE_KEY', '')))
    parser.add_argument('--neon-db', default=os.getenv('DATABASE_URL', os.getenv('NEON_DATABASE_URL', '')))
    args = parser.parse_args()

    if not args.supabase_key:
        print("ERROR: Supabase key is required.")
        sys.exit(1)

    if not args.neon_db:
        print("ERROR: Neon DATABASE_URL is required.")
        sys.exit(1)

    if not psycopg2:
        print("ERROR: psycopg2 is required. Run 'pip install psycopg2-binary'")
        sys.exit(1)

    devices = fetch_all_supabase_devices(args.supabase_url, args.supabase_key)
    if not devices:
        print("No devices found or Supabase is paused. Exiting.")
        sys.exit(1)

    print(f"\nMigrating {len(devices)} devices to Neon PostgreSQL...")
    db_url = args.neon_db
    if 'sslmode' not in db_url and 'neon.tech' in db_url:
        sep = '&' if '?' in db_url else '?'
        db_url = f"{db_url}{sep}sslmode=require"

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    upsert_sql = """
    INSERT INTO public.devices (
        serial_number, status, pending_restart, next_checkpoint, aging_started, next_due,
        last_server_received, last_device_time, last_battery, registration_time, registration_battery,
        h1_battery, h1_timestamp, h2_battery, h2_timestamp, h3_battery, h3_timestamp,
        h4_battery, h4_timestamp, post_aging_battery, post_aging_timestamp,
        observations, power_test_result, events
    ) VALUES (
        %(serial_number)s, %(status)s, %(pending_restart)s, %(next_checkpoint)s, %(aging_started)s, %(next_due)s,
        %(last_server_received)s, %(last_device_time)s, %(last_battery)s, %(registration_time)s, %(registration_battery)s,
        %(h1_battery)s, %(h1_timestamp)s, %(h2_battery)s, %(h2_timestamp)s, %(h3_battery)s, %(h3_timestamp)s,
        %(h4_battery)s, %(h4_timestamp)s, %(post_aging_battery)s, %(post_aging_timestamp)s,
        %(observations)s, %(power_test_result)s, %(events)s
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
        updated_at = NOW();
    """

    count = 0
    for dev in devices:
        try:
            cur.execute(upsert_sql, {
                **dev,
                'observations': Json(dev.get('observations') or {}),
                'events': Json(dev.get('events') or []),
            })
            count += 1
        except Exception as e:
            conn.rollback()
            print(f"  [-] Failed device {dev.get('serial_number')}: {e}")
            continue
        conn.commit()

    cur.close()
    conn.close()
    print(f"\nSUCCESS: Migrated {count}/{len(devices)} devices to Neon PostgreSQL!")


if __name__ == '__main__':
    main()
