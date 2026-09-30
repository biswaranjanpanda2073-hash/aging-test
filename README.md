# Tohands Aging Test — native photo workflow 1.2

Read VALIDATION_REPORT.md before use. This build provides native photo capture and local QR/battery processing; it is not a guarantee that every image is readable.

## Windows installation

Install Python 3.12, Node.js 22.12+ or 24, and mkcert from official sources. Extract to a new folder and back up existing records. In PowerShell from the project folder:

```powershell
.\scripts\install.ps1
.\scripts\setup-https.ps1 -LanIP YOUR-LAPTOP-IP
.\start-development.ps1
```

Find the Wi-Fi IPv4 address using ipconfig. Transfer only `phone-setup/tohands-development-ca.crt` to Android and install it as a CA certificate. Never transfer private keys. Allow TCP 5173 only on the laptop's Private network; backend port 8000 stays on loopback. On the same Wi-Fi open `https://YOUR-LAPTOP-IP:5173`, resolve certificate warnings and disable Chrome Desktop site. Do not bypass organization security policy to run scripts. If the laptop IP changes, repeat HTTPS setup and restart.

## Operator workflow

Start photo capture → Take QR Photo → native camera/picker → confirm decoded serial → Take Battery Photo → preview → read automatically or drag a green box around only the battery digits and % → check the result → confirm and save.

Rotate the returned photo until text is upright before selecting a crop. The guide is on the returned preview; a webpage cannot overlay a guide inside the native camera app. `capture=environment` requests the rear camera, but the camera/picker behavior depends on the phone/browser.

Keep the same device for both photographs. A separate battery photo cannot prove it belongs to the QR. For H1–H4/post-aging, find the registered serial and use the available stage action; the new QR must match that device.

If OCR fails or gives an incorrect result, retake or adjust the crop. Never approve a value without comparing it with the device. No manual guessed value replaces failed OCR. The native camera/OS may save its own photo copy; this application does not upload or persist images.

## Workflow and storage

Registration below 100% waits for charge. A fresh 100% reading starts aging. H1–H4 are ordered with default one-hour intervals and operator restart confirmations. Post-aging needs 70–100% for packing. This retains the project's four-checkpoint policy, not certification against another factory SOP.

Every reading updates the same Excel device row. Duplicate registrations and invalid transitions are rejected. Server timestamps are saved independently. Device clock is null/unavailable in this two-photo workflow; the phone's timestamp is not substituted for it.

Configure the workbook path, serial pattern, capture-ticket lifetime and checkpoint interval through backend/.env.example. Keep Excel closed during operation and back up the workbook before upgrading. Existing hidden capture records gain a revision field; repeat old pending scans. The hardened ticket-based backend from version 1.1 is used instead of the uploaded direct-registration endpoint.

## Local image pipeline

The generic QR decoder tries BarcodeDetector when available, then bounded jsQR and ZXing full-image/region/scale/contrast attempts. Serial validation is separate. No QR payload URL is visited.

Battery processing detects the green panel, normalizes orientation and reads a localized status crop. An operator crop instead maps CSS pixels to natural image coordinates with a safety margin. Contain/cover mapping is tested; devicePixelRatio is not applied twice. Browser decoding applies image orientation metadata; manual rotation handles visually rotated pictures. General perspective rectification is not implemented.

Tesseract.js 7 uses matching local worker/core/English assets. Crops are processed with original, downscale, upscale, gray, contrast, sharpening, threshold and green-channel variants. Only 0–100 followed by % is valid. At least two methods must agree with high confidence; conflicting credible readings are rejected. Scores are not calibrated probabilities and do not guarantee correctness.

Only extracted structured readings and ticket metadata reach the backend. Transient canvases, object URLs and workers are cleaned up. No analytics, external QR/OCR service, service worker or offline write queue is used. CSP allows blob images for temporary local previews only.

## Tests and reproduction

Frontend: npm ci --ignore-scripts; npm run ocr-assets; npm run typecheck; npm run lint; npm test; npm run build. Backend: install requirements.txt in a Python 3.12 virtual environment, then run python -m pytest -q from backend.

Browser: install Playwright Chromium, build, set up certificates and stop regular servers; run `npm run test:browser -- C:\path\to\sample_photo.png` from frontend. The harness uses real file inputs and a temporary workbook, but test-certificate bypass is confined to its browser context and does not prove Android CA trust.

See validation/ for the image inventory, per-attempt raw data and test logs. Original photos are excluded from the ZIP and remain unchanged. They must be supplied separately for reproduction.

## Limits

Use an isolated trusted LAN: no login or physical-device attestation exists. Origin/host checks are not authentication. Excel assumes one laptop/local disk. Windows scripts, Android camera behavior, certificate trust, firewall, Wi-Fi, performance and memory require physical checks. The automated sample report explicitly lists remaining failures.
