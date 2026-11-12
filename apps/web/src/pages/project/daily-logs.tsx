import { Image as ImageIcon, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Code, Empty, ErrorNote, Loading, Status, StatusIcon, cx } from "../../components/ui";
import { mediaUrl } from "../../lib/api";
import { dayDate, number, plural } from "../../lib/format";
import { useDailyLogs } from "../../lib/queries";
import type { DailyLog } from "../../lib/types";
import { useProjectContext } from "./layout";

/** Loads a Telegram photo or voice note through the API, which checks access. */
function Media({ projectId, messageId, kind }: { projectId: string; messageId: string; kind: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    mediaUrl(`/projects/${projectId}/messages/${messageId}/media`)
      .then((u) => {
        revoked = u;
        setUrl(u);
      })
      .catch(() => setFailed(true));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [projectId, messageId]);

  if (failed) return <span className="text-[12px] text-ink-3">{kind === "photo" ? "Photo" : "Voice note"} not available</span>;
  if (!url) return <div className="h-24 w-32 animate-pulse rounded-[4px] bg-sunken" />;
  return kind === "photo" ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Site photo" className="h-24 w-32 rounded-[4px] border border-rule object-cover" />
    </a>
  ) : (
    <audio controls src={url} className="h-9 w-56" />
  );
}

const LOG_STATUS = {
  complete: { tone: "good", label: "Applied" },
  awaiting_answer: { tone: "warning", label: "Waiting for an answer" },
  collecting: { tone: "info", label: "Collecting" },
} as const;

function LogEntry({ log, projectId }: { log: DailyLog; projectId: string }) {
  const incoming = log.messages.filter((m) => m.direction === "in");
  const status = LOG_STATUS[log.status];
  return (
    <article className="grid gap-6 border-b border-rule py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* What the supervisor sent */}
      <div className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-[15px] font-semibold">{dayDate(log.logDate)}</h3>
          <span className="text-[12px] text-ink-3">{log.supervisorName} on Telegram</span>
        </div>
        <div className="flex flex-col gap-2">
          {incoming.map((m) => (
            <div key={m.id} className="max-w-[46ch] rounded-[10px] rounded-tl-[2px] bg-sunken px-3 py-2 text-[13px] leading-relaxed">
              {m.kind === "text" ? (
                m.text
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
                    {m.kind === "photo" ? <ImageIcon className="size-3.5" /> : <Mic className="size-3.5" />}
                    {m.kind === "photo" ? "Photo" : "Voice note"}
                  </span>
                  <Media projectId={projectId} messageId={m.id} kind={m.kind} />
                  {m.text ? <span>{m.text}</span> : null}
                </div>
              )}
            </div>
          ))}
          {log.followUpQuestion ? (
            <div className="ml-auto max-w-[46ch] rounded-[10px] rounded-tr-[2px] border border-rule px-3 py-2 text-[13px]">
              <span className="mb-0.5 block text-[11px] text-ink-3">SiteMate asked</span>
              {log.followUpQuestion}
            </div>
          ) : null}
        </div>
      </div>

      {/* What the agent understood */}
      <div className="min-w-0 rounded-[6px] border border-rule bg-surface px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow">What SiteMate recorded</span>
          <div className="flex items-center gap-3">
            {log.confidence !== null ? <span className="text-[12px] text-ink-3 tabular">{number(log.confidence * 100)}% sure</span> : null}
            <Status tone={status.tone}>{log.correctedBy ? "Corrected by a person" : status.label}</Status>
          </div>
        </div>
        {log.summary ? <p className="mt-2 text-[14px] leading-relaxed">{log.summary}</p> : null}

        <dl className="mt-4 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
          {log.progress.length ? (
            <div className="sm:col-span-2">
              <dt className="mb-1 text-[12px] text-ink-3">Progress</dt>
              <dd className="flex flex-col gap-1.5">
                {log.progress.map((p) => (
                  <div key={p.activityCode} className="flex items-center gap-3">
                    <Code className="w-14 shrink-0">{p.activityCode}</Code>
                    <div className="h-1.5 flex-1 rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-ink" style={{ width: `${p.percentComplete}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular text-ink-2">
                      {number(p.percentComplete)}%{p.quantityDone ? ` · +${number(p.quantityDone, 1)}` : ""}
                    </span>
                  </div>
                ))}
              </dd>
            </div>
          ) : null}
          {log.workers.length ? (
            <div>
              <dt className="mb-1 text-[12px] text-ink-3">Workers · {log.workers.reduce((s, w) => s + w.count, 0)}</dt>
              <dd className="text-ink-2">{log.workers.map((w) => `${w.count} ${w.trade.toLowerCase()}`).join(", ")}</dd>
            </div>
          ) : null}
          {log.materialsUsed.length || log.materialsReceived.length ? (
            <div>
              <dt className="mb-1 text-[12px] text-ink-3">Materials</dt>
              <dd className="text-ink-2">
                {log.materialsUsed.map((m) => `${number(m.quantity, 1)} ${m.unit} ${m.material.toLowerCase()} used`).join(", ")}
                {log.materialsReceived.length ? (
                  <div>{log.materialsReceived.map((m) => `${number(m.quantity)} ${m.unit} ${m.material.toLowerCase()} delivered`).join(", ")}</div>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {log.issues.length ? (
          <ul className="mt-4 flex flex-col gap-1.5 border-t border-rule pt-3 text-[13px]">
            {log.issues.map((issue, i) => (
              <li key={i} className="flex gap-2">
                <StatusIcon tone={issue.severity === "high" ? "critical" : "warning"} className="mt-0.5 size-3.5" />
                <span>
                  <span className="capitalize text-ink-3">{issue.kind}</span>
                  {issue.activityCode ? <Code className="mx-1">{issue.activityCode}</Code> : " "}
                  {issue.description}
                  {issue.delayDays ? <span className="font-medium"> · {plural(issue.delayDays, "workday")} lost</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

const PAGE = 14;

export function DailyLogsTab() {
  const { project } = useProjectContext();
  const { data, isLoading, error } = useDailyLogs(project.id);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [shown, setShown] = useState(PAGE);
  if (isLoading) return <Loading />;
  const logs = (data?.logs ?? []).filter((l) => !onlyIssues || l.issues.length > 0);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-2">On the left what the supervisor sent, on the right what SiteMate made of it.</p>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} className="accent-[var(--ink)]" />
          Only days with issues
        </label>
      </div>
      <ErrorNote error={error} />
      {logs.length === 0 ? (
        <Empty title={onlyIssues ? "No issues reported" : "No daily logs yet"}>Supervisors are asked every evening on Telegram.</Empty>
      ) : (
        <div className={cx("border-t border-rule")}>
          {logs.slice(0, shown).map((log) => (
            <LogEntry key={log.id} log={log} projectId={project.id} />
          ))}
          {logs.length > shown ? (
            <div className="py-4">
              <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, logs.length - shown)} earlier days
              </Button>
              <span className="ml-3 text-[12px] text-ink-3">{logs.length - shown} not shown</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
