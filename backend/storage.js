const fs = require("node:fs");
const path = require("node:path");

const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function sanitizeFilename(name) {
  const normalized = String(name || "invoice")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("_")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .trim();

  return normalized || "invoice";
}

function buildAttachmentName(originalName, userId) {
  const safeName = sanitizeFilename(originalName || "receipt");
  const ext = path.extname(safeName) || ".png";
  const base = path.basename(safeName, ext).slice(0, 80) || "receipt";
  const uniqueToken = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  return `${userId}-${uniqueToken}-${base}${ext}`;
}

module.exports = {
  UPLOAD_DIR,
  sanitizeFilename,
  buildAttachmentName,
};
