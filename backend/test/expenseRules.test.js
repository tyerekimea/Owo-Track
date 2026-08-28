import test from "node:test";
import assert from "node:assert/strict";

import { isBudgetCountable } from "../expenseRules.js";

test("rejected expenses are excluded from budget tracking", () => {
  assert.equal(isBudgetCountable({ status: "rejected" }), false);
});

test("draft, submitted, and approved expenses still count toward budget tracking", () => {
  assert.equal(isBudgetCountable({ status: "draft" }), true);
  assert.equal(isBudgetCountable({ status: "submitted" }), true);
  assert.equal(isBudgetCountable({ status: "approved" }), true);
});

test("filtering a mixed list of expenses drops only the rejected ones", () => {
  const expenses = [
    { id: "1", status: "draft", amount: 100 },
    { id: "2", status: "submitted", amount: 200 },
    { id: "3", status: "approved", amount: 300 },
    { id: "4", status: "rejected", amount: 400 },
  ];

  const countable = expenses.filter(isBudgetCountable);
  const total = countable.reduce((sum, e) => sum + e.amount, 0);

  assert.deepEqual(countable.map((e) => e.id), ["1", "2", "3"]);
  assert.equal(total, 600);
});
