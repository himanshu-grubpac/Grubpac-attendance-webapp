# Grubpac Attendance Web App

Internal employee attendance system for **Grubpac Technologies** — React (Vite) client + Node/Express API + MongoDB.

## Environments

| Environment | Website | Use |
|-------------|---------|-----|
| **Production** | https://d1qk2thz664f5x.cloudfront.net | Live users |
| **Staging** | https://d24p2zn8763d4h.cloudfront.net | Pre-production testing |
| **Local** | http://localhost:5173 | Development |

Deploy and AWS details (identifiers, redeploy commands, Atlas, SAM setup): **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

**Workflow:** develop locally → deploy to **staging** → verify → deploy to **production**.

---

## Architecture (high level)

```
Browser → CloudFront (static UI + /api/* proxy)
              ├─ /*     → S3
              └─ /api/* → API Gateway → Lambda (Express) → MongoDB Atlas
```

- **Production** and **staging** each have their own CloudFront, S3 bucket, Lambda, API Gateway, and Atlas cluster.
- Session auth uses **httpOnly cookies**; the browser should only talk to the CloudFront origin (not API Gateway directly).

---

## Prerequisites

- Node.js 18+
- MongoDB running locally (`mongodb://127.0.0.1:27017`) **or** set `USE_MEMORY_DB=true` in `server/.env` for local dev without MongoDB

For AWS deploys: AWS CLI, SAM CLI, and credentials for IAM user `grubpac-attendance` — see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## First-time setup (local)

```powershell
cd "c:\Users\salun\Downloads\Company Data\attendance-web"
npm run install:all
copy server\.env.example server\.env
npm run seed
```

---

## Run the web app (local)

From the project root (`attendance-web/`):

```powershell
npm run dev
```

This will:

1. **Kill** any existing processes on ports **5000** (API) and **5173** (client)
2. Start the **server** at http://localhost:5000
3. Start the **client** at http://localhost:5173

Open **http://localhost:5173** in your browser.

### Other local commands

| Command | Description |
|---------|-------------|
| `npm run kill` | Free ports 5000 and 5173 only |
| `npm run seed` | Seed admin user + default office (uses `server/.env`) |
| `npm run seed:wipe` | Wipe and re-seed (local DB) |
| `npm run start` | Production server + dev client (kills ports first) |
| `npm run verify` | Run automated API + geo + IST verification tests |
| `npm run jobs:accrual` | Run leave accrual job (uses `server/.env`) |
| `npm run jobs:carry-forward` | Run carry-forward job (uses `server/.env`) |

### Default admin login

- Email: `admin@grubpac.com`
- Password: `Grubpac@Admin2026`

(Configurable in `server/.env`)

---

## Deploy quick reference

Full steps, AWS IDs, MongoDB, and security: **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

### Staging

```powershell
cd "c:\Users\salun\Downloads\Company Data\attendance-web"
npm run deploy:staging:api        # backend (Lambda)
npm run deploy:staging:frontend   # client → S3 → CloudFront
```

Requires local `samconfig.staging.toml` (copy from `samconfig.staging.example.toml`; **gitignored**).

### Production

```powershell
npm run prepare:lambda
sam build
sam deploy

cd client
npm run build
aws s3 sync dist s3://grubpac-attendance-web-662252246711 --delete
aws cloudfront create-invalidation --distribution-id E2RTSX0V53UZVH --paths "/*"
```

Uses committed `samconfig.toml`.

### Health checks

| Environment | URL |
|-------------|-----|
| Staging | https://d24p2zn8763d4h.cloudfront.net/api/health |
| Production | https://d1qk2thz664f5x.cloudfront.net/api/health |

---

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

---

## Project structure

```text
attendance-web/
  shared/validation/                          # Shared Zod schemas (client + server)
  client/
    public/assets/branding/grubpac-logo.png   # Company logo
    src/config/branding.js                    # Branding constants for UI
  server/                                     # Express API (+ Lambda handler)
  scripts/kill-ports.mjs                      # Auto port cleanup on run
  template.yaml                               # SAM template (prod + staging params)
  samconfig.toml                              # Production SAM deploy config
  samconfig.staging.example.toml              # Staging SAM template (copy locally)
  DEPLOYMENT.md                               # Full deploy reference
  package.json                                # Root dev + deploy orchestration
```
