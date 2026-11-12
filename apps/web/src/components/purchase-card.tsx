import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useCan } from "../lib/auth";
import { birr, dayDate, number, plural, relativeTime, roleLabel } from "../lib/format";
import { useDecide, useSuppliers } from "../lib/queries";
import type { PurchaseRequest } from "../lib/types";
import { Button, ErrorNote, Field, Input, Select, Status, cx, type Tone } from "./ui";

const STEPS = ["You approve", "Suppliers quote", "You pick a quote", "Ordered", "Delivered"] as const;

/** Where a request is in the buying process, and what is happening right now. */
function progress(p: PurchaseRequest): { step: number; tone: Tone; label: string; now: string } {
  if (p.status === "cancelled") return { step: -1, tone: "neutral", label: "Cancelled", now: "This request was turned down, nothing was ordered." };
  if (p.status === "delivered") return { step: 4, tone: "good", label: "Delivered", now: "Delivered and added to the stock on site." };
  if (p.status === "ordered") {
    const chosen = p.quotes.find((q) => q.id === p.selectedQuoteId) ?? p.quotes[0];
    return { step: 3, tone: "info", label: "Ordered", now: chosen ? `Ordered from ${chosen.supplierName}. The supervisor confirms delivery on Telegram.` : "Ordered. The supervisor confirms delivery on Telegram." };
  }
  if (p.approval?.step === "order") return { step: 2, tone: "warning", label: "Pick a quote", now: p.approval.title };
  if (p.status === "approved") {
    if (p.suppliersAsked === 0 && p.quotes.length === 0) {
      return {
        step: 1,
        tone: "warning",
        label: "Needs prices",
        now: `None of your ${p.material.name.toLowerCase()} suppliers are on Telegram yet, so nobody could be asked. Call them and record their prices here, or invite them from the supplier list below.`,
      };
    }
    const asked = p.suppliersAsked ? `Asked ${plural(p.suppliersAsked, "supplier")} on Telegram` : "Asking suppliers on Telegram";
    return {
      step: 1,
      tone: "info",
      label: "Asking suppliers",
      now: p.quotes.length ? `${asked}. ${plural(p.quotes.length, "price")} in so far, waiting for the rest.` : `${asked}. Waiting for their prices.`,
    };
  }
  return { step: 0, tone: "warning", label: "Needs your approval", now: "Approve and SiteMate asks the suppliers who carry it for prices. Nothing is bought yet." };
}

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]" aria-label="Buying steps">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-1.5">
            {i > 0 ? <span className={cx("h-px w-4", done || active ? "bg-ink-3" : "bg-rule-strong")} aria-hidden /> : null}
            <span
              className={cx(
                "flex size-4 items-center justify-center rounded-full border text-[10px] font-semibold",
                done ? "border-ink bg-ink text-page" : active ? "border-ink text-ink" : "border-rule-strong text-ink-3",
              )}
              aria-hidden
            >
              {done ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cx(active ? "font-medium text-ink" : done ? "text-ink-2" : "text-ink-3")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A price got by phone or in person, for suppliers who are not on Telegram. */
function RecordPrice({ request: p, onDone }: { request: PurchaseRequest; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useSuppliers();
  const all = data?.suppliers ?? [];
  const carrying = all.filter((s) => s.materials.some((m) => m.toLowerCase() === p.material.name.toLowerCase()));
  const options = carrying.length ? carrying : all;
  const [form, setForm] = useState({ supplierId: "", unitPrice: "", leadTimeDays: "2", note: "" });
  const supplierId = form.supplierId || options[0]?.id || "";
  const record = useMutation({
    mutationFn: () =>
      api(`/purchase-requests/${p.id}/quotes`, {
        body: {
          supplierId,
          unitPrice: Number(form.unitPrice),
          leadTimeDays: Number(form.leadTimeDays),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    record.mutate();
  };

  if (options.length === 0) return <p className="text-[13px] text-ink-3">Add a supplier in the list below first.</p>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Price per ${p.material.unit}, birr`}>
          <Input type="number" required min={0} step="any" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} autoFocus />
        </Field>
        <Field label="Delivers in, days">
          <Input type="number" required min={0} max={120} value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} />
        </Field>
      </div>
      <Field label="Note">
        <Input placeholder="Price includes transport to site" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </Field>
      <ErrorNote error={record.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" busy={record.isPending}>
          Save price
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="text-[12px] text-ink-3">Once every supplier asked has a price, SiteMate picks the cheapest that arrives in time and asks you to approve the order.</p>
    </form>
  );
}

export function PurchaseCard({ request: p }: { request: PurchaseRequest }) {
  const decide = useDecide();
  const can = useCan();
  const state = progress(p);
  const [recording, setRecording] = useState(false);
  const canRecord = can.manage && p.status === "approved" && p.approval?.step !== "order";
  const cost = p.quotes[0] ? p.quotes[0].unitPriceEtb * p.quantity : null;

  return (
    <article className="rounded-[6px] border border-rule bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold">
            {number(p.quantity)} {p.material.unit} of {p.material.name}
          </h3>
          <div className="mt-0.5 text-[12px] text-ink-3">
            Needed on site by {dayDate(p.neededBy)} · raised {relativeTime(p.createdAt)}
          </div>
        </div>
        <Status tone={state.tone}>{state.label}</Status>
      </header>

      <div className="px-5 py-3.5">
        <p className="max-w-[78ch] text-[13px] leading-relaxed text-ink-2">{p.reason}</p>
        {state.step >= 0 ? (
          <div className="mt-4">
            <Steps current={state.step} />
          </div>
        ) : null}
        <p className="mt-3 text-[13px] font-medium">{state.now}</p>
      </div>

      {p.quotes.length ? (
        <div className="border-t border-rule px-5 py-3">
          <div className="eyebrow mb-2">{plural(p.quotes.length, "price")} received, cheapest first</div>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {p.quotes.map((q, i) => (
              <li key={q.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={i === 0 ? "font-medium" : ""}>{q.supplierName}</span>
                <span className="tabular text-ink-2">
                  {birr(q.unitPriceEtb)} per {p.material.unit}
                  {q.currency !== "ETB" ? ` (${number(q.unitPrice, 2)} ${q.currency})` : ""} · delivers in {plural(q.leadTimeDays, "day")}
                  {q.note ? ` · ${q.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {cost ? <p className="mt-2 text-[12px] text-ink-3">At the cheapest price the order comes to about {birr(cost)}.</p> : null}
        </div>
      ) : null}

      {canRecord ? (
        <div className="border-t border-rule px-5 py-3">
          {recording ? (
            <RecordPrice request={p} onDone={() => setRecording(false)} />
          ) : (
            <Button size="sm" variant={p.suppliersAsked === 0 && p.quotes.length === 0 ? "primary" : "secondary"} onClick={() => setRecording(true)}>
              Record a price you got by phone
            </Button>
          )}
        </div>
      ) : null}

      {p.approval ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-rule px-5 py-3">
          {can.approve ? (
            <>
              <Button variant="primary" size="sm" busy={decide.isPending && decide.variables?.decision === "approve"} onClick={() => decide.mutate({ id: p.approval!.id, decision: "approve" })}>
                {p.approval.step === "order" ? "Approve this order" : "Approve, ask for prices"}
              </Button>
              <Button
                size="sm"
                busy={decide.isPending && decide.variables?.decision === "reject"}
                onClick={() => decide.mutate({ id: p.approval!.id, decision: "reject", note: "Not needed now" })}
              >
                Not now
              </Button>
              <span className="ml-auto text-[12px] text-ink-3">Also on Telegram for the {roleLabel[p.approval.approverRole]?.toLowerCase()}</span>
            </>
          ) : (
            <span className="text-[12px] text-ink-3">Waiting for the {roleLabel[p.approval.approverRole]?.toLowerCase()} to decide</span>
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
