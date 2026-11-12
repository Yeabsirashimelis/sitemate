import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasRole, type Role } from "../auth/permissions.js";
import { findSessionUser, type User } from "../auth/sessions.js";
import type { Database } from "../db/client.js";
import { AppError, forbidden } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    sessionToken: string | null;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Resolves the signed-in user on every request. Routes decide whether one is required. */
export function registerAuth(app: FastifyInstance, db: Database): void {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request) => {
    const token = bearerToken(request);
    if (!token) return;
    const user = await findSessionUser(db, token);
    if (user) {
      request.user = user;
      request.sessionToken = token;
    }
  });
}

export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw new AppError(401, "unauthenticated", "Please sign in");
  return request.user;
}

export function requireRole(request: FastifyRequest, roles: readonly Role[]): User {
  const user = requireUser(request);
  if (!hasRole(user.role, roles)) throw forbidden();
  return user;
}
