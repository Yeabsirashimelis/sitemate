import { useState } from "react";
import { Link } from "react-router";
import { AGENT_NAMES } from "../lib/activity";
import { useCan } from "../lib/auth";
import { relativeTime, roleLabel } from "../lib/format";
import { useDecide } from "../lib/queries";
import type { Approval } from "../lib/types";
import { Button, ErrorNote, Status, Textarea, type Tone } from "./ui";

const KIND_LABEL: Record<string, string> = {
  schedule_change: "Schedule change",
  recovery_plan: "Recovery plan",
  purchase_request: "Purchase",
  supplier_message: "Supplier message",
  consultant_rfi: "RFI to consultant",
  delay_notice: "Delay notice",
  payment_claim: "Payment claim",
  client_report: "Client report",
};

const STATUS: Record<Approval["status"], { tone: Tone; label: string }> = {
  pending: { tone: "warning", label: "Waiting" },
  approved: { tone: "good", label: "Approved" },
  executed: { tone: "good", label: "Approved and done" },
  rejected: { tone: "neutral", label: "Rejected" },
  failed: { tone: "critical", label: "Approved, could not be done" },
  expired: { tone: "neutral", label: "Expired" },
};

/** Summary paragraphs after the lead: plain prose, with "- " lines as a list. */
function Details({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="mt-3 flex max-w-[72ch] flex-col gap-2.5 text-[13px] leading-relaxed text-ink-2">
      {paragraphs.map((paragraph, i) => {
        const lines = paragraph.split("\n");
        const items = lines.filter((line) => line.startsWith("- "));
        const text = lines.filter((line) => !line.startsWith("- ")).join("\n");
        return (
          <div key={i}>
            {text ? <p className="whitespace-pre-line">{text}</p> : null}
            {items.length ? (
              <ul className={"flex list-disc flex-col gap-1 pl-5 marker:text-ink-3" + (text ? " mt-1.5" : "")}>
                {items.map((item, j) => (
                  <li key={j}>{item.slice(2)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One decision for a person: what the agent proposes, why, on what evidence. */
export function ApprovalCard({ approval, projectName }: { approval: Approval; projectName?: string | undefined }) {
  const decide = useDecide();
  const can = useCan();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const status = STATUS[approval.status];
  const [lead, ...rest] = approval.summary.split("\n\n");

  return (
    <article className="rounded-[6px] border border-rule bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <span className="font-medium text-ink-2">{KIND_LABEL[approval.kind] ?? approval.kind}</span>
            <span>·</span>
            <span>{AGENT_NAMES[approval.requestedBy] ?? "Requested from the dashboard"}</span>
            <span>·</span>
            <span>{relativeTime(approval.createdAt)}</span>
            {projectName && approval.projectId ? (
              <>
                <span>·</span>
                <Link to={`/projects/${approval.projectId}`} className="underline-offset-2 hover:underline">
                  {projectName}
                </Link>
              </>
            ) : null}
          </div>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug">{approval.title}</h3>
        </div>
        <Status tone={status.tone}>{status.label}</Status>
      </header>

      <div className="px-5 py-4">
        <p className="max-w-[72ch] text-[14px] leading-relaxed">{lead}</p>
        {rest.length > 0 ? <Details paragraphs={rest} /> : null}
        {approval.evidence.length > 0 ? (
          <div className="mt-3 text-[12px] text-ink-3">
            <span className="font-medium text-ink-2">Based on </span>
            {approval.evidence.map((e) => e.label).join(" · ")}
          </div>
        ) : null}
        {approval.decisionNote ? <p className="mt-3 text-[13px] text-ink-2">Note: {approval.decisionNote}</p> : null}
        {approval.status === "failed" && approval.result && typeof approval.result === "object" && "error" in approval.result ? (
          <p className="mt-3 text-[13px] text-critical-text">{String((approval.result as { error: unknown }).error)}</p>
        ) : null}
      </div>

      {approval.status === "pending" ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-rule px-5 py-3">
          {can.approve ? (
            rejecting ? (
              <div className="flex w-full flex-col gap-2">
                <Textarea rows={2} placeholder="Why not? The agent and the team will see this." value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2">
                  <Button variant="danger" size="sm" busy={decide.isPending} onClick={() => decide.mutate({ id: approval.id, decision: "reject", note })}>
                    Reject
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button variant="primary" size="sm" busy={decide.isPending} onClick={() => decide.mutate({ id: approval.id, decision: "approve" })}>
                  Approve
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
                <span className="ml-auto text-[12px] text-ink-3">Needs the {roleLabel[approval.approverRole]?.toLowerCase()}</span>
              </>
            )
          ) : (
            <span className="text-[12px] text-ink-3">Waiting for the {roleLabel[approval.approverRole]?.toLowerCase()}</span>
          )}
          {decide.error ? (
            <div className="w-full">
              <ErrorNote error={decide.error} />
            </div>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
