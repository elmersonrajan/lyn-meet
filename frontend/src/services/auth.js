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
