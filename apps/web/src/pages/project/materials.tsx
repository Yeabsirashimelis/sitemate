import { useState } from "react";
import { AddMaterialDialog, SuppliersSection } from "../../components/material-setup";
import { PurchaseCard } from "../../components/purchase-card";
import { Button, Empty, ErrorNote, Loading, Section, Status, Table, Td, Th } from "../../components/ui";
import { useCan } from "../../lib/auth";
import { dayDate, number, plural } from "../../lib/format";
import { useMaterials, usePurchases } from "../../lib/queries";
import { materialState } from "../../lib/status";
import type { MaterialRow } from "../../lib/types";
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
                        {number(m.openOrderQuantity)} {m.unit} in Buying below
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

      <Section title="Buying" aside="SiteMate raises a request when stock will run out before a new delivery could arrive">
        {purchases.data?.purchaseRequests.length ? (
          <div className="flex flex-col gap-4">
            {purchases.data.purchaseRequests.map((p) => (
              <PurchaseCard key={p.id} request={p} />
            ))}
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
