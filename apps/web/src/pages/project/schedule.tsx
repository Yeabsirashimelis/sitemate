import { useMutation } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Gantt } from "../../components/gantt";
import { Button, Code, Empty, ErrorNote, Field, Input, Loading, Panel, Section, Select, Status, Table, Td, Th, cx } from "../../components/ui";
import { api } from "../../lib/api";
import { birr, dayDate, longDate, number, plural, relativeTime } from "../../lib/format";
import { useMeasures, useSchedule } from "../../lib/queries";
import type { WhatIfResult } from "../../lib/types";
import { useProjectContext } from "./layout";

function WhatIf({ projectId, codes, onResult }: { projectId: string; codes: Array<{ code: string; name: string }>; onResult: (r: WhatIfResult | null) => void }) {
  const [code, setCode] = useState(codes[0]?.code ?? "");
  const [days, setDays] = useState(3);
  const run = useMutation({
    mutationFn: () => api<{ result: WhatIfResult }>(`/projects/${projectId}/what-if`, { body: { activityCode: code, days } }),
    onSuccess: (data) => onResult(data.result),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate();
  };
  const result = run.data?.result;

  return (
    <Panel className="p-5">
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 size-4 text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">What if something slips?</h3>
          <p className="mt-0.5 text-[13px] text-ink-2">Try a delay on a copy of the schedule. Nothing is saved.</p>
          <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_auto] sm:items-end">
            <Field label="Activity">
              <Select value={code} onChange={(e) => setCode(e.target.value)}>
                {codes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Workdays late">
              <Input type="number" min={1} max={120} value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </Field>
            <Button type="submit" variant="primary" busy={run.isPending}>
              Try it
            </Button>
          </form>
          <div className="mt-3">
            <ErrorNote error={run.error} />
          </div>

          {result ? (
            <div className="mt-5 border-t border-rule pt-5">
              <p className="text-[15px] leading-relaxed">
                {result.slipDays > 0 ? (
                  <>
                    Handover moves <span className="font-semibold text-critical-text">{plural(result.slipDays, "workday")}</span>, from {longDate(result.finishBefore)} to{" "}
                    <span className="font-semibold">{longDate(result.finishAfter)}</span>.
                  </>
                ) : (
                  <>
                    No effect on the handover. <Code>{result.activityCode}</Code> has {plural(result.floatBefore, "workday")} of float, enough to absorb {plural(result.days, "day")}.
                  </>
                )}
                {result.newlyCritical.length ? <span className="text-ink-2"> It also makes {result.newlyCritical.join(", ")} critical.</span> : null}
              </p>

              {result.slipDays > 0 ? (
                result.recovery.options.length ? (
                  <div className="mt-4">
                    <div className="eyebrow mb-2">Recovery options, cheapest per day first</div>
                    <Table>
                      <thead>
                        <tr>
                          <Th>Measure</Th>
                          <Th align="right">Recovers</Th>
                          <Th align="right">Cost</Th>
                          <Th align="right">Per day</Th>
                          <Th>Risk</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.recovery.options.map((o) => (
                          <tr key={o.measureId} className={cx(result.recovery.plan.measureIds.includes(o.measureId) && "bg-[var(--good-wash)]")}>
                            <Td>{o.description}</Td>
                            <Td align="right">{plural(o.daysRecovered, "day")}</Td>
                            <Td align="right">{birr(o.cost)}</Td>
                            <Td align="right">{birr(o.costPerDay)}</Td>
                            <Td>
                              <Status tone={o.risk === "high" ? "critical" : o.risk === "medium" ? "warning" : "good"}>{o.risk}</Status>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    <p className="mt-3 text-[13px] text-ink-2">
                      Best plan: the highlighted measures for <span className="font-medium text-ink">{birr(result.recovery.plan.totalCost)}</span> recover{" "}
                      {plural(result.recovery.plan.daysRecovered, "day")}
                      {result.recovery.plan.remainingSlip > 0 ? `, leaving ${plural(result.recovery.plan.remainingSlip, "day")} of slip` : ", which holds the date"}.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-[13px] text-ink-2">None of the priced recovery measures help with this activity.</p>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ScheduleTable({ activities }: { activities: import("../../lib/types").ScheduleActivity[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Code</Th>
          <Th>Activity</Th>
          <Th>Start</Th>
          <Th>Finish</Th>
          <Th align="right">Done</Th>
          <Th align="right">Float</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {activities.map((a) => (
          <tr key={a.code}>
            <Td>
              <Code>{a.code}</Code>
            </Td>
            <Td>{a.name}</Td>
            <Td className="tabular">{dayDate(a.startDate)}</Td>
            <Td className="tabular">{dayDate(a.finishDate)}</Td>
            <Td align="right">{number(a.percentComplete)}%</Td>
            <Td align="right">{a.status === "complete" ? "–" : a.totalFloat}</Td>
            <Td>
              {a.status === "complete" ? (
                <Status tone="neutral">Complete</Status>
              ) : a.critical ? (
                <Status tone="critical">Critical</Status>
              ) : (
                <Status tone="good">{a.status === "in_progress" ? "In progress" : "Not started"}</Status>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ScheduleTab() {
  const { project } = useProjectContext();
  const { data, isLoading, error } = useSchedule(project.id);
  const measures = useMeasures(project.id);
  const [zoom, setZoom] = useState<"week" | "month">("week");
  const [view, setView] = useState<"chart" | "table">("chart");
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const schedule = data?.schedule;
  if (!schedule) return <Empty title="No schedule yet">Import the schedule from Excel or MS Project as CSV to start.</Empty>;

  const open = schedule.activities.filter((a) => a.status !== "complete" && a.duration > 0);
  const counts = {
    done: schedule.activities.filter((a) => a.status === "complete").length,
    running: schedule.activities.filter((a) => a.status === "in_progress").length,
    critical: schedule.activities.filter((a) => a.critical).length,
  };
  const highlight = whatIf ? [whatIf.activityCode, ...whatIf.newlyCritical] : [];

  return (
    <div className="flex flex-col gap-8">
      <WhatIf projectId={project.id} codes={open.map((a) => ({ code: a.code, name: a.name }))} onResult={setWhatIf} />

      <Section
        title="Programme"
        aside={`${plural(schedule.activities.length, "activity", "activities")} · ${counts.done} done · ${counts.running} under way · ${counts.critical} critical · calculated ${relativeTime(schedule.calculatedAt)}`}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-[4px] border border-rule-strong p-0.5">
            {(["chart", "table"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cx("rounded-[3px] px-3 py-1 text-[13px] capitalize", view === v ? "bg-ink text-page" : "text-ink-2 hover:text-ink")}>
                {v}
              </button>
            ))}
          </div>
          {view === "chart" ? (
            <div className="flex rounded-[4px] border border-rule-strong p-0.5">
              {(["week", "month"] as const).map((z) => (
                <button key={z} onClick={() => setZoom(z)} className={cx("rounded-[3px] px-3 py-1 text-[13px]", zoom === z ? "bg-ink text-page" : "text-ink-2 hover:text-ink")}>
                  {z === "week" ? "Weeks" : "Months"}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {view === "chart" ? <Gantt project={project} activities={schedule.activities} highlight={highlight} zoom={zoom} /> : <ScheduleTable activities={schedule.activities} />}
      </Section>

      <Section title="Priced recovery measures" aside="The schedule agent picks from these when a delay hits the critical path">
        {measures.data?.measures.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Activity</Th>
                <Th>Measure</Th>
                <Th>Change</Th>
                <Th align="right">Cost</Th>
                <Th>Risk</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {measures.data.measures.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Code>{m.activityCode}</Code>
                  </Td>
                  <Td>{m.description}</Td>
                  <Td className="text-ink-2">{m.change.kind === "shorten" ? `${plural(m.change.days, "day")} shorter` : `Overlap, ${m.change.type} ${m.change.lag >= 0 ? "+" : ""}${m.change.lag}`}</Td>
                  <Td align="right">{birr(m.cost)}</Td>
                  <Td>
                    <Status tone={m.risk === "high" ? "critical" : m.risk === "medium" ? "warning" : "good"}>{m.risk}</Status>
                  </Td>
                  <Td>{m.appliedAt ? <Status tone="neutral">Used {dayDate(m.appliedAt)}</Status> : <Status tone="info">Available</Status>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-[13px] text-ink-3">No recovery measures priced yet.</p>
        )}
      </Section>
    </div>
  );
}
