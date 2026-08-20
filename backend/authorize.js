// Role-based authorization middleware
const roleHierarchy = { employee: 0, manager: 1, admin: 2 };

export const authorize = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userRole = req.user.role || 'employee';
    if (roleHierarchy[userRole] < roleHierarchy[requiredRole]) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

export const canAccessExpense = (req, expense) => {
  return req.user.role !== 'employee' || expense.user_id === req.userId;
};
