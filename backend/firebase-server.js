require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { randomUUID } = require("node:crypto");
const { auth, firestore, storage } = require("./firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");
const { errorHandler } = require("./error-handler");

const app = express();
const PORT = process.env.PORT || 4000;
const CATEGORIES = ["Rent", "Utilities", "Salaries", "Inventory", "Marketing", "Transport", "Equipment", "Miscellaneous"];
const PASSWORD_MIN_LENGTH = 8;
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((v) => v.trim()).filter(Boolean);

app.use(cors({ origin: (origin, cb) => (!origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"))), credentials: true }));
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)) return cb(null, true);
    const error = new Error("Unsupported file type");
    error.statusCode = 400;
    error.expose = true;
    return cb(error);
  },
});

const users = () => firestore.collection("users");
const organizations = () => firestore.collection("organizations");
const expenses = (orgId) => organizations().doc(orgId).collection("expenses");
const teams = (orgId) => organizations().doc(orgId).collection("teams");
const budgets = (orgId) => organizations().doc(orgId).collection("budgets");
const history = (orgId, expenseId) => expenses(orgId).doc(expenseId).collection("approvalHistory");

const plain = (value) => value instanceof Timestamp ? value.toDate().toISOString() : value;
function serialize(data) { return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, plain(value)])); }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, organization_id: user.organization_id, team_id: user.team_id || null, role: user.role || "employee" }; }
function now() { return new Date().toISOString(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function validPassword(value) { return typeof value === "string" && value.length >= PASSWORD_MIN_LENGTH; }
function userScope(user) {
  return user.role === "admin" ? (expense) => expense.organization_id === user.organization_id
    : user.role === "manager" ? (expense) => expense.organization_id === user.organization_id && expense.team_id === user.team_id
      : (expense) => expense.user_id === user.id;
}
function canAccess(user, expense) { return userScope(user)(expense); }
function canApprove(user, expense) { return canAccess(user, expense) && expense.user_id !== user.id && ["manager", "admin"].includes(user.role); }

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    const decoded = await auth.verifyIdToken(token);
    const snapshot = await users().doc(decoded.uid).get();
    if (!snapshot.exists) return res.status(401).json({ error: "User profile not found." });
    req.user = { id: decoded.uid, ...snapshot.data() };
    return next();
  } catch (error) { return next(error); }
}
function requireRole(role) {
  const ranks = { employee: 0, manager: 1, admin: 2 };
  return (req, res, next) => ranks[req.user?.role] >= ranks[role] ? next() : res.status(403).json({ error: "Insufficient permissions" });
}
async function readDocs(query) { const snapshot = await query.get(); return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })); }
async function getExpense(req, id) { const snapshot = await expenses(req.user.organization_id).doc(id).get(); return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null; }

