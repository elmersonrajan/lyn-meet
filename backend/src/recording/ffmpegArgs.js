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
 * Anything that only began once the class was under way -- a screen share, a
 * student unmuting to ask a question -- is captured to its own file at the
 * moment it starts, and arrives here with the offset from the start of the
 * class. Those are shifted back into place by that offset: a side screen is
 * padded with black until it begins, and a voice is delayed by the same amount
 * before being mixed in. Every capture is stamped from the one server clock, so
 * the offset is all that is needed to line them up.
 *
 * @param {{
 *   livePath: string, boardVideo: string|null, outputPath: string,
 *   camIndex: number|null, screenIndex: number|null, hasAudio: boolean,
 *   sideScreen?: {path:string, offsetMs:number}|null,
 *   voices?: Array<{path:string, offsetMs:number}>,
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
    sideScreen = null,
    voices = [],
    width = LAYOUT_W,
    height = LAYOUT_H,
    fps = FPS,
  } = opts;

  const args = ["-y", "-loglevel", "warning", "-i", livePath];
  let nextInput = 1;

  // A plain video input, already scaled and at the right frame rate by the
  // board step, so nothing here has to reason about image sequences.
  const boardInput = boardVideo ? nextInput++ : null;
  if (boardVideo) args.push("-i", boardVideo);

  const screenInput = sideScreen ? nextInput++ : null;
  if (sideScreen) args.push("-i", sideScreen.path);

  const voiceInputs = voices.map((voice) => {
    const index = nextInput++;
    args.push("-i", voice.path);
    return { index, offsetMs: Math.max(0, Math.round(voice.offsetMs || 0)) };
  });

  const fit = (w, h) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  const chains = [];

  // The base layer has to last the whole class, so it is the whiteboard: the
  // board video is built to span from the first moment of capture to the last.
  // A screen share is layered over it for however long it ran, which is what
  // the class actually looked like -- and it means a teacher who shares for two
  // minutes of an hour no longer ends the video after two minutes, which is
  // what using the share itself as the base would do.
  let videoLabel = "base";
  let needsShortest = false;
  if (boardInput != null) {
    chains.push(`[${boardInput}:v]${fit(width, height)},fps=${fps}[base]`);
  } else {
    // A colour source runs forever, so the output has to be bounded by the
    // other streams instead.
    chains.push(`color=c=black:s=${width}x${height}:r=${fps}[base]`);
    needsShortest = true;
  }

  if (screenIndex != null) {
    chains.push(`[0:v:${screenIndex}]${fit(width, height)},fps=${fps}[scr]`);
  } else if (screenInput != null) {
    // Transparent, not black, until the share began: black padding would hide
    // the board for everything that happened before the teacher shared.
    const seconds = Math.max(0, sideScreen.offsetMs || 0) / 1000;
    const pad =
      seconds > 0.05
        ? `tpad=start_duration=${seconds.toFixed(3)}:start_mode=add:color=0x00000000,`
        : "";
    chains.push(`[${screenInput}:v]${fit(width, height)},format=yuva420p,${pad}fps=${fps}[scr]`);
  }
  if (screenIndex != null || screenInput != null) {
    chains.push(`[${videoLabel}][scr]overlay=0:0:eof_action=pass[withscreen]`);
    videoLabel = "withscreen";
  }

  // The camera sits over everything, bottom right, for as long as it ran.
  if (camIndex != null) {
    chains.push(`[0:v:${camIndex}]${fit(PIP_W, PIP_H)},fps=${fps}[cam]`);
    chains.push(
      `[${videoLabel}][cam]overlay=W-w-${PIP_MARGIN}:H-h-${PIP_MARGIN}:eof_action=pass[withcam]`,
    );
    videoLabel = "withcam";
  }

  // Every voice in the room becomes one track: the teacher from the main
  // capture, and each student or coordinator who spoke from their own, delayed
  // to the moment they joined in. normalize=0 keeps the teacher at full volume
  // instead of quietening them every time somebody else is unmuted.
  const audioLabels = [];
  if (hasAudio) {
    chains.push(`[0:a:0]aresample=async=1:first_pts=0[a_main]`);
    audioLabels.push("a_main");
  }
  voiceInputs.forEach((voice, i) => {
    const delay = voice.offsetMs > 0 ? `adelay=${voice.offsetMs}:all=1,` : "";
    chains.push(`[${voice.index}:a]${delay}aresample=async=1[a_v${i}]`);
    audioLabels.push(`a_v${i}`);
  });

  let audioLabel = null;
  if (audioLabels.length === 1) {
    audioLabel = audioLabels[0];
  } else if (audioLabels.length > 1) {
    chains.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}` +
        `amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[a_out]`,
    );
    audioLabel = "a_out";
  }

  args.push("-filter_complex", chains.join(";"), "-map", `[${videoLabel}]`);
  if (audioLabel) args.push("-map", `[${audioLabel}]`);

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
  );
  if (audioLabel) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000");

  args.push(
    // Audio is the reliable clock, so video is fitted to it rather than the
    // other way round. Without this a few dropped video packets shift
    // everything after them and the file drifts out of sync as it plays.
    "-vsync", "cfr",
    "-movflags", "+faststart",
  );
  // Only needed when the base is an endless colour source; without it ffmpeg
  // would have no reason to ever stop.
  if (needsShortest) args.push("-shortest");
  args.push(outputPath);
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
