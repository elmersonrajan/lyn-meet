import React from "react";

/**
 * What this person is being sent, and their say in it.
 *
 * The camera arrives as three sizes at once and the server picks a rung per
 * student from their own connection -- so almost nobody needs this. It exists
 * for the two cases the automatic answer gets wrong:
 *
 *   - a line so poor it cannot carry even the smallest picture, where the
 *     server takes the video away and this is what says so, rather than a
 *     frozen tile and a guess;
 *   - a student on metered data who would rather spend it on the lesson than
 *     on the teacher's face, and should not have to leave to do that.
 *
 * Deliberately quiet: a single unobtrusive control that only speaks up when
 * something has actually happened to the picture.
 */
const LABELS = {
  auto: "Automatic",
  low: "Save data",
  "audio-only": "Audio only",
};

export default function ConnectionQuality({ mode = "auto", automatic = false, onChange }) {
  const degraded = mode !== "auto";

  return (
    <div className={`quality${degraded ? " quality-degraded" : ""}`}>
      <label className="quality-label" htmlFor="quality-mode">
        {/* Named for what it does to their experience, not for the mechanism.
            "Simulcast layer" is true and useless to a fifteen-year-old. */}
        Video
      </label>
      <select
        id="quality-mode"
        className="quality-select"
        value={mode}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {Object.entries(LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {automatic && mode === "audio-only" ? (
        <span className="quality-note" role="status">
          Your connection could not carry the video, so the class is audio only. It will try the
          picture again shortly, or choose Automatic to try now.
        </span>
      ) : null}
    </div>
  );
}
