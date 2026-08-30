# Static assets

Anything in this folder is served from the site root, unchanged. A file here at
`public/lyn_logo_cross.png` is reachable at `/lyn_logo_cross.png`, which is how
`index.html` and the login screen refer to it.

## The logo

Put **`lyn_logo_cross.png`** in this folder, spelled exactly that way — the
reference is case-sensitive once it is served from Linux, so `LYN_Logo_Cross.PNG`
will work on Windows and then quietly 404 in production.

It is used in two places:

- the browser tab icon (favicon), and the icon when the site is saved to a phone's
  home screen
- the login screen, above the sign-in form

One square PNG covers both. Around 512×512 with a transparent background is
ideal: it is scaled down for the tab and displayed at roughly 72px on the login
screen, so anything smaller than about 256px will look soft on a high-density
display.

Nothing needs rebuilding for a change to be picked up in development. A deployed
site needs `npm run build` as usual, and browsers cache favicons hard — use a
private window to check a change.

If the file is missing the login screen simply omits the logo rather than showing
a broken image, so the page still works while you are getting the artwork ready.
