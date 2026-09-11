/**
 * How often this browser is allowed to reload itself back into a meeting.
 *
 * Recovering from a dropped socket is a page load, and a page load starts a
 * fresh JavaScript world -- so an in-memory flag cannot see the reload before
 * it. On a line that is flapping rather than broken, that is a reload loop:
 * connect, drop, reload, connect, drop, and a teacher who cannot get a word
 * out. The only thing that survives a load and dies with the tab is session
 * storage, so the last attempt is written there.
 *
 * Pure apart from the store it is handed, so the rule is testable without a
 * browser.
 */

export const REJOIN_COOLDOWN_MS = 20000;

const KEY = "lynmeet.lastRejoinAt";

/**
 * @param {Storage|null} store   sessionStorage, or null when it is unavailable
 * @param {number} now
 * @returns {boolean} whether a reload is allowed right now
 */
export function mayReload(store, now = Date.now()) {
  try {
    // No store is not a reason to sit frozen: one reload is better than none,
    // and without a store there is nothing to loop on anyway.
    if (!store) return true;
    const last = Number(store.getItem(KEY));
    if (!Number.isFinite(last) || last <= 0) return true;
    // A clock that jumped backwards would otherwise block reloads for ever.
    if (now < last) return true;
    return now - last >= REJOIN_COOLDOWN_MS;
  } catch {
    return true;
  }
}

export function markReloaded(store, now = Date.now()) {
  try {
    store?.setItem(KEY, String(now));
  } catch {
    // A browser with storage disabled still gets to reload; it just cannot be
    // held back from doing it again.
  }
}

/** What the component calls: asks, and records the answer if it is yes. */
export function shouldReloadNow(store = safeSessionStorage(), now = Date.now()) {
  if (!mayReload(store, now)) return false;
  markReloaded(store, now);
  return true;
}

function safeSessionStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    // Private mode in some browsers throws on access rather than returning null.
    return null;
  }
}