function validateExpense(body) {
  const amount = Number(body?.amount);
  const category = body?.category;
  const description = String(body?.description || "").trim();
  const vendor = String(body?.vendor || "").trim();
  const date = String(body?.date || new Date().toISOString().slice(0, 10));
  if (!Number.isFinite(amount) || amount <= 0 || !CATEGORIES.includes(category)) return { error: "A valid positive amount and category are required." };
  if (description.length > 1000 || vendor.length > 200) return { error: "Vendor or description is too long." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Date must use YYYY-MM-DD." };
  return { amount, category, description, vendor, date };
}

async function transitionExpense(user, expenseId, action, body) {
  const expenseRef = expenses(user.organization_id).doc(expenseId);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(expenseRef);
    if (!snapshot.exists) {
      const error = new Error("Expense not found."); error.statusCode = 404; error.expose = true; throw error;
    }
    const expense = { id: snapshot.id, ...snapshot.data() };
    if (!canApprove(user, expense) || expense.status !== "submitted") {
      const error = new Error("Expense is not available for this action."); error.statusCode = 409; error.expose = true; throw error;
    }
    const update = { status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "draft" };
    if (action === "approve") Object.assign(update, { approved_at: now(), approved_by: user.id });
    if (action === "reject") {
      const reason = String(body?.reason || "").trim();
      if (!reason || reason.length > 1000) {
        const error = new Error("A rejection reason is required."); error.statusCode = 400; error.expose = true; throw error;
      }
      Object.assign(update, { rejected_at: now(), rejected_by: user.id, rejection_reason: reason });
    }
    const historyRef = history(user.organization_id, expense.id).doc();
    transaction.update(expenseRef, update);
    transaction.set(historyRef, { expense_id: expense.id, organization_id: user.organization_id, actor_id: user.id, action, from_status: expense.status, to_status: update.status, comment: body?.comment || body?.reason || "", created_at: now() });
    return { ...expense, ...update };
  });
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", async (req, res, next) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password;
  if (!name || name.length > 100 || !validEmail(email) || !validPassword(password)) return res.status(400).json({ error: `Name, valid email, and a password of at least ${PASSWORD_MIN_LENGTH} characters are required.` });
  let created;
  try {
    created = await auth.createUser({ email, password, displayName: name });
    const organizationId = randomUUID();
    const teamId = randomUUID();
    const createdAt = now();
    const profile = { name, email: created.email, organization_id: organizationId, team_id: teamId, role: "admin", created_at: createdAt };
    const batch = firestore.batch();
    batch.set(users().doc(created.uid), profile);
    batch.set(organizations().doc(organizationId), { name: `${profile.name}'s organization`, owner_id: created.uid, created_at: createdAt });
    batch.set(teams(organizationId).doc(teamId), { organization_id: organizationId, name: "General", created_at: createdAt });
    await batch.commit();
    return res.status(201).json({ user: publicUser({ id: created.uid, ...profile }) });
  } catch (error) {
    if (created) await auth.deleteUser(created.uid).catch(() => {});
    return next(error);
  }
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
app.post("/api/auth/login", (_req, res) => res.status(410).json({ error: "Sign in through Firebase Authentication." }));
app.post("/api/auth/logout", (_req, res) => res.status(204).send());
app.get("/api/categories", authenticate, (_req, res) => res.json(CATEGORIES));

app.get("/api/teams", authenticate, requireRole("manager"), async (req, res, next) => { try { res.json((await readDocs(teams(req.user.organization_id).orderBy("name"))).map(serialize)); } catch (error) { next(error); } });
app.post("/api/teams", authenticate, requireRole("admin"), async (req, res, next) => { try { const name = String(req.body?.name || "").trim(); if (!name || name.length > 100) return res.status(400).json({ error: "A team name between 1 and 100 characters is required." }); const existing = await teams(req.user.organization_id).where("name", "==", name).limit(1).get(); if (!existing.empty) return res.status(409).json({ error: "A team with that name already exists." }); const team = { organization_id: req.user.organization_id, name, created_at: now() }; const ref = await teams(req.user.organization_id).add(team); res.status(201).json({ id: ref.id, ...team }); } catch (error) { next(error); } });

app.get("/api/users", authenticate, requireRole("admin"), async (req, res, next) => { try { res.json((await readDocs(users().where("organization_id", "==", req.user.organization_id))).sort((a, b) => a.name.localeCompare(b.name)).map(serialize)); } catch (error) { next(error); } });
app.post("/api/users", authenticate, requireRole("admin"), async (req, res, next) => { const { name, email, password, role = "employee", team_id = null } = req.body || {}; if (!String(name || "").trim() || !validEmail(email) || !validPassword(password) || !["employee", "manager"].includes(role)) return res.status(400).json({ error: `Valid name, email, password of at least ${PASSWORD_MIN_LENGTH} characters, and role are required.` }); let created; try { if (team_id && !(await teams(req.user.organization_id).doc(team_id).get()).exists) return res.status(400).json({ error: "Invalid team." }); created = await auth.createUser({ email: String(email).trim().toLowerCase(), password: String(password), displayName: String(name).trim() }); const profile = { name: String(name).trim(), email: created.email, organization_id: req.user.organization_id, team_id, role, created_at: now() }; await users().doc(created.uid).set(profile); res.status(201).json(publicUser({ id: created.uid, ...profile })); } catch (error) { if (created) await auth.deleteUser(created.uid).catch(() => {}); next(error); } });
app.patch("/api/users/:id/role", authenticate, requireRole("admin"), async (req, res, next) => { try { if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot remove your own admin role." }); const role = req.body?.role; if (!["employee", "manager", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role." }); const ref = users().doc(req.params.id); const snap = await ref.get(); if (!snap.exists || snap.data().organization_id !== req.user.organization_id) return res.status(404).json({ error: "User not found." }); await ref.update({ role }); res.json(publicUser({ id: req.params.id, ...snap.data(), role })); } catch (error) { next(error); } });
app.patch("/api/users/:id/team", authenticate, requireRole("admin"), async (req, res, next) => { try { const ref = users().doc(req.params.id); const snap = await ref.get(); if (!snap.exists || snap.data().organization_id !== req.user.organization_id) return res.status(404).json({ error: "User not found." }); const teamId = req.body?.team_id || null; if (teamId && !(await teams(req.user.organization_id).doc(teamId).get()).exists) return res.status(400).json({ error: "Invalid team." }); await ref.update({ team_id: teamId }); res.json(publicUser({ id: req.params.id, ...snap.data(), team_id: teamId })); } catch (error) { next(error); } });

