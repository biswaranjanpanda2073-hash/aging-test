import { useEffect, useRef, useState, useCallback } from 'react';
import {
  openCamera,
  startPreview,
  stopStream,
  cameraError,
  getCameraCapabilities,
  applyCameraZoom,
  applyMacroFocus,
  applyTorch,
  captureFrameFromVideo,
  type CameraCapabilities,
  type NormalizedRect,
} from './camera';

export interface BatteryScannerProps {
  onCapture: (canvas: HTMLCanvasElement) => void;
  onCancel: () => void;
  onManual?: () => void;
  onFileSelect?: (file: File) => void;
  targetSerial?: string;
  stageTitle?: string;
}

// Battery percentage alignment guide coordinates (status bar region)
const BATTERY_GUIDE: NormalizedRect = { x: 0.15, y: 0.30, width: 0.70, height: 0.40 };

export function BatteryScanner({
  onCapture,
  onCancel,
  onManual,
  onFileSelect,
  targetSerial,
  stageTitle = 'Battery Scan',
}: BatteryScannerProps) {
  const [status, setStatus] = useState<string>('Initializing Macro Camera…');
  const [cameraErr, setCameraErr] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  // Zoom and Macro state
  const [zoom, setZoom] = useState<number>(2.0); // Default to 2.0x Macro Mode
  const [hasHardwareZoom, setHasHardwareZoom] = useState(false);
  const [minZoom, setMinZoom] = useState(1.0);
  const [maxZoom, setMaxZoom] = useState(5.0);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [macroActive, setMacroActive] = useState(true);

  // Tap-to-focus animation state
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveRef = useRef(true);
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Touch pinch-to-zoom tracking
  const touchStartDistRef = useRef<number | null>(null);
  const initialPinchZoomRef = useRef<number>(2.0);

  // Shutdown camera cleanly
  const shutdownCamera = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (streamRef.current) {
      stopStream(streamRef.current);
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  // Update zoom constraint or fallback to digital zoom
  const updateZoom = useCallback(async (targetZoom: number) => {
    const clamped = Math.max(minZoom, Math.min(maxZoom, Math.round(targetZoom * 10) / 10));
    setZoom(clamped);
    setMacroActive(clamped >= 1.8 && clamped <= 2.5);

    if (hasHardwareZoom && streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      if (track) {
        await applyCameraZoom(track, clamped);
      }
    }
  }, [hasHardwareZoom, minZoom, maxZoom]);

  // Initialize camera in Macro mode with 2.0x zoom
  const initCamera = useCallback(async (currentGen: number) => {
    shutdownCamera();
    setCameraErr(null);
    setStatus('Opening camera in Macro Mode…');

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is not supported in this browser. Please use Android Chrome over trusted HTTPS.');
      }

      // Open rear camera with macro preferences
      const stream = await openCamera(navigator.mediaDevices, abortCtrl.signal, {
        preferMacro: true,
        idealWidth: 1920,
        idealHeight: 1080,
      });

      if (!liveRef.current || generationRef.current !== currentGen) {
        stopStream(stream);
        return;
      }

      streamRef.current = stream;
      if (!videoRef.current) {
        stopStream(stream);
        return;
      }

      await startPreview(videoRef.current, stream, abortCtrl.signal);
      if (!liveRef.current || generationRef.current !== currentGen) {
        shutdownCamera();
        return;
      }

      // Inspect hardware capabilities
      const track = stream.getVideoTracks()[0];
      let caps: CameraCapabilities = {
        hasZoom: false,
        minZoom: 1,
        maxZoom: 5,
        stepZoom: 0.1,
        hasTorch: false,
        hasMacro: false,
        currentZoom: 1,
      };

      if (track) {
        caps = getCameraCapabilities(track);
        setHasTorch(caps.hasTorch);
        setHasHardwareZoom(caps.hasZoom);

        if (caps.hasZoom) {
          setMinZoom(caps.minZoom);
          setMaxZoom(Math.max(5.0, caps.maxZoom));
        }

        // Apply hardware macro focus if supported
        void applyMacroFocus(track);

        // Initially open with Macro Mode at 2.0x zoom
        const defaultMacroZoom = Math.min(caps.hasZoom ? caps.maxZoom : 5.0, Math.max(caps.minZoom, 2.0));
        setZoom(defaultMacroZoom);
        setMacroActive(true);

        if (caps.hasZoom) {
          void applyCameraZoom(track, defaultMacroZoom);
        }
      }

      setCameraActive(true);
      setStatus('Macro mode active (2.0x). Hold ~10–15 cm from battery screen.');
    } catch (err) {
      if (!liveRef.current || generationRef.current !== currentGen) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setCameraErr(cameraError(err));
      setStatus('');
    }
  }, [shutdownCamera]);

  useEffect(() => {
    liveRef.current = true;
    const currentGen = ++generationRef.current;
    void initCamera(currentGen);

    return () => {
      liveRef.current = false;
      generationRef.current++;
      shutdownCamera();
    };
  }, [initCamera, shutdownCamera]);

  // Handle capture button press
  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    try {
      if (navigator.vibrate) {
        try { navigator.vibrate(60); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // If hardware zoom was applied, the video stream is already zoomed optically/digitally.
    // If not, apply digital zoom crop on the canvas.
    const digitalScale = hasHardwareZoom ? 1.0 : zoom;
    const canvas = captureFrameFromVideo(video, {
      digitalZoom: digitalScale,
      maxDimension: 1280,
    });

    shutdownCamera();
    onCapture(canvas);
  };

  // Tap-to-focus handler
  const handleViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setFocusPoint({ x, y });

    // Clear focus indicator after animation
    setTimeout(() => setFocusPoint(null), 1000);

    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      if (track) {
        void applyMacroFocus(track);
      }
    }
  };

  // Pinch-to-zoom touch handlers
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDistRef.current = Math.hypot(dx, dy);
      initialPinchZoomRef.current = zoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && touchStartDistRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / touchStartDistRef.current;
      const targetZoom = initialPinchZoomRef.current * ratio;
      void updateZoom(targetZoom);
    }
  };

  const handleTouchEnd = () => {
    touchStartDistRef.current = null;
  };

  // Torch toggle
  const toggleTorch = async () => {
    if (!hasTorch || !streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track) {
      const nextState = !torchOn;
      const ok = await applyTorch(track, nextState);
      if (ok) setTorchOn(nextState);
    }
  };

  // Reset to initial Macro mode
  const handleSetMacroMode = () => {
    void updateZoom(2.0);
    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      if (track) void applyMacroFocus(track);
    }
  };

  const handleRetry = () => {
    void initCamera(++generationRef.current);
  };

  const handleCancel = () => {
    liveRef.current = false;
    generationRef.current++;
    shutdownCamera();
    onCancel();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && onFileSelect) {
      shutdownCamera();
      onFileSelect(file);
    }
  };

  return (
    <section className="live-scanner battery-scanner-container" aria-label="Battery Macro Scanner">
      {/* Hidden file input for file upload fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="live-scanner-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3>{stageTitle}</h3>
          <span className={`macro-badge ${macroActive ? 'active' : ''}`}>
            {macroActive ? '🔍 Macro Mode (2.0x)' : `${zoom.toFixed(1)}x Zoom`}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasTorch && (
            <button
              type="button"
              className={`scanner-icon-btn ${torchOn ? 'torch-on' : ''}`}
              title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
              onClick={toggleTorch}
            >
              🔦
            </button>
          )}
          <button
            type="button"
            className="scanner-close-btn"
            onClick={handleCancel}
            title="Cancel"
          >
            ✕
          </button>
        </div>
      </div>

      {targetSerial && (
        <p className="scanner-target-badge" style={{ marginBottom: 12 }}>
          Device: <strong>{targetSerial}</strong>
        </p>
      )}

      {/* Error state if camera is blocked */}
      {cameraErr && (
        <div className="camera-error-card" role="alert">
          <div className="camera-error-icon">📷</div>
          <h4>Camera Access Required</h4>
          <p>{cameraErr}</p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button type="button" onClick={handleRetry}>
              ↺ Retry Camera
            </button>
            {onFileSelect && (
              <button
                type="button"
                className="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                📁 Upload Photo
              </button>
            )}
            {onManual && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  shutdownCamera();
                  onManual();
                }}
              >
                ⌨ Enter Manually
              </button>
            )}
            <button type="button" className="secondary" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Live Viewport with Zoom and Macro Controls */}
      {!cameraErr && (
        <div className="camera-viewport-container">
          <div
            className="camera-viewport battery-viewport"
            onClick={handleViewportClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label="Live Battery Macro Viewfinder"
              style={
                !hasHardwareZoom && zoom !== 1.0
                  ? {
                      transform: `scale(${zoom})`,
                      transformOrigin: 'center center',
                      transition: 'transform 0.12s ease-out',
                    }
                  : undefined
              }
            />

            {/* Battery Alignment Guide */}
            <div
              className="live-guide battery-guide-box"
              style={{
                left: `${BATTERY_GUIDE.x * 100}%`,
                top: `${BATTERY_GUIDE.y * 100}%`,
                width: `${BATTERY_GUIDE.width * 100}%`,
                height: `${BATTERY_GUIDE.height * 100}%`,
              }}
            >
              <div className="guide-corner tl" />
              <div className="guide-corner tr" />
              <div className="guide-corner bl" />
              <div className="guide-corner br" />
              <div className="battery-guide-crosshair" />
              <span className="guide-tag">🔋 ALIGN BATTERY PERCENTAGE</span>
            </div>

            {/* Tap-to-focus animation ring */}
            {focusPoint && (
              <div
                className="tap-focus-indicator"
                style={{ left: focusPoint.x, top: focusPoint.y }}
              />
            )}

            {/* Active Magnification Overlay HUD */}
            <div className="viewport-zoom-pill">
              {zoom.toFixed(1)}×
            </div>
          </div>

          {/* Interactive Zoom Bar (Zoom In, Zoom Out, Presets, Slider) */}
          <div className="zoom-controls-panel">
            <div className="zoom-preset-chips">
              <button
                type="button"
                className={`zoom-chip ${zoom <= 1.2 ? 'active' : ''}`}
                onClick={() => void updateZoom(1.0)}
              >
                1.0x Wide
              </button>
              <button
                type="button"
                className={`zoom-chip ${macroActive ? 'active macro-chip' : ''}`}
                onClick={handleSetMacroMode}
              >
                🔍 2.0x Macro (Default)
              </button>
              <button
                type="button"
                className={`zoom-chip ${zoom >= 2.8 && zoom <= 3.2 ? 'active' : ''}`}
                onClick={() => void updateZoom(3.0)}
              >
                3.0x Detail
              </button>
            </div>

            <div className="zoom-slider-row">
              <button
                type="button"
                className="zoom-step-btn"
                aria-label="Zoom Out"
                disabled={zoom <= minZoom}
                onClick={() => void updateZoom(zoom - 0.2)}
              >
                −
              </button>

              <div className="zoom-slider-track">
                <input
                  type="range"
                  min={minZoom}
                  max={maxZoom}
                  step={0.1}
                  value={zoom}
                  onChange={(e) => void updateZoom(parseFloat(e.target.value))}
                  aria-label="Camera Zoom Level"
                  className="zoom-range-input"
                />
              </div>

              <button
                type="button"
                className="zoom-step-btn"
                aria-label="Zoom In"
                disabled={zoom >= maxZoom}
                onClick={() => void updateZoom(zoom + 0.2)}
              >
                +
              </button>

              <span className="zoom-value-label">{zoom.toFixed(1)}×</span>
            </div>
          </div>

          {/* Feedback & Instructions */}
          <div className="scanner-feedback">
            <p className="scanner-instruction" style={{ margin: 0 }}>
              Hold camera <strong>10–15 cm</strong> from the Tohands screen. Digits will be sharp in <strong>Macro Mode</strong>.
            </p>
            {status && (
              <div className="scanner-status-line" style={{ marginTop: 6 }}>
                <span className="pulsing-dot" /> {status}
              </div>
            )}
          </div>

          {/* Shutter Button Card */}
          <div className="shutter-action-container">
            <button
              type="button"
              className="shutter-button"
              disabled={!cameraActive}
              onClick={handleCapture}
              aria-label="Capture Battery Photo"
            >
              <div className="shutter-inner-circle">
                <span className="shutter-icon">📸</span>
              </div>
            </button>
            <span className="shutter-label">Tap to Read Battery</span>
          </div>
        </div>
      )}

      {/* Secondary Fallback Actions */}
      <div className="scanner-aux-actions">
        {onFileSelect && (
          <button
            type="button"
            className="text-button"
            onClick={() => fileInputRef.current?.click()}
          >
            📁 Upload Photo instead
          </button>
        )}
        {onManual && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              shutdownCamera();
              onManual();
            }}
          >
            ⌨ Enter Manually instead
          </button>
        )}
        <button
          type="button"
          className="text-button"
          style={{ color: '#889886' }}
          onClick={handleCancel}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
