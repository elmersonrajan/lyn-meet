The recording is made on the server again, the way Meet and Zoom make theirs. Nothing is captured from the teacher's browser.

## What a recording is now

The board, full-frame, with the teacher's camera in the corner and every microphone in the class mixed underneath.

"The board" means all of it, which is the part that was missing:

- the strokes, drawn from the stroke list as always;
- **the page under them** — a pasted picture, or the page of a PDF or Word document the class is on;
- **the zoom** — if the teacher magnified a paragraph, the recording is magnified into that paragraph too, strokes and page together.

The server already had the picture and the document on disk, because that is where every browser in the room fetches them from. It simply had no way to turn either into pixels, and that gap is the only reason a recording ever needed the teacher's screen. `recording/boardPage.js` closes it: ffmpeg — already required for recording at all — decodes an image, and poppler renders one page of a PDF. Both results are cached per page, so a teacher talking over one diagram for ten minutes costs one decode.

Pressing record no longer opens the browser's screen picker. That prompt was a thing to get wrong in front of a class, and declining it silently produced a worse recording.

## The audio

Everything the server can hear, which is everything except one thing worth naming:

- the teacher's microphone;
- every student and coordinator who unmutes, each captured from the moment they do and delayed back into place against the same server clock;
- the sound of a shared screen or a shared clip.

**A YouTube video played to the class is not in the recording.** It cannot be: every browser fetches that video from YouTube directly, so no copy of its sound ever reaches this server. The only way to record it is to capture the teacher's tab, which is the screen recording this change removes. The picture has the same gap and always did.

## The database

`YouTubeRecords` turned out to be fine. `npm run check:recording-db` on the dev server shows VideoIDs 4136–4148 written by this server, and every render that produced a file has its row. The reports of "not updating" were reports of something else.

What is actually failing is the **render**, and the report names it:

```
MISSING   meeting=10233 status=failed file=-
          render failed: nothing was captured
```

No file, so nothing to publish. That is correct behaviour on a wrong input.

**The cause, and the part that matters now.** `renderJob` gave up when the RTP capture file was under 2 KB — and that file holds only the microphone, the camera and a shared screen. Board frames are not in it. So a lesson taught on the board with the camera off and the mic muted was thrown away with "nothing was captured", while every frame of it sat on disk. Defensible when the board was an overlay; a hole now that the board is the picture.

The capture is now optional. `buildComposeArgs` builds its input list from what exists, so a board-only class composes from the board plus the mixed voices, and the render only gives up when there is genuinely no picture and no sound. Every stream index in the filter graph moved with it, which is what the new `ffmpegArgs` tests pin down — an off-by-one there produces a valid-looking command that references a stream which is not there.

The schema-fitted INSERT stays. The table is only the three columns, so it changes nothing today, but it is the right shape and it costs one cached `SHOW COLUMNS`.

**Still worth having**, and both were written before the above was known:

- the write is retried every fifteen minutes (`RECORDING_SWEEP_MINUTES`) instead of happening once, so a database that is briefly unreachable no longer loses the link permanently;
- publishing subscribes *before* the queue resumes jobs at boot, which it did not;
- `npm run check:recording-db`, and `GET /api/recordings/publish-report`, which is how the above was diagnosed in one command rather than inferred from a log.

A caution learnt the hard way here: run it from the directory pm2 actually uses (`pm2 describe lyn-backend | grep -i "exec cwd"`). Run from a different clone of the repo it reports a missing `.env` and zero recordings, which reads exactly like a real fault.

## What was removed

The `stage` producer, end to end — the tab capture, its encodings, the branch in `consumeProducer` that skipped it, the SDP stream, the compose layout that used it as the base, and its fallback ladder in the render. A student was never able to publish one; that guard goes with it.

This also settles the `stage-audio` work in flight: it existed to give the tab capture its sound, and there is no tab capture to give sound to. The `screen-audio` path it was modelled on is untouched and still records a shared clip.

## Prerequisite

Word documents already needed LibreOffice. PDF **pages in recordings** need poppler:

```bash
sudo dnf install -y poppler-utils   # apt on Debian/Ubuntu
```

Without it a class spent on a document still records — the strokes, the camera and the audio — and the job lists the page in `dropped` rather than pretending it was there. The log says so at boot, once.

## Verified

`npm test` — 69 passing, 27 of them new: the view transform against its own inverse, strokes magnified with the page including their thickness, a stroke the zoom pushes off the edge staying off it, a page composited under strokes, a page key that does not change when a picture and a document are both set, the INSERT builder against eight shapes of table, and the compose command with and without an RTP capture — including that a board-only class refers to no stream that is not there. `npm run check` (39 files) and `vite build` pass.

The decode path itself needs a box with ffmpeg — this one has none. What was checked here is that it fails the way it should: a missing decoder is one attempt, cached as failed, logged once, and the recording carries on without the page instead of throwing every second for an hour.

**Worth checking on the dev server**, in this order:

1. `npm run check:recording-db` — before recording anything, so the configuration is known good.
2. Record a minute with something written on the board. Expect board + camera + voices.
3. Record a minute with the camera off and the mic muted, writing on the board. This is the case that used to fail outright — expect a board-only video, not `nothing was captured`.
4. Paste a picture, write over it, record. Expect the picture under the writing.
5. Open a PDF, move to page 3, zoom in, record. Expect page 3, zoomed, with the annotations in the right places.
6. `npm run check:recording-db` again — every line should read `published`.
