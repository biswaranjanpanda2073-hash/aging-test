# Real-image validation — 26 September 2026

**Acceptance: FAIL for unattended automatic reading.** The project and operator-guided photo workflow are implemented, but several supplied photos remain unreadable. Do not treat successful unit/build tests as universal OCR validation.

## Summary

All **41 available files** were processed independently through the actual QR and battery functions: 26 photos in SAMPLE IMAGE, 12 existing diagnostic crops, and 3 earlier attachments. There are 41 distinct file hashes. Original bytes were verified unchanged.

| Content-bearing samples | Found / tested | PASS | FAIL | Pass rate |
|---|---:|---:|---:|---:|
| QR visible | 17 / 17 | 12 | 5 | 70.6% |
| Battery visible | 30 / 30 | 5 | 25 | 16.7% |

The other 24 images have no complete device QR; the other 11 have no device battery percentage. They were also processed as negative controls, and are marked N/A below rather than counted as successful reads. Across all 41 inputs, QR decoding succeeded on 12 and correct battery reading on 5; absent content is not a successful extraction.

Wrong accepted battery readings in this final run: **0**. Expected battery values were visually labeled for comparison only; they are never supplied to application recognition. QR PASS means an actual decoder payload was obtained; no complete independent ground-truth serial list was supplied. Two different device serial payloads were decoded, and four unrelated synthetic QR payloads also passed separately.

## What changed

- Native rear-camera file inputs for QR and battery, with serial confirmation, photo rotation, adjustable green crop, review and save. No live preview is used.
- Generic BarcodeDetector/jsQR/ZXing decoding with bounded full-image, region, overlap, scaling and contrast attempts. Serial validation remains separate; URLs are never visited.
- Green-panel localization and orientation attempts; manual guide mapping from displayed CSS pixels to natural image pixels with margin. Portrait/landscape and contain/cover mapping are covered by unit tests.
- Matching Tesseract.js 7 assets, real awaited worker initialization, localized OCR, contrast/channel/threshold/scale variants and strict percent parsing.
- A 46% image was incorrectly read as 48% during development. Final validation requires agreement across preprocessing methods and rejects conflicting credible readings. The affected `IMG_20260925_153121.jpg` is rejected as ambiguous in the final run.
- Temporary blob image URLs are permitted by the image CSP, fixing actual file-input decoding under the built server. No external image/OCR service was added.
- Ticket-based record updates, duplicate rejection and nullable device time retained. Phone ISO timestamps are not substituted for device time.

## Actual verification

75 backend tests and 75 frontend tests passed; TypeScript, ESLint and production build passed. Built HTTPS browser integration passed with real file inputs, QR/OCR, an operator-selected battery crop, confirmation and saving through the real API to a temporary workbook. It checked no live camera call, no image body, no external HTTP requests, mobile fit and cancellation. It did not operate Android hardware.

Backend tests exercise complete H1–H4/restart/post-aging flows and one-row storage, wrong device, replay, stale state, timing, invalid values, duplicates, concurrent writes and atomic-write failure. Registration sends only serial_number, battery_percent, device_timestamp and capture_token. No photo bytes are stored in Excel.

Four synthetic QR cases (two other serials, a URL payload and plain text) passed; these are excluded from real-photo rates. npm audit reported no known vulnerabilities at this run. One upstream test-client deprecation warning and the production bundle-size advisory remain; neither is a failed test.

The earlier uploaded-pipeline probes were exploratory and incomplete; their results are not used for the final rates. Every final rate above is from the complete delivered-pipeline batch. The reported 'undefined recognize' initialization error was not reproduced in the final run; asset/API matching was checked through actual OCR execution.

## Reading the tables

PASS requires an actual decoded QR or battery result matching the labeled percentage. FAIL means content is present but extraction/validation failed. N/A means the relevant content is absent and is a negative control; no successful extraction is claimed. All per-attempt raw strings, timing and confidence are preserved in validation/sample-results.json.

For automatic battery crops, the listed rectangle bounds the detected panel in original-image pixels. Apply the recorded orientation, then crop x=.12, y=.035, width=.20, height=.11 of that rotated panel. This is relative to detected content, not fixed photo coordinates. The table shows the final raw OCR attempt when no result was accepted; the JSON contains every attempt. Timing includes local computation and is not an Android performance claim.

