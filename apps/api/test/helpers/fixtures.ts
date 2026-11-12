import { eq } from "drizzle-orm";
import { materials, materialTransactions } from "../../src/db/schema.js";
import { receiveUpdate } from "../../src/telegram/bot.js";
import type { TelegramUpdate } from "../../src/telegram/api.js";
import { registerCompany, type TestApp } from "./app.js";
import { textUpdate } from "./telegram.js";

export const BOLE_SCHEDULE = [
  "code,name,duration,predecessors,kind,zone,progress_unit,planned_quantity",
  "A10,Excavation,3,,excavation,Block A,m3,120",
  "A20,Foundations,4,A10,concrete_pour,Block A,m3,40",
  "A30,Site drainage,2,A10,general,External,m,60",
  "A40,Ground floor columns,5,A20,concrete_pour,Block A,m3,18",
  "A50,Boundary wall blockwork,3,A30,masonry,External,m2,90",
  "A60,Ground floor slab,2,A40;A50,concrete_pour,Block A,m3,35",
].join("\n");

let telegramIds = 700_000;

export async function deliver(t: TestApp, update: TelegramUpdate) {
  await receiveUpdate(t.handle.db, update);
  await t.runtime.runner.drain();
}

/**
 * A company with one project (every day a workday, starting Monday 5 January
 * 2026), its schedule, two tracked materials and a supervisor linked to
 * Telegram.
 */
export async function setupSiteProject(t: TestApp, options: { language?: "en" | "am" } = {}) {
  const owner = await registerCompany(t.app, "Abay Construction");
  const project = (
    await t.app.inject({
      method: "POST",
      url: "/projects",
      headers: owner.auth,
      payload: {
        name: "Bole G+4 Apartments",
        locationName: "Bole, Addis Ababa",
        latitude: 8.9956,
        longitude: 38.7869,
        startDate: "2026-01-05",
        contractFinish: "2026-01-18",
        calendar: { workingWeekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] },
      },
    })
  ).json().project as { id: string };

  await t.app.inject({
    method: "PUT",
    url: `/projects/${project.id}/schedule`,
    headers: { ...owner.auth, "content-type": "text/csv" },
    payload: BOLE_SCHEDULE,
  });

  const [cement] = await t.handle.db
    .insert(materials)
    .values({ projectId: project.id, name: "Cement", unit: "bag", progressUnit: "m2", leadTimeDays: 3 })
    .returning();
  const [blocks] = await t.handle.db
    .insert(materials)
    .values({ projectId: project.id, name: "HCB blocks", unit: "pcs", progressUnit: "m2", leadTimeDays: 2 })
    .returning();
  await t.handle.db.insert(materialTransactions).values([
    { materialId: cement!.id, date: "2026-01-05", kind: "adjustment", quantity: 200, note: "Opening stock" },
    { materialId: blocks!.id, date: "2026-01-05", kind: "adjustment", quantity: 1000, note: "Opening stock" },
  ]);
  await t.handle.db.update(materials).set({ onHand: 200 }).where(eqId(cement!.id));
  await t.handle.db.update(materials).set({ onHand: 1000 }).where(eqId(blocks!.id));

  const supervisor = (
    await t.app.inject({
      method: "POST",
      url: "/users",
      headers: owner.auth,
      payload: { name: "Abebe Kebede", role: "supervisor", language: options.language ?? "en" },
    })
  ).json().user as { id: string };
  await t.app.inject({ method: "PUT", url: `/projects/${project.id}/members/${supervisor.id}`, headers: owner.auth });
  const code = (
    await t.app.inject({ method: "POST", url: `/users/${supervisor.id}/telegram-invite`, headers: owner.auth })
  ).json().code as string;
  const telegramId = ++telegramIds;
  await deliver(t, textUpdate(telegramId, `/start ${code}`));

  return {
    owner,
    projectId: project.id,
    supervisor: { id: supervisor.id, telegramId },
    materials: { cement: cement!, blocks: blocks! },
  };
}

/**
 * Adds a team member to a project and links their Telegram. Dashboard roles
 * also get a signed-in auth header.
 */
export async function addLinkedUser(
  t: TestApp,
  ownerAuth: Record<string, string>,
  input: { name: string; role: "owner" | "project_manager" | "site_engineer" | "supervisor"; projectId?: string },
) {
  const dashboard = input.role !== "supervisor";
  const email = `${input.role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = "member password 1";
  const created = await t.app.inject({
    method: "POST",
    url: "/users",
    headers: ownerAuth,
    payload: { name: input.name, role: input.role, ...(dashboard ? { email, password } : {}) },
  });
  if (created.statusCode !== 201) throw new Error(`create user failed: ${created.body}`);
  const id = created.json().user.id as string;
  if (input.projectId) {
    await t.app.inject({ method: "PUT", url: `/projects/${input.projectId}/members/${id}`, headers: ownerAuth });
  }
  const code = (await t.app.inject({ method: "POST", url: `/users/${id}/telegram-invite`, headers: ownerAuth })).json()
    .code as string;
  const telegramId = ++telegramIds;
  await deliver(t, textUpdate(telegramId, `/start ${code}`));

  let auth: Record<string, string> | null = null;
  if (dashboard) {
    const login = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    auth = { authorization: `Bearer ${login.json().token}` };
  }
  return { id, telegramId, auth };
}

function eqId(id: string) {
  return eq(materials.id, id);
}
