import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { Button, Code, Empty, ErrorNote, Input, Loading, Section, Status, StatusIcon, Table, Td, Th, cx } from "../../components/ui";
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
  const [calendarId, setCalendarId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.calendar(projectId) });
    // The server fills or empties the calendar in the background.
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.calendar(projectId) }), 4000);
  };
  const sync = useMutation({
    mutationFn: () => api(`/projects/${projectId}/calendar/sync`, { method: "POST" }),
    onSettled: refresh,
  });
  const connect = useMutation({
    mutationFn: (id: string | null) => api("/company/calendar", { method: "PUT", body: { calendarId: id } }),
    onSuccess: () => {
      setConnecting(false);
      setCalendarId("");
      refresh();
    },
  });
  const data = status.data;
  if (!data || !data.available) return null;

  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate(calendarId.trim());
      }}
      className="flex flex-col gap-3"
    >
      <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-[12px] leading-relaxed text-ink-2">
        <li>In Google Calendar, create a calendar for your projects (Settings, Add calendar).</li>
        <li>
          Under <span className="font-medium">Share with specific people</span>, add{" "}
          <span className="break-all font-mono text-[11px] text-ink">{data.shareWith}</span> and choose{" "}
          <span className="font-medium">Make changes and see all event details</span>.
        </li>
        <li>
          Copy the <span className="font-medium">Calendar ID</span> from Integrate calendar and paste it here.
        </li>
      </ol>
      <Input required placeholder="…@group.calendar.google.com" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} />
      <ErrorNote error={connect.error} />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" busy={connect.isPending}>
          Connect
        </Button>
        {data.connected ? (
          <Button size="sm" variant="ghost" type="button" onClick={() => setConnecting(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );

  return (
    <Section title="Google Calendar">
      {data.connected && !connecting ? (
        <>
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
            <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            <span>
              {plural(data.events, "event")} on your calendar: these activities, order-by dates, notice deadlines and RFI answers due.
              {data.lastSyncedAt ? ` Last change sent ${relativeTime(data.lastSyncedAt)}.` : ""}
            </span>
          </p>
          {can.manage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" busy={sync.isPending} onClick={() => sync.mutate()}>
                Sync now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConnecting(true)}>
                Change calendar
              </Button>
              <Button size="sm" variant="ghost" busy={connect.isPending} onClick={() => connect.mutate(null)}>
                Disconnect
              </Button>
            </div>
          ) : null}
          <ErrorNote error={sync.error ?? connect.error} />
        </>
      ) : can.manage ? (
        <>
          {!data.connected ? (
            <p className="mb-3 text-[13px] leading-relaxed text-ink-2">Put the look-ahead, order-by dates and deadlines on your team's Google Calendar, kept up to date after every site report.</p>
          ) : null}
          {form}
        </>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-3">Not connected. A project manager can connect the team's Google Calendar here.</p>
      )}
    </Section>
  );
}
