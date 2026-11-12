/**
 * Thin client for the Telegram Bot API.
 *
 * Only the calls SiteMate needs are wrapped. Everything goes through one
 * interface so tests can swap in a fake and check exactly what was sent.
 */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendOptions {
  buttons?: InlineButton[][];
  replyToMessageId?: number;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<TelegramMessage>;
  removeButtons(chatId: number, messageId: number): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /** Downloads a file sent to the bot. Telegram allows bots up to 20 MB. */
  downloadFile(fileId: string): Promise<{ data: Buffer; path: string }>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  deleteWebhook(): Promise<void>;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = "TelegramApiError";
  }
}

/** Telegram limits a message to 4096 characters. */
export const MAX_MESSAGE_LENGTH = 4096;

export class HttpTelegramApi implements TelegramApi {
  private readonly base: string;
  private readonly fileBase: string;

  constructor(token: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      throw new TelegramApiError(
        method,
        json.error_code ?? response.status,
        json.description ?? "unknown error",
        json.parameters?.retry_after,
      );
    }
    return json.result as T;
  }

  getMe() {
    return this.call<TelegramUser>("getMe");
  }

  sendMessage(chatId: number, text: string, options: SendOptions = {}) {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text,
      link_preview_options: { is_disabled: true },
      ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
      ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
    });
  }

  async removeButtons(chatId: number, messageId: number) {
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  async answerCallback(callbackId: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async downloadFile(fileId: string) {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramApiError("getFile", 400, "file has no path");
    const response = await this.fetchImpl(`${this.fileBase}/${file.file_path}`);
    if (!response.ok) throw new TelegramApiError("downloadFile", response.status, response.statusText);
    return { data: Buffer.from(await response.arrayBuffer()), path: file.file_path };
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal) {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }

  async setWebhook(url: string, secretToken: string) {
    await this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook() {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }
}
