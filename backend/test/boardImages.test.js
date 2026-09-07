/**
 * Pictures pasted onto a whiteboard.
 *
 * The thing worth testing here is the contract that keeps the server free of
 * an image decoder: what arrives is exactly one board frame of raw pixels, and
 * anything else is refused rather than stored and later composited into a
 * class recording as garbage.
 *
 * Run with:  npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lynmeet-boards-"));
process.env.BOARD_IMAGES_DIR = DIR;

const boardImages = require("../src/whiteboard/boardImages");
const { FRAME_W, FRAME_H } = require("../src/recording/whiteboardFrame");

const frame = (fill = 128) => Buffer.alloc(FRAME_W * FRAME_H * 3, fill);

test("a picture is stored as pixels for the recording and a PNG for the browsers", () => {
  const stored = boardImages.save("10197", frame(64));

  assert.match(stored.id, /^10197_\d+$/);
  assert.equal(stored.url, `/board-images/${stored.id}.png`);

  // The pixels, byte for byte, because the recorder composites them directly.
  const pixels = boardImages.pixels(stored.id);
  assert.equal(pixels.length, FRAME_W * FRAME_H * 3);
  assert.equal(pixels[0], 64);

  // And a real PNG beside them, for everyone's browser.
  const png = fs.readFileSync(path.join(DIR, `${stored.id}.png`));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("anything that is not one board frame of pixels is refused", () => {
  for (const wrong of [
    Buffer.alloc(0),
    Buffer.alloc(100),
    Buffer.alloc(FRAME_W * FRAME_H * 3 - 1),
    Buffer.alloc(FRAME_W * FRAME_H * 4),
    null,
    "not a buffer",
  ]) {
    assert.throws(() => boardImages.save("10197", wrong), /shape/);
  }
});

test("a meeting id cannot reach outside the pictures folder", () => {
  const stored = boardImages.save("../../etc/passwd", frame());
  assert.match(stored.id, /^_+etc_passwd_\d+$/);
  assert.equal(stored.url.includes(".."), false);
  assert.ok(fs.existsSync(path.join(DIR, `${stored.id}.rgb`)));
});

test("asking for a picture that is not there is an absence, not a crash", () => {
  assert.equal(boardImages.pixels("no-such-image"), null);
  assert.equal(boardImages.pixels(""), null);
  assert.equal(boardImages.pixels(null), null);
  // An id is checked before it reaches the filesystem.
  assert.equal(boardImages.pixels("../../../etc/passwd"), null);
  assert.equal(boardImages.pixels("a/b"), null);
});

test("old pictures are swept, and today's are left alone", () => {
  const kept = boardImages.save("10197", frame());
  const old = boardImages.save("10197", frame());

  // Two days back, which is past the one-day life of a lesson's pages.
  const ago = Date.now() - 48 * 60 * 60 * 1000;
  for (const ext of ["rgb", "png"]) {
    fs.utimesSync(path.join(DIR, `${old.id}.${ext}`), ago / 1000, ago / 1000);
  }

  const removed = boardImages.sweep();
  assert.ok(removed >= 2, `expected both files of the old picture to go, removed ${removed}`);
  assert.ok(fs.existsSync(path.join(DIR, `${kept.id}.rgb`)));
  assert.equal(fs.existsSync(path.join(DIR, `${old.id}.rgb`)), false);
});

test("the frame renderer draws strokes over the picture, not instead of it", () => {
  const { renderPng } = require("../src/recording/whiteboardFrame");
  const blank = renderPng([]);
  const overPicture = renderPng([], frame(200));
  // Same board, same (absent) strokes, different background: the picture is
  // reaching the recording rather than being ignored.
  assert.equal(blank.equals(overPicture), false);
});

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});
