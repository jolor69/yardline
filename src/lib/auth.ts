import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  deleteSession,
  getSessionAccount,
  insertSession,
} from "./db";
import type { Account, Env, Role } from "./types";

const SESSION_COOKIE = "yardline_session";
const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;

// ---------------------------------------------------------------------
// Password hashing — PBKDF2-SHA256 via Workers-native crypto.subtle.
// No bcrypt without WASM; this is the standard Workers-native choice.
// Stored as "saltB64:hashB64".
// ---------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKey(password, salt);
  return `${toBase64(salt)}:${toBase64(hash)}`;
}

// Telegram-only accounts have no password. This sentinel is deliberately
// colon-free: verifyPassword() below does stored.split(":"), and a
// colon-free string makes hashB64 undefined, so it returns false safely
// with no extra null-checks needed anywhere a password_hash is read.
export const NO_PASSWORD_SENTINEL = "telegram-account-no-password";

export function hasPassword(account: Account): boolean {
  return account.password_hash !== NO_PASSWORD_SENTINEL;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const salt = fromBase64(saltB64);
  const expected = fromBase64(hashB64);
  const actual = await deriveKey(password, salt);
  if (actual.length !== expected.length) return false;
  // Constant-time compare — timing attacks aren't the primary threat model
  // here, but it costs nothing to not leak a timing side-channel on login.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------
// Tokens — sessions and password-reset tokens use the same random-token
// shape (32 bytes, base64url, unguessable).
// ---------------------------------------------------------------------

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function addDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------
// Sessions + cookie
// ---------------------------------------------------------------------

export async function createSession(env: Env, c: Context, accountId: number): Promise<void> {
  const token = randomToken();
  await insertSession(env, token, accountId, addDays(SESSION_TTL_DAYS));
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export async function destroySession(env: Env, c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(env, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

async function resolveAccount(env: Env, c: Context): Promise<Account | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return getSessionAccount(env, token);
}

// ---------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------

declare module "hono" {
  interface ContextVariableMap {
    account: Account;
  }
}

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const account = await resolveAccount(c.env, c);
  if (!account) throw new HTTPException(401, { message: "Not signed in" });
  c.set("account", account);
  await next();
}

export function requireRole(...roles: Role[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const account = c.get("account");
    if (!account || !roles.includes(account.role)) {
      throw new HTTPException(403, { message: `Requires role: ${roles.join(" or ")}` });
    }
    await next();
  };
}

export { SESSION_TTL_DAYS };
export function resetTokenExpiry(): string {
  return addDays(1); // reset links expire in 24h
}
