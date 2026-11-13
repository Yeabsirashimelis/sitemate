import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { User } from "../auth/sessions.js";
import { audit } from "../audit.js";
import type { Database, Executor } from "../db/client.js";
import { companies, invites, messages, projectMembers, projects, telegramUpdates, users } from "../db/schema.js";
import { t } from "../i18n.js";
import { enqueue, type Logger } from "../jobs/queue.js";
import type { Project } from "../services/schedule.js";
import type { SendOptions, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./api.js";

export type MessageRow = typeof messages.$inferSelect;

export interface MessageContext {
  user: User;
  project: Project | null;
  message: MessageRow;
  telegram: TelegramMessage;
}

export interface CallbackContext {
  user: User;
  /** Text after the prefix, e.g. "<id>:approve" for "ap:<id>:approve". */
  data: string;
  query: TelegramCallbackQuery;
}

export type MessageHandler = (context: MessageContext) => Promise<boolean>;
export type CallbackHandler = (context: CallbackContext) => Promise<string | void>;

export const TELEGRAM_UPDATE_JOB = "telegram.update";

/** Stores a raw update and queues it. A repeated update id is ignored, so Telegram retries are harmless. */
export async function receiveUpdate(db: Executor, update: TelegramUpdate): Promise<boolean> {
  const inserted = await db
    .insert(telegramUpdates)
    .values({ updateId: update.update_id, payload: update })
    .onConflictDoNothing()
    .returning({ id: telegramUpdates.updateId });
  if (inserted.length === 0) return false;
  await enqueue(db, TELEGRAM_UPDATE_JOB, { updateId: update.update_id }, { idempotencyKey: `tg:${update.update_id}` });
  return true;
}

function describeMessage(message: TelegramMessage) {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    return { kind: "photo" as const, text: message.caption ?? null, fileId: largest.file_id, mimeType: "image/jpeg" };
  }
  if (message.voice) {
    return { kind: "voice" as const, text: message.caption ?? null, fileId: message.voice.file_id, mimeType: message.voice.mime_type ?? "audio/ogg" };
  }
  if (message.audio) {
    return { kind: "voice" as const, text: message.caption ?? null, fileId: message.audio.file_id, mimeType: message.audio.mime_type ?? "audio/mpeg" };
  }
  if (message.document) {
    return {
      kind: "document" as const,
      text: message.caption ?? null,
      fileId: message.document.file_id,
      mimeType: message.document.mime_type ?? "application/octet-stream",
    };
  }
  return { kind: "text" as const, text: message.text ?? null, fileId: null, mimeType: null };
}

export class TelegramBot {
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly callbackHandlers = new Map<string, CallbackHandler>();

  constructor(
    private readonly db: Database,
    readonly api: TelegramApi,
    private readonly logger: Logger,
  ) {}

  /** Handlers are tried in order until one returns true. */
  onMessage(handler: MessageHandler): this {
    this.messageHandlers.push(handler);
    return this;
  }

  /** Callback data looks like "<prefix>:<rest>". Prefixes must be unique. */
  onCallback(prefix: string, handler: CallbackHandler): this {
    if (this.callbackHandlers.has(prefix)) throw new Error(`Callback prefix "${prefix}" is already registered`);
    this.callbackHandlers.set(prefix, handler);
    return this;
  }

