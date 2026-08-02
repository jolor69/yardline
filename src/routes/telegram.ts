import { Hono } from "hono";
import { z } from "zod";
import { createSession, randomToken } from "../lib/auth";
import {
  completePendingSignup,
  consumePendingSignup,
  countRecentPendingSignupsByIp,
  expirePendingSignup,
  failPendingSignup,
  getAccount,
  getAccountByTelegramId,
  getPendingSignupByChatIdAwaitingContact,
  getTelegramPendingSignup,
  insertAccount,
  insertTelegramPendingSignup,
  linkPendingSignupToChat,
  markPendingSignupAwaitingContact,
  toPublicAccount,
} from "../lib/db";
import { safeJson } from "../lib/http";
import { requestContactKeyboard, sendMessage, verifyWebhookSecret } from "../lib/telegram";
import type { TelegramUpdate } from "../lib/telegram";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

const PENDING_TTL_MINUTES = 10;
const RATE_LIMIT_WINDOW_MINUTES = 60;
// 5/hour proved too tight in practice: household NAT means every device
// behind one router (phone, laptop, etc.) shares a single public IP, and
// even one person testing a couple of times trips it. 20/hour still
// meaningfully blocks automated abuse while covering realistic retries.
const RATE_LIMIT_MAX_PER_IP = 20;

function addMinutes(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// expires_at is stored as "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')
// format, no "T", no "Z" — same shape addDays() produces in lib/auth.ts).
// Converting to real ISO8601 before parsing avoids relying on lenient
// (and inconsistent-across-runtimes) Date parsing of the raw string.
function isPastExpiry(expiresAt: string): boolean {
  return new Date(`${expiresAt.replace(" ", "T")}Z`).getTime() < Date.now();
}

// Bot replies are bilingual, matching this site's EN/ID-first audience —
// Telegram supplies message.from.language_code for free, no geo lookup needed.
function botText(languageCode: string | undefined, en: string, id: string): string {
  return languageCode?.toLowerCase().startsWith("id") ? id : en;
}

// ---------------------------------------------------------------------
// POST /start — browser calls this to begin either flow; returns a deep
// link into Telegram plus a token the browser then polls via /status.
// ---------------------------------------------------------------------

const startSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("signup"),
    role: z.enum(["buyer", "seller"]),
    full_name: z.string().min(1),
  }),
  z.object({ intent: z.literal("login") }),
]);

app.post("/start", async (c) => {
  const body = startSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const recentCount = await countRecentPendingSignupsByIp(
    c.env,
    ip,
    addMinutes(-RATE_LIMIT_WINDOW_MINUTES),
  );
  if (recentCount >= RATE_LIMIT_MAX_PER_IP) {
    return c.json({ error: "Too many attempts — please try again later" }, 429);
  }

  // No email collected upfront anymore (see webhook: a placeholder email is
  // generated at account-creation time instead, since Telegram never
  // provides one) — so there's no email-uniqueness check to do here.
  // telegram_id's own UNIQUE constraint is what catches a real duplicate.

  const token = randomToken();
  const expires_at = addMinutes(PENDING_TTL_MINUTES);

  await insertTelegramPendingSignup(c.env, {
    token,
    intent: body.data.intent,
    role: body.data.intent === "signup" ? body.data.role : null,
    // Reusing the company_name column as a generic display-name field —
    // it's shown as a plain name everywhere in the UI (dashboards, admin
    // table), no company-specific validation depends on it.
    company_name: body.data.intent === "signup" ? body.data.full_name : null,
    requester_ip: ip,
    expires_at,
  });

  const deep_link = `https://t.me/${c.env.TELEGRAM_BOT_USERNAME}?start=${token}`;
  return c.json({ token, deep_link, expires_at });
});

// ---------------------------------------------------------------------
// POST /webhook — Telegram calls this. Always return 200 for any outcome
// we've already communicated to the user via a bot reply, so Telegram
// doesn't retry cases that will never resolve differently on retry.
// ---------------------------------------------------------------------

