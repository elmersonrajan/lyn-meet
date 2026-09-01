# SSO bridge: lynindia.in → meet.lynindia.in

The meeting server has no user database, no password field and no Google
sign-in. The only way in is a short-lived ticket signed by lynindia.in, and the
only thing that ticket is trusted to say is *which email address* is signed in.
Everything that grants power is looked up here, in the platform's own database.

## The flow

```
  browser                  lynindia.in                      meet.lynindia.in
     |                          |                                  |
     |  GET /?lynmeet=MATH-101 ------------------------------------>|
     |                          |            no session cookie      |
     |<-------------------------------------- 302 /auth/login ------|
     |                          |                                  |
     |-- GET /sso/authorize?redirect=... ->|                        |
     |                          |                                  |
     |                    checks ITS OWN session                    |
     |                    (not signed in -> normal login page)      |
     |                          |                                  |
     |                    mints ticket: HS256, 60s, one-time        |
     |                          |                                  |
     |<-- 302 /auth/sso/callback?ticket=eyJ... --|                  |
     |                          |                                  |
     |-- GET /auth/sso/callback?ticket=... ------------------------>|
     |                          |                                  |
     |                          |   verify sig / iss / aud / exp    |
     |                          |   burn jti (single use)           |
     |                          |   SELECT ... FROM v_Users  <-- the real gate
     |                          |   Set-Cookie: lynmeet_sid (httpOnly)
     |<------------------------------------- 302 /?lynmeet=MATH-101-|
     |                          |                                  |
     |-- socket.io handshake (cookie) ---------------------------->|
     |                          |   verify cookie + re-check v_Users|
     |                          |   role assigned from DB, not client
```

Two independent checks have to pass: the ticket proves *which account*, the
database decides *whether* and *as what*. A perfect ticket for someone who was
removed from the organisation this morning gets a 403.

## What the main site has to implement

One endpoint. It is the only change on the lynindia.in side.

### `GET /sso/authorize?redirect=<url>`

1. Check the site's **existing** session — whatever mechanism it already uses.
   If not signed in, run the normal login and come back here afterwards.
2. Validate `redirect`: it must be on `meet.lynindia.in`. Reject anything else,
   or you have built an open redirector.
3. Mint a ticket and 302 to
   `https://meet.lynindia.in/auth/sso/callback?ticket=<jwt>&next=<path>`.

### Ticket claims

| Claim   | Value                          | Notes |
|---------|--------------------------------|-------|
| `iss`   | `https://lynindia.in`          | must match `SSO_ISSUER` |
| `aud`   | `https://meet.lynindia.in`     | must match `SSO_AUDIENCE` |
| `sub`   | the user's email               | lower-cased; the only claim that matters |
| `jti`   | a fresh UUID                   | **required** — this is what makes it one-time |
| `iat`   | now                            | |
| `exp`   | now + 60s                      | keep it short |
| `name`  | display name                   | optional, advisory only |
| `utype` | platform UserType letter       | optional, advisory only |

`name` and `utype` are logged for support and then **ignored**. The meeting
server re-derives both from the database. This is deliberate: it means a bug in
the issuer cannot promote anyone.

Algorithm is pinned to **HS256** with `SSO_SHARED_SECRET`. Do not send `alg:
none`; it is rejected.

### Reference implementation (Node)

```js
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

app.get("/sso/authorize", (req, res) => {
  const user = req.session?.user;               // your existing session
  if (!user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);

  const target = new URL(req.query.redirect || "https://meet.lynindia.in/");
  if (target.host !== "meet.lynindia.in") return res.status(400).send("Bad redirect");

  const ticket = jwt.sign(
    { name: user.fullName, utype: user.userType },
    process.env.SSO_SHARED_SECRET,
    {
      algorithm: "HS256",
      issuer: "https://lynindia.in",
      audience: "https://meet.lynindia.in",
      subject: String(user.email).trim().toLowerCase(),
      jwtid: crypto.randomUUID(),
      expiresIn: 60,
    },
  );

  const cb = new URL("https://meet.lynindia.in/auth/sso/callback");
  cb.searchParams.set("ticket", ticket);
  cb.searchParams.set("next", target.pathname + target.search);
  res.redirect(302, cb.toString());
});
```

### Reference implementation (PHP)

