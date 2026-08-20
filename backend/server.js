import { authorize } from './authorize.js';

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { UPLOAD_DIR, buildAttachmentName } = require("./storage");
const { createRateLimiter } = require("./rateLimit");
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  getUserForSession,
  getSessionExpiry,
  isSessionExpired,
  SESSION_DURATION_MS,
} = require("./auth");

const app = express();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const PORT = process.env.PORT || 4000;

const CATEGORIES = [
  "Rent",
  "Utilities",
  "Salaries",
  "Inventory",
  "Marketing",
  "Transport",
  "Equipment",
  "Miscellaneous",
];

// Allowed frontend origin(s). Defaults to the Vite dev server so local
// development keeps working unchanged; set CORS_ORIGIN (comma-separated
// for more than one) to the real frontend URL(s) in production.
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no Origin header (server-to-server calls,
      // curl, some mobile/native webviews) alongside the configured list.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true, // required for the browser to send/receive the session cookie
  })
);
app.use(express.json({ limit: "10mb" }));

// Whether the session cookie requires HTTPS. Defaults to false so it works
// on http://localhost in dev; set COOKIE_SECURE=true once deployed behind
// HTTPS (required there — browsers won't send a Secure cookie over http).
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SESSION_COOKIE_NAME = "owo_track_session";

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true, // not readable by JS — the whole point, closes the XSS-token-theft gap
    secure: COOKIE_SECURE,
    sameSite: "lax", // sent on same-site requests (incl. cross-port, e.g. :5173 -> :4000), blocked cross-site
    maxAge: SESSION_DURATION_MS,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

// Minimal manual Cookie header parsing — avoids adding cookie-parser as a
// dependency for the one cookie this app sets.
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
}

// Trust the platform's proxy (Codespaces/most hosts sit behind one) so
// req.ip reflects the real client rather than the proxy's address.
app.set("trust proxy", true);

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: "login",
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  scope: "register",
  message: "Too many accounts created from this connection. Please try again later.",
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, buildAttachmentName(file.originalname, req.userId || "user")),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Unsupported file type. Please upload a JPG, PNG, WEBP, PDF, or text file."));
  },
});

function authenticate(req, res, next) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME] || "";

  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) {
    return res.status(401).json({ error: "Invalid session." });
  }

  if (isSessionExpired(session)) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user) {
    return res.status(401).json({ error: "User not found." });
  }

  req.user = user;
  req.userId = user.id;
  req.session = session;
  next();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", registerLimiter, (req, res) => {
  const { name, email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existingUser) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const userId = uuidv4();
  const { hash, salt } = hashPassword(String(password));
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, String(name).trim(), normalizedEmail, hash, salt, createdAt);

  const token = createSessionToken();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), userId, token, createdAt, getSessionExpiry());

  setSessionCookie(res, token);

  res.status(201).json({
    user: {
      id: userId,
      name: String(name).trim(),
      email: normalizedEmail,
    },
  });
});

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail);
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const isValid = verifyPassword(String(password), user.password_salt, user.password_hash);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = createSessionToken();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), user.id, token, createdAt, getSessionExpiry());

  setSessionCookie(res, token);

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  });
});

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
    },
  });
});

app.post("/api/auth/logout", authenticate, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.session.token);
  clearSessionCookie(res);
  res.status(204).send();
});

app.get("/api/categories", authenticate, (req, res) => {
  res.json(CATEGORIES);
});

app.get("/api/expenses", authenticate, (req, res) => {
  const { category } = req.query;

  let rows;
  if (category) {
    rows = db
      .prepare("SELECT * FROM expenses WHERE user_id = ? AND category = ? ORDER BY date DESC")
      .all(req.userId, category);
  } else {
    rows = db.prepare("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC").all(req.userId);
  }
  res.json(rows);
});

