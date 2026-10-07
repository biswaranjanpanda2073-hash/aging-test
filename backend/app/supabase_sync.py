import json
import logging
import urllib.request
import urllib.error
import urllib.parse
from . import config

logger = logging.getLogger(__name__)

SUPABASE_TIMEOUT = 5  # seconds


def get_headers():
    key = config.SUPABASE_KEY
    return {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
    }


def sync_device_to_supabase(state: dict, values: list | None = None) -> bool:
    """Synchronizes a device record and observation fields to the Supabase devices table."""
    if not config.is_supabase_enabled() or not config.SUPABASE_URL or not config.SUPABASE_KEY:
        return False

    serial = state.get('serial_number')
    if not serial:
        return False

    # Extract Excel column values if provided
    # Columns in values:
    # 0: Serial Number, 1: Reg Time, 2: Reg Batt, 3: H1 Batt, 4: H1 Time,
    # 5: H2 Batt, 6: H2 Time, 7: H3 Batt, 8: H3 Time, 9: H4 Batt, 10: H4 Time,
    # 11: Post Batt, 12: Post Time, 13: Final Status, ...
    reg_time = values[1] if values and len(values) > 1 and values[1] else state.get('last_server_received')
    reg_battery = values[2] if values and len(values) > 2 and values[2] is not None else state.get('last_battery', 0)
    h1_battery = values[3] if values and len(values) > 3 else None
    h1_timestamp = values[4] if values and len(values) > 4 else None
    h2_battery = values[5] if values and len(values) > 5 else None
    h2_timestamp = values[6] if values and len(values) > 6 else None
    h3_battery = values[7] if values and len(values) > 7 else None
    h3_timestamp = values[8] if values and len(values) > 8 else None
    h4_battery = values[9] if values and len(values) > 9 else None
    h4_timestamp = values[10] if values and len(values) > 10 else None
    post_battery = values[11] if values and len(values) > 11 else None
    post_timestamp = values[12] if values and len(values) > 12 else None

    payload = {
        'serial_number': serial,
        'status': state.get('status', 'WAITING_FOR_100_PERCENT_CHARGE'),
        'pending_restart': state.get('pending_restart'),
        'next_checkpoint': state.get('next_checkpoint', 1),
        'aging_started': state.get('aging_started'),
        'next_due': state.get('next_due'),
        'last_server_received': state.get('last_server_received'),
        'last_device_time': state.get('last_device_time'),
        'last_battery': state.get('last_battery', 0),
        'registration_time': reg_time,
        'registration_battery': reg_battery,
        'h1_battery': h1_battery,
        'h1_timestamp': h1_timestamp,
        'h2_battery': h2_battery,
        'h2_timestamp': h2_timestamp,
        'h3_battery': h3_battery,
        'h3_timestamp': h3_timestamp,
        'h4_battery': h4_battery,
        'h4_timestamp': h4_timestamp,
        'post_aging_battery': post_battery,
        'post_aging_timestamp': post_timestamp,
        'observations': state.get('observations') or {'h1': None, 'h2': None, 'h3': None, 'h4': None, 'post': None},
        'power_test_result': state.get('power_test_result'),
        'events': state.get('events', []),
    }

    url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?on_conflict=serial_number"
    data = json.dumps(payload).encode('utf-8')

    try:
        req = urllib.request.Request(url, data=data, headers=get_headers(), method='POST')
        with urllib.request.urlopen(req, timeout=SUPABASE_TIMEOUT) as resp:
            if resp.status in (200, 201):
                logger.info('Synced device %s to Supabase successfully.', serial)
                return True
    except Exception as ex:
        logger.warning('Failed to sync device %s to Supabase: %s', serial, ex)
    return False


def fetch_device_from_supabase(serial: str) -> dict | None:
    """Fetches a device record from Supabase if not found in local Excel storage."""
    if not config.is_supabase_enabled() or not config.SUPABASE_URL or not config.SUPABASE_KEY:
        return None

    url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?serial_number=eq.{urllib.parse.quote(serial)}&limit=1"
    headers = {
        'apikey': config.SUPABASE_KEY,
        'Authorization': f'Bearer {config.SUPABASE_KEY}',
    }

    try:
        req = urllib.request.Request(url, headers=headers, method='GET')
        with urllib.request.urlopen(req, timeout=SUPABASE_TIMEOUT) as resp:
            if resp.status == 200:
                rows = json.loads(resp.read().decode('utf-8'))
                if rows and len(rows) > 0:
                    return rows[0]
    except Exception as ex:
        logger.warning('Failed to fetch device %s from Supabase: %s', serial, ex)
    return None


def delete_device_from_supabase(serial: str) -> bool:
    """Deletes a device from Supabase when deleted from the aging workflow."""
    if not config.is_supabase_enabled() or not config.SUPABASE_URL or not config.SUPABASE_KEY:
        return False

    url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?serial_number=eq.{urllib.parse.quote(serial)}"
    headers = {
        'apikey': config.SUPABASE_KEY,
        'Authorization': f'Bearer {config.SUPABASE_KEY}',
    }

    try:
        req = urllib.request.Request(url, headers=headers, method='DELETE')
        with urllib.request.urlopen(req, timeout=SUPABASE_TIMEOUT) as resp:
            return resp.status in (200, 204)
    except Exception as ex:
        logger.warning('Failed to delete device %s from Supabase: %s', serial, ex)
    return False
