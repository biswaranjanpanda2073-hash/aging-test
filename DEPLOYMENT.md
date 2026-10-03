# Aging-Test — Firebase-Only Architecture

## Project structure

```
aging-test/
  firebase.json            # Hosting + Functions + Firestore config
  .firebaserc              # Firebase project alias (agingtest-57600)
  firestore.rules          # Firestore security rules
  firestore.indexes.json   # Firestore composite indexes
  package.json             # Root npm scripts (build / deploy / import)
  frontend/                # React + TypeScript + Vite SPA
  functions/               # Python 2nd-gen Cloud Functions
    main.py                # ALL API endpoints in one function
    requirements.txt       # rapidocr, onnxruntime, opencv, firebase-admin
  scripts/
    import_from_excel.mjs       # One-time Excel -> Firestore import
    import_from_supabase.mjs    # One-time Supabase CSV/JSON -> Firestore import
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 22 |
| Python | 3.12 (matches Cloud Functions runtime) |
| Firebase CLI | `npm install -g firebase-tools` |
| Google Cloud SDK (optional) | for ADC login |

---

## Firebase Console setup (one-time)

1. **Open project**: https://console.firebase.google.com/project/agingtest-57600

2. **Enable Blaze billing plan** — Cloud Functions require pay-as-you-go.
   > Console > Project Settings > Usage and billing > Modify plan > Blaze

3. **Enable Firestore** — Native mode, region `us-central1`.
   > Build > Firestore Database > Create database > Native mode

4. **Enable Authentication**.
   > Build > Authentication > Get started > Sign-in method
   - Enable **Email/Password** (for operators).
   - Optionally enable **Google** sign-in.

5. **Add the `operator: true` custom claim** to approved user accounts.
   This is done via Admin SDK or a one-time script. Example:
   ```bash
   node -e "
   const admin = require('firebase-admin');
   admin.initializeApp();
   admin.auth().getUserByEmail('operator@example.com')
     .then(u => admin.auth().setCustomUserClaims(u.uid, { operator: true }))
     .then(() => console.log('Done'))
     .catch(console.error);
   " 
   ```
   > Without this claim, Firestore rules will deny all reads/writes.

6. **Deploy initial Firestore rules & indexes**:
   ```bash
   firebase deploy --only firestore
   ```

---

## First-time local setup

```bash
# 1. Install root deps (if any)
npm install

# 2. Install frontend deps
npm install --prefix frontend

# 3. Login to Firebase
firebase login

# 4. Copy env example and fill Firebase config values
#    (get them from Firebase Console > Project Settings > Your apps > Web app)
cp frontend/.env.example frontend/.env
```

Edit `frontend/.env`:
```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=agingtest-57600.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=agingtest-57600
VITE_FIREBASE_STORAGE_BUCKET=agingtest-57600.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

---

## Local development with Firebase Emulator Suite

```bash
# Start all emulators (Functions, Firestore, Hosting)
npm run emulate
```

This starts:
- Hosting emulator: http://localhost:5000
- Functions emulator: http://localhost:5001
- Firestore emulator: http://localhost:8080
- Emulator UI: http://localhost:4000

In a separate terminal:
```bash
# Start Vite dev server (proxies /api -> emulator)
npm run dev
```

Access the app at the HTTPS address printed by Vite (port 5173).

> **Note**: The Python OCR function requires `rapidocr`, `onnxruntime`, and `opencv`
> installed in the **`functions/`** directory's Python environment.
> The Firebase CLI installs them automatically when deploying;
> for local emulation, install manually:
> ```bash
> cd functions && pip install -r requirements.txt
> ```

---

## Deploy to production

```bash
npm run deploy
```

This runs:
1. `npm run build` — TypeScript check + Vite production build
2. `firebase deploy` — deploys Hosting, Functions, and Firestore rules/indexes together

### Partial deploys

```bash
npm run deploy:hosting    # Frontend only
npm run deploy:functions  # Cloud Function only
npm run deploy:rules      # Firestore rules/indexes only
```

### Public URL

After deploy:
```
https://agingtest-57600.web.app
```

---

## Data import (non-destructive)

### From Excel workbook

```bash
# Dry run first (safe, no writes)
node scripts/import_from_excel.mjs --file data/aging_test.xlsx --dry-run

# Real import (skips serials that already exist in Firestore)
node scripts/import_from_excel.mjs --file data/aging_test.xlsx
```

### From Supabase export

