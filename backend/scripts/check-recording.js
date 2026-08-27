#!/usr/bin/env node
/**
 * Exercises the real recording pipeline against synthetic media.
 *
 * The recording code cannot be tested on a machine without ffmpeg and
 * mediasoup, so bugs in it have historically only surfaced when a class was
 * lost. This runs the SHIPPED argument builders through the SHIPPED ffmpeg,
 * using generated video, audio and whiteboard frames in place of a live
 * meeting, and then inspects the file that comes out.
 *
 * It would have caught the missing image-sequence start index -- the fault that
 * produced a 0-byte recording -- in about two seconds.
 *
 * Usage:  npm run check:recording
 * Exits non-zero if anything fails, so it can gate a deploy.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { buildComposeArgs, buildSdp, buildIngestArgs } = require("../src/recording/ffmpegArgs");
const { recordingFileName, dateStamp } = require("../src/recording/recordingName");
const { writeBoardFrame } = require("../src/recording/whiteboardFrame");
const { probeMedia, hasTool } = require("../src/recording/probeMedia");

let pass = 0;
let fail = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function run(cmd, args, label) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { ok: false, out: String(res.error.message) };
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  return { ok: res.status === 0, out, status: res.status };
}

const probe = (file) => probeMedia(file);

function main() {
  console.log("\nRecording pipeline check\n");

  console.log("0. tools");
  const hasFfmpeg = hasTool("ffmpeg");
  ok("ffmpeg present", hasFfmpeg, "install with: sudo dnf install ffmpeg");
  if (!hasFfmpeg) {
    console.log("\nCannot continue without ffmpeg.\n");
    process.exit(1);
  }
  // ffprobe is packaged separately in some distributions. It is preferred but
  // not required — stream details fall back to parsing `ffmpeg -i` output.
  if (hasTool("ffprobe")) {
    pass += 1;
    console.log("  PASS  ffprobe present");
  } else {
    console.log("  NOTE  ffprobe not installed — using ffmpeg -i for stream details");
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyn-rec-check-"));
  const DUR = 3;

  try {
    // ---- A synthetic stand-in for the ingest file: two video streams
    // (camera then screen) plus audio, exactly the shape the recorder captures.
    console.log("\n1. build a synthetic capture");
    const live = path.join(dir, "live.mkv");
    const gen = run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${DUR}`,
      "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${DUR}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${DUR}`,
      "-map", "0:v", "-map", "1:v", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-t", String(DUR), live,
    ]);
    ok("synthetic capture created", gen.ok && fs.existsSync(live), gen.out.slice(-300));
    const liveInfo = probe(live);
    ok("capture has 2 video + 1 audio", liveInfo?.videoCount === 2 && liveInfo?.audioCount === 1, JSON.stringify(liveInfo));

    // ---- Real whiteboard frames, written by the shipped renderer, numbered
    // from zero exactly as the recorder numbers them.
    console.log("\n2. whiteboard frames (numbered from zero, as the recorder writes them)");
    const frameDir = path.join(dir, "frames");
    fs.mkdirSync(frameDir);
    const strokes = [
      { color: "#163a6b", width: 4, canvasWidth: 1280, canvasHeight: 720,
        points: [{ nx: 0.1, ny: 0.1 }, { nx: 0.5, ny: 0.4 }, { nx: 0.8, ny: 0.2 }] },
    ];
    for (let i = 0; i < DUR; i += 1) {
      writeBoardFrame(path.join(frameDir, `board_${String(i).padStart(6, "0")}.ppm`), strokes);
    }
    const firstFrame = path.join(frameDir, "board_000000.ppm");
    ok("first frame is board_000000.ppm", fs.existsSync(firstFrame));
    ok("frames are non-empty", fs.statSync(firstFrame).size > 1000);
    const boardPattern = path.join(frameDir, "board_%06d.ppm");

    // ---- Layout 1: whiteboard main, camera inset. This is the combination
    // that silently produced a 0-byte file.
    console.log("\n3. compose — whiteboard main + camera inset");
    const out1 = path.join(dir, "board.mp4");
    const args1 = buildComposeArgs({
      livePath: live, boardPattern, outputPath: out1,
      camIndex: 0, screenIndex: null, hasAudio: true, boardFps: 1,
    });
    const r1 = run("ffmpeg", args1);
    ok("ffmpeg exited cleanly", r1.ok, r1.out.slice(-500));
    const size1 = fs.existsSync(out1) ? fs.statSync(out1).size : 0;
    ok("output is not 0 bytes", size1 > 2000, `size=${size1} bytes`);
    const i1 = probe(out1);
    ok("output has video", (i1?.videoCount || 0) >= 1, JSON.stringify(i1));
    ok("output has audio", (i1?.audioCount || 0) >= 1, JSON.stringify(i1));
    ok("output is the layout size", i1?.width === 1280 && i1?.height === 720, `${i1?.width}x${i1?.height}`);
    // Audio and video should span the same time; a large gap is the drift
    // symptom this pipeline exists to avoid.
    ok("duration matches the source", Math.abs((i1?.duration || 0) - DUR) < 1.5, `got ${i1?.duration}s, expected ~${DUR}s`);

    // ---- Layout 2: a shared screen takes the main area.
    console.log("\n4. compose — screen main + camera inset");
    const out2 = path.join(dir, "screen.mp4");
    const r2 = run("ffmpeg", buildComposeArgs({
      livePath: live, boardPattern, outputPath: out2,
      camIndex: 0, screenIndex: 1, hasAudio: true, boardFps: 1,
    }));
    ok("ffmpeg exited cleanly", r2.ok, r2.out.slice(-500));
    const i2 = probe(out2);
    ok("output is playable", (fs.existsSync(out2) ? fs.statSync(out2).size : 0) > 2000);
    ok("has video and audio", (i2?.videoCount || 0) >= 1 && (i2?.audioCount || 0) >= 1, JSON.stringify(i2));

    // ---- Layout 3: audio only, no camera and no screen.
    console.log("\n5. compose — board only, no camera");
    const out3 = path.join(dir, "boardonly.mp4");
    const r3 = run("ffmpeg", buildComposeArgs({
      livePath: live, boardPattern, outputPath: out3,
      camIndex: null, screenIndex: null, hasAudio: true, boardFps: 1,
    }));
    ok("ffmpeg exited cleanly", r3.ok, r3.out.slice(-500));
    ok("output is playable", (fs.existsSync(out3) ? fs.statSync(out3).size : 0) > 2000);

    // ---- Layout 4: silent capture, so no audio mapping at all.
    console.log("\n6. compose — no audio in the capture");
    const silent = path.join(dir, "silent.mkv");
    run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${DUR}`,
      "-map", "0:v", "-c:v", "libx264", "-preset", "ultrafast", "-t", String(DUR), silent,
    ]);
    const out4 = path.join(dir, "silent.mp4");
    const r4 = run("ffmpeg", buildComposeArgs({
      livePath: silent, boardPattern, outputPath: out4,
      camIndex: 0, screenIndex: null, hasAudio: false, boardFps: 1,
    }));
    ok("ffmpeg exited cleanly", r4.ok, r4.out.slice(-500));
    ok("output is playable", (fs.existsSync(out4) ? fs.statSync(out4).size : 0) > 2000);

    // ---- The ingest command must at least be accepted by this ffmpeg build.
    console.log("\n7. ingest arguments are valid for this ffmpeg");
    const sdp = buildSdp({
      audio: { remoteRtpPort: 20001, payloadType: 111, codecName: "opus", clockRate: 48000, channels: 2 },
      cam: { remoteRtpPort: 20002, payloadType: 96, codecName: "VP8", clockRate: 90000 },
    });
    const sdpPath = path.join(dir, "test.sdp");
    fs.writeFileSync(sdpPath, sdp);
    ok("sdp has audio and video", /m=audio /.test(sdp) && /m=video /.test(sdp));
    const ing = buildIngestArgs({ sdpPath, outputPath: path.join(dir, "x.mkv"), hasAudio: true });
    // No RTP will arrive, so a timeout is the expected outcome; an unknown
    // option or bad flag reports differently and is what we are looking for.
    const r5 = run("ffmpeg", ["-timeout", "1000000", ...ing]);
    const badFlag = /Unrecognized option|Option not found|Invalid argument/i.test(r5.out);
    ok("no unrecognised ffmpeg options", !badFlag, r5.out.slice(-400));

    console.log("\n8. output naming");
    ok("format is <meeting>_<DDMMMYY>.mp4", /^demo_\d{2}[A-Z]{3}\d{2}\.mp4$/.test(recordingFileName("demo")));
    ok("date stamp is 7 characters", dateStamp().length === 7, dateStamp());
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) {
    console.log("The recording pipeline is broken. Do not trust a class to it until this passes.\n");
  }
  process.exit(fail ? 1 : 0);
}

main();
