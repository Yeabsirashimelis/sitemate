import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useCan } from "../lib/auth";
import { birr, number } from "../lib/format";
import { keys, useSuppliers } from "../lib/queries";
import type { MaterialRow } from "../lib/types";
import { InviteDialog } from "../pages/team";
import { Button, Dialog, ErrorNote, Field, Input, Section, Select, Status, Table, Td, Th, cx } from "./ui";

const KINDS = [
  { value: "concrete_pour", label: "Concrete" },
  { value: "masonry", label: "Blockwork" },
  { value: "finishing", label: "Finishes" },
  { value: "roofing", label: "Roofing" },
  { value: "mep", label: "Electrical and plumbing" },
  { value: "excavation", label: "Earthworks" },
] as const;

/** Typical figures on an Ethiopian building site, per unit of the work that uses them. */
const PRESETS = [
  { name: "Cement", unit: "bag", consumedBy: ["concrete_pour", "masonry"], usage: 0.9, lead: 3, price: 1150 },
  { name: "Rebar", unit: "ton", consumedBy: ["concrete_pour"], usage: 0.012, lead: 5, price: 118000 },
  { name: "HCB blocks", unit: "pcs", consumedBy: ["masonry"], usage: 12.5, lead: 2, price: 42 },
  { name: "Sand", unit: "m3", consumedBy: ["concrete_pour", "masonry", "finishing"], usage: 0.08, lead: 2, price: 1900 },
  { name: "Aggregate", unit: "m3", consumedBy: ["concrete_pour"], usage: 0.11, lead: 2, price: 2100 },
] as const;

const empty = { name: "", unit: "", consumedBy: [] as string[], usage: "", lead: "3", stock: "", price: "" };

