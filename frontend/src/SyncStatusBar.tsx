import { useEffect, useState } from 'react';
import { subscribeSyncState, syncAllPending, type SyncState } from './syncManager';

export function SyncStatusBar() {
  const [syncState, setSyncState] = useState<SyncState>({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSyncing: false,
    pendingCount: 0,
    lastSyncTime: null,
    lastError: null,
  });

  useEffect(() => {
    return subscribeSyncState(setSyncState);
  }, []);

  const handleManualSync = async () => {
    await syncAllPending();
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 10px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: 600,
        background: syncState.isSyncing
          ? 'rgba(234, 179, 8, 0.15)'
          : syncState.pendingCount > 0
          ? 'rgba(239, 68, 68, 0.12)'
          : 'rgba(34, 197, 94, 0.12)',
        color: syncState.isSyncing
          ? '#854d0e'
          : syncState.pendingCount > 0
          ? '#991b1b'
          : '#166534',
        border: `1px solid ${
          syncState.isSyncing
            ? 'rgba(234, 179, 8, 0.3)'
            : syncState.pendingCount > 0
            ? 'rgba(239, 68, 68, 0.3)'
            : 'rgba(34, 197, 94, 0.3)'
        }`,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: syncState.isSyncing
            ? '#eab308'
            : !syncState.isOnline
            ? '#ef4444'
            : syncState.pendingCount > 0
            ? '#f97316'
            : '#22c55e',
          animation: syncState.isSyncing ? 'pulse 1s infinite' : 'none',
        }}
      />
      <span>
        {syncState.isSyncing
          ? `Syncing (${syncState.pendingCount})...`
          : !syncState.isOnline
          ? `Offline (${syncState.pendingCount} saved locally)`
          : syncState.pendingCount > 0
          ? `${syncState.pendingCount} pending upload`
          : 'Synced'}
      </span>
      {syncState.pendingCount > 0 && !syncState.isSyncing && (
        <button
          type="button"
          onClick={handleManualSync}
          style={{
            background: '#ffffff',
            border: '1px solid rgba(0, 0, 0, 0.15)',
            borderRadius: '12px',
            padding: '2px 8px',
            fontSize: '11px',
            fontWeight: 700,
            cursor: 'pointer',
            color: '#18362c',
          }}
        >
          Sync Now
        </button>
      )}
    </div>
  );
}
