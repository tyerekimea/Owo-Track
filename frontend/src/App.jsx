import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include", // send/receive the httpOnly session cookie
    headers: {
      "Content-Type": "application/json",
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
    // Checks whether a valid session cookie already exists (e.g. a
    // returning visitor). A 401 here is the normal, expected outcome for
    // a logged-out visitor — not an error — so this deliberately calls
    // fetch directly rather than apiFetch, whose 401 handler is meant for
    // *already-logged-in* calls and would otherwise reload the page in a
    // loop while checking.
    fetch(`${API_URL}/api/auth/me`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setUser(data?.user || null))
      .catch(() => setUser(null))
      .finally(() => setIsLoadingUser(false));
  }, []);

  async function loadAll() {
    if (!user) return;

    const [catsRes, expRes, sumRes] = await Promise.all([
      apiFetch("/api/categories"),
      apiFetch(`/api/expenses${filterCategory ? `?category=${filterCategory}` : ""}`),
      apiFetch("/api/summary"),
    ]);

    setCategories(catsRes || []);
    setExpenses(expRes || []);
    setSummary(sumRes || {
      totalsByCategory: {},
      grandTotal: 0,
      count: 0,
      month: "",
      monthSpentByCategory: {},
      budgets: {},
    });
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
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = authMode === "login"
        ? { email: authForm.email, password: authForm.password }
        : { name: authForm.name, email: authForm.email, password: authForm.password };

      const data = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        credentials: "include", // receive the httpOnly session cookie the server sets
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json.error || "Authentication failed.");
        }
        return json;
      });

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
    } catch (error) {
      // Ignore logout errors and still clear the local session.
    } finally {
      setUser(null);
      setCategories([]);
      setExpenses([]);
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

  async function handleViewAttachment(expenseId) {
    try {
      const response = await fetch(`${API_URL}/api/expenses/${expenseId}/attachment/file`, {
        credentials: "include",
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

      <section className="budgets-section">
        <h2>Monthly Budgets {summary.month && <span className="month-label">({summary.month})</span>}</h2>
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
                  {hasLimit && (
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
                ) : (
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

      <section className="list-section">
        <div className="list-header">
          <h2>Expenses ({expenses.length})</h2>
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">No expenses recorded yet.</td>
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
                <td>
                  <button className="delete" onClick={() => handleDelete(e.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
