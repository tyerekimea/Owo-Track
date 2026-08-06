const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAttachmentName, sanitizeFilename } = require('../storage');

test('buildAttachmentName keeps a user-safe original name and adds a unique suffix', () => {
  const name = buildAttachmentName('receipt.png', 'user-123');

  assert.match(name, /^user-123-/);
  assert.match(name, /receipt\.png$/);
  assert.ok(name.length > 'receipt.png'.length);
});

test('sanitizeFilename strips unsafe characters and directory paths', () => {
  const name = sanitizeFilename('../../evil/receipt (final).png');

  assert.equal(name, 'evil_receipt_final_.png');
});
