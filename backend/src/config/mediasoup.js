const os = require("os");

function numWorkers() {
  try {
    const forced = Number(process.env.MEDIASOUP_NUM_WORKERS || 0);
    if (forced > 0) return forced;
    return Math.max(1, Math.min(os.cpus().length, 4));
  } catch (err) {
    console.error("[Config:mediasoup] numWorkers failed", err);
    return 1;
  }
}

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: {
      "profile-id": 2,
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/h264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

function getListenIps() {
  try {
    const listenIp = process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0";
    const announcedIp =
      process.env.MEDIASOUP_ANNOUNCED_IP || process.env.PUBLIC_IP || "127.0.0.1";
    return [{ ip: listenIp, announcedIp }];
  } catch (err) {
    console.error("[Config:mediasoup] getListenIps failed", err);
    return [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }];
  }
}

module.exports = {
  workerSettings: {
    logLevel: "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT || 49999),
  },
  mediaCodecs,
  webRtcTransport: {
    listenIps: getListenIps(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
    maxIncomingBitrate: 3_000_000,
  },
  numWorkers: numWorkers(),
};
