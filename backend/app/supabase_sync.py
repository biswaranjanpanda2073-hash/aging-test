"""
supabase_sync.py  -  Compatibility facade for db_sync.py.
Supports Neon PostgreSQL database synchronization with Supabase fallback.
"""
from .db_sync import (
    sync_device_to_db,
    fetch_device_from_db,
    delete_device_from_db,
    sync_device_to_supabase,
    fetch_device_from_supabase,
    delete_device_from_supabase,
)

__all__ = [
    'sync_device_to_db',
    'fetch_device_from_db',
    'delete_device_from_db',
    'sync_device_to_supabase',
    'fetch_device_from_supabase',
    'delete_device_from_supabase',
]
