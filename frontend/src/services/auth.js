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
 * Redeems a hand-off token if lynindia.in sent us here with one.
 *
 * The platform links to
 * `https://meet.lynindia.in/?lynmeet=10214&TockenID=...`, so the token arrives
 * in the query string of a page nginx serves -- it never reaches our backend in
 * that request. This lifts it out, posts it in a body (where it stays out of
 * access logs and Referer headers), and then rewrites the URL.
 *
 * `replaceState` is used rather than `pushState` so the token-bearing URL is
 * not left behind in the back button or the history list. It is still in
 * nginx's log of that first GET, which is exactly why the server deletes the
 * row as it redeems it: by the time anyone reads that log, the token is spent.
 *
 * @returns {Promise<{email,name,role,isStaff}|null>} the user if a token was
 *   present and valid; null if there was no token at all
 * @throws {Error} when a token was present but refused
 */
export async function redeemHandoffToken() {
  const url = new URL(window.location.href);
  const key = TOKEN_PARAMS.find((p) => url.searchParams.get(p));
  if (!key) return null;

  const token = url.searchParams.get(key);

  // Scrub first, ask questions second. If the POST throws, or the user closes
  // the tab midway, the token should already be gone from the address bar.
  for (const p of TOKEN_PARAMS) url.searchParams.delete(p);
  const cleaned = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "") + url.hash;
  try {
    window.history.replaceState(null, "", cleaned);
  } catch {
    // Non-fatal: an unusual embedding context may forbid it.
  }

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
 * @returns {Promise<{email, name, role, isStaff}|null>} null when signed out
 */
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
