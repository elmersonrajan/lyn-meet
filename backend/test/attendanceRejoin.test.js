const test = require("node:test");
const assert = require("node:assert");

const { foldSessions } = require("../src/attendance/attendanceLog");

const T0 = Date.UTC(2026, 8, 11, 9, 0, 0);
const min = (n) => T0 + n * 60000;

function ev(type, at, extra = {}) {
  return {
    type,
    at,
    email: "ida@lynindia.in",
    name: "ADMIN",
    role: "coordinator",
    peerId: extra.peerId || "p",
    reason: extra.reason,
  };
}

/**
 * A rejoin is one person coming back, not a second person and not an hour of
 * unexplained presence. The register is folded by account, so the seat change
 * has to close the old session for the numbers to mean anything.
 */
test("a rejoin closes the first period and opens a second", () => {
  const people = foldSessions([
    ev("join", min(0)),
    ev("leave", min(7), { reason: "replaced" }),
    ev("join", min(7), { peerId: "p2" }),
    ev("leave", min(20), { peerId: "p2" }),
  ]);
  const [person] = [...people.values()];
  assert.strictEqual(people.size, 1, "one account is one person");
  assert.strictEqual(person.sessions.length, 2);
  assert.strictEqual(person.sessions[0].durationMs, 7 * 60000);
  assert.strictEqual(person.sessions[0].reason, "replaced");
  assert.strictEqual(person.sessions[1].durationMs, 13 * 60000);
});

/**
 * What the register looked like before the seat was released: the old peer was
 * still open when the new one joined, so the first period could only be closed
 * by guesswork and was marked unprovable.
 */
test("a rejoin with no leave in between is still marked unprovable", () => {
  const people = foldSessions([
    ev("join", min(0)),
    ev("join", min(7), { peerId: "p2" }),
    ev("leave", min(20), { peerId: "p2" }),
  ]);
  const [person] = [...people.values()];
  assert.strictEqual(person.sessions[0].reason, "exit-not-recorded");
});
