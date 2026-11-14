#!/usr/bin/env python3
"""
resync_excel_to_neon.py

Reads all device records from the aging test Excel workbook (local or exported from Render)
and synchronizes them into Neon PostgreSQL.

Usage:
    python scripts/resync_excel_to_neon.py [--excel path/to/aging_test.xlsx] [--db "postgresql://..."]
"""
import argparse
import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Try importing openpyxl
try:
    from openpyxl import load_workbook
except ImportError:
    print("ERROR: openpyxl is required. Run 'pip install openpyxl'")
    sys.exit(1)

# Try importing psycopg2
try:
    import psycopg2
    from psycopg2.extras import Json
except ImportError:
    psycopg2 = None

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / 'backend' / '.env')


def extract_observations(sheet, row: int):
    obs = {}
    for n in range(1, 5):
        issue_raw = sheet.cell(row, 15 + 3 * (n - 1)).value
        cat_raw = sheet.cell(row, 16 + 3 * (n - 1)).value
        rem_raw = sheet.cell(row, 17 + 3 * (n - 1)).value
        if issue_raw is not None and str(issue_raw).strip():
            issue_val = 'yes' if str(issue_raw).strip().lower() == 'yes' else 'no'
            cats = [c.strip() for c in str(cat_raw).split(',') if c.strip()] if cat_raw else []
            obs[f'h{n}'] = {
                'has_issue': issue_val,
                'categories': cats,
                'remarks': str(rem_raw) if rem_raw is not None else ''
            }
        else:
            obs[f'h{n}'] = None

    post_issue = sheet.cell(row, 27).value
    post_cat = sheet.cell(row, 28).value
    post_rem = sheet.cell(row, 29).value
    if post_issue is not None and str(post_issue).strip():
        issue_val = 'yes' if str(post_issue).strip().lower() == 'yes' else 'no'
        cats = [c.strip() for c in str(post_cat).split(',') if c.strip()] if post_cat else []
        obs['post'] = {
            'has_issue': issue_val,
            'categories': cats,
            'remarks': str(post_rem) if post_rem is not None else ''
        }
    else:
        obs['post'] = None

    power_test = sheet.cell(row, 30).value
    power_test_val = str(power_test).strip() if power_test is not None and str(power_test).strip() else None
    return obs, power_test_val


def main():
    parser = argparse.ArgumentParser(description="Resync aging test Excel data into Neon PostgreSQL")
    parser.add_argument('--excel', default=os.getenv('EXCEL_FILE_PATH', str(ROOT / 'data' / 'aging_test.xlsx')), help='Path to Excel workbook')
    parser.add_argument('--db', default=os.getenv('DATABASE_URL', os.getenv('NEON_DATABASE_URL', '')), help='Neon PostgreSQL connection string')
    args = parser.parse_args()

    excel_path = Path(args.excel)
    if not excel_path.exists():
        print(f"ERROR: Excel workbook not found at {excel_path}")
        print("If your data is currently on Render, export it using the /api/admin/export-excel endpoint first.")
        sys.exit(1)

    db_url = args.db
    if not db_url:
        print("ERROR: DATABASE_URL not provided.")
        print("Provide via --db or set DATABASE_URL in backend/.env")
        sys.exit(1)

    if not psycopg2:
        print("ERROR: psycopg2 is required. Run 'pip install psycopg2-binary'")
        sys.exit(1)

    print(f"Loading workbook: {excel_path}...")
    book = load_workbook(excel_path, read_only=True)
    if 'Devices' not in book.sheetnames:
        print("ERROR: Sheet 'Devices' not found in workbook.")
        sys.exit(1)

    sheet = book['Devices']
    devices = []
    for r in range(2, sheet.max_row + 1):
        serial_val = sheet.cell(r, 1).value
        if not serial_val or not str(serial_val).strip():
            continue
        serial = str(serial_val).strip()
        obs, power_test = extract_observations(sheet, r)

        dev = {
            'serial_number': serial,
            'registration_time': sheet.cell(r, 2).value,
            'registration_battery': sheet.cell(r, 3).value or 0,
            'h1_battery': sheet.cell(r, 4).value,
            'h1_timestamp': sheet.cell(r, 5).value,
            'h2_battery': sheet.cell(r, 6).value,
            'h2_timestamp': sheet.cell(r, 7).value,
            'h3_battery': sheet.cell(r, 8).value,
            'h3_timestamp': sheet.cell(r, 9).value,
            'h4_battery': sheet.cell(r, 10).value,
            'h4_timestamp': sheet.cell(r, 11).value,
            'post_aging_battery': sheet.cell(r, 12).value,
            'post_aging_timestamp': sheet.cell(r, 13).value,
            'status': sheet.cell(r, 14).value or 'WAITING_FOR_100_PERCENT_CHARGE',
            'observations': obs,
            'power_test_result': power_test,
        }
        devices.append(dev)

    print(f"Found {len(devices)} device records in Excel.")
    if not devices:
        print("No devices to sync.")
        return

    # Connect to Neon
    if 'sslmode' not in db_url and 'neon.tech' in db_url:
        sep = '&' if '?' in db_url else '?'
        db_url = f"{db_url}{sep}sslmode=require"

    print("Connecting to Neon PostgreSQL...")
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    upsert_sql = """
    INSERT INTO public.devices (
        serial_number, status, registration_time, registration_battery,
        h1_battery, h1_timestamp, h2_battery, h2_timestamp,
        h3_battery, h3_timestamp, h4_battery, h4_timestamp,
        post_aging_battery, post_aging_timestamp,
        observations, power_test_result, last_battery, last_server_received
    ) VALUES (
        %(serial_number)s, %(status)s, %(registration_time)s, %(registration_battery)s,
        %(h1_battery)s, %(h1_timestamp)s, %(h2_battery)s, %(h2_timestamp)s,
        %(h3_battery)s, %(h3_timestamp)s, %(h4_battery)s, %(h4_timestamp)s,
        %(post_aging_battery)s, %(post_aging_timestamp)s,
        %(observations)s, %(power_test_result)s, %(last_battery)s, NOW()
    )
    ON CONFLICT (serial_number) DO UPDATE SET
        status = EXCLUDED.status,
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
        updated_at = NOW();
    """

    synced = 0
    for dev in devices:
        last_batt = dev['post_aging_battery'] or dev['h4_battery'] or dev['h3_battery'] or dev['h2_battery'] or dev['h1_battery'] or dev['registration_battery']
        try:
            cur.execute(upsert_sql, {
                **dev,
                'last_battery': last_batt,
                'observations': Json(dev['observations']),
            })
            synced += 1
            print(f"  [+] Synced device: {dev['serial_number']} ({dev['status']})")
        except Exception as e:
            conn.rollback()
            print(f"  [-] Failed device {dev['serial_number']}: {e}")
            continue
        conn.commit()

    cur.close()
    conn.close()
    print(f"\nSUCCESS: Synced {synced}/{len(devices)} devices to Neon PostgreSQL!")


if __name__ == '__main__':
    main()
