/**
 * Turning something pasted or dropped into pixels the board can hold.
 *
 * A teacher copies a diagram, a photograph of a page, or a screenshot of a PDF
 * or a Word document, and pastes it onto the whiteboard to write over. What
 * they paste can be any image format the browser can decode -- and what the
 * server receives is none of them. It gets raw pixels, already scaled here to
 * exactly the size of a board frame.
 *
 * That is a deliberate trade. The server has to composite this picture into
 * the class recording, and its frame renderer is a hand-written pixel buffer
 * with no image decoder in it. Sending pixels means no file format that a
 * client chose is ever parsed on the server: there is no decoder to get wrong
 * and no malformed file to be surprised by. It costs about 2.7 MB on the wire,
 * once, over a websocket -- which is a fraction of a second of screen share,
 * and is not subject to the upload limit on the proxy that refused every video
 * upload before it.
 */

/** The board frame the server composites into. Must match whiteboardFrame.js. */
export const FRAME_W = 1280;
export const FRAME_H = 720;

/** The paper the picture is laid on, matching the board's own background. */
const BOARD_BG = "#f4f7fb";

/**
 * Pulls an image out of a paste or a drop.
 *
 * A paste carries several representations of the same thing -- a screenshot is
 * offered as an image, a copied web image often as both an image and some HTML
 * -- so the image is looked for specifically rather than taking the first item.
 *
 * @returns {File|null}
 */
export function imageFrom(dataTransfer) {
  if (!dataTransfer) return null;
  const files = [...(dataTransfer.files || [])];
  const file = files.find((f) => f.type.startsWith("image/"));
  if (file) return file;

  for (const item of dataTransfer.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const asFile = item.getAsFile();
      if (asFile) return asFile;
    }
  }
  return null;
}

/**
 * Scales an image to fit a board frame, and returns its pixels.
 *
 * Fitted rather than filled: a page pasted from a document is the wrong shape
 * for a 16:9 board, and cropping it would cut off the part the teacher wanted.
 * The margins are the board's own background, so a fitted image looks like a
 * sheet of paper on the board rather than a picture in a letterbox.
 *
 * @param {File|Blob} file
 * @returns {Promise<Uint8Array>} FRAME_W * FRAME_H * 3 bytes of RGB
 */
export async function toBoardPixels(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image could not be read"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser cannot prepare that image");

    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);

    const scale = Math.min(FRAME_W / image.width, FRAME_H / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, (FRAME_W - width) / 2, (FRAME_H - height) / 2, width, height);

    const { data } = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
    // RGBA out, RGB across: the alpha is meaningless here, because everything
    // has already been composited onto the board's own background.
    const rgb = new Uint8Array(FRAME_W * FRAME_H * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return rgb;
  } finally {
    URL.revokeObjectURL(url);
  }
}
