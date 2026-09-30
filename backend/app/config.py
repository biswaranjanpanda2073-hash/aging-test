import os
import re
from pathlib import Path
from dotenv import load_dotenv, dotenv_values

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / 'backend' / '.env')
FILE = Path(os.getenv('EXCEL_FILE_PATH', str(ROOT / 'data' / 'aging_test.xlsx'))).resolve()
SERIAL_REGEX = os.getenv('SERIAL_NUMBER_REGEX', r'^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$')
re.compile(SERIAL_REGEX)
CAPTURE_TTL = int(os.getenv('CAPTURE_TTL_SECONDS', '180'))
CHECKPOINT_SECONDS = int(os.getenv('CHECKPOINT_INTERVAL_SECONDS', '3600'))

# The setup script owns this local configuration; no client-controlled paths.
LAN_IP = dotenv_values(ROOT / 'frontend' / '.env').get('LAN_IP', '')
ALLOWED_HOSTS = ['localhost', '127.0.0.1'] + ([LAN_IP] if LAN_IP else [])
ALLOWED_ORIGINS = ['https://localhost:5173', 'https://127.0.0.1:5173'] + ([f'https://{LAN_IP}:5173'] if LAN_IP else [])
if not 30 <= CAPTURE_TTL <= 600 or not 0 <= CHECKPOINT_SECONDS <= 86400:
    raise ValueError('Capture TTL must be 30–600 seconds and checkpoint interval 0–86400 seconds.')
