The camera is now sent as three sizes at once, and each student is given the one their connection can actually carry. This is what Meet and Zoom do, and it is the only way one class can serve a room where one student is on fibre and another is on a phone in a bus.

## The problem with one size

The teacher published a single 640×360 stream capped at 300 kbps. That number was chosen to protect students on poor lines — and it worked — but it is the *only* number, so everyone lives with it:

- a student on a good connection gets 360p in a tile that could show more;
- a student on a bad one still gets 360p, and if they cannot carry it they get a frozen tile and no explanation;
- **the recording is made from that same 640×360 stream** and then scaled up to 720p for the file. That is why recordings look soft, and no setting could fix it without making the live class worse for everybody.

## The ladder

The teacher's browser now sends three encodings of the same camera:

| rung | size | bitrate | who gets it |
|---|---|---|---|
| 0 | 320×180 | ~150 kbps | a bad phone line |
| 1 | 640×360 | ~500 kbps | the ordinary case |
| 2 | 1280×720 | ~1500 kbps | a good connection, **and the recording** |

mediasoup moves each student up and down that ladder on its own, from its own per-consumer bandwidth estimate. Nothing in this change decides it per student — the ladder simply has to exist for the switching to be possible. `L1T3` adds three frame-rate steps within each rung, so a struggling student loses smoothness before losing half the resolution.

The capture is 1280×720 because every lower rung is scaled down from it. Capturing at 640 and offering a 1280 rung would send 640 stretched, which is worse than not offering it — there's a test pinning that.

**What it costs:** the teacher's uplink now carries roughly the sum, about 2.2 Mbps at full tilt, against 300 kbps before. That is the real price of a sharp recording and a sharp picture for students who can receive one. Their browser drops the upper rungs by itself when their own connection cannot keep up, and `CAM_HIGH_BITRATE` is the first dial to turn if teacher uplinks are the constraint. `CAM_SIMULCAST=0` restores the old single-stream behaviour completely.

## Recordings at full resolution

The recorder consumes over a plain transport, which has no congestion control — so mediasoup has nothing to estimate for it and leaves it on the bottom rung. Left alone, the new ladder would have made recordings *worse*: an hour of class at 320×180.

So the recording consumer asks for the top rung explicitly (`setPreferredLayers`). Students are unaffected — each of their consumers is estimated separately, and the recorder is not part of that.

## The other half of "the camera looks bad in the recording"

Pinning the recorder to the top rung fixes the *source*. It does not fix what the compose step then does with it, and that turned out to be most of the problem:

- **The camera inset was a sixth of the width — 214×120 pixels** in a 720p file. A perfect 720p source drawn at 214 wide is still a face too small to read an expression on. It is now a quarter, 320×180, which leaves three quarters of the frame for the board. `RECORDING_PIP_FRACTION`, or `RECORDING_PIP_WIDTH` to override outright — a lecture wants the teacher bigger, a worked example wants the board bigger.
- **The downscale used ffmpeg's default scaler.** 1280 to 320 is a 4× reduction, and bilinear turns fine detail to mush at that ratio. Now `flags=lanczos`, which costs a little CPU on a picture that small and nothing else.
- **`-crf` and `-preset` are now configurable.** Defaults unchanged (23 / veryfast) because render time on a box also running the SFU is real, but the board is flat colour and compresses to nothing — the camera inset is the only detailed part of the frame, so crf 21 is where a sharper face actually comes from if you want it.

## When even the smallest rung is too much

This is the case the automatic switching does not cover. mediasoup simply sends nothing, and the student sits watching a frozen tile with no idea whether the class is still running, while their connection goes on being spent trying.

Now: after their consumer has reported no layers for twelve seconds, the server pauses their video and tells them why. Audio continues — it is the part of a lesson that cannot be done without. Forty-five seconds later it offers the picture back to see whether the line recovered.

Two things this deliberately gets right:

- **A paused producer is not a bad connection.** The teacher turning their camera off also produces "no layers". Without that distinction every student in the room would be told their internet had failed at the same moment. There is a test for it.
- **A new consumer inherits the mode.** The teacher toggling their camera, or reconnecting, creates fresh consumers — and a student on a failing line would otherwise be handed the full picture again at the worst possible moment.

## The student's own say

A quiet control, bottom-left, that appears **only** when the picture is not simply working:

- **Automatic** — the default, and right almost always
- **Save data** — pins the bottom rung, for a student paying for their own data
- **Audio only** — no video at all

Choosing cancels whatever the server decided, so someone dropped to audio can ask for the picture back immediately instead of waiting out the retry. It is per student and needs no permission: their connection, their choice.

## Configuration

Everything is in `.env` and takes effect on restart — the profile is handed to each browser at join time, so none of it needs a frontend rebuild:

```
CAM_WIDTH=1280  CAM_HEIGHT=720  CAM_FPS=24
CAM_LOW_BITRATE=150000  CAM_MID_BITRATE=500000  CAM_HIGH_BITRATE=1500000
CAM_SIMULCAST=1
MAX_INCOMING_BITRATE=3800000          # raised: must fit the ladder + a screen share
LOW_BANDWIDTH_AUDIO_AFTER_MS=12000    # 0 switches the automatic drop off
LOW_BANDWIDTH_RETRY_MS=45000
# RECORDING_SPATIAL_LAYER=2           # defaults to the top rung
```

A screen share is untouched: still a single stream at its own resolution, because text has to stay legible and there is no smaller version of a spreadsheet worth sending.

## Verified

`npm test` — 93 passing, 24 new. The ones worth naming, because they cover the failure modes that are invisible until a class is running:

- the ladder is ordered small-to-large (reversed, the "top" rung is the *smallest* picture and the recording is sharpest at 320 wide);
- the capture matches the top rung;
- a mode string from a client is never trusted;
- a paused producer is not reported as a failing connection;
- the countdown to audio-only fires at twelve seconds and not before, and the retry at forty-five;
- `0` disables the automatic half without disabling the manual choice;
- a new consumer inherits the student's current mode;
- an audio or single-stream consumer is left alone rather than errored at;
- the camera inset is 320x180 and even (an odd width is rejected outright by H.264 with yuv420p);
- the inset is scaled with lanczos, and the encode uses the configured crf and preset.

`npm run check` (40 files) and `vite build` pass.

**Worth checking on the dev server:**

1. Teacher and two students. In `chrome://webrtc-internals` on the teacher, confirm three outbound video streams rather than one.
2. Throttle one student to "Slow 3G" in devtools. Their picture should get smaller and blockier within seconds while the other student's stays sharp — that is the switching working.
3. Keep throttling. After ~12s their video should stop with a plain explanation, and audio should continue. After ~45s it should try again.
4. Record a minute and open the file. The teacher should be noticeably bigger and sharper — a 320-wide inset from a 720p source, instead of a 214-wide one from a 360p source.
5. Watch the teacher's uplink. If it cannot sustain ~2 Mbps, lower `CAM_HIGH_BITRATE` before anything else.
