/**
 * A ready-made project for a company that has just signed up, so the
 * dashboard has something real to show before they import their own.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { User } from "../auth/sessions.js";
import type { Database } from "../db/client.js";
import { projects, suppliers, users } from "../db/schema.js";
import { conflict } from "../http/errors.js";
import { frameBuilding } from "./demo-project.js";
import { DEMO_SUPPLIERS, seedSite, type SiteSpec } from "./seed.js";

export const SAMPLE_PROJECT_NAME = "Bole G+4 Apartments (sample)";

const sampleSite = (): SiteSpec => ({
  name: SAMPLE_PROJECT_NAME,
  client: "Tesfaye Alemu",
  consultant: "Addis Design Consult",
  locationName: "Bole, Addis Ababa",
  latitude: 8.9956,
  longitude: 38.7869,
  activities: frameBuilding({ floors: 4, slabArea: 420, prefix: "B", blockName: "Block A" }),
  weeksAgo: 7,
  durationDays: 300,
  supervisor: { name: "Abebe Kebede", language: "en" },
  ld: 18_000,
});

export async function addSampleProject(db: Database, input: { user: User; today: string; indexDocuments: boolean }) {
  const { user } = input;
  const companyId = user.companyId;
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.name, SAMPLE_PROJECT_NAME)));
  if (existing) throw conflict("This company already has the sample project");

  // Procurement asks suppliers for quotes, so the sample needs some to ask.
  const known = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.companyId, companyId));
  const names = new Set(known.map((s) => s.name));
  for (const s of DEMO_SUPPLIERS) {
    if (names.has(s.name)) continue;
    const [account] = await db.insert(users).values({ companyId, name: s.name, role: "supplier" }).returning();
    await db.insert(suppliers).values({ companyId, name: s.name, userId: account!.id, phone: s.phone, materials: [...s.materials] });
  }

  // Everyone who runs projects in the office can see it.
  const office = await db
    .select()
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.active, true), inArray(users.role, ["owner", "project_manager", "site_engineer"])));
  const members = office.some((u) => u.id === user.id) ? office : [...office, user];

  return seedSite(db, { companyId, actor: user, members, site: sampleSite(), today: input.today, indexDocuments: input.indexDocuments });
}
