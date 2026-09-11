Two things reported from UAT: the same person appearing two and three times in
the participant list, and coordinators holding the teacher's tools.

## Why one person appeared three times

A `Peer` is a socket, not a person. Every join minted a fresh uuid, and nothing
ever asked whether that account was already sitting in the room.

So the list held one row per *connection*, and a connection is not removed when
someone leaves — it is removed when socket.io finally gives up on it. That is
`pingInterval + pingTimeout`, up to forty-five seconds. Refresh the tab, let a
phone sleep and wake, open a second window, ride through a tunnel: for the next
forty-five seconds the class, the teacher's panel and the register each show two
of you. Three, if it happens twice.

It reproduces every time. Join, press F5, count the names.

**A join now releases whatever seat that account already holds.** The old peer is
removed, its media closed, its socket told why and disconnected, and the room is
told it left — all before the new peer is created, so the list never holds both.

The newest connection wins, deliberately. The old one is the one that has already
stopped working, and the person is looking at the new one.

Identity is the account, compared case-insensitively — the platform hands the
same person back as `Ida.Sharon@…` one day and `ida.sharon@…` the next. A peer
with no email at all (ad-hoc rooms, `AUTH_DISABLED`) is never matched to another:
there is nothing there to say they are the same person.

### What this fixes for the teacher, which was the worse half

A teacher who refreshed mid-lesson was told **"This meeting already has an active
teacher"** — by their own dead tab. The grace-window reconnect only ran once the
old socket had actually gone, so they were locked out of their own class for up to
forty-five seconds while it was running.

Their own earlier connection is no longer mistaken for another teacher. A
*different* teacher is still refused, which is the check that actually matters:
without it anyone on staff could step into a colleague's class during the grace
window and inherit it, with the attendance still carrying the first teacher's
name.

### The register was wrong too

Folding attendance is per account, so the rejoin arrived as a join with the
previous session still open. That is marked `exit-not-recorded` and cut at the
last witnessed moment — the fold deliberately under-counts rather than inventing
the gap, which is what once turned seven minutes into 4h 48m.

Releasing the seat writes a real `leave` first, so both periods are provable.
Tests pin the new shape and the old one, so the difference is visible rather than
asserted.

## The lesson tools are the teacher's

Draw, Screen, Play Video and YouTube sat above the board for anyone on staff. A
coordinator supervising a class had the whole strip — including a **Draw** tab
that switches the entire class to a page they cannot write on, the board having
been teacher-only for a while now.

Gone for coordinators: the strip, the same four offered from the board's
right-click menu, and the controls on the shared player.

**And refused on the server**, which is the half that matters. Hiding a button is
a layout change; `set-stage`, `share-media`, `media-control` and `stop-media` all
still accepted anyone on staff, so a stale tab from before this deploy could put
the class on a screen share or stop the teacher's video mid-clip.

Everything else a coordinator does is untouched — muting, attendance, polls, Q&A,
recording, removing someone, ending the session. Those are the job; presenting is
not. A student never saw any of it.

## Why a teacher who left stayed on screen

Reported separately, and it turned out to be three faults stacked on the same
symptom — the name still listed, the camera still showing their face.

**1. Nothing told the browsers the camera had stopped.** Closing a producer on
the server does not reach a browser on its own: the consumers in every other tab
simply stop receiving frames. A `<video>` that stops receiving frames does not go
blank — it holds the last frame it decoded, indefinitely, looking exactly as
present as before. `producer-closed` is the message the browsers already act on,
and it was only ever sent for a camera switched off on purpose, never for someone
leaving, being removed, or having their seat replaced. All three send it now.

Not during the teacher's grace window, deliberately: the producers are still open
there — that is what the window *is* — and a teacher whose socket merely blipped
comes back to the same media, with no `new-producer` to re-subscribe anybody.
Announcing a close would lose their camera for the rest of the lesson.

**2. The grace window expiring told nobody at all.** That removal is done by a
timer inside the room, on its own clock, with no socket anywhere near it. It
deleted the peer and stopped. So two minutes after a teacher's laptop shut, the
class was still looking at their name and their last frame, and only an unrelated
event — somebody else joining — would ever clear it. The room can now say a peer
went, and the socket layer listens.

