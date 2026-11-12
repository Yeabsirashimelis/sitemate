import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, FileUp, Search } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Button, Dialog, Empty, ErrorNote, Field, Input, Loading, Section, Select, Status, cx } from "../../components/ui";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { relativeTime } from "../../lib/format";
import { keys, useDocuments } from "../../lib/queries";
import type { Answer, SearchHit } from "../../lib/types";
import { useProjectContext } from "./layout";

const KINDS = [
  { value: "contract", label: "Contract" },
  { value: "specification", label: "Specification" },
  { value: "boq", label: "Bill of quantities" },
  { value: "letter", label: "Letter" },
  { value: "minutes", label: "Meeting minutes" },
  { value: "other", label: "Other" },
];

const SUGGESTIONS = ["What is holding up the handover?", "How many days do we have to give notice of a delay?", "What concrete grade do the columns need?"];

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("contract");
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file");
      const mimeType = file.type || (file.name.endsWith(".pdf") ? "application/pdf" : "text/plain");
      return api(`/projects/${project.id}/documents`, {
        body: { title: title || file.name.replace(/\.[^.]+$/, ""), kind, fileName: file.name, mimeType, contentBase64: await readAsBase64(file) },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.documents(project.id) });
      setFile(null);
      setTitle("");
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    upload.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Upload a document">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="File" hint="PDF or text, up to 15 MB. It is read clause by clause so answers can quote the clause.">
          <input
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-[13px] file:mr-3 file:rounded-[4px] file:border file:border-rule-strong file:bg-surface file:px-3 file:py-1.5 file:text-[13px] file:text-ink"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title">
            <Input value={title} placeholder={file?.name} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorNote error={upload.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={upload.isPending}>
            Upload
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface Exchange {
  question: string;
  answer?: Answer;
  error?: unknown;
}

function AskSiteMate() {
  const { project } = useProjectContext();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Exchange[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (q: string) => api<Answer>(`/projects/${project.id}/ask`, { body: { question: q } }),
  });

  const send = async (q: string) => {
    const text = q.trim();
    if (text.length < 3 || ask.isPending) return;
    setQuestion("");
    setHistory((h) => [...h, { question: text }]);
    try {
      const answer = await ask.mutateAsync(text);
      setHistory((h) => h.map((e, i) => (i === h.length - 1 ? { ...e, answer } : e)));
    } catch (error) {
      setHistory((h) => h.map((e, i) => (i === h.length - 1 ? { ...e, error } : e)));
    }
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  return (
    <div className="flex min-h-[420px] flex-col rounded-[6px] border border-rule bg-surface">
      <div className="border-b border-rule px-5 py-3">
        <h3 className="text-[14px] font-semibold">Ask SiteMate</h3>
        <p className="text-[12px] text-ink-3">Answers come from this project's records and documents, with the source. If it is not there, SiteMate says so.</p>
      </div>
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {history.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void send(s)} className="rounded-[4px] border border-rule px-3 py-1.5 text-left text-[13px] text-ink-2 hover:border-rule-strong hover:text-ink">
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {history.map((e, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="ml-auto max-w-[85%] rounded-[10px] rounded-tr-[2px] bg-ink px-3 py-2 text-[13px] text-page">{e.question}</div>
            {e.answer ? (
              <div className="max-w-[92%]">
                <p className={cx("text-[14px] leading-relaxed", !e.answer.found && "text-ink-2")}>{e.answer.answer}</p>
                {e.answer.sources.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {e.answer.sources.map((s) => (
                      <span key={s.id} className="rounded-[3px] border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
                        {s.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : e.error ? (
              <ErrorNote error={e.error} />
            ) : (
              <div className="text-[13px] text-ink-3">Reading the records…</div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(question);
        }}
        className="flex items-center gap-2 border-t border-rule p-3"
      >
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about the schedule, materials, the contract…" aria-label="Question" />
        <Button type="submit" variant="primary" busy={ask.isPending} aria-label="Ask" icon={<ArrowUp className="size-4" />} />
      </form>
    </div>
  );
}

/** Queues a document again when reading failed or has been stuck for a while. */
function ReadAgain({ projectId, documentId }: { projectId: string; documentId: string }) {
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: () => api(`/projects/${projectId}/documents/${documentId}/read`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.documents(projectId) }),
  });
  return (
    <Button size="sm" variant="ghost" busy={read.isPending} onClick={() => read.mutate()}>
      Read again
    </Button>
  );
}

const STUCK_MS = 2 * 60_000;

export function DocumentsTab() {
  const { project } = useProjectContext();
  const { data, isLoading, error } = useDocuments(project.id);
  const can = useCan();
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const search = useMutation({
    mutationFn: (q: string) => api<{ results: SearchHit[] }>(`/projects/${project.id}/documents/search?q=${encodeURIComponent(q)}`),
  });

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-8">
        <Section
          title="Project documents"
          aside={
            can.manage ? (
              <Button size="sm" icon={<FileUp className="size-3.5" />} onClick={() => setUploading(true)}>
                Upload
              </Button>
            ) : null
          }
        >
          <ErrorNote error={error} />
          {isLoading ? <Loading /> : null}
          {data?.documents.length === 0 ? <Empty title="No documents yet">Upload the contract and the specification so SiteMate can answer from them and check site work.</Empty> : null}
          <ul className="divide-y divide-rule border-y border-rule">
            {data?.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">{d.title}</div>
                  <div className="text-[12px] text-ink-3">
                    {KINDS.find((k) => k.value === d.kind)?.label} · {d.fileName} · {relativeTime(d.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {can.manage && (d.status === "failed" || (d.status === "pending" && Date.now() - Date.parse(d.createdAt) > STUCK_MS)) ? (
                    <ReadAgain projectId={project.id} documentId={d.id} />
                  ) : null}
                  {d.status === "indexed" ? (
                    <Status tone="good">{d.chunks} clauses</Status>
                  ) : d.status === "pending" ? (
                    <Status tone="info">Reading</Status>
                  ) : (
                    <span title={d.error ?? undefined}>
                      <Status tone="critical">Could not read</Status>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Search the documents">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim().length >= 2) search.mutate(query.trim());
            }}
            className="flex gap-2"
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="C25, clause 14.4, curing, notice period…" aria-label="Search documents" />
            <Button type="submit" busy={search.isPending} icon={<Search className="size-4" />}>
              Search
            </Button>
          </form>
          <div className="mt-3">
            <ErrorNote error={search.error} />
          </div>
          <div className="mt-2 flex flex-col gap-3">
            {search.data?.results.map((hit) => (
              <div key={hit.id} className="rounded-[4px] border border-rule bg-surface px-4 py-3">
                <div className="text-[12px] text-ink-3">
                  {hit.documentTitle}
                  {hit.clause ? ` · clause ${hit.clause}` : ""}
                  {hit.page ? ` · page ${hit.page}` : ""}
                </div>
                <p className="mt-1 line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed">{hit.content}</p>
              </div>
            ))}
            {search.data && search.data.results.length === 0 ? <p className="text-[13px] text-ink-3">Nothing found.</p> : null}
          </div>
        </Section>
      </div>
      <AskSiteMate />
      <UploadDialog open={uploading} onClose={() => setUploading(false)} />
    </div>
  );
}
