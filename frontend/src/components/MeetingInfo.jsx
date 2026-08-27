import React from "react";

/**
 * Meeting identity strip at the top of the side panel — which meeting you are
 * in. Informational only: copying the invite link is a staff action and lives
 * in the toolbar, so students see the ID without a share control.
 *
 * @param {{ meetingId: string }} props
 */
export default function MeetingInfo({ meetingId }) {
  if (!meetingId) return null;
  return (
    <div className="meeting-info">
      <span className="mi-label">Meeting</span>
      <span className="mi-value" title={meetingId}>
        {meetingId}
      </span>
    </div>
  );
}
