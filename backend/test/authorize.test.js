import test from "node:test";
import assert from "node:assert/strict";

import { userScope, canAccess, canApprove, scopeUsers, requireRole } from "../authorize.js";

const admin = { id: "admin-1", role: "admin", organization_id: "org-1", team_id: "team-a" };
const manager = { id: "mgr-1", role: "manager", organization_id: "org-1", team_id: "team-a" };
const otherTeamManager = { id: "mgr-2", role: "manager", organization_id: "org-1", team_id: "team-b" };
const employee = { id: "emp-1", role: "employee", organization_id: "org-1", team_id: "team-a" };

const ownExpense = { user_id: "emp-1", organization_id: "org-1", team_id: "team-a" };
const teammateExpense = { user_id: "emp-2", organization_id: "org-1", team_id: "team-a" };
const otherTeamExpense = { user_id: "emp-3", organization_id: "org-1", team_id: "team-b" };
const otherOrgExpense = { user_id: "emp-4", organization_id: "org-2", team_id: "team-a" };

test("admin can access any expense in their organization, not other orgs", () => {
  assert.equal(canAccess(admin, ownExpense), true);
  assert.equal(canAccess(admin, otherTeamExpense), true);
  assert.equal(canAccess(admin, otherOrgExpense), false);
});

test("manager can access expenses on their own team, not other teams", () => {
  assert.equal(canAccess(manager, teammateExpense), true);
  assert.equal(canAccess(manager, otherTeamExpense), false);
  assert.equal(canAccess(otherTeamManager, teammateExpense), false);
});

test("employee can access only their own expense", () => {
  assert.equal(canAccess(employee, ownExpense), true);
  assert.equal(canAccess(employee, teammateExpense), false);
});

test("userScope filter matches canAccess for the same user/expense pairs", () => {
  const expenses = [ownExpense, teammateExpense, otherTeamExpense, otherOrgExpense];
  for (const user of [admin, manager, employee]) {
    const filtered = expenses.filter(userScope(user));
    const expected = expenses.filter((e) => canAccess(user, e));
    assert.deepEqual(filtered, expected);
  }
});

test("manager or admin can approve an accessible expense that isn't their own", () => {
  assert.equal(canApprove(manager, teammateExpense), true);
  assert.equal(canApprove(admin, teammateExpense), true);
});

test("nobody can approve their own expense, regardless of role", () => {
  const ownAsManager = { ...ownExpense, user_id: manager.id };
  const ownAsAdmin = { ...ownExpense, user_id: admin.id };
  assert.equal(canApprove(manager, ownAsManager), false);
  assert.equal(canApprove(admin, ownAsAdmin), false);
});

test("employees can never approve, even an accessible expense", () => {
  assert.equal(canApprove(employee, ownExpense), false);
});

test("manager cannot approve an expense outside their team", () => {
  assert.equal(canApprove(manager, otherTeamExpense), false);
});

test("scopeUsers gives an admin the entire organization's users", () => {
  const orgUsers = [
    { id: "emp-1", team_id: "team-a" },
    { id: "emp-2", team_id: "team-b" },
    { id: "mgr-1", team_id: "team-a" },
  ];
  assert.deepEqual(scopeUsers(admin, orgUsers), orgUsers);
});

test("scopeUsers restricts a manager to only their own team", () => {
  const teammate = { id: "emp-1", team_id: "team-a" };
  const otherTeamPerson = { id: "emp-2", team_id: "team-b" };
  const orgUsers = [teammate, otherTeamPerson];

  assert.deepEqual(scopeUsers(manager, orgUsers), [teammate]);
});

function mockReqRes(role) {
  const req = { user: role ? { role } : null };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

test("requireRole allows a role at or above the required rank", () => {
  const middleware = requireRole("manager");
  const { req, res } = mockReqRes("admin");
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("requireRole blocks a role below the required rank", () => {
  const middleware = requireRole("manager");
  const { req, res } = mockReqRes("employee");
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("requireRole fails closed when req.user or its role is missing", () => {
  const middleware = requireRole("employee");
  for (const role of [undefined, null, "not-a-real-role"]) {
    const { req, res } = mockReqRes(role);
    let called = false;
    middleware(req, res, () => { called = true; });
    assert.equal(called, false, `expected role "${role}" to be denied`);
    assert.equal(res.statusCode, 403);
  }
});
