import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import {
  approveMatch,
  deactivateAccount,
  getAccount,
  getListing,
  getSetting,
  getThreadMessages,
  listAccounts,
  listAllConversations,
  listAllListings,
  listApprovedMatches,
  listPendingMatches,
  setSetting,
  toPublicAccount,
  updateAccountAdminFields,
} from "../lib/db";
import { safeJson } from "../lib/http";
import type { Env } from "../lib/types";

// Every route in this file requires role=admin. Note on scope: admin
// "listing on behalf of a seller" is NOT a separate POST here — it's the
// same POST /api/listings used by sellers, just with account_id supplied
// in the body (see the comment in routes/listings.ts). Duplicating the
// extraction/draft/confirm flow here would just be two code paths doing
// the same thing.
const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth, requireRole("admin"));

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

app.get("/accounts", async (c) => {
  const role = c.req.query("role");
  const accounts = await listAccounts(c.env, role);
  return c.json(accounts.map(toPublicAccount));
});

const accountPatchSchema = z.object({
  verification_status: z.enum(["pending", "verified"]).optional(),
  can_self_list: z.boolean().optional(),
  max_photos_override: z.number().int().min(1).nullable().optional(),
  role: z.enum(["buyer", "seller", "admin"]).optional(),
});

app.patch("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid account id" }, 400);

  const raw = await safeJson(c);
  const body = accountPatchSchema.safeParse(raw);
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }

  const existing = await getAccount(c.env, id);
  if (!existing) return c.json({ error: "Account not found" }, 404);

  // Key-presence on the raw body (not the Zod-parsed result — Zod's
  // handling of an unset `.optional()` key vs. an explicit `null` isn't
  // something to build "was this field actually sent" logic on) decides
  // whether max_photos_override gets touched at all. Sending it as
  // explicit `null` clears a seller's override back to the global default;
  // omitting the key entirely leaves it untouched.
  const fields: Parameters<typeof updateAccountAdminFields>[2] = {
    verification_status: body.data.verification_status,
    can_self_list:
      body.data.can_self_list === undefined ? undefined : body.data.can_self_list ? 1 : 0,
    role: body.data.role,
  };
  if (typeof raw === "object" && raw !== null && "max_photos_override" in raw) {
    fields.max_photos_override = body.data.max_photos_override ?? null;
  }

  const updated = await updateAccountAdminFields(c.env, id, fields);
  return c.json(toPublicAccount(updated));
});

// Admin-triggered equivalent of the self-service "unregister" (see
// migrations/0006 / lib/db.ts's deactivateAccount) — mainly a testing
// utility: unlinks Telegram (freeing that phone/identity for a fresh
// signup) and deactivates the account, same as if the user had done it
// themselves from their own Settings page.
app.post("/accounts/:id/deactivate", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid account id" }, 400);

  const existing = await getAccount(c.env, id);
  if (!existing) return c.json({ error: "Account not found" }, 404);

  await deactivateAccount(c.env, id);
  const updated = await getAccount(c.env, id);
  return c.json(toPublicAccount(updated!));
});

// ---------------------------------------------------------------------
// Matches — the only place either queue is ever visible.
// ---------------------------------------------------------------------

app.get("/matches/pending", async (c) => {
  return c.json(await listPendingMatches(c.env));
});

app.get("/matches/approved", async (c) => {
  return c.json(await listApprovedMatches(c.env));
});

const approveMatchSchema = z.object({
  approval_status: z.enum(["buyer_only", "seller_only", "both"]),
});

app.post("/matches/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid match id" }, 400);

  const body = approveMatchSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }

  const admin = c.get("account");
  try {
    const match = await approveMatch(c.env, id, admin.id, body.data.approval_status);
    return c.json(match);
  } catch {
    return c.json({ error: "Match not found" }, 404);
  }
});

// ---------------------------------------------------------------------
// Listings — browse all, including needs_review drafts sellers can't see
// past themselves. Creation happens via POST /api/listings (see note above).
// ---------------------------------------------------------------------

app.get("/listings", async (c) => {
  return c.json(await listAllListings(c.env));
});

// ---------------------------------------------------------------------
// Settings — currently just the default photo cap; see accounts.max_photos_override
// for per-seller exceptions.
// ---------------------------------------------------------------------

app.get("/settings/default-max-photos", async (c) => {
  const value = await getSetting(c.env, "default_max_photos");
  return c.json({ default_max_photos: Number(value ?? 10) });
});

const settingsSchema = z.object({ default_max_photos: z.number().int().min(1) });

app.patch("/settings/default-max-photos", async (c) => {
  const body = settingsSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }
  await setSetting(c.env, "default_max_photos", String(body.data.default_max_photos));
  return c.json({ default_max_photos: body.data.default_max_photos });
});

app.get("/settings/open-mode", async (c) => {
  const value = await getSetting(c.env, "open_mode_enabled");
  return c.json({ open_mode_enabled: value === "1" });
});

const openModeSchema = z.object({ open_mode_enabled: z.boolean() });

app.patch("/settings/open-mode", async (c) => {
  const body = openModeSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid payload", details: body.error.issues }, 400);
  }
  await setSetting(c.env, "open_mode_enabled", body.data.open_mode_enabled ? "1" : "0");
  return c.json({ open_mode_enabled: body.data.open_mode_enabled });
});

// ---------------------------------------------------------------------
// Messages — admin oversight of every buyer<->seller conversation.
// Always available regardless of the open-mode toggle: admin's ability
// to review conversations isn't something the toggle should gate.
// ---------------------------------------------------------------------

app.get("/messages/conversations", async (c) => {
  const conversations = await listAllConversations(c.env);
  const enriched = await Promise.all(
    conversations.map(async (conv) => {
      const [listing, buyer, seller] = await Promise.all([
        getListing(c.env, conv.listing_id),
        getAccount(c.env, conv.buyer_account_id),
        getAccount(c.env, conv.seller_account_id),
      ]);
      return {
        ...conv,
        listing_category: listing?.category ?? null,
        listing_brand: listing?.brand ?? null,
        listing_model: listing?.model ?? null,
        buyer_company: buyer?.company_name ?? null,
        seller_company: seller?.company_name ?? null,
      };
    }),
  );
  return c.json(enriched);
});

app.get("/messages/:listingId/:buyerAccountId/:sellerAccountId", async (c) => {
  const listingId = Number(c.req.param("listingId"));
  const buyerAccountId = Number(c.req.param("buyerAccountId"));
  const sellerAccountId = Number(c.req.param("sellerAccountId"));
  if (![listingId, buyerAccountId, sellerAccountId].every(Number.isInteger)) {
    return c.json({ error: "Invalid id" }, 400);
  }
  const messages = await getThreadMessages(c.env, listingId, buyerAccountId, sellerAccountId);
  return c.json(messages);
});

export default app;
