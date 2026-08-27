import React from "react";
import ShareLink from "./ShareLink.jsx";

/**
 * Meeting identity strip at the top of the side panel: which meeting this is,
 * and a one-click invite link. Placed here rather than in the toolbar, which is
 * already crowded for staff.
 *
 * @param {{ meetingId: string, onToast?: (msg:string)=>void }} props
 */
export default function MeetingInfo({ meetingId, onToast }) {
  if (!meetingId) return null;
  return (
    <div className="meeting-info">
      <div className="mi-id">
        <span className="mi-label">Meeting</span>
        <span className="mi-value" title={meetingId}>
          {meetingId}
        </span>
      </div>
      <ShareLink meetingId={meetingId} variant="compact" onCopied={onToast} />
    </div>
  );
}
