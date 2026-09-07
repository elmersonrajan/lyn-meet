/**
 * How much data a class is allowed to cost.
 *
 * The teacher's camera was captured at 1280x720 with no ceiling on its bitrate,
 * and VP8 will happily spend two megabits a second on that. It is then shown in
 * a tile about 300 pixels wide. Nobody could see the difference between that
 * and a quarter of the data, but everybody pays for it -- the teacher on their
 * uplink, every student on their downlink, and the school on both.
 *
 * So the profile lives here, on the server, and is handed to each browser when
 * it joins. That means it can be tuned on a class-by-class basis from a
 * `.env` file and a restart, rather than by rebuilding the frontend -- which
 * matters, because the right number depends on the connection the teachers
 * actually have, and nobody knows that from here.
 *
 * The numbers below are chosen for the tile the video is displayed in:
 *
 *   camera  640x360 at 20fps, capped at 300 kbps   (~0.3 Mbps)
 *   screen  whatever it is, capped at 1.2 Mbps
 *
 * A screen share keeps its resolution because text has to stay readable; it is
 * the bitrate that is capped, which costs sharpness during movement rather
 * than legibility while still.
 */
const number = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

function mediaProfile() {
  return {
    camera: {
      width: number("CAM_WIDTH", 640),
      height: number("CAM_HEIGHT", 360),
      frameRate: number("CAM_FPS", 20),
      maxBitrate: number("CAM_MAX_BITRATE", 300000),
      /**
       * A talking head that stutters reads as a broken connection, while one
       * that softens for a moment reads as nothing at all. Under pressure the
       * encoder gives up sharpness rather than smoothness.
       */
      degradationPreference: process.env.CAM_DEGRADATION || "maintain-framerate",
    },
    screen: {
      maxBitrate: number("SCREEN_MAX_BITRATE", 1200000),
      maxFramerate: number("SCREEN_MAX_FPS", 24),
    },
    /**
     * A ceiling on everything one person sends, enforced by the server rather
     * than requested of the browser. Has to fit a screen share and a camera at
     * once, with room for audio.
     */
    maxIncomingBitrate: number("MAX_INCOMING_BITRATE", 2500000),
  };
}

module.exports = { mediaProfile };
