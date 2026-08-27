const { spawnSync } = require("child_process");
const { createLogger } = require("../utils/logger");

const log = createLogger("ProbeMedia");

/**
 * Reports the streams inside a media file.
 *
 * Prefers ffprobe, but falls back to parsing `ffmpeg -i`, because ffprobe is
 * packaged separately from ffmpeg in some distributions and is genuinely absent
 * on at least one deployment. Without the fallback, stream detection silently
 * reverts to guessing which streams exist, and a layout built on a guess
 * references a stream that is not there.
 */

function fromFfprobe(filePath) {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", filePath],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0 || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const streams = parsed.streams || [];
    if (!streams.length) return null;
    const video = streams.filter((s) => s.codec_type === "video");
    return {
      source: "ffprobe",
      videoCount: video.length,
      audioCount: streams.filter((s) => s.codec_type === "audio").length,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
      width: video[0]?.width,
      height: video[0]?.height,
      duration: Number(parsed.format?.duration || 0),
    };
  } catch (err) {
    log.warn("could not parse ffprobe output", err.message);
    return null;
  }
}

/**
 * `ffmpeg -i <file>` with no output prints the stream list to stderr and exits
 * non-zero. That non-zero exit is expected and is not an error here.
 */
function fromFfmpeg(filePath) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-i", filePath], { encoding: "utf8" });
  if (res.error) return null;
  const text = `${res.stdout || ""}${res.stderr || ""}`;
  if (!/Stream #/.test(text)) return null;

  const streamLines = text.split("\n").filter((l) => /^\s*Stream #\d+:\d+/.test(l));
  const video = streamLines.filter((l) => /:\s*Video:/.test(l));
  const audio = streamLines.filter((l) => /:\s*Audio:/.test(l));

  // e.g. "1280x720 [SAR 1:1 DAR 16:9]" — the first WxH on the line.
  let width;
  let height;
  const dim = video[0]?.match(/,\s(\d{2,5})x(\d{2,5})/);
  if (dim) {
    width = Number(dim[1]);
    height = Number(dim[2]);
  }

  // e.g. "Duration: 00:00:03.02,"
  let duration = 0;
  const dur = text.match(/Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) {
    duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  }

  return {
    source: "ffmpeg",
    videoCount: video.length,
    audioCount: audio.length,
    hasAudio: audio.length > 0,
    width,
    height,
    duration,
  };
}

/**
 * @param {string} filePath
 * @returns {null|{source:string, videoCount:number, audioCount:number,
 *   hasAudio:boolean, width?:number, height?:number, duration:number}}
 */
function probeMedia(filePath) {
  return fromFfprobe(filePath) || fromFfmpeg(filePath) || null;
}

function hasTool(cmd) {
  const res = spawnSync(cmd, ["-version"], { encoding: "utf8" });
  return !res.error && res.status === 0;
}

module.exports = { probeMedia, hasTool, fromFfprobe, fromFfmpeg };
