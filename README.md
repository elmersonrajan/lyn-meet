# LYN MEET
**https://meet.lynindia.in/**

Teacher + students. Whiteboard/chat over Socket.IO. Camera/audio/screen over mediasoup WebRTC. Cloud recording writes **`.mp4`** on the server.

Ports: backend **5000**, frontend **5173**.

## What each log means

| Log | Meaning |
| --- | --- |
| `[Socket] join-room ok` | Signaling works (chat/whiteboard will work) |
| `[RoomManager] transport ICE candidates` | Server tells Chrome `ip:port` for video (e.g. 59.96.57.40:43845) |
| `[RoomManager] ICE CONNECTED` | Camera path is OPEN |
| `[RoomManager] ICE FAILED` | UDP/TCP **40000–49000** not reaching this PC **1:1** (router) |
| `[CloudRecorder] cloud recording started` | ffmpeg capturing; the composed `.mp4` is written when you stop |
| Browser `send failed` / `recv failed` | Same as ICE FAILED — not a React bug |

## Record → mp4

Server-side recording. One composed file per session:

- **Main area** — the shared screen when one is being shared, otherwise the whiteboard
- **Inset** — the teacher camera, small, bottom-right
- **Audio** — the teacher microphone

File name is the meeting ID and the date: `10maths_27AUG26.mp4`. A second
recording of the same class on the same day becomes `..._2.mp4`.

1. Teacher camera/mic on.
2. Click **Record**.
3. File: `backend/recordings/<meetingId>_<DDMMMYY>.mp4`
4. List: `http://59.96.57.40:5000/api/recordings`
5. Needs **ffmpeg** on the server: `sudo dnf install ffmpeg` (or `apt install ffmpeg`)
6. If teacher internet drops, recording **keeps running** for 120s (reconnect).
7. When the render finishes, the class is published to `YouTubeRecords` as
   `(ScheduleID, VideoURL)` — the row lynindia.in reads to show a class its
   video. The URL is this server's own playback address, so replacing it with a
   real YouTube link later is an edit to that column and nothing else. Off
   switch: `RECORDING_DB_WRITES=0`; set `RECORDING_PUBLIC_BASE_URL`.

Capture and layout are two stages. One ffmpeg process ingests every RTP stream
through a single SDP into one Matroska file, so audio, camera and screen share
one clock; at stop, that file plus the whiteboard frames are composed into the
final MP4. Only the video track is rebuilt, so the layout pass cannot disturb
the audio timing. Intermediates are deleted only after the final file exists.

Tuning: `RECORDING_WIDTH`, `RECORDING_HEIGHT`, `RECORDING_FPS`,
`RECORDING_BOARD_FPS`, `RECORDING_WARMUP_MS`, `RECORDING_TIMEZONE`.

### Check the pipeline before trusting a class to it

```bash
npm run check:recording
```

Runs the real ffmpeg with generated video, audio and whiteboard frames, then
inspects the file produced: not empty, has both tracks, correct layout size, and
a duration matching the source. Needs `ffmpeg` and `ffprobe` on the box, and
exits non-zero on failure so it can gate a deploy. Run it after any change to
the recording code -- it catches faults that only otherwise appear as a lost
class.

```bash
npm run check
```

Parses every frontend file and reports syntax errors, including duplicate
declarations, before the app is loaded.

## Idle meetings close themselves

The server reclaims rooms nobody is using, so a forgotten tab does not hold a
mediasoup Router and its RTP ports open:

| Condition | Closed after |
| --- | --- |
| Nobody in the meeting | 15 minutes |
| Only one person in the meeting | 20 minutes |

A peer inside the teacher reconnect window does not count as present. Tune with
`IDLE_EMPTY_MS`, `IDLE_SOLO_MS`, `IDLE_CHECK_MS`.

## Run

```bash
# 1) HTTPS cert (camera needs https)
cd frontend
sh scripts/make-certs.sh

# 2) Backend
cd ../backend
cp .env.example .env
npm install
npm run dev

# 3) Frontend (other terminal)
cd ../frontend
npm install
npm run dev
```

