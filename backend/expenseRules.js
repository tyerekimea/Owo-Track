// Business rules about which expenses count toward things, independent of
// who's allowed to see them (that's authorize.js's job).

/**
 * Whether an expense should count toward monthly budget tracking. Rejected
 * expenses never happened as far as the business is concerned — they
 * shouldn't eat into a category's monthly budget.
 */
function isBudgetCountable(expense) {
  return expense.status !== "rejected";
}

export { isBudgetCountable };
