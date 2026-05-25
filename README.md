# ReminderOCR

Hebrew-first document management and contract reminder platform. Upload inspection reports, contracts, and invoices — AI extracts structured data, auto-creates client and contract records, and emails reminders before expiry dates.

```
Browser → Vercel (Vue 3 SPA)
              ↓ VITE_API_BASE
Railway → Express + Node.js (API + OCR pipeline)
              ↓
MongoDB Atlas → persistent storage
DigitalOcean Spaces → file storage (optional)
```

---

## Features

- **Document ingestion** — PDF, DOCX, XLSX, PNG/JPEG/TIFF; Tesseract OCR for scanned Hebrew files
- **AI extraction** — GPT-4o-mini (or local Ollama) pulls client name, ID number, dates, contract number, and equipment list from raw text
- **Client dedup** — fuzzy name matching strips `בע"מ`/`ltd`/punctuation; also matches on national ID or phone number
- **Auto-reminders** — configurable advance-day schedule (default 90/60/30 days before expiry); email sent via SMTP with HTML templates
- **Equipment catalog** — serial-number-keyed records linked to scanned document and client
- **Multi-user auth** — Google OAuth 2.0 + email/password; all data strictly scoped to the authenticated user
- **Role system** — `user` / `pro` / `admin`; admin-only Settings page and User Management table; `user` role capped at 25 uploaded documents
- **Engineer profile** — professional details (inspector number, address, title, expertise, membership); per-user, upserted on save
- **Certificates** — attach certifications with name, type, issuer, issue/expiry dates; auto-computed active/expired status
- **In-app notifications** — stored in MongoDB, sortable, markable as read
- **Avatar upload** — stored as base64 data URL in the `users` collection (5 MB limit)
- **Contracts export** — client-side CSV export with Hebrew BOM; column/filter selection wizard; 20-per-page pagination
- **RTL Hebrew UI** — full right-to-left layout, dark/light theme, Naive UI component library

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js 20, Express, TypeScript (ESM) |
| Database | MongoDB Atlas (native driver, no Mongoose) |
| AI | OpenAI `gpt-4o-mini` · local Ollama fallback |
| OCR | Tesseract.js (Hebrew + English) |
| File storage | DigitalOcean Spaces (S3-compatible) · local disk fallback |
| Client | Vue 3, Vite, Pinia, Naive UI, Vue Router 4 |
| Auth | Google OAuth 2.0 (GIS) + bcrypt email/password + MongoDB sessions |
| Deploy | Railway (server) · Vercel (client) |

---

## Quick Start

### Prerequisites

- Node.js 20+
- MongoDB running locally (`mongodb://127.0.0.1:27017`) **or** a MongoDB Atlas URI
- OpenAI API key **or** Ollama running locally

### 1. Install

```bash
git clone <repo-url> && cd Reminder

cd server && npm install
cd ../client && npm install
```

### 2. Configure the server

```bash
cd server
cp .env.example .env   # then edit with your values
```

Minimum required vars for local dev:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
OPENAI_LOCAL_API_KEY=sk-...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3737/auth/google/callback
SESSION_SECRET=<random 32+ chars>
```

### 3. Run

```bash
# Terminal 1 — server (hot reload)
cd server && npm run dev

# Terminal 2 — client
cd client && npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api`, `/auth`, and `/ws` to the server on port 3737 — no `VITE_API_BASE` needed in dev.

---

## Environment Variables

### Server

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `MONGODB_URI` | ✓ | `mongodb://127.0.0.1:27017` | Connection string |
| `MONGODB_DB` | | `reminder-app` | Database name |
| `PORT` | | `3737` | HTTP port |
| `OPENAI_LOCAL_API_KEY` | ✓ | — | GPT-4o-mini |
| `OLLAMA_URL` | | `http://localhost:11434` | Local inference endpoint |
| `OLLAMA_MODEL` | | `llama3.1` | Ollama model name |
| `GOOGLE_CLIENT_ID` | ✓ | — | OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | ✓ | — | OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | ✓ | `http://localhost:3737/auth/google/callback` | OAuth callback URL |
| `SESSION_SECRET` | ✓ | — | Cookie signing secret (32+ chars) |
| `ALLOWED_EMAILS` | | — | Comma-separated Google email whitelist |
| `SMTP_HOST` | ✓ | — | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | | `587` | |
| `SMTP_SECURE` | | `false` | `true` for port 465 |
| `SMTP_USER` | ✓ | — | SMTP login |
| `SMTP_PASS` | ✓ | — | SMTP password or Gmail app password |
| `EMAIL_FROM` | ✓ | — | Sender address |
| `EMAIL_FROM_NAME` | | `ReminderOCR` | Sender display name |
| `ALLOWED_ORIGINS` | | `http://localhost:5173` | CORS origins (comma-separated) |
| `SERVER_URL` | | — | Public URL for email verification links |
| `DATA_DIR` | | `./data` | Local data directory |
| `DO_SPACES_KEY` | | — | DigitalOcean Spaces access key |
| `DO_SPACES_SECRET` | | — | DigitalOcean Spaces secret |
| `DO_SPACES_ENDPOINT` | | — | e.g. `fra1.digitaloceanspaces.com` |
| `DO_SPACES_BUCKET` | | — | Bucket name |
| `DO_SPACES_REGION` | | — | e.g. `fra1` |
| `USER_DOCUMENT_LIMIT` | | `25` | Max documents for `user` role (`pro`/`admin` unlimited) |

