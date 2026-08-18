const { createLogger } = require("../utils/logger");

const log = createLogger("ICE");

function splitCsv(value) {
  try {
    return String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    log.error("splitCsv failed", err);
    return [];
  }
}

function getIceServers() {
  try {
    const iceServers = [];
    const stunUrls = splitCsv(
      process.env.STUN_URLS || "stun:stun.l.google.com:19302",
    );
    if (stunUrls.length) {
      iceServers.push({ urls: stunUrls });
    }

    const turnEnabled = String(process.env.TURN_ENABLED || "true") === "true";
    const turnUrls = splitCsv(process.env.TURN_URLS || "");
    const username = process.env.TURN_USERNAME || "";
    const credential = process.env.TURN_CREDENTIAL || "";

    if (turnEnabled && turnUrls.length && username && credential) {
      iceServers.push({
        urls: turnUrls,
        username,
        credential,
      });
      log.info("TURN servers attached", { count: turnUrls.length });
    } else {
      log.warn("TURN not fully configured — clients will rely on STUN only");
    }

    return iceServers;
  } catch (err) {
    log.error("getIceServers failed", err);
    return [{ urls: ["stun:stun.l.google.com:19302"] }];
  }
}

module.exports = { getIceServers };
