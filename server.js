const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

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

app.use(cors());
app.use(express.json());

// Get category list
app.get("/api/categories", (req, res) => {
  res.json(CATEGORIES);
});

// Get all expenses (optional ?category= filter), newest first
app.get("/api/expenses", (req, res) => {
  const { category } = req.query;

  let rows;
  if (category) {
    rows = db
      .prepare("SELECT * FROM expenses WHERE category = ? ORDER BY date DESC")
      .all(category);
  } else {
    rows = db.prepare("SELECT * FROM expenses ORDER BY date DESC").all();
  }
  res.json(rows);
});

// Add an expense
app.post("/api/expenses", (req, res) => {
  const { amount, category, description, vendor, date } = req.body;

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: "A valid positive amount is required." });
  }
  if (!category || !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "A valid category is required." });
  }

  const expense = {
    id: uuidv4(),
    amount: Number(amount),
    category,
    description: description || "",
    vendor: vendor || "",
    date: date || new Date().toISOString().slice(0, 10),
  };

  db.prepare(
    `INSERT INTO expenses (id, amount, category, description, vendor, date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(expense.id, expense.amount, expense.category, expense.description, expense.vendor, expense.date);

  res.status(201).json(expense);
});

// Delete an expense
app.delete("/api/expenses/:id", (req, res) => {
  const result = db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "Expense not found." });
  }
  res.status(204).send();
});

// Summary: totals by category + grand total
app.get("/api/summary", (req, res) => {
  const totalsByCategory = {};
  for (const cat of CATEGORIES) totalsByCategory[cat] = 0;

  const rows = db
    .prepare("SELECT category, SUM(amount) as total FROM expenses GROUP BY category")
    .all();
  for (const row of rows) {
    totalsByCategory[row.category] = row.total;
  }

  const { total: grandTotal, count } = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses")
    .get();

  res.json({ totalsByCategory, grandTotal, count });
});

app.listen(PORT, () => {
  console.log(`Owo Track API running on http://localhost:${PORT}`);
});
