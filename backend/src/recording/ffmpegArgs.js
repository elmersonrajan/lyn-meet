/**
 * Pure builders for the recording SDP and the two ffmpeg command lines.
 *
 * Kept separate from the recorder so the flags that govern audio/video sync can
 * be read, reviewed and tested without mediasoup, ffmpeg or a live meeting.
 */

const LAYOUT_W = Number(process.env.RECORDING_WIDTH || 1280);
const LAYOUT_H = Number(process.env.RECORDING_HEIGHT || 720);
const FPS = Number(process.env.RECORDING_FPS || 25);
// Teacher camera inset, bottom-right. Kept to a sixth of the width so the board
// or a shared screen stays readable behind it.
const PIP_W = Math.round(LAYOUT_W / 6);
const PIP_H = Math.round((LAYOUT_W / 6) * (9 / 16));
const PIP_MARGIN = 20;

/**
 * One SDP describing every stream, so a single ffmpeg process ingests all of
 * them.
 *
 * This is the core sync fix. Previously the camera and the screen were ingested
 * by separate ffmpeg processes, each with its own clock and start moment, and
 * nothing could align them afterwards. One process means one clock, and the
 * relative timing of audio, camera and screen is preserved by construction.
 *
 * Media order is fixed — audio, camera, screen — so the stream indexes used by
 * the filter graph are predictable.
 *
 * @param {{audio?:object, cam?:object, screen?:object}} tracks
 */
function buildSdp({ audio, cam, screen }) {
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=LYNMEET Cloud Recording",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
  ];

  if (audio) {
    lines.push(
      `m=audio ${audio.remoteRtpPort} RTP/AVP ${audio.payloadType}`,
      `a=rtpmap:${audio.payloadType} ${audio.codecName}/${audio.clockRate}/${audio.channels || 2}`,
      "a=recvonly",
    );
  }
  for (const video of [cam, screen]) {
    if (!video) continue;
    lines.push(
      `m=video ${video.remoteRtpPort} RTP/AVP ${video.payloadType}`,
      `a=rtpmap:${video.payloadType} ${video.codecName}/${video.clockRate}`,
      "a=recvonly",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Live ingest: RTP in, one Matroska file out, streams copied where possible.
 *
 * Flag choices that matter:
 *
 * - No `-fflags +genpts`. Generating presentation timestamps discards the RTP
 *   timing and renumbers packets by arrival order; audio and video arrive on
 *   separate UDP flows with different jitter, so their generated timelines
 *   drift apart. This single flag was the main cause of drift.
 * - `-use_wallclock_as_timestamps 1` stamps every packet with the server clock
 *   at arrival, giving all streams one shared, monotonic reference.
 * - `-thread_queue_size 1024` stops UDP packets being dropped while ffmpeg
 *   sets up, which previously lost the opening video keyframe and left video
 *   starting seconds after audio.
 * - Matroska, not MP4: MP4 needs a trailer written on clean exit, so a killed
 *   process leaves an unplayable file. Matroska stays readable.
 * - Video is copied rather than re-encoded here; all scaling and compositing
 *   happens once, in the compose pass.
 */
function buildIngestArgs({ sdpPath, outputPath, hasAudio }) {
  const args = [
    "-y",
    "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+discardcorrupt",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "1024",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",
    "-i", sdpPath,
    "-c:v", "copy",
  ];
  if (hasAudio) args.push("-c:a", "copy");
  args.push("-map", "0", outputPath);
  return args;
}

/**
 * Compose pass: the ingested streams plus the whiteboard frames become one
 * laid-out MP4.
 *
 * Layout: a shared screen takes the main area when one was captured, otherwise
 * the whiteboard does; the teacher camera is always a small inset bottom-right.
 * Audio is taken straight from the ingest, so this pass cannot disturb the
 * audio/video relationship established during capture -- it only rewrites the
 * video track.
 *
 * @param {{
 *   livePath: string, boardPattern: string|null, outputPath: string,
 *   camIndex: number|null, screenIndex: number|null, hasAudio: boolean,
 *   boardFps?: number, width?: number, height?: number, fps?: number,
 * }} opts
 */
function buildComposeArgs(opts) {
  const {
    livePath,
    boardPattern,
    outputPath,
    camIndex,
    screenIndex,
    hasAudio,
    boardFps = 1,
    width = LAYOUT_W,
    height = LAYOUT_H,
    fps = FPS,
  } = opts;

  const args = ["-y", "-loglevel", "warning", "-i", livePath];

  // The board is a slow image sequence; looping its last frame is not wanted,
  // so it simply ends and `eof_action=pass` keeps the overlay going.
  //
  // -start_number 0 is required, not optional: frames are written from
  // board_000000.ppm, and the image demuxer starts looking at 1 by default, so
  // without this the input fails and the whole compose produces a 0-byte file.
  const boardInput = boardPattern ? 1 : null;
  if (boardPattern) {
    args.push("-start_number", "0", "-framerate", String(boardFps), "-i", boardPattern);
  }

  const fit = (w, h) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  // Main area: screen when captured, else the whiteboard, else black.
  let mainLabel;
  const chains = [];
  if (screenIndex != null) {
    chains.push(`[0:v:${screenIndex}]${fit(width, height)},fps=${fps}[main]`);
    mainLabel = "main";
  } else if (boardInput != null) {
    chains.push(`[${boardInput}:v]${fit(width, height)},fps=${fps}[main]`);
    mainLabel = "main";
  } else {
    chains.push(`color=c=black:s=${width}x${height}:r=${fps}[main]`);
    mainLabel = "main";
  }

  let videoLabel = mainLabel;
  if (camIndex != null) {
    chains.push(`[0:v:${camIndex}]${fit(PIP_W, PIP_H)},fps=${fps}[pip]`);
    chains.push(
      `[${mainLabel}][pip]overlay=W-w-${PIP_MARGIN}:H-h-${PIP_MARGIN}:eof_action=pass[vout]`,
    );
    videoLabel = "vout";
  }

  args.push("-filter_complex", chains.join(";"), "-map", `[${videoLabel}]`);
  if (hasAudio) args.push("-map", "0:a:0");

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
  );
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000");

  args.push(
    // Audio is the reliable clock, so video is fitted to it rather than the
    // other way round. Without this a few dropped video packets shift
    // everything after them and the file drifts out of sync as it plays.
    "-vsync", "cfr",
    "-af", "aresample=async=1:first_pts=0",
    "-movflags", "+faststart",
    outputPath,
  );
  return args;
}

module.exports = {
  buildSdp,
  buildIngestArgs,
  buildComposeArgs,
  LAYOUT_W,
  LAYOUT_H,
  FPS,
  PIP_W,
  PIP_H,
};
