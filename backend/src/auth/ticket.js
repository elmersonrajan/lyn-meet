/**
 * Verification of the one-time hand-off ticket issued by lynindia.in.
 *
 * The ticket answers exactly one question -- "which signed-in account is this
 * browser?" -- and nothing more. Everything that grants power (role, display
 * name, whether the account still exists) is looked up here from the database
 * afterwards, so a bug or a compromise on the issuing side cannot mint a
 * teacher out of thin air.
 *
 * Rejected: wrong signature, wrong algorithm, wrong issuer, wrong audience,
 * expired, not-yet-valid, missing subject, missing id, or already redeemed.
 */
const jwt = require("jsonwebtoken");
const { config } = require("./config");
const replay = require("./replay");
const { createLogger } = require("../utils/logger");

const log = createLogger("Ticket");

class TicketError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

/**
 * @param {string} raw the `ticket` query parameter
 * @returns {{email: string, jti: string, issuedAt: number, expiresAt: number, hint: object}}
 * @throws {TicketError}
 */
function verify(raw) {
  const token = String(raw || "").trim();
  if (!token) throw new TicketError("missing", "No ticket supplied");

  let claims;
  try {
    claims = jwt.verify(token, config.ssoSecret, {
      // Pinned. Without this an attacker could present alg:none, or trick the
      // library into treating our HMAC secret as an RSA public key.
      algorithms: ["HS256"],
      issuer: config.ssoIssuer,
      audience: config.ssoAudience,
      clockTolerance: config.clockToleranceSec,
      // Belt and braces: even if the issuer sets a generous exp, we refuse
      // anything minted longer ago than the configured ticket lifetime.
      maxAge: `${config.ticketMaxAgeSec}s`,
    });
  } catch (err) {
    const reason =
      err.name === "TokenExpiredError"
        ? "expired"
        : err.name === "NotBeforeError"
          ? "not-yet-valid"
          : "bad-signature";
    log.warn("ticket rejected", { reason, detail: err.message });
    throw new TicketError(reason, "This sign-in link is no longer valid");
  }

  const email = String(claims.sub || claims.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new TicketError("no-subject", "The sign-in link did not identify a user");
  }

  const jti = String(claims.jti || "");
  if (!jti) {
    // Without an id the ticket cannot be burned after use, which would make it
    // replayable for its whole lifetime. Refuse rather than degrade quietly.
    throw new TicketError("no-jti", "The sign-in link is missing its one-time id");
  }

  const expiresAtMs = Number(claims.exp) * 1000;
  if (!replay.consume(jti, expiresAtMs)) {
    throw new TicketError("replayed", "This sign-in link has already been used");
  }

  return {
    email,
    jti,
    issuedAt: Number(claims.iat) * 1000,
    expiresAt: expiresAtMs,
    // Advisory only. Logged for support, never used to decide anything.
    hint: { name: claims.name, userType: claims.utype },
  };
}

module.exports = { verify, TicketError };
