import {useCallback,useEffect,useRef,useState} from 'react';
import {api,submit} from './api';
import {Scanner} from './Scanner';
import {detectQRFromImage,parseQRSerial} from './qr';
import type {Action,Device,Reading} from './types';

const modules = [
  { name: 'Device Registration', description: 'Scan QR and initial battery', number: '01' },
  { name: 'Aging Test', description: 'H1 through H4 hourly checkpoints', number: '02' },
  { name: 'Post Test', description: 'Final battery check for packing', number: '03' }
];

const label = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');

export default function App() {
  const [page, setPage] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [regex, setRegex] = useState('');
  const [device, setDevice] = useState<Device | null>(null);
  const [scanning, setScanning] = useState<Action | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [action, setAction] = useState<Action>('register');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // Lookup state for steps 02 & 03
  const [lookupPhase, setLookupPhase] = useState<'scan' | 'manual' | 'loading'>('scan');
  const [serial, setSerial] = useState('');
  const lookupQRInputRef = useRef<HTMLInputElement>(null);

  // Dedicated 2-step states for Step 01 (Device Registration)
  const [regSerial, setRegSerial] = useState('');
  const [regBattery, setRegBattery] = useState<number | null>(null);
  const [regToken, setRegToken] = useState('');
  const [regScanningQR, setRegScanningQR] = useState(false);
  const [regScanningBattery, setRegScanningBattery] = useState(false);
  const [regRegistered, setRegRegistered] = useState<Device | null>(null);
  const [regManual, setRegManual] = useState(false);
  const [regManualInput, setRegManualInput] = useState('');
  const regQRInputRef = useRef<HTMLInputElement>(null);

  // Dedicated 2-step states for Step 03 (Post Test / Packing)
  const [postSerial, setPostSerial] = useState('');
  const [postBattery, setPostBattery] = useState<number | null>(null);
  const [postToken, setPostToken] = useState('');
  const [postScanningQR, setPostScanningQR] = useState(false);
  const [postScanningBattery, setPostScanningBattery] = useState(false);
  const [postConfirmed, setPostConfirmed] = useState<Device | null>(null);
  const [postManual, setPostManual] = useState(false);
  const [postManualInput, setPostManualInput] = useState('');
  const postQRInputRef = useRef<HTMLInputElement>(null);

  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        await api('/health');
        const config = await api<{ serial_regex: string }>('/config');
        if (live) {
          setConnected(true);
          setRegex(config.serial_regex);
        }
      } catch {
        if (live) setConnected(false);
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 10000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  // Poll active device to immediately reflect deletions or edits made directly in Excel
  useEffect(() => {
    if (!device) return;
    let live = true;
    const verifyDevice = async () => {
      try {
        const latest = await api<Device>(`/devices/${encodeURIComponent(device.serial_number)}`);
        if (live && JSON.stringify(latest) !== JSON.stringify(device)) {
          setDevice(latest);
        }
      } catch {
        if (live) {
          setDevice(null);
          setReading(null);
          setMessage(`Device ${device.serial_number} was deleted or removed from Excel.`);
        }
      }
    };
    const timer = setInterval(() => { void verifyDevice(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [device]);

  const perform = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const resetRegistration = () => {
    setRegSerial('');
    setRegBattery(null);
    setRegToken('');
    setRegRegistered(null);
    setRegManual(false);
    setRegManualInput('');
    setRegScanningQR(false);
    setRegScanningBattery(false);
    setError('');
    setMessage('');
  };

  const resetPostStage = () => {
    setPostSerial('');
    setPostBattery(null);
    setPostToken('');
    setPostConfirmed(null);
    setPostManual(false);
    setPostManualInput('');
    setPostScanningQR(false);
    setPostScanningBattery(false);
    setError('');
    setMessage('');
  };

  const navigate = (index: number | null) => {
    if (busy) return;
    setPage(index);
    setScanning(null);
    setReading(null);
    setError('');
    setMessage('');
    setDevice(null);
    setLookupPhase('scan');
    resetRegistration();
    resetPostStage();
  };

  // Step 01: Handle QR photo scan
  const onScanRegQR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setRegScanningQR(true);
    try {
      const result = await detectQRFromImage(file);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'QR not found. Please ensure the QR code is clearly visible and retry.');
      }
      const found = parseQRSerial(result.data, regex);
      setRegSerial(found);
      setRegManual(false);
      setMessage('');
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : 'QR scan failed.');
    } finally {
      setRegScanningQR(false);
    }
  };

  // Step 01: Handle Battery scan completion from Scanner modal
  const onRegBatteryReceived = useCallback((result: Reading) => {
    setRegBattery(result.battery_percent);
    setRegToken(result.capture_token);
    setRegScanningBattery(false);
    setMessage('');
  }, []);

  // Step 01: Confirm & Register in Excel
  const confirmRegistration = () => perform(async () => {
    if (!regSerial || regBattery === null || !regToken) return;
    const readingPayload: Reading = {
      serial_number: regSerial,
      battery_percent: regBattery,
      device_timestamp: null,
      capture_token: regToken
    };
    const next = await submit('register', readingPayload);
    setRegRegistered(next);
    setMessage('Device registered successfully in Excel.');
  });

  // Step 03: Handle QR photo scan for packing
  const onScanPostQR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setPostScanningQR(true);
    try {
      const result = await detectQRFromImage(file);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'QR not found. Please ensure the QR code is clearly visible and retry.');
      }
      const found = parseQRSerial(result.data, regex);
      setPostSerial(found);
      setPostManual(false);
      setMessage('');
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : 'QR scan failed.');
    } finally {
      setPostScanningQR(false);
    }
  };

  // Step 03: Handle Battery scan completion for packing
  const onPostBatteryReceived = useCallback((result: Reading) => {
    setPostBattery(result.battery_percent);
    setPostToken(result.capture_token);
    setPostScanningBattery(false);
    setMessage('');
  }, []);

  // Step 03: Confirm & Save Post-Aging Packing in Excel
  const confirmPostAging = () => perform(async () => {
    if (!postSerial || postBattery === null || !postToken) return;
    const readingPayload: Reading = {
      serial_number: postSerial,
      battery_percent: postBattery,
      device_timestamp: null,
      capture_token: postToken
    };
    const next = await submit('post-aging', readingPayload, postSerial);
    setPostConfirmed(next);
    setMessage('Device successfully saved to Excel and marked Packing Ready.');
  });

  // Steps 02 & 03: Lookup logic
  const findBySerial = async (s: string) => perform(async () => {
    const next = await api<Device>(`/devices/${encodeURIComponent(s.trim())}`);
    setDevice(next);
    setSerial(s.trim());
    setMessage('');
    setLookupPhase('scan');
  });

  const scanLookupQR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setLookupPhase('loading');
    try {
      const result = await detectQRFromImage(file);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'QR not found. Try again or enter serial manually.');
      }
      const found = parseQRSerial(result.data, regex);
      await findBySerial(found);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : 'QR scan failed.');
      setLookupPhase('scan');
    }
  };

  const openCheckpointScan = (next: Action) => {
    setAction(next);
    setReading(null);
    setError('');
    setMessage('');
    setScanning(next);
  };

  const onCheckpointReceived = useCallback((result: Reading) => {
    setReading(result);
    setScanning(null);
  }, []);

  const formatRemaining = (ms: number) => {
    if (ms <= 0) return '0s';
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min > 0) return `${min}m ${sec}s`;
    return `${sec}s`;
  };

  const resetStage2Device = () => {
    setDevice(null);
    setReading(null);
    setScanning(null);
    setSerial('');
    setLookupPhase('scan');
    setError('');
    setMessage('');
  };

  const handleStage2NavClick = (targetStep: 'qr' | 1 | 2 | 3 | 4) => {
    setError('');
    setMessage('');
    if (targetStep === 'qr') {
      setScanning(null);
      setReading(null);
      lookupQRInputRef.current?.click();
      return;
    }
    if (!device) {
      setError('Please scan or select a device serial number first.');
      return;
    }
    const n = targetStep;
    const isSaved = device.values[2 * n + 1] !== null;
    if (isSaved) {
      setMessage(`H${n} is already recorded in Excel (${device.values[2 * n + 1]}% at ${device.values[2 * n + 2] || 'recorded time'}).`);
      return;
    }
    const currentCp = (device.status === 'READY_FOR_AGING' || device.status === 'WAITING_FOR_100_PERCENT_CHARGE') ? 1 : device.next_checkpoint;
    if (n > currentCp) {
      setError(`Please complete checkpoint H${currentCp} before H${n}.`);
      return;
    }
    if (n < currentCp) {
      setMessage(`H${n} is already completed.`);
      return;
    }
    const remMs = device.next_due ? Math.max(0, new Date(device.next_due).getTime() - currentTime) : 0;
    if (remMs > 0 && n > 1) {
      setError(`H${n} is not due yet. Remaining time: ${formatRemaining(remMs)}.`);
      return;
    }
    openCheckpointScan(`h${n}` as Action);
  };

  const confirmCheckpoint = () => perform(async () => {
    if (!reading) return;
    const next = await submit(action, reading, device?.serial_number);
    let updatedDevice = next;
    if (next.pending_restart) {
      try {
        updatedDevice = await api<Device>(`/devices/${encodeURIComponent(next.serial_number)}/restart`, {
          checkpoint: next.pending_restart,
          confirmed: true
        });
      } catch (e) {
        console.warn('Auto-restart warning:', e);
      }
    }
    setDevice(updatedDevice);
    setSerial(updatedDevice.serial_number);
    setReading(null);
    setMessage(`✓ Reading for ${action.toUpperCase()} (${reading.battery_percent}%) stored in Excel successfully.`);
  });

  const deleteDeviceRecord = () => perform(async () => {
    if (!device) return;
    const targetSerial = device.serial_number;
    if (!window.confirm(`Delete device ${targetSerial} from Excel?\nThis will permanently remove the device row and all aging records.`)) {
      return;
    }
    await api<{ status: string }>(`/devices/${encodeURIComponent(targetSerial)}`, {}, undefined, 'DELETE');
    setDevice(null);
    setReading(null);
    setSerial('');
    setMessage(`Device ${targetSerial} was deleted from Excel successfully.`);
  });

  return (
    <div className="app">
      <header>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate(null); }} className="brand">
          <span className="brand-mark">t.</span>tohands
          <span className="division">PRODUCTION</span>
        </a>
        <span className={'connection ' + (connected ? 'online' : 'offline')}>
          {connected ? 'Server connected' : 'Server not connected'}
        </span>
      </header>

      <main>
        <div className="title-row">
          <div>
            <p className="eyebrow">DEVICE QUALITY CONTROL</p>
            <h1>Production Aging Test</h1>
          </div>
          <span className="internal">Factory workflow</span>
        </div>

        {/* ----------------- FIRST / LANDING PAGE (page === null) ----------------- */}
        {page === null && (
          <section className="home-view" aria-label="Workflow Stages">
            <div className="home-intro">
              <p>Select a stage below to begin:</p>
            </div>

            <div className="home-modules-grid">
              {modules.map((m, idx) => (
                <div
                  key={m.number}
                  className="home-card"
                  onClick={() => navigate(idx)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(idx); }}
                >
                  <div>
                    <div className="home-card-header">
                      <span className="home-card-number">{m.number}</span>
                      <h2 className="home-card-title">{m.name}</h2>
                    </div>
                    <p className="home-card-desc">{m.description}</p>
                  </div>
                  <button type="button" className="home-card-btn">
                    Open {m.name} →
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ----------------- STAGE PAGES (page !== null) ----------------- */}
        {page !== null && (
          <>
            <div className="back-row">
              <button type="button" className="btn-back" onClick={() => navigate(null)}>
                ← Back to Stages
              </button>
            </div>

            <nav aria-label="Current module" style={{ gridTemplateColumns: 'minmax(0, 380px)' }}>
              {modules.filter((_, index) => index === page).map((module) => (
                <div
                  key={module.number}
                  className="module active"
                  style={{ cursor: 'default' }}
                >
                  <span className="step-number">{module.number}</span>
                  <span>
                    <strong>{module.name}</strong>
                    <small>{module.description}</small>
                  </span>
                </div>
              ))}
            </nav>

            {!connected && (
              <p className="error" role="status">
                Connect to the laptop server before capturing or saving a reading.
              </p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            {message && <p className="success" role="status">{message}</p>}

            {/* ===================== STAGE 01: DEVICE REGISTRATION ===================== */}
            {page === 0 && (
              <div className="workspace" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <section className="work-panel">
                  <div className="panel-heading">
                    <span className="eyebrow">STEP 01</span>
                    <h2>Device Registration</h2>
                    <p>Follow the 2-step scanning process: first scan the device serial QR, then scan the battery percentage.</p>
                  </div>

                  {/* Hidden QR photo file input */}
                  <input
                    ref={regQRInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => void onScanRegQR(e)}
                  />

                  {/* Modal for battery scan if open */}
                  {regScanningBattery ? (
                    <Scanner
                      action="register"
                      target={regSerial}
                      regex={regex}
                      mode="battery-only"
                      onResult={onRegBatteryReceived}
                      onCancel={() => setRegScanningBattery(false)}
                    />
                  ) : regRegistered ? (
                    /* Success screen after device is saved in Excel */
                    <div className="success-card-banner">
                      <span className="step-badge done" style={{ fontSize: 13 }}>✓ REGISTRATION COMPLETE</span>
                      <h3 style={{ margin: '14px 0 8px' }}>Device Registered Successfully!</h3>
                      <p style={{ margin: '0 0 20px', color: '#2b5220' }}>
                        Row saved in Excel database with initial status: <strong>{label(regRegistered.status)}</strong>
                      </p>

                      <div className="scanned-value-box" style={{ maxWidth: 440, margin: '0 auto 24px', background: '#fff' }}>
                        <div style={{ textAlign: 'left' }}>
                          <div className="scanned-label">Serial Number</div>
                          <div className="scanned-text">{regRegistered.serial_number}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="scanned-label">Battery Level</div>
                          <div className="scanned-text" style={{ color: '#27521c' }}>{regRegistered.values[2]}%</div>
                        </div>
                      </div>

                      <div className="actions" style={{ justifyContent: 'center' }}>
                        <button onClick={resetRegistration}>+ Register Another Device</button>
                        <button
                          className="secondary"
                          onClick={() => {
                            setDevice(regRegistered);
                            setPage(1);
                            setMessage('');
                          }}
                        >
                          Proceed to Aging Test (02) →
                        </button>
                        <button className="text-button" onClick={() => navigate(null)}>
                          ← Back to Stages
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* The 2-step cards: Button 1 (QR scan) + Button 2 (Battery scan) */
                    <div className="reg-container">
                      {/* --- CARD 1: SERIAL NUMBER QR SCAN --- */}
                      <div className={`scan-step-card ${regSerial ? 'completed' : 'active'}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className={`step-badge ${regSerial ? 'done' : 'active'}`}>
                            {regSerial ? '✓ STEP 1 COMPLETED' : 'STEP 1 OF 2'}
                          </span>
                        </div>

                        <h3 style={{ margin: '6px 0 8px' }}>1. Serial Num QR Scan</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Point the camera at the device QR code label to detect the serial number.
                        </p>

                        {!regSerial ? (
                          <>
                            {regScanningQR ? (
                              <p className="scan-status" role="status">Decoding QR photo…</p>
                            ) : regManual ? (
                              <form
                                className="lookup"
                                style={{ marginTop: 10 }}
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (!regManualInput.trim()) return;
                                  try {
                                    const val = parseQRSerial(regManualInput.trim(), regex);
                                    setRegSerial(val);
                                    setRegManual(false);
                                    setError('');
                                  } catch (ex) {
                                    setError(ex instanceof Error ? ex.message : 'Invalid serial format');
                                  }
                                }}
                              >
                                <label htmlFor="manual-serial">Enter Serial Number</label>
                                <div>
                                  <input
                                    id="manual-serial"
                                    value={regManualInput}
                                    onChange={(e) => setRegManualInput(e.target.value)}
                                    placeholder="Enter device serial"
                                    autoCapitalize="characters"
                                    required
                                  />
                                  <button type="submit" disabled={busy}>Use Serial</button>
                                </div>
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ marginTop: 8 }}
                                  onClick={() => setRegManual(false)}
                                >
                                  ← Back to camera QR scan
                                </button>
                              </form>
                            ) : (
                              <div>
                                <button
                                  type="button"
                                  className="scan-btn-primary"
                                  disabled={busy || !connected}
                                  onClick={() => regQRInputRef.current?.click()}
                                >
                                  ▣ Serial Num QR Scan
                                </button>
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ marginTop: 10, width: '100%' }}
                                  onClick={() => { setRegManual(true); setError(''); }}
                                >
                                  Enter serial manually instead
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          /* Scanned serial display */
                          <div className="scanned-value-box">
                            <div>
                              <div className="scanned-label">Detected Serial Number</div>
                              <div className="scanned-text">{regSerial}</div>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                              onClick={() => {
                                setRegSerial('');
                                setRegBattery(null);
                                setError('');
                              }}
                            >
                              Rescan QR
                            </button>
                          </div>
                        )}
                      </div>

                      {/* --- CARD 2: BATTERY PERCENTAGE SCAN --- */}
                      <div className={`scan-step-card ${!regSerial ? '' : regBattery !== null ? 'completed' : 'active'}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className={`step-badge ${!regSerial ? 'pending' : regBattery !== null ? 'done' : 'active'}`}>
                            {regBattery !== null ? '✓ STEP 2 COMPLETED' : 'STEP 2 OF 2'}
                          </span>
                        </div>

                        <h3 style={{ margin: '6px 0 8px' }}>2. Battery Scan</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Capture a close-up showing the battery percentage digits and % symbol.
                        </p>

                        {!regSerial ? (
                          <p style={{ color: '#748270', fontStyle: 'italic', margin: '10px 0' }}>
                            Scan the Serial QR code in Step 1 first to enable battery scanning.
                          </p>
                        ) : regBattery === null ? (
                          <button
                            type="button"
                            className="scan-btn-primary"
                            disabled={busy || !connected}
                            onClick={() => {
                              setError('');
                              setRegScanningBattery(true);
                            }}
                          >
                            ⚡ Battery Scan
                          </button>
                        ) : (
                          /* Scanned battery display */
                          <div className="scanned-value-box">
                            <div>
                              <div className="scanned-label">Detected Battery Level</div>
                              <div className="scanned-text">{regBattery}%</div>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                              onClick={() => {
                                setRegBattery(null);
                                setError('');
                                setRegScanningBattery(true);
                              }}
                            >
                              Rescan Battery
                            </button>
                          </div>
                        )}
                      </div>

                      {/* --- CONFIRM & SAVE CARD (Visible once both are scanned) --- */}
                      {regSerial && regBattery !== null && (
                        <div className="confirm-registration-card">
                          <span className="eyebrow" style={{ color: '#27521c' }}>READY TO REGISTER</span>
                          <h3 style={{ margin: '6px 0 14px' }}>Confirm Device Details</h3>
                          <div className="reading-grid" style={{ marginBottom: 20 }}>
                            <div>
                              <small>Serial Number</small>
                              <strong>{regSerial}</strong>
                            </div>
                            <div>
                              <small>Initial Battery</small>
                              <strong>{regBattery}%</strong>
                            </div>
                          </div>
                          <p style={{ margin: '0 0 18px', fontSize: 14 }}>
                            Status will be set to:{' '}
                            <strong>{regBattery === 100 ? 'READY FOR AGING (100%)' : 'WAITING FOR 100% CHARGE'}</strong>.
                          </p>
                          <div className="actions">
                            <button
                              type="button"
                              style={{ minHeight: 52, fontSize: 16, flex: 2 }}
                              disabled={busy || !connected}
                              onClick={() => void confirmRegistration()}
                            >
                              {busy ? 'Saving to Excel…' : '✓ Confirm & Register Device'}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={resetRegistration}
                            >
                              Clear & Restart
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* ===================== STAGE 02: AGING TEST (02) ===================== */}
            {page === 1 && (
              <div className="workspace" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <section className="work-panel">
                  <div className="panel-heading">
                    <span className="eyebrow">STEP 02</span>
                    <h2>Aging Test</h2>
                    <p>5-Button Workflow: Scan device serial QR, record H1–H4 checkpoints, and confirm to Excel.</p>
                  </div>

                  {/* Hidden QR file input for device lookup */}
                  <input
                    ref={lookupQRInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => void scanLookupQR(e)}
                  />

                  {/* 5-Button Control Bar */}
                  <div className="stage2-nav-bar">
                    {/* Button 1: QR Scan for Serial */}
                    <button
                      type="button"
                      className="stage2-nav-btn btn-qr"
                      disabled={busy}
                      onClick={() => handleStage2NavClick('qr')}
                    >
                      <span className="btn-title">▣ Scan Serial QR</span>
                      <span className="btn-subtext">
                        {device ? device.serial_number : 'Detect device'}
                      </span>
                    </button>

                    {/* Buttons 2-5: H1, H2, H3, H4 */}
                    {[1, 2, 3, 4].map((n) => {
                      const isSaved = device && device.values[2 * n + 1] !== null;
                      const savedVal = isSaved ? device.values[2 * n + 1] : null;
                      const currentCp = device
                        ? ((device.status === 'READY_FOR_AGING' || device.status === 'WAITING_FOR_100_PERCENT_CHARGE') ? 1 : device.next_checkpoint)
                        : 0;
                      const isCurrent = device && n === currentCp && !isSaved;
                      const isLocked = !device || n > currentCp;
                      const remMs = device?.next_due ? Math.max(0, new Date(device.next_due).getTime() - currentTime) : 0;
                      const isDue = !device?.next_due || remMs <= 0;

                      let btnClass = 'stage2-nav-btn';
                      if (isSaved) btnClass += ' btn-saved';
                      else if (isCurrent && isDue) btnClass += ' btn-ready';
                      else if (isCurrent && !isDue) btnClass += ' btn-waiting';
                      else if (isLocked) btnClass += ' btn-locked';

                      return (
                        <button
                          key={n}
                          type="button"
                          className={btnClass}
                          disabled={busy || isLocked}
                          onClick={() => handleStage2NavClick(n as 1 | 2 | 3 | 4)}
                        >
                          <span className="btn-title">H{n}</span>
                          <span className="btn-subtext">
                            {isSaved
                              ? `✓ ${savedVal}%`
                              : isCurrent && isDue
                              ? '⚡ Ready'
                              : isCurrent
                              ? `⏳ ${formatRemaining(remMs)}`
                              : 'Pending'}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Scanner modal for checkpoint reading */}
                  {scanning ? (
                    <Scanner
                      action={scanning}
                      target={device?.serial_number}
                      regex={regex}
                      mode="battery-only"
                      onResult={onCheckpointReceived}
                      onCancel={() => setScanning(null)}
                    />
                  ) : reading ? (
                    /* Review screen before confirming and saving to Excel */
                    <div className="review">
                      <span className="eyebrow" style={{ color: '#27521c' }}>CONFIRM {action.toUpperCase()} READING</span>
                      <h3 style={{ margin: '6px 0 16px' }}>{device?.serial_number || reading.serial_number}</h3>
                      
                      <div className="reading-grid">
                        <div>
                          <small>Detected Battery Level</small>
                          <strong style={{ color: '#27521c' }}>{reading.battery_percent}%</strong>
                        </div>
                        <div>
                          <small>Device Clock Time</small>
                          <strong>{reading.device_timestamp || 'Unavailable'}</strong>
                        </div>
                      </div>

                      {/* Display previous checkpoints so operator can compare */}
                      {action.startsWith('h') && (
                        <div style={{ marginTop: 16, background: '#ffffff', border: '1px solid #dbe5d6', borderRadius: 8, padding: '12px 16px' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#687765', textTransform: 'uppercase', marginBottom: 8 }}>
                            Checkpoint History for this Device:
                          </div>
                          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                            {[1, 2, 3, 4].map((n) => {
                              const val = device?.values[2 * n + 1];
                              const time = device?.values[2 * n + 2];
                              return (
                                <div key={n} style={{ fontSize: 13 }}>
                                  <strong>H{n}:</strong>{' '}
                                  {val !== null && val !== undefined ? (
                                    <span style={{ color: '#2b5220', fontWeight: 650 }}>{val}% {time ? `(${time})` : ''}</span>
                                  ) : action === `h${n}` ? (
                                    <span style={{ color: '#005bb5', fontWeight: 650 }}>→ {reading.battery_percent}% (Saving now)</span>
                                  ) : (
                                    <span style={{ color: '#889886' }}>Pending</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <p style={{ margin: '16px 0 20px', fontSize: 14 }}>
                        Compare these values with the device screen. Click confirm to store directly in Excel.
                      </p>

                      <div className="actions">
                        <button
                          type="button"
                          style={{ flex: 2, minHeight: 52, fontSize: 16 }}
                          disabled={busy || !connected}
                          onClick={() => void confirmCheckpoint()}
                        >
                          {busy ? 'Saving to Excel…' : `✓ Confirm & Save ${action.toUpperCase()} to Excel`}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => openCheckpointScan(action)}
                        >
                          ↺ Retry Capture
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => setReading(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Main Stage 2 Workspace content */
                    <>
                      {/* Step A: No device selected yet */}
                      {!device ? (
                        <div>
                          {lookupPhase === 'loading' && <p role="status" className="scan-status">Decoding QR code…</p>}
                          {lookupPhase === 'scan' && (
                            <div className="scan-start">
                              <div className="scan-icon" aria-hidden="true">▣</div>
                              <h3>Scan Device Serial QR Code</h3>
                              <p>Point the camera at the device QR label to load its record and checkpoints.</p>
                              <button
                                type="button"
                                disabled={busy || !connected || !regex}
                                onClick={() => lookupQRInputRef.current?.click()}
                              >
                                ▣ Scan QR to Find Device
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                style={{ marginTop: 10, width: '100%' }}
                                onClick={() => { setLookupPhase('manual'); setError(''); }}
                              >
                                Enter serial manually instead
                              </button>
                            </div>
                          )}
                          {lookupPhase === 'manual' && (
                            <form
                              className="lookup"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void findBySerial(serial);
                              }}
                            >
                              <label htmlFor="lookup-serial">Registered Serial Number</label>
                              <div>
                                <input
                                  id="lookup-serial"
                                  value={serial}
                                  onChange={(e) => {
                                    setSerial(e.target.value);
                                    setDevice(null);
                                  }}
                                  placeholder="Enter device serial"
                                  maxLength={64}
                                  required
                                  autoCapitalize="characters"
                                />
                                <button type="submit" disabled={busy || !connected}>Find Device</button>
                              </div>
                              <button
                                type="button"
                                className="text-button"
                                style={{ marginTop: 8 }}
                                onClick={() => { setLookupPhase('scan'); setError(''); }}
                              >
                                ← Back to QR camera scan
                              </button>
                            </form>
                          )}
                        </div>
                      ) : (
                        /* Step B: Device selected -> Show banner and H1-H4 checkpoint cards */
                        <div>
                          {/* Device Record Banner */}
                          <div className="stage2-device-banner">
                            <div className="stage2-device-info">
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#637361', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                Active Device Record
                              </div>
                              <h3 className="stage2-serial-title">{device.serial_number}</h3>
                              <div className="stage2-meta-row">
                                <span className="stage2-meta-tag">{label(device.status)}</span>
                                <span style={{ fontSize: 13, color: '#576755' }}>
                                  Reg Battery: <strong>{device.values[2]}%</strong>
                                </span>
                                <span style={{ fontSize: 13, color: '#576755' }}>
                                  Last Reading: <strong>{device.last_battery}%</strong>
                                </span>
                              </div>
                            </div>

                            <div className="stage2-device-actions">
                              <button
                                type="button"
                                className="secondary"
                                style={{ padding: '8px 14px', fontSize: 13 }}
                                onClick={resetStage2Device}
                              >
                                ＋ Scan Next Device
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                style={{ color: '#b3261e', padding: '8px 12px', fontSize: 13 }}
                                disabled={busy}
                                onClick={() => void deleteDeviceRecord()}
                              >
                                🗑 Delete
                              </button>
                            </div>
                          </div>

                          {/* When Aging Test is complete, ask operator to move to next stage (Stage 03) */}
                          {device && (device.status === 'AGING_TEST_COMPLETE' || (device.values[3] !== null && device.values[5] !== null && device.values[7] !== null && device.values[9] !== null)) && (
                            <div className="stage2-complete-card">
                              <div className="stage2-complete-icon">✓</div>
                              <span className="eyebrow" style={{ color: '#27521c', fontWeight: 800 }}>STAGE 02 COMPLETE</span>
                              <h3 style={{ margin: '6px 0 10px', fontSize: '22px', color: '#163a23' }}>
                                Aging Test is Complete for {device.serial_number}!
                              </h3>
                              <p style={{ margin: '0 0 20px', color: '#445643', fontSize: '15px' }}>
                                All 4 hourly checkpoints (H1–H4) are recorded in Excel. Proceed to <strong>Post Test (Stage 03)</strong> for final packing validation, or scan another device.
                              </p>
                              <div className="actions" style={{ justifyContent: 'center', gap: '14px' }}>
                                <button
                                  type="button"
                                  style={{ minHeight: '50px', fontSize: '16px', padding: '12px 28px', background: '#183e2f' }}
                                  onClick={() => {
                                    setPostSerial(device.serial_number);
                                    setPostBattery(null);
                                    setPostToken('');
                                    setPostConfirmed(null);
                                    setPostManual(false);
                                    setPostScanningQR(false);
                                    setPostScanningBattery(false);
                                    setError('');
                                    setMessage('');
                                    setPage(2);
                                  }}
                                >
                                  Proceed to Post Test (03) →
                                </button>
                                <button
                                  type="button"
                                  className="secondary"
                                  style={{ minHeight: '50px', fontSize: '15px', padding: '12px 20px' }}
                                  onClick={resetStage2Device}
                                >
                                  ＋ Scan Next Device for Aging
                                </button>
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ minHeight: '50px', fontSize: '14px' }}
                                  onClick={() => navigate(null)}
                                >
                                  ← Back to Stages
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Checkpoints Grid: H1, H2, H3, H4 */}
                          <div className="stage2-checkpoints-grid">
                            {[1, 2, 3, 4].map((n) => {
                              const isSaved = device.values[2 * n + 1] !== null;
                              const savedVal = isSaved ? device.values[2 * n + 1] : null;
                              const savedTime = isSaved ? device.values[2 * n + 2] : null;
                              const currentCp = (device.status === 'READY_FOR_AGING' || device.status === 'WAITING_FOR_100_PERCENT_CHARGE')
                                ? 1
                                : device.next_checkpoint;
                              const isCurrent = n === currentCp && !isSaved;
                              const isLocked = n > currentCp;
                              const remMs = device.next_due ? Math.max(0, new Date(device.next_due).getTime() - currentTime) : 0;
                              const isDue = !device.next_due || remMs <= 0;

                              let cardClass = 'stage2-cp-card';
                              if (isSaved) cardClass += ' cp-saved';
                              else if (isCurrent && isDue) cardClass += ' cp-ready';
                              else if (isCurrent && !isDue) cardClass += ' cp-waiting';
                              else if (isLocked) cardClass += ' cp-locked';

                              return (
                                <div key={n} className={cardClass}>
                                  <div>
                                    <div className="stage2-cp-header">
                                      <span className="stage2-cp-name">H{n} Checkpoint</span>
                                      <span className={`step-badge ${isSaved ? 'done' : isCurrent && isDue ? 'active' : 'pending'}`}>
                                        {isSaved ? '✓ SAVED' : isCurrent && isDue ? '⚡ READY' : isCurrent ? '⏳ DUE SOON' : '🔒 LOCKED'}
                                      </span>
                                    </div>

                                    {isSaved ? (
                                      <>
                                        <div className="stage2-cp-value" style={{ color: '#254e1d' }}>{savedVal}%</div>
                                        <div className="stage2-cp-time">Saved at {savedTime || 'Recorded'}</div>
                                        <p style={{ margin: 0, fontSize: 13, color: '#385e30' }}>Row updated in Excel</p>
                                      </>
                                    ) : isCurrent ? (
                                      <>
                                        {isDue ? (
                                          <>
                                            <div className="stage2-cp-value" style={{ color: '#183e2f' }}>Ready</div>
                                            <div className="stage2-cp-time">Interval complete. Ready to scan.</div>
                                          </>
                                        ) : (
                                          <>
                                            <div className="stage2-cp-value" style={{ color: '#596956', fontSize: 24 }}>
                                              {formatRemaining(remMs)}
                                            </div>
                                            <div className="stage2-cp-time">
                                              Due at {device.next_due ? new Date(device.next_due).toLocaleTimeString() : '—'}
                                            </div>
                                          </>
                                        )}
                                      </>
                                    ) : (
                                      <>
                                        <div className="stage2-cp-value" style={{ color: '#97a395' }}>—</div>
                                        <div className="stage2-cp-time">Awaiting H{n - 1} completion</div>
                                      </>
                                    )}
                                  </div>

                                  {isCurrent && (
                                    <button
                                      type="button"
                                      className="stage2-cp-btn"
                                      disabled={!isDue || busy || !connected}
                                      onClick={() => openCheckpointScan(`h${n}` as Action)}
                                    >
                                      {isDue ? `⚡ Scan H${n} Battery` : `⏳ Due in ${formatRemaining(remMs)}`}
                                    </button>
                                  )}

                                  {n === 4 && isSaved && (
                                    <button
                                      type="button"
                                      className="stage2-cp-btn"
                                      style={{ background: '#183e2f', color: '#ffffff', marginTop: 12 }}
                                      onClick={() => {
                                        setPostSerial(device.serial_number);
                                        setPostBattery(null);
                                        setPostToken('');
                                        setPostConfirmed(null);
                                        setPostManual(false);
                                        setPostScanningQR(false);
                                        setPostScanningBattery(false);
                                        setError('');
                                        setMessage('');
                                        setPage(2);
                                      }}
                                    >
                                      Move to Post Test (03) →
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}

            {/* ===================== STAGE 03: POST TEST (03) ===================== */}
            {page === 2 && (
              <div className="workspace" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <section className="work-panel">
                  <div className="panel-heading">
                    <span className="eyebrow">STEP 03</span>
                    <h2>Post Test (Packing)</h2>
                    <p>Scan device QR and capture post-aging battery reading (70–100%) to mark it Packing Ready in Excel.</p>
                  </div>

                  {/* Hidden QR file input for camera scan */}
                  <input
                    ref={postQRInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => void onScanPostQR(e)}
                  />

                  {/* Scanner modal for Step 2 battery */}
                  {postScanningBattery ? (
                    <Scanner
                      action="post-aging"
                      target={postSerial}
                      regex={regex}
                      mode="battery-only"
                      onResult={onPostBatteryReceived}
                      onCancel={() => setPostScanningBattery(false)}
                    />
                  ) : postConfirmed ? (
                    /* Success Confirmation State */
                    <div className="registration-success-card">
                      <div className="success-icon">✓</div>
                      <span className="eyebrow" style={{ color: '#27521c' }}>POST TEST COMPLETE</span>
                      <h3 style={{ margin: '8px 0 12px' }}>Device is Packing Ready!</h3>
                      <p style={{ margin: '0 0 16px', color: '#4d594b' }}>
                        Device <strong>{postConfirmed.serial_number}</strong> has been updated in Excel with status <strong>PACKING_READY</strong>.
                      </p>
                      <div className="scanned-value-box" style={{ maxWidth: 420, margin: '0 auto 24px', justifyContent: 'space-around' }}>
                        <div style={{ textAlign: 'left' }}>
                          <div className="scanned-label">Serial Number</div>
                          <div className="scanned-text">{postConfirmed.serial_number}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="scanned-label">Final Battery</div>
                          <div className="scanned-text" style={{ color: '#27521c' }}>{postBattery}%</div>
                        </div>
                      </div>

                      <div className="actions" style={{ justifyContent: 'center' }}>
                        <button onClick={resetPostStage}>+ Check Another Device</button>
                        <button className="secondary" onClick={() => navigate(null)}>
                          ← Back to Stages
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* The 2-step cards: Button 1 (QR scan) + Button 2 (Battery scan) */
                    <div className="reg-container">
                      {/* --- CARD 1: SERIAL NUMBER QR SCAN --- */}
                      <div className={`scan-step-card ${postSerial ? 'completed' : 'active'}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className={`step-badge ${postSerial ? 'done' : 'active'}`}>
                            {postSerial ? '✓ STEP 1 COMPLETED' : 'STEP 1 OF 2'}
                          </span>
                        </div>

                        <h3 style={{ margin: '6px 0 8px' }}>1. Serial Num QR Scan</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Point the camera at the device QR code label to detect the serial number.
                        </p>

                        {!postSerial ? (
                          <>
                            {postScanningQR ? (
                              <p className="scan-status" role="status">Decoding QR photo…</p>
                            ) : postManual ? (
                              <form
                                className="lookup"
                                style={{ marginTop: 10 }}
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (!postManualInput.trim()) return;
                                  try {
                                    const val = parseQRSerial(postManualInput.trim(), regex);
                                    setPostSerial(val);
                                    setPostManual(false);
                                    setError('');
                                  } catch (ex) {
                                    setError(ex instanceof Error ? ex.message : 'Invalid serial format');
                                  }
                                }}
                              >
                                <label htmlFor="manual-serial-post">Enter Serial Number</label>
                                <div>
                                  <input
                                    id="manual-serial-post"
                                    value={postManualInput}
                                    onChange={(e) => setPostManualInput(e.target.value)}
                                    placeholder="Enter device serial"
                                    autoCapitalize="characters"
                                    required
                                  />
                                  <button type="submit" disabled={busy}>Use Serial</button>
                                </div>
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ marginTop: 8 }}
                                  onClick={() => setPostManual(false)}
                                >
                                  ← Back to camera QR scan
                                </button>
                              </form>
                            ) : (
                              <div>
                                <button
                                  type="button"
                                  className="scan-btn-primary"
                                  disabled={busy || !connected}
                                  onClick={() => postQRInputRef.current?.click()}
                                >
                                  ▣ Serial Num QR Scan
                                </button>
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ marginTop: 10, width: '100%' }}
                                  onClick={() => { setPostManual(true); setError(''); }}
                                >
                                  Enter serial manually instead
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          /* Scanned serial display */
                          <div className="scanned-value-box">
                            <div>
                              <div className="scanned-label">Detected Serial Number</div>
                              <div className="scanned-text">{postSerial}</div>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                              onClick={() => {
                                setPostSerial('');
                                setPostBattery(null);
                                setError('');
                              }}
                            >
                              Rescan QR
                            </button>
                          </div>
                        )}
                      </div>

                      {/* --- CARD 2: BATTERY PERCENTAGE SCAN --- */}
                      <div className={`scan-step-card ${!postSerial ? '' : postBattery !== null ? 'completed' : 'active'}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className={`step-badge ${!postSerial ? 'pending' : postBattery !== null ? 'done' : 'active'}`}>
                            {postBattery !== null ? '✓ STEP 2 COMPLETED' : 'STEP 2 OF 2'}
                          </span>
                        </div>

                        <h3 style={{ margin: '6px 0 8px' }}>2. Battery Scan (Packing)</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Capture a close-up showing the post-aging battery level (must be 70–100%).
                        </p>

                        {!postSerial ? (
                          <p style={{ color: '#748270', fontStyle: 'italic', margin: '10px 0' }}>
                            Scan the Serial QR code in Step 1 first to enable battery scanning.
                          </p>
                        ) : postBattery === null ? (
                          <button
                            type="button"
                            className="scan-btn-primary"
                            disabled={busy || !connected}
                            onClick={() => {
                              setError('');
                              setPostScanningBattery(true);
                            }}
                          >
                            ⚡ Battery Scan (Packing)
                          </button>
                        ) : (
                          /* Scanned battery display */
                          <div className="scanned-value-box">
                            <div>
                              <div className="scanned-label">Detected Battery Level</div>
                              <div className="scanned-text">{postBattery}%</div>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                              onClick={() => {
                                setPostBattery(null);
                                setError('');
                                setPostScanningBattery(true);
                              }}
                            >
                              Rescan Battery
                            </button>
                          </div>
                        )}
                      </div>

                      {/* --- CONFIRM & SAVE CARD (Visible once both are scanned) --- */}
                      {postSerial && postBattery !== null && (
                        <div className="confirm-registration-card">
                          <span className="eyebrow" style={{ color: '#27521c' }}>READY TO PACK</span>
                          <h3 style={{ margin: '6px 0 14px' }}>Confirm Post-Aging Battery</h3>
                          <div className="reading-grid" style={{ marginBottom: 20 }}>
                            <div>
                              <small>Serial Number</small>
                              <strong>{postSerial}</strong>
                            </div>
                            <div>
                              <small>Post-Aging Battery</small>
                              <strong>{postBattery}%</strong>
                            </div>
                          </div>
                          <p style={{ margin: '0 0 18px', fontSize: 14 }}>
                            {postBattery >= 70 ? (
                              <span style={{ color: '#183e2f' }}>
                                ✓ Battery level is within packing range (70–100%). Device will be marked <strong>PACKING READY</strong>.
                              </span>
                            ) : (
                              <span style={{ color: '#b91c1c' }}>
                                ⚠ Battery level is {postBattery}% (below 70%). Device needs further charging before packing.
                              </span>
                            )}
                          </p>
                          <div className="actions">
                            <button
                              type="button"
                              style={{ minHeight: 52, fontSize: 16, flex: 2 }}
                              disabled={busy || !connected || postBattery < 70}
                              onClick={() => void confirmPostAging()}
                            >
                              {busy ? 'Saving to Excel…' : '✓ Confirm & Save to Excel'}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={resetPostStage}
                            >
                              Clear & Restart
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
            )}
          </>
        )}

        <footer>
          TOHANDS · PRODUCTION OPERATIONS <span>Local processing · Excel records</span>
        </footer>
      </main>
    </div>
  );
}
