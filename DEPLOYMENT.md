# Deployment guide — Grubpac Attendance Web

Practical reference for the **production** and **staging** AWS stacks: live URLs, identifiers, redeploy commands, MongoDB Atlas, and local development. Do **not** recreate infrastructure unless recovering from a disaster.

**Recommended workflow:** develop locally → deploy and verify on **staging** → deploy to **production**.

---

## Environments at a glance

| | **Production** | **Staging** |
|---|----------------|-------------|
| Purpose | Live users | Pre-production testing |
| Website (CloudFront) | https://d1qk2thz664f5x.cloudfront.net | https://d24p2zn8763d4h.cloudfront.net |
| API (API Gateway) | https://byijl0y4j3.execute-api.ap-south-1.amazonaws.com | https://5ghi01c26k.execute-api.ap-south-1.amazonaws.com |
| Health (via CloudFront) | https://d1qk2thz664f5x.cloudfront.net/api/health | https://d24p2zn8763d4h.cloudfront.net/api/health |
| Health (direct API) | `https://byijl0y4j3.execute-api.ap-south-1.amazonaws.com/api/health` | `https://5ghi01c26k.execute-api.ap-south-1.amazonaws.com/api/health` |
| SAM config file | `samconfig.toml` (committed) | `samconfig.staging.toml` (**gitignored**) |
| SAM example template | — | `samconfig.staging.example.toml` (committed) |

Users and QA should open the **CloudFront** URL only. `/api/*` is routed through CloudFront so session cookies stay same-origin.

---

## AWS identifiers

Shared across both environments:

| Resource | Value |
|----------|--------|
| Account ID | `662252246711` |
| Region | `ap-south-1` |
| IAM deploy user (CLI) | `grubpac-attendance` |
| SAM managed source bucket (optional) | `aws-sam-cli-managed-default-samclisourcebucket-mzdreqfkqpb1` |

### Production

| Resource | Value |
|----------|--------|
| SAM stack | `grubpac-attendance-api` |
| Lambda function | `grubpac-attendance-api` |
| S3 frontend bucket | `grubpac-attendance-web-662252246711` |
| CloudFront distribution ID | `E2RTSX0V53UZVH` |
| CloudFront domain | `d1qk2thz664f5x.cloudfront.net` |
| SAM config | `samconfig.toml` |
| `ApiFunctionName` (template default) | `grubpac-attendance-api` |

### Staging

| Resource | Value |
|----------|--------|
| SAM stack | `grubpac-attendance-api-staging` |
| Lambda function | `grubpac-attendance-api-staging` |
| S3 frontend bucket | `grubpac-attendance-web-staging-662252246711` |
| CloudFront distribution ID | `E2RJX8BNEIE0D` |
| CloudFront domain | `d24p2zn8763d4h.cloudfront.net` |
| SAM config | `samconfig.staging.toml` (local only) |
| `ApiFunctionName` | `grubpac-attendance-api-staging` |

---

## Architecture

- **Frontend:** S3 static hosting + CloudFront (one pair per environment)
- **Backend:** Lambda + API Gateway HTTP API (Express via `server/src/lambda.js`, SAM `template.yaml`)
- **Routing:** CloudFront forwards `/api/*` to that environment’s API Gateway (same-origin cookies)
- **Database:** MongoDB Atlas — **separate clusters** for production and staging (external to AWS)

```
Browser → CloudFront (UI + /api/*)
                ├─ /*     → S3 (frontend)
                └─ /api/* → API Gateway → Lambda (Express)
                                          └─ MongoDB Atlas
                                                    ├─ production cluster → attendance_web
                                                    └─ staging cluster    → attendance_web
```

The `ApiFunctionName` parameter in `template.yaml` distinguishes prod (`grubpac-attendance-api`) from staging (`grubpac-attendance-api-staging`).

---

## Prerequisites (each deploy session)

Run in **Windows PowerShell** so CLI tools and AWS identity are available:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
aws sts get-caller-identity
cd "C:\Users\salun\Downloads\Company Data\attendance-web"
```

Confirm the caller is the deploy user for account `662252246711` in `ap-south-1`. AWS credentials come from `aws configure` (or an environment profile), **not** from this repo.

---

## npm deploy scripts (root `package.json`)

| Script | Description |
|--------|-------------|
| `npm run prepare:lambda` | Bundle server + dependencies into `lambda-package/` for SAM (required before every API deploy) |
| `npm run deploy:staging:api` | `prepare:lambda` → `sam build` → `sam deploy --config-file samconfig.staging.toml --no-confirm-changeset` |
| `npm run deploy:staging:frontend` | Build client → S3 sync staging bucket → CloudFront invalidation |

Production has no one-shot npm script; use the **production backend** and **production frontend** sections below (`sam deploy` with default `samconfig.toml`).

Other useful root scripts:

| Script | Description |
|--------|-------------|
| `npm run install:all` | Install root, server, and client dependencies |
| `npm run verify` | Automated API tests (uses `server/.env`) |
| `npm run jobs:accrual` | Run leave accrual job locally (uses `server/.env`) |
| `npm run jobs:carry-forward` | Run carry-forward job locally (uses `server/.env`) |

---

## Redeploy BACKEND (API)

Always run from the **project root**. Every API deploy starts with `npm run prepare:lambda`.

### Staging (after server changes)

```powershell
npm run deploy:staging:api
```

Equivalent manual steps:

```powershell
npm run prepare:lambda
sam build
sam deploy --config-file samconfig.staging.toml --no-confirm-changeset
```

### Production (after server changes)

```powershell
npm run prepare:lambda
sam build
sam deploy
```

Uses committed `samconfig.toml` (stack `grubpac-attendance-api`, `ClientOrigin=https://d1qk2thz664f5x.cloudfront.net`).

