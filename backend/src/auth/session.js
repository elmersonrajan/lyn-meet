/**
 * The meeting server's own session cookie.
 *
 * The hand-off ticket lives for a minute; this is what carries the user
 * through a two-hour class. It is signed with a key that lynindia.in does not
 * hold, so the two systems cannot forge each other's credentials, and it is
 * httpOnly so no script in the page -- ours or injected -- can read it.
 *
 * Identity is re-checked against the database when the session is minted. The
 * cookie is a cache of that decision, bounded by SESSION_MAX_AGE_SEC.
 */
const jwt = require("jsonwebtoken");
const { config } = require("./config");
const { createLogger } = require("../utils/logger");

const log = createLogger("Session");

const SESSION_ISSUER = "meet.lynindia.in";

/**
 * @param {{email: string, role: string, name: string}} identity resolved from the database
 */
function issue(identity) {
  return jwt.sign(
    {
      email: identity.email,
      role: identity.role,
      name: identity.name,
    },
    config.sessionSecret,
    {
      algorithm: "HS256",
      issuer: SESSION_ISSUER,
      audience: SESSION_ISSUER,
      subject: identity.email,
      expiresIn: config.sessionMaxAgeSec,
    },
  );
}

/** @returns {{email, role, name, expiresAt}|null} */
function verify(raw) {
  const token = String(raw || "").trim();
  if (!token) return null;
  try {
    const claims = jwt.verify(token, config.sessionSecret, {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_ISSUER,
      clockTolerance: config.clockToleranceSec,
    });
    return {
      email: String(claims.email || claims.sub || "").toLowerCase(),
      role: String(claims.role || "student"),
      name: String(claims.name || ""),
      expiresAt: Number(claims.exp) * 1000,
    };
  } catch (err) {
    // Expiry is routine, not an incident. Anything else is worth seeing.
    if (err.name !== "TokenExpiredError") log.warn("session cookie rejected", err.message);
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Lax, not Strict: the user arrives by a top-level redirect from
    // lynindia.in, and Strict would withhold the cookie on that first
    // navigation and bounce them into a login loop.
    sameSite: "lax",
    secure: config.isProduction,
    domain: config.cookieDomain,
    path: "/",
    maxAge: config.sessionMaxAgeSec * 1000,
  };
}

function setCookie(res, token) {
  res.cookie(config.cookieName, token, cookieOptions());
}

function clearCookie(res) {
  res.clearCookie(config.cookieName, { ...cookieOptions(), maxAge: undefined });
}

/**
 * Minimal cookie-header parser.
 *
 * Socket.IO hands over the raw header rather than an Express request, and this
 * only ever needs to find one name, so a dependency is not worth it.
 */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

module.exports = { issue, verify, setCookie, clearCookie, readCookie, cookieOptions };
