import json
import logging
import urllib.request
import urllib.error
import urllib.parse
from . import config

logger = logging.getLogger(__name__)

TIMEOUT = 8  # seconds

# Optional psycopg2 import for Postgres / Neon
_pg_pool = None
try:
    import psycopg2
    from psycopg2 import pool
    from psycopg2.extras import Json
except ImportError:
    psycopg2 = None
    pool = None


def get_pg_connection():
    """Returns a connection from the Postgres pool or a new connection."""
    global _pg_pool
    if not config.DATABASE_URL or not psycopg2:
        return None
    try:
        if _pg_pool is None:
            # Handle sslmode in Neon database URL
            db_url = config.DATABASE_URL
            if 'sslmode' not in db_url and 'neon.tech' in db_url:
                separator = '&' if '?' in db_url else '?'
                db_url = f"{db_url}{separator}sslmode=require"
            _pg_pool = pool.SimpleConnectionPool(1, 10, db_url)
        return _pg_pool.getconn()
    except Exception as e:
        logger.warning('Failed to connect to PostgreSQL / Neon: %s', e)
        return None


def release_pg_connection(conn):
    global _pg_pool
    if _pg_pool and conn:
        try:
            _pg_pool.putconn(conn)
        except Exception:
            pass


def _execute_neon_sql_http(query: str, params: list | None = None) -> dict | None:
    """Executes SQL on Neon via Neon Serverless HTTP API when psycopg2 is not installed."""
    db_url = config.DATABASE_URL
    if not db_url or 'neon.tech' not in db_url:
        return None

    try:
        # Parse host and credentials from database URL
        parsed = urllib.parse.urlparse(db_url)
        host = parsed.hostname
        user = parsed.username
        password = parsed.password
        database = parsed.path.lstrip('/')

        http_url = f"https://{host}/sql"
        payload = {
            'query': query,
            'params': params or []
        }
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(http_url, data=data, method='POST')
        
        # Basic auth or Bearer token
        if user and password:
            import base64
            auth_str = base64.b64encode(f"{user}:{password}".encode()).decode()
            req.add_header('Authorization', f'Basic {auth_str}')
        elif config.NEON_API_KEY:
            req.add_header('Authorization', f'Bearer {config.NEON_API_KEY}')
            
        req.add_header('Content-Type', 'application/json')
        if database:
            req.add_header('Neon-Database-Name', database)

        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode('utf-8'))
    except Exception as ex:
        logger.warning('Neon HTTP SQL execution error: %s', ex)
    return None


