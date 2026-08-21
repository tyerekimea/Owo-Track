require("dotenv").config();

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
const { authorize, canAccessExpense, canApproveExpense } = require("./authorize");

const app = express();
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
  storage: process.env.FIREBASE_SERVICE_ACCOUNT_JSON && process.env.FIREBASE_STORAGE_BUCKET
    ? multer.memoryStorage()
    : multer.diskStorage({
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

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organization_id: user.organization_id,
    team_id: user.team_id,
    role: user.role || "employee",
  };
}

function expenseScope(req) {
  if (req.user.role === "admin") {
    return { clause: "organization_id = ?", params: [req.user.organization_id] };
  }
  if (req.user.role === "manager") {
    return {
      clause: "organization_id = ? AND team_id = ?",
      params: [req.user.organization_id, req.user.team_id],
    };
  }
  return { clause: "user_id = ?", params: [req.userId] };
}

function recordApproval(expenseId, organizationId, actorId, action, fromStatus, toStatus, comment = "") {
  db.prepare(
    `INSERT INTO approval_history
      (id, expense_id, organization_id, actor_id, action, from_status, to_status, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    expenseId,
    organizationId,
    actorId,
    action,
    fromStatus,
    toStatus,
    comment,
    new Date().toISOString(),
  );
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

  const organizationId = uuidv4();
  const teamId = uuidv4();
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(
    organizationId,
    `${String(name).trim()}'s organization`,
    createdAt,
  );
  db.prepare(
    "INSERT INTO teams (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)"
  ).run(teamId, organizationId, "General", createdAt);
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, password_salt, organization_id, team_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`
  ).run(userId, String(name).trim(), normalizedEmail, hash, salt, organizationId, teamId, createdAt);

  const token = createSessionToken();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), userId, token, createdAt, getSessionExpiry());

  setSessionCookie(res, token);

  res.status(201).json({
    user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)),
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
      ...publicUser(user),
    },
  });
});

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({
    user: publicUser(req.user),
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

app.get("/api/teams", authenticate, authorize("manager"), (req, res) => {
  const rows = db
    .prepare("SELECT id, organization_id, name, created_at FROM teams WHERE organization_id = ? ORDER BY name")
    .all(req.user.organization_id);
  res.json(rows);
});

app.post("/api/teams", authenticate, authorize("admin"), (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: "A team name between 1 and 100 characters is required." });
  }
  try {
    const team = { id: uuidv4(), organization_id: req.user.organization_id, name, created_at: new Date().toISOString() };
    db.prepare("INSERT INTO teams (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)").run(
      team.id, team.organization_id, team.name, team.created_at,
    );
    return res.status(201).json(team);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "A team with that name already exists." });
    }
    throw error;
  }
});

app.patch("/api/users/:id/team", authenticate, authorize("admin"), (req, res) => {
  const { team_id: teamId } = req.body || {};
  const team = db.prepare("SELECT * FROM teams WHERE id = ? AND organization_id = ?").get(teamId, req.user.organization_id);
  if (!team) return res.status(400).json({ error: "A valid team in your organization is required." });

  const target = db.prepare("SELECT * FROM users WHERE id = ? AND organization_id = ?").get(
    req.params.id,
    req.user.organization_id,
  );
  if (!target) return res.status(404).json({ error: "User not found." });

  db.prepare("UPDATE users SET team_id = ? WHERE id = ? AND organization_id = ?").run(
    teamId, target.id, req.user.organization_id,
  );
  res.json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(target.id)));
});

app.get("/api/users", authenticate, authorize("admin"), (req, res) => {
  const users = db
    .prepare("SELECT id, name, email, organization_id, team_id, role, created_at FROM users WHERE organization_id = ? ORDER BY name")
    .all(req.user.organization_id);
  res.json(users);
});

app.post("/api/users", authenticate, authorize("admin"), (req, res) => {
  const { name, email, password, role = "employee", team_id: teamId } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const cleanName = String(name || "").trim();
  if (!cleanName || cleanName.length > 120) return res.status(400).json({ error: "A valid name is required." });
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (!["employee", "manager"].includes(role)) {
    return res.status(400).json({ error: "New users may only be employees or managers." });
  }
  const team = db.prepare("SELECT id FROM teams WHERE id = ? AND organization_id = ?").get(
    teamId,
    req.user.organization_id,
  );
  if (!team) return res.status(400).json({ error: "A valid team in your organization is required." });
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const userId = uuidv4();
  const { hash, salt } = hashPassword(String(password));
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, password_salt, organization_id, team_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    cleanName,
    normalizedEmail,
    hash,
    salt,
    req.user.organization_id,
    teamId,
    role,
    new Date().toISOString(),
  );
  res.status(201).json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)));
});

app.patch("/api/users/:id/role", authenticate, authorize("admin"), (req, res) => {
  const { role } = req.body || {};
  if (!["employee", "manager", "admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be employee, manager, or admin." });
  }
  if (req.params.id === req.userId && role !== "admin") {
    return res.status(400).json({ error: "You cannot remove your own administrator role." });
  }
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND organization_id = ?").get(
    req.params.id,
    req.user.organization_id,
  );
  if (!target) return res.status(404).json({ error: "User not found." });
  db.prepare("UPDATE users SET role = ? WHERE id = ? AND organization_id = ?").run(
    role, target.id, req.user.organization_id,
  );
  res.json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(target.id)));
});

const DEFAULT_EXPENSE_LIMIT = 50;
const MAX_EXPENSE_LIMIT = 200;

app.get("/api/expenses", authenticate, (req, res) => {
  const { category } = req.query;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_EXPENSE_LIMIT;
  limit = Math.min(limit, MAX_EXPENSE_LIMIT);

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const scope = expenseScope(req);
  const whereClause = category ? `WHERE ${scope.clause} AND category = ?` : `WHERE ${scope.clause}`;
  const params = category ? [...scope.params, category] : scope.params;

  const { count: total } = db
    .prepare(`SELECT COUNT(*) as count FROM expenses ${whereClause}`)
    .get(...params);

  // `id` as a tiebreaker keeps ordering stable across pages when several
  // expenses share the same date — without it, LIMIT/OFFSET over ties in
  // the primary sort key isn't guaranteed to return each row exactly once.
  const items = db
    .prepare(`SELECT * FROM expenses ${whereClause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ items, total, limit, offset });
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
    organization_id: req.user.organization_id,
    team_id: req.user.team_id,
    created_by: req.userId,
    amount: Number(amount),
    category,
    description: description || "",
    vendor: vendor || "",
    date: date || new Date().toISOString().slice(0, 10),
    status: "draft",
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    rejected_by: null,
    rejection_reason: "",
    attachment_name: "",
    attachment_url: "",
  };

  db.prepare(
    `INSERT INTO expenses
      (id, user_id, organization_id, team_id, created_by, amount, category, description, vendor, date,
       status, submitted_at, submitted_by, approved_at, approved_by, rejected_at, rejected_by,
       rejection_reason, attachment_name, attachment_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    expense.id,
    expense.user_id,
    expense.organization_id,
    expense.team_id,
    expense.created_by,
    expense.amount,
    expense.category,
    expense.description,
    expense.vendor,
    expense.date,
    expense.status,
    expense.submitted_at,
    expense.submitted_by,
    expense.approved_at,
    expense.approved_by,
    expense.rejected_at,
    expense.rejected_by,
    expense.rejection_reason,
    expense.attachment_name,
    expense.attachment_url,
  );

  res.status(201).json(expense);
});

app.post("/api/expenses/:id/attachment", authenticate, upload.single("file"), async (req, res) => {
  const expense = db
    .prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.userId);

  if (!expense) {
    return res.status(404).json({ error: "Expense not found." });
  }
  if (expense.status !== "draft") {
    return res.status(409).json({ error: "Only draft expenses can be changed." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "A file is required." });
  }

  const filename = buildAttachmentName(req.file.originalname || req.file.filename, req.userId);
  let attachmentName = req.file.filename;

  if (req.file.buffer) {
    const { storage } = require("./firebase-admin");
    const objectPath = `organizations/${req.user.organization_id}/expenses/${req.params.id}/${filename}`;
    const object = storage.file(objectPath);

    await object.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype,
        metadata: { originalName: req.file.originalname || filename },
      },
      resumable: false,
    });
    attachmentName = objectPath;
  }

  const uploadedUrl = `/api/expenses/${req.params.id}/attachment/file`;

  db.prepare(
    "UPDATE expenses SET attachment_name = ?, attachment_url = ? WHERE id = ? AND user_id = ?"
  ).run(attachmentName, uploadedUrl, req.params.id, req.userId);

  res.json({
    attachment: {
      name: attachmentName,
      url: uploadedUrl,
    },
  });
});

app.get("/api/expenses/:id/attachment/file", authenticate, async (req, res) => {
  const expense = db
    .prepare("SELECT * FROM expenses WHERE id = ?")
    .get(req.params.id);

  if (!expense || !expense.attachment_name || !canAccessExpense(req, expense)) {
    return res.status(404).json({ error: "Attachment not found." });
  }

  if (expense.attachment_name.startsWith("organizations/")) {
    const { storage } = require("./firebase-admin");
    const object = storage.file(expense.attachment_name);
    const [metadata] = await object.getMetadata().catch(() => [null]);

    if (!metadata) {
      return res.status(404).json({ error: "Attachment not found." });
    }

    res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
    object.createReadStream().on("error", () => {
      if (!res.headersSent) res.status(404).json({ error: "Attachment not found." });
    }).pipe(res);
    return;
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
    .prepare("DELETE FROM expenses WHERE id = ? AND user_id = ? AND status = 'draft'")
    .run(req.params.id, req.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Expense not found." });
  }

  res.status(204).send();
});

app.post("/api/expenses/:id/submit", authenticate, (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!expense) return res.status(404).json({ error: "Expense not found." });
  if (expense.status !== "draft") return res.status(409).json({ error: "Only draft expenses can be submitted." });

  const submittedAt = new Date().toISOString();
  db.prepare(
    "UPDATE expenses SET status = 'submitted', submitted_at = ?, submitted_by = ? WHERE id = ? AND user_id = ? AND status = 'draft'"
  ).run(submittedAt, req.userId, expense.id, req.userId);
  recordApproval(expense.id, expense.organization_id, req.userId, "submitted", "draft", "submitted");
  res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(expense.id));
});

app.get("/api/expenses/pending-approval", authenticate, authorize("manager"), (req, res) => {
  const scope = expenseScope(req);
  const items = db
    .prepare(`SELECT * FROM expenses WHERE ${scope.clause} AND status = 'submitted' ORDER BY submitted_at ASC, id ASC`)
    .all(...scope.params);
  res.json(items);
});

app.get("/api/expenses/:id/approval-history", authenticate, (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense || !canAccessExpense(req, expense)) return res.status(404).json({ error: "Expense not found." });
  const history = db
    .prepare("SELECT * FROM approval_history WHERE expense_id = ? ORDER BY created_at ASC")
    .all(expense.id);
  res.json(history);
});

app.post("/api/expenses/:id/approve", authenticate, authorize("manager"), (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense || !canApproveExpense(req, expense)) return res.status(404).json({ error: "Expense not found." });
  if (expense.status !== "submitted") return res.status(409).json({ error: "Only submitted expenses can be approved." });

  const approvedAt = new Date().toISOString();
  db.prepare(
    "UPDATE expenses SET status = 'approved', approved_at = ?, approved_by = ?, rejection_reason = '' WHERE id = ? AND status = 'submitted'"
  ).run(approvedAt, req.userId, expense.id);
  recordApproval(expense.id, expense.organization_id, req.userId, "approved", "submitted", "approved", String(req.body?.comment || "").trim());
  res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(expense.id));
});

app.post("/api/expenses/:id/reject", authenticate, authorize("manager"), (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason || reason.length > 1000) return res.status(400).json({ error: "A rejection reason is required." });
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense || !canApproveExpense(req, expense)) return res.status(404).json({ error: "Expense not found." });
  if (expense.status !== "submitted") return res.status(409).json({ error: "Only submitted expenses can be rejected." });

  const rejectedAt = new Date().toISOString();
  db.prepare(
    "UPDATE expenses SET status = 'rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ? WHERE id = ? AND status = 'submitted'"
  ).run(rejectedAt, req.userId, reason, expense.id);
  recordApproval(expense.id, expense.organization_id, req.userId, "rejected", "submitted", "rejected", reason);
  res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(expense.id));
});

app.post("/api/expenses/:id/return", authenticate, authorize("manager"), (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense || !canApproveExpense(req, expense)) return res.status(404).json({ error: "Expense not found." });
  if (expense.status !== "submitted") return res.status(409).json({ error: "Only submitted expenses can be returned." });

  const comment = String(req.body?.comment || "").trim();
  db.prepare(
    "UPDATE expenses SET status = 'draft', submitted_at = NULL, submitted_by = NULL WHERE id = ? AND status = 'submitted'"
  ).run(expense.id);
  recordApproval(expense.id, expense.organization_id, req.userId, "returned", "submitted", "draft", comment);
  res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(expense.id));
});

app.get("/api/budgets", authenticate, (req, res) => {
  const rows = db
    .prepare("SELECT category, monthly_limit FROM organization_budgets WHERE organization_id = ?")
    .all(req.user.organization_id);
  const budgets = {};
  for (const row of rows) budgets[row.category] = row.monthly_limit;
  res.json(budgets);
});

app.put("/api/budgets/:category", authenticate, authorize("admin"), (req, res) => {
  const { category } = req.params;
  const { monthly_limit } = req.body;

  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Unknown category." });
  }
  if (monthly_limit === undefined || isNaN(monthly_limit) || Number(monthly_limit) < 0) {
    return res.status(400).json({ error: "A valid non-negative monthly_limit is required." });
  }

  db.prepare(
     `INSERT INTO organization_budgets (organization_id, category, monthly_limit)
      VALUES (?, ?, ?)
      ON CONFLICT(organization_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
    ).run(req.user.organization_id, category, Number(monthly_limit));

  res.json({ category, monthly_limit: Number(monthly_limit) });
});

