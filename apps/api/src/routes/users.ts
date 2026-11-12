import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../auth/password.js";
import { DASHBOARD_ROLES, MANAGER_ROLES, type Role } from "../auth/permissions.js";
import { toSafeUser } from "../auth/sessions.js";
import { audit } from "../audit.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { invites, userRole, users } from "../db/schema.js";
import { requireRole } from "../http/auth.js";
import { badRequest, forbidden, notFound } from "../http/errors.js";

const createUserBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    role: z.enum(userRole.enumValues),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    password: z.string().min(8).max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    language: z.enum(["en", "am"]).default("en"),
  })
  .refine((u) => !DASHBOARD_ROLES.includes(u.role) || (u.email && u.password), {
    message: "Dashboard users need an email and a password",
    path: ["email"],
  });

const updateUserBody = z
  .object({
    role: z.enum(userRole.enumValues),
    active: z.boolean(),
    language: z.enum(["en", "am"]),
    quietFrom: z.number().int().min(0).max(23),
    quietTo: z.number().int().min(0).max(23),
    phone: z.string().trim().max(30),
  })
  .partial();

const idParams = z.object({ id: z.uuid() });

/** Readable one-time codes without characters that are easy to confuse. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function inviteCode(length = 8): string {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** A project manager can manage everyone except owners. */
function assertCanAssign(actorRole: Role, targetRole: Role): void {
  if (targetRole === "owner" && actorRole !== "owner") throw forbidden("Only an owner can add or change owners");
}

export function userRoutes(app: FastifyInstance, db: Database, config: Config): void {
  app.get("/users", async (request) => {
    const actor = requireRole(request, DASHBOARD_ROLES);
    const rows = await db.select().from(users).where(eq(users.companyId, actor.companyId)).orderBy(asc(users.name));
    return { users: rows.map(toSafeUser) };
  });

  app.post("/users", async (request, reply) => {
    const actor = requireRole(request, MANAGER_ROLES);
    const body = createUserBody.parse(request.body);
    assertCanAssign(actor.role, body.role);

    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          companyId: actor.companyId,
          name: body.name,
          role: body.role,
          email: body.email ?? null,
          passwordHash: body.password ? await hashPassword(body.password) : null,
          phone: body.phone ?? null,
          language: body.language,
        })
        .returning();
      await audit(tx, {
        companyId: actor.companyId,
        actor: { type: "user", id: actor.id },
        action: "user.created",
        subject: { type: "user", id: user!.id },
        data: { role: body.role },
      });
      return user!;
    });
    return reply.status(201).send({ user: toSafeUser(created) });
  });

  app.patch("/users/:id", async (request) => {
    const actor = requireRole(request, MANAGER_ROLES);
    const { id } = idParams.parse(request.params);
    const body = updateUserBody.parse(request.body);

    const [target] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, actor.companyId)));
    if (!target) throw notFound("User");
    assertCanAssign(actor.role, target.role);
    if (body.role) assertCanAssign(actor.role, body.role);
    if (target.id === actor.id && (body.active === false || (body.role && body.role !== actor.role))) {
      throw badRequest("You cannot deactivate yourself or change your own role");
    }

    const [updated] = await db.update(users).set(body).where(eq(users.id, id)).returning();
    await audit(db, {
      companyId: actor.companyId,
      actor: { type: "user", id: actor.id },
      action: "user.updated",
      subject: { type: "user", id },
      data: body,
    });
    return { user: toSafeUser(updated!) };
  });

  /** One-time code the person sends to the bot as /start CODE to link their Telegram account. */
  app.post("/users/:id/telegram-invite", async (request, reply) => {
    const actor = requireRole(request, MANAGER_ROLES);
    const { id } = idParams.parse(request.params);
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, actor.companyId)));
    if (!target) throw notFound("User");

    const code = inviteCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(invites).values({ code, companyId: actor.companyId, userId: id, expiresAt });
    return reply.status(201).send({
      code,
      expiresAt,
      link: config.TELEGRAM_BOT_USERNAME ? `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${code}` : null,
    });
  });
}