### Client (build-time, `client/.env.production`)

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE` | Railway server URL e.g. `https://your-server.up.railway.app` |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID (same value as server) |

---

## Project Structure

```
reminder/
├── server/src/
│   ├── index.ts                  # Express bootstrap, middleware, route registration
│   ├── settings.ts               # App config (env vars + data/settings.json overlay)
│   ├── auth/
│   │   ├── middleware.ts         # requireAuth, requireRole, HTTPException
│   │   ├── session.ts            # MongoDB session create/verify/revoke
│   │   ├── emailAuth.ts          # Email/password register, login, reset, verify
│   │   └── google.ts             # Google OAuth 2.0 flow
│   ├── db/
│   │   └── db.ts                 # connectDb, col(), ensureCollections, applyIndexes
│   ├── pipeline/
│   │   ├── importer.ts           # importFile → processDocument → saveEntities
│   │   ├── extractor.ts          # OpenAI / Ollama field extraction
│   │   ├── pdfParser.ts          # pdf-parse + OCR fallback
│   │   ├── ocrParser.ts          # Tesseract.js (heb+eng)
│   │   ├── docxParser.ts         # Mammoth DOCX → plain text
│   │   └── xlsxParser.ts         # SheetJS XLSX → plain text
│   ├── reminders/
│   │   ├── scheduler.ts          # Background timer, generateContractReminders
│   │   └── emailSender.ts        # Nodemailer + HTML template rendering
│   ├── routes/                   # One file per resource (see API Reference)
│   ├── storage/spaces.ts         # DigitalOcean Spaces upload + presigned URLs
│   ├── templates/                # Doc templates, email templates, prompt builder
│   └── __tests__/                # Vitest unit tests (78 tests)
│
└── client/src/
    ├── main.ts                   # App entry, background session validation
    ├── App.vue                   # Shell: appbar, RTL config, theme, nav
    ├── router/index.ts           # Vue Router — auth guard, role check → /403
    ├── stores/                   # Pinia: auth, documents, clients, contracts, …
    ├── services/apiService.ts    # Typed fetch wrapper for every endpoint
    ├── views/                    # 14 page components (one per route)
    ├── components/               # Reusable: UserDropdown, WsConnector, …
    └── shared/types.ts           # TypeScript interfaces shared with server
```

---

## API Reference

All protected routes require a valid session cookie (`sid`). Unauthenticated requests return `401`. Insufficient role returns `403`.

### Authentication

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| `POST` | `/api/auth/register` | — | Email/password registration |
| `GET` | `/auth/verify-email` | — | Email verification link handler |
| `POST` | `/api/auth/login` | — | Email/password login |
| `POST` | `/api/auth/logout` | ✓ | Revoke session |
| `GET` | `/api/auth/me` | — | Current user (null if not logged in) |
| `POST` | `/api/auth/forgot-password` | — | Send password reset email |
| `POST` | `/api/auth/reset-password` | — | Complete password reset |
| `GET` | `/auth/google` | — | Start Google OAuth redirect |
| `GET` | `/auth/google/callback` | — | OAuth callback |
| `POST` | `/api/auth/google` | — | GIS one-tap credential sign-in |

### Documents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/documents` | List documents (user-scoped, paginated) |
| `GET` | `/api/documents/:id` | Single document detail |
| `POST` | `/api/documents/import` | Upload + process file (multipart) |
| `POST` | `/api/documents/:id/reprocess` | Re-run AI extraction |
| `DELETE` | `/api/documents/:id` | Delete document |

