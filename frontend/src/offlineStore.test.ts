import { describe, it, expect, beforeEach } from 'vitest';
import type { Reading, Device } from './types';

// In Node test environment, mock indexedDB if not available
class MockIDBDatabase {
  stores: Record<string, Map<string, any>> = {
    pending_readings: new Map(),
    cached_devices: new Map(),
  };

  transaction(storeNames: string | string[], _mode?: string) {
    const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    const storeMap = this.stores[storeName] || new Map();

    return {
      objectStore: () => ({
        put: (val: any) => {
          const key = val.id || val.serial_number;
          storeMap.set(key, val);
          const req: any = {};
          setTimeout(() => req.onsuccess?.({ target: { result: key } }), 0);
          return req;
        },
        get: (key: string) => {
          const req: any = {};
          setTimeout(() => {
            req.result = storeMap.get(key) || null;
            req.onsuccess?.({ target: { result: req.result } });
          }, 0);
          return req;
        },
        getAll: () => {
          const req: any = {};
          setTimeout(() => {
            req.result = Array.from(storeMap.values());
            req.onsuccess?.({ target: { result: req.result } });
          }, 0);
          return req;
        },
        delete: (key: string) => {
          storeMap.delete(key);
          const req: any = {};
          setTimeout(() => req.onsuccess?.({ target: {} }), 0);
          return req;
        },
      }),
    };
  }
}

describe('Offline Storage and Local-First Pipeline', () => {
  let mockDb: MockIDBDatabase;

  beforeEach(() => {
    mockDb = new MockIDBDatabase();
    (globalThis as any).window = globalThis;
    (globalThis as any).window.indexedDB = {
      open: () => {
        const req: any = {};
        setTimeout(() => {
          req.result = mockDb;
          req.onsuccess?.({ target: { result: mockDb } });
        }, 0);
        return req;
      },
    };
  });

  it('queues a pending reading when offline', async () => {
    const { savePendingReading, getPendingReadings } = await import('./offlineStore');

    const reading: Reading = {
      serial_number: 'T001RAABC00001',
      battery_percent: 100,
      device_timestamp: null,
      capture_token: 'tok_test_123',
    };

    const id = await savePendingReading('register', reading);
    expect(id).toMatch(/^reading_/);

    const pending = await getPendingReadings();
    expect(pending.length).toBe(1);
    expect(pending[0].reading.serial_number).toBe('T001RAABC00001');
    expect(pending[0].status).toBe('pending');
  });

  it('caches and retrieves a device record locally', async () => {
    const { cacheDevice, getCachedDevice } = await import('./offlineStore');

    const device: Device = {
      serial_number: 'T002RXYZ12345',
      status: 'READY_FOR_AGING',
      pending_restart: null,
      next_checkpoint: 1,
      aging_started: new Date().toISOString(),
      next_due: new Date().toISOString(),
      last_server_received: new Date().toISOString(),
      last_device_time: null,
      last_battery: 100,
      values: ['T002RXYZ12345', new Date().toISOString(), 100, null, null, null, null, null, null, null, null, null, null, 'READY_FOR_AGING'],
    };

    await cacheDevice(device);
    const cached = await getCachedDevice('T002RXYZ12345');
    expect(cached).not.toBeNull();
    expect(cached?.serial_number).toBe('T002RXYZ12345');
    expect(cached?.status).toBe('READY_FOR_AGING');
  });

  it('removes pending reading after successful sync', async () => {
    const { savePendingReading, getPendingReadings, removePendingReading } = await import('./offlineStore');

    const reading: Reading = {
      serial_number: 'T003RXYZ12345',
      battery_percent: 95,
      device_timestamp: null,
      capture_token: 'tok_test_456',
    };

    const id = await savePendingReading('h1', reading);
    let pending = await getPendingReadings();
    expect(pending.some((p) => p.id === id)).toBe(true);

    await removePendingReading(id);
    pending = await getPendingReadings();
    expect(pending.some((p) => p.id === id)).toBe(false);
  });
});
