/**
 * Single-use enforcement for hand-off tickets.
 *
 * A signed ticket is otherwise a bearer credential: anyone who captures one
 * from a browser history entry, a proxy log or a shoulder-surfed URL could
 * replay it until it expires. Recording each `jti` on first use closes that
 * window to exactly one redemption.
 *
 * Entries are kept only until the ticket would have expired anyway -- after
 * that the signature check rejects it on its own, so remembering it longer
 * buys nothing and leaks memory.
 *
 * SCOPE: this store is per-process. It is correct for the single meeting
 * server this app runs as today. If the backend is ever scaled to more than
 * one instance behind a load balancer, a ticket redeemed on instance A would
 * still be redeemable once on instance B -- at that point this must move to
 * Redis or a small `SsoTicketUsed(jti, ExpiresAt)` table. See docs/SSO.md.
 */
const { createLogger } = require("../utils/logger");

const log = createLogger("Replay");

/** jti -> epoch ms after which the ticket is dead regardless. */
const used = new Map();

let sweeper = null;

function sweep() {
  const now = Date.now();
  let dropped = 0;
  for (const [jti, expiresAt] of used) {
    if (expiresAt <= now) {
      used.delete(jti);
      dropped += 1;
    }
  }
  if (dropped) log.info("swept expired ticket ids", { dropped, remaining: used.size });
}

function start() {
  if (sweeper) return;
  sweeper = setInterval(sweep, 60_000);
  // Never hold the process open just to tidy a cache.
  if (typeof sweeper.unref === "function") sweeper.unref();
}

/**
 * Claims a ticket id. Returns false if it has already been redeemed.
 *
 * @param {string} jti  unique id from the ticket
 * @param {number} expiresAtMs  the ticket's own expiry, in epoch ms
 */
function consume(jti, expiresAtMs) {
  start();
  const id = String(jti || "");
  if (!id) return false;

  const existing = used.get(id);
  if (existing !== undefined && existing > Date.now()) {
    log.warn("ticket replay refused", { jti: id });
    return false;
  }
  used.set(id, expiresAtMs);
  return true;
}

function size() {
  return used.size;
}

/** Test seam. */
function reset() {
  used.clear();
}

module.exports = { consume, size, reset, sweep };
