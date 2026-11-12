import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { DASHBOARD_ROLES } from "../auth/permissions.js";
import { createSession, deleteSession, toSafeUser } from "../auth/sessions.js";
import { audit } from "../audit.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { companies, users } from "../db/schema.js";
import { requireUser } from "../http/auth.js";
import { AppError, conflict } from "../http/errors.js";

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(8, "Use at least 8 characters").max(200);

const registerBody = z.object({
  companyName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email,
  password,
});

const loginBody = z.object({ email, password: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, db: Database, config: Config): void {
  const authRateLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };

  app.post("/auth/register", { config: authRateLimit }, async (request, reply) => {
    const body = registerBody.parse(request.body);
    const passwordHash = await hashPassword(body.password);

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email}`)
        .limit(1);
      if (existing) throw conflict("An account with this email already exists");

      const [company] = await tx.insert(companies).values({ name: body.companyName }).returning();
      const [owner] = await tx
        .insert(users)
        .values({ companyId: company!.id, name: body.name, email: body.email, passwordHash, role: "owner" })
        .returning();
      await audit(tx, {
        companyId: company!.id,
        actor: { type: "user", id: owner!.id },
        action: "company.created",
        subject: { type: "company", id: company!.id },
      });
      return { company: company!, owner: owner! };
    });

    const token = await createSession(db, result.owner.id);
    return reply.status(201).send({ token, user: toSafeUser(result.owner), company: result.company });
  });

  app.post("/auth/login", { config: authRateLimit }, async (request) => {
    const body = loginBody.parse(request.body);
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);

    // Same answer and similar timing whether the email exists or not.
    const valid = user?.passwordHash
      ? await verifyPassword(body.password, user.passwordHash)
      : (await verifyPassword(body.password, await dummyHash()), false);

    if (!user || !valid || !user.active) {
      throw new AppError(401, "invalid_credentials", "Email or password is incorrect");
    }
    if (!DASHBOARD_ROLES.includes(user.role)) {
      throw new AppError(403, "telegram_only", "This account uses SiteMate through Telegram");
    }

    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    const token = await createSession(db, user.id);
    return { token, user: toSafeUser(user), company };
  });

  app.post("/auth/logout", async (request, reply) => {
    if (request.sessionToken) await deleteSession(db, request.sessionToken);
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request) => {
    const user = requireUser(request);
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    return { user: toSafeUser(user), company };
  });
}

/** A hash of a random password, so a login for an unknown email still does the hashing work. */
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));