**3. The tile could not show "reconnecting" while a frozen frame existed.** It
chose what to display from the track alone, and offered the away message only
when there was no picture at all — which is never, for the reason in (1). The
branch written for a dropped teacher was unreachable in exactly the case it was
for. A frozen frame is the least true of the three things that tile can show, so
it now loses to both of the others.

### On the two minutes

Pressing **Leave** is immediate and never waits for the grace window. Only a
connection that vanishes — a closed tab, a dead network — takes that path, and
holding the place is the point: the room, the board and a running recording all
survive the gap and the teacher walks back into the class they left.

What was wrong was that it was invisible and unbounded, not that it exists. It is
now visible from the first second (`reconnecting…`, tile stood down) and it ends
when it says it ends. `TEACHER_RECONNECT_GRACE_MS` is the dial, and `.env.example`
now explains the trade instead of just naming it.

## The one underneath all of them

The clue was in the report: *"in attendance it is updating live like that, the
name and video also should work."*

The attendance panel is fetched over **HTTP**. It asks the server every time, so
it was right about everything. The participant list, the instructor tile, the
board and the toolbar are all **pushed down the socket** — and they had all
stopped at the same moment, showing the last thing that browser happened to hear.

A socket.io reconnect is a **new socket**. The server hands it a fresh
`socket.data` with no peer and no room, and `join-room` is emitted exactly once,
from the lobby, and never again. So one blip — a laptop sleeping, a wifi handover,
a proxy timing out an idle websocket — detached the browser from the meeting
permanently. The server had long since removed that peer and told the room; there
was simply nobody left listening on that socket.

And nothing said so. The screen looked like a working meeting.

That is the same symptom as the frozen teacher, and it would have survived every
fix above: the messages were being sent correctly to a socket that was no longer
anybody.

**Now:** a red bar across the top the moment the socket drops, and a rejoin when
it comes back.

The rejoin is a page load, not a hand-rolled re-initialise. The transports, the
producers and every consumer died with the old socket and would all have to be
rebuilt in the right order; a load does precisely that through the path every
normal arrival already takes, and the link in the address bar carries the class,
so it comes back on its own with no click.

A page load also starts a fresh JavaScript world, which is why the loop guard
lives in session storage — an in-memory flag cannot see the reload before it, and
on a line that is flapping rather than broken that is connect, drop, reload,
connect, drop, and a teacher who never gets a word out. Twenty seconds between
attempts; after that the bar stays up with a **Rejoin** button and it is their
choice.

## Verified

`npm test` — 100 passing in the backend, 7 new; 7 more in the frontend, which now
has a test script of its own. `npm run check` (41 files) and `vite build` pass.

**Worth checking on the server:**

1. Join as a coordinator, press F5. One ADMIN in the list, not two. Wait a minute
   and it is still one.
2. Two tabs as the same account. The first says *"You joined this class again
   somewhere else."* and leaves; the room shows one of you.
3. Teacher, mid-lesson, press F5. They get straight back in as the teacher.
4. A second teacher on a different account is still refused — that check has to
   survive this.
5. As a coordinator, look above the board: no Draw / Screen / Play Video /
   YouTube. Right-click the board: no Play Video / YouTube. The bottom bar is
   unchanged.
6. As the teacher, all four still work.
7. Teacher presses **Leave**. Their name and their picture both go at once, on
   every other screen.
8. Teacher closes the tab instead. Within a moment they read `reconnecting…` and
   the tile says so; when the grace window ends they disappear on their own,
   with nothing else having to happen to make it so.
9. Teacher pulls their network out and puts it back inside the window. The class
   gets them back, picture included — that is the case that would break if the
   grace window announced a close.
10. The one that matters most, and the one nobody was testing: in devtools,
    Network → **Offline** for a few seconds, then back on. The red bar appears
    immediately, and the tab rejoins on its own. Before this it would have sat
    there looking perfectly normal and receiving nothing for the rest of the
    lesson.
