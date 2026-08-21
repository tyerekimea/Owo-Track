const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeCursor, encodeCursor, normalizeLimit, pageResponse } = require("./expense-pagination");

test("cursor round trip preserves date and id", () => {
  const cursor = encodeCursor({ date: "2026-08-21", id: "expense-123" });
  assert.deepEqual(decodeCursor(cursor), { date: "2026-08-21", id: "expense-123" });
});

test("invalid cursor returns a client error", () => {
  assert.throws(() => decodeCursor("not-a-valid-cursor"), { message: "Invalid pagination cursor.", statusCode: 400 });
});

test("limit is bounded", () => {
  assert.equal(normalizeLimit(undefined), 50);
  assert.equal(normalizeLimit("0"), 1);
  assert.equal(normalizeLimit("999"), 200);
  assert.equal(normalizeLimit("12.9"), 12);
});

test("page response returns a next cursor only when more records exist", () => {
  const result = pageResponse([
    { id: "a", date: "2026-08-21" },
    { id: "b", date: "2026-08-20" },
    { id: "c", date: "2026-08-19" },
  ], 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.hasMore, true);
  assert.deepEqual(decodeCursor(result.nextCursor), { id: "b", date: "2026-08-20" });
});
