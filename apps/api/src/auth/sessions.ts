import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export type User = typeof users.$inferSelect;
export type SafeUser = Omit<User, "passwordHash">;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function toSafeUser({ passwordHash: _ignored, ...user }: User): SafeUser {
  return user;
}

/** Creates a session and returns the token. Only its hash is stored. */
export async function createSession(db: Executor, userId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

export async function findSessionUser(db: Executor, token: string, now = new Date()): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now), eq(users.active, true)))
    .limit(1);
  return row?.user ?? null;
}

export async function deleteSession(db: Executor, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function deleteExpiredSessions(db: Executor, now = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
