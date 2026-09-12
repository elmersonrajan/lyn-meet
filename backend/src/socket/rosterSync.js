/**
 * Who is in the room, said again on a timer.
 *
 * Presence was pushed and never repeated: one `participants` message per event,
 * and a browser that missed it was wrong until the next thing happened to
 * somebody else. In a class where nobody joins or leaves for twenty minutes,
 * "until the next thing happens" is twenty minutes of a list showing people who
 * are not there.
 *
 * A message can be missed for reasons the sender cannot see or fix -- a socket
 * that reconnected onto a new id, a proxy that dropped a frame, a tab the
 * browser froze while it was in the background. Every one of those produces the
 * same symptom, and no amount of care at the point of sending prevents them,
 * because the failure is not at the point of sending.
 *
 * So the roster is soft state and this repeats it. It is exactly why the
 * attendance panel was right about everything while the participant list was
 * wrong: attendance asks the server every time it draws.
 *
 * This is not a licence to skip telling the room when something happens -- an
 * event is what makes presence feel live, and ten seconds of a stale name is
 * plainly worse than none. This is the floor under it: however a message is
 * lost, every screen is correct again within one interval.
 */

const { createLogger } = require("../utils/logger");

const log = createLogger("RosterSync");

const DEFAULT_INTERVAL_MS = 10000;

function intervalMs() {
  const raw = Number(process.env.ROSTER_SYNC_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * One line describing a room's roster, for deciding whether anything changed.
 *
 * The whole point is to repeat the truth, so a room nobody is changing still
 * gets sent -- but only when it differs from last time, so an idle server is
 * not broadcasting the same forty names for the length of a lesson. A new
 * arrival is caught by the join event and reconciled by the first tick after
 * it, whichever lands first.
 */
function signature(participants) {
  return participants
    .map((p) => `${p.id}:${p.audioMuted ? 1 : 0}${p.videoOff ? 1 : 0}${p.disconnected ? 1 : 0}`)
    .join("|");
}

/**
 * @param {Map<string, {id: string, peers: Map, participants: () => object[]}>} rooms
 * @param {Map<string, string>} lastSeen  room id -> last signature sent
 * @returns {Array<{roomId: string, participants: object[]}>} what to send now
 */
function pending(rooms, lastSeen, { force = false } = {}) {
  const out = [];
  for (const room of rooms.values()) {
    // An empty room is closed by the code that emptied it; nothing to say and
    // nobody to say it to.
    if (!room || room.peers.size === 0) {
      lastSeen.delete(room?.id);
      continue;
    }
    const participants = room.participants();
    const sig = signature(participants);
    if (!force && lastSeen.get(room.id) === sig) continue;
    lastSeen.set(room.id, sig);
    out.push({ roomId: room.id, participants });
  }
  return out;
}

/**
 * Starts the timer. Returns a stop function.
 *
 * unref'd: this must never be the reason a process refuses to exit.
 */
function start(io, rooms) {
  const ms = intervalMs();
  if (ms === 0) {
    log.warn("roster sync disabled by ROSTER_SYNC_MS=0");
    return () => {};
  }
  const lastSeen = new Map();
  const timer = setInterval(() => {
    try {
      for (const { roomId, participants } of pending(rooms, lastSeen)) {
        io.to(roomId).emit("participants", participants);
      }
    } catch (err) {
      log.error("roster sync tick failed", err);
    }
  }, ms);
  timer.unref?.();
  log.info("roster sync started", { everyMs: ms });
  return () => clearInterval(timer);
}

module.exports = { start, pending, signature, intervalMs, DEFAULT_INTERVAL_MS };
