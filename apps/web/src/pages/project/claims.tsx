import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Code, Dialog, Empty, ErrorNote, Field, Input, Loading, Section, Select, Status, Table, Td, Textarea, Th } from "../../components/ui";
import { api } from "../../lib/api";
import { dayDate, longDate, plural } from "../../lib/format";
import { keys, useClaims, useRfis, useSchedule } from "../../lib/queries";
import type { ClaimEvent, Rfi } from "../../lib/types";
import { useProjectContext } from "./layout";

const CAUSE: Record<string, string> = {
  weather: "Weather",
  late_information: "Late information",
  late_payment: "Late payment",
  client_change: "Client change",
  access: "Site access",
  supplier: "Supplier",
  other: "Other",
};

const EVENT_STATUS: Record<ClaimEvent["status"], { tone: "warning" | "good" | "neutral"; label: string }> = {
  open: { tone: "warning", label: "Notice not sent" },
  notified: { tone: "good", label: "Notice sent" },
  closed: { tone: "neutral", label: "Closed" },
};

const RFI_STATUS: Record<Rfi["status"], { tone: "neutral" | "warning" | "info" | "good"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warning", label: "Waiting for approval" },
  sent: { tone: "info", label: "Waiting for answer" },
  answered: { tone: "good", label: "Answered" },
  closed: { tone: "neutral", label: "Closed" },
};

