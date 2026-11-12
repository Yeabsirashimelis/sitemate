import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { Button, Code, Empty, ErrorNote, Loading, Section, Status, StatusIcon, Table, Td, Th, cx } from "../../components/ui";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { dayDate, longDate, plural, relativeTime, shortDate } from "../../lib/format";
import { keys, useCalendarStatus, useLookahead } from "../../lib/queries";
import { readinessLabel, readinessTone } from "../../lib/status";
import { useProjectContext } from "./layout";

/** Percent plan complete per week as thin columns, labelled on the latest week only. */
function PlanScore({ plans }: { plans: Array<{ weekStart: string; percentPlanComplete: number | null }> }) {
  const scored = plans.filter((p) => p.percentPlanComplete !== null).slice(-10);
  if (scored.length === 0) return <p className="text-[13px] text-ink-3">The first week is scored next Saturday.</p>;
  const height = 96;
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }} role="img" aria-label="Percent plan complete by week">
        {scored.map((p, i) => {
          const value = p.percentPlanComplete!;
          const last = i === scored.length - 1;
          return (
            <div key={p.weekStart} className="flex flex-1 flex-col items-center justify-end gap-1" title={`Week of ${shortDate(p.weekStart)}: ${value}%`}>
              {last ? <span className="text-[11px] font-medium tabular">{value}%</span> : null}
              <div className="w-full max-w-[24px] rounded-t-[4px] bg-series-1" style={{ height: `${Math.max(2, (value / 100) * (height - 18))}px`, opacity: last ? 1 : 0.55 }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-2 border-t border-rule-strong pt-1">
        {scored.map((p) => (
          <span key={p.weekStart} className="flex-1 text-center text-[10.5px] text-ink-3 tabular">
            {shortDate(p.weekStart)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function LookaheadTab() {
  const { project } = useProjectContext();
  const { data, isLoading, error } = useLookahead(project.id);
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const blocked = data.items.filter((i) => i.readiness === "blocked");
  const atRisk = data.items.filter((i) => i.readiness === "at_risk");
  const order = { blocked: 0, at_risk: 1, ready: 2 } as const;
  const items = [...data.items].sort((a, b) => order[a.readiness] - order[b.readiness] || a.startDate.localeCompare(b.startDate));

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Section title={`Three weeks ahead, ${shortDate(data.from)} to ${longDate(data.to)}`} aside={`${blocked.length} blocked · ${atRisk.length} at risk · ${data.items.length - blocked.length - atRisk.length} ready`}>
        {items.length === 0 ? (
          <Empty title="Nothing planned in the next three weeks" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Activity</Th>
                <Th>Dates</Th>
                <Th>Readiness</Th>
                <Th>What is missing</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.code} className={cx(item.readiness === "blocked" && "bg-[var(--critical-wash)]")}>
                  <Td>
                    <div className="flex items-baseline gap-2">
                      <Code>{item.code}</Code>
                      <span className="font-medium">{item.name}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-3">
                      {item.zone}
                      {item.critical ? " · critical" : ` · ${plural(item.totalFloat, "day")} float`}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap tabular text-ink-2">
                    {dayDate(item.startDate)}
                    <br />
                    {dayDate(item.finishDate)}
                  </Td>
                  <Td>
                    <Status tone={readinessTone[item.readiness]}>{readinessLabel[item.readiness]}</Status>
                  </Td>
                  <Td>
                    {item.constraints.length === 0 ? (
                      <span className="text-ink-3">Nothing</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {item.constraints.map((c, i) => (
                          <li key={i} className="flex gap-1.5">
                            <StatusIcon tone={c.severity === "blocking" ? "critical" : "warning"} className="mt-0.5 size-3.5" />
                            <span>{c.description}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <aside className="flex flex-col gap-8">
        <CalendarSync projectId={project.id} />
        <Section title="Percent plan complete">
          <PlanScore plans={data.plans} />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            Every Saturday the planning agent commits the coming week and scores the last one: the share of committed activities that actually finished.
          </p>
        </Section>
      </aside>
    </div>
  );
}

/** Where the look-ahead also lives: the team's Google Calendar. */
function CalendarSync({ projectId }: { projectId: string }) {
  const status = useCalendarStatus(projectId);
  const can = useCan();
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api(`/projects/${projectId}/calendar/sync`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.calendar(projectId) }),
  });
  if (!status.data) return null;
  return (
    <Section title="Google Calendar">
      {status.data.connected ? (
        <>
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
            <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            <span>
              {plural(status.data.events, "event")} on the team calendar: these activities, order-by dates, notice deadlines and RFI answers due.
              {status.data.lastSyncedAt ? ` Last change sent ${relativeTime(status.data.lastSyncedAt)}.` : ""}
            </span>
          </p>
          {can.manage ? (
            <Button size="sm" variant="secondary" className="mt-3" busy={sync.isPending} onClick={() => sync.mutate()}>
              Sync now
            </Button>
          ) : null}
          <ErrorNote error={sync.error} />
        </>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-3">Not connected. Set GOOGLE_CALENDAR_ID on the server to put the look-ahead and deadlines on the team calendar.</p>
      )}
    </Section>
  );
}
