import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "./firebase";

const configuredApiUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";
const API_URL = configuredApiUrl.replace(/\/$/, "").replace(/\/api$/, "");

async function apiFetch(path, options = {}) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : "";
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  });
  if (response.status === 401) {
    await signOut(auth).catch(() => {});
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Request failed.");
  }
  if (response.status === 204) return null;
  return response.json();
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [hasMoreExpenses, setHasMoreExpenses] = useState(false);
  const [nextExpenseCursor, setNextExpenseCursor] = useState("");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminTeams, setAdminTeams] = useState([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "employee", team_id: "" });
  const [adminError, setAdminError] = useState("");
  const EXPENSES_PAGE_SIZE = 50;
  const [summary, setSummary] = useState({ totalsByCategory: {}, grandTotal: 0, count: 0, month: "", monthSpentByCategory: {}, budgets: {} });
  const [form, setForm] = useState({ amount: "", category: "", description: "", vendor: "", date: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [budgetDrafts, setBudgetDrafts] = useState({});
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) { setUser(null); setIsLoadingUser(false); return; }
      try { const data = await apiFetch("/api/auth/me"); setUser(data?.user || null); }
      catch { setUser(null); }
      finally { setIsLoadingUser(false); }
    });
    return unsubscribe;
  }, []);

  async function loadAll() {
    if (!user) return;
    const requests = [apiFetch("/api/categories"), apiFetch(`/api/expenses?limit=${EXPENSES_PAGE_SIZE}${filterCategory ? `&category=${encodeURIComponent(filterCategory)}` : ""}`), apiFetch("/api/summary")];
    if (["manager", "admin"].includes(user.role)) requests.push(apiFetch("/api/expenses/pending-approval"));
    if (user.role === "admin") { requests.push(apiFetch("/api/users")); requests.push(apiFetch("/api/teams")); }
    const [catsRes, expRes, sumRes, pendingRes, usersRes, teamsRes] = await Promise.all(requests);
    setCategories(catsRes || []);
    setExpenses(expRes?.items || []);
    setExpensesTotal(expRes?.total || 0);
    setHasMoreExpenses(Boolean(expRes?.hasMore));
    setNextExpenseCursor(expRes?.nextCursor || "");
    setPendingApprovals(pendingRes || []);
    setAdminUsers(usersRes || []);
    setAdminTeams(teamsRes || []);
    setSummary(sumRes || { totalsByCategory: {}, grandTotal: 0, count: 0, month: "", monthSpentByCategory: {}, budgets: {} });
  }

  async function loadMoreExpenses() {
    if (!hasMoreExpenses || !nextExpenseCursor) return;
    setIsLoadingMore(true);
    try {
      const res = await apiFetch(`/api/expenses?limit=${EXPENSES_PAGE_SIZE}&cursor=${encodeURIComponent(nextExpenseCursor)}${filterCategory ? `&category=${encodeURIComponent(filterCategory)}` : ""}`);
      setExpenses((prev) => [...prev, ...(res?.items || [])]);
      setExpensesTotal(res?.total ?? expensesTotal);
      setHasMoreExpenses(Boolean(res?.hasMore));
      setNextExpenseCursor(res?.nextCursor || "");
    } finally { setIsLoadingMore(false); }
  }

  useEffect(() => { if (user) loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user, filterCategory]);

  async function handleAuthSubmit(e) {
    e.preventDefault(); setAuthError("");
    try {
      const payload = authMode === "login" ? { email: authForm.email, password: authForm.password } : { name: authForm.name, email: authForm.email, password: authForm.password };
      if (authMode === "login") await signInWithEmailAndPassword(auth, payload.email, payload.password);
      else {
        const response = await fetch(`${API_URL}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Registration failed.");
        await signInWithEmailAndPassword(auth, payload.email, payload.password);
      }
      const data = await apiFetch("/api/auth/me"); setUser(data.user); setAuthForm({ name: "", email: "", password: "" });
    } catch (error) { setAuthError(error.message || "Authentication failed."); }
  }

  async function handleLogout() {
    try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch { /* Firebase logout still clears local auth. */ }
    finally {
      await signOut(auth); setUser(null); setCategories([]); setExpenses([]); setExpensesTotal(0); setHasMoreExpenses(false); setNextExpenseCursor(""); setPendingApprovals([]); setAdminUsers([]); setAdminTeams([]); setSummary({ totalsByCategory: {}, grandTotal: 0, count: 0, month: "", monthSpentByCategory: {}, budgets: {} }); setFilterCategory("");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault(); setError(""); let createdExpense;
    try {
      createdExpense = await apiFetch("/api/expenses", { method: "POST", body: JSON.stringify(form) });
      if (pendingAttachment && createdExpense?.id) {
        const formData = new FormData(); formData.append("file", pendingAttachment); setUploading(true);
        const uploadResponse = await fetch(`${API_URL}/api/expenses/${createdExpense.id}/attachment`, { method: "POST", credentials: "include", headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` }, body: formData });
        const uploadData = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok) throw new Error(uploadData.error || "Attachment upload failed.");
      }
      setPendingAttachment(null); setForm({ amount: "", category: "", description: "", vendor: "", date: new Date().toISOString().slice(0, 10) }); await loadAll();
    } catch (loadError) {
      if (createdExpense?.id) await apiFetch(`/api/expenses/${createdExpense.id}`, { method: "DELETE" }).catch(() => {});
      setError(loadError.message || "Failed to add expense.");
    } finally { setUploading(false); }
  }

  async function handleDelete(id) { await apiFetch(`/api/expenses/${id}`, { method: "DELETE" }); loadAll(); }
  async function handleSubmitForApproval(id) { try { await apiFetch(`/api/expenses/${id}/submit`, { method: "POST" }); await loadAll(); } catch (submitError) { setError(submitError.message || "Could not submit expense."); } }
  async function handleApproval(id, action) { const body = {}; if (action === "reject") { const reason = window.prompt("Why is this expense being rejected?"); if (!reason?.trim()) return; body.reason = reason.trim(); } else if (action === "return") body.comment = window.prompt("Optional correction note:")?.trim() || ""; try { await apiFetch(`/api/expenses/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }); await loadAll(); } catch (approvalError) { setError(approvalError.message || "Could not update approval status."); } }
  async function handleCreateTeam(e) { e.preventDefault(); setAdminError(""); try { await apiFetch("/api/teams", { method: "POST", body: JSON.stringify({ name: newTeamName }) }); setNewTeamName(""); await loadAll(); } catch (createError) { setAdminError(createError.message || "Could not create team."); } }
  async function handleCreateUser(e) { e.preventDefault(); setAdminError(""); try { await apiFetch("/api/users", { method: "POST", body: JSON.stringify(newUser) }); setNewUser({ name: "", email: "", password: "", role: "employee", team_id: "" }); await loadAll(); } catch (createError) { setAdminError(createError.message || "Could not create user."); } }
  async function handleRoleChange(userId, role) { setAdminError(""); try { await apiFetch(`/api/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }); await loadAll(); } catch (roleError) { setAdminError(roleError.message || "Could not update role."); } }
  async function handleTeamChange(userId, teamId) { setAdminError(""); try { await apiFetch(`/api/users/${userId}/team`, { method: "PATCH", body: JSON.stringify({ team_id: teamId }) }); await loadAll(); } catch (teamError) { setAdminError(teamError.message || "Could not update team."); } }
  async function handleViewAttachment(expenseId) { try { const response = await fetch(`${API_URL}/api/expenses/${expenseId}/attachment/file`, { credentials: "include", headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } }); if (!response.ok) throw new Error("Could not load attachment."); const blob = await response.blob(); const objectUrl = URL.createObjectURL(blob); window.open(objectUrl, "_blank", "noopener,noreferrer"); setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); } catch (err) { setError(err.message || "Could not load attachment."); } }
  async function handleSetBudget(category) { const value = budgetDrafts[category]; if (value === undefined || value === "") return; await apiFetch(`/api/budgets/${encodeURIComponent(category)}`, { method: "PUT", body: JSON.stringify({ monthly_limit: Number(value) }) }); setBudgetDrafts({ ...budgetDrafts, [category]: "" }); loadAll(); }
  async function handleClearBudget(category) { await apiFetch(`/api/budgets/${encodeURIComponent(category)}`, { method: "DELETE" }); loadAll(); }

  if (!user || isLoadingUser) return (<div className="page auth-page"><div className="auth-card"><h1>Owo Track</h1><p className="subtitle">Track spending with your own account</p><div className="auth-toggle"><button type="button" className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")}>Login</button><button type="button" className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")}>Register</button></div><form onSubmit={handleAuthSubmit} className="auth-form">{authMode === "register" && <label>Full name<input type="text" value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} required /></label>}<label>Email<input type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} required /></label><label>Password<input type="password" value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required minLength={8} /></label>{authError && <p className="error">{authError}</p>}<button type="submit">{authMode === "login" ? "Log in" : "Create account"}</button></form></div></div>);

  return (<div className="page"><header className="topbar"><div><h1>Owo Track</h1><p className="subtitle">Welcome, {user?.name || "there"}</p><p className="role-label">{user?.role || "employee"}</p></div><button className="logout-button" onClick={handleLogout}>Log out</button></header><section className="summary"><div className="summary-card total"><span className="label">Total Spent</span><span className="value">₦{summary.grandTotal.toLocaleString()}</span></div>{Object.entries(summary.totalsByCategory).filter(([, amt]) => amt > 0).map(([cat, amt]) => <div className="summary-card" key={cat}><span className="label">{cat}</span><span className="value">₦{amt.toLocaleString()}</span></div>)}</section>{user.role === "admin" && (<section className="admin-section"><div className="admin-heading"><div><h2>Admin workspace</h2><p className="section-note">Manage organization access, teams, and approval coverage.</p></div><span className="admin-organization">{user.organization_id ? "Organization owner" : "Admin"}</span></div><div className="admin-metrics"><div><strong>{adminUsers.length}</strong><span>Users</span></div><div><strong>{adminTeams.length}</strong><span>Teams</span></div><div><strong>{pendingApprovals.length}</strong><span>Pending approvals</span></div><div><strong>{summary.count}</strong><span>Visible expenses</span></div></div><div className="admin-grid"><form className="admin-card" onSubmit={handleCreateTeam}><h3>Create team</h3><label>Team name<input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} maxLength={100} required placeholder="e.g. Operations" /></label><button type="submit">Add team</button></form><form className="admin-card" onSubmit={handleCreateUser}><h3>Create organization user</h3><div className="admin-form-row"><label>Name<input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} required /></label><label>Email<input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} required /></label></div><div className="admin-form-row"><label>Temporary password<input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} minLength={8} required /></label><label>Role<select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}><option value="employee">Employee</option><option value="manager">Manager</option></select></label><label>Team<select value={newUser.team_id} onChange={(e) => setNewUser({ ...newUser, team_id: e.target.value })}><option value="">No team</option>{adminTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label></div><button type="submit">Create user</button></form></div>{adminError && <p className="error">{adminError}</p>}<div className="admin-list"><h3>Organization users</h3>{adminUsers.map((member) => <div className="admin-user" key={member.id}><div><strong>{member.name}</strong><span>{member.email}</span></div><select value={member.role} disabled={member.id === user.id} onChange={(e) => handleRoleChange(member.id, e.target.value)}><option value="employee">Employee</option><option value="manager">Manager</option><option value="admin">Admin</option></select><select value={member.team_id || ""} onChange={(e) => handleTeamChange(member.id, e.target.value)}><option value="">No team</option>{adminTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div>)}</div></section>)}<section className="expense-form-section"><h2>Add expense</h2><form className="expense-form" onSubmit={handleSubmit}><label>Amount<input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label><label>Category<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required><option value="">Select category</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label><label>Vendor<input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} maxLength={200} /></label><label>Description<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} /></label><label>Date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label><label>Attachment<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setPendingAttachment(e.target.files?.[0] || null)} /></label><button type="submit" disabled={uploading}>{uploading ? "Saving..." : "Save expense"}</button></form></section>{error && <p className="error">{error}</p>}<section className="expenses-section"><div className="section-heading"><h2>Expenses</h2><label>Filter by category<select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label></div><p className="section-note">Showing {expenses.length} of {expensesTotal} expenses</p>{expenses.length === 0 ? <p className="empty-state">No expenses yet.</p> : <div className="expense-list">{expenses.map((expense) => <article className="expense-card" key={expense.id}><div><h3>{expense.category} — ₦{Number(expense.amount).toLocaleString()}</h3><p>{expense.vendor || "No vendor"} · {expense.date}</p><p>{expense.description}</p><span className={`status ${expense.status}`}>{expense.status}</span></div><div className="expense-actions">{expense.attachment_name && <button type="button" onClick={() => handleViewAttachment(expense.id)}>View attachment</button>}{expense.status === "draft" && expense.user_id === user.id && <><button type="button" onClick={() => handleSubmitForApproval(expense.id)}>Submit</button><button type="button" onClick={() => handleDelete(expense.id)}>Delete</button></>}</div></article>)}</div>}{hasMoreExpenses && <button type="button" className="load-more" disabled={isLoadingMore} onClick={loadMoreExpenses}>{isLoadingMore ? "Loading..." : "Load more"}</button>}</section>{["manager", "admin"].includes(user.role) && (<section className="approval-section"><h2>Pending approvals</h2>{pendingApprovals.length === 0 ? <p className="empty-state">No expenses awaiting approval.</p> : pendingApprovals.map((expense) => <article className="approval-card" key={expense.id}><div><strong>{expense.category} — ₦{Number(expense.amount).toLocaleString()}</strong><p>{expense.vendor || "No vendor"} · {expense.date}</p><p>{expense.description}</p></div><div className="approval-actions"><button type="button" onClick={() => handleApproval(expense.id, "approve")}>Approve</button><button type="button" onClick={() => handleApproval(expense.id, "return")}>Return</button><button type="button" onClick={() => handleApproval(expense.id, "reject")}>Reject</button></div></article>)}</section>)}{user.role === "admin" && <section className="budget-section"><h2>Monthly budgets</h2>{categories.map((category) => <div className="budget-row" key={category}><span>{category}</span><span>Spent this month: ₦{Number(summary.monthSpentByCategory?.[category] || 0).toLocaleString()}</span><input type="number" min="0" value={budgetDrafts[category] ?? summary.budgets?.[category] ?? ""} onChange={(e) => setBudgetDrafts({ ...budgetDrafts, [category]: e.target.value })} placeholder="Monthly limit" /><button type="button" onClick={() => handleSetBudget(category)}>Save</button>{summary.budgets?.[category] !== undefined && <button type="button" onClick={() => handleClearBudget(category)}>Clear</button>}</div>)}</section>}</div>);
}
