const test = require("node:test");
const assert = require("node:assert");

const { pending, signature, intervalMs, DEFAULT_INTERVAL_MS } = require("../src/socket/rosterSync");

function room(id, people) {
  return {
    id,
    peers: new Map(people.map((p) => [p.id, p])),
    participants: () => people,
  };
}

const p = (id, extra = {}) => ({
  id,
  name: id,
  audioMuted: false,
  videoOff: false,
  disconnected: false,
  ...extra,
});

test("a room is sent once, then not again while nothing changes", () => {
  // An idle class must not be a broadcast of forty names every ten seconds.
  const rooms = new Map([["10242", room("10242", [p("a"), p("b")])]]);
  const seen = new Map();
  assert.strictEqual(pending(rooms, seen).length, 1);
  assert.strictEqual(pending(rooms, seen).length, 0);
});

test("someone leaving makes it send again", () => {
  // This is the whole purpose: the leave message was missed, and one tick later
  // every screen is right anyway.
  const rooms = new Map();
  const seen = new Map();
  rooms.set("10242", room("10242", [p("a"), p("b")]));
  pending(rooms, seen);
  rooms.set("10242", room("10242", [p("a")]));
  const out = pending(rooms, seen);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].participants.map((x) => x.id), ["a"]);
});

test("muting is a change too", () => {
  // The row shows muted/in session, so the state on it has to be part of what
  // counts as different -- otherwise a missed mute is stale until someone joins.
  const rooms = new Map();
  const seen = new Map();
  rooms.set("10242", room("10242", [p("a")]));
  pending(rooms, seen);
  rooms.set("10242", room("10242", [p("a", { audioMuted: true })]));
  assert.strictEqual(pending(rooms, seen).length, 1);
});

test("a teacher going from present to reconnecting is a change", () => {
  const rooms = new Map();
  const seen = new Map();
  rooms.set("10242", room("10242", [p("t")]));
  pending(rooms, seen);
  rooms.set("10242", room("10242", [p("t", { disconnected: true })]));
  assert.strictEqual(pending(rooms, seen).length, 1);
});

test("an empty room is skipped and forgotten", () => {
  const rooms = new Map([["10242", room("10242", [])]]);
  const seen = new Map([["10242", "stale"]]);
  assert.deepStrictEqual(pending(rooms, seen), []);
  assert.strictEqual(seen.has("10242"), false);
});

test("force sends even when nothing changed", () => {
  const rooms = new Map([["10242", room("10242", [p("a")])]]);
  const seen = new Map();
  pending(rooms, seen);
  assert.strictEqual(pending(rooms, seen, { force: true }).length, 1);
});

test("rooms are independent of each other", () => {
  const rooms = new Map();
  const seen = new Map();
  rooms.set("1", room("1", [p("a")]));
  rooms.set("2", room("2", [p("b")]));
  assert.strictEqual(pending(rooms, seen).length, 2);
  rooms.set("2", room("2", [p("b"), p("c")]));
  const out = pending(rooms, seen);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].roomId, "2");
});

test("order matters to the signature only through identity, not position", () => {
  // Two peers swapping places in the array is not a change worth sending, but
  // it also must not crash or loop -- pinning current behaviour honestly.
  assert.notStrictEqual(signature([p("a"), p("b")]), signature([p("b"), p("a")]));
});

test("the interval falls back to the default for nonsense", () => {
  const before = process.env.ROSTER_SYNC_MS;
  try {
    delete process.env.ROSTER_SYNC_MS;
    assert.strictEqual(intervalMs(), DEFAULT_INTERVAL_MS);
    process.env.ROSTER_SYNC_MS = "banana";
    assert.strictEqual(intervalMs(), DEFAULT_INTERVAL_MS);
    process.env.ROSTER_SYNC_MS = "-5";
    assert.strictEqual(intervalMs(), DEFAULT_INTERVAL_MS);
    process.env.ROSTER_SYNC_MS = "0";
    assert.strictEqual(intervalMs(), 0, "0 must switch it off rather than fall back");
    process.env.ROSTER_SYNC_MS = "2500";
    assert.strictEqual(intervalMs(), 2500);
  } finally {
    if (before === undefined) delete process.env.ROSTER_SYNC_MS;
    else process.env.ROSTER_SYNC_MS = before;
  }
});
