import React from "react";

/**
 * Meeting identity strip at the top of the side panel — which meeting you are
 * in. Informational only: copying the invite link is a staff action and lives
 * in the toolbar, so students see the ID without a share control.
 *
 * The class name sits beside the id because the id alone -- 10242, a
 * ScheduleID -- tells nobody which lesson they are in. It comes from the
 * platform's own ClassSubjectName, so it reads the same here as it does on the
 * site a student clicked through from. Absent for an ad-hoc room, which has no
 * schedule behind it to name, and the strip is then exactly what it was.
 *
 * @param {{ meetingId: string, className?: string|null }} props
 */
export default function MeetingInfo({ meetingId, className }) {
  if (!meetingId) return null;
  const name = typeof className === "string" ? className.trim() : "";
  return (
    <div className="meeting-info">
      <span className="mi-label">Meeting</span>
      <span className="mi-value" title={meetingId}>
        {meetingId}
      </span>
      {name ? (
        // title carries the whole thing: subject names run long and this strip
        // is narrow, so the visible text is often cut.
        <span className="mi-class" title={name}>
          {name}
        </span>
      ) : null}
    </div>
  );
}
