const test = require("node:test");
const assert = require("node:assert");

const {
  normaliseView,
  throughView,
  fromView,
  normalizeStroke,
  renderPixels,
  FRAME_W,
  FRAME_H,
  BG_HEX,
} = require("../src/recording/whiteboardFrame");
const { pageKey } = require("../src/recording/boardPage");

const BYTES = FRAME_W * FRAME_H * 3;

function pixel(buf, x, y) {
  const i = (y * FRAME_W + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

/** A base page of one flat colour, so a sample says where it was read from. */
function solid(rgb) {
  const buf = Buffer.alloc(BYTES);
  for (let i = 0; i < BYTES; i += 3) {
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  }
  return buf;
}

test("a view is clamped the way the room clamps it", () => {
  assert.deepStrictEqual(normaliseView(), { scale: 1, tx: 0, ty: 0 });
  assert.deepStrictEqual(normaliseView({ scale: 0.1 }), { scale: 1, tx: 0, ty: 0 });
  assert.strictEqual(normaliseView({ scale: 99 }).scale, 6);
  // At scale 1 there is nothing off screen, so there is nowhere to pan.
  assert.strictEqual(normaliseView({ scale: 1, tx: 0.4 }).tx, 0);
  // At scale 2 the room is (1 - 1/2)/2 = 0.25.
  assert.strictEqual(normaliseView({ scale: 2, tx: 0.9 }).tx, 0.25);
  assert.strictEqual(normaliseView({ scale: 2, ty: -0.9 }).ty, -0.25);
  assert.strictEqual(normaliseView({ scale: NaN, tx: "x" }).tx, 0);
});

test("the view transform and its inverse agree", () => {
  for (const [scale, offset] of [[1, 0], [2, 0.1], [3.5, -0.2], [6, 0.25]]) {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const there = throughView(u, scale, offset);
      assert.ok(Math.abs(fromView(there, scale, offset) - u) < 1e-9, `${scale}/${offset}/${u}`);
    }
  }
});

test("the centre of the page stays the centre when there is no offset", () => {
  assert.strictEqual(throughView(0.5, 4, 0), 0.5);
});

test("strokes are magnified with the page, thickness included", () => {
  const stroke = {
    canvasWidth: FRAME_W,
    canvasHeight: FRAME_H,
    width: 4,
    points: [{ nx: 0.5, ny: 0.5 }, { nx: 0.75, ny: 0.5 }],
  };

  const flat = normalizeStroke(stroke);
  assert.strictEqual(flat.points[0].x, FRAME_W / 2);
  assert.strictEqual(flat.points[1].x, FRAME_W * 0.75);

  const zoomed = normalizeStroke(stroke, { scale: 2, tx: 0, ty: 0 });
  // The centre is fixed, and a point a quarter along moves twice as far from it.
  assert.strictEqual(zoomed.points[0].x, FRAME_W / 2);
  assert.strictEqual(zoomed.points[1].x, FRAME_W);
  assert.strictEqual(zoomed.width, flat.width * 2);
});

test("a stroke pushed off the edge by the zoom stays off the edge", () => {
  const s = normalizeStroke(
    { canvasWidth: FRAME_W, canvasHeight: FRAME_H, points: [{ nx: 0, ny: 0.5 }] },
    { scale: 4, tx: 0, ty: 0 },
  );
  // Clamping it to 0 would smear it along the border instead of letting it go.
  assert.ok(s.points[0].x < 0, `expected off-canvas, got ${s.points[0].x}`);
});

test("a frame with no page is the board's own background", () => {
  const buf = renderPixels([], null);
  assert.strictEqual(buf.length, BYTES);
  assert.deepStrictEqual(pixel(buf, 10, 10), [244, 247, 251]);
  // The ffmpeg padding colour has to be that same background, or a portrait
  // page would sit in a band of a different colour.
  assert.strictEqual(BG_HEX, "0xf4f7fb");
});

test("a page is copied through untouched when the view is flat", () => {
  const base = solid([10, 20, 30]);
  const buf = renderPixels([], base, { scale: 1, tx: 0, ty: 0 });
  assert.deepStrictEqual(pixel(buf, 0, 0), [10, 20, 30]);
  assert.deepStrictEqual(pixel(buf, FRAME_W - 1, FRAME_H - 1), [10, 20, 30]);
});

test("a base of the wrong size is ignored rather than drawn as noise", () => {
  const buf = renderPixels([], Buffer.alloc(128));
  assert.deepStrictEqual(pixel(buf, 5, 5), [244, 247, 251]);
});

test("a zoomed page is resampled, not left blank", () => {
  const base = solid([200, 100, 50]);
  const buf = renderPixels([], base, { scale: 3, tx: 0.1, ty: -0.1 });
  // Flat colour in, flat colour out -- what is being checked is that every
  // destination pixel found a source pixel rather than a hole.
  assert.deepStrictEqual(pixel(buf, 0, 0), [200, 100, 50]);
  assert.deepStrictEqual(pixel(buf, FRAME_W - 1, FRAME_H - 1), [200, 100, 50]);
  assert.deepStrictEqual(pixel(buf, FRAME_W >> 1, FRAME_H >> 1), [200, 100, 50]);
});

test("a stroke is drawn over the page", () => {
  const base = solid([255, 255, 255]);
  const buf = renderPixels(
    [
      {
        canvasWidth: FRAME_W,
        canvasHeight: FRAME_H,
        color: "#000000",
        width: 10,
        points: [{ nx: 0.4, ny: 0.5 }, { nx: 0.6, ny: 0.5 }],
      },
    ],
    base,
  );
  assert.deepStrictEqual(pixel(buf, FRAME_W >> 1, FRAME_H >> 1), [0, 0, 0]);
  assert.deepStrictEqual(pixel(buf, 5, 5), [255, 255, 255]);
});

test("a board is keyed by what is actually on it", () => {
  assert.strictEqual(pageKey(null), null);
  assert.strictEqual(pageKey({ strokes: [] }), null);
  assert.strictEqual(pageKey({ image: { id: "m_1" } }), "img:m_1");
  assert.strictEqual(pageKey({ document: { id: "m_2", page: 3 } }), "doc:m_2:3");
  // A document with no page yet is page one, not "undefined".
  assert.strictEqual(pageKey({ document: { id: "m_2" } }), "doc:m_2:1");
  // A picture and a document cannot both be showing; the picture is the one
  // the board keeps, and the key must not depend on which was set last.
  assert.strictEqual(pageKey({ image: { id: "a" }, document: { id: "b", page: 1 } }), "img:a");
});
