/**
 * Lets a hand-off token open a recording, not just a session cookie.
 *
 * A recording link is followed from the platform, often days after the class,
 * often by someone who has never opened LYN MEET in that browser. They have no
 * session cookie, so the file answered "Not signed in" and the link was useless
 * to exactly the person it was written for.
 *
 * The platform already has a way of saying who somebody is: the same
 * `AccessToken` row that gets them into a live class. This accepts it here too.
 * Nothing is loosened -- a token is still a single-use row the platform wrote,
 * still redeemed through the same code, and a request carrying no token and no
 * cookie is refused exactly as before.
 *
 * Redeeming issues the session cookie, so the token is spent once and the rest
 * of the video -- every range request a player makes while somebody scrubs --
 * is carried by the cookie. A token in a URL is also in browser history and in
 * any proxy log along the way, which is the other reason not to want one on
 * every request.
 */

const handoff = require("./handoff");
const session = require("./session");
const { createLogger } = require("../utils/logger");

const log = createLogger("RecordingAccess");

/** The platform spells it "TockenID"; the obvious spelling is accepted too. */
function tokenFrom(req) {
  return req.query?.TockenID || req.query?.TokenID || req.query?.tockenid || null;
}

/**
 * Express middleware. Always calls next(): this grants access, it never denies
 * it -- whatever gate follows decides that, so there is one place refusals are
 * written rather than two that have to agree.
 */
async function allowHandoffToken(req, res, next) {
  try {
    if (req.user) return next();
    const token = tokenFrom(req);
    if (!token) return next();

    const identity = await handoff.redeem(token);
    session.setCookie(res, session.issue(identity));
    // So the gate below sees them on this request, not just the next one.
    req.user = identity;
    log.info("a recording was opened with a hand-off token", { email: identity.email });
  } catch (err) {
    // A spent or invalid token is not an error here, it is simply not a way in.
    // requireAuth answers with the login URL, which is what the visitor needs.
    log.warn("a recording token was not accepted", err.message);
  }
  return next();
}

module.exports = { allowHandoffToken, tokenFrom };
