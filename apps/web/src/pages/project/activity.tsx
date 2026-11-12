import { Bot, User as UserIcon, Wrench } from "lucide-react";
import { ErrorNote, Loading, Section, Status, Table, Td, Th } from "../../components/ui";
import { number, relativeTime } from "../../lib/format";
import { useActivity } from "../../lib/queries";
import { AGENT_NAMES, describeAction, groupFeed } from "../../lib/activity";
import { useProjectContext } from "./layout";

export function ActivityTab() {
  const { project } = useProjectContext();
  const { data, isLoading, error } = useActivity(project.id);
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const agents = data?.agents ?? [];
  const totals = agents.reduce((t, a) => ({ runs: t.runs + a.runs, tokens: t.tokens + a.inputTokens + a.outputTokens }), { runs: 0, tokens: 0 });

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Section title="What happened" aside="Every action, by a person or an agent, with its reason">
        <ol className="flex flex-col">
          {groupFeed(data?.entries ?? []).map(({ first: e, count }) => (
            <li key={e.id} className="flex gap-3 border-b border-rule py-2.5 text-[13px]">
              <span className="mt-0.5 text-ink-3" aria-hidden>
                {e.actorType === "agent" ? <Bot className="size-4" /> : e.actorType === "user" ? <UserIcon className="size-4" /> : <Wrench className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">
                    {describeAction(e.action)}
                    {count > 1 ? <span className="ml-1.5 text-[12px] font-normal text-ink-3 tabular">{count} times</span> : null}
                  </span>
                  <span className="text-[12px] text-ink-3">{count > 1 ? "latest " : ""}{relativeTime(e.createdAt)}</span>
                </div>
                {e.reason ? <p className="mt-0.5 line-clamp-2 text-ink-2">{e.reason}</p> : null}
                <span className="text-[12px] text-ink-3">{e.actorType === "agent" ? (AGENT_NAMES[e.actorId] ?? `${e.actorId} agent`) : e.actorType === "user" ? "A person" : "System"}</span>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <div className="flex flex-col gap-10">
        <Section title="AI usage" aside={`${number(totals.runs)} runs · ${number(totals.tokens)} tokens`}>
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th align="right">Runs</Th>
                <Th align="right">Errors</Th>
                <Th align="right">Tokens in / out</Th>
                <Th align="right">Avg time</Th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent}>
                  <Td className="font-medium">{AGENT_NAMES[a.agent] ?? a.agent}</Td>
                  <Td align="right">{number(a.runs)}</Td>
                  <Td align="right">{a.errors ? <Status tone="critical">{a.errors}</Status> : "0"}</Td>
                  <Td align="right">
                    {number(a.inputTokens)} / {number(a.outputTokens)}
                  </Td>
                  <Td align="right">{number(a.avgMs / 1000, 1)} s</Td>
                </tr>
              ))}
              {agents.length === 0 ? (
                <tr>
                  <Td colSpan={5} className="text-ink-3">
                    No AI calls yet.
                  </Td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </Section>

        <Section title="Recent runs">
          <ul className="flex flex-col divide-y divide-rule">
            {data?.recentRuns.slice(0, 15).map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                <div className="min-w-0">
                  <span className="font-medium">{AGENT_NAMES[r.agent] ?? r.agent}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-3">{r.trigger.split(":")[0]}</span>
                  {r.error ? <div className="truncate text-[12px] text-critical-text">{r.error}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[12px] text-ink-3">
                  <span className="tabular">{number(r.durationMs / 1000, 1)} s</span>
                  <span>{relativeTime(r.createdAt)}</span>
                  <Status tone={r.status === "ok" ? "good" : "critical"}>{r.status === "ok" ? "OK" : "Failed"}</Status>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
