// Role-based access control for expenses. Pulled out of firebase-server.js
// so this logic — who can see, submit, or approve which expenses — can be
// unit tested directly, without needing a live Firestore connection.

const ROLE_RANK = { employee: 0, manager: 1, admin: 2 };

/**
 * Returns a predicate that decides whether a given expense is visible to
 * this user: admins see their whole organization, managers see their team,
 * employees see only their own expenses.
 */
function userScope(user) {
  if (user.role === "admin") {
    return (expense) => expense.organization_id === user.organization_id;
  }
  if (user.role === "manager") {
    return (expense) => expense.organization_id === user.organization_id && expense.team_id === user.team_id;
  }
  return (expense) => expense.user_id === user.id;
}

function canAccess(user, expense) {
  return userScope(user)(expense);
}

/** Managers/admins can approve expenses in their scope — but never their own. */
function canApprove(user, expense) {
  return canAccess(user, expense) && expense.user_id !== user.id && ["manager", "admin"].includes(user.role);
}

/**
 * Filters an organization's user list down to what the requester should see:
 * admins see everyone in the org, managers see only their own team.
 */
function scopeUsers(requester, orgUsers) {
  if (requester.role === "manager") {
    return orgUsers.filter((u) => u.team_id === requester.team_id);
  }
  return orgUsers;
}

/** Express middleware: rejects unless req.user's role meets the given minimum. */
function requireRole(role) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role];
    if (rank === undefined || rank < ROLE_RANK[role]) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

export { ROLE_RANK, userScope, canAccess, canApprove, scopeUsers, requireRole };
