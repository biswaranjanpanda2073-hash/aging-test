-- ==============================================================================
-- Tohands Aging Test - Supabase Database Schema
-- Run this script in the Supabase Dashboard -> SQL Editor
-- ==============================================================================

-- 1. Create devices table
create table if not exists public.devices (
    serial_number text primary key,
    status text not null default 'WAITING_FOR_100_PERCENT_CHARGE',
    pending_restart integer,
    next_checkpoint integer not null default 1,
    aging_started timestamptz,
    next_due timestamptz,
    last_server_received timestamptz not null default now(),
    last_device_time text,
    last_battery integer not null default 0,
    registration_time timestamptz not null default now(),
    registration_battery integer not null default 0,
    h1_battery integer,
    h1_timestamp text,
    h1_server_time timestamptz,
    h2_battery integer,
    h2_timestamp text,
    h2_server_time timestamptz,
    h3_battery integer,
    h3_timestamp text,
    h3_server_time timestamptz,
    h4_battery integer,
    h4_timestamp text,
    h4_server_time timestamptz,
    post_aging_battery integer,
    post_aging_timestamp text,
    post_aging_server_time timestamptz,
    observations jsonb default '{"h1":null,"h2":null,"h3":null,"h4":null,"post":null}'::jsonb,
    power_test_result text,
    events jsonb default '[]'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- 2. Performance indexes
create index if not exists idx_devices_status on public.devices(status);
create index if not exists idx_devices_updated_at on public.devices(updated_at desc);

-- 3. Trigger to automatically keep updated_at in sync
create or replace function public.handle_device_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists set_devices_updated_at on public.devices;
create trigger set_devices_updated_at
    before update on public.devices
    for each row
    execute function public.handle_device_updated_at();

-- 4. Enable Row Level Security (RLS)
alter table public.devices enable row level security;

-- 5. Policies for anonymous access from the web application
drop policy if exists "Allow anon read devices" on public.devices;
create policy "Allow anon read devices"
    on public.devices
    for select
    to anon
    using (true);

drop policy if exists "Allow anon insert devices" on public.devices;
create policy "Allow anon insert devices"
    on public.devices
    for insert
    to anon
    with check (true);

drop policy if exists "Allow anon update devices" on public.devices;
create policy "Allow anon update devices"
    on public.devices
    for update
    to anon
    using (true)
    with check (true);

drop policy if exists "Allow anon delete devices" on public.devices;
create policy "Allow anon delete devices"
    on public.devices
    for delete
    to anon
    using (true);
