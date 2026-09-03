/**
 * Token hand-off from lynindia.in.
 *
 * The main site writes a row into `AccessToken(EmailID, TokenID)` when someone
 * logs in, then sends them here with that token. This module trades the token
 * for an identity, exactly once.
 *
 * Three deliberate choices:
 *
 * 1. **The token is looked up, never parsed.** It carries no claims we trust;
 *    it is an opaque pointer into a table only the two servers can read. So
 *    there is nothing in it for a client to forge or tamper with.
 *
 * 2. **Single use.** The row is deleted the moment it is redeemed. The table
 *    has no expiry column, so without this a token recovered from browser
 *    history on a shared machine, or from an nginx access log, would work
 *    forever. Burning it on first use bounds the damage to the window between
 *    the redirect and the first page load.
 *
 * 3. **`v_UserforMeet` is not used to decide anything.** That view maps
 *    UserType itself and gets it wrong in places -- its LearningCentres branch
 *    emits 'C', which in the role chart means Co-ordinator, so every Learning
 *    Centre would arrive with the power to mute the room and close the class.
 *    We take only the email from the token and re-derive role from `v_Users`
 *    through directory.lookup(), where the mapping is in one tested place.
 */
const { query } = require("../db/pool");
const directory = require("./directory");
const { createLogger } = require("../utils/logger");

const log = createLogger("Handoff");

class HandoffError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

/**
 * Tokens are opaque, but they still arrive from a browser, so bound the input
 * before it reaches a query. The platform currently stores Google access
 * tokens (~340 chars); the column allows 1000.
 */
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 1000;

/**
 * The characters a token can actually contain: base64url plus the separators
 * Google uses in `ya29.` values.
 */
const TOKEN_CHARS = /[^A-Za-z0-9._~+/-]/;

/**
 * Trims a token to its first invalid character.
 *
 * A malformed link on the platform side arrives as
 * `...&TockenID=ya29.<token> target=` -- a missing closing quote in the anchor
 * tag swallows the `target` attribute into the href, so the browser hands us
 * the token with ` target=` stuck on the end and the lookup misses a row that
 * is sitting right there.
 *
 * Cutting at the character class rather than matching that exact suffix means
 * a `rel=`, a stray quote, or a fixed-then-differently-broken template all
 * behave the same way. This only ever *shortens* the input and the lookup
 * stays an exact match, so a partial token still authenticates nobody --
 * prefix matching here would be a real hole and is deliberately not done.
 */
function clean(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new HandoffError("missing", "No sign-in token supplied");

  const token = value.split(TOKEN_CHARS)[0];
  if (token.length !== value.length) {
    // Logged rather than silently accepted: the link that produced this is
    // broken at the source, and papering over it without a trace means nobody
    // ever fixes the template.
    log.warn("trimmed junk from a sign-in token — the link template is malformed", {
      received: value.length,
      kept: token.length,
    });
  }

  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new HandoffError("malformed", "This sign-in link is not valid");
  }
  return token;
}

/**
 * Redeems a token and returns the authenticated identity.
 *
 * @param {string} raw the TockenID from the hand-off
 * @returns {Promise<{email, name, role, userTypes}>}
 * @throws {HandoffError} unknown token, already used, or not an authorised user
 */
async function redeem(raw) {
  const token = clean(raw);

  // Read from AccessToken rather than v_UserforMeet: the email is the only
  // thing wanted, this is one indexless scan of a small table instead of a
  // six-way union, and it cannot inherit a mapping bug from the view.
  const rows = await query(`SELECT EmailID FROM AccessToken WHERE TokenID = ? LIMIT 1`, [token]);
  if (!rows.length) {
    // Indistinguishable from "already redeemed", and deliberately so: the
    // caller is told the link is stale either way.
    log.warn("hand-off token not found or already used");
    throw new HandoffError("unknown-token", "This sign-in link has expired or was already used");
  }

  const email = String(rows[0].EmailID || "").trim().toLowerCase();

  const identity = await directory.lookup(email);

  // Burn the token whether or not the person turned out to be authorised. A
  // token that failed the directory check must not be left lying around for
  // another attempt, and a row for a removed user is dead weight.
  await consume(token, email);

  if (!identity) {
    log.warn("token valid but user is not authorised", { email });
    throw new HandoffError("not-authorised", "Your account is not authorised to join meetings");
  }

  log.action("hand-off redeemed", {
    email: identity.email,
    role: identity.role,
    userTypes: identity.userTypes,
  });
  return identity;
}

/**
 * Deletes the redeemed row.
 *
 * A failure here is logged but not fatal: the user has already been
 * identified, and refusing the sign-in because cleanup failed would turn a
 * missing DELETE grant into an outage. It does mean the token stays live, so
 * it is logged at error level to be noticed.
 */
async function consume(token, email) {
  try {
    await query(`DELETE FROM AccessToken WHERE TokenID = ?`, [token]);
  } catch (err) {
    log.error(
      "could not delete redeemed token — it remains valid until overwritten. " +
        "Grant DELETE on LYNDev.AccessToken to the meeting server's account.",
      { email, detail: err.message },
    );
  }
}

module.exports = { redeem, HandoffError, MIN_TOKEN_LENGTH, MAX_TOKEN_LENGTH };
