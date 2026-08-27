const { rooms, closeRoom } = require("../mediasoup/roomManager");
const { createLogger } = require("../utils/logger");

const log = createLogger("IdleReaper");

/**
 * Closes rooms nobody is using, from the server rather than the browser.
 *
 * A tab left open, a laptop closed with the page still loaded, or a meeting
 * somebody forgot to end all keep a mediasoup Router and its transports alive.
 * Each idle room holds worker resources and RTP ports, so they are reclaimed
 * here on a fixed schedule instead of relying on a client to say goodbye.
 */

const EMPTY_MS = Number(process.env.IDLE_EMPTY_MS || 15 * 60 * 1000);
const SOLO_MS = Number(process.env.IDLE_SOLO_MS || 20 * 60 * 1000);
const CHECK_MS = Number(process.env.IDLE_CHECK_MS || 30 * 1000);

/**
 * Peers inside the teacher reconnect grace window are still in room.peers but
 * are not present, so they must not keep a room alive on their own.
 */
function activeCount(room) {
  let n = 0;
  for (const peer of room.peers.values()) {
    if (!peer.disconnected) n += 1;
  }
  return n;
}

/**
 * Decides a room's fate from its occupancy history.
 *
 * Exported and pure so the timing rules can be tested without spinning up
 * mediasoup: the caller supplies the counts and the clock.
 *
 * @param {{count:number, since:number}|null} state previous occupancy state
 * @param {number} count current active peers
 * @param {number} now
 * @param {{emptyMs:number, soloMs:number}} limits
 * @returns {{state:{count:number,since:number}, close:null|"empty"|"solo", idleMs:number}}
 */
function evaluateRoom(state, count, now, limits = { emptyMs: EMPTY_MS, soloMs: SOLO_MS }) {
  // Occupancy changed: the clock restarts from this moment.
  if (!state || state.count !== count) {
    return { state: { count, since: now }, close: null, idleMs: 0 };
  }

  const idleMs = now - state.since;
  let close = null;
  if (count === 0 && idleMs >= limits.emptyMs) close = "empty";
  else if (count === 1 && idleMs >= limits.soloMs) close = "solo";
  return { state, close, idleMs };
}

const REASONS = {
  empty: "Meeting closed automatically — nobody was in it",
  solo: "Meeting closed automatically — only one person was in it",
};

/**
 * @param {import("socket.io").Server} io
 * @returns {() => void} stop function
 */
function startIdleReaper(io) {
  // Occupancy state per room id, kept here rather than on the Room so the
  // reaper owns its own bookkeeping and a room carries no reaper fields.
  const states = new Map();

  const tick = async () => {
    const now = Date.now();
    try {
      for (const room of [...rooms.values()]) {
        const count = activeCount(room);
        const result = evaluateRoom(states.get(room.id), count, now);
        states.set(room.id, result.state);

        if (!result.close) continue;

        log.action("closing idle room", {
          roomId: room.id,
          reason: result.close,
          activePeers: count,
          idleMinutes: Math.round(result.idleMs / 60000),
        });

        try {
          // Tell anyone still connected before the room goes, so a lone
          // participant is returned to the lobby rather than left staring at a
          // dead meeting.
          if (count > 0) io.to(room.id).emit("session-closed", { reason: REASONS[result.close] });
          await closeRoom(room);
        } catch (err) {
          log.error("failed to close idle room", room.id, err);
        }
        states.delete(room.id);
      }

      // Drop bookkeeping for rooms that have gone away by other means.
      for (const id of [...states.keys()]) {
        if (!rooms.has(id)) states.delete(id);
      }
    } catch (err) {
      log.error("idle sweep failed", err);
    }
  };

  const timer = setInterval(tick, CHECK_MS);
  // Must not keep the process alive on its own during shutdown.
  if (timer.unref) timer.unref();

  log.info("idle reaper started", {
    emptyMinutes: Math.round(EMPTY_MS / 60000),
    soloMinutes: Math.round(SOLO_MS / 60000),
    checkSeconds: Math.round(CHECK_MS / 1000),
  });

  return () => clearInterval(timer);
}

module.exports = { startIdleReaper, evaluateRoom, activeCount, EMPTY_MS, SOLO_MS, CHECK_MS };
