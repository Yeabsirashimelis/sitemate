import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { inviteCode } from "../src/routes/users.js";
import { createTestApp, registerCompany, type TestApp } from "./helpers/app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ TELEGRAM_BOT_USERNAME: "sitemate_test_bot", AUTH_RATE_LIMIT_PER_MINUTE: "1000" });
});
afterAll(async () => {
  await t.close();
});

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("site mate 2026");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("site mate 2026", hash)).toBe(true);
    expect(await verifyPassword("site mate 2027", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("sign up and sign in", () => {
  it("registers a company with its owner and signs them in", async () => {
    const { user, auth } = await registerCompany(t.app, "Tana Builders");
    const me = await t.app.inject({ url: "/auth/me", headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: user.id, role: "owner" });
    expect(me.json().user.passwordHash).toBeUndefined();
    expect(me.json().company.name).toBe("Tana Builders");
  });

  it("rejects a second account with the same email in any case", async () => {
    const { user } = await registerCompany(t.app);
    const again = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { companyName: "Copy", name: "Copy", email: user.email.toUpperCase(), password: "another pass 1" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("logs in with the right password only, with the same message for unknown emails", async () => {
    const { user } = await registerCompany(t.app);
    const ok = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "correct horse 1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTypeOf("string");

    const wrong = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email: user.email, password: "nope" } });
    const unknown = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it("ends the session on logout", async () => {
    const { auth } = await registerCompany(t.app);
    expect((await t.app.inject({ method: "POST", url: "/auth/logout", headers: auth })).statusCode).toBe(204);
    expect((await t.app.inject({ url: "/auth/me", headers: auth })).statusCode).toBe(401);
  });

  it("validates input", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { companyName: "X Co", name: "X", email: "not-an-email", password: "short" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
  });

  it("rate limits repeated login attempts", async () => {
    const limited = await createTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limited.app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.co", password: "x" } });
      statuses.push(r.statusCode);
      if (r.statusCode === 429) expect(r.json().error.code).toBe("rate_limited");
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    await limited.close();
  });
});

describe("team management", () => {
  it("lets a manager add a supervisor who cannot use the dashboard", async () => {
    const { auth } = await registerCompany(t.app);
    const created = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: auth,
      payload: { name: "Abebe Kebede", role: "supervisor", language: "am" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user).toMatchObject({ role: "supervisor", language: "am", email: null });
  });

  it("requires an email and password for dashboard roles", async () => {
    const { auth } = await registerCompany(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: auth,
      payload: { name: "Sara", role: "project_manager" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("stops a project manager from creating owners and a site engineer from adding anyone", async () => {
    const { auth } = await registerCompany(t.app);
    const pmEmail = `pm${Date.now()}@example.com`;
    await t.app.inject({
      method: "POST",
      url: "/users",
      headers: auth,
      payload: { name: "Sara", role: "project_manager", email: pmEmail, password: "pm password 1" },
    });
    const pmLogin = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email: pmEmail, password: "pm password 1" } });
    const pmAuth = { authorization: `Bearer ${pmLogin.json().token}` };

    const owner = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: pmAuth,
      payload: { name: "New Owner", role: "owner", email: `o${Date.now()}@example.com`, password: "owner pass 1" },
    });
    expect(owner.statusCode).toBe(403);

    const engEmail = `eng${Date.now()}@example.com`;
    await t.app.inject({
      method: "POST",
      url: "/users",
      headers: pmAuth,
      payload: { name: "Dawit", role: "site_engineer", email: engEmail, password: "eng password 1" },
    });
    const engLogin = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email: engEmail, password: "eng password 1" } });
    const engAdd = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${engLogin.json().token}` },
      payload: { name: "Someone", role: "supervisor" },
    });
    expect(engAdd.statusCode).toBe(403);
  });

  it("keeps each company's people separate", async () => {
    const a = await registerCompany(t.app, "Company A");
    const b = await registerCompany(t.app, "Company B");
    const supervisor = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: a.auth,
      payload: { name: "Only In A", role: "supervisor" },
    });
    const id = supervisor.json().user.id;

    const listB = await t.app.inject({ url: "/users", headers: b.auth });
    expect(listB.json().users.map((u: { name: string }) => u.name)).not.toContain("Only In A");

    const patch = await t.app.inject({ method: "PATCH", url: `/users/${id}`, headers: b.auth, payload: { active: false } });
    expect(patch.statusCode).toBe(404);
    const invite = await t.app.inject({ method: "POST", url: `/users/${id}/telegram-invite`, headers: b.auth });
    expect(invite.statusCode).toBe(404);
  });

  it("does not let owners lock themselves out", async () => {
    const { auth, user } = await registerCompany(t.app);
    const response = await t.app.inject({ method: "PATCH", url: `/users/${user.id}`, headers: auth, payload: { active: false } });
    expect(response.statusCode).toBe(400);
  });

  it("creates a Telegram invite code and link", async () => {
    const { auth } = await registerCompany(t.app);
    const supervisor = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: auth,
      payload: { name: "Abebe", role: "supervisor" },
    });
    const invite = await t.app.inject({
      method: "POST",
      url: `/users/${supervisor.json().user.id}/telegram-invite`,
      headers: auth,
    });
    expect(invite.statusCode).toBe(201);
    const { code, link } = invite.json();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(link).toBe(`https://t.me/sitemate_test_bot?start=${code}`);
  });

  it("generates invite codes without confusable characters", () => {
    const codes = Array.from({ length: 200 }, () => inviteCode());
    expect(codes.every((c) => /^[A-HJ-NP-Z2-9]{8}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(200);
  });
});

describe("protected routes", () => {
  it("rejects requests without a valid token", async () => {
    expect((await t.app.inject({ url: "/users" })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/users", headers: { authorization: "Bearer made-up" } })).statusCode).toBe(401);
  });
});
