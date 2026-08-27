import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "./firebase";

const configuredApiUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";
// API paths below already include /api. Strip it from the configured base so
// both a same-origin Vercel value (/api) and a separate backend URL work.
const API_URL = configuredApiUrl.replace(/\/$/, "").replace(/\/api$/, "");

async function apiFetch(path, options = {}) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : "";
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    window.location.reload();
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Request failed.");
  }

  if (response.status === 204) {
    return null;
  }

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
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminTeams, setAdminTeams] = useState([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "employee", team_id: "" });
  const [adminError, setAdminError] = useState("");
  const EXPENSES_PAGE_SIZE = 50;
  const [summary, setSummary] = useState({
    totalsByCategory: {},
    grandTotal: 0,
    count: 0,
    month: "",
    monthSpentByCategory: {},
    budgets: {},
  });
  const [form, setForm] = useState({
    amount: "",
    category: "",
    description: "",
    vendor: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const [error, setError] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [budgetDrafts, setBudgetDrafts] = useState({});
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setIsLoadingUser(false);
        return;
      }
      try {
        const data = await apiFetch("/api/auth/me");
        setUser(data?.user || null);
      } catch {
        setUser(null);
      } finally {
        setIsLoadingUser(false);
      }
    });
    return unsubscribe;
  }, []);

  async function loadAll() {
    if (!user) return;

    const requests = [
      apiFetch("/api/categories"),
      apiFetch(
        `/api/expenses?limit=${EXPENSES_PAGE_SIZE}${filterCategory ? `&category=${filterCategory}` : ""}`
      ),
      apiFetch("/api/summary"),
    ];
    if (user.role === "manager" || user.role === "admin") {
      requests.push(apiFetch("/api/expenses/pending-approval"));
      requests.push(apiFetch("/api/users"));
    }
    if (user.role === "admin") {
      requests.push(apiFetch("/api/teams"));
    }
    const [catsRes, expRes, sumRes, pendingRes, usersRes, teamsRes] = await Promise.all(requests);

    setCategories(catsRes || []);
    setExpenses(expRes?.items || []);
    setExpensesTotal(expRes?.total || 0);
    setPendingApprovals(pendingRes || []);
    setAdminUsers(usersRes || []);
    setAdminTeams(teamsRes || []);
    setSummary(sumRes || {
      totalsByCategory: {},
      grandTotal: 0,
      count: 0,
      month: "",
      monthSpentByCategory: {},
      budgets: {},
    });
  }

  async function loadMoreExpenses() {
    setIsLoadingMore(true);
    try {
      const res = await apiFetch(
        `/api/expenses?limit=${EXPENSES_PAGE_SIZE}&offset=${expenses.length}${
          filterCategory ? `&category=${filterCategory}` : ""
        }`
      );
      setExpenses((prev) => [...prev, ...(res?.items || [])]);
      setExpensesTotal(res?.total ?? expensesTotal);
    } finally {
      setIsLoadingMore(false);
    }
  }

  useEffect(() => {
    if (user) {
      loadAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filterCategory]);

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");

    try {
      const payload = authMode === "login"
        ? { email: authForm.email, password: authForm.password }
        : { name: authForm.name, email: authForm.email, password: authForm.password };

      if (authMode === "login") {
        await signInWithEmailAndPassword(auth, payload.email, payload.password);
      } else {
        const response = await fetch(`${API_URL}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Registration failed.");
        await signInWithEmailAndPassword(auth, payload.email, payload.password);
      }
      const data = await apiFetch("/api/auth/me");
      setUser(data.user);
      setAuthForm({ name: "", email: "", password: "" });
    } catch (error) {
      setAuthError(error.message || "Authentication failed.");
    }
  }

  async function handleLogout() {
    if (!user) return;

    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout errors and still clear the local session.
    } finally {
      await signOut(auth);
      setUser(null);
      setCategories([]);
      setExpenses([]);
      setPendingApprovals([]);
      setAdminUsers([]);
      setAdminTeams([]);
      setSummary({
        totalsByCategory: {},
        grandTotal: 0,
        count: 0,
        month: "",
        monthSpentByCategory: {},
        budgets: {},
      });
      setFilterCategory("");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      const createdExpense = await apiFetch("/api/expenses", {
        method: "POST",
        body: JSON.stringify(form),
      });

      if (pendingAttachment && createdExpense?.id) {
        const formData = new FormData();
        formData.append("file", pendingAttachment);

        setUploading(true);
        const uploadResponse = await fetch(`${API_URL}/api/expenses/${createdExpense.id}/attachment`, {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
          body: formData,
        });

        const uploadData = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok) {
          throw new Error(uploadData.error || "Attachment upload failed.");
        }
      }

      setPendingAttachment(null);
      setForm({
        amount: "",
        category: "",
        description: "",
        vendor: "",
        date: new Date().toISOString().slice(0, 10),
      });
      loadAll();
    } catch (loadError) {
      setError(loadError.message || "Failed to add expense.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id) {
    await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
    loadAll();
  }

  async function handleSubmitForApproval(id) {
    try {
      await apiFetch(`/api/expenses/${id}/submit`, { method: "POST" });
      await loadAll();
    } catch (submitError) {
      setError(submitError.message || "Could not submit expense.");
    }
  }

  async function handleApproval(id, action) {
    const body = {};
    if (action === "reject") {
      const reason = window.prompt("Why is this expense being rejected?");
      if (!reason?.trim()) return;
      body.reason = reason.trim();
    } else if (action === "return") {
      body.comment = window.prompt("Optional correction note:")?.trim() || "";
    }

    try {
      await apiFetch(`/api/expenses/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await loadAll();
    } catch (approvalError) {
      setError(approvalError.message || "Could not update approval status.");
    }
  }

  async function handleCreateTeam(e) {
    e.preventDefault();
    setAdminError("");
    try {
      await apiFetch("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: newTeamName }),
      });
      setNewTeamName("");
      await loadAll();
    } catch (createError) {
      setAdminError(createError.message || "Could not create team.");
    }
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    setAdminError("");
    try {
      await apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setNewUser({ name: "", email: "", password: "", role: "employee", team_id: "" });
      await loadAll();
    } catch (createError) {
      setAdminError(createError.message || "Could not create user.");
    }
  }

  async function handleRoleChange(userId, role) {
    setAdminError("");
    try {
      await apiFetch(`/api/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      await loadAll();
    } catch (roleError) {
      setAdminError(roleError.message || "Could not update role.");
    }
  }

  async function handleTeamChange(userId, teamId) {
    setAdminError("");
    try {
      await apiFetch(`/api/users/${userId}/team`, {
        method: "PATCH",
        body: JSON.stringify({ team_id: teamId }),
      });
      await loadAll();
    } catch (teamError) {
      setAdminError(teamError.message || "Could not update team.");
    }
  }

  async function handleViewAttachment(expenseId) {
    try {
      const response = await fetch(`${API_URL}/api/expenses/${expenseId}/attachment/file`, {
        credentials: "include",
        headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
      });
      if (!response.ok) {
        throw new Error("Could not load attachment.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      // Release the blob URL once the browser's had a moment to open it.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (err) {
      setError(err.message || "Could not load attachment.");
    }
  }

  async function handleSetBudget(category) {
    const value = budgetDrafts[category];
    if (value === undefined || value === "") return;

    await apiFetch(`/api/budgets/${encodeURIComponent(category)}`, {
      method: "PUT",
      body: JSON.stringify({ monthly_limit: Number(value) }),
    });

    setBudgetDrafts({ ...budgetDrafts, [category]: "" });
    loadAll();
  }

  async function handleClearBudget(category) {
    await apiFetch(`/api/budgets/${encodeURIComponent(category)}`, { method: "DELETE" });
    loadAll();
  }

  if (!user || isLoadingUser) {
    return (
      <div className="page auth-page">
        <div className="auth-card">
          <h1>Owo Track</h1>
          <p className="subtitle">Track spending with your own account</p>

          <div className="auth-toggle">
            <button
              type="button"
              className={authMode === "login" ? "active" : ""}
              onClick={() => setAuthMode("login")}
            >
              Login
            </button>
            <button
              type="button"
              className={authMode === "register" ? "active" : ""}
              onClick={() => setAuthMode("register")}
            >
              Register
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="auth-form">
            {authMode === "register" && (
              <label>
                Full name
                <input
                  type="text"
                  value={authForm.name}
                  onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })}
                  required
                />
              </label>
            )}

            <label>
              Email
              <input
                type="email"
                value={authForm.email}
                onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={authForm.password}
                onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                required
                minLength={6}
              />
            </label>

            {authError && <p className="error">{authError}</p>}

            <button type="submit">{authMode === "login" ? "Log in" : "Create account"}</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Owo Track</h1>
          <p className="subtitle">Welcome, {user?.name || "there"}</p>
          <p className="role-label">{user?.role || "employee"}</p>
        </div>
        <button className="logout-button" onClick={handleLogout}>Log out</button>
      </header>

      <section className="summary">
        <div className="summary-card total">
          <span className="label">Total Spent</span>
          <span className="value">₦{summary.grandTotal.toLocaleString()}</span>
        </div>
        {Object.entries(summary.totalsByCategory)
          .filter(([, amt]) => amt > 0)
          .map(([cat, amt]) => (
            <div className="summary-card" key={cat}>
              <span className="label">{cat}</span>
              <span className="value">₦{amt.toLocaleString()}</span>
            </div>
          ))}
      </section>

        {user.role === "admin" && (
          <section className="admin-section">
            <div className="admin-heading">
              <div>
                <h2>Admin workspace</h2>
                <p className="section-note">Manage organization access, teams, and approval coverage.</p>
              </div>
              <span className="admin-organization">{user.organization_id ? "Organization owner" : "Admin"}</span>
            </div>

            <div className="admin-metrics">
              <div><strong>{adminUsers.length}</strong><span>Users</span></div>
              <div><strong>{adminTeams.length}</strong><span>Teams</span></div>
              <div><strong>{pendingApprovals.length}</strong><span>Pending approvals</span></div>
              <div><strong>{summary.count}</strong><span>Visible expenses</span></div>
            </div>

            <div className="admin-grid">
              <form className="admin-card" onSubmit={handleCreateTeam}>
                <h3>Create team</h3>
                <label>
                  Team name
                  <input
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    maxLength={100}
                    required
                    placeholder="e.g. Operations"
                  />
                </label>
                <button type="submit">Add team</button>
              </form>

              <form className="admin-card" onSubmit={handleCreateUser}>
                <h3>Create organization user</h3>
                <div className="admin-form-row">
                  <label>
                    Name
                    <input
                      value={newUser.name}
                      onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                      required
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      value={newUser.email}
                      onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                      required
                    />
                  </label>
                </div>
                <div className="admin-form-row">
                  <label>
                    Temporary password
                    <input
                      type="password"
                      minLength={6}
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                      required
                    />
                  </label>
                  <label>
                    Role
                    <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                      <option value="employee">Employee</option>
                      <option value="manager">Manager</option>
                    </select>
                  </label>
                </div>
                <label>
                  Team
                  <select
                    value={newUser.team_id}
                    onChange={(e) => setNewUser({ ...newUser, team_id: e.target.value })}
                    required
                  >
                    <option value="">Select team...</option>
                    {adminTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                  </select>
                </label>
                <button type="submit" disabled={adminTeams.length === 0}>Create user</button>
              </form>
            </div>

            {adminError && <p className="error">{adminError}</p>}

            <div className="admin-card user-management-card">
              <div className="list-header">
                <h3>Organization users</h3>
                <span className="section-note">Managers approve only expenses from their selected team.</span>
              </div>
              <div className="admin-user-list">
                {adminUsers.map((managedUser) => (
                  <div className="admin-user-row" key={managedUser.id}>
                    <div>
                      <strong>{managedUser.name}</strong>
                      <span>{managedUser.email}</span>
                    </div>
                    <select
                      value={managedUser.role}
                      disabled={managedUser.id === user.id}
                      onChange={(e) => handleRoleChange(managedUser.id, e.target.value)}
                      aria-label={`Role for ${managedUser.name}`}
                    >
                      <option value="employee">Employee</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                    <select
                      value={managedUser.team_id || ""}
                      onChange={(e) => handleTeamChange(managedUser.id, e.target.value)}
                      aria-label={`Team for ${managedUser.name}`}
                    >
                      {adminTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                  </div>
                ))}
                {adminUsers.length === 0 && <p className="empty">No organization users found.</p>}
              </div>
            </div>
          </section>
        )}

      <section className="budgets-section">
        <div className="section-heading-row">
          <h2>Monthly Budgets {summary.month && <span className="month-label">({summary.month})</span>}</h2>
          <span className="section-note">
            {user.role === "admin" ? "Organization limits" : "Read-only organization limits"}
          </span>
        </div>
        <div className="budget-grid">
          {categories.map((cat) => {
            const spent = summary.monthSpentByCategory?.[cat] || 0;
            const limit = summary.budgets?.[cat];
            const hasLimit = limit !== undefined;
            const pct = hasLimit && limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
            const overBudget = hasLimit && spent > limit;

            return (
              <div className="budget-card" key={cat}>
                <div className="budget-card-header">
                  <span>{cat}</span>
                  {hasLimit && user.role === "admin" && (
                    <button className="clear-budget" onClick={() => handleClearBudget(cat)}>
                      clear
                    </button>
                  )}
                </div>

                {hasLimit ? (
                  <>
                    <div className="budget-bar">
                      <div
                        className={`budget-bar-fill ${overBudget ? "over" : ""}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className={`budget-status ${overBudget ? "over" : ""}`}>
                      ₦{spent.toLocaleString()} / ₦{limit.toLocaleString()}
                      {overBudget && " — over budget"}
                    </div>
                  </>
                ) : user.role === "admin" ? (
                  <div className="budget-set">
                    <input
                      type="number"
                      min="0"
                      placeholder="Set limit (₦)"
                      value={budgetDrafts[cat] || ""}
                      onChange={(e) => setBudgetDrafts({ ...budgetDrafts, [cat]: e.target.value })}
                    />
                    <button onClick={() => handleSetBudget(cat)}>Set</button>
                  </div>
                ) : (
                  <div className="budget-unset">No limit configured by your Admin.</div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="form-section">
        <h2>Add Expense</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <label>
              Amount (₦)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                required
              />
            </label>
            <label>
              Category
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                required
              >
                <option value="">Select...</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Vendor
              <input
                type="text"
                placeholder="e.g. PHCN, Jumia"
                value={form.vendor}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              />
            </label>
            <label className="grow">
              Description
              <input
                type="text"
                placeholder="Optional note"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Attachment
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                onChange={(e) => setPendingAttachment(e.target.files?.[0] || null)}
              />
            </label>
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={uploading}>{uploading ? "Uploading..." : "Add Expense"}</button>
        </form>
      </section>

      {(user.role === "manager" || user.role === "admin") && (
        <section className="list-section approval-section">
          <div className="list-header">
            <h2>Pending approvals ({pendingApprovals.length})</h2>
            <span className="approval-scope">
              {user.role === "manager" ? "Assigned team" : "Organization"}
            </span>
          </div>
          {pendingApprovals.length === 0 ? (
            <p className="empty">No expenses are waiting for approval.</p>
          ) : (
            <div className="approval-list">
              {pendingApprovals.map((expense) => (
                <div className="approval-item" key={expense.id}>
                  <div>
                    <strong>{expense.category} — ₦{expense.amount.toLocaleString()}</strong>
                    <span>{expense.vendor || "No vendor"} · {expense.date}</span>
                    {expense.description && <span>{expense.description}</span>}
                  </div>
                  <div className="approval-actions">
                    <button type="button" onClick={() => handleApproval(expense.id, "approve")}>Approve</button>
                    <button type="button" className="return" onClick={() => handleApproval(expense.id, "return")}>Return</button>
                    <button type="button" className="reject" onClick={() => handleApproval(expense.id, "reject")}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {user.role === "manager" && (
        <section className="admin-card user-management-card">
          <div className="list-header">
            <h3>My team ({adminUsers.length})</h3>
            <span className="section-note">Read-only — team membership is managed by an admin.</span>
          </div>
          <div className="admin-user-list">
            {adminUsers.map((teamMember) => (
              <div className="admin-user-row read-only" key={teamMember.id}>
                <div>
                  <strong>{teamMember.name}</strong>
                  <span>{teamMember.email}</span>
                </div>
                <span className="role-badge">{teamMember.role}</span>
              </div>
            ))}
            {adminUsers.length === 0 && <p className="empty">No one else is on your team yet.</p>}
          </div>
        </section>
      )}

      <section className="list-section">
        <div className="list-header">
          <h2>Expenses ({expensesTotal})</h2>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Vendor</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">No expenses recorded yet.</td>
              </tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id}>
                <td>{e.date}</td>
                <td>{e.category}</td>
                <td>{e.vendor}</td>
                <td>{e.description}</td>
                <td>
                  <div className="amount-cell">
                    <span>₦{e.amount.toLocaleString()}</span>
                    {e.attachment_url && (
                      <button
                        type="button"
                        className="view-attachment"
                        onClick={() => handleViewAttachment(e.id)}
                      >
                        View file
                      </button>
                    )}
                  </div>
                </td>
                <td><span className={`status-badge status-${e.status || "draft"}`}>{e.status || "draft"}</span></td>
                <td>
                  {e.status === "draft" && e.user_id === user.id && (
                    <>
                      <button className="submit-expense" onClick={() => handleSubmitForApproval(e.id)}>Submit</button>
                      <button className="delete" onClick={() => handleDelete(e.id)}>✕</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {expenses.length < expensesTotal && (
          <div className="load-more-row">
            <button type="button" className="load-more" onClick={loadMoreExpenses} disabled={isLoadingMore}>
              {isLoadingMore ? "Loading..." : `Load more (${expensesTotal - expenses.length} remaining)`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
