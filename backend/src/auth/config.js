/**
 * Auth configuration, validated once at boot.
 *
 * A misconfigured secret is an open door, so this refuses to start rather than
 * running with a weak or missing one. The one deliberate exception is
 * AUTH_DISABLED, which exists so a developer on a laptop with no database can
 * still work on video code -- it is refused outright when NODE_ENV=production.
 */
const { createLogger } = require("../utils/logger");

const log = createLogger("AuthConfig");

const MIN_SECRET_LENGTH = 32;

function secret(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is not set. Generate one with: openssl rand -hex 32`);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length})`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";

/**
 * Escape hatch for local development only. In production this is ignored and
 * a warning is logged, because the failure mode -- an unauthenticated meeting
 * server reachable from the internet -- is exactly what this module exists to
 * prevent.
 */
const authDisabled = (() => {
  const requested = String(process.env.AUTH_DISABLED || "") === "1";
  if (requested && isProduction) {
    log.error("AUTH_DISABLED=1 ignored: refusing to run without authentication in production");
    return false;
  }
  if (requested) log.warn("AUTH_DISABLED=1 — every visitor is a teacher. Never use this on a server.");
  return requested;
})();

const config = {
  isProduction,
  authDisabled,

  /** Shared with lynindia.in. Signs the short-lived hand-off ticket. */
  get ssoSecret() {
    return secret("SSO_SHARED_SECRET");
  },
  /** Ours alone. Signs the meeting session cookie. Must differ from ssoSecret. */
  get sessionSecret() {
    return secret("SESSION_SECRET");
  },

  /** Ticket claims we require. A ticket minted for anything else is refused. */
  ssoIssuer: process.env.SSO_ISSUER || "https://lynindia.in",
  ssoAudience: process.env.SSO_AUDIENCE || "https://meet.lynindia.in",

  /**
   * Ticket lifetime. Long enough to survive a redirect on a slow phone,
   * far too short to be useful if one leaks into a log or a Referer header.
   */
  ticketMaxAgeSec: Number(process.env.SSO_TICKET_MAX_AGE_SEC || 60),
  /** Tolerance for clock skew between the two servers. */
  clockToleranceSec: Number(process.env.SSO_CLOCK_TOLERANCE_SEC || 10),

  /** Meeting session lifetime -- one long teaching day. */
  sessionMaxAgeSec: Number(process.env.SESSION_MAX_AGE_SEC || 8 * 60 * 60),
  cookieName: process.env.SESSION_COOKIE_NAME || "lynmeet_sid",
  /**
   * Left unset by default so the cookie is host-only to meet.lynindia.in.
   * Set it to ".lynindia.in" only if the cookie genuinely has to be readable
   * by the parent site -- a wider scope is a wider blast radius.
   */
  cookieDomain: process.env.SESSION_COOKIE_DOMAIN || undefined,

  /** Where to send someone who arrives without a session. */
  loginUrl: process.env.SSO_LOGIN_URL || "https://lynindia.in/sso/authorize",
  /** Post-logout and error landing page on the main site. */
  siteUrl: process.env.SITE_URL || "https://lynindia.in",

  /** Only these may be handed back as post-login redirect targets. */
  allowedRedirectHosts: String(process.env.ALLOWED_REDIRECT_HOSTS || "meet.lynindia.in")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

/** Called at boot so a bad secret fails the deploy, not the first student. */
function validateAtBoot() {
  if (config.authDisabled) return { ok: true, disabled: true };
  const sso = config.ssoSecret;
  const session = config.sessionSecret;
  if (sso === session) {
    throw new Error("SSO_SHARED_SECRET and SESSION_SECRET must be different keys");
  }
  log.info("auth configured", {
    issuer: config.ssoIssuer,
    audience: config.ssoAudience,
    ticketMaxAgeSec: config.ticketMaxAgeSec,
    sessionMaxAgeSec: config.sessionMaxAgeSec,
    cookie: config.cookieName,
  });
  return { ok: true, disabled: false };
}

module.exports = { config, validateAtBoot };