export function AddMaterialDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/materials`, {
        body: {
          name: form.name.trim(),
          unit: form.unit.trim(),
          consumedBy: form.consumedBy,
          leadTimeDays: Number(form.lead || 0),
          openingStock: Number(form.stock || 0),
          ...(form.usage ? { usagePerUnit: Number(form.usage) } : {}),
          ...(form.price ? { lastUnitPrice: Number(form.price) } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setForm(empty);
      onClose();
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a material">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <div className="text-[13px] font-medium text-ink-2">Start from</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setForm({ ...form, name: p.name, unit: p.unit, consumedBy: [...p.consumedBy], usage: String(p.usage), lead: String(p.lead), price: String(p.price) })}
                className={cx("h-7 rounded-[4px] border px-2.5 text-[12px]", form.name === p.name ? "border-ink bg-ink text-page" : "border-rule-strong text-ink-2 hover:border-ink-3")}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="Name">
            <Input required minLength={2} value={form.name} onChange={set("name")} />
          </Field>
          <Field label="Unit">
            <Input required placeholder="bag, m3, pcs" value={form.unit} onChange={set("unit")} />
          </Field>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-2">Used by</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {KINDS.map((k) => (
              <label key={k.value} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-[var(--ink)]"
                  checked={form.consumedBy.includes(k.value)}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, consumedBy: e.target.checked ? [...f.consumedBy, k.value] : f.consumedBy.filter((v) => v !== k.value) }))
                  }
                />
                {k.label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">Activities of these kinds draw on it, so SiteMate can forecast when it runs out.</p>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="On site now" hint={form.unit ? `In ${form.unit}` : undefined}>
            <Input type="number" min={0} step="any" value={form.stock} onChange={set("stock")} />
          </Field>
          <Field label="Supplier lead time, days">
            <Input type="number" min={0} max={120} required value={form.lead} onChange={set("lead")} />
          </Field>
          <Field label="Use per unit of work" hint="Learned from site reports after a few days">
            <Input type="number" min={0} step="any" value={form.usage} onChange={set("usage")} />
          </Field>
          <Field label="Last price per unit, birr">
            <Input type="number" min={0} step="any" value={form.price} onChange={set("price")} />
          </Field>
        </div>
        <ErrorNote error={add.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={add.isPending}>
            Add material
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddSupplierDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", phone: "", materials: "", language: "en" });
  const add = useMutation({
    mutationFn: () =>
      api("/suppliers", {
        body: {
          name: form.name.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          materials: form.materials
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
          language: form.language,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.suppliers });
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      setForm({ name: "", phone: "", materials: "", language: "en" });
      onClose();
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));

  return (
    <Dialog open={open} onClose={onClose} title="Add a supplier">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Name">
          <Input required minLength={2} placeholder="Derba Building Materials" value={form.name} onChange={set("name")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone">
            <Input type="tel" placeholder="+251 9..." value={form.phone} onChange={set("phone")} />
          </Field>
          <Field label="Language on Telegram">
            <Select value={form.language} onChange={set("language")}>
              <option value="en">English</option>
              <option value="am">Amharic</option>
            </Select>
          </Field>
        </div>
        <Field label="Supplies" hint="Material names as on your materials list, separated by commas">
          <Input required placeholder="Cement, Sand" value={form.materials} onChange={set("materials")} />
        </Field>
        <ErrorNote error={add.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={add.isPending}>
            Add supplier
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Who the procurement agent asks for quotes. Suppliers answer on Telegram once linked from the Team page. */
export function SuppliersSection({ lastPrices }: { lastPrices: Record<string, number | null> }) {
  const { data } = useSuppliers();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState<{ id: string; name: string } | null>(null);
  const suppliers = data?.suppliers ?? [];

  return (
    <Section
      title="Suppliers"
      aside={
        can.manage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add supplier
          </Button>
        ) : undefined
      }
    >
      {suppliers.length === 0 ? (
        <p className="text-[13px] text-ink-3">No suppliers yet. Add the ones you buy from and the procurement agent asks them for quotes when stock runs low.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Supplier</Th>
              <Th>Supplies</Th>
              <Th>Phone</Th>
              <Th>Telegram</Th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">{s.name}</Td>
                <Td className="text-ink-2">
                  {s.materials.map((m) => (lastPrices[m] ? `${m} (last ${birr(lastPrices[m])})` : m)).join(", ")}
                </Td>
                <Td className="tabular text-ink-2">{s.phone ?? "–"}</Td>
                <Td>
                  {s.telegramLinked ? (
                    <Status tone="good">Linked</Status>
                  ) : can.manage && s.userId ? (
                    <Button size="sm" variant="ghost" onClick={() => setInviting({ id: s.userId!, name: s.name })}>
                      Invite
                    </Button>
                  ) : (
                    <span className="text-[12px] text-ink-3">Not linked</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <AddSupplierDialog open={adding} onClose={() => setAdding(false)} />
      <InviteDialog user={inviting} onClose={() => setInviting(null)} />
    </Section>
  );
}

/** A physical count on site. The difference is booked as an adjustment and the forecast follows. */
export function CountDialog({ projectId, material, onClose }: { projectId: string; material: MaterialRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState("");
  const count = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/materials/${material!.id}/adjust`, {
        body: { quantity: Number(counted) - material!.onHand, note: "Stock count on site" },
      }),
    onSuccess: () => {
      setCounted("");
      onClose();
      // The procurement agent looks right after a count; refresh once it has.
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }), 3000);
    },
  });
  const difference = counted === "" || !material ? null : Number(counted) - material.onHand;

  return (
    <Dialog
      open={material !== null}
      onClose={() => {
        count.reset();
        setCounted("");
        onClose();
      }}
      title={material ? `Count ${material.name.toLowerCase()} on site` : "Count"}
    >
      {material ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            count.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-[13px] text-ink-2">
            The records say {number(material.onHand, 1)} {material.unit}. Enter what is actually there and SiteMate corrects the stock, then checks whether it is time to
            order.
          </p>
          <Field label={`Counted, ${material.unit}`} hint={difference ? `${difference > 0 ? "+" : ""}${number(difference, 1)} ${material.unit} against the records` : undefined}>
            <Input type="number" required min={0} step="any" value={counted} onChange={(e) => setCounted(e.target.value)} className="w-48" autoFocus />
          </Field>
          <ErrorNote error={count.error} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={count.isPending} disabled={!difference}>
              Save count
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
