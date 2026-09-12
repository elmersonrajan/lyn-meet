/**
 * Peers whose connection no longer exists.
 *
 * A Peer is only ever removed by the disconnect handler of the socket that
 * owns it. That is one code path, run once, with no second chance: if it does
 * not run, or runs and finds nothing because `socket.data` had already been
 * cleared, the Peer stays in the room for the rest of the meeting. Its name
 * stays in every participant list, its row stays on the register, and nothing
 * anywhere will ever remove it.
 *
 * And the browsers are right about it. This is worth being clear on, because
 * it is the opposite of the problem it looks like: re-sending the roster does
 * not help, because the roster faithfully describes a room that is wrong.
 *
 * `io.sockets.sockets` is the authority on which connections exist, and it
 * costs one map lookup per peer to ask. So the room is reconciled against it
 * on a timer -- the same reasoning as repeating the roster, one level down:
 * the room's own state is checked against something that cannot drift, rather
 * than trusted because it was correct when it was written.
 *
 * The decision is pure and tested; the removal is done by the caller, which is
 * the only place that knows how to tell a room that somebody has gone.
 */

const { createLogger } = require("../utils/logger");

const log = createLogger("OrphanReaper");

const DEFAULT_INTERVAL_MS = 5000;

/**
 * How long a peer is left alone after joining.
 *
 * Guards against reaping somebody mid-handshake. The socket exists before the
 * Peer does, so this should never be load-bearing -- it is here because the
 * cost of being wrong in this direction is throwing a real person out of a
 * class, and the cost of waiting is a few seconds of a name.
 */
const JOIN_GRACE_MS = 15000;

function intervalMs() {
  const raw = Number(process.env.ORPHAN_REAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * @param {Map} rooms
 * @param {(socketId: string) => boolean} isAlive
 * @returns {Array<{room: object, peer: object, ageMs: number}>}
 */
function orphans(rooms, isAlive, { graceMs = JOIN_GRACE_MS, now = Date.now() } = {}) {
  const found = [];
  for (const room of rooms.values()) {
    if (!room || !room.peers) continue;
    for (const peer of room.peers.values()) {
      if (isAlive(peer.socketId)) continue;
      /**
       * A teacher inside the reconnect window has no socket ON PURPOSE -- that
       * is the entire point of the window, and the room, the board and any
       * running recording are being held open for them. Its own timer removes
       * them when it expires.
       */
      if (peer.role === "teacher" && peer.disconnected) continue;
      if (now - peer.joinedAt < graceMs) continue;
      found.push({ room, peer, ageMs: now - peer.joinedAt });
    }
  }
  return found;
}

/**
 * @param {object} io
 * @param {Map} rooms
 * @param {(room, peer) => void} remove  how to actually take a peer out
 * @returns {() => void} stop
 */
function start(io, rooms, remove) {
  const ms = intervalMs();
  if (ms === 0) {
    log.warn("orphan reaping disabled by ORPHAN_REAP_MS=0");
    return () => {};
  }
  const isAlive = (socketId) => Boolean(socketId) && io.sockets.sockets.has(socketId);
  const timer = setInterval(() => {
    try {
      for (const { room, peer, ageMs } of orphans(rooms, isAlive)) {
        // Warn, not info: every one of these is a disconnect that did not do
        // its job, and a server quietly reaping them for a month is a bug
        // nobody is looking at.
        log.warn("reaping a peer whose socket is gone", {
          roomId: room.id,
          peerId: peer.id,
          name: peer.name,
          role: peer.role,
          socketId: peer.socketId,
          inRoomForMs: ageMs,
        });
        remove(room, peer);
      }
    } catch (err) {
      log.error("orphan reap tick failed", err);
    }
  }, ms);
  timer.unref?.();
  log.info("orphan reaping started", { everyMs: ms });
  return () => clearInterval(timer);
}

module.exports = { start, orphans, intervalMs, DEFAULT_INTERVAL_MS, JOIN_GRACE_MS };
