/**
 * Demo data for the dashboard and the walkthrough video.
 *
 * Creates Abay Construction with two sites in Addis Ababa, their schedules,
 * bills of quantities, materials, suppliers, recovery measures, contract and
 * specification, and several weeks of daily logs that have already been
 * applied, so every screen has something real to show. Dates are relative to
 * the day the seed runs.
 *
 * Run it with src/seed/cli.ts.
 */

import { addCalendarDays, computeSchedule } from "@sitemate/engine";
import { eq, sql } from "drizzle-orm";
import type { CheckedLog } from "../agents/site-agent.js";
import { hashPassword } from "../auth/password.js";
import type { Database } from "../db/client.js";
import {
  boqItems,
  companies,
  costEntries,
  dailyLogs,
  documentFiles,
  documents,
  materials,
  materialTransactions,
  messages,
  projectMembers,
  projects,
  recoveryMeasures,
  suppliers,
  users,
} from "../db/schema.js";
import { defaultHolidays } from "../domain/holidays.js";
import { enqueue } from "../jobs/queue.js";
import { labourCost } from "../services/cost.js";
import { applyLog } from "../services/daily-logs.js";
import { loadProjectSchedule, recalculate, replaceSchedule } from "../services/schedule.js";
import { CONTRACT_TEXT, frameBuilding, SPECIFICATION_TEXT, type DemoActivity } from "./demo-project.js";

const COMPANY = "Abay Construction PLC";

/** Monday on or before a date. */
function mondayOnOrBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addCalendarDays(date, -((day + 6) % 7));
}