def _format_device_payload(state: dict, values: list | None = None) -> dict:
    serial = state.get('serial_number')
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

    return {
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


def _sync_to_postgres(payload: dict) -> bool:
    """Upsert into PostgreSQL / Neon database using psycopg2."""
    conn = get_pg_connection()
    if not conn:
        return False

    sql = """
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
    try:
        with conn.cursor() as cur:
            cur.execute(sql, {
                **payload,
                'observations': Json(payload['observations']) if psycopg2 else json.dumps(payload['observations']),
                'events': Json(payload['events']) if psycopg2 else json.dumps(payload['events']),
            })
            conn.commit()
            logger.info('Synced device %s to PostgreSQL / Neon successfully.', payload['serial_number'])
            return True
    except Exception as ex:
        conn.rollback()
        logger.warning('Failed to sync device %s to PostgreSQL / Neon: %s', payload['serial_number'], ex)
    finally:
        release_pg_connection(conn)
    return False


def _sync_to_supabase(payload: dict) -> bool:
    """Fallback: Upsert into Supabase devices table via REST API."""
    if not config.SUPABASE_URL or not config.SUPABASE_KEY:
        return False

    serial = payload['serial_number']
    url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?on_conflict=serial_number"
    data = json.dumps(payload).encode('utf-8')
    headers = {
        'apikey': config.SUPABASE_KEY,
        'Authorization': f'Bearer {config.SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
    }

    try:
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            if resp.status in (200, 201):
                logger.info('Synced device %s to Supabase successfully.', serial)
                return True
    except Exception as ex:
        logger.warning('Failed to sync device %s to Supabase: %s', serial, ex)
    return False


def sync_device_to_db(state: dict, values: list | None = None) -> bool:
    """Synchronizes a device record to Neon Postgres or Supabase."""
    if not config.is_db_enabled():
        return False

    serial = state.get('serial_number')
    if not serial:
        return False

    payload = _format_device_payload(state, values)

    # 1. Try PostgreSQL / Neon if DATABASE_URL configured
    if config.DATABASE_URL:
        if psycopg2 and _sync_to_postgres(payload):
            return True
        # Try Neon HTTP fallback
        elif 'neon.tech' in config.DATABASE_URL:
            # Format simple insert/update for Neon HTTP
            logger.info('Attempting Neon HTTP sync for device %s', serial)
            obs_json = json.dumps(payload['observations'])
            events_json = json.dumps(payload['events'])
            query = """
            INSERT INTO public.devices (
                serial_number, status, pending_restart, next_checkpoint,
                last_server_received, last_battery, registration_time, registration_battery,
                h1_battery, h1_timestamp, h2_battery, h2_timestamp,
                h3_battery, h3_timestamp, h4_battery, h4_timestamp,
                post_aging_battery, post_aging_timestamp, observations, power_test_result, events
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21::jsonb
            )
            ON CONFLICT (serial_number) DO UPDATE SET
                status = EXCLUDED.status,
                pending_restart = EXCLUDED.pending_restart,
                next_checkpoint = EXCLUDED.next_checkpoint,
                last_server_received = EXCLUDED.last_server_received,
                last_battery = EXCLUDED.last_battery,
                observations = EXCLUDED.observations,
                updated_at = NOW();
            """
            params = [
                payload['serial_number'], payload['status'], payload['pending_restart'], payload['next_checkpoint'],
                payload['last_server_received'], payload['last_battery'], payload['registration_time'], payload['registration_battery'],
                payload['h1_battery'], payload['h1_timestamp'], payload['h2_battery'], payload['h2_timestamp'],
                payload['h3_battery'], payload['h3_timestamp'], payload['h4_battery'], payload['h4_timestamp'],
                payload['post_aging_battery'], payload['post_aging_timestamp'], obs_json, payload['power_test_result'], events_json
            ]
            res = _execute_neon_sql_http(query, params)
            if res is not None:
                return True

    # 2. Fallback to Supabase
    return _sync_to_supabase(payload)


def fetch_device_from_db(serial: str) -> dict | None:
    """Fetches a device record from Neon Postgres or Supabase."""
    if not config.is_db_enabled():
        return None

    # 1. Try PostgreSQL / Neon
    if config.DATABASE_URL and psycopg2:
        conn = get_pg_connection()
        if conn:
            try:
                from psycopg2.extras import RealDictCursor
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("SELECT * FROM public.devices WHERE serial_number = %s LIMIT 1", (serial,))
                    row = cur.fetchone()
                    if row:
                        return dict(row)
            except Exception as ex:
                logger.warning('Failed to fetch device %s from PostgreSQL: %s', serial, ex)
            finally:
                release_pg_connection(conn)

    # 2. Try Supabase
    if config.SUPABASE_URL and config.SUPABASE_KEY:
        url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?serial_number=eq.{urllib.parse.quote(serial)}&limit=1"
        headers = {
            'apikey': config.SUPABASE_KEY,
            'Authorization': f'Bearer {config.SUPABASE_KEY}',
        }
        try:
            req = urllib.request.Request(url, headers=headers, method='GET')
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if resp.status == 200:
                    rows = json.loads(resp.read().decode('utf-8'))
                    if rows and len(rows) > 0:
                        return rows[0]
        except Exception as ex:
            logger.warning('Failed to fetch device %s from Supabase: %s', serial, ex)

    return None


def delete_device_from_db(serial: str) -> bool:
    """Deletes a device from Neon Postgres or Supabase."""
    if not config.is_db_enabled():
        return False

    success = False

    # 1. PostgreSQL / Neon
    if config.DATABASE_URL and psycopg2:
        conn = get_pg_connection()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM public.devices WHERE serial_number = %s", (serial,))
                    conn.commit()
                    success = True
            except Exception as ex:
                conn.rollback()
                logger.warning('Failed to delete device %s from PostgreSQL: %s', serial, ex)
            finally:
                release_pg_connection(conn)

    # 2. Supabase
    if config.SUPABASE_URL and config.SUPABASE_KEY:
        url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/devices?serial_number=eq.{urllib.parse.quote(serial)}"
        headers = {
            'apikey': config.SUPABASE_KEY,
            'Authorization': f'Bearer {config.SUPABASE_KEY}',
        }
        try:
            req = urllib.request.Request(url, headers=headers, method='DELETE')
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if resp.status in (200, 204):
                    success = True
        except Exception as ex:
            logger.warning('Failed to delete device %s from Supabase: %s', serial, ex)

    return success


# Backward compatibility aliases
sync_device_to_supabase = sync_device_to_db
fetch_device_from_supabase = fetch_device_from_db
delete_device_from_supabase = delete_device_from_db
