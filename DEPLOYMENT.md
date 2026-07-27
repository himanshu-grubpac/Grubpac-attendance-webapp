# Deployment guide — Grubpac Attendance Web

Practical reference for connecting to the **already-deployed** AWS stack, redeploying after code changes, and using MongoDB Atlas. Do **not** recreate infrastructure unless recovering from a disaster.

---

## Live URLs

| Surface | URL |
|--------|-----|
| Website (CloudFront) | https://d1qk2thz664f5x.cloudfront.net |
| API (API Gateway) | https://byijl0y4j3.execute-api.ap-south-1.amazonaws.com |
| Health (via CloudFront `/api`) | https://d1qk2thz664f5x.cloudfront.net/api/health |
| Health (direct API) | `https://byijl0y4j3.execute-api.ap-south-1.amazonaws.com/api/health` |

Users should use the **CloudFront** URL only. `/api/*` is routed through CloudFront so cookies stay same-origin.

---

## AWS identifiers

| Resource | Value |
|----------|--------|
| Account ID | `662252246711` |
| Region | `ap-south-1` |
| IAM deploy user (CLI) | `grubpac-attendance` |
| SAM stack | `grubpac-attendance-api` |
| Lambda function | `grubpac-attendance-api` |
| S3 frontend bucket | `grubpac-attendance-web-662252246711` |
| CloudFront distribution ID | `E2RTSX0V53UZVH` |
| CloudFront domain | `d1qk2thz664f5x.cloudfront.net` |
| SAM managed source bucket (optional) | `aws-sam-cli-managed-default-samclisourcebucket-mzdreqfkqpb1` |

---

## Architecture reminder

- **Frontend:** S3 static hosting + CloudFront
- **Backend:** Lambda + API Gateway (Express via `server/src/lambda.js`, SAM `template.yaml`)
- **Routing:** CloudFront forwards `/api/*` to API Gateway (same-origin cookies)
- **Database:** MongoDB Atlas (external to AWS)

```
Browser → CloudFront (UI + /api/*)
                ├─ /*     → S3 (frontend)
                └─ /api/* → API Gateway → Lambda (Express)
                                          └─ MongoDB Atlas
```

---

## Prerequisites each session

Run in **Windows PowerShell** so CLI tools and AWS identity are available:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
aws sts get-caller-identity
cd "C:\Users\salun\Downloads\Company Data\attendance-web"
```

Confirm the caller is the deploy user for account `662252246711` in `ap-south-1`. Credentials come from `aws configure` (or the environment profile), not from this repo.

---

## Redeploy BACKEND (API) after server changes

From the project root:

```powershell
npm run prepare:lambda
sam build
sam deploy
```

Notes:

- `samconfig.toml` already sets `ClientOrigin=https://d1qk2thz664f5x.cloudfront.net`. Do **not** reset it to localhost unless you intentionally need local CORS testing against a changed origin.
- `MongoDbUri` and `JwtSecret` were set on the first deploy. If they are not in `samconfig.toml`, keep using the **previous stack parameter values** when SAM prompts (do not invent new secrets unless rotating intentionally).

---

## Redeploy FRONTEND after client changes

```powershell
cd client
npm run build
aws s3 sync dist s3://grubpac-attendance-web-662252246711 --delete
aws cloudfront create-invalidation --distribution-id E2RTSX0V53UZVH --paths "/*"
```

After invalidation, hard-refresh the browser (typically wait ~1–2 minutes for CloudFront).

---

## Full redeploy (both)

1. Run the **backend** steps (`prepare:lambda` → `sam build` → `sam deploy`).
2. Run the **frontend** steps (`client` build → S3 sync → CloudFront invalidation).

---

## MongoDB Atlas

- Connection string lives in `server/.env` as `MONGODB_URI`. **Never** commit `.env` or paste secrets into this file / chat logs.
- Database name: `attendance_web`
- **Network Access:** allow `0.0.0.0/0` for Lambda outbound access (or use a NAT / fixed egress later).
- **Seed data** (from project root, uses `server/.env`):

  ```powershell
  npm run seed
  ```

- `USE_MEMORY_DB` is for local/tests only. Production Lambda must use Atlas (`USE_MEMORY_DB` off / unset in the deployed environment).

---

## Local vs production

| Mode | How | Notes |
|------|-----|--------|
| Local | `npm run dev` from project root | Server ~5000, client ~5173 |
| Production | https://d1qk2thz664f5x.cloudfront.net | Only URL end users should open |

Do not point production users at API Gateway or localhost.

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

## Security notes

- Do **not** put AWS access keys, JWT secrets, or MongoDB passwords in this file, git, or tickets.
- App secrets: `server/.env` (and Lambda env via SAM parameters).
- AWS credentials: `aws configure` / IAM for user `grubpac-attendance`.
- If any secret was exposed, **rotate** it (IAM keys, JWT secret, Atlas password) and update Lambda parameters / `.env` accordingly.

---

## What NOT to recreate

- Do **not** create new S3 buckets, CloudFront distributions, Lambda functions, or API Gateways for routine feature work.
- New features = **code change + redeploy** only.
- MongoDB collections are created by Mongoose as needed; no separate infra step for new schemas in normal development.

Disaster recovery (lost stack/bucket) is the only reason to rebuild AWS resources from scratch — prefer restoring from the existing identifiers above.