app.get("/api/expenses", authenticate, async (req, res, next) => { try { let items = (await readDocs(expenses(req.user.organization_id))).filter(userScope(req.user)); if (req.query.category) items = items.filter((item) => item.category === req.query.category); items.sort((a, b) => `${b.date}|${b.id}`.localeCompare(`${a.date}|${a.id}`)); const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200); const offset = Math.max(Number(req.query.offset) || 0, 0); res.json({ items: items.slice(offset, offset + limit).map(serialize), total: items.length, limit, offset }); } catch (error) { next(error); } });
app.post("/api/expenses", authenticate, async (req, res, next) => { try { const input = validateExpense(req.body); if (input.error) return res.status(400).json({ error: input.error }); const expense = { user_id: req.user.id, organization_id: req.user.organization_id, team_id: req.user.team_id || null, created_by: req.user.id, ...input, status: "draft", submitted_at: null, submitted_by: null, approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, rejection_reason: "", attachment_name: "", attachment_url: "" }; const ref = await expenses(req.user.organization_id).add(expense); res.status(201).json({ id: ref.id, ...expense }); } catch (error) { next(error); } });

app.post("/api/expenses/:id/attachment", authenticate, upload.single("file"), async (req, res, next) => { let objectPath = null; try { const expense = await getExpense(req, req.params.id); if (!expense || expense.user_id !== req.user.id) return res.status(404).json({ error: "Expense not found." }); if (expense.status !== "draft") return res.status(409).json({ error: "Only draft expenses can be changed." }); if (!req.file) return res.status(400).json({ error: "A supported file is required." }); const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`; objectPath = `organizations/${req.user.organization_id}/expenses/${req.params.id}/${safeName}`; await storage.file(objectPath).save(req.file.buffer, { resumable: false, metadata: { contentType: req.file.mimetype } }); await expenses(req.user.organization_id).doc(req.params.id).update({ attachment_name: objectPath, attachment_url: `/api/expenses/${req.params.id}/attachment/file` }); res.json({ attachment: { name: objectPath, url: `/api/expenses/${req.params.id}/attachment/file` } }); } catch (error) { if (objectPath) await storage.file(objectPath).delete({ ignoreNotFound: true }).catch(() => {}); next(error); } });
app.get("/api/expenses/:id/attachment/file", authenticate, async (req, res, next) => { try { const expense = await getExpense(req, req.params.id); if (!expense || !expense.attachment_name || !canAccess(req.user, expense)) return res.status(404).json({ error: "Attachment not found." }); const object = storage.file(expense.attachment_name); const [metadata] = await object.getMetadata().catch(() => [null]); if (!metadata) return res.status(404).json({ error: "Attachment not found." }); res.setHeader("Content-Type", metadata.contentType || "application/octet-stream"); object.createReadStream().on("error", next).pipe(res); } catch (error) { next(error); } });

app.delete("/api/expenses/:id", authenticate, async (req, res, next) => { try { const expense = await getExpense(req, req.params.id); if (!expense || expense.user_id !== req.user.id || expense.status !== "draft") return res.status(404).json({ error: "Expense not found." }); if (expense.attachment_name) await storage.file(expense.attachment_name).delete({ ignoreNotFound: true }); await expenses(req.user.organization_id).doc(expense.id).delete(); res.status(204).send(); } catch (error) { next(error); } });
app.post("/api/expenses/:id/submit", authenticate, async (req, res, next) => { try { const expense = await getExpense(req, req.params.id); if (!expense || expense.user_id !== req.user.id || expense.status !== "draft") return res.status(409).json({ error: "Only your draft expenses can be submitted." }); const update = { status: "submitted", submitted_at: now(), submitted_by: req.user.id }; const expenseRef = expenses(req.user.organization_id).doc(expense.id); const historyRef = history(req.user.organization_id, expense.id).doc(); const batch = firestore.batch(); batch.update(expenseRef, update); batch.set(historyRef, { expense_id: expense.id, organization_id: req.user.organization_id, actor_id: req.user.id, action: "submitted", from_status: "draft", to_status: "submitted", comment: "", created_at: now() }); await batch.commit(); res.json({ ...expense, ...update }); } catch (error) { next(error); } });
app.get("/api/expenses/pending-approval", authenticate, requireRole("manager"), async (req, res, next) => { try { const submitted = await readDocs(expenses(req.user.organization_id).where("status", "==", "submitted")); res.json(submitted.filter(userScope(req.user)).sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).map(serialize)); } catch (error) { next(error); } });
app.get("/api/expenses/:id/approval-history", authenticate, async (req, res, next) => { try { const expense = await getExpense(req, req.params.id); if (!expense || !canAccess(req.user, expense)) return res.status(404).json({ error: "Expense not found." }); res.json((await readDocs(history(req.user.organization_id, expense.id).orderBy("created_at"))).map(serialize)); } catch (error) { next(error); } });
app.post("/api/expenses/:id/approve", authenticate, requireRole("manager"), async (req, res, next) => { try { res.json(await transitionExpense(req.user, req.params.id, "approve", req.body)); } catch (error) { next(error); } });
app.post("/api/expenses/:id/reject", authenticate, requireRole("manager"), async (req, res, next) => { try { res.json(await transitionExpense(req.user, req.params.id, "reject", req.body)); } catch (error) { next(error); } });
app.post("/api/expenses/:id/return", authenticate, requireRole("manager"), async (req, res, next) => { try { res.json(await transitionExpense(req.user, req.params.id, "return", req.body)); } catch (error) { next(error); } });

app.get("/api/budgets", authenticate, async (req, res, next) => { try { const result = {}; for (const budget of await readDocs(budgets(req.user.organization_id))) result[budget.id] = budget.monthly_limit; res.json(result); } catch (error) { next(error); } });
app.put("/api/budgets/:category", authenticate, requireRole("admin"), async (req, res, next) => { try { const value = Number(req.body?.monthly_limit); if (!CATEGORIES.includes(req.params.category) || !Number.isFinite(value) || value < 0) return res.status(400).json({ error: "Invalid budget." }); await budgets(req.user.organization_id).doc(req.params.category).set({ category: req.params.category, monthly_limit: value }); res.json({ category: req.params.category, monthly_limit: value }); } catch (error) { next(error); } });
app.delete("/api/budgets/:category", authenticate, requireRole("admin"), async (req, res, next) => { try { if (!CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: "Invalid category." }); await budgets(req.user.organization_id).doc(req.params.category).delete(); res.status(204).send(); } catch (error) { next(error); } });
app.get("/api/summary", authenticate, async (req, res, next) => { try { const all = (await readDocs(expenses(req.user.organization_id))).filter(userScope(req.user)); const approved = all.filter((e) => e.status === "approved"); const month = new Date().toISOString().slice(0, 7); const totalsByCategory = Object.fromEntries(CATEGORIES.map((category) => [category, approved.filter((e) => e.category === category).reduce((sum, e) => sum + Number(e.amount), 0)])); const monthSpentByCategory = Object.fromEntries(CATEGORIES.map((category) => [category, approved.filter((e) => e.category === category && String(e.date).startsWith(month)).reduce((sum, e) => sum + Number(e.amount), 0)])); const budgetRows = await readDocs(budgets(req.user.organization_id)); res.json({ totalsByCategory, grandTotal: approved.reduce((sum, e) => sum + Number(e.amount), 0), count: approved.length, month, monthSpentByCategory, budgets: Object.fromEntries(budgetRows.map((b) => [b.id, b.monthly_limit])) }); } catch (error) { next(error); } });

app.use(errorHandler);

if (require.main === module) app.listen(PORT, () => console.log(`Firebase API listening on port ${PORT}`));
module.exports = app;
