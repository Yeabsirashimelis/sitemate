/**
 * Gantt chart in plain SVG.
 *
 * Time is in workdays (the schedule engine's own unit), so weekends and
 * holidays take no space and bars line up exactly with the critical path
 * maths. Colour carries one meaning: red is the critical path. Everything
 * else is ink at different weights, and the legend names every mark.
 */

import { WorkCalendar } from "@sitemate/engine";
import { useMemo, useRef, useState } from "react";
import { dayDate, number, plural, shortDate } from "../lib/format";
import type { Project, ScheduleActivity } from "../lib/types";
import { cx } from "./ui";

const ROW = 30;
const BAR = 12;
const HEADER = 44;
const LABEL_WIDTH = 300;

export interface GanttProps {
  project: Project;
  activities: ScheduleActivity[];
  /** Activities to draw attention to, e.g. the one in a what-if. */
  highlight?: string[];
  zoom?: "week" | "month";
}

interface Hover {
  activity: ScheduleActivity;
  x: number;
  y: number;
}

export function Gantt({ project, activities, highlight = [], zoom = "week" }: GanttProps) {
  const calendar = useMemo(() => new WorkCalendar(project.startDate, project.calendar), [project.startDate, project.calendar]);
  const [hover, setHover] = useState<Hover | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => [...activities].sort((a, b) => a.earlyStart - b.earlyStart || a.earlyFinish - b.earlyFinish || a.code.localeCompare(b.code)), [activities]);
  const dataDay = calendar.indexOf(project.dataDate);
  const contractDay = calendar.indexOf(project.contractFinish) + 1;

  const first = Math.min(0, ...rows.map((a) => Math.min(a.earlyStart, a.baselineStart ?? a.earlyStart)));
  const last = Math.max(contractDay, ...rows.map((a) => Math.max(a.lateFinish, a.earlyFinish, a.baselineFinish ?? 0))) + 3;
  const dayWidth = zoom === "week" ? 9 : 4;
  const width = (last - first) * dayWidth;
  const height = HEADER + rows.length * ROW + 8;
  const x = (day: number) => (day - first) * dayWidth;

  // Week ticks on the first workday of each week; month labels above them.
  const ticks = useMemo(() => {
    const result: Array<{ day: number; date: string; month: boolean }> = [];
    let previousWeek = "";
    let previousMonth = "";
    for (let day = first; day <= last; day++) {
      if (day < 0) continue;
      const date = calendar.dateOf(day);
      const monday = new Date(`${date}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const week = monday.toISOString().slice(0, 10);
      if (week === previousWeek) continue;
      previousWeek = week;
      const month = date.slice(0, 7);
      result.push({ day, date, month: month !== previousMonth });
      previousMonth = month;
    }
    return result;
  }, [calendar, first, last]);

  // Week labels give way to the TODAY tag and the contract finish label.
  const crowded = (day: number) => {
    const left = x(day);
    const right = left + 40;
    const today = x(dataDay);
    const contract = x(contractDay);
    return (right > today - 2 && left < today + 38) || (right > contract - 84 && left < contract);
  };

  const show = (activity: ScheduleActivity, rowIndex: number, event?: { clientX: number }) => {
    const box = wrapper.current?.getBoundingClientRect();
    const scroll = wrapper.current?.scrollLeft ?? 0;
    const pointerX = event && box ? event.clientX - box.left + scroll : LABEL_WIDTH + x(activity.earlyFinish);
    setHover({ activity, x: pointerX, y: HEADER + rowIndex * ROW });
  };

  return (
    <div className="relative">
      <Legend />
      <div ref={wrapper} className="relative overflow-x-auto rounded-[6px] border border-rule bg-surface" onPointerLeave={() => setHover(null)}>
        <svg width={LABEL_WIDTH + width} height={height} role="img" aria-label={`Gantt chart of ${rows.length} activities`} className="block">
          {/* Week grid and labels */}
          <g>
            {ticks.map((t) => (
              <g key={t.day} transform={`translate(${LABEL_WIDTH + x(t.day)},0)`}>
                <line y1={HEADER - 6} y2={height} stroke="var(--rule)" strokeWidth={1} />
                {t.month ? (
                  <text y={16} x={3} fontSize={11} fontWeight={600} fill="var(--ink-2)">
                    {new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${t.date}T00:00:00Z`))}
                  </text>
                ) : null}
                {zoom === "week" && !crowded(t.day) ? (
                  <text y={34} x={3} fontSize={10.5} fill="var(--ink-3)" className="tabular">
                    {shortDate(t.date)}
                  </text>
                ) : null}
              </g>
            ))}
            <line x1={0} x2={LABEL_WIDTH + width} y1={HEADER - 0.5} y2={HEADER - 0.5} stroke="var(--rule-strong)" />
          </g>

          {/* Rows */}
          {rows.map((a, i) => {
            const y = HEADER + i * ROW;
            const mid = y + ROW / 2;
            const isMilestone = a.earlyFinish === a.earlyStart;
            const done = a.status === "complete";
            const highlighted = highlight.includes(a.code);
            const color = done ? "var(--ink-3)" : a.critical ? "var(--critical)" : "var(--ink-2)";
            const barStart = x(a.earlyStart);
            const barWidth = Math.max(dayWidth, x(a.earlyFinish) - barStart);
            const progressWidth = done ? barWidth : (barWidth * a.percentComplete) / 100;
            return (
              <g
                key={a.code}
                tabIndex={0}
                aria-label={`${a.code} ${a.name}, ${dayDate(a.startDate)} to ${dayDate(a.finishDate)}${a.critical ? ", critical" : `, ${a.totalFloat} days float`}`}
                onPointerMove={(event) => show(a, i, event)}
                onFocus={() => show(a, i)}
                onBlur={() => setHover(null)}
                className="outline-none focus-visible:[&>rect:first-child]:fill-[var(--series-1-wash)]"
              >
                <rect x={0} y={y} width={LABEL_WIDTH + width} height={ROW} fill={highlighted ? "var(--warning-wash)" : hover?.activity.code === a.code ? "var(--surface-sunken)" : "transparent"} />
                <line x1={0} x2={LABEL_WIDTH + width} y1={y + ROW - 0.5} y2={y + ROW - 0.5} stroke="var(--rule)" strokeOpacity={0.6} />

                {/* Label column */}
                <text x={12} y={mid + 4} fontSize={11} fontFamily="var(--font-mono)" fill="var(--ink-3)">
                  {a.code}
                </text>
                <text x={68} y={mid + 4} fontSize={12.5} fill={done ? "var(--ink-3)" : "var(--ink)"} fontWeight={a.critical && !done ? 500 : 400}>
                  {a.name.length > 34 ? `${a.name.slice(0, 33)}…` : a.name}
                </text>

                <g transform={`translate(${LABEL_WIDTH},0)`}>
                  {/* Baseline */}
                  {a.baselineStart !== null && a.baselineFinish !== null && a.baselineFinish > a.baselineStart ? (
                    <rect x={x(a.baselineStart)} y={mid + BAR / 2 + 3} width={x(a.baselineFinish) - x(a.baselineStart)} height={2} rx={1} fill="var(--rule-strong)" />
                  ) : null}

                  {isMilestone ? (
                    <path d={`M${barStart} ${mid - 6} l6 6 l-6 6 l-6 -6 z`} fill={color} />
                  ) : (
                    <>
                      {/* Remaining work as a wash, done work solid */}
                      <rect x={barStart} y={mid - BAR / 2} width={barWidth} height={BAR} rx={2} fill={color} fillOpacity={done ? 0.45 : 0.25} />
                      {progressWidth > 0 ? <rect x={barStart} y={mid - BAR / 2} width={progressWidth} height={BAR} rx={2} fill={color} fillOpacity={done ? 0.45 : 1} /> : null}
                    </>
                  )}

                  {/* Total float as a whisker */}
                  {!done && !a.critical && a.totalFloat > 0 ? (
                    <g stroke="var(--ink-3)" strokeWidth={1}>
                      <line x1={x(a.earlyFinish) + 1} x2={x(a.lateFinish)} y1={mid} y2={mid} />
                      <line x1={x(a.lateFinish)} x2={x(a.lateFinish)} y1={mid - 4} y2={mid + 4} />
                    </g>
                  ) : null}
                </g>
              </g>
            );
          })}

          {/* Status date and contract finish */}
          <g transform={`translate(${LABEL_WIDTH},0)`} pointerEvents="none">
            <line x1={x(dataDay)} x2={x(dataDay)} y1={HEADER - 6} y2={height} stroke="var(--series-1)" strokeWidth={1.5} />
            <rect x={x(dataDay) - 1} y={HEADER - 13} width={36} height={13} rx={2} fill="var(--series-1)" />
            <text x={x(dataDay) + 3} y={HEADER - 3.5} fontSize={9.5} fontWeight={600} fill="#ffffff">
              TODAY
            </text>
            <line x1={x(contractDay)} x2={x(contractDay)} y1={HEADER - 6} y2={height} stroke="var(--ink)" strokeWidth={1.5} />
            <text x={x(contractDay) - 4} y={HEADER - 4} fontSize={10} fontWeight={600} textAnchor="end" fill="var(--ink)">
              Contract finish
            </text>
          </g>
          <line x1={LABEL_WIDTH - 0.5} x2={LABEL_WIDTH - 0.5} y1={0} y2={height} stroke="var(--rule-strong)" />
        </svg>

        {hover ? <Readout hover={hover} /> : null}
      </div>
    </div>
  );
}

