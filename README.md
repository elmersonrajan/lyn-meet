# Classroom Meet

Teacher + students. Whiteboard/chat over Socket.IO. Camera/audio/screen over mediasoup WebRTC. Cloud recording writes **`.mp4`** on the server.

Ports: backend **5000**, frontend **5173**.

## What each log means

| Log | Meaning |
| --- | --- |
| `[Socket] join-room ok` | Signaling works (chat/whiteboard will work) |
| `[RoomManager] transport ICE candidates` | Server tells Chrome `ip:port` for video (e.g. 59.96.57.40:43845) |
| `[RoomManager] ICE CONNECTED` | Camera path is OPEN |
| `[RoomManager] ICE FAILED` | UDP/TCP **40000–49000** not reaching this PC **1:1** (router) |
| `[CloudRecorder] cloud recording started` | ffmpeg writing `backend/recordings/<meetingId>_rec_*.mp4` |
| Browser `send failed` / `recv failed` | Same as ICE FAILED — not a React bug |

## Record → mp4

1. Teacher camera/mic on.
2. Click **Start Record**.
3. File: `backend/recordings/<meetingId>_rec_<id>.mp4`
4. List: `http://59.96.57.40:5000/api/recordings`
5. Needs **ffmpeg** on the server: `sudo dnf install ffmpeg` (or `apt install ffmpeg`)
6. If teacher internet drops, recording **keeps running** for 120s (reconnect).

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

Teacher: camera, mic, screen, draw, record, mute others, close session.
Student: see teacher video + hear teacher, mic only, no camera/screen/draw.
