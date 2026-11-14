-- ==============================================================================
-- Tohands Aging Test - Neon PostgreSQL Database Schema
-- Run this script in the Neon Console -> SQL Editor (https://console.neon.tech)
-- ==============================================================================

-- 1. Create devices table
CREATE TABLE IF NOT EXISTS public.devices (
    serial_number TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'WAITING_FOR_100_PERCENT_CHARGE',
    pending_restart INTEGER,
    next_checkpoint INTEGER NOT NULL DEFAULT 1,
    aging_started TIMESTAMPTZ,
    next_due TIMESTAMPTZ,
    last_server_received TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_device_time TEXT,
    last_battery INTEGER NOT NULL DEFAULT 0,
    registration_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registration_battery INTEGER NOT NULL DEFAULT 0,
    h1_battery INTEGER,
    h1_timestamp TEXT,
    h1_server_time TIMESTAMPTZ,
    h2_battery INTEGER,
    h2_timestamp TEXT,
    h2_server_time TIMESTAMPTZ,
    h3_battery INTEGER,
    h3_timestamp TEXT,
    h3_server_time TIMESTAMPTZ,
    h4_battery INTEGER,
    h4_timestamp TEXT,
    h4_server_time TIMESTAMPTZ,
    post_aging_battery INTEGER,
    post_aging_timestamp TEXT,
    post_aging_server_time TIMESTAMPTZ,
    observations JSONB DEFAULT '{"h1":null,"h2":null,"h3":null,"h4":null,"post":null}'::jsonb,
    power_test_result TEXT,
    events JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Performance indexes
CREATE INDEX IF NOT EXISTS idx_devices_status ON public.devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_updated_at ON public.devices(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_registration_time ON public.devices(registration_time DESC);

-- 3. Trigger to automatically keep updated_at in sync
CREATE OR REPLACE FUNCTION public.handle_device_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_devices_updated_at ON public.devices;
CREATE TRIGGER set_devices_updated_at
    BEFORE UPDATE ON public.devices
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_device_updated_at();

-- 4. Audit table for offline/online sync history
CREATE TABLE IF NOT EXISTS public.sync_log (
    id BIGSERIAL PRIMARY KEY,
    serial_number TEXT NOT NULL,
    action TEXT NOT NULL,
    battery_percent INTEGER,
    source TEXT DEFAULT 'offline_sync',
    synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_log_serial ON public.sync_log(serial_number);
