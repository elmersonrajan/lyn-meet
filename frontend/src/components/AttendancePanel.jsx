import React, { useCallback, useEffect, useState } from "react";
import { IconClipboard, IconClose, IconDownload, IconRefresh } from "./Icons.jsx";

const ROLE_LABEL = { teacher: "Teacher", coordinator: "Coordinator", student: "Student" };

function hhmmss(ms) {
  const total = Math.floor(Math.max(0, ms || 0) / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function clock(at) {
  if (!at) return "—";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

export default function AttendancePanel({ open, meetingId, onClose, onError }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance/${encodeURIComponent(meetingId)}`);
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      setReport(body.report);
    } catch (err) {
      console.error("[Attendance] load failed", err);
      onError?.(`Attendance unavailable: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [meetingId, onError]);

  // Open sessions keep counting, so refresh while the panel is visible.
  useEffect(() => {
    if (!open) return undefined;
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [open, load]);

  if (!open) return null;

  const people = report?.people || [];

  return (
    <div className="att-backdrop" onClick={onClose}>
      <section className="att-modal" onClick={(e) => e.stopPropagation()}>
        <header className="att-head">
          <h3>
            <IconClipboard size={17} />
            Attendance — {meetingId}
          </h3>
          <div className="att-actions">
            <button type="button" onClick={load} title="Refresh" disabled={loading}>
              <IconRefresh size={15} />
              {loading ? "…" : "Refresh"}
            </button>
            <a
              className="att-dl"
              href={`/api/attendance/${encodeURIComponent(meetingId)}/csv`}
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
          <p className="att-summary">
            <strong>{report.totals.people}</strong> total ·{" "}
            <strong>{report.totals.present}</strong> in the meeting now ·{" "}
            <strong>{report.totals.students}</strong> students
            {report.startedAt ? <> · started {clock(report.startedAt)}</> : null}
          </p>
        ) : null}

        <div className="att-scroll">
          {people.length ? (
            <table className="att-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Duration</th>
                  <th className="num">Sess.</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const key = `${p.name}::${p.role}`;
                  const isOpen = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={p.present ? "live" : ""}
                        onClick={() => setExpanded(isOpen ? null : key)}
                        title="Click for session breakdown"
                      >
                        <td>
                          <span className={`att-dot ${p.present ? "on" : ""}`} />
                          {p.name}
                        </td>
                        <td>
                          <span className={`role-tag ${p.role}`}>{ROLE_LABEL[p.role] || p.role}</span>
                        </td>
                        <td className="num">{clock(p.firstJoinAt)}</td>
                        <td className="num">{p.present ? "in meeting" : clock(p.lastLeaveAt)}</td>
                        <td className="num strong">{hhmmss(p.totalMs)}</td>
                        <td className="num">{p.sessionCount}</td>
                      </tr>
                      {isOpen && p.sessions.length ? (
                        <tr className="att-detail">
                          <td colSpan={6}>
                            <ul>
                              {p.sessions.map((s, i) => (
                                <li key={i}>
                                  <span className="att-seq">{i + 1}</span>
                                  {clock(s.joinedAt)} → {s.leftAt ? clock(s.leftAt) : "still in"}
                                  <span className="att-dur">
                                    {s.durationMs != null ? hhmmss(s.durationMs) : "running"}
                                  </span>
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
          Durations exclude time spent disconnected — a drop and rejoin counts as two sessions.
          People are matched by name, so duplicate names merge into one row.
        </footer>
      </section>
    </div>
  );
}
