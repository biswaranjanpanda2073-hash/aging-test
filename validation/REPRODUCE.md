# Reproduce image validation

Original photos are not included. Recreate inventory.json's relative paths beneath a separate sample-root directory: SAMPLE IMAGE/, frontend/diagnostic-crop-..., and earlier-attachments/. Do not overwrite originals.

Install project dependencies, copy OCR assets, install Playwright Chromium and run from frontend:

```powershell
node scripts/validate-samples.cjs ..\validation\inventory.json C:\sample-root C:\results.json
```

This test-only loopback server supplies original bytes to the local browser, imports the actual app functions, and records structured results. No backend receives image bytes. QR and battery are tested independently for every file, including negatives. The delivered raw results contain all attempts, text, confidence, timing and crop bounds.

Automatic crop bounds describe the detected panel in original-image pixels. Rotate that panel by the recorded rotation, then take its normalized status rectangle x=.12, y=.035, width=.20, height=.11. Operator-selected crops use original-image coordinates. Coordinates are geometric inputs, never expected battery values.

The browser integration harness tests the built application, file inputs, real QR/OCR, an operator-selected crop and real API saving with a temporary workbook. Its fixture must be the supplied full reference screen. Native Android camera behavior and TLS trust are not simulated proof of actual phone operation.

Synthetic generic QR checks encode four unrelated payloads locally and pass the rendered pixels through the actual decoder. These are separate from real-photo pass rates.
