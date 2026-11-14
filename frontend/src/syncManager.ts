/**
 * syncManager.ts
 *
 * Background synchronization engine for Tohands Production Aging Test.
 * - Monitors online/offline connectivity.
 * - Flushes pending readings from IndexedDB to the backend/Postgres when connected.
 * - Caches device records returned from successful syncs.
 * - Provides real-time sync status to the UI.
 */

import {
  getPendingReadings,
  getPendingCount,
  updatePendingStatus,
  removePendingReading,
  cacheDevice,
} from './offlineStore';
import { submit } from './api';
import type { Device } from './types';

export interface SyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncTime: number | null;
  lastError: string | null;
}

type SyncListener = (state: SyncState) => void;

let currentState: SyncState = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isSyncing: false,
  pendingCount: 0,
  lastSyncTime: null,
  lastError: null,
};

const listeners = new Set<SyncListener>();

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener({ ...currentState });
    } catch (err) {
      console.error('Error in sync listener:', err);
    }
  }
}

export function getSyncState(): SyncState {
  return { ...currentState };
}

export function subscribeSyncState(listener: SyncListener): () => void {
  listeners.add(listener);
  listener({ ...currentState });
  return () => {
    listeners.delete(listener);
  };
}

let syncTimeout: number | null = null;

export async function refreshPendingCount(): Promise<number> {
  try {
    const count = await getPendingCount();
    currentState.pendingCount = count;
    notifyListeners();
    return count;
  } catch {
    return currentState.pendingCount;
  }
}

/**
 * Flush all pending readings to the backend.
 */
export async function syncAllPending(): Promise<{ synced: number; failed: number }> {
  if (currentState.isSyncing) {
    return { synced: 0, failed: 0 };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    currentState.isOnline = false;
    notifyListeners();
    return { synced: 0, failed: 0 };
  }

  currentState.isSyncing = true;
  currentState.lastError = null;
  notifyListeners();

  let synced = 0;
  let failed = 0;

  try {
    const pending = await getPendingReadings();
    currentState.pendingCount = pending.length;
    notifyListeners();

    for (const item of pending) {
      try {
        await updatePendingStatus(item.id, 'syncing');
        notifyListeners();

        // Submit to backend
        const updatedDevice: Device = await submit(
          item.action,
          item.reading,
          item.target
        );

        // Cache the resulting device state in IndexedDB
        if (updatedDevice && updatedDevice.serial_number) {
          await cacheDevice(updatedDevice);
        }

        // Remove successfully synced reading from queue
        await removePendingReading(item.id);
        synced++;
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        await updatePendingStatus(item.id, 'failed', errMsg);
        currentState.lastError = errMsg;
        // If network error occurred, pause sync queue
        if (!navigator.onLine || errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
          break;
        }
      }
    }

    currentState.lastSyncTime = Date.now();
  } catch (err) {
    console.error('Failed during sync queue flush:', err);
  } finally {
    currentState.isSyncing = false;
    await refreshPendingCount();
  }

  return { synced, failed };
}

/**
 * Schedule next sync attempt.
 */
export function scheduleSync(delayMs = 1500) {
  if (syncTimeout !== null) {
    clearTimeout(syncTimeout);
  }
  syncTimeout = window.setTimeout(() => {
    syncTimeout = null;
    void syncAllPending();
  }, delayMs);
}

/**
 * Initialize background sync listeners and interval.
 */
export function initSyncManager() {
  if (typeof window === 'undefined') return;

  const handleOnline = () => {
    currentState.isOnline = true;
    notifyListeners();
    void syncAllPending();
  };

  const handleOffline = () => {
    currentState.isOnline = false;
    notifyListeners();
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  // Initial pending count check and sync
  void refreshPendingCount().then((count) => {
    if (count > 0 && navigator.onLine) {
      scheduleSync(2000);
    }
  });

  // Periodic background check every 30 seconds
  const interval = setInterval(() => {
    if (navigator.onLine && currentState.pendingCount > 0 && !currentState.isSyncing) {
      void syncAllPending();
    }
  }, 30000);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    clearInterval(interval);
  };
}
