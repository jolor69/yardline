import { Hono } from "hono";
import { z } from "zod";
import {
  createSession,
  destroySession,
  hashPassword,
  randomToken,
  requireAuth,
  resetTokenExpiry,
  verifyPassword,
} from "../lib/auth";
import {
  deleteSessionsForAccount,
  getAccountByEmail,
  getValidResetToken,
  insertAccount,
  insertResetToken,
  markResetTokenUsed,
  toPublicAccount,
  updateAccountPassword,
} from "../lib/db";
import { safeJson } from "../lib/http";
import { sendPasswordResetEmail } from "../lib/resend";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

const signupSchema = z.object({
  role: z.enum(["buyer", "seller"]), // admin is never self-registered — see lib/auth.ts / plan
  company_name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

app.post("/signup", async (c) => {
  const body = signupSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid signup payload", details: body.error.issues }, 400);
  }

  const existing = await getAccountByEmail(c.env, body.data.email);
  if (existing) {
    // Same email can never be both buyer and seller (or sign up twice) —
    // this UNIQUE constraint is what enforces that rule end to end.
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const password_hash = await hashPassword(body.data.password);
  const account = await insertAccount(c.env, { ...body.data, password_hash });
  await createSession(c.env, c, account.id);
  return c.json(toPublicAccount(account), 201);
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/login", async (c) => {
  const body = loginSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid login payload", details: body.error.issues }, 400);
  }

  const account = await getAccountByEmail(c.env, body.data.email);
  const ok = account ? await verifyPassword(body.data.password, account.password_hash) : false;
  if (!account || !ok) {
    return c.json({ error: "Incorrect email or password" }, 401);
  }

  await createSession(c.env, c, account.id);
  return c.json(toPublicAccount(account));
});

app.post("/logout", async (c) => {
  await destroySession(c.env, c);
  return c.json({ ok: true });
});

app.get("/me", requireAuth, async (c) => {
  return c.json(toPublicAccount(c.get("account")));
});

const forgotSchema = z.object({ email: z.string().email() });

app.post("/forgot-password", async (c) => {
  const body = forgotSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }

  const account = await getAccountByEmail(c.env, body.data.email);
  // Always return the same generic response whether or not the account
  // exists — the alternative leaks which emails are registered.
  if (account) {
    const token = randomToken();
    await insertResetToken(c.env, token, account.id, resetTokenExpiry());
    const resetUrl = `https://yardline.neulab.xyz/reset-password?token=${token}`;
    try {
      await sendPasswordResetEmail(c.env, account.email, resetUrl);
    } catch (err) {
      console.error("Password reset email failed to send", err);
      // Don't leak the failure to the client either — same reasoning as above.
    }
  }

  return c.json({
    ok: true,
    message: "If an account with that email exists, a reset link has been sent.",
  });
});

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

app.post("/reset-password", async (c) => {
  const body = resetSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }

  const resetToken = await getValidResetToken(c.env, body.data.token);
  if (!resetToken) {
    return c.json({ error: "This reset link is invalid or has expired" }, 400);
  }

  const password_hash = await hashPassword(body.data.password);
  await updateAccountPassword(c.env, resetToken.account_id, password_hash);
  await markResetTokenUsed(c.env, body.data.token);
  // Force re-login everywhere — a password reset should invalidate every
  // existing session, including whatever session (if any) leaked the
  // password in the first place.
  await deleteSessionsForAccount(c.env, resetToken.account_id);

  return c.json({ ok: true });
});

export default app;
