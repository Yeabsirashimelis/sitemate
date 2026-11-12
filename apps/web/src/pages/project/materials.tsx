import { useState } from "react";
import { AddMaterialDialog, SuppliersSection } from "../../components/material-setup";
import { Button, Code, Empty, ErrorNote, Loading, Section, Status, Table, Td, Th } from "../../components/ui";
import { useCan } from "../../lib/auth";
import { birr, dayDate, number, plural, relativeTime } from "../../lib/format";
import { useMaterials, usePurchases } from "../../lib/queries";
import { materialState } from "../../lib/status";
import type { MaterialRow, PurchaseRequest } from "../../lib/types";
import { useProjectContext } from "./layout";

/** Days of stock against the supplier lead time, as a meter. */
function Cover({ material }: { material: MaterialRow }) {
  if (!material.dailyUse) return <span className="text-[12px] text-ink-3">No planned use</span>;
  const days = material.onHand / material.dailyUse;
  const scale = Math.max(material.leadTimeDays * 3, 10);
  const fill = Math.min(1, days / scale);
  const lead = Math.min(1, material.leadTimeDays / scale);
  const color = material.status === "order_now" ? "bg-critical" : material.status === "order_soon" ? "bg-warning" : "bg-ink-2";
  return (
    <div className="w-44">
      <div className="relative h-1.5 rounded-full bg-sunken">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${fill * 100}%` }} />
        <div className="absolute -top-1 h-3.5 w-px bg-ink" style={{ left: `${lead * 100}%` }} title={`Lead time ${material.leadTimeDays} days`} />
      </div>
      <div className="mt-1 text-[11px] text-ink-3 tabular">
        {plural(Math.round(days), "day")} · lead {material.leadTimeDays}
      </div>
    </div>
  );
}

const PURCHASE_STATUS: Record<PurchaseRequest["status"], { tone: "good" | "warning" | "neutral" | "info" | "critical"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warning", label: "Waiting for approval" },
  approved: { tone: "info", label: "Asking suppliers" },
  ordered: { tone: "info", label: "Ordered" },
  delivered: { tone: "good", label: "Delivered" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function MaterialsTab() {
  const { project } = useProjectContext();
  const materials = useMaterials(project.id);
  const purchases = usePurchases(project.id);
  const can = useCan();
  const [adding, setAdding] = useState(false);

  if (materials.isLoading) return <Loading />;
  return (
    <div className="flex flex-col gap-10">
      <ErrorNote error={materials.error ?? purchases.error} />
      <Section
        title="Stock and run-out forecast"
        aside={
          can.manage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add material
            </Button>
          ) : (
            "Usage is learned from the daily logs and matched with the work planned in the next three weeks"
          )
        }
      >
        {materials.data?.materials.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Material</Th>
                <Th align="right">On site</Th>
                <Th align="right">Planned use a day</Th>
                <Th>Cover</Th>
                <Th>Runs out</Th>
                <Th>Order by</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {materials.data.materials.map((m) => (
                <tr key={m.id}>
                  <Td className="font-medium">{m.name}</Td>
                  <Td align="right">
                    {number(m.onHand, 1)} {m.unit}
                  </Td>
                  <Td align="right">
                    {number(m.dailyUse, 1)} {m.unit}
                  </Td>
                  <Td>
                    <Cover material={m} />
                  </Td>
                  <Td className="tabular">{m.runOutDate ? dayDate(m.runOutDate) : <span className="text-ink-3">Not in 3 weeks</span>}</Td>
                  <Td className="tabular">{m.orderBy ? dayDate(m.orderBy) : "–"}</Td>
                  <Td>
                    <Status tone={materialState(m).tone}>{materialState(m).label}</Status>
                    {m.openOrderQuantity ? (
                      <div className="mt-0.5 text-[11px] text-ink-3">
                        {number(m.openOrderQuantity)} {m.unit} on order
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No materials tracked yet">Add the materials you want SiteMate to watch. Supervisors then report deliveries and use on Telegram, and the forecast tells you when to order.</Empty>
        )}
      </Section>

      <Section title="Purchase requests and quotes">
        {purchases.data?.purchaseRequests.length ? (
          <div className="flex flex-col gap-4">
            {purchases.data.purchaseRequests.map((p) => {
              const status = PURCHASE_STATUS[p.status];
              return (
                <div key={p.id} className="rounded-[6px] border border-rule bg-surface">
                  <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <Code>PR-{p.id.slice(0, 8).toUpperCase()}</Code>
                        <span className="font-medium">
                          {number(p.quantity)} {p.material.unit} of {p.material.name}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-3">
                        Needed by {dayDate(p.neededBy)} · raised {relativeTime(p.createdAt)}
                      </div>
                    </div>
                    <Status tone={status.tone}>{status.label}</Status>
                  </div>
                  {p.quotes.length ? (
                    <div className="border-t border-rule px-5 py-3">
                      <div className="eyebrow mb-2">{plural(p.quotes.length, "quote")}, cheapest first</div>
                      <ul className="flex flex-col gap-1.5 text-[13px]">
                        {p.quotes.map((q, i) => (
                          <li key={q.id} className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className={i === 0 ? "font-medium" : ""}>{q.supplierName}</span>
                            <span className="tabular text-ink-2">
                              {birr(q.unitPriceEtb)} per {p.material.unit}
                              {q.currency !== "ETB" ? ` (${number(q.unitPrice, 2)} ${q.currency})` : ""} · {plural(q.leadTimeDays, "day")}
                              {q.note ? ` · ${q.note}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[13px] text-ink-3">No purchase requests yet. The procurement agent raises one when a material will run out before a new delivery could arrive.</p>
        )}
      </Section>

      <SuppliersSection lastPrices={Object.fromEntries((materials.data?.materials ?? []).map((m) => [m.name, m.lastUnitPrice]))} />
      <AddMaterialDialog projectId={project.id} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
