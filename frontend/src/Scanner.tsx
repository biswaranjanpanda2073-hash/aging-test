import { useEffect, useRef, useState, useCallback } from 'react';
import { decodeCodeFromCanvas, parseQRSerial } from './qr';
import { openCamera, startPreview, stopStream, cameraError, cropVideoFrame, type NormalizedRect } from './camera';
import type { Action, Reading } from './types';

export interface ScannerProps {
  mode?: 'qr' | 'battery' | 'full';
  action?: Action;
  target?: string;
  regex: string;
  onSerial?: (serial: string) => void;
  onResult?: (reading: Reading) => void;
  onCancel: () => void;
}

// Normalized guide coordinates on video stream for QR/barcode alignment
const QR_GUIDE: NormalizedRect = { x: 0.15, y: 0.20, width: 0.70, height: 0.60 };

export function Scanner({
  target,
  regex,
  onSerial,
  onResult,
  onCancel,
}: ScannerProps) {
  const [status, setStatus] = useState<string>('Initializing camera…');
  const [guidance, setGuidance] = useState<string | null>(null);
  const [cameraErr, setCameraErr] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveRef = useRef(true);
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scanLoopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean shutdown of camera and pending timers
  const shutdownCamera = useCallback(() => {
    if (scanLoopTimerRef.current) {
      clearTimeout(scanLoopTimerRef.current);
      scanLoopTimerRef.current = null;
    }
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

  // Initialize camera session
  const initCamera = useCallback(async (currentGen: number) => {
    shutdownCamera();
    setCameraErr(null);
    setStatus('Opening rear camera…');
    setGuidance(null);

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is not supported in this browser. Please use Android Chrome over trusted HTTPS.');
      }

      const stream = await openCamera(navigator.mediaDevices, abortCtrl.signal);
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

      setCameraActive(true);
      setStatus('Scanning for QR code or barcode…');
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

  // Main continuous QR/barcode scanner loop
  useEffect(() => {
    if (!cameraActive || cameraErr) return;

    let loopAlive = true;
    const currentGen = generationRef.current;

    const runScanStep = async () => {
      if (!loopAlive || !liveRef.current || generationRef.current !== currentGen) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        scanLoopTimerRef.current = setTimeout(() => void runScanStep(), 150);
        return;
      }

      try {
        const crop = cropVideoFrame(video, QR_GUIDE, 640);
        const rawCode = await decodeCodeFromCanvas(crop);

        if (rawCode && loopAlive && liveRef.current && generationRef.current === currentGen) {
          try {
            const serial = parseQRSerial(rawCode, regex);

            if (target && serial !== target) {
              setGuidance(`Scanned device (${serial}) does not match expected (${target})`);
            } else {
              setStatus(`✓ Valid serial detected: ${serial}`);
              setGuidance(null);
              shutdownCamera();

              if (navigator.vibrate) {
                try { navigator.vibrate(80); } catch { /* ignore */ }
              }

              if (onSerial) {
                onSerial(serial);
              } else if (onResult) {
                onResult({
                  serial_number: serial,
                  battery_percent: 0,
                  device_timestamp: null,
                  capture_token: '',
                });
              }
              return;
            }
          } catch (validationErr) {
            setGuidance(validationErr instanceof Error ? validationErr.message : 'Invalid code format');
          }
        }
      } catch {
        // Frame decode exception; continue scanning next frame
      }

      if (loopAlive) {
        scanLoopTimerRef.current = setTimeout(() => void runScanStep(), 120);
      }
    };

    scanLoopTimerRef.current = setTimeout(() => void runScanStep(), 150);

    return () => {
      loopAlive = false;
      if (scanLoopTimerRef.current) {
        clearTimeout(scanLoopTimerRef.current);
        scanLoopTimerRef.current = null;
      }
    };
  }, [cameraActive, cameraErr, target, regex, onSerial, onResult, shutdownCamera]);

  const handleRetry = () => {
    void initCamera(++generationRef.current);
  };

  const handleCancel = () => {
    liveRef.current = false;
    generationRef.current++;
    shutdownCamera();
    onCancel();
  };

  return (
    <section className="live-scanner" aria-label="Live Serial Scanner">
      <div className="live-scanner-header">
        <h3>Scan Device Serial (Live Camera)</h3>
        {target && (
          <p className="scanner-target-badge">
            Expected: <strong>{target}</strong>
          </p>
        )}
      </div>

      {/* Camera Error / Permission Denied State */}
      {cameraErr && (
        <div className="camera-error-card" role="alert">
          <div className="camera-error-icon">📷</div>
          <h4>Camera Access Required</h4>
          <p>{cameraErr}</p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button type="button" onClick={handleRetry}>
              ↺ Retry Camera
            </button>
            <button type="button" className="secondary" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Active Live Camera Viewport */}
      {!cameraErr && (
        <div className="camera-viewport-container">
          <div className="camera-viewport">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label="Live QR and Barcode Scanner"
            />

            {/* Live Alignment Guide Overlay */}
            <div
              className="live-guide qr-guide-box"
              style={{
                left: `${QR_GUIDE.x * 100}%`,
                top: `${QR_GUIDE.y * 100}%`,
                width: `${QR_GUIDE.width * 100}%`,
                height: `${QR_GUIDE.height * 100}%`,
              }}
            >
              <div className="guide-corner tl" />
              <div className="guide-corner tr" />
              <div className="guide-corner bl" />
              <div className="guide-corner br" />
              <div className="scanner-laser" />
              <span className="guide-tag">⚡ ALIGN QR OR BARCODE</span>
            </div>
          </div>

          {/* Real-time Instructions and Feedback */}
          <div className="scanner-feedback">
            <p className="scanner-instruction">
              Align the device QR code or barcode inside the green frame.
            </p>

            {guidance && (
              <div className="scanner-guidance-pill" role="status">
                💡 {guidance}
              </div>
            )}

            {status && (
              <div className="scanner-status-line">
                <span className="pulsing-dot" /> {status}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom Controls */}
      <div className="actions" style={{ justifyContent: 'center', marginTop: 14 }}>
        <button type="button" className="secondary" onClick={handleCancel}>
          Cancel Scanner
        </button>
      </div>

      <p className="privacy-notice">
        Serial QR codes and barcodes are processed temporarily in memory. No photos are saved to disk.
      </p>
    </section>
  );
}