  async processStoredUpdate(updateId: number): Promise<void> {
    const [row] = await this.db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId));
    if (!row) throw new Error(`Telegram update ${updateId} not found`);
    if (row.processedAt) return;
    await this.handleUpdate(row.payload as TelegramUpdate);
    await this.db.update(telegramUpdates).set({ processedAt: new Date() }).where(eq(telegramUpdates.updateId, updateId));
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const message = update.message;
    if (!message?.from || message.from.is_bot || message.chat.type !== "private") return;

    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9]{6,12})\s*$/.exec(message.text ?? "");
    if (start) return this.linkAccount(message, start[1]!.toUpperCase());

    const user = await this.findUser(message.from.id);
    if (!user) {
      const language = message.from.language_code === "am" ? "am" : "en";
      await this.api.sendMessage(message.chat.id, t("unknownUser", language));
      return;
    }
    if (user.telegramChatId !== message.chat.id) {
      await this.db.update(users).set({ telegramChatId: message.chat.id }).where(eq(users.id, user.id));
      user.telegramChatId = message.chat.id;
    }

    const project = await this.activeProjectFor(user);
    const described = describeMessage(message);
    const [stored] = await this.db
      .insert(messages)
      .values({
        companyId: user.companyId,
        projectId: project?.id ?? null,
        userId: user.id,
        direction: "in",
        kind: described.kind,
        text: described.text,
        telegramChatId: message.chat.id,
        telegramMessageId: message.message_id,
        telegramFileId: described.fileId,
        mimeType: described.mimeType,
      })
      .returning();

    const context: MessageContext = { user, project, message: stored!, telegram: message };
    for (const handler of this.messageHandlers) {
      if (await handler(context)) return;
    }
    if (!project) {
      await this.sendToUser(user, t("notOnProject", user.language));
      return;
    }
    await this.sendToUser(user, t("received", user.language), { projectId: project.id });
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const user = await this.findUser(query.from.id);
    if (!user) {
      await this.api.answerCallback(query.id, "Not linked to SiteMate");
      return;
    }
    const data = query.data ?? "";
    const separator = data.indexOf(":");
    const handler = separator > 0 ? this.callbackHandlers.get(data.slice(0, separator)) : undefined;
    if (!handler) {
      await this.api.answerCallback(query.id);
      return;
    }
    try {
      const reply = await handler({ user, data: data.slice(separator + 1), query });
      await this.api.answerCallback(query.id, reply ?? undefined);
    } catch (error) {
      this.logger.error({ err: error, data }, "Callback handler failed");
      await this.api.answerCallback(query.id, t("somethingWrong", user.language));
    }
  }

  private async linkAccount(message: TelegramMessage, code: string): Promise<void> {
    const from = message.from!;
    const language = from.language_code === "am" ? "am" : "en";
    const linked = await this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.code, code), isNull(invites.usedAt), gt(invites.expiresAt, new Date())));
      if (!invite) return null;

      // One Telegram account belongs to one SiteMate user.
      await tx.update(users).set({ telegramUserId: null, telegramChatId: null }).where(eq(users.telegramUserId, from.id));
      const [user] = await tx
        .update(users)
        .set({ telegramUserId: from.id, telegramChatId: message.chat.id })
        .where(eq(users.id, invite.userId))
        .returning();
      await tx.update(invites).set({ usedAt: new Date() }).where(eq(invites.code, code));
      const [company] = await tx.select().from(companies).where(eq(companies.id, invite.companyId));
      await audit(tx, {
        companyId: invite.companyId,
        actor: { type: "user", id: invite.userId },
        action: "telegram.linked",
        subject: { type: "user", id: invite.userId },
      });
      return { user: user!, company: company! };
    });

    if (!linked) {
      await this.api.sendMessage(message.chat.id, t("inviteInvalid", language));
      return;
    }
    await this.sendToUser(linked.user, t("welcome", linked.user.language, linked.user.name, linked.company.name));
  }

  async findUser(telegramUserId: number): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.telegramUserId, telegramUserId), eq(users.active, true)));
    return user ?? null;
  }

  /** The most recently created active project the user is a member of. */
  async activeProjectFor(user: Pick<User, "id">): Promise<Project | null> {
    const [row] = await this.db
      .select({ project: projects })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, user.id), eq(projects.active, true)))
      .orderBy(desc(projects.createdAt))
      .limit(1);
    return row?.project ?? null;
  }

  /**
   * Sends a message and records it. Users without a linked Telegram account
   * are skipped. A network failure is retried once and then logged rather
   * than thrown: the work behind the message is already saved, and failing
   * the job would only make it run again.
   */
  async sendToUser(
    user: Pick<User, "id" | "companyId" | "telegramChatId">,
    text: string,
    options: SendOptions & { projectId?: string; dailyLogId?: string } = {},
  ): Promise<{ chatId: number; messageId: number } | null> {
    if (!user.telegramChatId) {
      this.logger.warn({ userId: user.id }, "User has no Telegram chat, message not sent");
      return null;
    }
    const chatId = user.telegramChatId;
    const send = () => this.api.sendMessage(chatId, text, options);
    const sent = await send()
      .catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return send();
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error, userId: user.id }, "Telegram message could not be sent");
        return null;
      });
    if (!sent) return null;
    await this.db.insert(messages).values({
      companyId: user.companyId,
      projectId: options.projectId ?? null,
      userId: user.id,
      dailyLogId: options.dailyLogId ?? null,
      direction: "out",
      kind: "text",
      text,
      telegramChatId: user.telegramChatId,
      telegramMessageId: sent.message_id,
    });
    return { chatId: user.telegramChatId, messageId: sent.message_id };
  }
}
