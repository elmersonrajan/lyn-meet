import test from "node:test";
import assert from "node:assert";

import { mayReload, markReloaded, REJOIN_COOLDOWN_MS } from "../src/services/rejoinGuard.js";

/** sessionStorage, near enough for the two calls this uses. */
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

test("the first drop of a page's life reloads straight away", () => {
  assert.strictEqual(mayReload(fakeStore(), 1000), true);
});

test("a second drop inside the cooldown does not reload", () => {
  // This is the flapping line: connect, drop, reload, connect, drop. Without
  // the cooldown the teacher never gets a word out.
  const store = fakeStore();
  markReloaded(store, 1000);
  assert.strictEqual(mayReload(store, 1000 + REJOIN_COOLDOWN_MS - 1), false);
});

test("once the cooldown is up it reloads again", () => {
  const store = fakeStore();
  markReloaded(store, 1000);
  assert.strictEqual(mayReload(store, 1000 + REJOIN_COOLDOWN_MS), true);
});

test("no storage is not a reason to sit frozen", () => {
  // Private browsing, or storage switched off. One reload beats none, and with
  // nothing remembered there is nothing to loop on either.
  assert.strictEqual(mayReload(null, 1000), true);
});

test("a storage that throws is treated as no storage", () => {
  const hostile = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.strictEqual(mayReload(hostile, 1000), true);
  assert.doesNotThrow(() => markReloaded(hostile, 1000));
});

test("a clock that jumped backwards does not block reloads for ever", () => {
  const store = fakeStore();
  markReloaded(store, 10_000_000);
  assert.strictEqual(mayReload(store, 1000), true);
});

test("junk left in storage is ignored rather than believed", () => {
  assert.strictEqual(mayReload(fakeStore({ "lynmeet.lastRejoinAt": "nonsense" }), 1000), true);
});