### Clients

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/clients` | List (`?q=` search, paginated) |
| `POST` | `/api/clients` | Create client |
| `GET` | `/api/clients/:id` | Detail + doc/contract/reminder counts |
| `PUT` | `/api/clients/:id` | Update client |
| `DELETE` | `/api/clients/:id` | Delete client |
| `GET` | `/api/clients/:id/documents` | Documents linked to client |
| `GET` | `/api/clients/:id/timeline` | Event timeline |

### Contracts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/contracts` | List (`?clientId=`, `?status=`, `?kind=contract\|inspection`) |
| `POST` | `/api/contracts` | Create contract |
| `GET` | `/api/contracts/expiring` | Contracts expiring within `?days=30` |
| `GET` | `/api/contracts/:id` | Detail |
| `PUT` | `/api/contracts/:id` | Update (regenerates reminders if expiry changed) |
| `DELETE` | `/api/contracts/:id` | Delete |

### Reminders

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reminders` | List (`?status=`, `?days=`) |
| `POST` | `/api/reminders` | Create manual reminder |
| `PUT` | `/api/reminders/:id` | Update |
| `POST` | `/api/reminders/:id/dismiss` | Mark dismissed |
| `POST` | `/api/reminders/:id/snooze` | Snooze until date |
| `POST` | `/api/reminders/:id/send-now` | Force-send email immediately |

### Equipment

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/equipment` | List (`?category=`, `?q=`, `?client_id=`) |
| `GET` | `/api/equipment/stats` | Count per category |
| `GET` | `/api/equipment/:id` | Detail |
| `POST` | `/api/equipment` | Create |
| `PUT` | `/api/equipment/:id` | Update |
| `DELETE` | `/api/equipment/:id` | Delete |
| `POST` | `/api/equipment/backfill` | Patch missing client_id/document_id from extractions |

### Other

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| `GET` | `/api/dashboard/stats` | ✓ | Home page aggregates (user-scoped) |
| `GET` | `/api/search?q=` | ✓ | Cross-collection full-text search |
| `GET` | `/api/profile/stats` | ✓ | Reminder counts (active / snoozed / completed / monthly) |
| `GET` | `/api/profile/engineer` | ✓ | Engineer professional profile |
| `PUT` | `/api/profile/engineer` | ✓ | Save engineer profile (upsert) |
| `PUT` | `/api/profile` | ✓ | Update name + phone on user account |
| `POST` | `/api/profile/avatar` | ✓ | Upload profile avatar (multipart, 5 MB) |
| `GET` | `/api/profile/certificates` | ✓ | List certificates |
| `POST` | `/api/profile/certificates` | ✓ | Add certificate |
| `DELETE` | `/api/profile/certificates/:id` | ✓ | Delete certificate (owner-scoped) |
| `GET` | `/api/profile/notifications` | ✓ | List last 50 notifications |
| `PUT` | `/api/profile/notifications/:id/read` | ✓ | Mark notification as read |
| `POST` | `/api/auth/change-password` | ✓ | Change password (bcrypt verify + rehash) |
| `GET` | `/api/user-settings` | ✓ | Per-user preferences |
| `PUT` | `/api/user-settings` | ✓ | Save preferences |
| `GET` | `/api/settings` | admin | Global app settings |
| `POST` | `/api/settings` | admin | Update global settings |
| `GET` | `/api/admin/users` | admin | List all users |
| `PUT` | `/api/admin/users/:id` | admin | Update role / active status |
| `GET` | `/api/tasks` | ✓ | Task list |
| `PUT` | `/api/tasks/:id` | ✓ | Update task |

---

## Document Processing Flow

```
POST /api/documents/import
  │
  ├─ SHA-256 dedup (file_hash, scoped to user)
  ├─ Copy → data/documents/<hash>.<ext>
  ├─ Upload to DigitalOcean Spaces (if configured)
  │
  ├─ Text extraction
  │   ├─ PDF   → pdf-parse → OCR fallback if no text layer
  │   ├─ Image → Tesseract.js (heb+eng)
  │   ├─ DOCX  → Mammoth
  │   └─ XLSX  → SheetJS
  │
  ├─ Template matching (pickTemplate)
  │   ├─ Match  → extractWithTemplate (structured per-template prompt)
  │   └─ No match → extractDocument (generic extraction prompt)
  │
  └─ saveEntities (user-scoped)
      ├─ findOrCreateClient
      │   └─ dedup: id_number → phone → exact name → normalised name
      ├─ upsert contract (keyed on document_id, unique+sparse index)
      ├─ insert tasks
      ├─ upsert equipment (keyed on serial_number)
      └─ generateContractReminders (one per advance day)
```

