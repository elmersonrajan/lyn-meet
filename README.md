# LYN MEET
**https://lynindia.in/**

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

Debug: `http://59.96.57.40:5000/api/debug` and `/api/webrtc` and `/health`

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

## Attendance

In/out times and duration per person. The Attendance button is visible to the
**coordinator only** — not to teachers.

- `GET /api/attendance` — meetings with a log
- `GET /api/attendance/<meetingId>` — report
- `GET /api/attendance/<meetingId>/csv` — spreadsheet download
- Raw event log: `backend/attendance/<meetingId>.jsonl`

A drop and rejoin counts as two sessions and the disconnected gap is excluded
from the total, so nobody is credited for time they were away. Only meetings
that ran after this feature was deployed have data.
