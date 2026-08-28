import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { auth, firestore, storage } from "./firebase-admin.js";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { userScope, canAccess, canApprove, scopeUsers, requireRole } from "./authorize.js";
import { isBudgetCountable } from "./expenseRules.js";
import { createRateLimiter } from "./rateLimit.js";

const app = express();
const PORT = process.env.PORT || 4000;
const CATEGORIES = ["Rent", "Utilities", "Salaries", "Inventory", "Marketing", "Transport", "Equipment", "Miscellaneous"];
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((v) => v.trim()).filter(Boolean);

app.use(cors({ origin: (origin, cb) => (!origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"))), credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.set("trust proxy", true);

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  scope: "register",
  message: "Too many accounts created from this connection. Please try again later.",
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"].includes(file.mimetype)),
});

const users = () => firestore.collection("users");
const organizations = () => firestore.collection("organizations");
const expenses = (orgId) => organizations().doc(orgId).collection("expenses");
const teams = (orgId) => organizations().doc(orgId).collection("teams");
const budgets = (orgId) => organizations().doc(orgId).collection("budgets");
const history = (orgId, expenseId) => expenses(orgId).doc(expenseId).collection("approvalHistory");

const plain = (value) => value instanceof Timestamp ? value.toDate().toISOString() : value;
function serialize(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, plain(value)]));
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, organization_id: user.organization_id, team_id: user.team_id || null, role: user.role || "employee" };
}
function now() { return new Date().toISOString(); }
async function getTeamName(orgId, teamId) {
  if (!teamId) return null;
  const snap = await teams(orgId).doc(teamId).get();
  return snap.exists ? snap.data().name : null;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    const decoded = await auth.verifyIdToken(token);
    const snapshot = await users().doc(decoded.uid).get();
    if (!snapshot.exists) return res.status(401).json({ error: "User profile not found." });
    req.user = { id: decoded.uid, ...snapshot.data() };
    next();
  } catch { return res.status(401).json({ error: "Invalid authentication token." }); }
}
async function readDocs(query) { const snapshot = await query.get(); return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })); }
async function getExpense(req, id) {
  const snapshot = await expenses(req.user.organization_id).doc(id).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}
async function writeHistory(user, expense, action, fromStatus, toStatus, comment = "") {
  await history(user.organization_id, expense.id).add({ expense_id: expense.id, organization_id: user.organization_id, actor_id: user.id, action, from_status: fromStatus, to_status: toStatus, comment, created_at: now() });
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!String(name || "").trim() || !email || !password || String(password).length < 6) return res.status(400).json({ error: "Name, valid email, and a password of at least 6 characters are required." });
  try {
    const created = await auth.createUser({ email: String(email).trim().toLowerCase(), password: String(password), displayName: String(name).trim() });
    const organizationId = randomUUID();
    const teamId = randomUUID();
    const createdAt = now();
    const profile = { name: String(name).trim(), email: created.email, organization_id: organizationId, team_id: teamId, role: "admin", created_at: createdAt };
    const batch = firestore.batch();
    batch.set(users().doc(created.uid), profile);
    batch.set(organizations().doc(organizationId), { name: `${profile.name}'s organization`, owner_id: created.uid, created_at: createdAt });
    batch.set(teams(organizationId).doc(teamId), { organization_id: organizationId, name: "General", created_at: createdAt });
    await batch.commit();
    res.status(201).json({ user: publicUser({ id: created.uid, ...profile }) });
  } catch (error) { res.status(error.code === "auth/email-already-exists" ? 409 : 400).json({ error: error.message }); }
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  const team_name = await getTeamName(req.user.organization_id, req.user.team_id);
  res.json({ user: { ...publicUser(req.user), team_name } });
});
app.post("/api/auth/login", (_req, res) => res.status(410).json({ error: "Sign in through Firebase Authentication." }));
app.post("/api/auth/logout", (_req, res) => res.status(204).send());
app.get("/api/categories", authenticate, (_req, res) => res.json(CATEGORIES));

app.get("/api/teams", authenticate, requireRole("manager"), async (req, res) => res.json((await readDocs(teams(req.user.organization_id).orderBy("name"))).map(serialize)));
app.post("/api/teams", authenticate, requireRole("admin"), async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name || name.length > 100) return res.status(400).json({ error: "A team name between 1 and 100 characters is required." });
  const existing = await teams(req.user.organization_id).where("name", "==", name).limit(1).get();
  if (!existing.empty) return res.status(409).json({ error: "A team with that name already exists." });
  const team = { organization_id: req.user.organization_id, name, created_at: now() };
  const ref = await teams(req.user.organization_id).add(team);
  res.status(201).json({ id: ref.id, ...team });
});

