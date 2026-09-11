const test = require("node:test");
const assert = require("node:assert");

const { Room, Peer, accountKey } = require("../src/mediasoup/roomManager");

function seat(room, { id, email, role = "student", name = "A" }) {
  const peer = new Peer({ id, socketId: `s-${id}`, name, role, email });
  room.peers.set(peer.id, peer);
  return peer;
}

test("an account already in the room is found again", () => {
  const room = new Room("10239", null);
  const first = seat(room, { id: "p1", email: "ida@lynindia.in" });
  seat(room, { id: "p2", email: "someone.else@lynindia.in" });
  assert.strictEqual(room.findPeerByAccount("ida@lynindia.in"), first);
});

test("the same person in different letter case is the same person", () => {
  // The platform is not consistent about this, and a comparison that cared
  // would seat one person twice.
  const room = new Room("10239", null);
  const first = seat(room, { id: "p1", email: "Ida.Sharon@LynIndia.in" });
  assert.strictEqual(room.findPeerByAccount("  ida.sharon@lynindia.in "), first);
});

test("a peer with no account is never matched to another", () => {
  // Ad-hoc rooms and AUTH_DISABLED produce these. Two of them are not evidence
  // of one person -- there is nothing there to compare.
  const room = new Room("MATH-101", null);
  seat(room, { id: "p1", email: null });
  assert.strictEqual(room.findPeerByAccount(null), null);
  assert.strictEqual(room.findPeerByAccount(""), null);
});

test("the peer being seated does not find itself", () => {
  const room = new Room("10239", null);
  seat(room, { id: "p1", email: "ida@lynindia.in" });
  assert.strictEqual(room.findPeerByAccount("ida@lynindia.in", { exclude: "p1" }), null);
});

test("accountKey reduces an address to something comparable", () => {
  assert.strictEqual(accountKey(" Ida@Lyn.in "), "ida@lyn.in");
  assert.strictEqual(accountKey(""), null);
  assert.strictEqual(accountKey(undefined), null);
});
