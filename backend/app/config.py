import os
import re
from pathlib import Path
from dotenv import load_dotenv, dotenv_values  # type: ignore

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / 'backend' / '.env')
FILE = Path(os.getenv('EXCEL_FILE_PATH', str(ROOT / 'data' / 'aging_test.xlsx'))).resolve()
SERIAL_REGEX = os.getenv('SERIAL_NUMBER_REGEX', r'^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$')
re.compile(SERIAL_REGEX)
CAPTURE_TTL = int(os.getenv('CAPTURE_TTL_SECONDS', '180'))
CHECKPOINT_SECONDS = int(os.getenv('CHECKPOINT_INTERVAL_SECONDS', '3600'))

# Host and origin configuration
ENV_HOSTS = os.getenv('ALLOWED_HOSTS', '')
if ENV_HOSTS:
    ALLOWED_HOSTS = [h.strip() for h in ENV_HOSTS.split(',') if h.strip()]
elif os.getenv('RENDER') or os.getenv('ENVIRONMENT') == 'production':
    ALLOWED_HOSTS = ['*']
else:
    LAN_IP = dotenv_values(ROOT / 'frontend' / '.env').get('LAN_IP', '')
    EXTRA_IPS = [ip for ip in [LAN_IP, '192.168.137.1'] if ip]
    ALLOWED_HOSTS = list(dict.fromkeys(['localhost', '127.0.0.1'] + EXTRA_IPS))

ENV_ORIGINS = os.getenv('ALLOWED_ORIGINS', '')
if ENV_ORIGINS:
    ALLOWED_ORIGINS = [o.strip() for o in ENV_ORIGINS.split(',') if o.strip()]
elif os.getenv('RENDER') or os.getenv('ENVIRONMENT') == 'production':
    ALLOWED_ORIGINS = ['*']
else:
    LAN_IP = dotenv_values(ROOT / 'frontend' / '.env').get('LAN_IP', '')
    EXTRA_IPS = [ip for ip in [LAN_IP, '192.168.137.1'] if ip]
    ALLOWED_ORIGINS = list(dict.fromkeys(['https://localhost:5173', 'https://127.0.0.1:5173'] + [f'https://{ip}:5173' for ip in EXTRA_IPS]))

if not 30 <= CAPTURE_TTL <= 600 or not 0 <= CHECKPOINT_SECONDS <= 86400:
    raise ValueError('Capture TTL must be 30–600 seconds and checkpoint interval 0–86400 seconds.')
