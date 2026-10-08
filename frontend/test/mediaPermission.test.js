import test from "node:test";
import assert from "node:assert";

import { classifyMediaError, watchPermissions } from "../src/services/mediaPermission.js";

const err = (name, message = "") => Object.assign(new Error(message), { name });

test("a refusal names the thing to click, not just the fault", () => {
  // "Permission denied" tells somebody nothing they can act on. The padlock is
  // the only way back once a browser has been told Block, and it will never
  // prompt again however many times we ask.
  const out = classifyMediaError(err("NotAllowedError"), { wantCamera: true });
  assert.strictEqual(out.kind, "denied");
  assert.ok(out.canRetry);
  assert.ok(/address bar/i.test(out.message), out.message);
  assert.ok(/camera and microphone/.test(out.title), out.title);
});

test("a student is not told to fix a camera they were never asked for", () => {
  const out = classifyMediaError(err("NotAllowedError"), { wantCamera: false });
  assert.ok(!/camera/.test(out.title), out.title);
  assert.ok(/microphone/.test(out.title), out.title);
});

test("a device held by another app is its own answer", () => {
  // The commonest failure after a refusal, and the least obvious: another tab
  // or another meeting still owns the microphone.
  const out = classifyMediaError(err("NotReadableError"));
  assert.strictEqual(out.kind, "busy");
  assert.ok(/other tab|app/i.test(out.message), out.message);
});

test("no device at all is not a permission problem", () => {
  assert.strictEqual(classifyMediaError(err("NotFoundError")).kind, "missing");
});

test("an insecure page offers no button, because none would help", () => {
  // https is not something the person can switch on from here, and a Try again
  // that cannot work is worse than no button.
  const out = classifyMediaError(err("SecurityError"));
  assert.strictEqual(out.canRetry, false);
  assert.ok(/https/.test(out.message), out.message);
});

test("an unknown failure still carries what the browser said", () => {
  const out = classifyMediaError(err("WeirdError", "the gremlins again"));
  assert.strictEqual(out.kind, "unknown");
  assert.ok(out.message.includes("the gremlins again"), out.message);
  assert.ok(out.canRetry);
});

test("no error is no banner", () => {
  assert.strictEqual(classifyMediaError(null), null);
  assert.strictEqual(classifyMediaError(undefined), null);
});

test("watching permissions is survivable where the API does not exist", () => {
  // Firefox rejects a query for "camera"; older browsers have no Permissions
  // API at all. Neither is worth an exception -- it only means no automatic
  // recovery, and the button still works.
  for (const nav of [{}, null, undefined, { permissions: {} }]) {
    const stop = watchPermissions(["microphone"], () => {}, nav);
    assert.strictEqual(typeof stop, "function");
    assert.doesNotThrow(stop);
  }
});

test("a permission turning granted starts the class without a reload", async () => {
  // The half nobody has to press: somebody allows the microphone in site
  // settings and the lesson begins, rather than waiting for them to think of
  // reloading.
  let fire;
  const status = {
    state: "prompt",
    addEventListener: (_e, h) => {
      fire = h;
    },
    removeEventListener: () => {},
  };
  const nav = { permissions: { query: async () => status } };

  let started = 0;
  const stop = watchPermissions(["microphone"], () => {
    started += 1;
  }, nav);
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(typeof fire, "function", "a change handler was registered");

  // Still only "prompt": nothing should happen yet.
  fire();
  assert.strictEqual(started, 0);

  status.state = "granted";
  fire();
  assert.strictEqual(started, 1, "granted starts the class");
  stop();
});
