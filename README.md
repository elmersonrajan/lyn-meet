# Classroom Meet

Zoom / Google Meet style classroom. Teacher + students. SFU media. Cloud recording that **keeps running if the teacher’s internet drops**.

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | React (JSX) + Vite + WebRTC + mediasoup-client |
| Backend | Node.js + Express + Socket.IO |
| Media | mediasoup SFU |
| NAT | coturn TURN on **your existing server** |
| Recording | Server-side FFmpeg (room-scoped, not browser-scoped) |

Ports: **backend `5000`**, **frontend `5173`**.

## Roles

| Feature | Teacher | Student |
| --- | --- | --- |
| Own camera | Yes | No (permanently off) |
| Own microphone | Yes | Yes |
| See teacher video | Yes | Yes |
| Screen share / Draw / Whiteboard tools | Yes | View only |
| Mute others | Yes | No |
| Cloud record | Yes | No |
| Close session | Yes | No |
| Chat + QA | Yes | Yes |

## Cloud recording (Zoom-style)

Recording is a **server process** attached to the **room**, not the teacher’s browser.

1. Teacher clicks **Start Record**.
2. Backend consumes teacher audio + camera/screen via mediasoup `PlainTransport`.
3. FFmpeg writes `backend/recordings/<meetingId>_rec_*.mp4`.
4. If the teacher disconnects, the room stays open for 120 seconds (configurable) and **FFmpeg keeps running**.
5. Teacher can rejoin the same Meeting ID as Teacher and continue.
6. Only **Stop Record** or **Close Session** finalizes the file.

Install FFmpeg on the server (`sudo apt install ffmpeg`). List files at `GET /api/recordings`.

To push files to S3/GCS, sync the `recordings/` folder (cron, rclone, or an upload hook).

## Run on your server

```bash
# 1) Backend
cd backend
cp .env.example .env
# edit PUBLIC_IP, MEDIASOUP_ANNOUNCED_IP, TURN_* to your server IP
npm install
npm run dev          # port 5000

# 2) Frontend (second terminal)
cd frontend
npm install
npm run dev          # port 5173
```

Open `http://YOUR_SERVER:5173`.

Teacher joins first (creates the room). Students join with the same Meeting ID.

## coturn

See [coturn/SETUP.md](coturn/SETUP.md). Run it on the same server. Copy `coturn/turnserver.conf.example` to `/etc/turnserver.conf`.

Open firewall:

- `5000/tcp` API + Socket.IO
- `5173/tcp` Vite (or 80/443 in production)
- `3478/udp+tcp` TURN
- `40000-49999/udp+tcp` mediasoup
- `49152-65535/udp` TURN relays

## Project layout

```
classroom-meet/
  backend/src/
    server.js
    config/          mediasoup + ICE/TURN
    mediasoup/       workers + rooms
    recording/       CloudRecorder (FFmpeg)
    socket/          signaling + role checks
  frontend/src/
    components/      lobby, room, toolbar, whiteboard…
    hooks/           mediasoup, whiteboard
    context/         role + session
  coturn/
```

Every action is wrapped in `try/catch` with prefixed `console` logs: `[Lobby]`, `[Mediasoup]`, `[Socket]`, `[Whiteboard]`, `[CloudRecorder]`, etc.
# lyn-meet
