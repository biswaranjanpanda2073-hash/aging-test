import type { Action, Device, Reading, CheckpointObservation, PowerTestResult } from './types';
import { supabase } from './supabase';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface DeviceRow {
  serial_number: string;
  status: string;
  pending_restart: number | null;
  next_checkpoint: number;
  aging_started: string | null;
  next_due: string | null;
  last_server_received: string;
  last_device_time: string | null;
  last_battery: number;
  registration_time: string;
  registration_battery: number;
  h1_battery: number | null;
  h1_timestamp: string | null;
  h1_server_time: string | null;
  h2_battery: number | null;
  h2_timestamp: string | null;
  h2_server_time: string | null;
  h3_battery: number | null;
  h3_timestamp: string | null;
  h3_server_time: string | null;
  h4_battery: number | null;
  h4_timestamp: string | null;
  h4_server_time: string | null;
  post_aging_battery: number | null;
  post_aging_timestamp: string | null;
  post_aging_server_time: string | null;
  observations: Record<string, CheckpointObservation | null> | null;
  power_test_result: PowerTestResult | null;
  events: Record<string, unknown>[] | null;
  created_at: string;
  updated_at: string;
}

function mapRowToDevice(row: DeviceRow): Device {
  const obs = row.observations || { h1: null, h2: null, h3: null, h4: null, post: null };
  const h1Obs = obs.h1;
  const h2Obs = obs.h2;
  const h3Obs = obs.h3;
  const h4Obs = obs.h4;
  const postObs = obs.post;

  const values: (string | number | null)[] = [
    row.serial_number, // 0: Serial Number
    row.registration_time ? new Date(row.registration_time).toISOString().replace('T', ' ').substring(0, 19) : null, // 1: Registration Time
    row.registration_battery, // 2: Registration Battery %
    row.h1_battery ?? null, // 3: H1 Battery %
    row.h1_timestamp ?? null, // 4: H1 Timestamp
    row.h2_battery ?? null, // 5: H2 Battery %
    row.h2_timestamp ?? null, // 6: H2 Timestamp
    row.h3_battery ?? null, // 7: H3 Battery %
    row.h3_timestamp ?? null, // 8: H3 Timestamp
    row.h4_battery ?? null, // 9: H4 Battery %
    row.h4_timestamp ?? null, // 10: H4 Timestamp
    row.post_aging_battery ?? null, // 11: Post-Aging Battery %
    row.post_aging_timestamp ?? null, // 12: Post-Aging Timestamp
    row.status ?? null, // 13: Final Status
    h1Obs ? (h1Obs.has_issue === 'yes' ? 'Yes' : 'No') : null, // 14: H1 Issue
    h1Obs?.categories?.length ? h1Obs.categories.join(', ') : null, // 15: H1 Issue Categories
    h1Obs?.remarks || null, // 16: H1 Remarks
    h2Obs ? (h2Obs.has_issue === 'yes' ? 'Yes' : 'No') : null, // 17: H2 Issue
    h2Obs?.categories?.length ? h2Obs.categories.join(', ') : null, // 18: H2 Issue Categories
    h2Obs?.remarks || null, // 19: H2 Remarks
    h3Obs ? (h3Obs.has_issue === 'yes' ? 'Yes' : 'No') : null, // 20: H3 Issue
    h3Obs?.categories?.length ? h3Obs.categories.join(', ') : null, // 21: H3 Issue Categories
    h3Obs?.remarks || null, // 22: H3 Remarks
    h4Obs ? (h4Obs.has_issue === 'yes' ? 'Yes' : 'No') : null, // 23: H4 Issue
    h4Obs?.categories?.length ? h4Obs.categories.join(', ') : null, // 24: H4 Issue Categories
    h4Obs?.remarks || null, // 25: H4 Remarks
    postObs ? (postObs.has_issue === 'yes' ? 'Yes' : 'No') : null, // 26: Post-Aging Issue
    postObs?.categories?.length ? postObs.categories.join(', ') : null, // 27: Post-Aging Issue Categories
    postObs?.remarks || null, // 28: Post-Aging Remarks
    row.power_test_result ?? null, // 29: Power Test Result
  ];

  return {
    serial_number: row.serial_number,
    status: row.status,
    pending_restart: row.pending_restart,
    next_checkpoint: row.next_checkpoint,
    aging_started: row.aging_started,
    next_due: row.next_due,
    last_server_received: row.last_server_received,
    last_device_time: row.last_device_time,
    last_battery: row.last_battery,
    values,
    observations: obs,
    power_test_result: row.power_test_result,
  };
}

