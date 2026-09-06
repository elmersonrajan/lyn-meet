import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * A video the whole class watches together, with its sound.
 *
 * Every browser plays the video for itself, and the server says only WHICH
 * video and WHERE IN IT everyone should be. That is what carries the audio: a
 * clip shared as a screen arrives as silent pictures, and re-encoding it
 * through the SFU would spend a webcam's worth of bandwidth to deliver
 * something every student can already fetch at full quality. Playing locally
 * also means each student's own volume control works.
 *
 * The cost of that choice is drift, so a position update is applied whenever
 * the gap is big enough to notice and ignored when it is not -- correcting a
 * third of a second would be more disruptive than the third of a second.
 */

/** Below this, a correction would be more noticeable than the drift. */
const DRIFT_TOLERANCE_SEC = 1.5;

/**
 * Long enough for a slow tab to actually start, short enough that a student
 * staring at a still frame is offered the button quickly.
 */
const AUTOPLAY_GRACE_MS = 1500;

const YT_API_SRC = "https://www.youtube.com/iframe_api";
let youtubeApi = null;

/**
 * Loads YouTube's player once per page.
 *
 * The API announces itself through a single global callback, so anything
 * already waiting on it is chained rather than overwritten -- two players
 * mounting together must not leave one of them waiting forever.
 */
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (youtubeApi) return youtubeApi;

  youtubeApi = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        previous?.();
      } catch (err) {
        console.error("[SharedMedia] earlier YouTube callback failed", err);
      }
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = YT_API_SRC;
    tag.async = true;
    tag.onerror = () => {
      youtubeApi = null;
      reject(new Error("YouTube could not be reached from this network"));
    };
    document.head.appendChild(tag);
  });
  return youtubeApi;
}

/**
 * The banner across the top of the stage.
 *
 * Students are told what they are watching and that the teacher is driving;
 * staff get the one control that matters, which is stopping it.
 */
function MediaHeader({ media, canControl, onStop }) {
  return (
    <div className="media-head">
      <span className="media-kind">{media.kind === "youtube" ? "YouTube" : "Video"}</span>
      <span className="media-title">{media.title}</span>
      {canControl ? (
        <button type="button" className="btn ghost small" onClick={onStop}>
          Stop sharing
        </button>
      ) : (
        <span className="media-note">Playing for everyone</span>
      )}
    </div>
  );
}

/**
 * Offered only when the browser refuses to start on its own.
 *
 * Autoplay with sound needs the viewer to have interacted with the page.
 * Joining the meeting usually counts, but not always -- and a student watching
 * a silent video would assume the video is broken rather than that their
 * browser is being careful.
 */
function TapToPlay({ onTap }) {
  return (
    <button type="button" className="media-gesture" onClick={onTap}>
      <span className="media-gesture-icon">▶</span>
      Tap to play with sound
    </button>
  );
}

