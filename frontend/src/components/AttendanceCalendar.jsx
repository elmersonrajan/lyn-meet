import React, { useMemo, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconUsers } from "./Icons.jsx";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The server writes dates as DD-MM-YYYY. */
export function parseDate(text) {
  const [d, m, y] = String(text || "").split("-").map(Number);
  if (!d || !m || !y) return null;
  return { day: d, month: m - 1, year: y };
}

const monthKey = (year, month) => `${year}-${month}`;

/**
 * Which days a class actually ran, as a month you can page through.
 *
 * A coordinator looking for a register knows the day it happened, not the
 * meeting ID and not its position in a list — so a dropdown of every
 * meeting-day ever held is the wrong shape for the question they are asking.
 *
 * Days with no class are drawn but greyed and inert, rather than left out. A
 * grid with holes in it stops reading as a calendar; keeping the shape intact
 * is what lets the marked days stand out at a glance.
 *
 * @param {{
 *   meetings: Array<{meetingId:string, date:string, startedAt:number,
 *     startedLabel:string, weekday:string, peopleCount:number}>,
 *   selectedDate: string|null,
 *   onPickDate: (date: string|null) => void,
 * }} props
 */
export default function AttendanceCalendar({
  meetings,
  selectedDate,
  selectedId,
  onPickDate,
}) {
  // Every meeting held on a given day, newest first within the day.
  const byDate = useMemo(() => {
    const map = new Map();
    for (const m of meetings || []) {
      if (!map.has(m.date)) map.set(m.date, []);
      map.get(m.date).push(m);
    }
    for (const list of map.values()) list.sort((a, b) => a.startedAt - b.startedAt);
    return map;
  }, [meetings]);

  // Opens on the month of whatever is selected, else the most recent class —
  // which is almost always the one being looked for.
  const [cursor, setCursor] = useState(() => {
    const anchor = parseDate(selectedDate) || parseDate(meetings?.[0]?.date);
    const now = new Date();
    return anchor
      ? { year: anchor.year, month: anchor.month }
      : { year: now.getFullYear(), month: now.getMonth() };
  });

  // Months that hold at least one class, so paging can skip empty stretches
  // instead of walking through them one at a time.
  const monthsWithClasses = useMemo(() => {
    const set = new Set();
    for (const m of meetings || []) {
      const p = parseDate(m.date);
      if (p) set.add(monthKey(p.year, p.month));
    }
    return set;
  }, [meetings]);

  const step = (delta) => {
    let { year, month } = cursor;
    // Look ahead for the next month that has something in it; if there is none,
    // move by one so the control never feels stuck.
    for (let i = 0; i < 36; i += 1) {
      month += delta;
      if (month < 0) { month = 11; year -= 1; }
      if (month > 11) { month = 0; year += 1; }
      if (monthsWithClasses.has(monthKey(year, month))) {
        setCursor({ year, month });
        return;
      }
    }
    setCursor((c) => {
      const m = c.month + delta;
      if (m < 0) return { year: c.year - 1, month: 11 };
      if (m > 11) return { year: c.year + 1, month: 0 };
      return { year: c.year, month: m };
    });
  };

  const hasEarlier = useMemo(
    () => [...monthsWithClasses].some((k) => {
      const [y, m] = k.split("-").map(Number);
      return y < cursor.year || (y === cursor.year && m < cursor.month);
    }),
    [monthsWithClasses, cursor],
  );
  const hasLater = useMemo(
    () => [...monthsWithClasses].some((k) => {
      const [y, m] = k.split("-").map(Number);
      return y > cursor.year || (y === cursor.year && m > cursor.month);
    }),
    [monthsWithClasses, cursor],
  );

  // Monday-first, which is how a school week is read.
  const firstOfMonth = new Date(cursor.year, cursor.month, 1);
  const lead = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const dateKey = (day) =>
    `${String(day).padStart(2, "0")}-${String(cursor.month + 1).padStart(2, "0")}-${cursor.year}`;

  const today = new Date();
  const isToday = (day) =>
    day === today.getDate() &&
    cursor.month === today.getMonth() &&
    cursor.year === today.getFullYear();

  const selectedMeetings = selectedDate ? byDate.get(selectedDate) || [] : [];

  return (
    <div className="att-cal">
      <div className="att-cal-head">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={!hasEarlier}
          title={hasEarlier ? "Earlier classes" : "No earlier classes"}
          aria-label="Previous month"
        >
          <IconChevronLeft size={15} />
        </button>
        <strong>
          {MONTHS[cursor.month]} {cursor.year}
        </strong>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={!hasLater}
          title={hasLater ? "Later classes" : "No later classes"}
          aria-label="Next month"
        >
          <IconChevronRight size={15} />
        </button>
      </div>

      <div className="att-cal-grid">
        {WEEKDAYS.map((w, i) => (
          <span className="att-cal-dow" key={i}>
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <span className="att-cal-pad" key={`pad${i}`} />;
          const key = dateKey(day);
          const held = byDate.get(key);
          const count = held ? held.length : 0;
          return (
            <button
              type="button"
              key={key}
              className={[
                "att-cal-day",
                count ? "has" : "empty",
                selectedDate === key ? "sel" : "",
                isToday(day) ? "today" : "",
              ].join(" ")}
              disabled={!count}
              onClick={() => onPickDate(selectedDate === key ? null : key)}
              title={
                count
                  ? `${count} ${count === 1 ? "class" : "classes"} on ${key}`
                  : "No class on this day"
              }
            >
              {day}
              {count > 1 ? <span className="att-cal-n">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {selectedDate ? (
        <div className="att-cal-day-list">
          <div className="att-cal-day-head">
            {selectedMeetings[0]?.weekday ? `${selectedMeetings[0].weekday}, ` : ""}
            {selectedDate}
          </div>
          {selectedMeetings.length ? (
            <ul>
              {selectedMeetings.map((m) => (
                <li key={`${m.meetingId}-${m.startedAt}`}>
                  <button
                    type="button"
                    className={m.meetingId === selectedId ? "sel" : ""}
                    onClick={() => onPickDate(selectedDate, m)}
                  >
                    <span className="att-cal-mid">{m.meetingId}</span>
                    <span className="att-cal-time">{m.startedLabel}</span>
                    <span className="att-cal-people">
                      <IconUsers size={12} />
                      {m.peopleCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="att-cal-none">No class on this day.</p>
          )}
        </div>
      ) : (
        <p className="att-cal-hint">Pick a highlighted day to see the classes held on it.</p>
      )}
    </div>
  );
}
