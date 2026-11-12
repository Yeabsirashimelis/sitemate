import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import { Button, Dialog, ErrorNote, Field, Input, Select, cx } from "./ui";

/** A small G+1 house, enough to see the critical path and the look-ahead work. */
export const SAMPLE_SCHEDULE_CSV = [
  "code,name,duration,predecessors,kind,zone,progress_unit,planned_quantity",
  "A100,Site clearing and setting out,3,,general,Site,,",
  "A110,Excavation for footings,5,A100,excavation,Foundation,m3,140",
  "A120,Blinding and footing concrete,6,A110,concrete_pour,Foundation,m3,38",
  "A130,Column starters and grade beam,6,A120,concrete_pour,Foundation,m3,22",
  "A140,Backfill and hardcore,4,A130,excavation,Foundation,m3,90",
  "A150,Ground floor slab,4,A140,concrete_pour,Ground floor,m3,30",
  "A200,Ground floor columns,5,A150,concrete_pour,Ground floor,m3,12",
  "A210,First floor beam and slab formwork,6,A200SS+2,general,First floor,m2,160",
  "A220,First floor slab pour and curing,8,A210,concrete_pour,First floor,m3,36",
  "A300,Ground floor HCB walls,8,A150,masonry,Ground floor,m2,320",
  "A310,First floor HCB walls,8,A220;A300,masonry,First floor,m2,300",
  "A320,Roof structure and sheeting,6,A310,roofing,Roof,m2,190",
  "A400,Electrical and plumbing rough-in,10,A300SS+3,mep,Whole building,,",
  "A410,Plastering inside and out,12,A320;A400,finishing,Whole building,m2,1100",
  "A420,Floor tiling,8,A410,finishing,Whole building,m2,260",
  "A430,Doors windows and painting,10,A420,finishing,Whole building,,",
  "A900,Handover,0,A430,milestone,,,",
].join("\n");

export function downloadSampleCsv() {
  const url = URL.createObjectURL(new Blob([SAMPLE_SCHEDULE_CSV], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "sitemate-sample-schedule.csv" });
  link.click();
  URL.revokeObjectURL(url);
}

/** Where the weather agent looks. Other places can be added later from the API. */
const CITIES = [
  { name: "Addis Ababa", latitude: 9.0108, longitude: 38.7613 },
  { name: "Adama", latitude: 8.54, longitude: 39.27 },
  { name: "Bahir Dar", latitude: 11.5936, longitude: 37.3908 },
  { name: "Dire Dawa", latitude: 9.6009, longitude: 41.8501 },
  { name: "Gondar", latitude: 12.6, longitude: 37.4667 },
  { name: "Hawassa", latitude: 7.0621, longitude: 38.4764 },
  { name: "Jimma", latitude: 7.6667, longitude: 36.8333 },
  { name: "Mekelle", latitude: 13.4967, longitude: 39.4753 },
] as const;

const WEEKDAYS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

const today = () => new Date().toISOString().slice(0, 10);
const inMonths = (months: number) => {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
};

