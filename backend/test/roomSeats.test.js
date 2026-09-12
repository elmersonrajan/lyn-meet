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

/* ---------- Finding a peer from the connection that made it ---------- */

const { findBySocket, rooms, getOrCreateRoom } = require("../src/mediasoup/roomManager");

function liveRoom(id, people) {
  const room = new Room(id, null);
  for (const p of people) room.peers.set(p.id, p);
  rooms.set(id, room);
  return room;
}

test("a peer is found from the socket that made it", () => {
  // This is what the disconnect handler falls back to when socket.data has
  // been overwritten by a later join -- the case that stranded peers in the
  // room for the rest of the lesson.
  rooms.clear();
  const peer = new Peer({ id: "p1", socketId: "sock-1", name: "A", role: "student", email: "a@x" });
  const room = liveRoom("10242", [peer]);
  const found = findBySocket("sock-1");
  assert.strictEqual(found.peer, peer);
  assert.strictEqual(found.room, room);
  rooms.clear();
});

test("it looks across every room, not just one", () => {
  // A socket that joined a second class strands its first peer in a DIFFERENT
  // room, which is why this cannot be scoped to the room being joined.
  rooms.clear();
  liveRoom("10242", [new Peer({ id: "p1", socketId: "sock-1", name: "A", role: "student" })]);
  const other = new Peer({ id: "p2", socketId: "sock-2", name: "B", role: "student" });
  liveRoom("10243", [other]);
  assert.strictEqual(findBySocket("sock-2").peer, other);
  rooms.clear();
});

test("an unknown or missing socket finds nothing rather than throwing", () => {
  rooms.clear();
  assert.strictEqual(findBySocket("nobody"), null);
  assert.strictEqual(findBySocket(null), null);
  assert.strictEqual(findBySocket(undefined), null);
  assert.strictEqual(findBySocket(""), null);
  rooms.clear();
});
