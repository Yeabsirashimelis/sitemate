import type { Executor } from "./db/client.js";
import { auditLog } from "./db/schema.js";

export interface AuditEntry {
  companyId: string;
  projectId?: string | null;
  actor: { type: "user" | "agent" | "system"; id: string };
  action: string;
  subject?: { type: string; id: string };
  reason?: string;
  data?: unknown;
}

/** Records who or what did something, and why. Written in the same transaction as the change. */
export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    companyId: entry.companyId,
    projectId: entry.projectId ?? null,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    subjectType: entry.subject?.type ?? null,
    subjectId: entry.subject?.id ?? null,
    reason: entry.reason ?? null,
    data: entry.data ?? null,
  });
}