---

## Reminder Scheduling

```
generateContractReminders(contractId, clientId, documentId, expiryDate, userId)
  → for each day in [90, 60, 30] (configurable):
      triggerDate = expiryDate − N days
      skip if triggerDate ≤ today
      skip if reminder already exists (source_type + source_id + advance_days)
      insert reminder with status=pending

Background scheduler (every 60 s)
  → find reminders: status=pending AND trigger_date ≤ today
  → skip if already in email_log (success=1)
  → enrich with client + document context
  → sendReminderEmail() via Nodemailer
  → log to email_log
  → mark status=sent  (or status=error after 3 consecutive failures)
```

---

## Roles

| Role | Access |
|------|--------|
| `user` | Own documents, clients, contracts, reminders, equipment, tasks |
| `pro` | Same as `user` (reserved for future plan features) |
| `admin` | Everything + `/settings` page + User Management table in Profile |

Enforced server-side by `requireRole(ctx, minRole)` in `auth/middleware.ts`.  
Enforced client-side by router guard (`meta.requireRole`) and nav filtering (`primaryNav` computed).

---

## MongoDB Collections

| Collection | Purpose | Key unique indexes |
|-----------|---------|-------------------|
| `users` | Auth accounts (name, email, phone, picture_url) | `email`, `google_sub` |
| `sessions` | Active sessions (TTL) | `expires_at` (TTL index) |
| `oauth_states` | PKCE state (10-min TTL) | `expires_at` (TTL index) |
| `user_settings` | Per-user preferences (theme, ocr_language, reminder_advance_days) | `user_id` |
| `documents` | File records | `file_hash` |
| `document_clients` | Document ↔ Client join | `(document_id, client_id)` |
| `clients` | Contact records | — |
| `contracts` | Contract/inspection records | `document_id` (sparse) |
| `reminders` | Scheduled email alerts | — |
| `tasks` | Action items | — |
| `extractions` | Raw AI output (audit log) | — |
| `timeline_events` | Per-client event history | — |
| `email_log` | Sent email audit log | — |
| `equipment` | Equipment catalog | `serial_number` (sparse) |
| `doc_templates` | AI extraction templates | `name` |
| `email_templates` | HTML email designs | `name` |
| `engineer_profiles` | Professional engineer details per user | `user_id` (unique sparse) |
| `certificates` | User certifications | `user_id`, `expiry_date` |
| `notifications` | In-app notification feed | `user_id`, `created_at`, `read` |

---

## Tests

```bash
cd server && npm test       # vitest run — 121 tests
```

| File | Coverage |
|------|---------|
| `roles.test.ts` | `requireRole`, `requireAdmin`, role hierarchy |
| `profile.test.ts` | User-settings upsert, stats query shapes |
| `profileRoutes.test.ts` | Engineer profile, certificates, notifications, avatar, password change, personal info patch |
| `documentQuota.test.ts` | Upload quota logic (user/pro/admin roles, single/multi-file, per-user scoping) |
| `renderEmail.test.ts` | HTML template `{{var}}` substitution |
| `keyScanner.test.ts` | Credential key detection in extracted text |
| `emailAuth.test.ts` | bcrypt hashing and verification |

---

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full step-by-step guide. Summary:

1. Deploy `server/` to **Railway** → set all env vars → copy the generated domain
2. Set `VITE_API_BASE=<railway-domain>` in `client/.env.production`
3. Deploy `client/` to **Vercel** → set `VITE_API_BASE` and `VITE_GOOGLE_CLIENT_ID` in Vercel dashboard
4. In Google Cloud Console → OAuth client → add the production domains to Authorized Origins and Redirect URIs

---

## Development Scripts

```bash
# Server
cd server
npm run dev          # tsx watch — hot reload
npm run build        # tsc --noEmit (type check only)
npm test             # vitest run
npm run test:watch   # vitest watch

# Client
cd client
npm run dev          # Vite dev server on :5173
npm run build        # Production bundle → client/dist/
```

---

## License

Private — all rights reserved.
