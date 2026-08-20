const roleHierarchy = { employee: 0, manager: 1, admin: 2 };

function authorize(requiredRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userRole = req.user.role || "employee";
    if (!(userRole in roleHierarchy) || !(requiredRole in roleHierarchy)
      || roleHierarchy[userRole] < roleHierarchy[requiredRole]) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

function canAccessExpense(req, expense) {
  if (!req.user || !expense || req.user.organization_id !== expense.organization_id) return false;
  if (req.user.role === "admin") return true;
  if (req.user.role === "manager") return req.user.team_id === expense.team_id;
  return expense.user_id === req.userId;
}

function canApproveExpense(req, expense) {
  if (!canAccessExpense(req, expense) || expense.user_id === req.userId) return false;
  return req.user.role === "admin" || (
    req.user.role === "manager" && req.user.team_id === expense.team_id
  );
}

module.exports = { roleHierarchy, authorize, canAccessExpense, canApproveExpense };
