/**
 * Security properties of the SSO bridge.
 *
 * These assert the things that would be silently catastrophic if they broke:
 * a forged ticket accepted, a replayed ticket accepted, a role taken from the
 * client. Run with:  node --test test/
 *
 * No database and no mediasoup worker is needed -- the directory lookup is the
 * only part that talks to MySQL, and it is exercised separately.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const SSO_SECRET = "a".repeat(64);
const SESSION_SECRET = "b".repeat(64);

process.env.SSO_SHARED_SECRET = SSO_SECRET;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.SSO_ISSUER = "https://lynindia.in";
process.env.SSO_AUDIENCE = "https://meet.lynindia.in";
process.env.ALLOWED_REDIRECT_HOSTS = "meet.lynindia.in";

const ticket = require("../src/auth/ticket");
const session = require("../src/auth/session");
const replay = require("../src/auth/replay");
const { safeNext } = require("../src/auth/routes");
const { roleFor } = require("../src/auth/directory");

function mint(overrides = {}, secret = SSO_SECRET) {
  const { claims = {}, ...opts } = overrides;
  return jwt.sign({ name: "Test User", ...claims }, secret, {
    algorithm: "HS256",
    issuer: "https://lynindia.in",
    audience: "https://meet.lynindia.in",
    subject: "student@lynindia.in",
    jwtid: crypto.randomUUID(),
    expiresIn: 60,
    ...opts,
  });
}

test("a well-formed ticket is accepted and yields the subject", () => {
  replay.reset();
  const claim = ticket.verify(mint());
  assert.strictEqual(claim.email, "student@lynindia.in");
});

test("a ticket signed with the wrong secret is refused", () => {
  replay.reset();
  const forged = mint({}, "c".repeat(64));
  assert.throws(() => ticket.verify(forged), (err) => err.reason === "bad-signature");
});

test("a tampered payload is refused", () => {
  replay.reset();
  const good = mint();
  const [header, payload, sig] = good.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  decoded.sub = "attacker@gmail.com";
  const swapped = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  assert.throws(
    () => ticket.verify(`${header}.${swapped}.${sig}`),
    (err) => err.reason === "bad-signature",
  );
});

test("alg:none is refused", () => {
  replay.reset();
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://lynindia.in",
      aud: "https://meet.lynindia.in",
      sub: "attacker@gmail.com",
      jti: "x",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString("base64url");
  assert.throws(() => ticket.verify(`${header}.${payload}.`));
});

test("a ticket for another audience is refused", () => {
  replay.reset();
  assert.throws(
    () => ticket.verify(mint({ audience: "https://someone-else.example" })),
    (err) => err.reason === "bad-signature",
  );
});

test("a ticket from another issuer is refused", () => {
  replay.reset();
  assert.throws(
    () => ticket.verify(mint({ issuer: "https://evil.example" })),
    (err) => err.reason === "bad-signature",
  );
});

test("an expired ticket is refused", () => {
  replay.reset();
  assert.throws(
    () => ticket.verify(mint({ expiresIn: -120 })),
    (err) => err.reason === "expired",
  );
});

test("a ticket with no jti is refused rather than accepted unburnable", () => {
  replay.reset();
  const noJti = jwt.sign({}, SSO_SECRET, {
    algorithm: "HS256",
    issuer: "https://lynindia.in",
    audience: "https://meet.lynindia.in",
    subject: "student@lynindia.in",
    expiresIn: 60,
  });
  assert.throws(() => ticket.verify(noJti), (err) => err.reason === "no-jti");
});

test("a ticket cannot be redeemed twice", () => {
  replay.reset();
  const token = mint();
  ticket.verify(token);
  assert.throws(() => ticket.verify(token), (err) => err.reason === "replayed");
});

test("the session cookie round-trips and carries the resolved role", () => {
  const token = session.issue({ email: "t@lynindia.in", role: "teacher", name: "T" });
  const claims = session.verify(token);
  assert.strictEqual(claims.email, "t@lynindia.in");
  assert.strictEqual(claims.role, "teacher");
});

test("a session cookie signed with the SSO secret is refused", () => {
  // The two keys are separate so neither system can forge the other's
  // credential. A ticket must never be usable as a session.
  const crossSigned = jwt.sign({ email: "x@y.z", role: "teacher" }, SSO_SECRET, {
    algorithm: "HS256",
    issuer: "meet.lynindia.in",
    audience: "meet.lynindia.in",
    expiresIn: 60,
  });
  assert.strictEqual(session.verify(crossSigned), null);
});

test("a tampered session cookie is refused", () => {
  const token = session.issue({ email: "s@lynindia.in", role: "student", name: "S" });
  const [h, p, sig] = token.split(".");
  const decoded = JSON.parse(Buffer.from(p, "base64url").toString());
  decoded.role = "teacher";
  const swapped = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  assert.strictEqual(session.verify(`${h}.${swapped}.${sig}`), null);
});

test("garbage and empty cookies are refused without throwing", () => {
  assert.strictEqual(session.verify(""), null);
  assert.strictEqual(session.verify("not-a-jwt"), null);
  assert.strictEqual(session.verify(undefined), null);
});

test("readCookie picks the right value out of a cookie header", () => {
  const header = "other=1; lynmeet_sid=abc.def.ghi; another=2";
  assert.strictEqual(session.readCookie(header, "lynmeet_sid"), "abc.def.ghi");
  assert.strictEqual(session.readCookie(header, "missing"), null);
  assert.strictEqual(session.readCookie(undefined, "lynmeet_sid"), null);
});

test("safeNext refuses off-site redirect targets", () => {
  assert.strictEqual(safeNext("/?lynmeet=MATH-101"), "/?lynmeet=MATH-101");
  assert.strictEqual(safeNext("https://meet.lynindia.in/x?a=1"), "/x?a=1");
  assert.strictEqual(safeNext("https://evil.example/steal"), "/");
  // Protocol-relative: looks like a path, is actually another host.
  assert.strictEqual(safeNext("//evil.example/steal"), "/");
  assert.strictEqual(safeNext("javascript:alert(1)"), "/");
  assert.strictEqual(safeNext(""), "/");
});

test("role mapping: only T teaches, office types coordinate, rest are students", () => {
  assert.strictEqual(roleFor("T"), "teacher");
  for (const code of ["A", "O", "Q", "M"]) assert.strictEqual(roleFor(code), "coordinator");
  assert.strictEqual(roleFor("S"), "student");
  // Unmapped and unknown codes must not accidentally grant power.
  for (const code of ["C", "E", "V", "I", "U", "G", "Z", "", null]) {
    assert.strictEqual(roleFor(code), "student");
  }
});