Open `https://59.96.57.40:5173/` → Advanced → Proceed. Teacher first, then student.

Set `AUTH_DISABLED=1` in `backend/.env` for local work: without it the lobby
redirects to lynindia.in to sign in, and there is no way past it on a laptop.
The flag is ignored when `NODE_ENV=production`.

Debug: `http://59.96.57.40:5000/api/debug` and `/api/webrtc` and `/health`
(the first two are staff-only now; `/health` stays public for monitoring)

## Sign-in

There is no login form and no Google sign-in. Everyone arrives from
lynindia.in with a one-time signed ticket, and their email must exist in the
platform's `v_Users` view or they are refused. Roles come from that view, not
from the browser — the old lobby let anyone pick "Teacher" from a dropdown.

See [docs/SSO.md](docs/SSO.md) for the flow, the endpoint lynindia.in has to
expose, and what stops each class of attack.

## Router (office Zyxel → 192.168.1.55)

| Port | Protocol | Inside ports |
| --- | --- | --- |
| 5173 | TCP | 5173 |
| 5000 | TCP | 5000 |
| 3478 | UDP+TCP | 3478 |
| **40000–49000** | **UDP+TCP** | **40000–49000 (same numbers, not 40000 only)** |
| 49152–65535 | UDP | 49152–65535 |

Students do not open ports. Only the office server router.

## Roles

| | Teacher | Coordinator | Student |
| --- | --- | --- | --- |
| Camera | yes | no | no |
| Mic | joins **live** | joins **muted** | joins **muted** |
| Can unmute | always | always | only while a teacher or coordinator is in the meeting |
| Screen share | yes | yes | no |
| Draw / erase | yes | no | no |
| Post messages & polls | yes | yes | no — read and vote only |
| Raise hand | yes | yes | yes |
| Record, mute all, close session | yes | yes | no |
| Mute one student, from their row | yes | yes | no |
| View attendance | no | **yes** | no |

Coordinators always appear as **ADMIN**; the name is fixed on the server, not
just in the lobby, so the participant list, attendance and announcements read
the same whoever is covering the role.

Only the teacher arrives with an open mic. Students and coordinators join muted
and unmute deliberately. A student's unmute is refused server-side when no
teacher or coordinator is present, and all student mics are muted when the last
staff member leaves.

## Invite links

Share a meeting with a link instead of dictating the ID:

```
https://59.96.57.40:5173/?lynmeet=math-101
```

Opening the link fills the meeting in; the person only types their name. After
joining, the address bar is rewritten to the shareable form, so the link can be
copied straight out of the browser.

A link never carries a role — anyone arriving by link lands on Student, and
staff pick Teacher or Coordinator by hand, so a forwarded link cannot hand out
teacher access.

These forms are all accepted when reading a link, so nothing breaks if a link
is written by hand:

| Form | Note |
| --- | --- |
| `/?lynmeet=<id>` | what the address bar shows; always works |
| `/?meeting=<id>`, `/?meetingId=<id>`, `/?id=<id>` | aliases |
| `/lynmeet=<id>`, `/join/<id>`, `/m/<id>` | path forms |
| `/<code>` | only when it matches a `xxx-xxxx-xxx` code |

Path forms need the server to serve `index.html` for unknown paths. The Vite dev
server does this already; behind nginx add `try_files $uri /index.html;`. The
query form needs no server configuration at all, which is why it is the default.

## Whiteboards, shared video and appreciation

**Whiteboard tabs.** `Whiteboard 1 | Whiteboard 2 | +`. A new board no longer
replaces the old one -- each keeps its own strokes for the meeting. Each tab
carries a close button, like a browser tab; it asks before deleting, because
everything drawn on that board goes with it. The last board cannot be closed,
and the numbers come from position, so the tabs always read 1..N however many
have come and gone. Only the
teacher can add or switch, and switching moves the whole class: the strokes
travel with the switch, so a tab change, a late join and a reconnect all end in
the same picture. The recording follows whichever board the class is on.

