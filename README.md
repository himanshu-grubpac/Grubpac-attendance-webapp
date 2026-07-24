# Grubpac Attendance Web App

Internal employee attendance system for **Grubpac Technologies** — React (Vite) client + Node/Express API + MongoDB.

## Prerequisites

- Node.js 18+
- MongoDB running locally (`mongodb://127.0.0.1:27017`) **or** set `USE_MEMORY_DB=true` in `server/.env` for local dev without MongoDB

## First-time setup

```powershell
cd "c:\Users\salun\Downloads\Company Data\attendance-web"
npm run install:all
copy server\.env.example server\.env
npm run seed
```

## Run the web app

From the project root (`attendance-web/`):

```powershell
npm run dev
```

This will:

1. **Kill** any existing processes on ports **5000** (API) and **5173** (client)
2. Start the **server** at http://localhost:5000
3. Start the **client** at http://localhost:5173

Open **http://localhost:5173** in your browser.

### Other commands

| Command | Description |
|---------|-------------|
| `npm run kill` | Free ports 5000 and 5173 only |
| `npm run seed` | Seed admin user + default office (kills ports first) |
| `npm run start` | Production server + dev client (kills ports first) |
| `npm run verify` | Run automated API + geo + IST verification tests |

### Default admin login

- Email: `admin@grubpac.com`
- Password: `Grubpac@Admin2026`

(Configurable in `server/.env`)

## Enterprise features

- **Multi-sample GPS** — 3 high-accuracy readings per check-in/out; best accuracy used
- **Conservative geofence** — rejects if `distance + accuracy > radius`
- **Shared Zod validation** — same rules on client (`@shared/validation`) and server
- **httpOnly session cookies** — JWT not stored in localStorage
- **Login rate limit** — 20 attempts / 15 min; attendance 15 / min
- **MongoDB transactions** — prevents duplicate check-in race conditions
- **IST timezone** — all day boundaries and display in Asia/Kolkata
- **Pagination** — employee list, attendance history, admin records
- **Audit logging** — structured JSON logs for login, attendance, admin actions
- **Bulk upload cap** — max 500 rows per Excel file

Run `npm run verify` for **35 automated tests** covering geo, auth, validation, and pagination.

## Project structure

```text
attendance-web/
  shared/validation/                          # Shared Zod schemas (client + server)
  client/
    public/assets/branding/grubpac-logo.png   # Company logo
    src/config/branding.js                    # Branding constants for UI
  server/                                     # Express API
  scripts/kill-ports.mjs                      # Auto port cleanup on run
  package.json                                # Root dev orchestration
```