app.get("/api/users", authenticate, requireRole("manager"), async (req, res) => {
  const orgUsers = await readDocs(users().where("organization_id", "==", req.user.organization_id));
  res.json(scopeUsers(req.user, orgUsers).sort((a, b) => a.name.localeCompare(b.name)).map(serialize));
});
app.post("/api/users", authenticate, requireRole("admin"), async (req, res) => {
  const { name, email, password, role = "employee", team_id = null } = req.body || {};
  if (!name || !email || !password || !["employee", "manager"].includes(role)) return res.status(400).json({ error: "Valid name, email, password, and role are required." });
  if (team_id && !(await teams(req.user.organization_id).doc(team_id).get()).exists) return res.status(400).json({ error: "Invalid team." });
  try {
    const created = await auth.createUser({ email: String(email).trim().toLowerCase(), password: String(password), displayName: String(name).trim() });
    const profile = { name: String(name).trim(), email: created.email, organization_id: req.user.organization_id, team_id, role, created_at: now() };
    await users().doc(created.uid).set(profile);
    res.status(201).json(publicUser({ id: created.uid, ...profile }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch("/api/users/:id/role", authenticate, requireRole("admin"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot remove your own admin role." });
  const role = req.body?.role;
  if (!["employee", "manager", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role." });
  const ref = users().doc(req.params.id); const snap = await ref.get();
  if (!snap.exists || snap.data().organization_id !== req.user.organization_id) return res.status(404).json({ error: "User not found." });
  await ref.update({ role }); res.json(publicUser({ id: req.params.id, ...snap.data(), role }));
});
app.patch("/api/users/:id/team", authenticate, requireRole("admin"), async (req, res) => {
  const ref = users().doc(req.params.id); const snap = await ref.get();
  if (!snap.exists || snap.data().organization_id !== req.user.organization_id) return res.status(404).json({ error: "User not found." });
  const teamId = req.body?.team_id || null;
  if (teamId && !(await teams(req.user.organization_id).doc(teamId).get()).exists) return res.status(400).json({ error: "Invalid team." });
  await ref.update({ team_id: teamId }); res.json(publicUser({ id: req.params.id, ...snap.data(), team_id: teamId }));
});

app.get("/api/expenses", authenticate, async (req, res) => {
  let items = (await readDocs(expenses(req.user.organization_id))).filter(userScope(req.user));
  if (req.query.category) items = items.filter((item) => item.category === req.query.category);
  items.sort((a, b) => `${b.date}|${b.id}`.localeCompare(`${a.date}|${a.id}`));
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200); const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({ items: items.slice(offset, offset + limit).map(serialize), total: items.length, limit, offset });
});
app.post("/api/expenses", authenticate, async (req, res) => {
  const { amount, category, description = "", vendor = "", date = new Date().toISOString().slice(0, 10) } = req.body || {};
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0 || !CATEGORIES.includes(category)) return res.status(400).json({ error: "A valid positive amount and category are required." });
  const expense = { user_id: req.user.id, user_name: req.user.name, organization_id: req.user.organization_id, team_id: req.user.team_id || null, created_by: req.user.id, amount: Number(amount), category, description, vendor, date, status: "draft", submitted_at: null, submitted_by: null, approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, rejection_reason: "", attachment_name: "", attachment_url: "" };
  const ref = await expenses(req.user.organization_id).add(expense); res.status(201).json({ id: ref.id, ...expense });
});

app.post("/api/expenses/:id/attachment", authenticate, upload.single("file"), async (req, res) => {
  const expense = await getExpense(req, req.params.id);
  if (!expense || expense.user_id !== req.user.id) return res.status(404).json({ error: "Expense not found." });
  if (expense.status !== "draft") return res.status(409).json({ error: "Only draft expenses can be changed." });
  if (!req.file) return res.status(400).json({ error: "A supported file is required." });
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  const objectPath = `organizations/${req.user.organization_id}/expenses/${req.params.id}/${safeName}`;
  await storage.file(objectPath).save(req.file.buffer, { resumable: false, metadata: { contentType: req.file.mimetype } });
  await expenses(req.user.organization_id).doc(req.params.id).update({ attachment_name: objectPath, attachment_url: `/api/expenses/${req.params.id}/attachment/file` });
  res.json({ attachment: { name: objectPath, url: `/api/expenses/${req.params.id}/attachment/file` } });
});
app.get("/api/expenses/:id/attachment/file", authenticate, async (req, res) => {
  const expense = await getExpense(req, req.params.id);
  if (!expense || !expense.attachment_name || !canAccess(req.user, expense)) return res.status(404).json({ error: "Attachment not found." });
  const object = storage.file(expense.attachment_name); const [metadata] = await object.getMetadata().catch(() => [null]);
  if (!metadata) return res.status(404).json({ error: "Attachment not found." });
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream"); object.createReadStream().pipe(res);
});

async function transition(req, res, action) {
  const expense = await getExpense(req, req.params.id);
  if (!expense || !canApprove(req.user, expense) || expense.status !== "submitted") return res.status(409).json({ error: "Expense is not available for this action." });
  const update = { status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "draft" };
  if (action === "approve") Object.assign(update, { approved_at: now(), approved_by: req.user.id });
  if (action === "reject") { const reason = String(req.body?.reason || "").trim(); if (!reason || reason.length > 1000) return res.status(400).json({ error: "A rejection reason is required." }); Object.assign(update, { rejected_at: now(), rejected_by: req.user.id, rejection_reason: reason }); }
  await expenses(req.user.organization_id).doc(expense.id).update(update); await writeHistory(req.user, expense, action, expense.status, update.status, req.body?.comment || req.body?.reason || ""); res.json({ ...expense, ...update });
}
app.delete("/api/expenses/:id", authenticate, async (req, res) => { const expense = await getExpense(req, req.params.id); if (!expense || expense.user_id !== req.user.id || expense.status !== "draft") return res.status(404).json({ error: "Expense not found." }); await expenses(req.user.organization_id).doc(expense.id).delete(); res.status(204).send(); });
app.post("/api/expenses/:id/submit", authenticate, async (req, res) => { const expense = await getExpense(req, req.params.id); if (!expense || expense.user_id !== req.user.id || expense.status !== "draft") return res.status(409).json({ error: "Only your draft expenses can be submitted." }); const update = { status: "submitted", submitted_at: now(), submitted_by: req.user.id }; await expenses(req.user.organization_id).doc(expense.id).update(update); await writeHistory(req.user, expense, "submitted", "draft", "submitted"); res.json({ ...expense, ...update }); });
app.get("/api/expenses/pending-approval", authenticate, requireRole("manager"), async (req, res) => res.json((await readDocs(expenses(req.user.organization_id).where("status", "==", "submitted"))).filter(userScope(req.user)).sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).map(serialize)));
app.get("/api/expenses/:id/approval-history", authenticate, async (req, res) => { const expense = await getExpense(req, req.params.id); if (!expense || !canAccess(req.user, expense)) return res.status(404).json({ error: "Expense not found." }); res.json((await readDocs(history(req.user.organization_id, expense.id).orderBy("created_at"))).map(serialize)); });
app.post("/api/expenses/:id/approve", authenticate, requireRole("manager"), (req, res) => transition(req, res, "approve"));
app.post("/api/expenses/:id/reject", authenticate, requireRole("manager"), (req, res) => transition(req, res, "reject"));
app.post("/api/expenses/:id/return", authenticate, requireRole("manager"), (req, res) => transition(req, res, "return"));

app.get("/api/budgets", authenticate, async (req, res) => { const result = {}; for (const budget of await readDocs(budgets(req.user.organization_id))) result[budget.id] = budget.monthly_limit; res.json(result); });
app.put("/api/budgets/:category", authenticate, requireRole("admin"), async (req, res) => { const value = Number(req.body?.monthly_limit); if (!CATEGORIES.includes(req.params.category) || Number.isNaN(value) || value < 0) return res.status(400).json({ error: "Invalid budget." }); await budgets(req.user.organization_id).doc(req.params.category).set({ category: req.params.category, monthly_limit: value }); res.json({ category: req.params.category, monthly_limit: value }); });
app.delete("/api/budgets/:category", authenticate, requireRole("admin"), async (req, res) => { await budgets(req.user.organization_id).doc(req.params.category).delete(); res.status(204).send(); });
app.get("/api/summary", authenticate, async (req, res) => { const all = (await readDocs(expenses(req.user.organization_id))).filter(userScope(req.user)); const totalsByCategory = Object.fromEntries(CATEGORIES.map((category) => [category, all.filter((e) => e.category === category).reduce((sum, e) => sum + Number(e.amount), 0)])); const month = new Date().toISOString().slice(0, 7); const monthSpentByCategory = Object.fromEntries(CATEGORIES.map((category) => [category, all.filter((e) => e.category === category && String(e.date).startsWith(month) && isBudgetCountable(e)).reduce((sum, e) => sum + Number(e.amount), 0)])); const budgetRows = await readDocs(budgets(req.user.organization_id)); res.json({ totalsByCategory, grandTotal: all.reduce((sum, e) => sum + Number(e.amount), 0), count: all.length, month, monthSpentByCategory, budgets: Object.fromEntries(budgetRows.map((b) => [b.id, b.monthly_limit])) }); });

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`Firebase API listening on port ${PORT}`));
}

export default app;
