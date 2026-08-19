# Owo Track (MVP)

A minimal expense tracker for small and medium scale enterprises.

## Stack
- **Frontend:** React (Vite)
- **Backend:** Node.js + Express
- **Storage:** SQLite via Node's built-in `node:sqlite` module (`backend/owotrack.db`) — no native build tools required, just Node ≥ 22.5.0

## Features (MVP)
- User accounts (email/password signup and login)
- Add an expense (amount, category, vendor, description, date), with an optional receipt attachment (image or PDF)
- View all expenses, filter by category
- Delete an expense
- Per-category monthly budgets, with spend-vs-limit tracking and an over-budget warning
- Auto-calculated totals: grand total, per-category breakdown, current-month spend

## Run it

**Backend**
```
cd backend
npm install
node server.js
```
Runs on http://localhost:4000. Configurable via env vars — see `backend/.env.example`
(`PORT`, and `CORS_ORIGIN` for which frontend origin(s) are allowed to call the API).

**Frontend**
```
cd frontend
npm install
npm run dev
```
Runs on http://localhost:5173 and calls the backend directly at http://localhost:4000 by
default — override with a `.env` file in `frontend/`, see `frontend/.env.example`.

## Next steps (post-MVP)
- Multi-user/team support per business (shared ledger, staff + owner roles)
- Expense approval workflow
- CSV/PDF export
- Charts (spend over time, category breakdown)
- Recurring expenses
- Password reset flow

## Notes
- `node:sqlite` is still an experimental Node API — you'll see a one-line experimental
  warning in the console when the server starts. It's safe to ignore for this MVP; if it
  becomes a blocker later, the queries are plain SQL and would port easily to `better-sqlite3`
  or `pg` (Postgres).
