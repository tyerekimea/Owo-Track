const test = require('node:test');
const assert = require('node:assert/strict');

const { canAccessExpense, canApproveExpense } = require('../authorize');
const { authorize } = require('../authorize');

function request(user) {
  return { user, userId: user.id };
}

const organizationId = 'org-1';
const teamA = 'team-a';
const teamB = 'team-b';

function expense(overrides = {}) {
  return {
    id: 'expense-1',
    user_id: 'employee-1',
    organization_id: organizationId,
    team_id: teamA,
    status: 'submitted',
    ...overrides,
  };
}

test('employees can access only their own expenses', () => {
  const employee = { id: 'employee-1', role: 'employee', organization_id: organizationId, team_id: teamA };

  assert.equal(canAccessExpense(request(employee), expense()), true);
  assert.equal(canAccessExpense(request(employee), expense({ user_id: 'employee-2' })), false);
  assert.equal(canApproveExpense(request(employee), expense()), false);
});

test('managers can access and approve expenses from their assigned team only', () => {
  const manager = { id: 'manager-1', role: 'manager', organization_id: organizationId, team_id: teamA };

  assert.equal(canAccessExpense(request(manager), expense()), true);
  assert.equal(canApproveExpense(request(manager), expense()), true);
  assert.equal(canAccessExpense(request(manager), expense({ team_id: teamB })), false);
  assert.equal(canApproveExpense(request(manager), expense({ team_id: teamB })), false);
  assert.equal(canApproveExpense(request(manager), expense({ user_id: manager.id })), false);
});

test('admins can access organization expenses but not another organization', () => {
  const admin = { id: 'admin-1', role: 'admin', organization_id: organizationId, team_id: teamA };

  assert.equal(canAccessExpense(request(admin), expense({ team_id: teamB })), true);
  assert.equal(canApproveExpense(request(admin), expense({ team_id: teamB })), true);
  assert.equal(canAccessExpense(request(admin), expense({ organization_id: 'org-2' })), false);
});

test('authorization rejects unknown roles instead of failing open', () => {
  const middleware = authorize('manager');
  const req = { user: { role: 'unexpected' } };
  let nextCalled = false;
  const res = {
    status(code) {
      assert.equal(code, 403);
      return this;
    },
    json(body) {
      assert.deepEqual(body, { error: 'Insufficient permissions' });
    },
  };

  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
});
