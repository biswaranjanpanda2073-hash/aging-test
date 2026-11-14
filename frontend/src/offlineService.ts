/**
 * offlineService.ts
 *
 * Local-First submission and device lookup services.
 * Writes to IndexedDB first, then pushes to backend/Postgres.
 */

import { submit, api, ApiError } from './api';
import {
  savePendingReading,
  cacheDevice,
  getCachedDevice,
  removePendingReading,
} from './offlineStore';
import { scheduleSync, refreshPendingCount } from './syncManager';
import type { Action, Device, Reading } from './types';

export interface SubmitResult {
  device: Device;
  isOffline: boolean;
}

/**
 * Creates an optimistic Device representation when offline so the operator UI continues seamlessly.
 */
function createOptimisticDevice(
  action: Action,
  reading: Reading,
  currentDevice?: Device | null
): Device {
  const serial = reading.serial_number;
  const now = new Date().toISOString();
  const battery = reading.battery_percent;

  if (action === 'register') {
    const isReady = battery === 100;
    const status = isReady ? 'READY_FOR_AGING' : 'WAITING_FOR_100_PERCENT_CHARGE';
    const values: (string | number | null)[] = [
      serial,
      now,
      battery,
      null, null, // H1
      null, null, // H2
      null, null, // H3
      null, null, // H4
      null, null, // Post
      status,
    ];

    return {
      serial_number: serial,
      status,
      pending_restart: null,
      next_checkpoint: 1,
      aging_started: isReady ? now : null,
      next_due: isReady ? new Date(Date.now() + 3600 * 1000).toISOString() : null,
      last_server_received: now,
      last_device_time: null,
      last_battery: battery,
      values,
      observations: null,
      power_test_result: null,
    };
  }

  // Base on existing device if available
  const existingValues = currentDevice?.values ? [...currentDevice.values] : [serial, now, battery, ...Array(11).fill(null)];

  let nextCp = currentDevice?.next_checkpoint ?? 1;
  let status = currentDevice?.status ?? 'READY_FOR_AGING';
  let nextDue: string | null = null;

  if (action.startsWith('h')) {
    const cpIndex = parseInt(action.substring(1), 10);
    // H1 is at index 3,4; H2 at 5,6; H3 at 7,8; H4 at 9,10
    const valIdx = 2 * cpIndex + 1;
    existingValues[valIdx] = battery;
    existingValues[valIdx + 1] = now;

    if (cpIndex < 4) {
      nextCp = cpIndex + 1;
      status = `AGING_HOUR_${nextCp}`;
      nextDue = new Date(Date.now() + 3600 * 1000).toISOString();
    } else {
      nextCp = 4;
      status = 'AGING_TEST_COMPLETE';
      nextDue = null;
    }
  } else if (action === 'post-aging') {
    existingValues[11] = battery;
    existingValues[12] = now;
    status = 'PACKING_READY';
  }

  existingValues[13] = status;

  return {
    serial_number: serial,
    status,
    pending_restart: null,
    next_checkpoint: nextCp,
    aging_started: currentDevice?.aging_started ?? now,
    next_due: nextDue,
    last_server_received: now,
    last_device_time: null,
    last_battery: battery,
    values: existingValues,
    observations: currentDevice?.observations ?? null,
    power_test_result: reading.power_test_result ?? currentDevice?.power_test_result ?? null,
  };
}

/**
 * Submit reading with Local-First guarantees:
 * 1. Queue to IndexedDB.
 * 2. Try online API submit.
 * 3. If online succeeds, cache the official response and remove from pending queue.
 * 4. If offline/error, return optimistic device state so user can continue without delay.
 */
export async function submitLocalFirst(
  action: Action,
  reading: Reading,
  target?: string,
  currentDevice?: Device | null
): Promise<SubmitResult> {
  const serial = reading.serial_number;
  if (target && target !== serial) {
    throw new ApiError('Serial mismatch. Capture the selected device.', 409);
  }

  // 1. Immediately persist to IndexedDB pending queue
  const pendingId = await savePendingReading(action, reading, target);
  await refreshPendingCount();

  // 2. If browser reports offline, skip network and return optimistic result immediately
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const optimisticDevice = createOptimisticDevice(action, reading, currentDevice);
    await cacheDevice(optimisticDevice);
    return { device: optimisticDevice, isOffline: true };
  }

  // 3. Try immediate network submission
  try {
    const serverDevice = await submit(action, reading, target);
    // Successful online submission: cache server state and remove from pending queue
    await cacheDevice(serverDevice);
    await removePendingReading(pendingId);
    await refreshPendingCount();
    return { device: serverDevice, isOffline: false };
  } catch (err) {
    // If error is network error or server down (502, 503, timeout)
    const isNetworkError =
      !navigator.onLine ||
      (err instanceof ApiError && (err.status === 0 || err.status >= 500)) ||
      (err instanceof Error && (err.message.includes('fetch') || err.message.includes('Network')));

    if (isNetworkError) {
      console.warn('Network submit failed, stored in IndexedDB for background sync:', err);
      const optimisticDevice = createOptimisticDevice(action, reading, currentDevice);
      await cacheDevice(optimisticDevice);
      scheduleSync(5000);
      return { device: optimisticDevice, isOffline: true };
    }

    // Validation / 409 Conflict errors should be thrown to the user
    await removePendingReading(pendingId);
    await refreshPendingCount();
    throw err;
  }
}

/**
 * Look up device by serial number with offline fallback.
 */
export async function lookupDeviceWithOfflineFallback(
  serial: string
): Promise<{ device: Device; isCached: boolean }> {
  const trimmed = serial.trim();

  // Try online fetch first if online
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const liveDevice = await api<Device>(`/devices/${encodeURIComponent(trimmed)}`);
      // Update local cache
      await cacheDevice(liveDevice);
      return { device: liveDevice, isCached: false };
    } catch (err) {
      // If server returned 404, throw error (device not registered)
      if (err instanceof ApiError && err.status === 404) {
        throw err;
      }
      console.warn('Online device lookup failed, checking local IndexedDB cache:', err);
    }
  }

  // Offline fallback: check local IndexedDB
  const cached = await getCachedDevice(trimmed);
  if (cached) {
    return { device: cached, isCached: true };
  }

  throw new ApiError(
    navigator.onLine
      ? `Device ${trimmed} not found.`
      : `Offline: Device ${trimmed} is not cached in local storage. Please connect to internet to fetch it.`,
    404
  );
}
