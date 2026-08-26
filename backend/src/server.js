require("dotenv").config();
const { teeConsoleToMeetingLog, appendMeetingLog, LOG_PATH } = require("./utils/meetingLog");
teeConsoleToMeetingLog();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { startWorkers } = require("./mediasoup/workerManager");
const { attachSocketHandlers } = require("./socket");
const { RECORDINGS_DIR } = require("./recording/cloudRecorder");
const attendance = require("./attendance/attendanceLog");
const { rooms } = require("./mediasoup/roomManager");
const { createLogger } = require("./utils/logger");

const log = createLogger("Server");

function ffmpegAvailable() {
  try {
    const { execSync } = require("child_process");
    const out = execSync("ffmpeg -version", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const first = String(out).split("\n")[0];
    log.info("ffmpeg detected", first);
    return { ok: true, version: first };
  } catch (err) {
    log.error("ffmpeg NOT installed — cloud recording to .mp4 will fail", err.message);
    return { ok: false, error: "ffmpeg not found. Install with: sudo dnf install ffmpeg  OR  sudo apt install ffmpeg" };
  }
}


const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

async function main() {
  try {
    log.action("boot", { port: PORT, cors: CORS_ORIGIN });

    await startWorkers();

    const app = express();
    app.use(
      cors({
        origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
        credentials: true,
      }),
    );
    app.use(express.json());
    app.use((req, res, next) => {
      try {
        log.info("http", req.method, req.url);
      } catch (err) {
        log.error("http log failed", err);
      }
      next();
    });

    const ffmpeg = ffmpegAvailable();

    app.get("/api/logs", (_req, res) => {
      try {
        const fs = require("fs");
        if (!fs.existsSync(LOG_PATH)) {
          res.type("text/plain").send("(no meeting log yet)\n");
          return;
        }
        res.type("text/plain").send(fs.readFileSync(LOG_PATH, "utf8"));
      } catch (err) {
        log.error("/api/logs failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get("/health", (_req, res) => {
      try {
        res.json({
          ok: true,
          service: "lyn-meet-backend",
          rooms: rooms.size,
          uptime: process.uptime(),
        });
      } catch (err) {
        log.error("/health failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get("/api/webrtc", (_req, res) => {
      try {
        const { getIceServers } = require("./config/ice");
        const ms = require("./config/mediasoup");
        const body = {
          ok: true,
          announcedIp: ms.announcedIp,
          listenIps: ms.webRtcTransport.listenIps,
          rtcMinPort: ms.workerSettings.rtcMinPort,
          rtcMaxPort: ms.workerSettings.rtcMaxPort,
          enableUdp: ms.webRtcTransport.enableUdp,
          enableTcp: ms.webRtcTransport.enableTcp,
          iceServers: getIceServers(),
          ffmpeg,
          recordingsDir: RECORDINGS_DIR,
        };
        log.info("/api/webrtc", body);
        res.json(body);
      } catch (err) {
        log.error("/api/webrtc failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get("/api/debug", (_req, res) => {
      try {
        const snapshot = [];
        for (const room of rooms.values()) {
          snapshot.push({
            roomId: room.id,
            peers: room.participants(),
            producers: room.listProducers(),
            recording: room.recorder ? room.recorder.snapshot() : null,
            stageMode: room.stageMode,
          });
        }
        res.json({ ok: true, ffmpeg, rooms: snapshot, uptime: process.uptime() });
      } catch (err) {
        log.error("/api/debug failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get("/api/attendance", (_req, res) => {
      try {
        res.json({ ok: true, meetings: attendance.listMeetings() });
      } catch (err) {
        log.error("/api/attendance failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ?date=DD-MM-YYYY selects one day; omitted, the most recent day is used.
    app.get("/api/attendance/:meetingId", (req, res) => {
      try {
        const report = attendance.buildReport(req.params.meetingId, { date: req.query.date });
        res.json({ ok: true, report });
      } catch (err) {
        log.error("/api/attendance/:meetingId failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get("/api/attendance/:meetingId/csv", (req, res) => {
      try {
        const report = attendance.buildReport(req.params.meetingId, { date: req.query.date });
        const day = String(report.meetingDate || "").replace(/-/g, "");
        const name = `attendance_${attendance.safeId(req.params.meetingId)}${day ? `_${day}` : ""}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        res.send(attendance.toCsv(report));
      } catch (err) {
        log.error("/api/attendance csv failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.use("/recordings", express.static(RECORDINGS_DIR));

    app.post(
      "/api/recordings/chunk",
      express.raw({ type: "*/*", limit: "80mb" }),
      async (req, res) => {
        try {
          const meetingId = String(req.headers["x-meeting-id"] || "unknown");
          const recId = String(req.headers["x-recorder-id"] || "");
          const isFinal = String(req.headers["x-final"] || "0") === "1";
          const buf = req.body;
          log.action("recording chunk", {
            meetingId,
            recId,
            bytes: buf?.length || 0,
            final: isFinal,
          });
          appendMeetingLog("recording chunk", { meetingId, recId, bytes: buf?.length || 0, final: isFinal });

          let room = rooms.get(meetingId);
          if (!room) {
            log.warn("chunk: room gone (teacher dropped?) — still append if recorder file exists");
          }
          if (room && !room.recorder) {
            const { CloudRecorder } = require("./recording/cloudRecorder");
            room.recorder = new CloudRecorder(room);
            room.recorder.id = recId || room.recorder.id;
            room.recorder.active = true;
          }
          if (room && room.recorder) {
            if (buf && buf.length) await room.recorder.appendChunk(buf);
            if (isFinal) await room.recorder.finalizeRaw();
            res.json({ ok: true, recording: room.recorder.snapshot() });
            return;
          }

          const fs = require("fs");
          const pathMod = require("path");
          fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
          const name = `${meetingId}_${recId || "orphan"}.webm`;
          if (buf && buf.length) fs.appendFileSync(pathMod.join(RECORDINGS_DIR, name), buf);
          res.json({ ok: true, file: name, orphan: true });
        } catch (err) {
          log.error("/api/recordings/chunk failed", err);
          appendMeetingLog("chunk http failed", { message: err.message });
          res.status(500).json({ ok: false, error: err.message });
        }
      },
    );

    app.post(
      "/api/recordings/upload",
      express.raw({ type: "*/*", limit: "400mb" }),
      async (req, res) => {
        try {
          const meetingId = String(req.headers["x-meeting-id"] || "unknown");
          const contentType = req.headers["content-type"] || "video/webm";
          const buf = req.body;
          log.action("upload recording", { meetingId, bytes: buf?.length, contentType });
          appendMeetingLog("upload recording", { meetingId, bytes: buf?.length });
          if (!buf || !buf.length) {
            log.warn("upload empty — logs only");
            appendMeetingLog("WARN upload empty — no audio/video/screen/whiteboard");
            res.json({ ok: true, logsOnly: true });
            return;
          }
          const room = rooms.get(meetingId);
          if (room && room.recorder) {
            const snap = await room.recorder.ingestClientBlob(buf, contentType);
            res.json({ ok: true, recording: snap });
            return;
          }
          const fs = require("fs");
          const path = require("path");
          fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
          const name = `${meetingId}_upload_${Date.now()}.webm`;
          fs.writeFileSync(path.join(RECORDINGS_DIR, name), buf);
          res.json({ ok: true, file: name });
        } catch (err) {
          log.error("/api/recordings/upload failed", err);
          appendMeetingLog("upload failed", { message: err.message });
          res.status(500).json({ ok: false, error: err.message });
        }
      },
    );

    app.get("/api/recordings", (req, res) => {
      try {
        const fs = require("fs");
        if (!fs.existsSync(RECORDINGS_DIR)) {
          res.json({ ok: true, files: [] });
          return;
        }
        const files = fs
          .readdirSync(RECORDINGS_DIR)
          .filter((f) => f.endsWith(".mp4") || f.endsWith(".webm"))
          .map((name) => ({
            name,
            url: `/recordings/${encodeURIComponent(name)}`,
            size: fs.statSync(path.join(RECORDINGS_DIR, name)).size,
          }));
        res.json({ ok: true, files });
      } catch (err) {
        log.error("/api/recordings failed", err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    const server = http.createServer(app);
    const io = new Server(server, {
      cors: {
        origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
        methods: ["GET", "POST"],
        credentials: true,
      },
      pingTimeout: 20000,
      pingInterval: 10000,
      maxHttpBufferSize: 20 * 1024 * 1024,
    });

    attachSocketHandlers(io);

    server.listen(PORT, HOST, () => {
      log.info(`backend listening on http://${HOST}:${PORT}`);
      log.info("cloud recordings directory (.mp4)", RECORDINGS_DIR);
      log.info("ICE range", {
        min: process.env.MEDIASOUP_RTC_MIN_PORT,
        max: process.env.MEDIASOUP_RTC_MAX_PORT,
        announced: process.env.MEDIASOUP_ANNOUNCED_IP,
      });
      log.info("TURN", { enabled: process.env.TURN_ENABLED, urls: process.env.TURN_URLS });
      if (!ffmpeg.ok) log.warn("Install ffmpeg or Start Record will fail");
    });
  } catch (err) {
    log.error("fatal boot error", err);
    process.exit(1);
  }
}

process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", err);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});

main();
