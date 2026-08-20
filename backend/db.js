const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "owotrack.db");
const db = new DatabaseSync(DB_PATH);

// Foreign keys are off by default in SQLite and must be enabled per
// connection — this setting isn't stored in the database file itself, so
// every process that opens this file needs to turn it on again.
db.exec("PRAGMA foreign_keys = ON");

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

// user_id references cascade on delete: if a user account is ever removed,
// their sessions/expenses/budgets go with it rather than becoming orphaned
// rows with no owner (there's no user-deletion feature yet, but the
// constraint is what actually stops that class of bug from being possible
// later, rather than relying on every future code path to remember to
// clean up manually).
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit REAL NOT NULL,
    PRIMARY KEY(user_id, category)
  )
`);

// --- Column migrations for databases created before certain fields existed ---

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

// --- Foreign-key migration for databases created before FK constraints existed ---
//
// SQLite can't ALTER TABLE to add a foreign key to an already-existing
// table. The standard workaround (per SQLite's own docs) is: rename the
// old table aside, create a new one with the constraint, copy every row
// across, then drop the old one — all with foreign_keys off for the
// duration, since it can't be toggled inside a transaction anyway.
function ensureForeignKey(table, createSql) {
  const hasForeignKey = db.prepare(`PRAGMA foreign_key_list(${table})`).all().length > 0;
  if (hasForeignKey) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    db.exec(createSql);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const columnList = columns.join(", ");
    db.exec(`INSERT INTO ${table} (${columnList}) SELECT ${columnList} FROM ${table}_old`);
    db.exec(`DROP TABLE ${table}_old`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

ensureForeignKey(
  "sessions",
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )`
);

ensureForeignKey(
  "expenses",
  `CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT DEFAULT '',
    vendor TEXT DEFAULT '',
    date TEXT NOT NULL,
    attachment_name TEXT DEFAULT '',
    attachment_url TEXT DEFAULT ''
  )`
);

ensureForeignKey(
  "budgets",
  `CREATE TABLE budgets (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit REAL NOT NULL,
    PRIMARY KEY(user_id, category)
  )`
);

module.exports = db;
