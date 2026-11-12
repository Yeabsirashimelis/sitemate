import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { messages, telegramUpdates, users } from "../src/db/schema.js";
import { receiveUpdate } from "../src/telegram/bot.js";
import { createTestApp, registerCompany, type TestApp } from "./helpers/app.js";
import { callbackUpdate, photoUpdate, textUpdate, voiceUpdate } from "./helpers/telegram.js";

let t: TestApp;
let tgId = 500_000;

beforeAll(async () => {
  t = await createTestApp({ TELEGRAM_WEBHOOK_SECRET: "hook-secret" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.telegram.reset());

/** Stores an update the way the webhook would, then processes queued jobs. */
async function deliver(update: Parameters<typeof receiveUpdate>[1]) {
  await receiveUpdate(t.handle.db, update);
  await t.runtime.runner.drain();
}

async function supervisorWithInvite(language: "en" | "am" = "en") {
  const { auth } = await registerCompany(t.app, "Abay Construction");
  const created = await t.app.inject({
    method: "POST",
    url: "/users",
    headers: auth,
    payload: { name: "Abebe Kebede", role: "supervisor", language },
  });
  const userId = created.json().user.id as string;
  const invite = await t.app.inject({ method: "POST", url: `/users/${userId}/telegram-invite`, headers: auth });
  return { auth, userId, code: invite.json().code as string, telegramId: ++tgId };
}

describe("account linking", () => {
  it("links a Telegram account with a valid code and welcomes the user", async () => {
    const { userId, code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));

    const [user] = await t.handle.db.select().from(users).where(eq(users.id, userId));
    expect(user!.telegramUserId).toBe(telegramId);
    expect(t.telegram.textsTo(telegramId)[0]).toMatch(/Welcome Abebe Kebede.*Abay Construction/);
  });

  it("welcomes in Amharic when the user's language is Amharic", async () => {
    const { code, telegramId } = await supervisorWithInvite("am");
    await deliver(textUpdate(telegramId, `/start ${code}`));
    expect(t.telegram.textsTo(telegramId)[0]).toMatch(/እንኳን ደህና መጡ/);
  });

  it("does not accept a code twice", async () => {
    const { code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));
    await deliver(textUpdate(telegramId + 1, `/start ${code}`));
    expect(t.telegram.textsTo(telegramId + 1)[0]).toMatch(/not valid or has expired/);
  });

  it("asks unknown people for their code", async () => {
    await deliver(textUpdate(999_001, "hello"));
    expect(t.telegram.textsTo(999_001)[0]).toMatch(/send the code your project manager gave you/);
  });
});

describe("incoming messages", () => {
  it("stores text, photos and voice notes with their file ids", async () => {
    const { userId, code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));
    await deliver(textUpdate(telegramId, "Poured the ground floor slab today"));
    await deliver(photoUpdate(telegramId, "photo-large", "Slab after pour"));
    await deliver(voiceUpdate(telegramId, "voice-1"));

    const rows = await t.handle.db.select().from(messages).where(eq(messages.userId, userId));
    const incoming = rows.filter((r) => r.direction === "in");
    expect(incoming.map((r) => [r.kind, r.text, r.telegramFileId])).toEqual([
      ["text", "Poured the ground floor slab today", null],
      ["photo", "Slab after pour", "photo-large"],
      ["voice", null, "voice-1"],
    ]);
    // Not on a project yet, so the bot says so.
    expect(t.telegram.textsTo(telegramId).at(-1)).toMatch(/not on any active project/);
  });

  it("processes each update once even if Telegram delivers it twice", async () => {
    const { userId, code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));
    const update = textUpdate(telegramId, "Only once please");
    await deliver(update);
    await deliver(update);
    const rows = await t.handle.db.select().from(messages).where(eq(messages.userId, userId));
    expect(rows.filter((r) => r.text === "Only once please")).toHaveLength(1);
  });

  it("passes messages to registered handlers before the default reply", async () => {
    const { code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));
    const seen: string[] = [];
    t.runtime.bot!.onMessage(async ({ message }) => {
      if (message.text !== "handled") return false;
      seen.push(message.text);
      return true;
    });
    t.telegram.reset();
    await deliver(textUpdate(telegramId, "handled"));
    expect(seen).toEqual(["handled"]);
    expect(t.telegram.textsTo(telegramId)).toEqual([]);
  });
});

describe("callbacks", () => {
  it("routes button presses by prefix and answers the callback", async () => {
    const { code, telegramId } = await supervisorWithInvite();
    await deliver(textUpdate(telegramId, `/start ${code}`));
    const pressed: string[] = [];
    t.runtime.bot!.onCallback("test", async ({ data }) => {
      pressed.push(data);
      return "Done";
    });
    await deliver(callbackUpdate(telegramId, "test:abc:approve"));
    expect(pressed).toEqual(["abc:approve"]);
    expect(t.telegram.answered.at(-1)?.text).toBe("Done");
  });
});

describe("webhook", () => {
  it("rejects calls without the right secret", async () => {
    const update = textUpdate(1, "hi");
    const missing = await t.app.inject({ method: "POST", url: "/telegram/webhook", payload: update });
    const wrong = await t.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: update,
      headers: { "x-telegram-bot-api-secret-token": "nope" },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("stores the update and answers straight away", async () => {
    const update = textUpdate(424242, "via webhook");
    const response = await t.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: update,
      headers: { "x-telegram-bot-api-secret-token": "hook-secret" },
    });
    expect(response.statusCode).toBe(200);
    const [stored] = await t.handle.db
      .select()
      .from(telegramUpdates)
      .where(eq(telegramUpdates.updateId, update.update_id));
    expect(stored).toBeDefined();
  });
});