function Readout({ hover }: { hover: Hover }) {
  const a = hover.activity;
  const slip = a.baselineFinish !== null ? a.earlyFinish - a.baselineFinish : null;
  const left = Math.max(LABEL_WIDTH + 8, hover.x + 14);
  return (
    <div
      className="pointer-events-none absolute z-10 w-[248px] rounded-[4px] border border-rule bg-surface px-3 py-2.5 text-[12px] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
      style={{ left, top: hover.y + ROW + 2 }}
      role="tooltip"
    >
      <div className="font-mono text-[11px] text-ink-3">{a.code}</div>
      <div className="font-medium leading-snug">{a.name}</div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-ink-3">Forecast</dt>
        <dd className="tabular">
          {dayDate(a.startDate)} to {dayDate(a.finishDate)}
        </dd>
        <dt className="text-ink-3">Progress</dt>
        <dd className="tabular">{a.status === "complete" ? "Complete" : `${number(a.percentComplete)}%`}</dd>
        <dt className="text-ink-3">Float</dt>
        <dd>{a.status === "complete" ? "–" : a.critical ? <span className="font-medium text-critical-text">Critical, no float</span> : plural(a.totalFloat, "workday")}</dd>
        {slip !== null && a.status !== "complete" ? (
          <>
            <dt className="text-ink-3">vs baseline</dt>
            <dd className={cx(slip > 0 && "text-critical-text")}>{slip === 0 ? "On baseline" : slip > 0 ? `${plural(slip, "workday")} later` : `${plural(-slip, "workday")} earlier`}</dd>
          </>
        ) : null}
        {a.startNoEarlierThan ? (
          <>
            <dt className="text-ink-3">Held until</dt>
            <dd>{dayDate(a.startNoEarlierThan)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function Legend() {
  const item = "inline-flex items-center gap-1.5";
  return (
    <div className="mb-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-ink-2">
      <span className={item}>
        <svg width="22" height="10" aria-hidden>
          <rect width="22" height="10" rx="2" fill="var(--critical)" />
        </svg>
        Critical path
      </span>
      <span className={item}>
        <svg width="22" height="10" aria-hidden>
          <rect width="22" height="10" rx="2" fill="var(--ink-2)" />
        </svg>
        Other work
      </span>
      <span className={item}>
        <svg width="22" height="10" aria-hidden>
          <rect width="22" height="10" rx="2" fill="var(--ink-2)" fillOpacity={0.18} />
          <rect width="9" height="10" rx="2" fill="var(--ink-2)" />
        </svg>
        Done and still to do
      </span>
      <span className={item}>
        <svg width="22" height="10" aria-hidden>
          <rect y="4" width="22" height="2" rx="1" fill="var(--rule-strong)" />
        </svg>
        Baseline
      </span>
      <span className={item}>
        <svg width="22" height="10" aria-hidden>
          <line x1="0" x2="20" y1="5" y2="5" stroke="var(--ink-3)" />
          <line x1="20" x2="20" y1="1" y2="9" stroke="var(--ink-3)" />
        </svg>
        Float
      </span>
    </div>
  );
}
