import React from "react";

/**
 * Where recordings the server is still building have got to.
 *
 * Deliberately passive. Stopping a recording means the class is safely captured,
 * and the teacher is free to leave the moment they have pressed it — this is
 * here so that anyone who does stay can see the video being prepared, not
 * something they have to wait for. A finished recording drops off the list
 * shortly after it is announced.
 */
const LABEL = {
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

export default function RecordingStatus({ jobs }) {
  const shown = (jobs || []).filter((j) => j.status === "queued" || j.status === "processing");
  if (!shown.length) return null;

  return (
    <div className="rec-status">
      {shown.map((job) => (
        <div key={job.id} className={`rec-status-row ${job.status}`}>
          <span className="rec-status-dot" />
          <span>
            Recording · {LABEL[job.status] || job.status}
          </span>
        </div>
      ))}
    </div>
  );
}