app.post("/webhook", async (c) => {
  if (!verifyWebhookSecret(c.env, c.req.header("X-Telegram-Bot-Api-Secret-Token"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const update = (await safeJson(c)) as TelegramUpdate;
  const message = update.message;
  if (!message || !message.from) {
    return c.json({ ok: true });
  }

  const from = message.from;
  const chatId = message.chat.id;

  if (message.text?.startsWith("/start ")) {
    const token = message.text.slice("/start ".length).trim();
    const row = await getTelegramPendingSignup(c.env, token);

    const invalid =
      !row ||
      isPastExpiry(row.expires_at) ||
      !["awaiting_start", "awaiting_contact"].includes(row.status);

    if (invalid) {
      if (row && row.status === "awaiting_start") await expirePendingSignup(c.env, token);
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "This signup link is invalid or has expired — please go back to Yardline and try again.",
          "Tautan pendaftaran ini tidak valid atau sudah kedaluwarsa — silakan kembali ke Yardline dan coba lagi.",
        ),
      );
      return c.json({ ok: true });
    }

    await linkPendingSignupToChat(c.env, token, {
      chat_id: chatId,
      telegram_user_id: from.id,
      telegram_username: from.username ?? null,
    });

    const existingAccount = await getAccountByTelegramId(c.env, from.id);
    if (existingAccount) {
      await completePendingSignup(c.env, token, existingAccount.id, "existing_account_logged_in");
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "Welcome back — you're logged in. You can close Telegram now and go back to the Yardline tab; it'll continue automatically.",
          "Selamat datang kembali — Anda sudah masuk. Anda bisa menutup Telegram sekarang dan kembali ke tab Yardline; halaman akan lanjut secara otomatis.",
        ),
      );
      return c.json({ ok: true });
    }

    if (row!.intent === "login") {
      await failPendingSignup(c.env, token, "not_registered");
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "We couldn't find a Yardline account linked to this Telegram. Please sign up first, or log in with email and password if you already have an account.",
          "Kami tidak menemukan akun Yardline yang terhubung dengan Telegram ini. Silakan daftar dulu, atau masuk dengan email dan kata sandi jika Anda sudah punya akun.",
        ),
      );
      return c.json({ ok: true });
    }

    await markPendingSignupAwaitingContact(c.env, token, {
      chat_id: chatId,
      telegram_user_id: from.id,
      telegram_username: from.username ?? null,
    });
    await sendMessage(
      c.env,
      chatId,
      botText(
        from.language_code,
        "Thanks! Tap the \"Share phone number\" button below to finish registering. Please don't type your number into the message box — typing it will not complete your registration, only tapping the button works.",
        "Terima kasih! Ketuk tombol \"Bagikan nomor telepon\" di bawah untuk menyelesaikan pendaftaran. Jangan mengetik nomor Anda di kotak pesan — mengetiknya tidak akan menyelesaikan pendaftaran, hanya menekan tombol yang berfungsi.",
      ),
      requestContactKeyboard(
        botText(from.language_code, "📱 Share phone number", "📱 Bagikan nomor telepon"),
      ),
    );
    return c.json({ ok: true });
  }

  // A user waiting for contact-share sometimes types their number as a
  // plain message instead of tapping the button — that arrives as regular
  // text, not a `contact` payload, so without this it's silently ignored
  // (confirmed live: no webhook call at all followed a typed number).
  // Typed numbers aren't Telegram-verified, so we don't accept them as a
  // fallback — just point back at the button and resend it.
  if (message.text && !message.text.startsWith("/")) {
    const awaitingRow = await getPendingSignupByChatIdAwaitingContact(c.env, chatId);
    if (awaitingRow) {
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "Typing your number won't complete your registration — please tap the \"Share phone number\" button below instead, that's what lets us verify it's really yours.",
          "Mengetik nomor Anda tidak akan menyelesaikan pendaftaran — silakan ketuk tombol \"Bagikan nomor telepon\" di bawah, itu yang memungkinkan kami memverifikasi bahwa itu benar nomor Anda.",
        ),
        requestContactKeyboard(
          botText(from.language_code, "📱 Share phone number", "📱 Bagikan nomor telepon"),
        ),
      );
      return c.json({ ok: true });
    }
  }

  if (message.contact) {
    const row = await getPendingSignupByChatIdAwaitingContact(c.env, chatId);
    if (!row) {
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "Please start over from the Yardline website.",
          "Silakan mulai lagi dari situs Yardline.",
        ),
      );
      return c.json({ ok: true });
    }

    if (message.contact.user_id && message.contact.user_id !== from.id) {
      await sendMessage(
        c.env,
        chatId,
        botText(
          from.language_code,
          "Please share your own phone number using the button provided.",
          "Silakan bagikan nomor telepon Anda sendiri menggunakan tombol yang disediakan.",
        ),
      );
      return c.json({ ok: true });
    }

    // Only the account-creation + pending-row transition are the critical
    // path here — a failure in the *notification* sendMessage below must
    // never roll this back to 'error', since /status would then tell a
    // successfully-registered user their signup failed and never mint them
    // a session. Notification is best-effort, isolated in its own try/catch.
    let newAccountId: number | null = null;
    try {
      const account = await insertAccount(c.env, {
        role: row.role!,
        company_name: row.company_name!,
        // Telegram signup no longer collects an email (see the simplified
        // /start schema above) — accounts.email is still NOT NULL UNIQUE
        // and used for post-match contact exchange, so a placeholder is
        // generated here. It's never sent to or displayed prominently;
        // phone (the real, Telegram-verified contact channel) is already
        // shown alongside it in contact exchange, so this is cosmetic
        // plumbing, not a functional gap. Keyed on telegram_id, which is
        // itself unique, so this can never collide.
        email: `telegram-${from.id}@yardline.invalid`,
        phone: message.contact.phone_number,
        telegram_id: from.id,
        telegram_username: from.username ?? null,
      });
      await completePendingSignup(c.env, row.token, account.id);
      newAccountId = account.id;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const detail = errMessage.includes("telegram_id")
        ? "telegram_already_linked"
        : errMessage.includes("email")
          ? "email_taken"
          : "signup_failed";
      console.error("Telegram signup failed", err);
      await failPendingSignup(c.env, row.token, detail);
    }

    try {
      await sendMessage(
        c.env,
        chatId,
        newAccountId
          ? botText(
              from.language_code,
              "You're all set! You can close Telegram now and go back to the Yardline tab; it'll continue automatically.",
              "Semua sudah siap! Anda bisa menutup Telegram sekarang dan kembali ke tab Yardline; halaman akan lanjut secara otomatis.",
            )
          : botText(
              from.language_code,
              "Something went wrong finishing your registration — please go back to Yardline and try again.",
              "Terjadi kesalahan saat menyelesaikan pendaftaran Anda — silakan kembali ke Yardline dan coba lagi.",
            ),
      );
    } catch (err) {
      console.error("Telegram notification failed (non-critical)", err);
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------
// GET /status?token= — polled by the browser tab that opened the deep
// link. Session creation happens exactly once, on the first read of a
// 'completed' row, which then flips it to 'consumed'.
// ---------------------------------------------------------------------

app.get("/status", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);

  const row = await getTelegramPendingSignup(c.env, token);
  if (!row) return c.json({ status: "not_found" }, 404);

  if (row.status === "awaiting_start" || row.status === "awaiting_contact") {
    if (isPastExpiry(row.expires_at)) {
      await expirePendingSignup(c.env, token);
      return c.json({ status: "expired" });
    }
    return c.json({ status: row.status });
  }

  if (row.status === "expired") return c.json({ status: "expired" });
  if (row.status === "error") return c.json({ status: "error", detail: row.detail });
  if (row.status === "consumed") return c.json({ status: "consumed" });

  // completed — first read mints the session, then consumes the token.
  const account = row.account_id ? await getAccount(c.env, row.account_id) : null;
  if (!account) return c.json({ status: "error", detail: "account_missing" });

  await createSession(c.env, c, account.id);
  await consumePendingSignup(c.env, token);
  return c.json({ status: "completed", account: toPublicAccount(account) });
});

export default app;