**Zoom into a page.** The `−  100%  +` controls on the board tools, Ctrl and the
scroll wheel to zoom where the pointer is, or Ctrl with `+` `-` `0`; Shift and
drag moves the page once zoomed. All of these zoom **the board only** -- the
toolbar, roster and video tiles stay where they are, which is not what Chrome's
own zoom does with them. **The whole class zooms with the teacher** -- magnifying a
paragraph is pointing at it, and forty people still seeing the whole page have
not been shown anything. The zoom belongs to the board, so it travels with a
tab switch and reaches a late joiner. Strokes are drawn through the same
transform, so a circle round a word stays round that word at any zoom.

**Right-click the board** for a menu: Paste, Picture…, PDF or Word document…,
Video… (which shares the tab it is playing in), YouTube…, and Clear. Ctrl+V and
dropping a file work as well; the menu exists because neither is discoverable
and right-clicking a board is what somebody tries when they want to put
something on it.

**Paste a picture onto a whiteboard.** Ctrl+V, or drop the file on the board.
Teacher only, and it appears for the whole class under the strokes, so the
picture is the page and the drawing is the working on it. A diagram, a photo of
a page, a screenshot of a PDF or a Word document -- anything the browser can
decode as an image.

The browser scales it to the shape of a board and sends a **PNG** over the
socket -- not an upload, so no proxy body limit applies. One picture per board -- pasting again replaces it, and Clear
takes it with the strokes.

**Open a PDF or Word document on the board.** The document button on the board
tools, or paste or drop the file. The file is stored once and **every browser
renders it for itself** with pdf.js, a page at a time, with the teacher's page
synchronised to the class -- so a page stays sharp at whatever size a student's
screen is, a forty-page document costs one download rather than forty, and
turning a page puts one number on the wire. Draw on it like anything else.

Word documents are converted to PDF by LibreOffice on the server. Without
`soffice` installed the teacher is told to save it as a PDF, rather than left
waiting for a file that will never appear:

```bash
sudo dnf install libreoffice-writer   # or: apt install libreoffice-writer
```

**Playing a video: Play Video.** It shares the browser tab the video is in,
picture and sound together, live. Chrome's picker has an audio tickbox that is
easy to miss and a silent video is the failure this feature exists to avoid, so
the button says so before opening it.

Nothing is uploaded: there is no size limit, it works for a video that is not a
file at all, and the sound is the original. The picture and the sound travel as
two separate producers, so muting the teacher does not mute the video, and the
recording keeps them apart. Firefox and Safari may give no audio track; the
share then goes ahead silently and says so in the console.

**YouTube.** A link is reduced to its video id on the server and played through
YouTube's own player, which every browser fetches for itself -- at its own
quality, with its own volume control. The server holds *what* is playing and
*where it has got to*, so a student joining ten minutes in starts ten minutes
in. Staff drive play, pause and seek; students watch -- hiding
YouTube's controls is not enough on its own, since its player pauses on a click
anywhere in the picture, so a transparent pane over it swallows those clicks.

A browser may refuse to start sound on its own if the viewer has not interacted
with the page yet. When that happens the student is offered a **Tap to play with
sound** button rather than a silent video.

**Appreciation.** Four fixed messages (Great Job!, Excellent!, Well Done!,
Outstanding!), staff only, thrown full-screen across every participant's screen
for about four seconds. The wording lives on the server and the client sends
only an id.

**Ending a session** now asks first. It removes everyone from the lesson and
cannot be undone, and the button sits beside Leave.

### Nothing is kept

Pictures and documents live on the server only so that every browser in the
room can fetch them. They are deleted **when the meeting closes**, and swept on
a timer as well as at boot for whatever a crash left behind -- a server that
stays up for a month would otherwise never sweep at all, which is how
"temporary" quietly becomes "forever". `BOARD_IMAGE_MAX_AGE_HOURS`,
`DOCUMENT_MAX_AGE_HOURS` and `MATERIAL_SWEEP_MINUTES` tune the backstop.

## What the recording contains

Pressing **Record** captures the teacher's own browser tab and records that as
the picture. The recording is then whatever the class was looking at: the
whiteboard with its drawings, a pasted picture, a PDF or Word page, a screen
share, a video, the camera tile -- all of it, arranged as it was on screen.