## QR validation

| Filename | Width | Height | Orientation | QR detected | Decoded value | Attempts | Successful method | Time ms | PASS/FAIL | Failure reason |
|---|---:|---:|---|---|---|---:|---|---:|---|---|
|SAMPLE IMAGE/1000367765.jpg|691|1536|portrait|NO|—|15|—|4520|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260924_124404.jpg|4608|2592|landscape|YES|T130R4CIK54677|6|center-expanded|2738|PASS||
|SAMPLE IMAGE/IMG_20260924_124404_1.jpg|3088|1006|landscape|YES|T130R4CIK54677|1|full-image|195|PASS||
|SAMPLE IMAGE/IMG_20260924_124425.jpg|4608|2592|landscape|YES|T130R4CIK54677|13|ZXing-full|5740|PASS||
|SAMPLE IMAGE/IMG_20260924_124426.jpg|2780|934|landscape|YES|T130R4CIK54677|2|right-side|266|PASS||
|SAMPLE IMAGE/IMG_20260925_153119.jpg|4608|2592|landscape|NO|—|15|—|6440|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153121.jpg|4608|2592|landscape|NO|—|15|—|9272|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153125.jpg|4608|2592|landscape|NO|—|15|—|3116|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153128.jpg|4608|2592|landscape|NO|—|15|—|3352|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153132.jpg|4608|2592|landscape|NO|—|15|—|4409|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153141.jpg|2592|4608|portrait|NO|—|15|—|6733|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153144.jpg|2592|4608|portrait|NO|—|15|—|6941|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153208.jpg|2592|4608|portrait|NO|—|15|—|2229|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153212.jpg|2592|4608|portrait|NO|—|15|—|3189|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_153215.jpg|2592|4608|portrait|NO|—|15|—|2386|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161633.jpg|4608|2592|landscape|YES|T120R4CBK23922|12|full-image-contrast|1973|PASS||
|SAMPLE IMAGE/IMG_20260925_161635.jpg|4608|2592|landscape|NO|—|15|—|4718|FAIL|Decoder stage: visible QR, but all bounded jsQR/ZXing region/scale/contrast attempts yielded no payload. Exact optical cause is not proven; retake in focus with quiet zone.|
|SAMPLE IMAGE/IMG_20260925_161638.jpg|4608|2592|landscape|NO|—|15|—|3736|FAIL|Decoder stage: visible QR, but all bounded jsQR/ZXing region/scale/contrast attempts yielded no payload. Exact optical cause is not proven; retake in focus with quiet zone.|
|SAMPLE IMAGE/IMG_20260925_161643.jpg|4608|2592|landscape|YES|T120R4CBK23922|10|tile-0.4-0.4|2662|PASS||
|SAMPLE IMAGE/IMG_20260925_161647.jpg|4608|2592|landscape|YES|T120R4CBK23922|1|full-image|381|PASS||
|SAMPLE IMAGE/IMG_20260925_161650.jpg|4608|2592|landscape|NO|—|15|—|5336|FAIL|Decoder stage: visible QR, but all bounded jsQR/ZXing region/scale/contrast attempts yielded no payload. Exact optical cause is not proven; retake in focus with quiet zone.|
|SAMPLE IMAGE/IMG_20260925_161653.jpg|4608|2592|landscape|NO|—|15|—|6066|FAIL|Decoder stage: visible QR, but all bounded jsQR/ZXing region/scale/contrast attempts yielded no payload. Exact optical cause is not proven; retake in focus with quiet zone.|
|SAMPLE IMAGE/IMG_20260925_161655.jpg|4608|2592|landscape|YES|T120R4CBK23922|13|ZXing-full|3941|PASS||
|SAMPLE IMAGE/IMG_20260925_161702.jpg|4608|2592|landscape|NO|—|15|—|3218|FAIL|Decoder stage: visible QR, but all bounded jsQR/ZXing region/scale/contrast attempts yielded no payload. Exact optical cause is not proven; retake in focus with quiet zone.|
|SAMPLE IMAGE/IMG_20260925_161706.jpg|4608|2592|landscape|YES|T120R4CBK23922|1|full-image|438|PASS||
|SAMPLE IMAGE/sample_photo.png|1536|516|landscape|YES|T130R4CIK54677|2|right-side|198|PASS||
|frontend/battery-crop-debug.png|768|206|landscape|NO|—|15|—|551|N/A|Required content absent; rejection expected (negative control).|
|frontend/battery-crop-processed.png|768|206|landscape|NO|—|15|—|617|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-1.png|490|154|landscape|NO|—|15|—|512|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-10.png|735|231|landscape|NO|—|15|—|683|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-2.png|490|154|landscape|NO|—|15|—|456|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-3.png|490|154|landscape|NO|—|15|—|540|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-4.png|490|154|landscape|NO|—|15|—|451|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-5.png|490|154|landscape|NO|—|15|—|454|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-6.png|490|154|landscape|NO|—|15|—|533|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-7.png|735|231|landscape|NO|—|15|—|758|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-8.png|735|231|landscape|NO|—|15|—|631|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-9.png|735|231|landscape|NO|—|15|—|726|N/A|Required content absent; rejection expected (negative control).|
|earlier-attachments/208b5324-d1f3-4dff-bf7c-e5053407dc8b.jpeg|921|2048|portrait|NO|—|15|—|1172|N/A|Required content absent; rejection expected (negative control).|
|earlier-attachments/3f3ca86d-de39-4126-b038-aa7b2207a3e2.png|1536|516|landscape|YES|T130R4CIK54677|2|right-side|194|PASS||
|earlier-attachments/86da599e-fdd5-4861-9064-79f2c631dc21.png|1536|516|landscape|YES|T130R4CIK54677|2|right-side|187|PASS||

