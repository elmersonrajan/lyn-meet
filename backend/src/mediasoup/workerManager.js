const mediasoup = require("mediasoup");
const config = require("../config/mediasoup");
const { createLogger } = require("../utils/logger");

const log = createLogger("WorkerManager");

const workers = [];
let nextWorker = 0;

async function startWorkers() {
  try {
    log.action("startWorkers", { count: config.numWorkers });
    for (let i = 0; i < config.numWorkers; i += 1) {
      const worker = await mediasoup.createWorker({
        logLevel: config.workerSettings.logLevel,
        logTags: config.workerSettings.logTags,
        rtcMinPort: config.workerSettings.rtcMinPort,
        rtcMaxPort: config.workerSettings.rtcMaxPort,
      });

      worker.on("died", () => {
        log.error("mediasoup worker died", { pid: worker.pid });
        setTimeout(() => process.exit(1), 2000);
      });

      workers.push(worker);
      log.info("worker started", { pid: worker.pid, index: i });
    }
  } catch (err) {
    log.error("startWorkers failed", err);
    throw err;
  }
}

function getNextWorker() {
  try {
    if (!workers.length) {
      throw new Error("No mediasoup workers available");
    }
    const worker = workers[nextWorker];
    nextWorker = (nextWorker + 1) % workers.length;
    return worker;
  } catch (err) {
    log.error("getNextWorker failed", err);
    throw err;
  }
}

async function createRouter() {
  try {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
    log.info("router created", { routerId: router.id, workerPid: worker.pid });
    return router;
  } catch (err) {
    log.error("createRouter failed", err);
    throw err;
  }
}

module.exports = { startWorkers, getNextWorker, createRouter };
