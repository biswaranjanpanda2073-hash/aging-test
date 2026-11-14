/**
 * offlineStore.ts
 *
 * IndexedDB local storage engine for Tohands Production Aging Test.
 * Guarantees local-first persistence:
 *  1. Every reading is written to IndexedDB before any network transmission.
 *  2. Device states are cached locally so operators can work seamlessly offline.
 *  3. An unsynced queue persists across page reloads and browser restarts.
 */

import type { Action, Device, Reading } from './types';

const DB_NAME = 'TohandsAgingDB';
const DB_VERSION = 1;

export interface PendingReadingRecord {
  id: string;
  action: Action;
  reading: Reading;
  target?: string;
  createdAt: number;
  status: 'pending' | 'syncing' | 'failed' | 'synced';
  retryCount: number;
  lastError: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Object store for pending offline readings
      if (!db.objectStoreNames.contains('pending_readings')) {
        const pendingStore = db.createObjectStore('pending_readings', { keyPath: 'id' });
        pendingStore.createIndex('serial_number', 'reading.serial_number', { unique: false });
        pendingStore.createIndex('status', 'status', { unique: false });
        pendingStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Object store for local device state caching
      if (!db.objectStoreNames.contains('cached_devices')) {
        db.createObjectStore('cached_devices', { keyPath: 'serial_number' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB.'));
    };
  });

  return dbPromise;
}

// ── Pending Readings Queue ──────────────────────────────────────────────────

export async function savePendingReading(
  action: Action,
  reading: Reading,
  target?: string
): Promise<string> {
  const db = await openDB();
  const id = `reading_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const record: PendingReadingRecord = {
    id,
    action,
    reading,
    target,
    createdAt: Date.now(),
    status: 'pending',
    retryCount: 0,
    lastError: null,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_readings', 'readwrite');
    const store = tx.objectStore('pending_readings');
    const req = store.put(record);

    req.onsuccess = () => resolve(id);
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingReadings(): Promise<PendingReadingRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_readings', 'readonly');
    const store = tx.objectStore('pending_readings');
    const req = store.getAll();

    req.onsuccess = () => {
      const records = (req.result || []) as PendingReadingRecord[];
      // Filter out already synced records and sort chronologically
      const pending = records
        .filter((r) => r.status !== 'synced')
        .sort((a, b) => a.createdAt - b.createdAt);
      resolve(pending);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingCount(): Promise<number> {
  const pending = await getPendingReadings();
  return pending.length;
}

export async function updatePendingStatus(
  id: string,
  status: 'pending' | 'syncing' | 'failed' | 'synced',
  error?: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_readings', 'readwrite');
    const store = tx.objectStore('pending_readings');
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const record = getReq.result as PendingReadingRecord | undefined;
      if (!record) {
        resolve();
        return;
      }
      record.status = status;
      if (status === 'failed') {
        record.retryCount = (record.retryCount || 0) + 1;
        record.lastError = error || 'Sync failed';
      } else if (status === 'synced') {
        record.lastError = null;
      }
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function removePendingReading(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_readings', 'readwrite');
    const store = tx.objectStore('pending_readings');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Local Cached Devices ────────────────────────────────────────────────────

export async function cacheDevice(device: Device): Promise<void> {
  if (!device || !device.serial_number) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_devices', 'readwrite');
    const store = tx.objectStore('cached_devices');
    const record = {
      ...device,
      _local_updated_at: Date.now(),
    };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedDevice(serial: string): Promise<Device | null> {
  if (!serial) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_devices', 'readonly');
    const store = tx.objectStore('cached_devices');
    const req = store.get(serial.trim());

    req.onsuccess = () => {
      resolve((req.result as Device) || null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCachedDevices(): Promise<Device[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_devices', 'readonly');
    const store = tx.objectStore('cached_devices');
    const req = store.getAll();

    req.onsuccess = () => {
      resolve((req.result as Device[]) || []);
    };
    req.onerror = () => reject(req.error);
  });
}
