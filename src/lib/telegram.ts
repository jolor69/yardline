import type { Env } from "./types";

// Telegram Bot API — same call-a-secret-gated-REST-API pattern as
// src/lib/resend.ts. Used for the Telegram-based signup/login flow; see
// src/routes/telegram.ts for the webhook and state machine that drive this.

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  contact?: TelegramContact;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string; request_contact?: boolean }>>;
  resize_keyboard: boolean;
  one_time_keyboard: boolean;
}

export function requestContactKeyboard(buttonText: string): ReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: buttonText, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: ReplyKeyboardMarkup,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }
}

// Constant-time compare — same technique as verifyPassword's diff loop in
// src/lib/auth.ts. Telegram signs webhook requests with this secret
// (set once via the setWebhook API call, see plan's Setup section) so we
// can trust the payload actually came from Telegram before touching the DB.
export function verifyWebhookSecret(env: Env, headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
