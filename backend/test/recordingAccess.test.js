const test = require("node:test");
const assert = require("node:assert");

const { tokenFrom } = require("../src/auth/recordingAccess");

test("the platform's spelling is accepted, and the obvious one too", () => {
  // The platform writes "TockenID". Nobody reading a URL would guess that, so
  // the correct spelling has to work as well.
  assert.strictEqual(tokenFrom({ query: { TockenID: "abc" } }), "abc");
  assert.strictEqual(tokenFrom({ query: { TokenID: "abc" } }), "abc");
  assert.strictEqual(tokenFrom({ query: { tockenid: "abc" } }), "abc");
});

test("no token is not an error, it is simply no token", () => {
  assert.strictEqual(tokenFrom({ query: {} }), null);
  assert.strictEqual(tokenFrom({}), null);
  assert.strictEqual(tokenFrom({ query: { other: "x" } }), null);
});