## Battery validation

| Filename | Width | Height | Orientation | Crop / rotation | OCR raw result | Parsed % | Expected % | Attempts | Successful method | Time ms | PASS/FAIL | Failure reason |
|---|---:|---:|---|---|---|---:|---:|---:|---|---:|---|---|
|SAMPLE IMAGE/1000367765.jpg|691|1536|portrait|{'x': 89.6, 'y': 611.84, 'width': 517.12, 'height': 552.96}; rotation 269.4||—|84|35|—|4546|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260924_124404.jpg|4608|2592|landscape|{'x': 867.8399999999999, 'y': 990.7199999999999, 'width': 1013.7599999999999, 'height': 1067.52}; rotation 90|a|—|84|34|—|8136|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260924_124404_1.jpg|3088|1006|landscape|{'x': 0, 'y': 0, 'width': 936.6933333333334, 'height': 998.4533333333334}; rotation 270||—|84|35|—|7953|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260924_124425.jpg|4608|2592|landscape|{'x': 1520.6399999999999, 'y': 576, 'width': 829.4399999999999, 'height': 929.28}; rotation 179.2|=|—|84|38|—|7881|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260924_124426.jpg|2780|934|landscape|{'x': 0, 'y': 0, 'width': 843.2666666666667, 'height': 931.3000000000001}; rotation 270|a|—|84|39|—|7713|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_153119.jpg|4608|2592|landscape|{'x': 1774.08, 'y': 330.23999999999995, 'width': 1927.6799999999998, 'height': 1727.9999999999998}; rotation 268.6||—|46|33|—|5431|FAIL|Validation stage: credible preprocessing readings conflict; rejected rather than choosing a number.|
|SAMPLE IMAGE/IMG_20260925_153121.jpg|4608|2592|landscape|{'x': 2065.92, 'y': 852.4799999999999, 'width': 1152, 'height': 1029.12}; rotation 90|48%|—|46|35|—|4359|FAIL|Validation stage: credible preprocessing readings conflict; rejected rather than choosing a number.|
|SAMPLE IMAGE/IMG_20260925_153125.jpg|4608|2592|landscape|{'x': 2173.44, 'y': 0, 'width': 2158.08, 'height': 1996.8}; rotation 77.2|48%|—|46|33|—|6391|FAIL|Validation stage: credible preprocessing readings conflict; rejected rather than choosing a number.|
|SAMPLE IMAGE/IMG_20260925_153128.jpg|4608|2592|landscape|{'x': 1459.1999999999998, 'y': 430.08, 'width': 1766.3999999999999, 'height': 1628.1599999999999}; rotation 259.4||—|46|33|—|6113|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_153132.jpg|4608|2592|landscape|{'x': 921.5999999999999, 'y': 184.32, 'width': 2165.7599999999998, 'height': 2050.56}; rotation 287.9|46%|46|46|32|green-panel-top-strip-contrast|6739|PASS||
|SAMPLE IMAGE/IMG_20260925_153141.jpg|2592|4608|portrait|{'x': 253.43999999999997, 'y': 1927.6799999999998, 'width': 1390.08, 'height': 1413.12}; rotation 449.5|Q 46%|46|46|33|green-panel-top-strip-contrast|4917|PASS||
|SAMPLE IMAGE/IMG_20260925_153144.jpg|2592|4608|portrait|{'x': 261.12, 'y': 1351.6799999999998, 'width': 2027.5199999999998, 'height': 1850.8799999999999}; rotation 320.2||—|46|32|—|5054|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_153208.jpg|2592|4608|portrait|{'x': 161.28, 'y': 1612.8, 'width': 2426.8799999999997, 'height': 2611.2}; rotation 343.5||—|46|35|—|6596|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_153212.jpg|2592|4608|portrait|{'x': 798.7199999999999, 'y': 1128.9599999999998, 'width': 1789.4399999999998, 'height': 2004.4799999999998}; rotation 184.7||—|46|37|—|7251|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_153215.jpg|2592|4608|portrait|{'x': 99.83999999999999, 'y': 1328.6399999999999, 'width': 1889.28, 'height': 2088.96}; rotation 173.2|TR|—|46|33|—|6537|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_161633.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|49|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161635.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|50|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161638.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|66|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161643.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|49|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161647.jpg|4608|2592|landscape|{'x': 698.88, 'y': 1213.4399999999998, 'width': 1382.3999999999999, 'height': 1374.7199999999998}; rotation 126.9|\| g .|—|47|33|—|6018|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/IMG_20260925_161650.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|47|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161653.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|45|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161655.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|50|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161702.jpg|4608|2592|landscape|None; rotation 0||—|—|0|—|49|N/A|Required content absent; rejection expected (negative control).|
|SAMPLE IMAGE/IMG_20260925_161706.jpg|4608|2592|landscape|{'x': 61.44, 'y': 1105.9199999999998, 'width': 1359.36, 'height': 1344}; rotation 391.0|8 47%|—|47|34|—|6346|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|SAMPLE IMAGE/sample_photo.png|1536|516|landscape|{'x': 0, 'y': 0, 'width': 465.92, 'height': 514.56}; rotation 270|84% 3|84|84|33|green-panel-top-strip-contrast|4473|PASS||
|frontend/battery-crop-debug.png|768|206|landscape|{'x': 5.12, 'y': 0, 'width': 761.6, 'height': 204.8}; rotation 270||—|—|32|—|2540|N/A|Required content absent; rejection expected (negative control).|
|frontend/battery-crop-processed.png|768|206|landscape|{'x': 0, 'y': 0, 'width': 768, 'height': 206}; rotation 0|@|—|—|8|—|1176|N/A|Required content absent; rejection expected (negative control).|
|frontend/diagnostic-crop-1.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0|\| BD 84% 34 9|—|84|8|—|1084|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-10.png|735|231|landscape|{'x': 0, 'y': 0, 'width': 735, 'height': 231}; rotation 0|BB 84%|—|84|15|—|810|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-2.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0||—|84|9|—|725|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-3.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0|8B 84%|—|84|10|—|1155|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-4.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0|\| oD 84% 4 9|84|84|13|close-up-strip-upscale|787|PASS||
|frontend/diagnostic-crop-5.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0||—|84|8|—|675|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-6.png|490|154|landscape|{'x': 0, 'y': 0, 'width': 490, 'height': 154}; rotation 0|\| Ta|—|84|8|—|1470|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-7.png|735|231|landscape|{'x': 0, 'y': 0, 'width': 735, 'height': 231}; rotation 0|BB 84%|—|84|11|—|1202|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-8.png|735|231|landscape|{'x': 0, 'y': 0, 'width': 735, 'height': 231}; rotation 0||—|84|9|—|747|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|frontend/diagnostic-crop-9.png|735|231|landscape|{'x': 0, 'y': 0, 'width': 735, 'height': 231}; rotation 0|BB 84%|—|84|10|—|1158|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|earlier-attachments/208b5324-d1f3-4dff-bf7c-e5053407dc8b.jpeg|921|2048|portrait|None; rotation 0||—|—|0|—|32|N/A|Required content absent; rejection expected (negative control).|
|earlier-attachments/3f3ca86d-de39-4126-b038-aa7b2207a3e2.png|1536|516|landscape|{'x': 0, 'y': 0, 'width': 465.92, 'height': 514.56}; rotation 270||—|84|36|—|4190|FAIL|OCR/validation stage: localized crop did not produce two agreeing readings at confidence >=85. Blur, perspective or crop accuracy may contribute; exact optical cause is not isolated.|
|earlier-attachments/86da599e-fdd5-4861-9064-79f2c631dc21.png|1536|516|landscape|{'x': 0, 'y': 0, 'width': 465.92, 'height': 514.56}; rotation 270|84% 3|84|84|33|green-panel-top-strip-contrast|4517|PASS||

