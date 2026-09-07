/**
 * Pictures pasted onto a whiteboard.
 *
 * They are stored so the other browsers in the room can fetch them, and for no
 * longer than the lesson that used them. What is tested here is the boundary:
 * only an image is accepted, a meeting id cannot climb out of the folder, and
 * both the sweep and the end of a meeting really do delete.
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

/** The eight bytes that make a file a PNG, and a little padding. */
const png = (extra = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);

test("a picture is stored where the other browsers can fetch it", () => {
  const stored = boardImages.save("10197", png());
  assert.match(stored.id, /^10197_\d+$/);
  assert.equal(stored.url, `/board-images/${stored.id}.png`);
  assert.ok(fs.existsSync(path.join(DIR, `${stored.id}.png`)));
});

test("anything that is not an image is refused", () => {
  for (const wrong of [
    Buffer.alloc(0),
    Buffer.from("not an image at all"),
    // A JPEG is a perfectly good image and still not what the board is sent.
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]),
    null,
    "a string",
  ]) {
    assert.throws(() => boardImages.save("10197", wrong), /empty|image/);
  }
});

test("a picture larger than a board could need is refused", () => {
  const huge = Buffer.concat([png(), Buffer.alloc(boardImages.MAX_BYTES)]);
  assert.throws(() => boardImages.save("10197", huge), /more than a board needs/);
});

test("a meeting id cannot reach outside the pictures folder", () => {
  const stored = boardImages.save("../../etc/passwd", png());
  assert.match(stored.id, /^_+etc_passwd_\d+$/);
  assert.equal(stored.url.includes(".."), false);
});

test("a meeting takes its pictures with it when it ends", () => {
  const mine = boardImages.save("10500", png());
  const other = boardImages.save("10501", png());

  const removed = boardImages.removeForMeeting("10500");
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(path.join(DIR, `${mine.id}.png`)), false);
  // Another meeting's materials are not this meeting's business.
  assert.ok(fs.existsSync(path.join(DIR, `${other.id}.png`)));
});

test("old pictures are swept, and this lesson's are left alone", () => {
  const kept = boardImages.save("10197", png());
  const old = boardImages.save("10197", png());

  const ago = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(path.join(DIR, `${old.id}.png`), ago / 1000, ago / 1000);

  const removed = boardImages.sweep();
  assert.ok(removed >= 1, `expected the old picture to go, removed ${removed}`);
  assert.ok(fs.existsSync(path.join(DIR, `${kept.id}.png`)));
  assert.equal(fs.existsSync(path.join(DIR, `${old.id}.png`)), false);
});

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});