**Parameter notes:**

- `ClientOrigin` must match that environment’s CloudFront URL (set in the respective `samconfig*.toml`).
- `MongoDbUri` and `JwtSecret` are **secrets** (`NoEcho` in `template.yaml`). Staging values live in local `samconfig.staging.toml`. Production values were set on first deploy and are retained by CloudFormation unless you override them.
- Do **not** point production `ClientOrigin` at localhost unless intentionally testing CORS against a non-prod origin.

---

## Redeploy FRONTEND (client)

Build the Vite app, sync to the correct S3 bucket, then invalidate CloudFront.

### Staging

```powershell
npm run deploy:staging:frontend
```

Manual equivalent:

```powershell
npm run build --prefix client
aws s3 sync client/dist s3://grubpac-attendance-web-staging-662252246711 --delete
aws cloudfront create-invalidation --distribution-id E2RJX8BNEIE0D --paths "/*"
```

### Production

```powershell
cd client
npm run build
aws s3 sync dist s3://grubpac-attendance-web-662252246711 --delete
aws cloudfront create-invalidation --distribution-id E2RTSX0V53UZVH --paths "/*"
```

After invalidation, hard-refresh the browser (typically wait ~1–2 minutes for CloudFront).

---

## Full redeploy (backend + frontend)

1. Deploy **API** for the target environment (staging or production steps above).
2. Deploy **frontend** for the same environment.
3. Hit `/api/health` via CloudFront and smoke-test login.

**Order:** staging first, then production after verification.

---

## SAM config on a new machine

### Production

`samconfig.toml` is **committed**. Clone the repo and use it as-is for `sam deploy`. It sets `ClientOrigin` for production; `MongoDbUri` / `JwtSecret` remain in the existing stack unless you explicitly override.

### Staging

`samconfig.staging.toml` is **gitignored** (contains secrets). On each new machine:

```powershell
cd "C:\Users\salun\Downloads\Company Data\attendance-web"
Copy-Item samconfig.staging.example.toml samconfig.staging.toml
```

Edit `samconfig.staging.toml` and replace placeholders:

- `MongoDbUri` — staging Atlas connection string (see MongoDB section)
- `JwtSecret` — staging-only JWT secret (32+ characters; **different from production**)

Committed template (`samconfig.staging.example.toml`) documents the required shape:

- `stack_name = "grubpac-attendance-api-staging"`
- `ApiFunctionName = "grubpac-attendance-api-staging"`
- `ClientOrigin = "https://d24p2zn8763d4h.cloudfront.net"`

---

## MongoDB Atlas

| | **Production** | **Staging** |
|---|----------------|-------------|
| Cluster | Production Atlas cluster (connection string in Lambda / local env only) | `attendance-staging` (`attendance-staging.ivyl6lu.mongodb.net`) |
| Database name | `attendance_web` | `attendance_web` |
| Used by | Production Lambda + optional local `server/.env.production` | Staging Lambda + local `server/.env.staging` |
| Example env template | Create locally from prod URI (not committed) | `server/.env.staging.example` |

**Network access:** allow `0.0.0.0/0` so Lambda can reach Atlas (or restrict to known egress later).

**Never commit:** `.env`, `.env.*` (except `*.example`), `samconfig.staging.toml`, or real connection strings / passwords in docs or tickets.

`USE_MEMORY_DB` is for local/tests only. Deployed Lambdas must use Atlas (`USE_MEMORY_DB` unset / off).

### Local env files for CLI operations (seed, migrate, jobs)

Copy the example and fill credentials locally:

```powershell
# Staging — for Atlas CLI against staging data
Copy-Item server\.env.staging.example server\.env.staging

# Production — create manually; do not commit
# server/.env.production with MONGODB_URI=<prod Atlas URI>
```

Node 18+ `--env-file` loads variables before server scripts run.

### Seed (admin user + default office)

**Local dev** (uses `server/.env`, typically local MongoDB):

```powershell
npm run seed
```

**Staging** (from project root):

```powershell
node --env-file=server/.env.staging server/src/seed.js
```

**Production** (only when intentionally seeding prod Atlas):

```powershell
node --env-file=server/.env.production server/src/seed.js
```

### Seed with wipe (destructive — clears app data, re-seeds)

**Staging:**

