import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function App() {
  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState({ totalsByCategory: {}, grandTotal: 0, count: 0 });
  const [form, setForm] = useState({
    amount: "",
    category: "",
    description: "",
    vendor: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const [error, setError] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  async function loadAll() {
    const [catsRes, expRes, sumRes] = await Promise.all([
      fetch(`${API_URL}/api/categories`),
      fetch(`${API_URL}/api/expenses${filterCategory ? `?category=${filterCategory}` : ""}`),
      fetch(`${API_URL}/api/summary`),
    ]);
    setCategories(await catsRes.json());
    setExpenses(await expRes.json());
    setSummary(await sumRes.json());
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const res = await fetch(`${API_URL}/api/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to add expense.");
      return;
    }
    setForm({
      amount: "",
      category: "",
      description: "",
      vendor: "",
      date: new Date().toISOString().slice(0, 10),
    });
    loadAll();
  }

  async function handleDelete(id) {
    await fetch(`${API_URL}/api/expenses/${id}`, { method: "DELETE" });
    loadAll();
  }

  return (
    <div className="page">
      <header>
        <h1>Owo Track</h1>
        <p className="subtitle">Expense tracking for small &amp; medium scale enterprises</p>
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
          {error && <p className="error">{error}</p>}
          <button type="submit">Add Expense</button>
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
                <td>₦{e.amount.toLocaleString()}</td>
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
