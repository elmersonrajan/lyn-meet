/**
 * What a client is allowed to put on forty screens.
 *
 * Sharing a video and praising a student both take something the browser sent
 * and show it to the whole room, which makes this the boundary worth testing
 * hardest: a URL that is not YouTube's, a path that is not one this server
 * wrote, a message nobody chose. Everything here is a rejection test as much as
 * an acceptance one.
 *
 * Run with:  npm test
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  APPRECIATIONS,
  youtubeId,
  cleanTitle,
  buildMedia,
  mediaPublic,
} = require("../src/socket/sharedStage");

test("every shape of YouTube link a teacher might paste resolves to the video", () => {
  const id = "dQw4w9WgXcQ";
  const links = [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PLabc&index=2`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?t=42`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    // Pasted without the scheme, which is what a copied address bar often gives.
    `youtube.com/watch?v=${id}`,
    // Or just the id, copied out of a link by hand.
    id,
  ];
  for (const link of links) {
    assert.equal(youtubeId(link), id, link);
  }
});

test("anything that is not a YouTube video is refused", () => {
  const refused = [
    "",
    null,
    undefined,
    "https://vimeo.com/76979871",
    // The host check is a real check, not a substring one.
    "https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    // An id of the wrong length is not an id.
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=dQw4w9WgXcQtoolong",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    // A channel or a playlist is not a video.
    "https://www.youtube.com/@someone",
    "https://www.youtube.com/playlist?list=PLabc",
  ];
  for (const link of refused) {
    assert.equal(youtubeId(link), null, String(link));
  }
});

test("titles are shown to the room, so they are cleaned rather than trusted", () => {
  assert.equal(cleanTitle("  Lesson 4 intro  ", "fallback"), "Lesson 4 intro");
  assert.equal(cleanTitle("", "Video clip"), "Video clip");
  assert.equal(cleanTitle(null, "Video clip"), "Video clip");
  // Control characters can rearrange a line of text in a terminal or a log.
  assert.equal(cleanTitle("a\u0007b\u0000c", "fallback"), "abc");
  assert.equal(cleanTitle("x".repeat(500), "fallback").length, 120);
});

test("buildMedia keeps the id, never the URL the client sent", () => {
  const media = buildMedia({
    kind: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc",
    title: "Photosynthesis",
  });
  assert.equal(media.kind, "youtube");
  assert.equal(media.videoId, "dQw4w9WgXcQ");
  assert.equal(media.title, "Photosynthesis");
  assert.equal(media.positionSec, 0);
  assert.equal(media.paused, false);
  // The URL itself is not carried forward anywhere.
  assert.equal(JSON.stringify(media).includes("list=PLabc"), false);
});

test("refusing to share is an error the teacher can read", () => {
  assert.throws(() => buildMedia({ kind: "youtube", url: "https://vimeo.com/1" }), /YouTube/);
  assert.throws(() => buildMedia({ kind: "iframe", url: "https://x" }), /Unknown kind/);
  // Uploading a video file is gone; a video that is not on YouTube is played
  // by sharing the tab it is in, which never reaches this module at all.
  assert.throws(() => buildMedia({ kind: "clip", src: "/clips/x.mp4" }), /Unknown kind/);
  assert.throws(() => buildMedia({}), /Unknown kind/);
});

test("a student joining late is told where the video is now, not where it started", () => {
  const startedAt = Date.now() - 60000;
  const room = {
    media: {
      kind: "youtube",
      videoId: "dQw4w9WgXcQ",
      title: "x",
      positionSec: 30,
      paused: false,
      startedAt,
      updatedAt: startedAt,
    },
  };
  // A minute of play since the position was reported: 30 + 60.
  const live = mediaPublic(room, startedAt + 60000);
  assert.equal(live.positionSec, 90);

  // Paused means paused: the clock does not run on while nobody is watching.
  room.media.paused = true;
  const held = mediaPublic(room, startedAt + 60000);
  assert.equal(held.positionSec, 30);
});

test("nothing playing is nothing to report", () => {
  assert.equal(mediaPublic({ media: null }), null);
  assert.equal(mediaPublic({}), null);
  assert.equal(mediaPublic(null), null);
});

test("appreciation wording is the server's, and there are four of them", () => {
  assert.equal(APPRECIATIONS.length, 4);
  for (const award of APPRECIATIONS) {
    assert.match(award.id, /^[a-z-]+$/);
    assert.ok(award.emoji.length > 0);
    assert.ok(award.message.length > 0);
  }
  // Ids are what the client sends, so they have to be distinct.
  assert.equal(new Set(APPRECIATIONS.map((a) => a.id)).size, 4);
});
