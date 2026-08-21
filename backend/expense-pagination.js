const { Buffer } = require("node:buffer");

function encodeCursor(expense) {
  if (!expense?.date || !expense?.id) return "";
  return Buffer.from(JSON.stringify({ date: expense.date, id: expense.id }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed?.date) || typeof parsed?.id !== "string" || !parsed.id) throw new Error("Invalid cursor");
    return parsed;
  } catch {
    const error = new Error("Invalid pagination cursor.");
    error.statusCode = 400;
    error.expose = true;
    throw error;
  }
}

function normalizeLimit(value, fallback = 50, maximum = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), maximum);
}

function pageResponse(items, limit) {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page,
    hasMore,
    nextCursor: hasMore ? encodeCursor(page.at(-1)) : "",
    limit,
  };
}

module.exports = { decodeCursor, encodeCursor, normalizeLimit, pageResponse };