export async function api<T>(path: string, body?: unknown, _signal?: AbortSignal, method?: string): Promise<T> {
  const cleanPath = path.startsWith('/api') ? path.substring(4) : path;
  const verb = (method || (body === undefined ? 'GET' : 'POST')).toUpperCase();

  // 1. Health check
  if (cleanPath === '/health') {
    const { error } = await supabase.from('devices').select('serial_number').limit(1);
    if (error) {
      throw new ApiError(`Supabase connection failed: ${error.message}`, 500);
    }
    return { status: 'ok' } as T;
  }

  // 2. Config settings
  if (cleanPath === '/config') {
    return {
      serial_regex: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
      checkpoint_interval_seconds: 3600,
    } as T;
  }

  // 3. Capture token generation
  if (cleanPath === '/captures') {
    const token = 'cap_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    return { capture_token: token, expires_in: 300 } as T;
  }

  // 4. Device restart confirmation: /devices/:serial/restart
  const restartMatch = cleanPath.match(/^\/devices\/([^/]+)\/restart$/);
  if (restartMatch) {
    const serial = decodeURIComponent(restartMatch[1]);
    const { data: device, error: fetchErr } = await supabase
      .from('devices')
      .select('*')
      .eq('serial_number', serial)
      .maybeSingle<DeviceRow>();

    if (fetchErr) throw new ApiError(fetchErr.message, 500);
    if (!device) throw new ApiError('Device not registered.', 404);

    const restartReq = body as { checkpoint: number; confirmed: boolean };
    const n = restartReq?.checkpoint;
    if (device.pending_restart !== n) {
      throw new ApiError('No matching restart is awaiting confirmation.', 409);
    }

    const stamp = new Date().toISOString();
    const nextCheckpoint = n + 1;
    const newStatus = n === 4 ? 'AGING_TEST_COMPLETE' : `AGING_HOUR_${nextCheckpoint}`;
    const nextDue = n === 4 ? null : new Date(Date.now() + 3600 * 1000).toISOString();
    const events = Array.isArray(device.events) ? [...device.events] : [];
    events.push({ action: 'operator_restart_confirmation', checkpoint: n, server_received: stamp });

    const { data: updated, error: updateErr } = await supabase
      .from('devices')
      .update({
        pending_restart: null,
        next_checkpoint: nextCheckpoint,
        status: newStatus,
        next_due: nextDue,
        events,
        last_server_received: stamp,
      })
      .eq('serial_number', serial)
      .select('*')
      .single<DeviceRow>();

    if (updateErr) throw new ApiError(updateErr.message, 500);
    return mapRowToDevice(updated) as T;
  }

  // 5. Delete device: DELETE /devices/:serial or POST /devices/:serial/delete
  const deleteMatch = cleanPath.match(/^\/devices\/([^/]+)(?:\/delete)?$/);
  if (deleteMatch && (verb === 'DELETE' || cleanPath.endsWith('/delete'))) {
    const serial = decodeURIComponent(deleteMatch[1]);
    const { error: delErr } = await supabase
      .from('devices')
      .delete()
      .eq('serial_number', serial);

    if (delErr) throw new ApiError(delErr.message, 500);
    return { status: 'deleted', serial_number: serial } as T;
  }

  // 6. Get device: GET /devices/:serial or /devices/:serial/status
  const deviceMatch = cleanPath.match(/^\/devices\/([^/]+)(?:\/status)?$/);
  if (deviceMatch && verb === 'GET') {
    const serial = decodeURIComponent(deviceMatch[1]);
    const { data, error } = await supabase
      .from('devices')
      .select('*')
      .eq('serial_number', serial)
      .maybeSingle<DeviceRow>();

    if (error) throw new ApiError(error.message, 500);
    if (!data) throw new ApiError('Device not registered.', 404);
    return mapRowToDevice(data) as T;
  }

  throw new ApiError(`Unhandled route: ${cleanPath}`, 404);
}

