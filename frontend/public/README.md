# Static assets

Anything in this folder is served from the site root, unchanged. A file here at
`public/lyn-logo-cross.png` is reachable at `/lyn-logo-cross.png`, which is how
`index.html` and the login screen refer to it.

## The logo

Put **`lyn-logo-cross.png`** in this folder, spelled exactly that way — the
reference is case-sensitive once it is served from Linux, so `LYN_Logo_Cross.PNG`
will work on Windows and then quietly 404 in production.

It is used in two places:

- the browser tab icon (favicon), and the icon when the site is saved to a phone's
  home screen
- the login screen, above the sign-in form

One square PNG covers both. 512×512 is the size held here: it is scaled down for
the tab and shown at roughly 76px on the login screen, so anything below about
256px looks soft on a high-density display, and anything much above 512 is
weight every student pays for on every page load with nothing to show for it.
The artwork that arrived was 1155×1155 and 922 KB; it is kept at 512×512, which
is a fifth of the size and identical at the sizes actually used.

The mark does not need a transparent background — the login screen sets it on a
white tile, the way an app icon sits on a home screen, so artwork on its own
white ground looks deliberate rather than like a pale rectangle on the navy.
Do not try to make the white transparent: the figures inside this logo are
themselves white, and removing white everywhere would erase them.

Nothing needs rebuilding for a change to be picked up in development. A deployed
site needs `npm run build` as usual, and browsers cache favicons hard — use a
private window to check a change.

If the file is missing the login screen simply omits the logo rather than showing
a broken image, so the page still works while you are getting the artwork ready.
