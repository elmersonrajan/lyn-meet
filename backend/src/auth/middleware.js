/**
 * Request gates.
 *
 * `attach` runs on every request and is silent; the `require*` gates refuse.
 * Kept separate so a public endpoint (/health) can still report who is asking
 * without demanding that anyone be signed in.
 */
const { config } = require("./config");
const session = require("./session");
const { createLogger } = require("../utils/logger");

const log = createLogger("AuthGate");

/** The identity used when AUTH_DISABLED=1 on a developer machine. */
const DEV_IDENTITY = { email: "dev@localhost", role: "teacher", name: "Dev User", dev: true };

/** Populates req.user when a valid session cookie is present. Never rejects. */
function attach(req, _res, next) {
  if (config.authDisabled) {
    req.user = DEV_IDENTITY;
    return next();
  }
  const token = req.cookies?.[config.cookieName];
  req.user = session.verify(token);
  next();
}

/** 401s anyone without a valid session. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({
    ok: false,
    error: "Not signed in",
    // The browser needs somewhere to send them; the SPA reads this.
    loginUrl: config.loginUrl,
  });
}

/** Teacher or coordinator only -- attendance exports, recordings, debug. */
function requireStaff(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Not signed in", loginUrl: config.loginUrl });
  }
  if (req.user.role !== "teacher" && req.user.role !== "coordinator") {
    log.warn("staff endpoint refused", { email: req.user.email, role: req.user.role, path: req.path });
    return res.status(403).json({ ok: false, error: "Staff only" });
  }
  next();
}

module.exports = { attach, requireAuth, requireStaff, DEV_IDENTITY };