/** Picks a CSV file and sends it as the project's schedule. */
function CsvPicker({ file, onFile }: { file: File | null; onFile: (file: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <Button type="button" size="sm" icon={<FileUp className="size-3.5" />} onClick={() => input.current?.click()}>
        {file ? "Choose another file" : "Choose CSV file"}
      </Button>
      <span className="min-w-0 truncate text-[12px] text-ink-3">{file ? file.name : "Exported from Excel, MS Project or Primavera"}</span>
    </div>
  );
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    client: "",
    consultant: "",
    city: "Addis Ababa",
    locationName: "",
    startDate: today(),
    contractFinish: inMonths(10),
    liquidatedDamagesPerDay: "",
  });
  const [workdays, setWorkdays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [file, setFile] = useState<File | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const city = CITIES.find((c) => c.name === form.city);
      const { project } = await api<{ project: { id: string } }>("/projects", {
        body: {
          name: form.name.trim(),
          ...(form.client.trim() ? { client: form.client.trim() } : {}),
          ...(form.consultant.trim() ? { consultant: form.consultant.trim() } : {}),
          locationName: form.locationName.trim() || form.city,
          ...(city ? { latitude: city.latitude, longitude: city.longitude } : {}),
          startDate: form.startDate,
          contractFinish: form.contractFinish,
          calendar: { workingWeekdays: workdays },
          ...(form.liquidatedDamagesPerDay ? { liquidatedDamagesPerDay: Number(form.liquidatedDamagesPerDay) } : {}),
        },
      });
      // The project exists either way; a bad file is reported on its Schedule tab.
      let scheduleError: unknown = null;
      if (file) await api(`/projects/${project.id}/schedule`, { method: "PUT", csv: await file.text() }).catch((error: unknown) => (scheduleError = error));
      return { id: project.id, scheduleError };
    },
    onSuccess: ({ id, scheduleError }) => {
      void queryClient.invalidateQueries();
      onClose();
      navigate(scheduleError ? `/projects/${id}/schedule` : `/projects/${id}`);
    },
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open={open} onClose={onClose} title="New project" width="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Project name">
          <Input required minLength={2} placeholder="CMC G+3 Mixed Use Building" value={form.name} onChange={set("name")} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client">
            <Input value={form.client} onChange={set("client")} />
          </Field>
          <Field label="Engineer or consultant">
            <Input value={form.consultant} onChange={set("consultant")} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City" hint="For the daily weather check">
            <Select value={form.city} onChange={set("city")}>
              {CITIES.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
              <option value="">Other, no weather check</option>
            </Select>
          </Field>
          <Field label="Site location">
            <Input placeholder="CMC, Addis Ababa" value={form.locationName} onChange={set("locationName")} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start date">
            <Input type="date" required value={form.startDate} onChange={set("startDate")} />
          </Field>
          <Field label="Contract completion">
            <Input type="date" required min={form.startDate} value={form.contractFinish} onChange={set("contractFinish")} />
          </Field>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-2">Working days</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {WEEKDAYS.map(({ day, label }) => {
              const on = workdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setWorkdays((days) => (on ? (days.length > 1 ? days.filter((d) => d !== day) : days) : [...days, day]))}
                  className={cx(
                    "h-8 w-11 rounded-[4px] border text-[12px] font-medium transition-colors",
                    on ? "border-ink bg-ink text-page" : "border-rule-strong text-ink-2 hover:border-ink-3",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">Ethiopian public holidays are added for you.</p>
        </fieldset>
        <Field label="Delay damages per day, birr" hint="From the contract. Used to price slippage; leave empty if none.">
          <Input type="number" min={0} step={500} value={form.liquidatedDamagesPerDay} onChange={set("liquidatedDamagesPerDay")} className="w-48" />
        </Field>
        <div>
          <div className="text-[13px] font-medium text-ink-2">Schedule</div>
          <div className="mt-1.5">
            <CsvPicker file={file} onFile={setFile} />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            Optional now, you can import it later.{" "}
            <button type="button" onClick={downloadSampleCsv} className="inline-flex items-center gap-1 font-medium text-ink-2 underline underline-offset-2 hover:text-ink">
              <Download className="size-3" aria-hidden /> Sample CSV
            </button>
          </p>
        </div>
        <ErrorNote error={create.error} />
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shown where a project has no schedule yet. */
export function ScheduleImport({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: async () => api(`/projects/${projectId}/schedule`, { method: "PUT", csv: await file!.text() }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  return (
    <div className="rounded-[6px] border border-dashed border-rule-strong px-6 py-8">
      <h2 className="text-[15px] font-semibold">Import the schedule</h2>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-2">
        A CSV with one row per activity: code, name, duration in workdays and predecessors. Kind, zone, unit and quantity are optional but let SiteMate track
        materials and progress by quantity. SiteMate checks the logic before saving, and the computed dates become the baseline.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <CsvPicker file={file} onFile={setFile} />
        <Button variant="primary" size="sm" disabled={!file} busy={upload.isPending} onClick={() => upload.mutate()}>
          Import
        </Button>
        <button type="button" onClick={downloadSampleCsv} className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink">
          <Download className="size-3" aria-hidden /> Sample CSV
        </button>
      </div>
      <div className="mt-3">
        <ErrorNote error={upload.error} />
      </div>
    </div>
  );
}
