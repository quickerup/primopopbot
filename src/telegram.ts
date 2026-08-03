// ---------------------------------------------------------------------------
// Minimal fetch-based Telegram Bot API client. Replaces python-telegram-bot;
// there's no SDK dependency here on purpose, just thin wrappers over the
// HTTP API, since that's all a webhook-driven Worker needs.
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_MESSAGE_LEN = 4096;

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  document?: { file_id: string; file_name?: string };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramClient {
  constructor(private token: string) {}

  async callApi<T = any>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed: ${data.description ?? res.status}`);
    }
    return data.result as T;
  }

  async getMe() {
    return this.callApi<TgUser>("getMe");
  }

  async setWebhook(url: string, secretToken: string) {
    return this.callApi("setWebhook", { url, secret_token: secretToken, drop_pending_updates: true });
  }

  async deleteWebhook() {
    return this.callApi("deleteWebhook", { drop_pending_updates: true });
  }

  async getFile(fileId: string) {
    return this.callApi<{ file_id: string; file_path?: string }>("getFile", { file_id: fileId });
  }

  fileDownloadUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    opts: { parse_mode?: string; disable_web_page_preview?: boolean; reply_markup?: unknown } = {}
  ) {
    // Telegram caps messages at 4096 chars; chunk on whitespace where possible.
    const chunks = chunkText(text, TELEGRAM_MAX_MESSAGE_LEN);
    let last;
    for (const chunk of chunks) {
      last = await this.callApi("sendMessage", { chat_id: chatId, text: chunk, ...opts });
    }
    return last;
  }

  async sendPhoto(chatId: number | string, photo: string, caption?: string) {
    return this.callApi("sendPhoto", { chat_id: chatId, photo, caption });
  }

  async sendVideo(chatId: number | string, video: string, caption?: string) {
    return this.callApi("sendVideo", { chat_id: chatId, video, caption });
  }

  async sendDocument(chatId: number | string, document: string, caption?: string) {
    return this.callApi("sendDocument", { chat_id: chatId, document, caption });
  }

  async sendLocation(chatId: number | string, latitude: number, longitude: number) {
    return this.callApi("sendLocation", { chat_id: chatId, latitude, longitude });
  }

  async sendDice(chatId: number | string, emoji?: string) {
    return this.callApi("sendDice", { chat_id: chatId, emoji });
  }

  async sendPoll(
    chatId: number | string,
    question: string,
    options: string[],
    is_anonymous = true,
    allows_multiple_answers = false
  ) {
    return this.callApi("sendPoll", { chat_id: chatId, question, options, is_anonymous, allows_multiple_answers });
  }

  async sendMessageWithInlineKeyboard(
    chatId: number | string,
    text: string,
    buttons: { text: string; url?: string; callback_data?: string }[][],
    opts: { parse_mode?: string; disable_web_page_preview?: boolean } = {}
  ) {
    return this.callApi("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: buttons },
      ...opts,
    });
  }

  async sendMessageWithKeyboard(
    chatId: number | string,
    text: string,
    buttons: string[][],
    oneTime = true
  ) {
    return this.callApi("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard: buttons.map((row) => row.map((label) => ({ text: label }))),
        one_time_keyboard: oneTime,
        resize_keyboard: true,
      },
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.callApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  async setMyCommands(commands: { command: string; description: string }[]) {
    return this.callApi("setMyCommands", { commands });
  }

  async deleteMessage(chatId: number | string, messageId: number) {
    try {
      return await this.callApi("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      // Best-effort hygiene delete
      return undefined;
    }
  }
}

export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text.length ? text : " "];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}
