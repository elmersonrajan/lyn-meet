/**
 * Shareable meeting links.
 *
 * Pure functions with no React and no direct DOM reads -- every entry point
 * takes the location or a randomness source as an argument, so the whole module
 * is testable outside a browser.
 */

/** The parameter the Copy Link button writes. */
export const LINK_PARAM = "lynmeet";

/** Older/alternative names still accepted when reading, so no link ever dies. */
const QUERY_ALIASES = [LINK_PARAM, "meeting", "meetingId", "id"];

/** Path forms accepted in addition to the query string. */
const PATH_PATTERNS = [
  /^\/lynmeet=(.+)$/i,
  /^\/meeting=(.+)$/i,
  /^\/join\/(.+)$/i,
  /^\/m\/(.+)$/i,
];

/**
 * A generated code: three groups, lowercase, no ambiguous characters.
 * Used to recognise a bare path like /kfd-8mza-qtp without mistaking an asset
 * request or a future route for a meeting ID.
 */
export const CODE_PATTERN = /^[a-hjkmnp-z2-9]{3}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{3}$/;

// Excludes 0/o/O, 1/l/I and similar, so a code read aloud or copied by hand
// cannot land on the wrong meeting.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function cleanId(raw) {
  if (raw == null) return "";
  let value = String(raw).trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed escape sequence should not throw away the whole value.
  }
  // Strip anything after a fragment or stray separator picked up by a mangled
  // paste, and cap the length so a hostile link cannot carry a huge payload.
  return value.split("#")[0].split("?")[0].trim().slice(0, 64);
}

/**
 * Reads a meeting ID from a location-like object.
 * Query string wins over path: it is the format Copy Link produces, and it
 * works without any server rewrite rule.
 *
 * @param {{search?: string, pathname?: string}} loc
 * @returns {string} the meeting ID, or "" when the link carries none
 */
export function readMeetingIdFromUrl(loc = typeof window !== "undefined" ? window.location : {}) {
  try {
    const search = loc?.search || "";
    const params = new URLSearchParams(search);
    for (const key of QUERY_ALIASES) {
      const found = params.get(key);
      if (found) {
        const id = cleanId(found);
        if (id) return id;
      }
    }

    const pathname = loc?.pathname || "";
    for (const pattern of PATH_PATTERNS) {
      const match = pathname.match(pattern);
      if (match) {
        const id = cleanId(match[1]);
        if (id) return id;
      }
    }

    // A bare path is only treated as a meeting when it looks like a generated
    // code, so "/", "/assets/x.js" and any future route are left alone.
    const bare = cleanId(pathname.replace(/^\//, ""));
    if (CODE_PATTERN.test(bare)) return bare;

    return "";
  } catch (err) {
    console.error("[meetingLink] failed to read meeting from URL", err);
    return "";
  }
}

/**
 * Builds the link to share for a meeting.
 * @param {string} meetingId
 * @param {string} [origin] defaults to the current page origin
 */
export function buildMeetingLink(meetingId, origin) {
  const id = String(meetingId || "").trim();
  if (!id) return "";
  const base =
    origin || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/?${LINK_PARAM}=${encodeURIComponent(id)}`;
}

/**
 * Rewrites the address bar to the shareable form once a meeting is joined.
 *
 * A teacher who typed the meeting ID rather than following a link would
 * otherwise be left on a bare origin, with nothing to copy out of the address
 * bar. replaceState is used rather than pushState so the browser Back button
 * still leaves the meeting instead of stepping through URL edits.
 *
 * @returns {string} the URL now shown, or "" if nothing was changed
 */
export function syncUrlToMeeting(meetingId, win = typeof window !== "undefined" ? window : null) {
  try {
    if (!win?.history?.replaceState) return "";
    const link = buildMeetingLink(meetingId, win.location?.origin);
    if (!link) return "";
    if (win.location?.href === link) return link;
    win.history.replaceState(null, "", link);
    return link;
  } catch (err) {
    console.error("[meetingLink] could not sync the address bar", err);
    return "";
  }
}

/**
 * Generates a Meet-style code, e.g. kfd-8mza-qtp.
 *
 * Note this is obscurity, not security: the app has no authentication, so a
 * code only stops casual guessing of short IDs like "1" or "5".
 *
 * @param {(n:number)=>number[]} [randomBytes] injectable for tests
 */
export function generateMeetingCode(randomBytes = defaultRandomBytes) {
  const groups = [3, 4, 3];
  const total = groups.reduce((a, b) => a + b, 0);
  const bytes = randomBytes(total);
  let i = 0;
  return groups
    .map((len) =>
      Array.from({ length: len }, () => ALPHABET[bytes[i++] % ALPHABET.length]).join(""),
    )
    .join("-");
}

function defaultRandomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
    return out;
  }
  // Only reached in environments without Web Crypto; codes are not secrets.
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * Copies text, falling back to a hidden textarea where the async clipboard API
 * is unavailable -- which includes any page served over plain http, and this
 * app runs on a self-signed certificate that some browsers treat as insecure.
 *
 * @returns {Promise<boolean>} whether the copy succeeded
 */
export async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    console.warn("[meetingLink] clipboard API refused, falling back", err);
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch (err) {
    console.error("[meetingLink] copy failed", err);
    return false;
  }
}