## Exact failed filenames

QR:

- SAMPLE IMAGE/IMG_20260925_161635.jpg
- SAMPLE IMAGE/IMG_20260925_161638.jpg
- SAMPLE IMAGE/IMG_20260925_161650.jpg
- SAMPLE IMAGE/IMG_20260925_161653.jpg
- SAMPLE IMAGE/IMG_20260925_161702.jpg

Battery:

- SAMPLE IMAGE/1000367765.jpg
- SAMPLE IMAGE/IMG_20260924_124404.jpg
- SAMPLE IMAGE/IMG_20260924_124404_1.jpg
- SAMPLE IMAGE/IMG_20260924_124425.jpg
- SAMPLE IMAGE/IMG_20260924_124426.jpg
- SAMPLE IMAGE/IMG_20260925_153119.jpg
- SAMPLE IMAGE/IMG_20260925_153121.jpg
- SAMPLE IMAGE/IMG_20260925_153125.jpg
- SAMPLE IMAGE/IMG_20260925_153128.jpg
- SAMPLE IMAGE/IMG_20260925_153144.jpg
- SAMPLE IMAGE/IMG_20260925_153208.jpg
- SAMPLE IMAGE/IMG_20260925_153212.jpg
- SAMPLE IMAGE/IMG_20260925_153215.jpg
- SAMPLE IMAGE/IMG_20260925_161647.jpg
- SAMPLE IMAGE/IMG_20260925_161706.jpg
- frontend/diagnostic-crop-1.png
- frontend/diagnostic-crop-10.png
- frontend/diagnostic-crop-2.png
- frontend/diagnostic-crop-3.png
- frontend/diagnostic-crop-5.png
- frontend/diagnostic-crop-6.png
- frontend/diagnostic-crop-7.png
- frontend/diagnostic-crop-8.png
- frontend/diagnostic-crop-9.png
- earlier-attachments/3f3ca86d-de39-4126-b038-aa7b2207a3e2.png

## Remaining limitations and recommendation

Automatic battery OCR has not met acceptance. Use the photo/crop workflow only with operator comparison and retakes; do not deploy unattended. Confident OCR can still be wrong on unseen photos, and correlated preprocessing is not independent proof. A separate battery photograph cannot attest the same physical device as the preceding QR.

There is no login or hardware attestation. Use a trusted isolated LAN and workbook backups. Device clock is unavailable/null in the two-photo workflow; server receive time is separate. Native camera/OS software may save its own copy, although this application does not upload or persist photos.

Real Android validation remains outstanding: native camera opening/return, permission denial/cancel, portrait/landscape/EXIF, edge crops, rotation, same-file retry, glare/blur, memory/performance, HTTPS CA trust and network loss. On a backed-up test workbook, complete registration, start, H1–H4/restarts and post-aging and check the single device row. Windows scripts/firewall were reviewed but not executed on Windows here.

Original photographs, credentials, private keys, workbooks, binaries and environments are excluded from delivery. See README.md and validation/REPRODUCE.md for setup and repeatable local testing.
