import type {
  SendOptions,
  TelegramApi,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../../src/telegram/api.js";

export interface SentMessage {
  chatId: number;
  text: string;
  options: SendOptions;
  messageId: number;
}

/** Records what the bot sends and serves files from memory. */
export class FakeTelegramApi implements TelegramApi {
  sent: SentMessage[] = [];
  answered: Array<{ id: string; text: string | undefined }> = [];
  removedButtons: Array<{ chatId: number; messageId: number }> = [];
  files = new Map<string, { data: Buffer; path: string }>();
  webhook: { url: string; secret: string } | null = null;
  private nextMessageId = 1000;

  async getMe(): Promise<TelegramUser> {
    return { id: 1, is_bot: true, username: "sitemate_test_bot" };
  }

  async sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<TelegramMessage> {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, text, options, messageId });
    return { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, text };
  }

  async removeButtons(chatId: number, messageId: number) {
    this.removedButtons.push({ chatId, messageId });
  }

  async answerCallback(id: string, text?: string) {
    this.answered.push({ id, text });
  }

  async downloadFile(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`No fake file ${fileId}`);
    return file;
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async setWebhook(url: string, secret: string) {
    this.webhook = { url, secret };
  }

  async deleteWebhook() {
    this.webhook = null;
  }

  textsTo(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }

  reset() {
    this.sent = [];
    this.answered = [];
    this.removedButtons = [];
  }
}

let updateId = 1;

export function textUpdate(from: number, text: string, language = "en"): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId * 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: "private" },
      from: { id: from, first_name: "Test", language_code: language },
      text,
    },
  };
}

export function photoUpdate(from: number, fileId: string, caption?: string): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId * 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: "private" },
      from: { id: from, first_name: "Test" },
      ...(caption ? { caption } : {}),
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: "s", width: 90, height: 60 },
        { file_id: fileId, file_unique_id: "l", width: 1280, height: 960 },
      ],
    },
  };
}

export function voiceUpdate(from: number, fileId: string): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId * 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: "private" },
      from: { id: from, first_name: "Test" },
      voice: { file_id: fileId, duration: 12, mime_type: "audio/ogg" },
    },
  };
}

export function callbackUpdate(from: number, data: string, messageId = 1): TelegramUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: from },
      data,
      message: { message_id: messageId, date: 0, chat: { id: from, type: "private" } },
    },
  };
}
