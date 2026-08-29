/**
 * Pure builders for the recording SDP and the two ffmpeg command lines.
 *
 * Kept separate from the recorder so the flags that govern audio/video sync can
 * be read, reviewed and tested without mediasoup, ffmpeg or a live meeting.
 */

const FPS = Number(process.env.RECORDING_FPS || 25);
/**
 * Rounds to an even number, minimum 2.
 *
 * H.264 with yuv420p subsamples chroma by two in each direction, so an odd
 * width or height is rejected outright: ffmpeg reports -22 (Invalid argument)
 * and "could not open encoder". A sixth of 1280 is 213.33, which rounded to 213
 * and broke every layout containing the camera inset, while the one layout
 * without it worked.
 */
function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Forced even for the same reason, since these come from the environment.
const LAYOUT_W = even(Number(process.env.RECORDING_WIDTH || 1280));
const LAYOUT_H = even(Number(process.env.RECORDING_HEIGHT || 720));

// Teacher camera inset, bottom-right. Kept to a sixth of the width so the board
// or a shared screen stays readable behind it.
const PIP_W = even(LAYOUT_W / 6);
const PIP_H = even((LAYOUT_W / 6) * (9 / 16));
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
 * Turns the whiteboard frame sequence into a small video, as its own step.
 *
 * Previously the frames were fed straight into the layout as an image sequence.
 * That put the most fragile input -- a numbered sequence, with its own frame
 * rate and its own start index -- inside the one command that also had to get
 * the overlay and the audio right, so any problem with it took the whole
 * recording down. As a separate step it either works or it does not, and the
 * layout can carry on without it.
 *
 * Prefer `manifest`: a concat list carrying each frame's real on-screen
 * duration. A fixed `-framerate` assumes the snapshot timer fired exactly on
 * schedule, and it does not -- Node timers drift, and this box is also running
 * the SFU and an ffmpeg ingest. Every late tick then shortened the board
 * timeline against the audio, so the board ran ahead of the voice describing
 * it. Real durations pin each frame to the moment it was actually drawn.
 *
 * `pattern` is the older fixed-rate form, kept for the pipeline check.
 * -start_number 0 matters there: frames begin at 000000 and the image demuxer
 * looks for 1 by default.
 */
function buildBoardVideoArgs({ pattern, manifest, framesFps = 1, outputPath, width = LAYOUT_W, height = LAYOUT_H, fps = FPS }) {
  const args = ["-y", "-loglevel", "warning"];
  if (manifest) {
    args.push("-f", "concat", "-safe", "0", "-i", manifest);
  } else {
    args.push("-start_number", "0", "-framerate", String(framesFps), "-i", pattern);
  }
  args.push(
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-an",
    outputPath,
  );
  return args;
}

/**
 * Compose pass: the ingested streams plus the whiteboard video become one
 * laid-out MP4.
 *
 * Layout: a shared screen takes the main area when one was captured, otherwise
 * the whiteboard does. Everything else that was captured becomes an inset along
 * the bottom edge, right to left: the teacher camera first, then the whiteboard
 * when a screen displaced it from the main area. Nothing the teacher shared is
 * dropped -- a class where the board was displaced by a screen share used to
 * lose the board entirely, so anything written while sharing was gone.
 *
 * Audio is taken straight from the ingest, so this pass cannot disturb the
 * audio/video relationship established during capture -- it only rewrites the
 * video track.
 *
 * @param {{
 *   livePath: string, boardVideo: string|null, outputPath: string,
 *   camIndex: number|null, screenIndex: number|null, hasAudio: boolean,
 *   width?: number, height?: number, fps?: number,
 * }} opts
 */
function buildComposeArgs(opts) {
  const {
    livePath,
    boardVideo,
    outputPath,
    camIndex,
    screenIndex,
    hasAudio,
    width = LAYOUT_W,
    height = LAYOUT_H,
    fps = FPS,
  } = opts;

  const args = ["-y", "-loglevel", "warning", "-i", livePath];

  // A plain video input, already scaled and at the right frame rate by the
  // board step, so nothing here has to reason about image sequences.
  const boardInput = boardVideo ? 1 : null;
  if (boardVideo) args.push("-i", boardVideo);

  const fit = (w, h) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  const chains = [];
  // Insets are laid out right to left along the bottom, so the first entry
  // sits in the conventional bottom-right corner.
  const insets = [];

  // Main area: screen when captured, else the whiteboard, else black.
  if (screenIndex != null) {
    chains.push(`[0:v:${screenIndex}]${fit(width, height)},fps=${fps}[main]`);
  } else if (boardInput != null) {
    chains.push(`[${boardInput}:v]${fit(width, height)},fps=${fps}[main]`);
  } else {
    chains.push(`color=c=black:s=${width}x${height}:r=${fps}[main]`);
  }

  if (camIndex != null) {
    chains.push(`[0:v:${camIndex}]${fit(PIP_W, PIP_H)},fps=${fps}[cam]`);
    insets.push("cam");
  }
  // The board only needs an inset when a screen share took the main area.
  if (boardInput != null && screenIndex != null) {
    chains.push(`[${boardInput}:v]${fit(PIP_W, PIP_H)},fps=${fps}[board]`);
    insets.push("board");
  }

  let videoLabel = "main";
  insets.forEach((label, i) => {
    // eof_action=pass keeps the main area running after an inset ends, which is
    // normal: a camera or a screen share rarely lasts the whole class.
    const x = `W-w-${PIP_MARGIN + i * (PIP_W + PIP_MARGIN)}`;
    const out = `ov${i}`;
    chains.push(`[${videoLabel}][${label}]overlay=${x}:H-h-${PIP_MARGIN}:eof_action=pass[${out}]`);
    videoLabel = out;
  });

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
  even,
  buildSdp,
  buildIngestArgs,
  buildBoardVideoArgs,
  buildComposeArgs,
  LAYOUT_W,
  LAYOUT_H,
  FPS,
  PIP_W,
  PIP_H,
};
