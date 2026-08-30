# well-known

Served at `https://meet.lynindia.in/.well-known/` by the backend, ahead of the
SPA's catch-all route. Without that ordering the SPA answers these paths with
`index.html` and both platforms silently fail their check, sending every shared
link to a browser instead of the app.

## assetlinks.json

Android's proof that this domain agreed to hand its links to the app. Android
fetches it **on install** and caches the result, so after changing it the app
has to be uninstalled and reinstalled — a running app will not notice.

The fingerprint listed is the **debug** keystore, which is what
`flutter run` and `flutter build apk` produce today. `android/app/build.gradle.kts`
in the app repo still signs release builds with the debug key too, so this one
entry covers both for now.

Add the real one before shipping to Play. Play App Signing **re-signs the
upload**, so the fingerprint that matters is the one Play shows you, not your
upload keystore's:

> Play Console → Release → Setup → App signing → *SHA-256 certificate fingerprint*

Both can be listed at once — a device matches if any entry matches. Add it as a
second string in `sha256_cert_fingerprints`; do not replace the debug one, or
test builds stop verifying. Every entry must be a real fingerprint: a
placeholder string invalidates the statement.

## apple-app-site-association

Not here yet, because it needs the 10-character Team ID from the Apple
Developer account and a knowingly-invalid file is no better than a missing one.
The template is in the app repo at `deploy/apple-app-site-association` — fill in
`TEAMID.com.el.lynmeet`, drop it in this directory, and it is served with no
further change. It must have **no** `.json` extension; that is the name Apple
looks for.

## Checking it

```bash
curl -i https://meet.lynindia.in/.well-known/assetlinks.json
```

`200` and `content-type: application/json`, not HTML.

Then Google's verifier, which reports exactly what Android will conclude:

```bash
curl "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://meet.lynindia.in&relation=delegate_permission/common.handle_all_urls"
```

On a device with the app installed:

```bash
adb shell pm get-app-links com.el.lynmeet
```

`verified` is what you want. `legacy_failure` or `1024` means the fetch failed —
usually the SPA still answering, or a redirect. Neither verifier follows one.