/** Small deterministic noise so the demo looks real and is the same every run. */
function wobble(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

interface SiteSpec {
  name: string;
  client: string;
  consultant: string;
  locationName: string;
  latitude: number;
  longitude: number;
  activities: DemoActivity[];
  weeksAgo: number;
  durationDays: number;
  supervisor: { name: string; language: "en" | "am" };
  ld: number;
}

export async function seedDemo(db: Database, options: { today: string; password: string; reset: boolean; indexDocuments: boolean }) {
  const [existing] = await db.select().from(companies).where(eq(companies.name, COMPANY));
  if (existing) {
    if (!options.reset) throw new Error(`"${COMPANY}" already exists. Run with --reset to recreate it.`);
    await db.delete(companies).where(eq(companies.id, existing.id));
  }

  const passwordHash = await hashPassword(options.password);
  const [company] = await db.insert(companies).values({ name: COMPANY }).returning();
  const companyId = company!.id;
  const person = async (name: string, role: (typeof users.$inferInsert)["role"], email: string | null, language: "en" | "am" = "en") => {
    const [row] = await db
      .insert(users)
      .values({ companyId, name, role, email, passwordHash: email ? passwordHash : null, language })
      .returning();
    return row!;
  };

  const owner = await person("Mekdes Haile", "owner", "owner@abay.demo");
  const pm = await person("Sara Tadesse", "project_manager", "pm@abay.demo");
  const engineer = await person("Dawit Bekele", "site_engineer", "engineer@abay.demo");

  const sites: SiteSpec[] = [
    {
      name: "Bole G+4 Apartments",
      client: "Tesfaye Alemu",
      consultant: "Addis Design Consult",
      locationName: "Bole, Addis Ababa",
      latitude: 8.9956,
      longitude: 38.7869,
      activities: frameBuilding({ floors: 4, slabArea: 420, prefix: "B", blockName: "Block A" }),
      weeksAgo: 7,
      durationDays: 300,
      supervisor: { name: "Abebe Kebede", language: "am" },
      ld: 18_000,
    },
    {
      name: "Kazanchis Commercial Building",
      client: "Selam Trading PLC",
      consultant: "Horizon Engineering",
      locationName: "Kazanchis, Addis Ababa",
      latitude: 9.0189,
      longitude: 38.7663,
      activities: frameBuilding({ floors: 2, slabArea: 600, prefix: "K", blockName: "Main block" }),
      weeksAgo: 4,
      durationDays: 220,
      supervisor: { name: "Tigist Alemu", language: "en" },
      ld: 12_000,
    },
  ];

  const supplierRows = [
    { name: "Habesha Cement Agent", materials: ["Cement"], phone: "+251 911 234 567" },
    { name: "Derba Building Materials", materials: ["Cement", "Sand", "Aggregate"], phone: "+251 912 345 678" },
    { name: "Mesfin Steel Trading", materials: ["Rebar"], phone: "+251 913 456 789" },
    { name: "Akaki Block Factory", materials: ["HCB blocks"], phone: "+251 914 567 890" },
  ];
  for (const s of supplierRows) {
    const account = await person(s.name, "supplier", null);
    await db.insert(suppliers).values({ companyId, name: s.name, userId: account.id, phone: s.phone, materials: s.materials });
  }

  const summary = [];
  for (const site of sites) {
    const startDate = mondayOnOrBefore(addCalendarDays(options.today, -site.weeksAgo * 7));
    // Replaced below by the planned finish plus a short buffer, once the schedule is in.
    let contractFinish = addCalendarDays(startDate, site.durationDays);
    const supervisor = await person(site.supervisor.name, "supervisor", null, site.supervisor.language);

    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name: site.name,
        client: site.client,
        consultant: site.consultant,
        locationName: site.locationName,
        latitude: site.latitude,
        longitude: site.longitude,
        startDate,
        contractFinish,
        dataDate: startDate,
        calendar: { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: defaultHolidays(startDate, addCalendarDays(contractFinish, 120)) },
        liquidatedDamagesPerDay: site.ld,
        retentionPercent: 5,
        labourRates: { mason: 950, carpenter: 900, "steel fixer": 900, electrician: 1000, plumber: 1000, painter: 850, labourer: 450, default: 500 },
      })
      .returning();
    const projectId = project!.id;
    for (const member of [owner, pm, engineer, supervisor]) await db.insert(projectMembers).values({ projectId, userId: member.id });

    const imported = await replaceSchedule(db, { projectId, companyId, actorId: pm.id, activities: site.activities });
    // The contract allows a week beyond the planned finish, so slippage soon puts it at risk.
    contractFinish = addCalendarDays(imported.result.finishDate, 7);
    await db.update(projects).set({ contractFinish }).where(eq(projects.id, projectId));
    const schedule = await loadProjectSchedule(db, projectId);
    const idByCode = new Map([...schedule.byCode.values()].map((a) => [a.code, a.id]));

    // Bill of quantities from the measured activities, plus preliminaries.
    await db.insert(boqItems).values([
      { projectId, itemNo: "1.1", description: "Preliminaries, site setup and insurance", unit: "LS", quantity: 1, rate: 450_000, activityId: null },
      ...site.activities
        .filter((a) => a.plannedQuantity && a.rate)
        .map((a, i) => ({
          projectId,
          itemNo: `${2 + Math.floor(i / 9)}.${(i % 9) + 1}`,
          description: a.name,
          unit: a.progressUnit!,
          quantity: Math.round(a.plannedQuantity! * 100) / 100,
          rate: a.rate!,
          activityId: idByCode.get(a.code)!,
        })),
    ]);

    // Materials, with opening stock and learned usage rates.
    const materialDefs = [
      { name: "Cement", unit: "bag", consumedBy: ["concrete_pour", "masonry"], usage: 0.9, lead: 3, stock: 900, price: 1_150 },
      { name: "Rebar", unit: "ton", consumedBy: ["concrete_pour"], usage: 0.012, lead: 5, stock: 14, price: 118_000 },
      { name: "HCB blocks", unit: "pcs", consumedBy: ["masonry"], usage: 12.5, lead: 2, stock: 4_000, price: 42 },
      { name: "Sand", unit: "m3", consumedBy: ["concrete_pour", "masonry", "finishing"], usage: 0.08, lead: 2, stock: 60, price: 1_900 },
      { name: "Aggregate", unit: "m3", consumedBy: ["concrete_pour"], usage: 0.11, lead: 2, stock: 45, price: 2_100 },
    ] as const;
    const materialIds = new Map<string, string>();
    for (const m of materialDefs) {
      const [row] = await db
        .insert(materials)
        .values({ projectId, name: m.name, unit: m.unit, consumedBy: [...m.consumedBy], usagePerUnit: m.usage, leadTimeDays: m.lead, safetyDays: 2, lastUnitPrice: m.price })
        .returning();
      materialIds.set(m.name, row!.id);
      await db.insert(materialTransactions).values({ materialId: row!.id, date: startDate, kind: "adjustment", quantity: m.stock, note: "Opening stock" });
    }

    // Recovery measures the project manager has priced in advance.
    const measure = async (code: string, description: string, change: (typeof recoveryMeasures.$inferInsert)["change"], cost: number, risk: "low" | "medium" | "high") => {
      const activityId = idByCode.get(code);
      if (activityId) await db.insert(recoveryMeasures).values({ projectId, activityId, description, change, cost, risk });
    };
    const p = site.activities[0]!.code[0]!;
    await measure(`${p}2100`, "Second steel fixing crew on floor 1 columns", { kind: "shorten", days: 2 }, 38_000, "low");
    await measure(`${p}2130`, "Pump hire for the floor 1 slab pour", { kind: "shorten", days: 1 }, 24_000, "low");
    await measure(`${p}2140`, "Early striking with back-propping on floor 1", { kind: "shorten", days: 2 }, 15_000, "medium");
    await measure(`${p}2200`, "Saturday afternoon shift on floor 2 columns", { kind: "shorten", days: 1 }, 12_000, "low");
    const formwork = idByCode.get(`${p}2210`);
    const columns = idByCode.get(`${p}2200`);
    if (formwork && columns) {
      await db.insert(recoveryMeasures).values({
        projectId,
        activityId: formwork,
        description: "Start floor 2 formwork two days after the columns start, bay by bay",
        change: { kind: "relink", fromActivityId: columns, type: "SS", lag: 2 },
        cost: 9_000,
        risk: "medium",
      });
    }

    // History: a daily log for every working day so far, following the baseline with some slippage.
    const calendar = schedule.calendar;
    const todayIndex = calendar.indexOf(options.today);
    const baseline = computeSchedule(schedule.activities, calendar);
    const progress = new Map<string, number>();
    const links = new Map(site.activities.map((a) => [a.code, a.predecessors]));
    /** Work only happens once the logic allows it: finish-to-start needs the predecessor done, start-to-start needs it started. */
    const predecessorsAllow = (code: string) =>
      (links.get(code) ?? []).every((link) => (link.type === "SS" ? (progress.get(link.code) ?? 0) > 0 : (progress.get(link.code) ?? 0) >= 100));
    let logs = 0;
    // Running stock, so deliveries arrive the way a storekeeper would order them.
    const stock = new Map<string, number>(materialDefs.map((m) => [m.name, m.stock]));
    for (let day = 0; day < todayIndex; day++) {
      const date = calendar.dateOf(day);
      const working = baseline.order
        .map((code) => ({ code, a: baseline.activities.get(code)! }))
        // Planned to have started by today and not finished yet, in the order they were planned.
        .filter(({ a }) => a.earlyStart <= day && a.earlyFinish > a.earlyStart)
        .filter(({ code }) => (progress.get(code) ?? 0) < 100 && predecessorsAllow(code));
      if (working.length === 0) continue;

      const reported: CheckedLog["progress"] = [];
      const used: Record<string, number> = {};
      for (const { code, a } of working.slice(0, 5)) {
        const row = schedule.byCode.get(code)!;
        const span = a.earlyFinish - a.earlyStart;
        // Some days go faster than planned and some slower.
        const pace = (100 / span) * (0.8 + wobble(`${code}${date}`) * 0.35);
        const percent = Math.min(100, Math.round(((progress.get(code) ?? 0) + pace) * 10) / 10);
        if (percent <= (progress.get(code) ?? 0)) continue;
        const done = row.plannedQuantity ? Math.round(row.plannedQuantity * ((percent - (progress.get(code) ?? 0)) / 100) * 10) / 10 : undefined;
        progress.set(code, percent);
        reported.push({ activityCode: code, percentComplete: percent, ...(done !== undefined ? { quantityDone: done } : {}) });
        if (done) {
          for (const m of materialDefs) {
            if ((m.consumedBy as readonly string[]).includes(row.kind)) used[m.name] = (used[m.name] ?? 0) + done * m.usage;
          }
        }
      }
      if (reported.length === 0) continue;

      const workers = [
        { trade: "Mason", count: 4 + Math.round(wobble(`m${date}`) * 6) },
        { trade: "Steel fixer", count: 2 + Math.round(wobble(`s${date}`) * 4) },
        { trade: "Carpenter", count: 2 + Math.round(wobble(`c${date}`) * 3) },
        { trade: "Labourer", count: 8 + Math.round(wobble(`l${date}`) * 8) },
      ];
      // A delivery the day after stock drops below a third of the opening amount.
      const received: CheckedLog["materialsReceived"] = [];
      for (const m of materialDefs) {
        const left = (stock.get(m.name) ?? 0) - (used[m.name] ?? 0);
        if (left < m.stock / 3) {
          const quantity = Math.round(m.stock * 0.8 * 10) / 10;
          received.push({ material: m.name, quantity, unit: m.unit });
          stock.set(m.name, left + quantity);
        } else {
          stock.set(m.name, left);
        }
      }
      const names = reported.map((r) => schedule.byCode.get(r.activityCode)!.name.toLowerCase());
      const checked: CheckedLog = {
        summary: `Worked on ${names.join(", ")}. ${workers.reduce((s, w) => s + w.count, 0)} workers on site.${received.length ? ` Delivered: ${received.map((r) => `${r.quantity} ${r.unit} of ${r.material}`).join(", ")}.` : ""}`,
        weather: wobble(`w${date}`) > 0.8 ? "Light rain in the afternoon" : "Dry",
        workers,
        progress: reported,
        materialsReceived: received,
        materialsUsed: Object.entries(used).map(([material, quantity]) => ({
          material,
          quantity: Math.round(quantity * 10) / 10,
          unit: materialDefs.find((m) => m.name === material)!.unit,
        })),
        issues: [],
        photoConcerns: [],
        followUpQuestion: null,
        confidence: 0.85 + wobble(`q${date}`) * 0.12,
        corrections: [],
      };

      const [log] = await db
        .insert(dailyLogs)
        .values({ projectId, supervisorId: supervisor.id, logDate: date, status: "collecting" })
        .returning();
      await db.insert(messages).values({
        companyId,
        projectId,
        userId: supervisor.id,
        dailyLogId: log!.id,
        direction: "in",
        kind: "text",
        text:
          site.supervisor.language === "am"
            ? `ዛሬ ${reported.length} ስራዎች ላይ ሰርተናል። ${workers.reduce((s, w) => s + w.count, 0)} ሰራተኞች ነበሩ።`
            : `Today we worked on ${names.join(", ")}. ${workers.reduce((s, w) => s + w.count, 0)} workers.`,
        createdAt: new Date(`${date}T14:${String(10 + (day % 40)).padStart(2, "0")}:00Z`),
      });
      await applyLog(db, { log: log!, checked, companyId });
      await db
        .insert(costEntries)
        .values({ projectId, date, category: "labour", amount: labourCost(workers, project!.labourRates), description: `Labour, daily log ${date}`, sourceRef: `labour:${log!.id}` })
        .onConflictDoNothing();
      for (const r of received) {
        const price = materialDefs.find((m) => m.name === r.material)!.price;
        await db.insert(costEntries).values({ projectId, date, category: "material", amount: r.quantity * price, description: `${r.quantity} ${r.unit} of ${r.material}`, sourceRef: `seed-delivery:${log!.id}` });
      }
      if (day % 5 === 0) await recalculate(db, projectId, `Daily log ${date} from ${supervisor.name}`);
      logs++;
    }
    await db.execute(sql`update projects set data_date = ${options.today}::date where id = ${projectId}`);
    const { result } = await recalculate(db, projectId, "Demo data loaded");

    // Contract and specification, indexed once a Gemini key is available.
    for (const doc of [
      { title: "Conditions of Contract", kind: "contract" as const, text: CONTRACT_TEXT },
      { title: "Technical Specification", kind: "specification" as const, text: SPECIFICATION_TEXT },
    ]) {
      const [row] = await db
        .insert(documents)
        .values({ projectId, title: doc.title, kind: doc.kind, fileName: `${doc.title}.txt`, mimeType: "text/plain", uploadedBy: pm.id })
        .returning();
      await db.insert(documentFiles).values({ documentId: row!.id, data: Buffer.from(doc.text) });
      if (options.indexDocuments) await enqueue(db, "documents.index", { documentId: row!.id }, { idempotencyKey: `index:${row!.id}` });
    }

    summary.push({ project: site.name, activities: site.activities.length, logs, forecastFinish: result.finishDate, contractFinish });
  }

  return { companyId, logins: ["owner@abay.demo", "pm@abay.demo", "engineer@abay.demo"], summary };
}
