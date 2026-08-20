require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { startWorkers } = require("./mediasoup/workerManager");
const { attachSocketHandlers } = require("./socket");
const { RECORDINGS_DIR } = require("./recording/cloudRecorder");
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

    app.get("/health", (_req, res) => {
      try {
        res.json({
          ok: true,
          service: "classroom-meet-backend",
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

    app.use("/recordings", express.static(RECORDINGS_DIR));

    app.get("/api/recordings", (req, res) => {
      try {
        const fs = require("fs");
        if (!fs.existsSync(RECORDINGS_DIR)) {
          res.json({ ok: true, files: [] });
          return;
        }
        const files = fs
          .readdirSync(RECORDINGS_DIR)
          .filter((f) => f.endsWith(".mp4"))
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