export async function submit(action: Action, reading: Reading, target?: string): Promise<Device> {
  const serial = reading.serial_number;
  if (target && target !== serial) {
    throw new ApiError('Serial mismatch. Capture the selected device.', 409);
  }

  const stamp = new Date().toISOString();

  // ── Action: Register ─────────────────────────────────────────────────────────
  if (action === 'register') {
    const { data: existing, error: checkErr } = await supabase
      .from('devices')
      .select('serial_number, status')
      .eq('serial_number', serial)
      .maybeSingle();

    if (checkErr) throw new ApiError(checkErr.message, 500);
    if (existing) {
      throw new ApiError(`Device already registered. Current status: ${existing.status}`, 409);
    }

    const initStatus = reading.battery_percent === 100 ? 'READY_FOR_AGING' : 'WAITING_FOR_100_PERCENT_CHARGE';
    const initEvent = {
      action: 'register',
      battery: reading.battery_percent,
      device_time: reading.device_timestamp,
      server_received: stamp,
    };

    const { data: created, error: insertErr } = await supabase
      .from('devices')
      .insert({
        serial_number: serial,
        status: initStatus,
        registration_battery: reading.battery_percent,
        registration_time: stamp,
        last_battery: reading.battery_percent,
        last_device_time: reading.device_timestamp,
        last_server_received: stamp,
        next_checkpoint: 1,
        pending_restart: null,
        aging_started: null,
        next_due: null,
        observations: { h1: null, h2: null, h3: null, h4: null, post: null },
        events: [initEvent],
      })
      .select('*')
      .single<DeviceRow>();

    if (insertErr) throw new ApiError(insertErr.message, 500);
    return mapRowToDevice(created);
  }

  // ── All other actions require existing device ───────────────────────────────
  const { data: device, error: fetchErr } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', serial)
    .maybeSingle<DeviceRow>();

  if (fetchErr) throw new ApiError(fetchErr.message, 500);
  if (!device) throw new ApiError('Device not registered.', 404);

  if (device.pending_restart !== null) {
    throw new ApiError('Confirm the manual restart before continuing.', 409);
  }

  const events = Array.isArray(device.events) ? [...device.events] : [];
  const eventItem: Record<string, unknown> = {
    action,
    battery: reading.battery_percent,
    device_time: reading.device_timestamp,
    server_received: stamp,
  };
  if (reading.has_issue) eventItem.has_issue = reading.has_issue;
  if (reading.issue_categories) eventItem.issue_categories = reading.issue_categories;
  if (reading.remarks) eventItem.remarks = reading.remarks;
  if (reading.power_test_result) eventItem.power_test_result = reading.power_test_result;
  events.push(eventItem);

  const observations = device.observations || { h1: null, h2: null, h3: null, h4: null, post: null };

  // ── Action: Start Aging ──────────────────────────────────────────────────────
  if (action === 'start-aging') {
    if (!['READY_FOR_AGING', 'WAITING_FOR_100_PERCENT_CHARGE'].includes(device.status)) {
      throw new ApiError('Aging has already started or is unavailable.', 409);
    }
    if (reading.battery_percent !== 100) {
      throw new ApiError('Charge to 100% and capture a fresh reading before starting aging.', 409);
    }

    const { data: updated, error: updateErr } = await supabase
      .from('devices')
      .update({
        status: 'AGING_HOUR_1',
        aging_started: stamp,
        next_due: new Date(Date.now() + 3600 * 1000).toISOString(),
        last_battery: 100,
        last_device_time: reading.device_timestamp,
        last_server_received: stamp,
        next_checkpoint: 1,
        events,
      })
      .eq('serial_number', serial)
      .select('*')
      .single<DeviceRow>();

    if (updateErr) throw new ApiError(updateErr.message, 500);
    return mapRowToDevice(updated);
  }

  // ── Action: H1, H2, H3, H4 Checkpoints ──────────────────────────────────────
  if (/^h[1-4]$/.test(action)) {
    const n = parseInt(action[1], 10);

    // Auto-start aging on H1 if coming directly from registered state
    let agingStarted = device.aging_started;
    if (n === 1 && ['READY_FOR_AGING', 'WAITING_FOR_100_PERCENT_CHARGE'].includes(device.status)) {
      agingStarted = stamp;
    } else if (device.status !== `AGING_HOUR_${n}` || device.next_checkpoint !== n) {
      throw new ApiError('Checkpoints must follow H1, H2, H3, H4 in order.', 409);
    }

    if (reading.has_issue) {
      observations[`h${n}`] = {
        has_issue: reading.has_issue,
        categories: reading.issue_categories || [],
        remarks: reading.remarks || '',
      };
    }

    const updatePayload: Record<string, unknown> = {
      [`h${n}_battery`]: reading.battery_percent,
      [`h${n}_timestamp`]: reading.device_timestamp,
      [`h${n}_server_time`]: stamp,
      observations,
      pending_restart: n,
      next_due: null,
      last_battery: reading.battery_percent,
      last_device_time: reading.device_timestamp,
      last_server_received: stamp,
      events,
    };
    if (agingStarted) {
      updatePayload.aging_started = agingStarted;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('devices')
      .update(updatePayload)
      .eq('serial_number', serial)
      .select('*')
      .single<DeviceRow>();

    if (updateErr) throw new ApiError(updateErr.message, 500);
    return mapRowToDevice(updated);
  }

  // ── Action: Post-Aging ──────────────────────────────────────────────────────
  if (action === 'post-aging') {
    if (!['AGING_TEST_COMPLETE', 'POST_AGING_CHARGE'].includes(device.status)) {
      throw new ApiError('Complete H4 and confirm restart before post-aging charge.', 409);
    }

    if (reading.has_issue) {
      observations.post = {
        has_issue: reading.has_issue,
        categories: reading.issue_categories || [],
        remarks: reading.remarks || '',
      };
    }

    const newStatus = reading.battery_percent >= 70 ? 'PACKING_READY' : 'POST_AGING_CHARGE';
    const updatePayload: Record<string, unknown> = {
      post_aging_battery: reading.battery_percent,
      post_aging_timestamp: reading.device_timestamp,
      post_aging_server_time: stamp,
      status: newStatus,
      observations,
      last_battery: reading.battery_percent,
      last_device_time: reading.device_timestamp,
      last_server_received: stamp,
      events,
    };

    if (reading.power_test_result) {
      updatePayload.power_test_result = reading.power_test_result;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('devices')
      .update(updatePayload)
      .eq('serial_number', serial)
      .select('*')
      .single<DeviceRow>();

    if (updateErr) throw new ApiError(updateErr.message, 500);
    return mapRowToDevice(updated);
  }

  throw new ApiError(`Unknown action: ${action}`, 400);
}
