const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, "data.json");

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

function readData() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Get category list
app.get("/api/categories", (req, res) => {
  res.json(CATEGORIES);
});

// Get all expenses (optional ?category= filter)
app.get("/api/expenses", (req, res) => {
  const { category } = req.query;
  const data = readData();
  let expenses = data.expenses;
  if (category) {
    expenses = expenses.filter((e) => e.category === category);
  }
  expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(expenses);
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

  const data = readData();
  const expense = {
    id: uuidv4(),
    amount: Number(amount),
    category,
    description: description || "",
    vendor: vendor || "",
    date: date || new Date().toISOString().slice(0, 10),
  };
  data.expenses.push(expense);
  writeData(data);
  res.status(201).json(expense);
});

// Delete an expense
app.delete("/api/expenses/:id", (req, res) => {
  const data = readData();
  const exists = data.expenses.some((e) => e.id === req.params.id);
  if (!exists) return res.status(404).json({ error: "Expense not found." });

  data.expenses = data.expenses.filter((e) => e.id !== req.params.id);
  writeData(data);
  res.status(204).send();
});

// Summary: totals by category + grand total
app.get("/api/summary", (req, res) => {
  const data = readData();
  const totalsByCategory = {};
  let grandTotal = 0;

  for (const cat of CATEGORIES) totalsByCategory[cat] = 0;

  for (const e of data.expenses) {
    totalsByCategory[e.category] = (totalsByCategory[e.category] || 0) + e.amount;
    grandTotal += e.amount;
  }

  res.json({ totalsByCategory, grandTotal, count: data.expenses.length });
});

app.listen(PORT, () => {
  console.log(`Expense tracker API running on http://localhost:${PORT}`);
});
