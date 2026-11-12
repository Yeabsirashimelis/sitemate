/**
 * Earned value S-curve: planned value, earned value and actual cost on one
 * birr axis. Three validated categorical slots, 2px lines, a legend plus
 * end labels, a crosshair that snaps to the nearest update, and a table view.
 */

import { useMemo, useRef, useState } from "react";
import { birr, birrCompact, longDate, shortDate } from "../lib/format";
import { Table, Td, Th, cx } from "./ui";

export interface Point {
  date: string;
  plannedValue: number;
  earnedValue: number;
  actualCost: number;
}

const SERIES = [
  { key: "plannedValue", label: "Planned value", color: "var(--series-1)" },
  { key: "earnedValue", label: "Earned value", color: "var(--series-2)" },
  { key: "actualCost", label: "Actual cost", color: "var(--series-3)" },
] as const;

const W = 760;
const H = 300;
const M = { top: 16, right: 116, bottom: 32, left: 64 };

/** A round step (1, 2, 2.5 or 5 times a power of ten) at or above the value. */
function niceStep(value: number): number {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

export function SCurve({ points }: { points: Point[] }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => {
    const peak = Math.max(1, ...points.flatMap((p) => [p.plannedValue, p.earnedValue, p.actualCost]));
    const step = niceStep(peak / 4);
    const max = Math.ceil(peak / step) * step;
    const times = points.map((p) => Date.parse(p.date));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times, t0 + 86_400_000);
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const x = (date: string) => M.left + ((Date.parse(date) - t0) / (t1 - t0)) * innerW;
    const y = (value: number) => M.top + innerH - (value / max) * innerH;
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
    return { x, y, ticks, max, innerW, innerH };
  }, [points]);

  if (points.length < 2) {
    return <p className="text-[13px] text-ink-3">The curve appears after the second schedule update with a bill of quantities in place.</p>;
  }

  const { x, y, ticks } = geometry;
  const last = points[points.length - 1]!;

  // End labels, pushed apart where lines finish close together, with a short leader to the line end.
  const ends = SERIES.map((s) => ({ ...s, value: last[s.key], target: y(last[s.key]) })).sort((a, b) => a.target - b.target);
  for (let i = 1; i < ends.length; i++) ends[i]!.target = Math.max(ends[i]!.target, ends[i - 1]!.target + 15);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]!.date) - px) < Math.abs(x(points[best]!.date) - px)) best = i;
    setHoverIndex(best);
  };
  const hovered = hoverIndex !== null ? points[hoverIndex] : undefined;
  // Date labels at least 56 units apart, always keeping the latest one.
  const xTicks: Point[] = [];
  for (const p of points.slice(0, -1)) {
    const previous = xTicks.at(-1);
    if ((!previous || x(p.date) - x(previous.date) >= 56) && x(last.date) - x(p.date) >= 56) xTicks.push(p);
  }
  xTicks.push(last);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="16" height="4" aria-hidden>
                <line x1="0" x2="16" y1="2" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
        <div className="flex rounded-[4px] border border-rule-strong p-0.5">
          {(["chart", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cx("rounded-[3px] px-2.5 py-0.5 text-[12px] capitalize", view === v ? "bg-ink text-page" : "text-ink-2 hover:text-ink")}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "table" ? (
        <Table>
          <thead>
            <tr>
              <Th>Status date</Th>
              {SERIES.map((s) => (
                <Th key={s.key} align="right">
                  {s.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <Td className="tabular">{longDate(p.date)}</Td>
                {SERIES.map((s) => (
                  <Td key={s.key} align="right">
                    {birr(p[s.key])}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="relative">
          <svg
            ref={svg}
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full touch-none"
            role="img"
            aria-label={`Earned value to ${longDate(last.date)}: planned ${birr(last.plannedValue)}, earned ${birr(last.earnedValue)}, spent ${birr(last.actualCost)}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHoverIndex(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--rule-strong)" : "var(--rule)"} />
                <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" className="tabular">
                  {birrCompact(t)}
                </text>
              </g>
            ))}
            {xTicks.map((p) => (
              <text key={p.date} x={x(p.date)} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--ink-3)" className="tabular">
                {shortDate(p.date)}
              </text>
            ))}

            {SERIES.map((s) => (
              <polyline
                key={s.key}
                points={points.map((p) => `${x(p.date)},${y(p[s.key])}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {ends.map((e) => (
              <g key={e.key}>
                <circle cx={x(last.date)} cy={y(e.value)} r={4} fill={e.color} stroke="var(--surface)" strokeWidth={2} />
                {Math.abs(e.target - y(e.value)) > 2 ? <line x1={x(last.date) + 6} x2={x(last.date) + 14} y1={y(e.value)} y2={e.target} stroke="var(--rule-strong)" /> : null}
                <text x={x(last.date) + 16} y={e.target + 4} fontSize={11.5} fill="var(--ink-2)" className="tabular">
                  {birrCompact(e.value)}
                </text>
              </g>
            ))}

            {hovered ? (
              <g pointerEvents="none">
                <line x1={x(hovered.date)} x2={x(hovered.date)} y1={M.top} y2={H - M.bottom} stroke="var(--ink-3)" />
                {SERIES.map((s) => (
                  <circle key={s.key} cx={x(hovered.date)} cy={y(hovered[s.key])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            ) : null}
          </svg>

          {hovered ? (
            <div
              className="pointer-events-none absolute top-2 z-10 w-[200px] rounded-[4px] border border-rule bg-surface px-3 py-2 text-[12px] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
              style={{ left: `clamp(0px, calc(${(x(hovered.date) / W) * 100}% + 12px), calc(100% - 200px))` }}
              role="tooltip"
            >
              <div className="mb-1 text-ink-3">{longDate(hovered.date)}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-ink-2">
                    <svg width="10" height="4" aria-hidden>
                      <line x1="0" x2="10" y1="2" y2="2" stroke={s.color} strokeWidth="2" />
                    </svg>
                    {s.label}
                  </span>
                  <span className="font-medium tabular">{birrCompact(hovered[s.key])}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
