# Tohands Production Aging Test — Standard Operating Procedure (SOP)

**Document ID**: SOP-PRD-AGING-001  
**Version**: 2.0 (Neon PostgreSQL & Local-First IndexedDB Edition)  
**Effective Date**: November 2026  
**Audience**: Assembly Line Operators, Quality Control (QC) Technicians, Production Supervisors  

---

## 1. Overview & Purpose

This SOP outlines the end-to-end operation for the **Tohands Smart Calculator Aging Test Workflow**. The process validates battery degradation, screen reliability, firmware stability, and power button functionality across a continuous 4-hour cycle before packaging.

```
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  01. Registration      │ ───► │  02. 4-Hour Aging Test │ ───► │  03. Post-Aging Test   │
│  • QR Serial Capture   │      │  • Checkpoints H1 - H4 │      │  • Battery (70%-100%)  │
│  • Strict 100% Battery │      │  • Issue Categorization│      │  • Long Press Power    │
│  • Ticket Verification │      │  • Auto-Restart Logic  │      │  • Packing Ready Flag  │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
```

---

## 2. Key Policies & Thresholds

| Stage | Parameter | Requirement | Action if Failed |
| :--- | :--- | :--- | :--- |
| **Registration** | Initial Battery | Must be **100%** | Marked `WAITING_FOR_100_PERCENT_CHARGE`. Return device to charging dock. |
| **Checkpoint H1** | Starting Battery | Strictly **100%** | Cannot record H1 under 100%. Device must be fully charged before starting. |
| **Checkpoints H2–H4** | Interval | **60 minutes** per stage | System prevents early submissions until countdown timer expires. |
| **Post-Aging** | Final Battery | **70% to 100%** | Reject for re-inspection if battery drops below 70%. |
| **Post-Aging** | Power Button | Long-press power test | Must **Pass** physical shutdown/startup test. |

---

## 3. Module 01: Device Registration

```
[Start Photo Capture] ──► [Take QR Photo] ──► [Confirm Serial] ──► [Take Battery Photo] ──► [Confirm & Save]
```

### Step 1.1: Physical Setup
1. Ensure the device has been charged to 100% on the charging dock.
2. Open the Aging Test Web Application on your workstation or Android mobile scanner.
3. Select **Module 01: Device Registration**.

### Step 1.2: Scan QR Code (Serial Number)
1. Tap **Start Photo Capture**.
2. Tap **Take QR Photo** to open the camera.
3. Align the QR code printed on the bottom label of the calculator inside the camera viewfinder and snap the photo.
4. Verify the decoded serial number displayed on screen (format: `T001R0ABC00001`).
   * *Alternative*: If the QR code is damaged or unreadable, tap **Enter Serial Manually** and type the serial.

### Step 1.3: Capture Battery Percentage
1. Tap **Take Battery Photo**.
2. Align the calculator screen showing the battery indicator and percentage.
3. Snap the photo.
4. The application automatically crops the green battery region and performs OCR:
   * If OCR recognizes the percentage, verify the number on screen matches the physical display.
   * If the guide box is misaligned, drag the corners of the green crop box around **only the battery digits and % symbol**.
   * *Alternative*: If the display has heavy glare or reflection, tap **Enter Battery Manually** to input the exact visible value.

### Step 1.4: Confirm & Save
1. Review the serial and battery percentage.
2. Tap **Confirm & Register**:
   * **If 100%**: Status shows `READY_FOR_AGING`. Place device into the Aging Rack.
   * **If < 100%**: Status shows `WAITING_FOR_100_PERCENT_CHARGE`. Keep device on the charger until it reaches 100%.

---

## 4. Module 02: 4-Hour Aging Test (Checkpoints H1 to H4)

```
[Module 02] ──► [Find Device (QR/Manual)] ──► [Select Checkpoint] ──► [Capture Battery] ──► [Log Observations] ──► [Confirm]
```

### Step 2.1: Locate Device
1. Open **Module 02: Aging Test**.
2. Tap **Scan Device QR** to scan the device, or enter the serial in the search bar.
3. The device card will load showing its current state and next due time.

### Step 2.2: Checkpoint H1 (Hour 1 — Strict 100% Rule)
1. When the device is placed on the aging rack and ready to start, select **H1**.
2. Take the battery photo.
3. **Strict Validation**: The battery **must be 100%**. If the device has drained to 99% or below before H1 is recorded, the application will block submission. Recharge the device to 100% before proceeding.
4. Inspect the screen and behavior for defects (see Step 2.4).
5. Tap **Confirm Checkpoint Reading**. The timer for H2 (1 hour) starts automatically.

