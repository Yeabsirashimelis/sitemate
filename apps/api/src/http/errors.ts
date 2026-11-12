import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** An error that is safe to show to the caller, with an HTTP status. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const forbidden = (message = "You do not have access to this") => new AppError(403, "forbidden", message);
export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const conflict = (message: string) => new AppError(409, "conflict", message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_failed",
          message: "The request is not valid",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    }
    const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: error.code ?? "bad_request", message: error.message } });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong on our side" } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: `No route for ${request.method} ${request.url}` } });
  });
}
