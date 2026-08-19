const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "owotrack.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT DEFAULT '',
    vendor TEXT DEFAULT '',
    date TEXT NOT NULL,
    attachment_name TEXT DEFAULT '',
    attachment_url TEXT DEFAULT ''
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS budgets (
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    monthly_limit REAL NOT NULL,
    PRIMARY KEY(user_id, category)
  )
`);

const expenseColumns = db.prepare("PRAGMA table_info(expenses)").all();
if (!expenseColumns.some((column) => column.name === "user_id")) {
  db.exec("ALTER TABLE expenses ADD COLUMN user_id TEXT DEFAULT ''");
  db.exec("UPDATE expenses SET user_id = '' WHERE user_id IS NULL");
}
if (!expenseColumns.some((column) => column.name === "attachment_name")) {
  db.exec("ALTER TABLE expenses ADD COLUMN attachment_name TEXT DEFAULT ''");
}
if (!expenseColumns.some((column) => column.name === "attachment_url")) {
  db.exec("ALTER TABLE expenses ADD COLUMN attachment_url TEXT DEFAULT ''");
}

const budgetColumns = db.prepare("PRAGMA table_info(budgets)").all();
if (!budgetColumns.some((column) => column.name === "user_id")) {
  db.exec("ALTER TABLE budgets ADD COLUMN user_id TEXT DEFAULT ''");
  db.exec("UPDATE budgets SET user_id = '' WHERE user_id IS NULL");
}

const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all();
if (!sessionColumns.some((column) => column.name === "expires_at")) {
  db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
  // Existing sessions predate expiry tracking — give them a fresh 30-day
  // window from now rather than logging every current user out immediately.
  db.exec(
    `UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE expires_at IS NULL`
  );
}

module.exports = db;
