import { useEffect, useState } from 'react';

interface VersionInfo {
  version: string;
  buildTime: number;
  buildId: string;
}

export function UpdatePrompt() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    // Current runtime build timestamp
    const currentBuildTime = typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : null;

    async function checkVersion() {
      try {
        const url = `/version.json?_t=${Date.now()}`;
        const res = await fetch(url, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
        });

        if (!res.ok) return;
        const data = (await res.json()) as VersionInfo;

        if (data && data.buildTime) {
          // If server build time is newer than current running app build time
          if (currentBuildTime && data.buildTime > currentBuildTime + 1000) {
            setHasUpdate(true);
            setLatestVersion(data.version);
          }
        }
      } catch {
        // Ignore network polling errors when offline
      }
    }

    // Check after 3 seconds on launch
    const initialTimer = setTimeout(() => {
      void checkVersion();
    }, 3000);

    // Periodic check every 45 seconds
    const intervalTimer = setInterval(() => {
      void checkVersion();
    }, 45000);

    // Check immediately when user switches tabs or returns to the window
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkVersion();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);

  const handleRefresh = async () => {
    // Clear service worker caches if present
    if ('serviceWorker' in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.update();
        }
      } catch {
        /* ignore */
      }
    }
    // Hard reload
    window.location.reload();
  };

  if (!hasUpdate || dismissed) {
    return null;
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        background: '#18362c',
        color: '#ffffff',
        padding: '10px 18px',
        borderRadius: '999px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        maxWidth: '92vw',
        fontSize: '14px',
        fontWeight: 500,
        animation: 'slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <span style={{ fontSize: '16px' }}>🚀</span>
      <span>
        A new update {latestVersion ? `(${latestVersion})` : ''} is available!
      </span>
      <button
        onClick={handleRefresh}
        type="button"
        style={{
          background: '#34d399',
          color: '#064e3b',
          border: 'none',
          padding: '6px 14px',
          borderRadius: '999px',
          fontWeight: 700,
          cursor: 'pointer',
          fontSize: '13px',
          transition: 'transform 0.1s ease',
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.96)')}
        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        Refresh Now
      </button>
      <button
        onClick={() => setDismissed(true)}
        type="button"
        title="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'rgba(255, 255, 255, 0.7)',
          cursor: 'pointer',
          padding: '4px',
          fontSize: '16px',
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}
