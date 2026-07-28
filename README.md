# Owo Track (MVP)

A minimal expense tracker for small and medium scale enterprises.

## Stack
- **Frontend:** React (Vite)
- **Backend:** Node.js + Express
- **Storage:** JSON file (`backend/data.json`) — swap for a real DB later

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
- Move storage to SQLite or Postgres
- Charts (spend over time, category breakdown)
