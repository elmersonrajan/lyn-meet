/**
 * The meeting side of the SSO bridge.
 *
 *   lynindia.in  --302 with one-time ticket-->  /auth/sso/callback
 *                                                  |
 *                        verify signature, issuer, audience, expiry, jti
 *                                                  |
 *                        look the email up in v_Users  <-- the real gate
 *                                                  |
 *                                        set httpOnly session cookie
 *                                                  |
 *                                          302 to the meeting
 *
 * The ticket proves *which account*; the database decides *whether* and *as
 * what*. Both must pass.
 */
const express = require("express");
const { config } = require("./config");
const ticket = require("./ticket");
const handoff = require("./handoff");
const session = require("./session");
const directory = require("./directory");
const { requireAuth } = require("./middleware");
const { createLogger } = require("../utils/logger");

const log = createLogger("AuthRoutes");

/**
 * Only same-site destinations are honoured as a post-login target, so a
 * crafted link cannot turn our callback into a redirector that launders a
 * phishing page through a trusted domain.
 */
function safeNext(raw) {
  const fallback = "/";
  const value = String(raw || "").trim();
  if (!value) return fallback;
  // A bare path is fine, but "//evil.com" is a protocol-relative URL.
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    if (!config.allowedRedirectHosts.includes(url.host.toLowerCase())) {
      log.warn("refused off-site redirect target", { host: url.host });
      return fallback;
    }
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** Where to bounce someone who needs to sign in first. */
function loginRedirectUrl(returnTo) {
  const url = new URL(config.loginUrl);
  url.searchParams.set("redirect", new URL(returnTo || "/", config.ssoAudience).toString());
  return url.toString();
}

function createAuthRouter() {
  const router = express.Router();

  /**
   * Entry point for someone who lands here with no session. Sends them to
   * lynindia.in, which will bounce them straight back if they are already
   * signed in there -- so a logged-in user sees a flicker, not a login form.
   */
  router.get("/login", (req, res) => {
    res.redirect(302, loginRedirectUrl(safeNext(req.query.next)));
  });

  /** Redemption. One ticket, one session, one time. */
  router.get("/sso/callback", async (req, res) => {
    const next = safeNext(req.query.next);
    try {
      const claim = ticket.verify(req.query.ticket);

      // The decisive check. A perfectly signed ticket for someone who has been
      // removed from the organisation -- or who never existed in it -- stops
      // here.
      const identity = await directory.lookup(claim.email);
      if (!identity) {
        log.warn("ticket valid but user is not authorised", { email: claim.email });
        return res
          .status(403)
          .type("html")
          .send(denialPage("Your account is not authorised to join meetings."));
      }

      session.setCookie(res, session.issue(identity));
      log.action("sso sign-in", {
        email: identity.email,
        role: identity.role,
        userTypes: identity.userTypes,
      });
      res.redirect(302, next);
    } catch (err) {
      if (err instanceof ticket.TicketError) {
        log.warn("sso callback refused", { reason: err.reason });
        // An expired or reused link is usually a stale tab or a back button,
        // not an attack -- send them round the loop again rather than to a
        // dead end. A tampered one gets the same treatment; it will simply
        // fail again if they are not really signed in.
        return res.redirect(302, loginRedirectUrl(next));
      }
      log.error("sso callback failed", err);
      res.status(500).type("html").send(denialPage("Sign-in is temporarily unavailable."));
    }
  });

  /**
   * Token hand-off from lynindia.in.
   *
   * POST, not GET, and that is the whole point. The platform sends people to
   * `https://meet.lynindia.in/?lynmeet=10214&TockenID=...`, which nginx serves
   * as the SPA -- the token never reaches this server in that request. The page
   * lifts it out of the query string, posts it here in a body, and rewrites its
   * own URL. So the token stays out of our access logs, out of Referer headers
   * and out of the address bar, and the row is deleted as it is redeemed.
   *
   * It cannot be kept out of nginx's log of that first request, which is why
   * single use matters: by the time anyone reads that log, the token is spent.
   */
  router.post("/handoff", async (req, res) => {
    try {
      const identity = await handoff.redeem(req.body?.token);
      session.setCookie(res, session.issue(identity));
      res.json({
        ok: true,
        user: {
          email: identity.email,
          name: identity.name,
          role: identity.role,
          isStaff: identity.role === "teacher" || identity.role === "coordinator",
        },
      });
    } catch (err) {
      if (err instanceof handoff.HandoffError) {
        // 403 for a real refusal, 401 for a stale link -- the SPA sends the
        // user back to lynindia.in on 401 and shows the reason on 403.
        const status = err.reason === "not-authorised" ? 403 : 401;
        return res.status(status).json({
          ok: false,
          error: err.message,
          reason: err.reason,
          loginUrl: config.loginUrl,
        });
      }
      log.error("hand-off failed", err);
      res.status(500).json({ ok: false, error: "Sign-in is temporarily unavailable" });
    }
  });

  /**
   * Fallback for the case where nginx *does* route the root request here (or
   * someone opens the hand-off URL against the API host directly). Redeems the
   * token and bounces to the clean URL so it leaves the address bar.
   */
  router.get("/handoff", async (req, res) => {
    const meeting = String(req.query.lynmeet || "").trim();
    const clean = meeting ? `/?lynmeet=${encodeURIComponent(meeting)}` : "/";
    try {
      const identity = await handoff.redeem(req.query.TockenID || req.query.TokenID);
      session.setCookie(res, session.issue(identity));
      res.redirect(302, clean);
    } catch (err) {
      if (err instanceof handoff.HandoffError) {
        if (err.reason === "not-authorised") {
          return res.status(403).type("html").send(denialPage(err.message));
        }
        return res.redirect(302, loginRedirectUrl(clean));
      }
      log.error("hand-off redirect failed", err);
      res.status(500).type("html").send(denialPage("Sign-in is temporarily unavailable."));
    }
  });

  /** Who am I? The SPA calls this on load instead of showing a name field. */
  router.get("/me", requireAuth, (req, res) => {
    res.json({
      ok: true,
      user: {
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        isStaff: req.user.role === "teacher" || req.user.role === "coordinator",
      },
    });
  });

  /** Drops our cookie. The lynindia.in session is theirs to end, not ours. */
  router.post("/logout", (req, res) => {
    if (req.user) log.action("sign-out", { email: req.user.email });
    session.clearCookie(res);
    res.json({ ok: true, siteUrl: config.siteUrl });
  });

  return router;
}

function denialPage(message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  return `<!doctype html><meta charset="utf-8">
<title>Access denied</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:32rem;padding:0 1.5rem;color:#1f2937}
h1{font-size:1.25rem}a{color:#2563eb}</style>
<h1>Access denied</h1><p>${safe}</p>
<p><a href="${config.siteUrl}">Return to LYN India</a></p>`;
}

module.exports = { createAuthRouter, safeNext, loginRedirectUrl };
