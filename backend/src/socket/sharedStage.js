/**
 * What the class is looking at together: a video, and praise thrown on screen.
 *
 * Everything the browser sends about shared media passes through here first.
 * The rule is that nothing a client typed is ever handed back out to the room
 * as-is -- a YouTube link becomes an eleven-character video id, and an
 * appreciation becomes one of exactly four messages chosen here. A field that arrives as free text
 * is a field that can arrive as anything, and this one lands on the screens of
 * a class of children.
 */

/**
 * The wording is fixed, and the client sends only an id.
 *
 * Four, because a teacher choosing between four things mid-lesson is choosing;
 * choosing between twelve is stopping to read.
 */
const APPRECIATIONS = [
  { id: "great-job", emoji: "\u{1F44F}", message: "Great Job!" },
  { id: "excellent", emoji: "\u{1F31F}", message: "Excellent!" },
  { id: "well-done", emoji: "\u{1F389}", message: "Well Done!" },
  { id: "outstanding", emoji: "\u{1F3C6}", message: "Outstanding!" },
];

/**
 * Every YouTube address a teacher might paste, reduced to the video id.
 *
 * Only the id is kept, never the URL they typed. The id is what goes into an
 * iframe on forty machines, so it is allowed to be eleven characters of
 * [A-Za-z0-9_-] and nothing else -- no query string a link could smuggle
 * through, no other host, no other kind of YouTube page.
 */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function youtubeId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // A bare id, which is what somebody who copied it out of a link will paste.
  if (YOUTUBE_ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = url.pathname.replace(/\/+$/, "");
  const candidate =
    url.searchParams.get("v") ||
    (url.hostname.toLowerCase().endsWith("youtu.be") ? path.slice(1) : null) ||
    (path.startsWith("/embed/") ? path.slice(7) : null) ||
    (path.startsWith("/shorts/") ? path.slice(8) : null) ||
    (path.startsWith("/live/") ? path.slice(6) : null);

  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

/**
 * Titles are shown on every screen in the room, so control characters go and
 * the length is capped -- a file name is not a place to keep anything that can
 * rearrange a line of text.
 */
function cleanTitle(title, fallback) {
  const text = String(title || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return text ? text.slice(0, 120) : fallback;
}

/**
 * Turns what staff asked to play into what the room will hold.
 *
 * Throws rather than returning null: refusing to share is a message the
 * teacher needs to read, not a silent no-op in front of a class.
 */
function buildMedia({ kind, url, title } = {}) {
  const now = Date.now();
  const base = { positionSec: 0, paused: false, startedAt: now, updatedAt: now };

  if (kind === "youtube") {
    const videoId = youtubeId(url);
    if (!videoId) throw new Error("That does not look like a YouTube video link");
    return { ...base, kind: "youtube", videoId, title: cleanTitle(title, "YouTube video") };
  }

  throw new Error("Unknown kind of media");
}

/**
 * What is playing, and where it has got to *now*.
 *
 * The room stores a position and the moment it was reported. Reading it back
 * this way is what lets a student who joins ten minutes into a video start ten
 * minutes in, rather than at the point the teacher last pressed something.
 */
function mediaPublic(room, now = Date.now()) {
  const media = room && room.media;
  if (!media) return null;
  const drift = media.paused ? 0 : Math.max(0, now - media.updatedAt) / 1000;
  return {
    kind: media.kind,
    title: media.title,
    videoId: media.videoId,
    paused: media.paused,
    positionSec: Number((media.positionSec + drift).toFixed(2)),
    startedAt: media.startedAt,
    serverTime: now,
  };
}

/** Tabs plus which one is live, the pair every board message carries. */
function boardsPublic(room) {
  return { boards: room.boardTabs(), activeBoardId: room.activeBoardId };
}

module.exports = {
  APPRECIATIONS,
  youtubeId,
  cleanTitle,
  buildMedia,
  mediaPublic,
  boardsPublic,
};
