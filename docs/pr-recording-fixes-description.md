Four fixes to cloud recording, all found from real classes on production.

## Every render failed for a day

The worst of them, and mine. Recordings captured fine and none of them ever
became a file:

```
failed: events?.note is not a function
```

A render job is written to `<id>.job.json` and read back before it runs. I put
the recording-log handle on that job, so it crossed a JSON file on the way and
arrived as plain data with no methods. The first render step called it and
threw, which the queue recorded as a failed render — every class, silently,
while the captures piled up on disk.

The render now opens its own handle on the same file, appending, so a recording
still has one story. Tested the only way that would have caught it: a handle put
through `JSON.parse(JSON.stringify(...))`, which is exactly what the job file
does to it.

**No class was lost.** The live capture, the side voices and the board frames
all survive a failed render by design, which is why the affected classes could
be re-rendered rather than mourned.

## Two people unmuting at once lost both their voices

From a real log:

```
side:audio:ADMIN      -> rec_..._side1.sdp
side:audio:Harini S   -> rec_..._side1.sdp   (105ms later)
  bind failed: Address already in use
  Invalid data found when processing input
```

`_startSide` numbered itself from `this.sides.length`, read at the top — but a
side is not pushed to that array until the end, four `await`s later. Two people
unmuting in the same tick both read the same number, wrote the same `.sdp` and
`.mkv`, and collided. One ffmpeg had already bound the port named in that file;
the other read it after it was overwritten underneath. Both captures died.

A counter incremented synchronously cannot collide: nothing can run between
reading it and increasing it.

The duplicate guard in `addVoice` had the same hole — it asks the sides array
whether someone is already being captured, and that array cannot know about a
capture still starting. A claim is now taken before the awaits and released
after, and the `MAX_SIDES` ceiling counts those claims, so the limit cannot be
overshot by whatever is in flight.

## Every voice piled up at the start of the recording

Reported as: live audio is perfect, but in the file everyone except the teacher
is bunched at the beginning.

The delays were right — `adelay=19463, 21222, 40781, 91431, 1314256`, sensible
offsets for people who unmuted between 19 seconds and 21 minutes in. The order
was wrong:

```
teacher:  aresample=async=1:first_pts=0
voice:    adelay=19463:all=1 , aresample=async=1
```

The teacher's stream is pinned to zero before anything touches it. A voice was
**delayed first and anchored after**, so its offset was added to whatever
timestamp that capture happened to begin at — and a side capture is written from
live RTP and killed when the class ends, so its header is not to be trusted. The
same log carries `File ended prematurely` against those files.

Delaying an unknown start by a known amount gives an unknown position.

Now: normalise, then place. Doing it the other way round — simply adding
`first_pts=0` to the existing chain — would have been *worse*, pinning the
silence `adelay` had just inserted back to zero and discarding the offset again.

A voice that began with the recording gets no `adelay` at all rather than
`adelay=0`, since a filter that does nothing can still introduce error.

## The log could only answer the opposite question

A recording that mixed five voices had no `side-start` lines in its log at all,
and there was no way to tell whether that was a logging gap, a rule doing its
job, or a bug.

`side-start` is only reached once a capture actually begins, so every other
outcome was silent. Six rules can end `addVoice` — the recording is not running,
they had already left, they are already being captured, a capture was already
starting, the side limit is reached, or they have no microphone producer — and
from outside they are indistinguishable from each other and from a fault. Each
now writes a line saying which.

"Why is this person not in the recording" is the question the log exists to
answer, and until now it could only answer the opposite one.

## Verified

`npm test` — 158 passing, 15 new. The ones that matter, because each pins a
failure that was invisible until a class hit it:

- a log handle does not survive being written to a job file;
- a voice is pinned to zero **before** it is delayed, not after;
- a voice that began with the recording gets no delay filter at all;
- the teacher and the voices are anchored the same way;
- the mix never quietens the teacher when somebody else speaks.

**Worth checking on the server:** record two minutes with somebody unmuting
partway through, then confirm the mix command reads
`aresample=async=1:first_pts=0,adelay=…` — normalise before delay — and that
their voice lands where they actually spoke.
