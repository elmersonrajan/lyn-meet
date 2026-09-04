/**
 * Client side of the SSO bridge.
 *
 * There is deliberately no login form here. The session cookie is httpOnly, so
 * this file cannot read it and cannot fake it -- all it can do is ask the
 * server who the browser is and, if the answer is nobody, hand the page over
 * to lynindia.in.
 */

/** Where to send someone who is not signed in. Filled in from the 401 body. */
let cachedLoginUrl = "/auth/login";

/** The platform spells it "TockenID"; accept the obvious spelling too. */
const TOKEN_PARAMS = ["TockenID", "TokenID", "tockenid", "tokenid"];

/**
 * The hand-off token, lifted out of the URL once when this module loads.
 *
 * Capturing it here rather than inside the component is what makes the arrival
 * survive React StrictMode, which mounts every component twice. The old code
 * read the URL inside the effect and scrubbed it synchronously, so the second
 * mount found nothing, fell through to asking about a cookie, and raced the
 * first mount's still-in-flight exchange. The cookie usually lost that race, so
 * the *first* click of a link bounced back to lynindia.in and only the second
 * or third worked -- by which point a cookie existed from the earlier attempt.
 *
 * `replaceState` rather than `pushState` so the token-bearing URL is not left
 * in the back button. It is still in nginx's log of that first GET, which is
 * why the server deletes the row as it redeems it.
 */
const arrivalToken = (() => {
  try {
    const url = new URL(window.location.href);
    const key = TOKEN_PARAMS.find((p) => url.searchParams.get(p));
    if (!key) return null;
    const token = url.searchParams.get(key);

    for (const p of TOKEN_PARAMS) url.searchParams.delete(p);
    const query = url.searchParams.toString();
    const cleaned = url.pathname + (query ? `?${query}` : "") + url.hash;
    try {
      window.history.replaceState(null, "", cleaned);
    } catch {
      // Non-fatal: an unusual embedding context may forbid it.
    }
    return token;
  } catch {
    return null;
  }
})();

/** The single exchange for this page load. Every caller awaits the same one. */
let handoffInFlight = null;

async function exchange(token) {
  const res = await fetch("/auth/handoff", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token }),
  });

  const body = await res.json().catch(() => ({}));
  if (res.ok && body.user) return body.user;

  if (body.loginUrl) cachedLoginUrl = body.loginUrl;
  // 401 is a stale or reused link -- recoverable by signing in again.
  // 403 means the account itself is not allowed, which a retry will not fix.
  const err = new Error(body.error || "Sign-in failed");
  err.recoverable = res.status === 401;
  throw err;
}

/**
 * Redeems the hand-off token, if this page load arrived with one.
 *
 * Memoised on purpose: the token is single-use, so a second exchange would
 * spend a token that no longer exists. Both StrictMode mounts get the same
 * promise and therefore the same answer.
 *
 * @returns {Promise<{email,name,role,isStaff}|null>} null when no token arrived
 * @throws {Error} when a token arrived but was refused
 */
export function redeemHandoffToken() {
  if (!arrivalToken) return Promise.resolve(null);
  if (!handoffInFlight) handoffInFlight = exchange(arrivalToken);
  return handoffInFlight;
}

export async function fetchMe() {
  const res = await fetch("/auth/me", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    try {
      const body = await res.json();
      if (body?.loginUrl) cachedLoginUrl = body.loginUrl;
    } catch {
      // A proxy error page instead of JSON still means "signed out".
    }
    return null;
  }
  if (!res.ok) throw new Error(`Sign-in check failed (${res.status})`);
  const body = await res.json();
  return body.user;
}

/**
 * Leaves the SPA for the main site's login, remembering where we were so the
 * round trip lands back on the same meeting link.
 */
export function goToLogin() {
  const next = window.location.pathname + window.location.search;
  const url = new URL(cachedLoginUrl, window.location.origin);
  url.searchParams.set("redirect", new URL(next, window.location.origin).toString());
  window.location.replace(url.toString());
}

export async function logout() {
  try {
    const res = await fetch("/auth/logout", { method: "POST", credentials: "include" });
    const body = await res.json().catch(() => ({}));
    // Ending the meeting session does not end the lynindia.in one; sending the
    // user back there is the honest outcome, not a claim that they are fully
    // signed out.
    window.location.replace(body.siteUrl || "/");
  } catch (err) {
    console.error("[Auth] logout failed", err);
    window.location.replace("/");
  }
}