The server used to rebuild the picture from the parts it understood: strokes
re-drawn from the stroke list, the camera, a screen share. Anything it could
not rebuild was simply missing from the video.

Chrome asks the teacher to confirm the capture when they press Record. If they
decline, the recording still happens -- the server falls back to assembling the
board, the camera and any screen share, which is what it always did, and says
so on screen.

## How much data a class costs

The teacher's camera used to be captured at 1280x720 with no ceiling on its
bitrate, which VP8 will spend 1.5-2 Mbps on. It is displayed in a tile a few
hundred pixels wide, so that was paid for by the teacher's uplink and every
student's downlink and visible to none of them.

| | Capture | Cap | Roughly |
| --- | --- | --- | --- |
| Camera | 640x360 at 20fps | 300 kbps | ~0.3 Mbps |
| Screen | unchanged (text must stay readable) | 1.2 Mbps at 24fps | ~1.2 Mbps |
| Per person, all sources | | 2.5 Mbps, enforced server-side | |

The profile is **sent by the server** at join time (`CAM_*`, `SCREEN_*`,
`MAX_INCOMING_BITRATE` in `.env`), so it can be tuned for the connections
teachers actually have with a restart rather than a frontend rebuild. The cap
is also applied to the transport with `setMaxIncomingBitrate`, so it holds
whatever the browser asks for.

Under pressure the camera gives up sharpness rather than smoothness
(`maintain-framerate`) -- a stuttering face reads as a broken connection, a
softer one reads as nothing at all. Set `CAM_DEGRADATION=maintain-resolution`
for a camera pointed at handwriting.

## Attendance

In/out times and duration per person. The Attendance button is visible to the
**coordinator only** — not to teachers.

**Only the meeting you are in.** Every endpoint below checks that the caller is
currently a participant of the meeting they are asking about, and refuses with
403 otherwise. Being staff is not enough: a coordinator could previously read
the register of every meeting this server had ever run, other people's classes
included. There is no date picker either — the register of a class that
finished last week lives on the platform. The check is server-side, because
hiding a picker stops browsing and does not stop a typed URL.

- `GET /api/attendance` — the meetings the caller is in
- `GET /api/attendance/<meetingId>` — report for the live day
- `GET /api/attendance/<meetingId>/csv` — spreadsheet download
- `GET /api/attendance/<meetingId>/log` — the readable event log
- Raw event log: `backend/attendance/<meetingId>.jsonl` (append-only, never
  deleted, and still the source every report and every database row is built
  from)

A drop and rejoin counts as two sessions and the disconnected gap is excluded
from the total, so nobody is credited for time they were away. Only meetings
that ran after this feature was deployed have data.

### Into the platform database

The `.jsonl` file stays the record; every row below is a mirror of it, written
as people join and leave. A class needs no button pressed and no spreadsheet
uploaded.

| Table | What lands there |
| --- | --- |
| `AttendanceLog` | one row per period of presence — `InTime`, `OutTime`, `SessionID` = the ScheduleID |
| `Attendance` | the register: one row per student per class-day, `duration` excluding gaps |
| `TeacherAttendance` | the teacher who took the class |
| `AdminAttendance` | a coordinator supervising it |

`Subject`, `Class` and `Medium` come from `ClassSubject`, and `AttendDate` from
`ClassSchedule` — the same way the site's own rows are built. Times read
`6:59 PM` and durations `1 hr 5 min`, in class time.

Rows are stamped `UploadedBy = LYN MEET`, and the upsert **only overwrites a
row carrying that marker** — attendance uploaded by a centre is never replaced.
Ad-hoc rooms (anything that is not a ScheduleID) write nothing.

If MySQL was down, replay from the file:

```bash
node scripts/backfill-attendance.js 10197            # every day in that log
node scripts/backfill-attendance.js 10197 27-08-2026 # one class-day
node scripts/backfill-attendance.js --all --dry-run  # show, write nothing
```

Off switch: `ATTENDANCE_DB_WRITES=0`. The DB account needs INSERT and UPDATE on
those four tables — SELECT alone is no longer enough.