function ClaimEventCard({ event }: { event: ClaimEvent }) {
  const [open, setOpen] = useState(false);
  const status = EVENT_STATUS[event.status];
  return (
    <article className="rounded-[6px] border border-rule bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-[12px] text-ink-3">
            {CAUSE[event.cause] ?? event.cause} · {event.responsible === "neutral" ? "Neutral event" : `${event.responsible[0]!.toUpperCase()}${event.responsible.slice(1)}'s risk`} · from {dayDate(event.startedOn)}
          </div>
          <h3 className="mt-0.5 text-[15px] font-semibold">{event.title}</h3>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Status tone={status.tone}>{status.label}</Status>
          <span className="text-[12px] font-medium tabular">{plural(event.delayDays, "workday")} on completion</span>
        </div>
      </header>
      <div className="border-t border-rule px-5 py-3.5">
        <p className="max-w-[72ch] text-[13px] leading-relaxed text-ink-2">{event.description}</p>
        <div className="mt-3">
          <div className="eyebrow mb-1.5">Evidence held</div>
          <ul className="flex flex-col gap-1 text-[13px]">
            {event.evidence.map((e, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-24 shrink-0 text-ink-3 tabular">{dayDate(e.date)}</span>
                <span className="w-20 shrink-0 capitalize text-ink-3">{e.type.replace("_", " ")}</span>
                <span>{e.note}</span>
              </li>
            ))}
          </ul>
        </div>
        {event.clauseRefs.length ? (
          <div className="mt-3 text-[12px] text-ink-3">
            Contract clauses: <Code>{event.clauseRefs.join(", ")}</Code>
          </div>
        ) : null}
        {event.noticeDraft ? (
          <div className="mt-3">
            <button onClick={() => setOpen((o) => !o)} className="text-[13px] font-medium underline-offset-2 hover:underline">
              {open ? "Hide the notice letter" : "Read the notice letter"}
            </button>
            {open ? <div className="mt-2 whitespace-pre-line rounded-[4px] bg-sunken px-4 py-3 text-[13px] leading-relaxed">{event.noticeDraft}</div> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function NewRfiDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { project } = useProjectContext();
  const schedule = useSchedule(project.id);
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [activityCode, setActivityCode] = useState("");
  const [dueInDays, setDueInDays] = useState(7);
  const create = useMutation({
    mutationFn: () => api(`/projects/${project.id}/rfis`, { body: { question, dueInDays, ...(activityCode ? { activityCode } : {}) } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.rfis(project.id) });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      setQuestion("");
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Ask the consultant">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Question" hint="Be specific: drawing number, grid line, what is unclear.">
          <Textarea rows={4} required minLength={10} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Activity waiting for the answer">
            <Select value={activityCode} onChange={(e) => setActivityCode(e.target.value)}>
              <option value="">None</option>
              {(schedule.data?.schedule.activities ?? [])
                .filter((a) => a.status !== "complete")
                .map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Answer within">
            <Input type="number" min={1} max={60} value={dueInDays} onChange={(e) => setDueInDays(Number(e.target.value))} />
          </Field>
        </div>
        <p className="text-[12px] text-ink-3">It goes to the project manager for approval first. If the answer comes late, the waiting time goes into the claims file.</p>
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Draft RFI
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AnswerDialog({ rfi, onClose }: { rfi: Rfi | null; onClose: () => void }) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [answeredOn, setAnsweredOn] = useState(project.dataDate);
  const record = useMutation({
    mutationFn: () => api(`/projects/${project.id}/rfis/${rfi!.id}/answer`, { body: { answer, answeredOn } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.rfis(project.id) });
      void queryClient.invalidateQueries({ queryKey: keys.claims(project.id) });
      setAnswer("");
      onClose();
    },
  });
  return (
    <Dialog open={rfi !== null} onClose={onClose} title={`Answer to RFI ${rfi?.number ?? ""}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          record.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-[13px] text-ink-2">{rfi?.question}</p>
        <Field label="Answer">
          <Textarea rows={3} required value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <Field label="Received on" hint={rfi ? `Due ${longDate(rfi.dueOn)}` : undefined}>
          <Input type="date" required value={answeredOn} onChange={(e) => setAnsweredOn(e.target.value)} className="w-44" />
        </Field>
        <ErrorNote error={record.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={record.isPending}>
            Record answer
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ClaimsTab() {
  const { project } = useProjectContext();
  const claims = useClaims(project.id);
  const rfis = useRfis(project.id);
  const [asking, setAsking] = useState(false);
  const [answering, setAnswering] = useState<Rfi | null>(null);

  if (claims.isLoading) return <Loading />;
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <Section title="Extension of time file" aside={claims.data ? `${plural(claims.data.totals.claimableDays, "workday")} claimable` : undefined}>
        <ErrorNote error={claims.error} />
        {claims.data?.events.length ? (
          <div className="flex flex-col gap-4">
            {claims.data.events.map((e) => (
              <ClaimEventCard key={e.id} event={e} />
            ))}
          </div>
        ) : (
          <Empty title="No claim events">
            When a delay is caused by the client, the consultant or exceptional weather, the claims agent opens an evidence file here as it happens.
          </Empty>
        )}
      </Section>

      <Section
        title="Requests for information"
        aside={
          <Button size="sm" icon={<MessageSquarePlus className="size-3.5" />} onClick={() => setAsking(true)}>
            New RFI
          </Button>
        }
      >
        {rfis.data?.rfis.length ? (
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Question</Th>
                <Th>Due</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rfis.data.rfis.map((r) => {
                const overdue = r.status === "sent" && r.dueOn < project.dataDate;
                return (
                  <tr key={r.id}>
                    <Td className="font-medium">{r.number}</Td>
                    <Td>
                      <div className="line-clamp-2">{r.question}</div>
                      {r.activityCode ? <Code>{r.activityCode}</Code> : null}
                      {r.answer ? <div className="mt-1 text-[12px] text-ink-2">Answer: {r.answer}</div> : null}
                    </Td>
                    <Td className="whitespace-nowrap tabular">{dayDate(r.dueOn)}</Td>
                    <Td>
                      {overdue ? <Status tone="critical">Overdue</Status> : <Status tone={RFI_STATUS[r.status].tone}>{RFI_STATUS[r.status].label}</Status>}
                      {r.status === "sent" ? (
                        <button onClick={() => setAnswering(r)} className="mt-1 block text-[12px] underline-offset-2 hover:underline">
                          Record answer
                        </button>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="text-[13px] text-ink-3">No RFIs yet.</p>
        )}
      </Section>
      <NewRfiDialog open={asking} onClose={() => setAsking(false)} />
      <AnswerDialog rfi={answering} onClose={() => setAnswering(null)} />
    </div>
  );
}
