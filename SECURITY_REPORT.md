# Scope and remaining risks

This update tests the local image pipeline and photo workflow; it is not a new exhaustive malware audit. Uploaded binaries, environments, keys, workbooks and sample images are not included in the deliverable. Original samples are unchanged.

The hardened backend/static server retains strict fields, bounded requests, explicit hosts/origins, capture-ticket action/device/revision/expiry/replay checks, cross-process workbook locking, atomic replacement and static path allowlisting. Photos are not accepted as API fields. The direct-registration bypass and phone timestamp substitution are not used.

CSP permits blob images for transient photo decoding while script/worker/connect sources remain local. Matching Tesseract.js 7 assets are served locally. No external decoder is called. Native camera/OS photo retention is outside the app's control.

There is no login or device attestation. Use a trusted isolated LAN, keep the same device for both photos, and verify every reading. QR matching cannot prove the origin of the separate battery photo. No error-free, malware-free or universal OCR accuracy guarantee is made. See the validation report and logs.