### Step 2.3: Checkpoints H2, H3, and H4 (Hourly Checks)
1. Retrieve the device when the due time arrives (indicated by a `Due now` badge or 0s remaining).
2. Scan the device QR code.
3. Select the due checkpoint (**H2**, **H3**, or **H4**).
4. Capture the battery photo and confirm the reading.

### Step 2.4: Observation & Defect Logging
At every checkpoint, inspect the physical device and answer the prompt:
* **"Any issues observed?"**
  * **No**: Select `No` and proceed.
  * **Yes**: Select `Yes`, and check all applicable issue categories:
    * `[ ] Display issue` (e.g. flickering, dead pixels, missing segments)
    * `[ ] Crashing / hanging issue` (e.g. unresponsive keypad, frozen screen)
    * `[ ] Other issue` (e.g. abnormal heat, physical defect)
  * Enter a brief explanation in the **Remarks** field.

### Step 2.5: Restart Workflow
If a device suffers a crash or is rebooted during aging:
1. The app flags `Restart Required`.
2. The operator must confirm the restart on screen to reset the interval timer.

---

## 5. Module 03: Post-Aging Test (Packing Readiness)

```
[Module 03] ──► [Scan Device] ──► [Battery Check 70%-100%] ──► [Power Button Test] ──► [Confirm Packing Ready]
```

### Step 3.1: Locate Device
1. Once H4 is completed, the device status transitions to `AGING_TEST_COMPLETE`.
2. Move the device to the Post-Aging QC station.
3. Select **Module 03: Post Test**.
4. Scan the device QR code.

### Step 3.2: Battery Level Check
1. Take the final battery photograph.
2. **Acceptance Criteria**: Battery percentage must be between **70% and 100%**.
   * *If below 70%*: The device has excessive battery drain during 4-hour standby. Flag for battery replacement / engineering review.

### Step 3.3: Long-Press Power Button Test
1. Perform physical test: Press and hold the power button for 3 seconds.
2. Confirm the device initiates a clean shutdown or power cycle.
3. On screen, select the **Power Test Result**:
   * **Pass**: Device powered on/off normally.
   * **Fail**: Button is sticky, unresponsive, or device refused to turn off.

### Step 3.4: Final Inspection & Sign-off
1. Select any remaining issue observations (or `No`).
2. Tap **Confirm & Save to Excel / Database**.
3. Status changes to **`PACKING_READY`**.
4. Affix the green QC PASS sticker and transfer the device to the packaging line.

---

## 6. Offline Operation & Auto-Sync Guidelines

The application features a **Local-First IndexedDB Engine**. Operators can continue working without interruptions even if factory Wi-Fi drops.

### Understanding the Header Status Bar
* 🟢 **Synced**: All data is securely uploaded to Neon PostgreSQL and the server Excel sheet.
* 🟡 **Syncing (X pending)...**: Uploading local records in the background.
* 🔴 **Offline (X saved locally)**: Wi-Fi or backend is offline. Records are saved locally in the browser's database.

### Offline Best Practices:
1. **Never clear browser cookies or site data** while records are pending sync.
2. Continue scanning and recording as usual — the app will confirm every step instantly.
3. When Wi-Fi is restored, the app automatically flushes the queue. You can also tap **[Sync Now]** in the header to force an immediate sync.

---

## 7. App Updates ("Refresh Now" Banner)

When an update is pushed by the engineering team, a banner appears at the top of the screen:

> **🚀 A new update is available! [Refresh Now] [✕]**

* **If currently capturing a photo**: Tap **✕** to finish saving the current device first.
* **Once saved**: Tap **Refresh Now** to reload and get the latest version immediately.

---

## 8. Supervisor & Administration Guide

### 8.1 Checking Live Records in Neon Console
1. Open [Neon Console](https://console.neon.tech).
2. Go to **Tables** -> **`devices`**.
3. You can inspect all devices, H1–H4 timestamps, observations, and status in real-time.

### 8.2 Triggering Server-to-DB Resync
To resync all Excel records from the backend server into Neon PostgreSQL:
* Visit `https://aging-test.onrender.com/api/admin/resync-to-db` in your browser.
* Expected output:
  ```json
  {"total_in_excel": 25, "synced_to_db": 25, "serials": ["..."]}
  ```

### 8.3 Downloading Live Excel Backup
To download the current production Excel workbook from Render to your PC:
* Open `https://aging-test.onrender.com/api/admin/export-excel` in your browser to save `aging_test_backup.xlsx`.

---
*End of Standard Operating Procedure.*
