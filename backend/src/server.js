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
      log.info("cloud recordings directory", RECORDINGS_DIR);
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
