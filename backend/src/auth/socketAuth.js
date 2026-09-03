/**
 * Socket.IO handshake gate.
 *
 * HTTP endpoints are not the way into a meeting -- the socket is. Without this
 * an attacker could ignore the REST API entirely, open a websocket and emit
 * `join-room` with any name and role they liked, which is exactly what the
 * old lobby let anyone do.
 *
 * The cookie is re-checked against the database here rather than trusted on
 * its own. A session minted this morning for a teacher who was removed at
 * lunchtime must not still open a classroom this afternoon, and one lookup per
 * connection (tens per class, not thousands) is a cheap way to guarantee it.
 */
const { config } = require("./config");
const session = require("./session");
const directory = require("./directory");
const { DEV_IDENTITY } = require("./middleware");
const { createLogger } = require("../utils/logger");

const log = createLogger("SocketAuth");

/**
 * Socket.IO reports a middleware error to the client as `connect_error`. The
 * `data` payload survives the trip, so the SPA can tell "sign in again" apart
 * from "you are not allowed".
 */
function refuse(message, code) {
  const err = new Error(message);
  err.data = { code, loginUrl: config.loginUrl };
  return err;
}

function install(io) {
  io.use(async (socket, next) => {
    try {
      if (config.authDisabled) {
        socket.data.auth = { ...DEV_IDENTITY };
        return next();
      }

      const raw = session.readCookie(socket.handshake.headers?.cookie, config.cookieName);
      const claims = session.verify(raw);
      if (!claims) {
        return next(refuse("Your session has expired. Please sign in again.", "NO_SESSION"));
      }

      const identity = await directory.lookup(claims.email);
      if (!identity) {
        log.warn("session valid but user no longer authorised", { email: claims.email });
        return next(refuse("Your account is not authorised to join meetings.", "NOT_AUTHORISED"));
      }

      // Role comes from this lookup, never from the cookie and never from the
      // client. A stale cookie cannot outrank a demotion in the database.
      socket.data.auth = {
        email: identity.email,
        name: identity.name,
        role: identity.role,
        userTypes: identity.userTypes,
      };
      log.info("socket authenticated", { email: identity.email, role: identity.role });
      next();
    } catch (err) {
      log.error("handshake auth failed", err);
      next(refuse("Sign-in check failed. Please try again.", "AUTH_ERROR"));
    }
  });
}

module.exports = { install };
