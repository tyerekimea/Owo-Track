# Owo Track

An expense tracker for small and medium-scale enterprises — organizations, teams,
roles, and an expense submit/approve workflow, not just a personal ledger.

## Stack
- **Frontend:** React (Vite), Firebase Auth client SDK
- **Backend:** Node.js + Express, running as a single Vercel serverless function
  (`api/[...path].js` → `backend/firebase-server.js`)
- **Data:** Firestore (organizations, teams, users, expenses, approval history, budgets)
- **Files:** Firebase Storage (receipt attachments)
- **Auth:** Firebase Authentication (email/password)

There is no local database file and no separate long-running backend process to deploy —
the whole thing is designed to run as one Vercel project serving both the static frontend
and the API.

## Features
- Firebase-authenticated accounts. The first person to register for an email domain
  becomes their organization's **admin**; admins can add employees/managers and assign
  them to teams.
- Three roles — **employee**, **manager**, **admin** — with access scoped accordingly:
  employees see only their own expenses, managers see their team's, admins see the
  whole organization.
- Expense lifecycle: **draft → submitted → approved / rejected / returned**, with a
  recorded approval history per expense. A manager or admin can approve/reject/return
  any expense in their scope, but never their own.
- Expenses support an optional receipt attachment (image or PDF), stored in Firebase
  Storage and served back through an authenticated endpoint (not a public URL).
- Per-category monthly budgets at the organization level, with spend-vs-limit tracking.
- Paginated expense listing, category filtering, and an auto-calculated summary
  (grand total, per-category totals, current-month spend).

## Run it locally

Both the backend and frontend need real Firebase project credentials — there's no
local/offline mode. You'll need a Firebase project with **Email/Password**
authentication enabled, Firestore, and Storage set up.

**Backend**
```
cd backend
npm install
npm start
```
Copy `backend/.env.example` to `backend/.env` and fill in:
- `FIREBASE_SERVICE_ACCOUNT_JSON` — the full service-account key JSON, as a single-line
  string. Keep this secret; never commit a real value.
- `FIREBASE_STORAGE_BUCKET`
- `CORS_ORIGIN` if the frontend isn't running on the default `http://localhost:5173`

Runs on http://localhost:4000.

**Frontend**
```
cd frontend
npm install
npm run dev
```
Copy `frontend/.env.example` to `frontend/.env` and fill in the `VITE_FIREBASE_*`
values from your Firebase project's web app config, plus `VITE_API_URL` pointing at
the backend above. Runs on http://localhost:5173.

## Testing

- `cd backend && npm test` — unit tests for the role-based access control logic
  (`authorize.js`: who can see/approve which expenses) and the rate limiter. This
  covers the app's core authorization rules directly, without needing a live
  Firestore connection.
- `cd frontend && npm test` — component tests for the auth flow (login, registration,
  logout, error states), with Firebase mocked out so no real credentials are needed.
- CI (`.github/workflows/ci.yml`) runs both suites, plus lint and a production build,
  on every push and PR.

Neither suite currently exercises the live Firestore/Storage integration end-to-end —
that would need a Firestore emulator or a real test project, which isn't set up yet.

## Deploying (Vercel)

`vercel.json` builds the frontend and deploys `api/[...path].js` as a single
serverless function handling all `/api/*` routes. In the Vercel project settings, set:
- The backend env vars above (`FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_STORAGE_BUCKET`)
- The frontend `VITE_FIREBASE_*` values
- `CORS_ORIGIN` to your deployed frontend's actual URL

## Not built yet
- CSV/PDF export
- Charts (spend over time, category breakdown)
- Recurring expenses
- Password reset flow (Firebase Auth supports this natively — just not wired up in the UI yet)
- End-to-end tests against a real/emulated Firestore
