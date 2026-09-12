const test = require("node:test");
const assert = require("node:assert");

const {
  orphans,
  intervalMs,
  DEFAULT_INTERVAL_MS,
  JOIN_GRACE_MS,
} = require("../src/socket/orphanReaper");

const T = 1_000_000;

function peer(id, extra = {}) {
  return {
    id,
    name: id,
    role: "student",
    socketId: `sock-${id}`,
    disconnected: false,
    joinedAt: T - 10 * 60000,
    ...extra,
  };
}

function rooms(list) {
  return new Map([["10242", { id: "10242", peers: new Map(list.map((p) => [p.id, p])) }]]);
}

/** Sockets named here are the only ones that still exist. */
const alive = (...ids) => (socketId) => ids.includes(socketId);

test("a peer whose socket is gone is an orphan", () => {
  // The case seen on UAT: socketAlive false, still sitting in the room, and
  // no code path left that would ever remove them.
  const found = orphans(rooms([peer("joshua")]), alive(), { now: T });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].peer.id, "joshua");
});

test("a peer with a live socket is left alone", () => {
  const found = orphans(rooms([peer("teacher")]), alive("sock-teacher"), { now: T });
  assert.deepStrictEqual(found, []);
});

test("a teacher inside the reconnect window is not an orphan", () => {
  // They have no socket on purpose -- the room, the board and any running
  // recording are being held open for them, and their own timer ends it.
  const t = peer("t", { role: "teacher", disconnected: true });
  assert.deepStrictEqual(orphans(rooms([t]), alive(), { now: T }), []);
});

test("a teacher who is simply gone IS an orphan", () => {
  // disconnected false means nobody is holding a window open for them, so the
  // grace period is not what is keeping them here -- nothing is.
  const t = peer("t", { role: "teacher", disconnected: false });
  assert.strictEqual(orphans(rooms([t]), alive(), { now: T }).length, 1);
});

test("somebody who just joined is left alone", () => {
  // Never reap through a handshake. The socket exists before the peer does, so
  // this should not be load-bearing -- but the cost of being wrong here is
  // throwing a real person out of a class.
  const fresh = peer("new", { joinedAt: T - 1000 });
  assert.deepStrictEqual(orphans(rooms([fresh]), alive(), { now: T }), []);

  const older = peer("new", { joinedAt: T - JOIN_GRACE_MS });
  assert.strictEqual(orphans(rooms([older]), alive(), { now: T }).length, 1);
});

test("a peer with no socket id at all is an orphan", () => {
  assert.strictEqual(orphans(rooms([peer("x", { socketId: null })]), alive(), { now: T }).length, 1);
});

test("only the dead ones are picked out of a busy room", () => {
  const all = rooms([
    peer("a"),
    peer("b"),
    peer("c"),
  ]);
  const found = orphans(all, alive("sock-b"), { now: T });
  assert.deepStrictEqual(found.map((f) => f.peer.id).sort(), ["a", "c"]);
});

test("a room with no peers is skipped without complaint", () => {
  assert.deepStrictEqual(orphans(new Map([["x", { id: "x", peers: new Map() }]]), alive(), { now: T }), []);
  assert.deepStrictEqual(orphans(new Map([["x", null]]), alive(), { now: T }), []);
});

test("how long they had been there is reported, for the log", () => {
  const found = orphans(rooms([peer("a", { joinedAt: T - 90000 })]), alive(), { now: T });
  assert.strictEqual(found[0].ageMs, 90000);
});

test("the interval falls back to the default for nonsense", () => {
  const before = process.env.ORPHAN_REAP_MS;
  try {
    delete process.env.ORPHAN_REAP_MS;
    assert.strictEqual(intervalMs(), DEFAULT_INTERVAL_MS);
    process.env.ORPHAN_REAP_MS = "banana";
    assert.strictEqual(intervalMs(), DEFAULT_INTERVAL_MS);
    process.env.ORPHAN_REAP_MS = "0";
    assert.strictEqual(intervalMs(), 0, "0 must switch it off rather than fall back");
    process.env.ORPHAN_REAP_MS = "3000";
    assert.strictEqual(intervalMs(), 3000);
  } finally {
    if (before === undefined) delete process.env.ORPHAN_REAP_MS;
    else process.env.ORPHAN_REAP_MS = before;
  }
});