```bash
# Export from Supabase Dashboard: Table Editor > devices > Export as JSON/CSV
node scripts/import_from_supabase.mjs --file supabase_export.json --dry-run
node scripts/import_from_supabase.mjs --file supabase_export.json
```

> Both scripts **skip** existing records. Original files are never modified.

---

## npm scripts reference

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript check + Vite production build |
| `npm run dev` | Vite dev server (proxies /api to emulator) |
| `npm run test` | Vitest unit tests |
| `npm run emulate` | Firebase emulators with data persistence |
| `npm run deploy` | Full build + deploy (hosting + functions + rules) |
| `npm run deploy:hosting` | Deploy frontend only |
| `npm run deploy:functions` | Deploy Cloud Function only |
| `npm run deploy:rules` | Deploy Firestore rules + indexes |
| `npm run import:excel` | Import from Excel workbook |
| `npm run import:supabase` | Import from Supabase export |

---

## Architecture overview

```
Browser (React SPA)
  │  /api/* requests
  ▼
Firebase Hosting (CDN)
  │  rewrite /api/** → Cloud Function
  ▼
Cloud Function  api  (Python 3.12, 512MB, 120s timeout)
  ├── Battery OCR (RapidOCR / ONNX / OpenCV-headless)
  ├── Workflow engine (register → start-aging → H1-H4 → post-aging)
  └── Firestore Admin SDK
          │
          ▼
     Cloud Firestore
       collections/
         devices/{serial}   — device state + observations + events
         captures/{token}   — expiring single-use capture tokens
```

### What was replaced

| Before | After |
|--------|-------|
| FastAPI on Render (port 8000) | Firebase Cloud Function |
| Supabase Postgres | Cloud Firestore |
| Excel file (`aging_test.xlsx`) | Firestore (Excel kept for import/export only) |
| `VITE_BACKEND_URL` env var | Relative `/api/` URL (Firebase Hosting rewrite) |
| Supabase Auth | Firebase Authentication (Email/Password) |

---

## Firestore data schema

### `devices/{serial_number}`

```json
{
  "serial_number": "T001RABC12345",
  "status": "AGING_HOUR_1",
  "registration_battery": 100,
  "registration_time": "2026-10-01T08:00:00Z",
  "h1_battery": 84, "h1_timestamp": "9:00 AM", "h1_server_time": "...",
  "h2_battery": null, ...
  "pending_restart": 1,
  "next_checkpoint": 1,
  "aging_started": "2026-10-01T09:00:00Z",
  "next_due": "2026-10-01T10:00:00Z",
  "last_battery": 84,
  "observations": {
    "h1": {"has_issue": "no", "categories": [], "remarks": ""},
    "h2": null, "h3": null, "h4": null, "post": null
  },
  "power_test_result": null,
  "events": [...]
}
```

### `captures/{token}`

```json
{
  "token": "abc123...",
  "action": "h1",
  "serial_number": "T001RABC12345",
  "created_at": "2026-10-01T09:00:00Z",
  "used": false,
  "revision": "<sha256 of device state at capture time>"
}
```

---

## Business rules preserved

- ✅ Register: battery < 100 → `WAITING_FOR_100_PERCENT_CHARGE`
- ✅ H1 shortcut: H1 allowed directly from READY/WAITING state (auto-starts aging)
- ✅ Checkpoints H1→H4 must be in order; timing check (`next_due`) enforced
- ✅ Restart confirmation required after each H1-H4 before next checkpoint
- ✅ Post-aging: battery ≥ 70% → `PACKING_READY`, else `POST_AGING_CHARGE`
- ✅ Capture tokens: server-generated, 180s TTL, single-use, bound to action + serial + state revision
- ✅ Issue categories: Display issue / Crashing / Other
- ✅ Power test result: Pass / Fail / Hold
- ✅ Authorized deletion only

---

## Troubleshooting

**"OCR engine still initialising"** — The ONNX model compiles on cold start. Retry after 30s.

**"Firebase Functions runtime python312 not available"** — Blaze plan required; check billing.

**Firestore permission denied** — User account needs `operator: true` custom claim (see setup step 5).

**Emulator OCR hangs** — Install `rapidocr` + `opencv-python-headless` locally in `functions/`:
```bash
cd functions && pip install -r requirements.txt
```

**`npm run deploy` fails on Windows** — Use `cmd` instead of PowerShell for the deploy step if `&&` causes issues:
```
npx npm-run-all build deploy-firebase
```
