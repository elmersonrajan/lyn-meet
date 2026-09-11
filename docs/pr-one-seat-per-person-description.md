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

## Verified

`npm test` — 100 passing, 7 new. `npm run check` (40 files) passes.

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)
