import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows, type DatabaseHandle } from "../src/db/client.js";
import { companies, documentChunks, documents, EMBEDDING_DIMENSIONS, jobs, projects, users } from "../src/db/schema.js";
import { createTestDatabase } from "./helpers/db.js";

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await handle.close();
});

const unitVector = (index: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));

describe("database", () => {
  it("applies migrations and answers a ping", async () => {
    await expect(handle.ping()).resolves.toBeUndefined();
    // Running migrations again is a no-op.
    await expect(handle.migrate()).resolves.toBeUndefined();
  });

  it("enforces case-insensitive unique emails and unique Telegram ids", async () => {
    const [company] = await handle.db.insert(companies).values({ name: "Abay Construction" }).returning();
    await handle.db.insert(users).values({
      companyId: company!.id,
      name: "Hanna",
      email: "hanna@abay.et",
      role: "project_manager",
      telegramUserId: 1001,
    });

    await expect(
      handle.db.insert(users).values({ companyId: company!.id, name: "H", email: "HANNA@abay.et", role: "owner" }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(users).values({ companyId: company!.id, name: "X", role: "supervisor", telegramUserId: 1001 }),
    ).rejects.toThrow();
  });

  it("stores embeddings and ranks them by cosine distance", async () => {
    const [company] = await handle.db.insert(companies).values({ name: "Vector Test" }).returning();
    const [project] = await handle.db
      .insert(projects)
      .values({
        companyId: company!.id,
        name: "Bole G+4",
        startDate: "2026-09-01",
        contractFinish: "2027-06-30",
        dataDate: "2026-09-01",
        calendar: { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: [] },
      })
      .returning();
    const [document] = await handle.db
      .insert(documents)
      .values({ projectId: project!.id, title: "Spec", kind: "specification", fileName: "spec.pdf", mimeType: "application/pdf" })
      .returning();

    await handle.db.insert(documentChunks).values([
      { documentId: document!.id, projectId: project!.id, ordinal: 0, content: "Concrete grade C25", embedding: unitVector(0) },
      { documentId: document!.id, projectId: project!.id, ordinal: 1, content: "Rebar grade 60", embedding: unitVector(1) },
    ]);

    const query = JSON.stringify(unitVector(1));
    const ranked = await queryRows<{ content: string }>(
      handle.db,
      sql`select content from document_chunks order by embedding <=> ${query}::vector limit 1`,
    );
    expect(ranked[0]?.content).toBe("Rebar grade 60");
  });

  it("ignores a second job with the same idempotency key", async () => {
    await handle.db.insert(jobs).values({ type: "test", idempotencyKey: "once" });
    await handle.db.insert(jobs).values({ type: "test", idempotencyKey: "once" }).onConflictDoNothing();
    const count = await queryRows<{ n: number }>(
      handle.db,
      sql`select count(*)::int as n from jobs where idempotency_key = 'once'`,
    );
    expect(count[0]?.n).toBe(1);
  });
});