```powershell
node --env-file=server/.env.staging server/src/seed.js --wipe
```

**Production** (use with extreme care):

```powershell
node --env-file=server/.env.production server/src/seed.js --wipe
```

### Migrations (from `server/` scripts, run with `--env-file`)

**Staging:**

```powershell
node --env-file=server/.env.staging server/src/migrateRecentFeatures.js
node --env-file=server/.env.staging server/src/migrateDualPortal.js
```

**Production:**

```powershell
node --env-file=server/.env.production server/src/migrateRecentFeatures.js
node --env-file=server/.env.production server/src/migrateDualPortal.js
```

### Other data scripts

**Wipe app data but keep holidays + geo** (requires `CONFIRM_WIPE=1`):

```powershell
$env:CONFIRM_WIPE = "1"
node --env-file=server/.env.staging server/src/wipeKeepHolidaysGeo.js
```

**Seed India holidays:**

```powershell
node --env-file=server/.env.staging server/src/seedIndiaHolidays.js
```

Replace `server/.env.staging` with `server/.env.production` when targeting production.

---

## Staging first-time setup checklist

Use this when standing up staging on a **new developer machine** (infrastructure already exists in AWS):

1. [ ] Install Node.js 18+, AWS CLI, SAM CLI; run `aws configure` for `grubpac-attendance`.
2. [ ] `npm run install:all`
3. [ ] Copy `samconfig.staging.example.toml` → `samconfig.staging.toml`; set `MongoDbUri` and `JwtSecret` (placeholders in example only).
4. [ ] Copy `server/.env.staging.example` → `server/.env.staging`; set real staging `MONGODB_URI` and `JWT_SECRET`.
5. [ ] Verify AWS identity: `aws sts get-caller-identity`
6. [ ] Deploy API: `npm run deploy:staging:api`
7. [ ] Deploy frontend: `npm run deploy:staging:frontend`
8. [ ] Open https://d24p2zn8763d4h.cloudfront.net/api/health — expect success JSON.
9. [ ] If DB is empty, seed staging: `node --env-file=server/.env.staging server/src/seed.js`
10. [ ] Log in and smoke-test before any production deploy.

---

## Local development

| Mode | Command | URLs |
|------|---------|------|
| Local dev | `npm run dev` (project root) | Client http://localhost:5173, API http://localhost:5000 |
| Staging | https://d24p2zn8763d4h.cloudfront.net | Test here before prod |
| Production | https://d1qk2thz664f5x.cloudfront.net | End users only |

First-time local setup:

```powershell
npm run install:all
copy server\.env.example server\.env
npm run seed
npm run dev
```

Optional: `USE_MEMORY_DB=true` in `server/.env` to run without local MongoDB.

Do **not** point production users at API Gateway URLs or localhost.

---

## Local testing — shared-device detection (Login Logs)

The app stores a stable browser device id in `localStorage` under `attendance.deviceId` on first visit. Every admin and employee login sends this `deviceId` to the API along with the public IP and user agent.

**Quick test (same browser = same device):**

1. Start locally: `npm run dev` from the project root.
2. Open Chrome DevTools → Application → Local Storage → confirm `attendance.deviceId` exists (or refresh once to create it).
3. Log in as **User A** (employee or admin portal).
4. Log out, then log in as **User B** in the **same browser** (do not clear site data).
5. Sign in as an admin and open **Login Logs** (`/admin/audit-logs`).
6. Both User A and User B rows should show:
   - **Device** — same truncated id (first 8 chars; hover for full uuid).
   - **Conflict** — orange **Shared device** badge on both rows.
   - Tooltip — lists the other account with reason `shared device`.
7. Optional: enable **Conflicts only** filter and click **Apply Filters** to hide non-conflicting rows.

**Same network only (no shared device):** use two different browsers (or incognito + normal) on the same Wi‑Fi. Rows may show **Same network** (IP match within 24h) instead of **Shared device**.

---

## Security

- Do **not** commit AWS keys, JWT secrets, MongoDB passwords, or filled `samconfig.staging.toml`.
- Gitignored secrets (see `.gitignore`): `server/.env`, `server/.env.*` (except `*.example`), `samconfig.staging.toml`, `lambda-package/`, `.aws-sam/`.
- App secrets: local `server/.env*` files; deployed secrets via SAM `MongoDbUri` / `JwtSecret` parameters.
- AWS credentials: `aws configure` / IAM user `grubpac-attendance`.
- Use **different** JWT secrets and Atlas credentials for staging vs production.
- If any secret was exposed, **rotate** it (IAM keys, JWT secret, Atlas password) and update Lambda parameters / local env files.

---

## What NOT to recreate

- Do **not** create new S3 buckets, CloudFront distributions, Lambda functions, or API Gateways for routine feature work.
- New features = **code change + redeploy** to the existing prod or staging stack.
- MongoDB collections are created by Mongoose as needed; no separate infra step for new schemas in normal development.

Disaster recovery (lost stack/bucket) is the only reason to rebuild AWS resources from scratch — prefer restoring from the identifiers in this document.
