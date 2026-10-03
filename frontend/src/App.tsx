import { useEffect, useRef, useState } from 'react';
import { api, submit, ApiError } from './api';
import { Scanner } from './Scanner';
import { parseQRSerial } from './qr';
import { detectBatteryPercentage, warmClientWorker } from './batteryOCR';
import type { Action, Device, Reading, IssueCategory, PowerTestResult } from './types';

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
  const [reading, setReading] = useState<Reading | null>(null);
  const [action, setAction] = useState<Action>('register');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // Lookup state for steps 02 & 03
  const [lookupPhase, setLookupPhase] = useState<'scan' | 'manual' | 'loading'>('scan');
  const [serial, setSerial] = useState('');
  const [lookupScanningQR, setLookupScanningQR] = useState(false);

  // Dedicated 2-step states for Step 01 (Device Registration)
  const [regSerial, setRegSerial] = useState('');
  const [regBattery, setRegBattery] = useState<number | null>(null);
  const [regToken, setRegToken] = useState('');
  const [regScanningQR, setRegScanningQR] = useState(false);
  const [regBatteryProcessing, setRegBatteryProcessing] = useState(false);
  const [regBatteryError, setRegBatteryError] = useState<string | null>(null);
  const [regRegistered, setRegRegistered] = useState<Device | null>(null);
  const [regManual, setRegManual] = useState(false);
  const [regManualInput, setRegManualInput] = useState('');
  const [regBatteryManual, setRegBatteryManual] = useState(false);
  const [regBatteryManualInput, setRegBatteryManualInput] = useState('');

  // Stage 02 (Aging Test) battery photo capture state
  const [cpAction, setCpAction] = useState<Action>('h1');
  const [cpBatteryProcessing, setCpBatteryProcessing] = useState(false);
  const [cpBatteryError, setCpBatteryError] = useState<string | null>(null);
  const [cpBatteryManual, setCpBatteryManual] = useState(false);
  const [cpBatteryManualInput, setCpBatteryManualInput] = useState('');

  // Stage 02 (Aging Test) issue observation state for review screen
  const [cpHasIssue, setCpHasIssue] = useState<'yes' | 'no' | null>(null);
  const [cpCategories, setCpCategories] = useState<{ display: boolean; crashing: boolean; other: boolean }>({
    display: false,
    crashing: false,
    other: false,
  });
  const [cpRemarks, setCpRemarks] = useState('');

  // Dedicated 2-step states for Step 03 (Post Test / Packing)
  const [postSerial, setPostSerial] = useState('');
  const [postBattery, setPostBattery] = useState<number | null>(null);
  const [postToken, setPostToken] = useState('');
  const [postScanningQR, setPostScanningQR] = useState(false);
  const [postBatteryProcessing, setPostBatteryProcessing] = useState(false);
  const [postBatteryError, setPostBatteryError] = useState<string | null>(null);
  const [postBatteryManual, setPostBatteryManual] = useState(false);
  const [postBatteryManualInput, setPostBatteryManualInput] = useState('');
  const [postConfirmed, setPostConfirmed] = useState<Device | null>(null);
  const [postManual, setPostManual] = useState(false);
  const [postManualInput, setPostManualInput] = useState('');

  // Dedicated Stage 03 observation and long-press power test states
  const [postHasIssue, setPostHasIssue] = useState<'yes' | 'no' | null>(null);
  const [postCategories, setPostCategories] = useState<{ display: boolean; crashing: boolean; other: boolean }>({
    display: false,
    crashing: false,
    other: false,
  });
  const [postRemarks, setPostRemarks] = useState('');
  const [postPowerTest, setPostPowerTest] = useState<PowerTestResult | null>(null);

  // Hidden file input refs for rear-camera photo capture
  const regBatteryInputRef = useRef<HTMLInputElement>(null);
  const cpBatteryInputRef = useRef<HTMLInputElement>(null);
  const postBatteryInputRef = useRef<HTMLInputElement>(null);
  const ocrAbortCtrlRef = useRef<AbortController | null>(null);

  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    // Pre-warm client Tesseract WebAssembly worker in the background for instant scans
    void warmClientWorker();
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    let failCount = 0;
    let timer: ReturnType<typeof setTimeout>;

    const check = async () => {
      try {
        await api('/health');
        if (!regex) {
          const config = await api<{ serial_regex: string }>('/config');
          if (live) setRegex(config.serial_regex);
        }
        if (live) {
          failCount = 0;
          setConnected(true);
        }
      } catch {
        if (live) {
          failCount++;
          // Only show 'Server not connected' if 2 consecutive heartbeats fail.
          // This prevents transient Wi-Fi packet drops from flashing 'Server not connected'.
          if (failCount >= 2) {
            setConnected(false);
          }
        }
      } finally {
        if (live) {
          // If in failure state, retry quickly (2.5s) to recover immediately.
          // When healthy, ping every 6s.
          const delay = failCount > 0 ? 2500 : 6000;
          timer = setTimeout(() => { void check(); }, delay);
        }
      }
    };

    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [regex]);

  // Poll active device to immediately reflect deletions or edits made directly in Excel
  useEffect(() => {
    if (!device) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const verifyDevice = async () => {
      try {
        const latest = await api<Device>(`/devices/${encodeURIComponent(device.serial_number)}`);
        if (live && JSON.stringify(latest) !== JSON.stringify(device)) {
          setDevice(latest);
        }
      } catch (err) {
        // ONLY clear device if the server explicitly confirmed it was deleted (HTTP 404).
        // Temporary Wi-Fi packet drops (status 0 or 503) must NOT kick the operator out!
        if (live && err instanceof ApiError && err.status === 404) {
          setDevice(null);
          setReading(null);
          setMessage(`Device ${device.serial_number} was deleted or removed from Excel.`);
        }
      } finally {
        if (live) {
          timer = setTimeout(() => { void verifyDevice(); }, 6000);
        }
      }
    };

    timer = setTimeout(() => { void verifyDevice(); }, 6000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
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

  // Cleanup in-flight OCR on unmount
  useEffect(() => {
    return () => {
      ocrAbortCtrlRef.current?.abort();
    };
  }, []);

  const resetRegistration = () => {
    if (ocrAbortCtrlRef.current) {
      ocrAbortCtrlRef.current.abort();
      ocrAbortCtrlRef.current = null;
    }
    setRegSerial('');
    setRegBattery(null);
    setRegToken('');
    setRegRegistered(null);
    setRegManual(false);
    setRegManualInput('');
    setRegBatteryManual(false);
    setRegBatteryManualInput('');
    setRegScanningQR(false);
    setRegBatteryProcessing(false);
    setRegBatteryError(null);
    setError('');
    setMessage('');
  };

  const resetPostStage = () => {
    if (ocrAbortCtrlRef.current) {
      ocrAbortCtrlRef.current.abort();
      ocrAbortCtrlRef.current = null;
    }
    setPostSerial('');
    setPostBattery(null);
    setPostToken('');
    setPostConfirmed(null);
    setPostManual(false);
    setPostManualInput('');
    setPostBatteryManual(false);
    setPostBatteryManualInput('');
    setPostScanningQR(false);
    setPostBatteryProcessing(false);
    setPostBatteryError(null);
    setPostHasIssue(null);
    setPostCategories({ display: false, crashing: false, other: false });
    setPostRemarks('');
    setPostPowerTest(null);
    setError('');
    setMessage('');
  };

  const resetStage2Device = () => {
    if (ocrAbortCtrlRef.current) {
      ocrAbortCtrlRef.current.abort();
      ocrAbortCtrlRef.current = null;
    }
    setDevice(null);
    setReading(null);
    setCpBatteryProcessing(false);
    setCpBatteryError(null);
    setCpBatteryManual(false);
    setCpBatteryManualInput('');
    setLookupScanningQR(false);
    setSerial('');
    setLookupPhase('scan');
    setCpHasIssue(null);
    setCpCategories({ display: false, crashing: false, other: false });
    setCpRemarks('');
    setError('');
    setMessage('');
  };

  const handleManualBatterySubmit = async (stage: 'reg' | 'cp' | 'post', valStr: string) => {
    const pct = parseInt(valStr.trim(), 10);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      setError('Please enter a valid battery percentage between 0 and 100.');
      return;
    }
    if (stage === 'post' && pct < 70) {
      setError('Post-aging packing battery must be at least 70%.');
      return;
    }
    try {
      const capData = await api<{ capture_token: string }>('/captures', {
        action: stage === 'reg' ? 'register' : stage === 'post' ? 'post-aging' : cpAction,
        serial_number: (stage === 'reg' ? regSerial : stage === 'post' ? postSerial : device?.serial_number) || undefined,
      });
      const token = capData.capture_token;

      if (stage === 'reg') {
        setRegBattery(pct);
        setRegToken(token);
        setRegBatteryError(null);
        setRegBatteryManual(false);
        setRegBatteryManualInput('');
      } else if (stage === 'cp') {
        setReading({
          serial_number: device?.serial_number || '',
          battery_percent: pct,
          device_timestamp: null,
          capture_token: token,
        });
        setAction(cpAction);
        setCpHasIssue(null);
        setCpCategories({ display: false, crashing: false, other: false });
        setCpRemarks('');
        setCpBatteryError(null);
        setCpBatteryManual(false);
        setCpBatteryManualInput('');
      } else if (stage === 'post') {
        setPostBattery(pct);
        setPostToken(token);
        setPostHasIssue(null);
        setPostCategories({ display: false, crashing: false, other: false });
        setPostRemarks('');
        setPostPowerTest(null);
        setPostBatteryError(null);
        setPostBatteryManual(false);
        setPostBatteryManualInput('');
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set manual battery percentage.');
    }
  };

  const navigate = (index: number | null) => {
    if (busy) return;
    if (ocrAbortCtrlRef.current) {
      ocrAbortCtrlRef.current.abort();
      ocrAbortCtrlRef.current = null;
    }
    setPage(index);
    setReading(null);
    setError('');
    setMessage('');
    setDevice(null);
    setLookupPhase('scan');
    resetRegistration();
    resetPostStage();
    setCpBatteryProcessing(false);
    setCpBatteryError(null);
    setCpHasIssue(null);
    setCpCategories({ display: false, crashing: false, other: false });
    setCpRemarks('');
  };

  // Synchronous triggers to preserve browser user activation
  const triggerRegBatteryScan = () => {
    setRegBatteryError(null);
    setError('');
    setMessage('');
    if (regBatteryInputRef.current) {
      regBatteryInputRef.current.value = '';
      regBatteryInputRef.current.click();
    }
  };

  const triggerCpBatteryScan = (targetAction: Action) => {
    setCpAction(targetAction);
    setCpBatteryError(null);
    setError('');
    setMessage('');
    if (cpBatteryInputRef.current) {
      cpBatteryInputRef.current.value = '';
      cpBatteryInputRef.current.click();
    }
  };

  const triggerPostBatteryScan = () => {
    setPostBatteryError(null);
    setError('');
    setMessage('');
    if (postBatteryInputRef.current) {
      postBatteryInputRef.current.value = '';
      postBatteryInputRef.current.click();
    }
  };

  // Automatic OCR handler triggered immediately upon photo selection
  const handleBatteryPhotoSelect = async (
    e: React.ChangeEvent<HTMLInputElement>,
    stage: 'reg' | 'cp' | 'post',
    batteryAction: Action,
    targetSerial?: string
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      // User cancelled camera; return without changing any data
      return;
    }

    // Cancel obsolete OCR requests
    if (ocrAbortCtrlRef.current) {
      ocrAbortCtrlRef.current.abort();
    }
    const ctrl = new AbortController();
    ocrAbortCtrlRef.current = ctrl;

    if (stage === 'reg') {
      setRegBatteryProcessing(true);
      setRegBatteryError(null);
    } else if (stage === 'cp') {
      setCpBatteryProcessing(true);
      setCpBatteryError(null);
    } else if (stage === 'post') {
      setPostBatteryProcessing(true);
      setPostBatteryError(null);
    }
    setError('');
    setMessage('');

    try {
      const ocrPromise = detectBatteryPercentage(file, undefined, undefined, ctrl.signal);
      const tokenPromise = api<{ capture_token: string }>(
        '/captures',
        { action: batteryAction, serial_number: targetSerial || undefined },
        ctrl.signal
      );

      const [ocrResult, captureData] = await Promise.all([ocrPromise, tokenPromise]);

      if (ctrl.signal.aborted) {
        return; // Ignore late/obsolete result
      }

      if (!ocrResult.success || ocrResult.batteryPercent === undefined) {
        const errMsg = ocrResult.error || 'Could not detect battery percentage. Please retake photo.';
        if (stage === 'reg') {
          setRegBattery(null);
          setRegBatteryError(errMsg);
        } else if (stage === 'cp') {
          setCpBatteryError(errMsg);
        } else if (stage === 'post') {
          setPostBattery(null);
          setPostBatteryError(errMsg);
        }
        return;
      }

      const pct = ocrResult.batteryPercent;
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
        const errMsg = `Invalid percentage detected (${pct}%). Must be 0–100%.`;
        if (stage === 'reg') {
          setRegBattery(null);
          setRegBatteryError(errMsg);
        } else if (stage === 'cp') {
          setCpBatteryError(errMsg);
        } else if (stage === 'post') {
          setPostBattery(null);
          setPostBatteryError(errMsg);
        }
        return;
      }

      const token = captureData.capture_token;

      if (stage === 'reg') {
        setRegBattery(pct);
        setRegToken(token);
        setRegBatteryError(null);
      } else if (stage === 'cp') {
        setReading({
          serial_number: targetSerial || device?.serial_number || '',
          battery_percent: pct,
          device_timestamp: null,
          capture_token: token
        });
        setAction(batteryAction);
        setCpHasIssue(null);
        setCpCategories({ display: false, crashing: false, other: false });
        setCpRemarks('');
        setCpBatteryError(null);
      } else if (stage === 'post') {
        setPostBattery(pct);
        setPostToken(token);
        setPostHasIssue(null);
        setPostCategories({ display: false, crashing: false, other: false });
        setPostRemarks('');
        setPostPowerTest(null);
        setPostBatteryError(null);
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const errMsg = err instanceof Error ? err.message : 'Battery scanning failed. Please retake photo.';
      if (stage === 'reg') {
        setRegBattery(null);
        setRegBatteryError(errMsg);
      } else if (stage === 'cp') {
        setCpBatteryError(errMsg);
      } else if (stage === 'post') {
        setPostBattery(null);
        setPostBatteryError(errMsg);
      }
    } finally {
      if (!ctrl.signal.aborted) {
        if (stage === 'reg') setRegBatteryProcessing(false);
        else if (stage === 'cp') setCpBatteryProcessing(false);
        else if (stage === 'post') setPostBatteryProcessing(false);
      }
    }
  };

  // Helper validation functions for observations
  const getCpCategoryList = (): IssueCategory[] => {
    if (cpHasIssue !== 'yes') return [];
    const list: IssueCategory[] = [];
    if (cpCategories.display) list.push('Display issue');
    if (cpCategories.crashing) list.push('Crashing / hanging issue');
    if (cpCategories.other) list.push('Other issue');
    return list;
  };

  const isCpObservationValid =
    cpHasIssue === 'no' ||
    (cpHasIssue === 'yes' && (cpCategories.display || cpCategories.crashing || cpCategories.other));

  const getPostCategoryList = (): IssueCategory[] => {
    if (postHasIssue !== 'yes') return [];
    const list: IssueCategory[] = [];
    if (postCategories.display) list.push('Display issue');
    if (postCategories.crashing) list.push('Crashing / hanging issue');
    if (postCategories.other) list.push('Other issue');
    return list;
  };

  const isPostObservationValid =
    postHasIssue === 'no' ||
    (postHasIssue === 'yes' && (postCategories.display || postCategories.crashing || postCategories.other));

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

  // Step 03: Confirm & Save Post-Aging Packing in Excel
  const confirmPostAging = () => perform(async () => {
    if (
      !postSerial ||
      postBattery === null ||
      !postToken ||
      postHasIssue === null ||
      !isPostObservationValid ||
      postPowerTest === null
    ) {
      return;
    }
    const readingPayload: Reading = {
      serial_number: postSerial,
      battery_percent: postBattery,
      device_timestamp: null,
      capture_token: postToken,
      has_issue: postHasIssue,
      issue_categories: getPostCategoryList(),
      remarks: postRemarks.trim() || null,
      power_test_result: postPowerTest,
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

  const formatRemaining = (ms: number) => {
    if (ms <= 0) return '0s';
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min > 0) return `${min}m ${sec}s`;
    return `${sec}s`;
  };

  const handleStage2NavClick = (targetStep: 'qr' | 1 | 2 | 3 | 4) => {
    setError('');
    setMessage('');
    if (targetStep === 'qr') {
      setReading(null);
      setLookupScanningQR(true);
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
    triggerCpBatteryScan(`h${n}` as Action);
  };

  const confirmCheckpoint = () => perform(async () => {
    if (!reading || cpHasIssue === null || !isCpObservationValid) return;
    const readingPayload: Reading = {
      ...reading,
      has_issue: cpHasIssue,
      issue_categories: getCpCategoryList(),
      remarks: cpRemarks.trim() || null,
    };
    const next = await submit(action, readingPayload, device?.serial_number);
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
    setCpHasIssue(null);
    setCpCategories({ display: false, crashing: false, other: false });
    setCpRemarks('');
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
        {/* Hidden file inputs for rear-camera photo capture of battery percentages */}
        <input
          ref={regBatteryInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => void handleBatteryPhotoSelect(e, 'reg', 'register')}
        />
        <input
          ref={cpBatteryInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => void handleBatteryPhotoSelect(e, 'cp', cpAction, device?.serial_number)}
        />
        <input
          ref={postBatteryInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => void handleBatteryPhotoSelect(e, 'post', 'post-aging', postSerial)}
        />

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

                  {/* Modal for live QR scan */}
                  {regScanningQR ? (
                    <Scanner
                      mode="qr"
                      regex={regex}
                      onSerial={(found) => {
                        setRegSerial(found);
                        setRegManual(false);
                        setRegScanningQR(false);
                        setMessage('');
                      }}
                      onCancel={() => setRegScanningQR(false)}
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

                        <h3 style={{ margin: '6px 0 8px' }}>1. Serial Number Scanner</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Open the rear camera to detect the QR code or barcode.
                        </p>

                        {!regSerial ? (
                          <>
                            {regManual ? (
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
                                  ← Back to live camera scanner
                                </button>
                              </form>
                            ) : (
                              <div>
                                <button
                                  type="button"
                                  className="scan-btn-primary"
                                  disabled={busy || !connected}
                                  onClick={() => {
                                    setError('');
                                    setRegScanningQR(true);
                                  }}
                                >
                                  ▣ Serial Num Scanner
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
                                setRegScanningQR(true);
                              }}
                            >
                              Rescan Serial
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
                        ) : regBatteryProcessing ? (
                          <div className="battery-processing-card">
                            <div className="battery-spinner" />
                            <strong>Reading battery percentage…</strong>
                            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#3f674f' }}>Processing captured photo</p>
                          </div>
                        ) : regBatteryManual ? (
                          <form
                            className="lookup"
                            style={{ marginTop: 10 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleManualBatterySubmit('reg', regBatteryManualInput);
                            }}
                          >
                            <label htmlFor="manual-reg-battery">Enter Battery Percentage (0–100%)</label>
                            <div>
                              <input
                                id="manual-reg-battery"
                                type="number"
                                min="0"
                                max="100"
                                value={regBatteryManualInput}
                                onChange={(e) => setRegBatteryManualInput(e.target.value)}
                                placeholder="e.g. 100"
                                required
                              />
                              <button type="submit" disabled={busy}>Use Battery</button>
                            </div>
                            <button
                              type="button"
                              className="text-button"
                              style={{ marginTop: 8 }}
                              onClick={() => { setRegBatteryManual(false); setRegBatteryError(null); }}
                            >
                              ← Back to camera scan
                            </button>
                          </form>
                        ) : regBatteryError ? (
                          <div className="battery-error-card">
                            <p>⚠ {regBatteryError}</p>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn-retake"
                                onClick={triggerRegBatteryScan}
                              >
                                📷 Retake Photo
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                                onClick={() => { setRegBatteryManual(true); setError(''); }}
                              >
                                ⌨ Enter Manually
                              </button>
                            </div>
                          </div>
                        ) : regBattery === null ? (
                          <div>
                            <button
                              type="button"
                              className="scan-btn-primary"
                              disabled={busy || !connected}
                              onClick={triggerRegBatteryScan}
                            >
                              ⚡ Battery Scan
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              style={{ marginTop: 10, width: '100%' }}
                              onClick={() => { setRegBatteryManual(true); setError(''); }}
                            >
                              Enter battery percentage manually instead
                            </button>
                          </div>
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
                              onClick={triggerRegBatteryScan}
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

                    {/* Hidden QR file input removed in favor of live camera scanning */}

                  {/* 5-Button Control Bar */}
                  <div className="stage2-nav-bar">
                    {/* Button 1: Live Scanner for Serial */}
                    <button
                      type="button"
                      className="stage2-nav-btn btn-qr"
                      disabled={busy}
                      onClick={() => handleStage2NavClick('qr')}
                    >
                      <span className="btn-title">▣ Scanner</span>
                      <span className="btn-subtext">
                        {device ? device.serial_number : 'Scan device'}
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

                  {/* Scanner modal for device lookup */}
                  {lookupScanningQR ? (
                    <Scanner
                      mode="qr"
                      regex={regex}
                      onSerial={(found) => {
                        void findBySerial(found);
                        setLookupScanningQR(false);
                      }}
                      onCancel={() => setLookupScanningQR(false)}
                    />
                  ) : cpBatteryProcessing ? (
                    <div className="battery-processing-card" style={{ maxWidth: 480, margin: '20px auto' }}>
                      <div className="battery-spinner" />
                      <strong>Reading battery percentage…</strong>
                      <p style={{ margin: '6px 0 0', fontSize: 13, color: '#3f674f' }}>
                        Processing captured photo for {cpAction.toUpperCase()} checkpoint
                      </p>
                    </div>
                  ) : cpBatteryManual ? (
                    <div style={{ maxWidth: 480, margin: '20px auto', background: '#ffffff', border: '1px solid #dbe5d6', borderRadius: 12, padding: 20 }}>
                      <form
                        className="lookup"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleManualBatterySubmit('cp', cpBatteryManualInput);
                        }}
                      >
                        <h4 style={{ margin: '0 0 10px' }}>Enter {cpAction.toUpperCase()} Battery Level</h4>
                        <label htmlFor="manual-cp-battery">Battery Percentage (0–100%)</label>
                        <div>
                          <input
                            id="manual-cp-battery"
                            type="number"
                            min="0"
                            max="100"
                            value={cpBatteryManualInput}
                            onChange={(e) => setCpBatteryManualInput(e.target.value)}
                            placeholder="e.g. 85"
                            required
                          />
                          <button type="submit" disabled={busy}>Use Battery</button>
                        </div>
                        <button
                          type="button"
                          className="text-button"
                          style={{ marginTop: 8 }}
                          onClick={() => { setCpBatteryManual(false); setCpBatteryError(null); }}
                        >
                          ← Cancel
                        </button>
                      </form>
                    </div>
                  ) : cpBatteryError ? (
                    <div className="battery-error-card" style={{ maxWidth: 480, margin: '20px auto' }}>
                      <p>⚠ {cpBatteryError}</p>
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn-retake"
                          onClick={() => {
                            setCpBatteryError(null);
                            triggerCpBatteryScan(cpAction);
                          }}
                        >
                          📷 Retake Photo
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                          onClick={() => { setCpBatteryManual(true); setError(''); }}
                        >
                          ⌨ Enter Manually
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setCpBatteryError(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
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
                              const issueVal = device?.values[14 + 3 * (n - 1)];
                              return (
                                <div key={n} style={{ fontSize: 13 }}>
                                  <strong>H{n}:</strong>{' '}
                                  {val !== null && val !== undefined ? (
                                    <span style={{ color: '#2b5220', fontWeight: 650 }}>
                                      {val}% {time ? `(${time})` : ''}
                                      {issueVal === 'Yes' ? ' [⚠ Issue]' : issueVal === 'No' ? ' [✓ OK]' : ''}
                                    </span>
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

                      {/* Issue Observations Section for Checkpoints H1–H4 */}
                      <div className="obs-section">
                        <div className="obs-header">
                          <h4 className="obs-title">Issue Observation</h4>
                          <span style={{ fontSize: 12, fontWeight: 700, color: cpHasIssue ? '#254e1d' : '#b3261e' }}>
                            {cpHasIssue ? 'Answered' : 'Required Selection *'}
                          </span>
                        </div>

                        <div className="obs-question-row">
                          <label className="obs-label">Is any issue observed? *</label>
                          <div className="obs-btn-group">
                            <button
                              type="button"
                              className={`obs-choice-btn ${cpHasIssue === 'no' ? 'selected-no' : ''}`}
                              onClick={() => {
                                setCpHasIssue('no');
                                setCpCategories({ display: false, crashing: false, other: false });
                              }}
                            >
                              {cpHasIssue === 'no' ? '✓ No' : 'No'}
                            </button>
                            <button
                              type="button"
                              className={`obs-choice-btn ${cpHasIssue === 'yes' ? 'selected-yes' : ''}`}
                              onClick={() => setCpHasIssue('yes')}
                            >
                              {cpHasIssue === 'yes' ? '⚠ Yes' : 'Yes'}
                            </button>
                          </div>
                          {cpHasIssue === null && (
                            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#889886', fontStyle: 'italic' }}>
                              Select Yes or No to proceed.
                            </p>
                          )}
                        </div>

                        {cpHasIssue === 'yes' && (
                          <div className="obs-categories-box">
                            <div className="obs-categories-title">Select Issue Categories (at least one required) *</div>
                            <label className="obs-checkbox-label">
                              <input
                                type="checkbox"
                                checked={cpCategories.display}
                                onChange={(e) => setCpCategories((prev) => ({ ...prev, display: e.target.checked }))}
                              />
                              <span>Display issue</span>
                            </label>
                            <label className="obs-checkbox-label">
                              <input
                                type="checkbox"
                                checked={cpCategories.crashing}
                                onChange={(e) => setCpCategories((prev) => ({ ...prev, crashing: e.target.checked }))}
                              />
                              <span>Crashing / hanging issue</span>
                            </label>
                            <label className="obs-checkbox-label">
                              <input
                                type="checkbox"
                                checked={cpCategories.other}
                                onChange={(e) => setCpCategories((prev) => ({ ...prev, other: e.target.checked }))}
                              />
                              <span>Other issue</span>
                            </label>
                            {cpHasIssue === 'yes' && !cpCategories.display && !cpCategories.crashing && !cpCategories.other && (
                              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#b3261e', fontWeight: 600 }}>
                                ⚠ Please select at least one issue category.
                              </p>
                            )}
                          </div>
                        )}

                        <div className="obs-remarks-field">
                          <label htmlFor="cp-remarks">Observations / remarks (optional):</label>
                          <textarea
                            id="cp-remarks"
                            rows={3}
                            value={cpRemarks}
                            onChange={(e) => setCpRemarks(e.target.value)}
                            placeholder="Enter any additional observations, notes, or issue descriptions..."
                          />
                        </div>
                      </div>

                      <p style={{ margin: '16px 0 20px', fontSize: 14 }}>
                        Compare these values with the device screen. Click confirm to store directly in Excel.
                      </p>

                      <div className="actions">
                        <button
                          type="button"
                          style={{ flex: 2, minHeight: 52, fontSize: 16 }}
                          disabled={busy || !connected || cpHasIssue === null || !isCpObservationValid}
                          onClick={() => void confirmCheckpoint()}
                        >
                          {busy ? 'Saving to Excel…' : `✓ Confirm & Save ${action.toUpperCase()} to Excel`}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => triggerCpBatteryScan(action)}
                        >
                          ↺ Rescan Battery
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setReading(null);
                            setCpHasIssue(null);
                            setCpCategories({ display: false, crashing: false, other: false });
                            setCpRemarks('');
                          }}
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
                          {lookupPhase === 'loading' && <p role="status" className="scan-status">Decoding device code…</p>}
                          {lookupPhase === 'scan' && (
                            <div className="scan-start">
                              <div className="scan-icon" aria-hidden="true">▣</div>
                              <h3>Scan Device Serial Code</h3>
                              <p>Open the live camera scanner to detect the device QR code or barcode.</p>
                              <button
                                type="button"
                                disabled={busy || !connected || !regex}
                                onClick={() => {
                                  setError('');
                                  setLookupScanningQR(true);
                                }}
                              >
                                ▣ Scanner to Find Device
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
                                ← Back to live camera scanner
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
                                    setPostBatteryProcessing(false);
                                    setPostBatteryError(null);
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
                                        {(() => {
                                          const issueVal = device.values[14 + 3 * (n - 1)];
                                          const catVal = device.values[15 + 3 * (n - 1)];
                                          const remVal = device.values[16 + 3 * (n - 1)];
                                          const obsObj = device.observations?.[`h${n}`];
                                          const hasIssue = issueVal === 'Yes' || obsObj?.has_issue === 'yes';
                                          const isNoIssue = issueVal === 'No' || obsObj?.has_issue === 'no';
                                          const categories = catVal || obsObj?.categories?.join(', ');
                                          const remarks = remVal || obsObj?.remarks;

                                          if (hasIssue) {
                                            return (
                                              <div className="stage2-obs-badge" style={{ borderColor: '#f4c7b8', background: '#fff5f2' }}>
                                                <span style={{ color: '#b91c1c', fontWeight: 650 }}>
                                                  ⚠ Issue: {categories || 'Reported'}
                                                </span>
                                                {remarks ? <div style={{ fontSize: 11, color: '#7c2a0f', marginTop: 2 }}>&ldquo;{remarks}&rdquo;</div> : null}
                                              </div>
                                            );
                                          } else if (isNoIssue) {
                                            return (
                                              <div className="stage2-obs-badge">
                                                <span style={{ color: '#254e1d' }}>✓ No issue observed</span>
                                                {remarks ? <div style={{ fontSize: 11, color: '#556653', marginTop: 2 }}>&ldquo;{remarks}&rdquo;</div> : null}
                                              </div>
                                            );
                                          } else {
                                            return (
                                              <div className="stage2-obs-badge" style={{ background: '#f8faf6', color: '#7a8877' }}>
                                                <span style={{ fontStyle: 'italic' }}>Observations: Not recorded</span>
                                              </div>
                                            );
                                          }
                                        })()}
                                        <p style={{ margin: '8px 0 0', fontSize: 13, color: '#385e30' }}>Row updated in Excel</p>
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
                                      onClick={() => triggerCpBatteryScan(`h${n}` as Action)}
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
                                        setPostBatteryProcessing(false);
                                        setPostBatteryError(null);
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

                  {/* Modal for live QR scan */}
                  {postScanningQR ? (
                    <Scanner
                      mode="qr"
                      regex={regex}
                      onSerial={(found) => {
                        setPostSerial(found);
                        setPostManual(false);
                        setPostScanningQR(false);
                        setMessage('');
                      }}
                      onCancel={() => setPostScanningQR(false)}
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
                      <div className="scanned-value-box" style={{ maxWidth: 460, margin: '0 auto 24px', flexDirection: 'column', gap: 12, textAlign: 'left', background: '#ffffff' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                          <div>
                            <div className="scanned-label">Serial Number</div>
                            <div className="scanned-text" style={{ fontSize: 20 }}>{postConfirmed.serial_number}</div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div className="scanned-label">Final Battery</div>
                            <div className="scanned-text" style={{ color: '#27521c', fontSize: 20 }}>{postBattery}%</div>
                          </div>
                        </div>
                        <hr style={{ width: '100%', margin: '4px 0', borderColor: '#e1e9dc' }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                          <div>
                            <div className="scanned-label">Long Press Power Test</div>
                            <div style={{ fontSize: 16, fontWeight: 750, marginTop: 4, color: (postPowerTest || postConfirmed.power_test_result) === 'Pass' ? '#27521c' : (postPowerTest || postConfirmed.power_test_result) === 'Fail' ? '#b3261e' : '#8c5d08' }}>
                              {postPowerTest || postConfirmed.power_test_result || 'Pass'}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div className="scanned-label">Issue Observation</div>
                            <div style={{ fontSize: 14, fontWeight: 650, marginTop: 4 }}>
                              {postHasIssue === 'yes' ? (
                                <span style={{ color: '#b3261e' }}>⚠ Issues: {getPostCategoryList().join(', ') || 'Yes'}</span>
                              ) : postHasIssue === 'no' ? (
                                <span style={{ color: '#27521c' }}>✓ No issue observed</span>
                              ) : (
                                <span>Recorded</span>
                              )}
                            </div>
                          </div>
                        </div>
                        {postRemarks && (
                          <div style={{ width: '100%', fontSize: 13, color: '#576755', fontStyle: 'italic', marginTop: 2 }}>
                            Remarks: &ldquo;{postRemarks}&rdquo;
                          </div>
                        )}
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

                        <h3 style={{ margin: '6px 0 8px' }}>1. Serial Number Scanner</h3>
                        <p style={{ margin: '0 0 14px' }}>
                          Open the rear camera to detect the QR code or barcode.
                        </p>

                        {!postSerial ? (
                          <>
                            {postManual ? (
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
                                  ← Back to live camera scanner
                                </button>
                              </form>
                            ) : (
                              <div>
                                <button
                                  type="button"
                                  className="scan-btn-primary"
                                  disabled={busy || !connected}
                                  onClick={() => {
                                    setError('');
                                    setPostScanningQR(true);
                                  }}
                                >
                                  ▣ Serial Num Scanner
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
                                setPostScanningQR(true);
                              }}
                            >
                              Rescan Serial
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
                          Position the device’s battery percentage inside the guide (must be 70–100%).
                        </p>

                        {!postSerial ? (
                          <p style={{ color: '#748270', fontStyle: 'italic', margin: '10px 0' }}>
                            Scan the Serial QR code in Step 1 first to enable battery scanning.
                          </p>
                        ) : postBatteryProcessing ? (
                          <div className="battery-processing-card">
                            <div className="battery-spinner" />
                            <strong>Reading battery percentage…</strong>
                            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#3f674f' }}>Processing captured photo</p>
                          </div>
                        ) : postBatteryManual ? (
                          <form
                            className="lookup"
                            style={{ marginTop: 10 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleManualBatterySubmit('post', postBatteryManualInput);
                            }}
                          >
                            <label htmlFor="manual-post-battery">Enter Battery Percentage (70–100%)</label>
                            <div>
                              <input
                                id="manual-post-battery"
                                type="number"
                                min="70"
                                max="100"
                                value={postBatteryManualInput}
                                onChange={(e) => setPostBatteryManualInput(e.target.value)}
                                placeholder="e.g. 95"
                                required
                              />
                              <button type="submit" disabled={busy}>Use Battery</button>
                            </div>
                            <button
                              type="button"
                              className="text-button"
                              style={{ marginTop: 8 }}
                              onClick={() => { setPostBatteryManual(false); setPostBatteryError(null); }}
                            >
                              ← Back to camera scan
                            </button>
                          </form>
                        ) : postBatteryError ? (
                          <div className="battery-error-card">
                            <p>⚠ {postBatteryError}</p>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn-retake"
                                onClick={triggerPostBatteryScan}
                              >
                                📷 Retake Photo
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                style={{ minHeight: 38, padding: '8px 14px', fontSize: 13 }}
                                onClick={() => { setPostBatteryManual(true); setError(''); }}
                              >
                                ⌨ Enter Manually
                              </button>
                            </div>
                          </div>
                        ) : postBattery === null ? (
                          <div>
                            <button
                              type="button"
                              className="scan-btn-primary"
                              disabled={busy || !connected}
                              onClick={triggerPostBatteryScan}
                            >
                              ⚡ Battery Scan (Packing)
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              style={{ marginTop: 10, width: '100%' }}
                              onClick={() => { setPostBatteryManual(true); setError(''); }}
                            >
                              Enter battery percentage manually instead
                            </button>
                          </div>
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
                              onClick={triggerPostBatteryScan}
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
                          <h3 style={{ margin: '6px 0 14px' }}>Confirm Post-Aging Battery & Test Results</h3>
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
                                ✓ Battery level is within packing range (70–100%). Device will be marked <strong>PACKING READY</strong> in Excel.
                              </span>
                            ) : (
                              <span style={{ color: '#b91c1c' }}>
                                ⚠ Battery level is {postBattery}% (below 70%). Device needs further charging before packing.
                              </span>
                            )}
                          </p>

                          {/* Issue Observations Section for Post Test / Packing */}
                          <div className="obs-section">
                            <div className="obs-header">
                              <h4 className="obs-title">Issue Observation</h4>
                              <span style={{ fontSize: 12, fontWeight: 700, color: postHasIssue ? '#254e1d' : '#b3261e' }}>
                                {postHasIssue ? 'Answered' : 'Required Selection *'}
                              </span>
                            </div>

                            <div className="obs-question-row">
                              <label className="obs-label">Is any issue observed? *</label>
                              <div className="obs-btn-group">
                                <button
                                  type="button"
                                  className={`obs-choice-btn ${postHasIssue === 'no' ? 'selected-no' : ''}`}
                                  onClick={() => {
                                    setPostHasIssue('no');
                                    setPostCategories({ display: false, crashing: false, other: false });
                                  }}
                                >
                                  {postHasIssue === 'no' ? '✓ No' : 'No'}
                                </button>
                                <button
                                  type="button"
                                  className={`obs-choice-btn ${postHasIssue === 'yes' ? 'selected-yes' : ''}`}
                                  onClick={() => setPostHasIssue('yes')}
                                >
                                  {postHasIssue === 'yes' ? '⚠ Yes' : 'Yes'}
                                </button>
                              </div>
                              {postHasIssue === null && (
                                <p style={{ margin: '6px 0 0', fontSize: 13, color: '#889886', fontStyle: 'italic' }}>
                                  Select Yes or No to proceed.
                                </p>
                              )}
                            </div>

                            {postHasIssue === 'yes' && (
                              <div className="obs-categories-box">
                                <div className="obs-categories-title">Select Issue Categories (at least one required) *</div>
                                <label className="obs-checkbox-label">
                                  <input
                                    type="checkbox"
                                    checked={postCategories.display}
                                    onChange={(e) => setPostCategories((prev) => ({ ...prev, display: e.target.checked }))}
                                  />
                                  <span>Display issue</span>
                                </label>
                                <label className="obs-checkbox-label">
                                  <input
                                    type="checkbox"
                                    checked={postCategories.crashing}
                                    onChange={(e) => setPostCategories((prev) => ({ ...prev, crashing: e.target.checked }))}
                                  />
                                  <span>Crashing / hanging issue</span>
                                </label>
                                <label className="obs-checkbox-label">
                                  <input
                                    type="checkbox"
                                    checked={postCategories.other}
                                    onChange={(e) => setPostCategories((prev) => ({ ...prev, other: e.target.checked }))}
                                  />
                                  <span>Other issue</span>
                                </label>
                                {postHasIssue === 'yes' && !postCategories.display && !postCategories.crashing && !postCategories.other && (
                                  <p style={{ margin: '8px 0 0', fontSize: 13, color: '#b3261e', fontWeight: 600 }}>
                                    ⚠ Please select at least one issue category.
                                  </p>
                                )}
                              </div>
                            )}

                            <div className="obs-remarks-field">
                              <label htmlFor="post-remarks">Observations / remarks (optional):</label>
                              <textarea
                                id="post-remarks"
                                rows={3}
                                value={postRemarks}
                                onChange={(e) => setPostRemarks(e.target.value)}
                                placeholder="Enter any post-aging observations, notes, or issue descriptions..."
                              />
                            </div>
                          </div>

                          {/* Long Press Power Off/On Test Section */}
                          <div className="power-test-section">
                            <div className="obs-header">
                              <h4 className="obs-title">Long Press Power Off/On Test *</h4>
                              <span style={{ fontSize: 12, fontWeight: 700, color: postPowerTest ? '#254e1d' : '#b3261e' }}>
                                {postPowerTest ? `Selected: ${postPowerTest}` : 'Required Selection *'}
                              </span>
                            </div>
                            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#576755' }}>
                              Record the operator assessment for the physical long-press power off and power on cycle.
                            </p>
                            <div className="power-test-btn-group">
                              <button
                                type="button"
                                className={`power-test-btn ${postPowerTest === 'Pass' ? 'selected-pass' : ''}`}
                                onClick={() => setPostPowerTest('Pass')}
                              >
                                {postPowerTest === 'Pass' ? '✓ Pass' : 'Pass'}
                              </button>
                              <button
                                type="button"
                                className={`power-test-btn ${postPowerTest === 'Fail' ? 'selected-fail' : ''}`}
                                onClick={() => setPostPowerTest('Fail')}
                              >
                                {postPowerTest === 'Fail' ? '✕ Fail' : 'Fail'}
                              </button>
                              <button
                                type="button"
                                className={`power-test-btn ${postPowerTest === 'Hold' ? 'selected-hold' : ''}`}
                                onClick={() => setPostPowerTest('Hold')}
                              >
                                {postPowerTest === 'Hold' ? '⏸ Hold' : 'Hold'}
                              </button>
                            </div>
                            {postPowerTest === null && (
                              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#889886', fontStyle: 'italic' }}>
                                Please select Pass, Fail, or Hold to proceed.
                              </p>
                            )}
                          </div>

                          <div className="actions">
                            <button
                              type="button"
                              style={{ minHeight: 52, fontSize: 16, flex: 2 }}
                              disabled={busy || !connected || postBattery < 70 || postHasIssue === null || !isPostObservationValid || postPowerTest === null}
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