app.delete("/api/budgets/:category", authenticate, authorize("admin"), (req, res) => {
  db.prepare("DELETE FROM organization_budgets WHERE organization_id = ? AND category = ?")
    .run(req.user.organization_id, req.params.category);
  res.status(204).send();
});

app.get("/api/summary", authenticate, (req, res) => {
  const totalsByCategory = {};
  for (const cat of CATEGORIES) totalsByCategory[cat] = 0;

  const scope = expenseScope(req);

  const rows = db
    .prepare(`SELECT category, SUM(amount) as total FROM expenses WHERE ${scope.clause} GROUP BY category`)
    .all(...scope.params);

  for (const row of rows) {
    totalsByCategory[row.category] = row.total;
  }

  const { total: grandTotal, count } = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE ${scope.clause}`)
    .get(...scope.params);

  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthRows = db
    .prepare(
      `SELECT category, SUM(amount) as total FROM expenses WHERE ${scope.clause} AND date LIKE ? GROUP BY category`
    )
    .all(...scope.params, `${monthPrefix}%`);

  const monthSpentByCategory = {};
  for (const cat of CATEGORIES) monthSpentByCategory[cat] = 0;
  for (const row of monthRows) monthSpentByCategory[row.category] = row.total;

  const budgetRows = db
    .prepare("SELECT category, monthly_limit FROM organization_budgets WHERE organization_id = ?")
    .all(req.user.organization_id);
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
