# Owo Track (MVP)

A minimal expense tracker for small and medium scale enterprises.

## Stack
- **Frontend:** React (Vite)
- **Backend:** Node.js + Express
- **Storage:** SQLite via Node's built-in `node:sqlite` module (`backend/owotrack.db`) — no native build tools required, just Node ≥ 22.5.0

## Features (MVP)
- Add an expense (amount, category, vendor, description, date)
- View all expenses, filter by category
- Delete an expense
- Auto-calculated totals: grand total + per-category breakdown

## Run it

**Backend**
```
cd backend
npm install
node server.js
```
Runs on http://localhost:4000

**Frontend**
```
cd frontend
npm install
npm run dev
```
Runs on http://localhost:5173 (proxies API calls to http://localhost:4000 by default —
override with a `.env` file, see `.env.example`)

## Next steps (post-MVP)
- User accounts / multi-branch support
- Recurring expenses & budgets per category
- CSV/PDF export
- Charts (spend over time, category breakdown)

## Notes
- `node:sqlite` is still an experimental Node API — you'll see a one-line experimental
  warning in the console when the server starts. It's safe to ignore for this MVP; if it
  becomes a blocker later, the queries are plain SQL and would port easily to `better-sqlite3`
  or `pg` (Postgres).
