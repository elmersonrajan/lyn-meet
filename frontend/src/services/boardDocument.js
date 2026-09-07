/**
 * Rendering a document onto the board.
 *
 * Every browser renders the PDF for itself, a page at a time, with the
 * teacher's page number synchronised to the class. Sending pictures of pages
 * instead would be simpler here and worse everywhere else: a page rendered
 * locally is sharp at whatever size the student's screen happens to be, a
 * forty-page document costs one download rather than forty, and turning a page
 * is one number on the wire.
 *
 * pdf.js is loaded on demand. It is the largest thing in this application by
 * some distance, and most lessons never open a document -- there is no reason
 * for every student to download a PDF engine to watch a whiteboard.
 */

/** The board frame everything is drawn into, matching the server's own. */
export const PAGE_W = 1280;
export const PAGE_H = 720;

const PAGE_BG = "#ffffff";

let pdfjs = null;

async function library() {
  if (pdfjs) return pdfjs;
  const lib = await import("pdfjs-dist");
  /**
   * The worker is a separate file, and its URL has to be resolved by the
   * bundler rather than guessed at runtime -- this exact shape is what Vite
   * understands well enough to emit and fingerprint it.
   */
  lib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  pdfjs = lib;
  return pdfjs;
}

/**
 * Opens a document. The handle is kept by the caller so that turning a page
 * does not fetch and parse the file again.
 */
export async function openDocument(url) {
  const lib = await library();
  const task = lib.getDocument({ url, withCredentials: true });
  const doc = await task.promise;
  return { doc, pages: doc.numPages };
}

/**
 * Renders one page onto a canvas the size of a board frame.
 *
 * Fitted rather than filled, and centred on white: a page is A4 and a board is
 * 16:9, so something has to give, and cropping a page would cut off the part
 * being taught.
 *
 * @returns {Promise<HTMLCanvasElement>} ready to be drawn as the board's base
 */
export async function renderPage(doc, pageNumber) {
  const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, pageNumber)));
  const unscaled = page.getViewport({ scale: 1 });
  const scale = Math.min(PAGE_W / unscaled.width, PAGE_H / unscaled.height);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAGE_BG;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // Centred, so a portrait page sits in the middle of the board rather than
  // hard against its left edge.
  ctx.save();
  ctx.translate((PAGE_W - viewport.width) / 2, (PAGE_H - viewport.height) / 2);
  await page.render({ canvasContext: ctx, viewport }).promise;
  ctx.restore();

  return canvas;
}

/** What a teacher can put on the board, beyond an image. */
const DOCUMENT_TYPES = [".pdf", ".doc", ".docx", ".odt", ".rtf", ".ppt", ".pptx", ".odp"];

export function isDocument(file) {
  if (!file) return false;
  const name = String(file.name || "").toLowerCase();
  if (file.type === "application/pdf") return true;
  return DOCUMENT_TYPES.some((ext) => name.endsWith(ext));
}

/** Pulls a document out of a paste or a drop, ignoring anything else. */
export function documentFrom(dataTransfer) {
  if (!dataTransfer) return null;
  const files = [...(dataTransfer.files || [])];
  return files.find(isDocument) || null;
}
