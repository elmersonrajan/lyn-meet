import React, { useCallback, useEffect, useState } from "react";
import { IconClipboard, IconClose, IconDownload, IconRefresh } from "./Icons.jsx";

const ROLE_LABEL = { teacher: "Teacher", coordinator: "Coordinator", student: "Student" };

export default function AttendancePanel({ open, meetingId, onClose, onError }) {
  const [selectedId, setSelectedId] = useState(meetingId);
  const [meetings, setMeetings] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const isLive = selectedId === meetingId;

  // Reset to the live meeting whenever the panel is reopened.
  useEffect(() => {
    if (open) {
      setSelectedId(meetingId);
      setExpanded(null);
    }
  }, [open, meetingId]);

  const loadMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/attendance");
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      setMeetings(body.meetings || []);
    } catch (err) {
      console.error("[Attendance] meeting list failed", err);
    }
  }, []);

  const loadReport = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance/${encodeURIComponent(selectedId)}`);
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      setReport(body.report);
    } catch (err) {
      console.error("[Attendance] load failed", err);
      onError?.(`Attendance unavailable: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedId, onError]);

  useEffect(() => {
    if (!open) return undefined;
    loadMeetings();
    loadReport();
    // Only the meeting in progress has durations that keep advancing.
    if (!isLive) return undefined;
    const id = setInterval(loadReport, 15000);
    return () => clearInterval(id);
  }, [open, isLive, loadMeetings, loadReport]);

  if (!open) return null;

  const people = report?.people || [];
  const tz = report?.timezoneLabel || "IST";

  return (
    <div className="att-backdrop" onClick={onClose}>
      <section className="att-modal" onClick={(e) => e.stopPropagation()}>
        <header className="att-head">
          <h3>
            <IconClipboard size={17} />
            Attendance
          </h3>
          <div className="att-actions">
            <select
              className="att-select"
              value={selectedId || ""}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setExpanded(null);
              }}
              title="Choose a meeting"
            >
              {meetings.length === 0 && selectedId ? (
                <option value={selectedId}>{selectedId}</option>
              ) : null}
              {meetings.map((m) => (
                <option key={m.meetingId} value={m.meetingId}>
                  {m.meetingId}
                  {m.dateLabel ? ` — ${m.dateLabel}` : ""}
                  {m.peopleCount ? ` (${m.peopleCount})` : ""}
                  {m.meetingId === meetingId ? " • live" : ""}
                </option>
              ))}
            </select>
            <button type="button" onClick={loadReport} title="Refresh" disabled={loading}>
              <IconRefresh size={15} />
              {loading ? "…" : "Refresh"}
            </button>
            <a
              className="att-dl"
              href={`/api/attendance/${encodeURIComponent(selectedId || "")}/csv`}
              title="Download as CSV"
            >
              <IconDownload size={15} />
              CSV
            </a>
            <button type="button" className="att-close" onClick={onClose} aria-label="Close">
              <IconClose size={16} />
            </button>
          </div>
        </header>

        {report ? (
          <div className="att-meta">
            <div className="att-meta-row">
              <span className="att-k">Meeting ID</span>
              <span className="att-v mono">{report.meetingId}</span>
            </div>
            <div className="att-meta-row">
              <span className="att-k">Date</span>
              <span className="att-v">
                {report.meetingDate || "—"}
                {report.meetingWeekday ? (
                  <span className="att-sub"> ({report.meetingWeekday})</span>
                ) : null}
              </span>
            </div>
            <div className="att-meta-row">
              <span className="att-k">Started</span>
              <span className="att-v">
                {report.startedLabel || "—"} {tz}
              </span>
            </div>
            <div className="att-meta-row">
              <span className="att-k">Ended</span>
              <span className="att-v">
                {report.endedLabel ? `${report.endedLabel} ${tz}` : "in progress"}
              </span>
            </div>
            <div className="att-meta-row wide">
              <span className="att-k">Participants</span>
              <span className="att-v">
                <strong>{report.totals.people}</strong> total
                <span className="att-sub">
                  {" · "}
                  {report.totals.students} students · {report.totals.present} in meeting now
                </span>
              </span>
            </div>
          </div>
        ) : null}

        <div className="att-scroll">
          {people.length ? (
            <table className="att-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th className="num">In ({tz})</th>
                  <th className="num">Out ({tz})</th>
                  <th className="num">Duration</th>
                  <th className="num">Sess.</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p, idx) => {
                  const key = `${p.name}::${p.role}`;
                  const isOpen = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={p.present ? "live" : ""}
                        onClick={() => setExpanded(isOpen ? null : key)}
                        title="Click for session breakdown"
                      >
                        <td className="num dim">{idx + 1}</td>
                        <td>
                          <span className={`att-dot ${p.present ? "on" : ""}`} />
                          {p.name}
                        </td>
                        <td>
                          <span className={`role-tag ${p.role}`}>{ROLE_LABEL[p.role] || p.role}</span>
                        </td>
                        <td className="num">
                          {p.firstJoinLabel || "—"}
                          {p.firstJoinDateNote ? (
                            <span className="att-daytag">{p.firstJoinDateNote}</span>
                          ) : null}
                        </td>
                        <td className="num">
                          {p.present ? (
                            <span className="att-inmeet">still in</span>
                          ) : (
                            <>
                              {p.lastLeaveLabel || "—"}
                              {p.lastLeaveDateNote ? (
                                <span className="att-daytag">{p.lastLeaveDateNote}</span>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="num strong">{p.durationLabel}</td>
                        <td className="num">{p.sessionCount}</td>
                        <td>
                          <span className={`att-status ${p.present ? "in" : ""}`}>
                            {p.present ? "In meeting" : "Left"}
                          </span>
                        </td>
                      </tr>
                      {isOpen && p.sessions.length ? (
                        <tr className="att-detail">
                          <td colSpan={8}>
                            <ul>
                              {p.sessions.map((s, i) => (
                                <li key={i}>
                                  <span className="att-seq">{i + 1}</span>
                                  {s.joinedLabel}
                                  {s.joinedDateNote ? (
                                    <span className="att-daytag">{s.joinedDateNote}</span>
                                  ) : null}
                                  {" → "}
                                  {s.leftLabel || "still in"}
                                  {s.leftDateNote ? (
                                    <span className="att-daytag">{s.leftDateNote}</span>
                                  ) : null}
                                  <span className="att-dur">{s.durationLabel || "running"}</span>
                                  <span className="att-reason">{s.reason}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="dock-empty">
              {loading ? "Loading…" : "No attendance recorded for this meeting yet."}
            </p>
          )}
        </div>

        <footer className="att-foot">
          All times {tz} ({report?.timezone || "Asia/Kolkata"}). Durations exclude time spent
          disconnected — a drop and rejoin counts as two sessions. People are matched by name, so
          duplicate names merge into one row.
          {report?.generatedLabel ? ` Generated ${report.generatedLabel}.` : ""}
        </footer>
      </section>
    </div>
  );
}
