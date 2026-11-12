import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { ApprovalCard } from "../../components/approval-card";
import { Code, Empty, Figure, Loading, Section, Status, StatusIcon } from "../../components/ui";
import { birr, dayDate, longDate, number, perfIndex, plural, relativeTime, slipText } from "../../lib/format";
import { useActivity, useApprovals, useClaims, useCost, useDailyLogs, useMaterials, useSchedule } from "../../lib/queries";
import { indexTone, materialState, slipTone } from "../../lib/status";
import { describeAction, groupFeed } from "../../lib/activity";
import { useProjectContext } from "./layout";

export function OverviewTab() {
  const { project } = useProjectContext();
  const schedule = useSchedule(project.id);
  const cost = useCost(project.id);
  const materials = useMaterials(project.id);
  const approvals = useApprovals("pending");
  const claims = useClaims(project.id);
  const logs = useDailyLogs(project.id);
  const activity = useActivity(project.id);

  if (schedule.isLoading) return <Loading />;
  const s = schedule.data?.schedule;
  const tone = slipTone(s?.slipDays);
  const pending = (approvals.data?.approvals ?? []).filter((a) => a.projectId === project.id);
  const critical = (s?.activities ?? []).filter((a) => a.critical && a.status !== "complete").sort((a, b) => a.earlyStart - b.earlyStart);
  const short = (materials.data?.materials ?? []).filter((m) => materialState(m).needsAction);
  const toOrder = short.filter((m) => m.openOrderQuantity === 0);
  const summary = cost.data?.summary;
  const ld = project.liquidatedDamagesPerDay;

  return (
    <div className="grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-10">
        {/* The one number this page leads with */}
        <section className="grid gap-8 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>
            <div className="text-[12px] text-ink-3">Forecast handover</div>
            <div className="mt-1 text-[48px] font-semibold leading-none tracking-[-0.025em]">{s ? longDate(s.finishDate) : "–"}</div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <Status tone={tone} className="!text-[13px]">
                {slipText(s?.slipDays)}
              </Status>
              <span className="text-[13px] text-ink-2">Contract {longDate(project.contractFinish)}</span>
            </div>
            {s && s.slipDays > 0 && ld ? (
              <p className="mt-3 max-w-md text-[13px] text-ink-2">
                At {birr(ld)} a day in delay damages, the current forecast exposes the company to about{" "}
                <span className="font-medium text-ink">{birr(ld * s.slipDays)}</span>.
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 border-t border-rule pt-5 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0">
            <Figure label="Schedule performance" value={perfIndex(summary?.spi)} tone={indexTone(summary?.spi)} note="Earned vs planned" />
            <Figure label="Cost performance" value={perfIndex(summary?.cpi)} tone={indexTone(summary?.cpi)} note="Earned vs spent" />
            <Figure
              label="Materials"
              value={toOrder.length ? `${number(toOrder.length)} to order` : short.length ? `${number(short.length)} raised` : "Covered"}
              tone={toOrder.some((m) => m.status === "order_now") ? "critical" : toOrder.length ? "warning" : short.length ? "info" : "good"}
              note={short.length && !toOrder.length ? "Waiting for approval or delivery" : undefined}
            />
            <Figure
              label="Claims file"
              value={claims.data?.totals.open ? number(claims.data.totals.open) : "None open"}
              note={claims.data?.totals.open ? `${plural(claims.data.totals.claimableDays, "workday")} claimable` : "Nothing to notify"}
            />
          </div>
        </section>

        <Section title="Waiting for your decision" aside={pending.length ? plural(pending.length, "request") : undefined}>
          {pending.length === 0 ? (
            <p className="text-[13px] text-ink-3">Nothing waiting. The agents will ask here and on Telegram when a decision is needed.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {pending.slice(0, 3).map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
              {pending.length > 3 ? (
                <Link to="/approvals" className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">
                  {plural(pending.length - 3, "more request")} <ArrowRight className="size-3.5" />
                </Link>
              ) : null}
            </div>
          )}
        </Section>

        <Section
          title="What drives the handover"
          aside={
            <Link to="schedule" className="inline-flex items-center gap-1 hover:text-ink">
              Open the schedule <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {critical.length === 0 ? (
            <Empty title="No critical activities">Either the schedule has not been calculated yet or everything has float.</Empty>
          ) : (
            <ol className="relative ml-1.5 border-l border-critical/50">
              {critical.slice(0, 7).map((a) => (
                <li key={a.code} className="relative py-1.5 pl-5">
                  <span className="absolute -left-[4.5px] top-[13px] size-2 rounded-full bg-critical" aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <Code>{a.code}</Code>
                    <span className="text-[13px] font-medium">{a.name}</span>
                    <span className="text-[12px] text-ink-3">
                      {dayDate(a.startDate)} to {dayDate(a.finishDate)}
                      {a.status === "in_progress" ? ` · ${number(a.percentComplete)}% done` : ""}
                    </span>
                  </div>
                </li>
              ))}
              {critical.length > 7 ? <li className="py-1.5 pl-5 text-[12px] text-ink-3">and {plural(critical.length - 7, "more activity", "more activities")} to handover</li> : null}
            </ol>
          )}
        </Section>
      </div>

      <aside className="flex min-w-0 flex-col gap-10">
        <Section title="Latest from site" aside={<Link to="logs" className="hover:text-ink">All logs</Link>}>
          <div className="flex flex-col divide-y divide-rule">
            {(logs.data?.logs ?? []).slice(0, 4).map((log) => (
              <div key={log.id} className="py-3 first:pt-0">
                <div className="flex items-baseline justify-between gap-2 text-[12px] text-ink-3">
                  <span className="font-medium text-ink-2">{dayDate(log.logDate)}</span>
                  <span>{log.supervisorName}</span>
                </div>
                <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed">{log.summary ?? (log.status === "awaiting_answer" ? `Waiting for an answer: ${log.followUpQuestion}` : "Collecting the report")}</p>
                {log.issues.length ? (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning-text">
                    <StatusIcon tone="warning" className="size-3.5" /> {plural(log.issues.length, "issue")} reported
                  </div>
                ) : null}
              </div>
            ))}
            {logs.data?.logs.length === 0 ? <p className="text-[13px] text-ink-3">No reports yet. Supervisors are asked every evening on Telegram.</p> : null}
          </div>
        </Section>

        {short.length ? (
          <Section title="Materials running short" aside={<Link to="materials" className="hover:text-ink">Materials</Link>}>
            <ul className="flex flex-col gap-2.5">
              {short.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span>
                    <span className="font-medium">{m.name}</span>
                    <span className="text-ink-3"> runs out {dayDate(m.runOutDate)}</span>
                  </span>
                  <Status tone={materialState(m).tone}>{materialState(m).label}</Status>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Agents today" aside={<Link to="activity" className="hover:text-ink">Activity</Link>}>
          <ul className="flex flex-col gap-2">
            {groupFeed((activity.data?.entries ?? []).filter((e) => e.actorType === "agent"))
              .slice(0, 6)
              .map(({ first, count }) => (
                <li key={first.id} className="text-[13px] leading-snug">
                  <span className="text-ink-2">{describeAction(first.action)}</span>
                  {count > 1 ? <span className="ml-1 text-[12px] font-medium text-ink tabular">×{count}</span> : null}
                  <span className="text-[12px] text-ink-3"> · {relativeTime(first.createdAt)}</span>
                </li>
              ))}
          </ul>
        </Section>
      </aside>
    </div>
  );
}
