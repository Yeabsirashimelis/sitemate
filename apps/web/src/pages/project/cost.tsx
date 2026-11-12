import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { SCurve } from "../../components/scurve";
import { Button, ErrorNote, Figure, Field, Input, Loading, Section, Status, Table, Td, Th } from "../../components/ui";
import { api, download } from "../../lib/api";
import { birr, birrCompact, longDate, number, perfIndex } from "../../lib/format";
import { keys, useCost, usePaymentClaims } from "../../lib/queries";
import { indexTone } from "../../lib/status";
import type { PaymentClaim } from "../../lib/types";
import { useProjectContext } from "./layout";

const CLAIM_STATUS: Record<PaymentClaim["status"], { tone: "good" | "warning" | "neutral" | "info"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warning", label: "Waiting for approval" },
  submitted: { tone: "info", label: "Submitted" },
  paid: { tone: "good", label: "Paid" },
};

const CATEGORY: Record<string, string> = { labour: "Labour", material: "Materials", equipment: "Equipment", subcontract: "Subcontract", other: "Other" };

export function CostTab() {
  const { project } = useProjectContext();
  const cost = useCost(project.id);
  const claims = usePaymentClaims(project.id);
  const queryClient = useQueryClient();
  const [periodEnd, setPeriodEnd] = useState(project.dataDate);
  const draft = useMutation({
    mutationFn: () => api(`/projects/${project.id}/payment-claims`, { body: { periodEnd } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.paymentClaims(project.id) });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  if (cost.isLoading) return <Loading />;
  if (cost.error) return <ErrorNote error={cost.error} />;
  const s = cost.data!.summary;
  const categories = Object.entries(cost.data!.costByCategory).sort(([, a], [, b]) => b - a);
  const totalSpent = categories.reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="flex flex-col gap-10">
      <section className="grid grid-cols-2 gap-x-8 gap-y-6 border-b border-rule pb-8 md:grid-cols-4">
        <Figure label="Contract value measured" value={birrCompact(s.budgetAtCompletion)} note="Budget at completion" />
        <Figure label="Work done by value" value={birrCompact(s.earnedValue)} note={`${number((s.earnedValue / Math.max(1, s.budgetAtCompletion)) * 100, 1)}% of the contract`} />
        <Figure label="Schedule performance" value={perfIndex(s.spi)} tone={indexTone(s.spi)} note={`${birrCompact(s.scheduleVariance)} against plan`} />
        <Figure
          label="Cost performance"
          value={perfIndex(s.cpi)}
          tone={indexTone(s.cpi)}
          note={s.estimateAtCompletion ? `Forecast final cost ${birrCompact(s.estimateAtCompletion)}` : "Not enough cost recorded"}
        />
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Section title="Earned value" aside={`To ${longDate(cost.data!.dataDate)}`}>
          <SCurve points={cost.data!.series} />
        </Section>
        <Section title="Spent by category" aside={birr(totalSpent)}>
          <ul className="flex flex-col gap-3">
            {categories.map(([category, amount]) => (
              <li key={category}>
                <div className="flex justify-between text-[13px]">
                  <span>{CATEGORY[category] ?? category}</span>
                  <span className="tabular text-ink-2">{birr(amount)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-sunken">
                  <div className="h-full rounded-full bg-series-1" style={{ width: `${(amount / Math.max(1, totalSpent)) * 100}%` }} />
                </div>
              </li>
            ))}
            {categories.length === 0 ? <li className="text-[13px] text-ink-3">No costs recorded yet.</li> : null}
          </ul>
        </Section>
      </div>

      <Section title="Interim payment claims" aside="Drafted from measured progress near month end, checked by the site engineer, approved by the project manager">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Claim up to">
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-44" />
          </Field>
          <Button icon={<FileText className="size-4" />} busy={draft.isPending} onClick={() => draft.mutate()}>
            Draft claim now
          </Button>
        </div>
        <ErrorNote error={draft.error} />
        {claims.data?.claims.length ? (
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Period to</Th>
                <Th align="right">This period</Th>
                <Th align="right">Retention held</Th>
                <Th align="right">Net due</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {claims.data.claims.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{c.number}</Td>
                  <Td className="tabular">{longDate(c.periodEnd)}</Td>
                  <Td align="right">{birr(c.cumulativeGross - c.previousGross)}</Td>
                  <Td align="right">{birr(c.retention)}</Td>
                  <Td align="right" className="font-medium">
                    {birr(c.netThisPeriod)}
                  </Td>
                  <Td>
                    <Status tone={CLAIM_STATUS[c.status].tone}>{CLAIM_STATUS[c.status].label}</Status>
                  </Td>
                  <Td align="right">
                    <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void download(`/projects/${project.id}/payment-claims/${c.id}/csv`, `payment-claim-${c.number}.csv`)}>
                      CSV
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-[13px] text-ink-3">No claims yet.</p>
        )}
      </Section>
    </div>
  );
}