```php
<?php
use Firebase\JWT\JWT;                            // composer require firebase/php-jwt

session_start();
if (empty($_SESSION['email'])) {
    header('Location: /login.php?next=' . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$redirect = $_GET['redirect'] ?? 'https://meet.lynindia.in/';
if (parse_url($redirect, PHP_URL_HOST) !== 'meet.lynindia.in') {
    http_response_code(400);
    exit('Bad redirect');
}

$now = time();
$ticket = JWT::encode([
    'iss'   => 'https://lynindia.in',
    'aud'   => 'https://meet.lynindia.in',
    'sub'   => strtolower(trim($_SESSION['email'])),
    'jti'   => bin2hex(random_bytes(16)),
    'iat'   => $now,
    'exp'   => $now + 60,
    'name'  => $_SESSION['fullname'] ?? null,
    'utype' => $_SESSION['usertype'] ?? null,
], getenv('SSO_SHARED_SECRET'), 'HS256');

$next = parse_url($redirect, PHP_URL_PATH) ?: '/';
header('Location: https://meet.lynindia.in/auth/sso/callback?ticket=' . urlencode($ticket)
     . '&next=' . urlencode($next));
```

## Why each attack fails

| Attack | What stops it |
|---|---|
| **Forged ticket** | HS256 over a 32-byte secret the attacker does not have. `algorithms: ["HS256"]` is pinned, so `alg:none` and RS/HS confusion are both refused. |
| **Email spoofing** | `sub` is inside the signature. Changing it invalidates the ticket. |
| **Role escalation** | Role is never read from the ticket or the client. It comes from `v_Users` on every socket connection. A client that sends `role: "teacher"` is logged and ignored. |
| **Replay of a captured ticket** | `jti` is burned on first redemption (`auth/replay.js`). A second attempt is refused even inside the 60-second window. |
| **Expired ticket reuse** | `exp` plus an independent `maxAge` check. Clock skew tolerance is 10s. |
| **Random Google account** | The meeting server never talks to Google. Sign-in is only ever a ticket from lynindia.in, and the email still has to exist in `v_Users`. |
| **Direct access to meet.lynindia.in** | No session cookie → `/auth/me` 401s, the SPA redirects to login, and the socket handshake is refused with `NO_SESSION`. |
| **Cookie theft via XSS** | Cookie is `httpOnly`; no script can read it. `Secure` in production, `SameSite=Lax`. |
| **Cookie forgery** | Signed with `SESSION_SECRET`, which lynindia.in does not hold. |
| **Revoked user with a live cookie** | `v_Users` is re-checked on every socket handshake, so access dies at the next connection rather than at cookie expiry. |
| **Open redirect via `next`** | `safeNext()` allows only bare paths and hosts in `ALLOWED_REDIRECT_HOSTS`. |
| **Teacher hijack during reconnect** | Reconnecting into an existing teacher peer requires the same email. |

## Role mapping

From `UserType` in `v_Users` (see `backend/src/auth/directory.js`):

| UserType | Meaning | Meeting role |
|---|---|---|
| `T` | Teacher | `teacher` |
| `A` | Administrator | `coordinator` |
| `O` | Online Admins | `coordinator` |
| `Q` | Academic Coordinators | `coordinator` |
| `M` | Management | `coordinator` |
| `S` | Student | `student` |
| `C` `E` `V` `I` `U` `G` | Centre, Mentors, eValuation, IT, Consultant, General | `student` |

Unknown codes fall through to `student` — members of the organisation get in
with the fewest powers rather than being locked out by a code nobody mapped.

A person appearing under more than one type (a teacher who is also a class
admin) gets the strongest role, not whichever row the database returned first.

## Operational notes

- **Grant the DB account `SELECT` only.** It needs `v_Users`, `Teachers`,
  `ClassAdmins`, `Students`. It never writes.
- **The replay store is per-process.** Correct for the single backend running
  today. If this is ever scaled behind a load balancer, move `auth/replay.js`
  to Redis or an `SsoTicketUsed(jti, ExpiresAt)` table, or a ticket redeemed on
  instance A stays redeemable once on instance B.
- **`/health` is public** and reports `directoryOk`, so a broken database link
  is visible before a class starts rather than when 40 students cannot join.
- **`AUTH_DISABLED=1`** exists for laptop development with no database. It is
  ignored when `NODE_ENV=production` and logs an error if attempted.
- **Both servers need roughly correct clocks.** Skew beyond 10 seconds will
  start rejecting valid tickets; run NTP on both.