app.post("/api/expenses", authenticate, (req, res) => {
  const { amount, category, description, vendor, date } = req.body;

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: "A valid positive amount is required." });
  }
  if (!category || !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "A valid category is required." });
  }

  const expense = {
    id: uuidv4(),
    user_id: req.userId,
    amount: Number(amount),
    category,
    description: description || "",
    vendor: vendor || "",
    date: date || new Date().toISOString().slice(0, 10),
    attachment_name: "",
    attachment_url: "",
  };

  db.prepare(
    `INSERT INTO expenses (id, user_id, amount, category, description, vendor, date, attachment_name, attachment_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    expense.id,
    expense.user_id,
    expense.amount,
    expense.category,
    expense.description,
    expense.vendor,
    expense.date,
    expense.attachment_name,
    expense.attachment_url,
  );

  res.status(201).json(expense);
});

app.post("/api/expenses/:id/attachment", authenticate, upload.single("file"), (req, res) => {
  const expense = db
    .prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.userId);

  if (!expense) {
    return res.status(404).json({ error: "Expense not found." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "A file is required." });
  }

  const uploadedUrl = `/api/expenses/${req.params.id}/attachment/file`;

  db.prepare(
    "UPDATE expenses SET attachment_name = ?, attachment_url = ? WHERE id = ? AND user_id = ?"
  ).run(req.file.filename, uploadedUrl, req.params.id, req.userId);

  res.json({
    attachment: {
      name: req.file.filename,
      url: uploadedUrl,
    },
  });
});

app.get("/api/expenses/:id/attachment/file", authenticate, (req, res) => {
  const expense = db
    .prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.userId);

  if (!expense || !expense.attachment_name) {
    return res.status(404).json({ error: "Attachment not found." });
  }

  const filePath = path.join(UPLOAD_DIR, expense.attachment_name);

  // Guard against the resolved path ever escaping the uploads directory.
  if (!filePath.startsWith(UPLOAD_DIR)) {
    return res.status(400).json({ error: "Invalid file path." });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Attachment not found." });
  }

  res.sendFile(filePath);
});

app.delete("/api/expenses/:id", authenticate, (req, res) => {
  const result = db
    .prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Expense not found." });
  }

  res.status(204).send();
});

app.get("/api/budgets", authenticate, (req, res) => {
  const rows = db.prepare("SELECT category, monthly_limit FROM budgets WHERE user_id = ?").all(req.userId);
  const budgets = {};
  for (const row of rows) budgets[row.category] = row.monthly_limit;
  res.json(budgets);
});

app.put("/api/budgets/:category", authenticate, (req, res) => {
  const { category } = req.params;
  const { monthly_limit } = req.body;

  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Unknown category." });
  }
  if (monthly_limit === undefined || isNaN(monthly_limit) || Number(monthly_limit) < 0) {
    return res.status(400).json({ error: "A valid non-negative monthly_limit is required." });
  }

  db.prepare(
    `INSERT INTO budgets (user_id, category, monthly_limit)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
  ).run(req.userId, category, Number(monthly_limit));

  res.json({ category, monthly_limit: Number(monthly_limit) });
});

app.delete("/api/budgets/:category", authenticate, (req, res) => {
  db.prepare("DELETE FROM budgets WHERE user_id = ? AND category = ?").run(req.userId, req.params.category);
  res.status(204).send();
});

app.get("/api/summary", authenticate, (req, res) => {
  const totalsByCategory = {};
  for (const cat of CATEGORIES) totalsByCategory[cat] = 0;

  const rows = db
    .prepare("SELECT category, SUM(amount) as total FROM expenses WHERE user_id = ? GROUP BY category")
    .all(req.userId);

  for (const row of rows) {
    totalsByCategory[row.category] = row.total;
  }

  const { total: grandTotal, count } = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE user_id = ?")
    .get(req.userId);

  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthRows = db
    .prepare(
      "SELECT category, SUM(amount) as total FROM expenses WHERE user_id = ? AND date LIKE ? GROUP BY category"
    )
    .all(req.userId, `${monthPrefix}%`);

  const monthSpentByCategory = {};
  for (const cat of CATEGORIES) monthSpentByCategory[cat] = 0;
  for (const row of monthRows) monthSpentByCategory[row.category] = row.total;

  const budgetRows = db.prepare("SELECT category, monthly_limit FROM budgets WHERE user_id = ?").all(req.userId);
  const budgets = {};
  for (const row of budgetRows) budgets[row.category] = row.monthly_limit;

  res.json({
    totalsByCategory,
    grandTotal,
    count,
    month: monthPrefix,
    monthSpentByCategory,
    budgets,
  });
});

app.listen(PORT, () => {
  console.log(`Owo Track API running on http://localhost:${PORT}`);
});