function ClipStage({ media, canControl, onControl, onStop }) {
  const ref = useRef(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  /**
   * Set while the player is being moved to match the server.
   *
   * Seeking a video fires the same events as a person seeking it, so without
   * this a correction sent to one browser would bounce back as a new command
   * from the teacher's, and the two would push each other around the timeline.
   */
  const applying = useRef(false);

  const applyState = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    applying.current = true;
    try {
      if (Math.abs(el.currentTime - media.positionSec) > DRIFT_TOLERANCE_SEC) {
        el.currentTime = media.positionSec;
      }
      if (media.paused) {
        el.pause();
        setNeedsGesture(false);
      } else {
        el.play()
          .then(() => setNeedsGesture(false))
          .catch((err) => {
            console.warn("[SharedMedia] autoplay refused", err.name);
            setNeedsGesture(true);
          });
      }
    } catch (err) {
      console.error("[SharedMedia] could not apply playback state", err);
    }
    // Cleared on a later tick: the events the changes above provoke arrive
    // asynchronously, and every one of them has to be recognised as ours.
    setTimeout(() => {
      applying.current = false;
    }, 400);
  }, [media.paused, media.positionSec]);

  useEffect(applyState, [applyState, media.src]);

  const report = (action) => {
    if (!canControl || applying.current) return;
    onControl({ action, positionSec: ref.current?.currentTime || 0 });
  };

  return (
    <div className="media-stage">
      <MediaHeader media={media} canControl={canControl} onStop={onStop} />
      <div className="media-frame">
        <video
          ref={ref}
          className="media-video"
          src={media.src}
          // Never muted: the sound is the point. Students get no controls, so
          // the class cannot drift apart by everyone scrubbing their own copy.
          controls={canControl}
          playsInline
          preload="auto"
          onPlay={() => report("play")}
          onPause={() => report("pause")}
          onSeeked={() => report("seek")}
        />
        {needsGesture ? (
          <TapToPlay
            onTap={() => {
              ref.current
                ?.play()
                .then(() => setNeedsGesture(false))
                .catch((err) => console.error("[SharedMedia] play failed", err));
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function YouTubeStage({ media, canControl, onControl, onStop }) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const applying = useRef(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [error, setError] = useState("");

  // Read inside callbacks that YouTube holds for the life of the player, so
  // they must not close over a stale render.
  const latest = useRef(media);
  latest.current = media;
  const controlRef = useRef(onControl);
  controlRef.current = onControl;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

  useEffect(() => {
    let cancelled = false;
    let player = null;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        player = new YT.Player(hostRef.current, {
          videoId: media.videoId,
          playerVars: {
            autoplay: 1,
            start: Math.floor(media.positionSec),
            // Students get no scrubber: the teacher decides where the class is.
            controls: canControl ? 1 : 0,
            disablekb: canControl ? 0 : 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onReady: (e) => {
              playerRef.current = e.target;
              applying.current = true;
              try {
                e.target.seekTo(latest.current.positionSec, true);
                if (latest.current.paused) e.target.pauseVideo();
                else e.target.playVideo();
              } catch (err) {
                console.error("[SharedMedia] YouTube start failed", err);
              }
              setTimeout(() => {
                applying.current = false;
                // If it has not started by now the browser has refused, and
                // the student needs to be told they can start it themselves.
                const state = playerRef.current?.getPlayerState?.();
                if (!latest.current.paused && state !== 1) setNeedsGesture(true);
              }, AUTOPLAY_GRACE_MS);
            },
            onStateChange: (e) => {
              if (e.data === 1) setNeedsGesture(false);
              if (!canControlRef.current || applying.current) return;
              // 1 playing, 2 paused. Everything else is buffering or ending,
              // which is this browser's business rather than the room's.
              if (e.data === 1) {
                controlRef.current({ action: "play", positionSec: e.target.getCurrentTime() });
              } else if (e.data === 2) {
                controlRef.current({ action: "pause", positionSec: e.target.getCurrentTime() });
              }
            },
            onError: () => setError("This video cannot be played here"),
          },
        });
      })
      .catch((err) => {
        console.error("[SharedMedia] YouTube API failed", err);
        setError(err.message);
      });

    return () => {
      cancelled = true;
      try {
        player?.destroy?.();
      } catch (err) {
        console.error("[SharedMedia] YouTube teardown failed", err);
      }
      playerRef.current = null;
    };
    // Rebuilt only for a different video: everything else is applied to the
    // player that is already running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.videoId]);

  // Server state, applied to a player that is already up.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || typeof player.getCurrentTime !== "function") return;
    applying.current = true;
    try {
      if (Math.abs(player.getCurrentTime() - media.positionSec) > DRIFT_TOLERANCE_SEC) {
        player.seekTo(media.positionSec, true);
      }
      if (media.paused) player.pauseVideo();
      else player.playVideo();
    } catch (err) {
      console.error("[SharedMedia] could not apply YouTube state", err);
    }
    setTimeout(() => {
      applying.current = false;
    }, 400);
  }, [media.paused, media.positionSec]);

  return (
    <div className="media-stage">
      <MediaHeader media={media} canControl={canControl} onStop={onStop} />
      <div className="media-frame">
        {error ? (
          <div className="media-error">{error}</div>
        ) : (
          <div className="media-youtube">
            <div ref={hostRef} />
          </div>
        )}
        {needsGesture && !error ? (
          <TapToPlay
            onTap={() => {
              try {
                playerRef.current?.playVideo();
                setNeedsGesture(false);
              } catch (err) {
                console.error("[SharedMedia] play failed", err);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function SharedMedia({ media, canControl, onControl, onStop }) {
  if (!media) return null;
  if (media.kind === "youtube") {
    return (
      <YouTubeStage media={media} canControl={canControl} onControl={onControl} onStop={onStop} />
    );
  }
  return <ClipStage media={media} canControl={canControl} onControl={onControl} onStop={onStop} />;
}
