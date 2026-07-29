import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import {
  getAccount,
  getListing,
  getThreadMessages,
  insertMessage,
  isOpenModeEnabled,
  listConversationsForAccount,
  threadExists,
} from "../lib/db";
import { safeJson } from "../lib/http";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

// Direct buyer<->seller messaging, scoped to a listing. Only available when
// the admin's open-mode toggle is on — see migrations/0004_open_mode_and_messages.sql
// and the comment on isOpenModeEnabled in lib/db.ts.

const sendSchema = z.object({
  listing_id: z.number().int(),
  // Only used (and required) when the sender is a seller replying to a
  // buyer — buyers never send this, the buyer side of the thread is always
  // their own account.
  counterpart_account_id: z.number().int().optional(),
  body: z.string().min(1).max(4000),
});

app.post("/", requireAuth, requireRole("buyer", "seller"), async (c) => {
  const body = sendSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid message payload", details: body.error.issues }, 400);
  }

  if (!(await isOpenModeEnabled(c.env))) {
    return c.json({ error: "Messaging is currently disabled" }, 403);
  }

  const listing = await getListing(c.env, body.data.listing_id);
  if (!listing || listing.active !== 1) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const actor = c.get("account");
  let buyerAccountId: number;
  let sellerAccountId: number;

  if (actor.role === "buyer") {
    buyerAccountId = actor.id;
    sellerAccountId = listing.account_id;
  } else {
    // Seller — must own the listing, and can only reply to a buyer who has
    // already started a conversation. Sellers never cold-message a buyer.
    if (listing.account_id !== actor.id) {
      return c.json({ error: "You don't have permission to message about this listing" }, 403);
    }
    if (!body.data.counterpart_account_id) {
      return c.json({ error: "counterpart_account_id is required when replying as a seller" }, 400);
    }
    sellerAccountId = actor.id;
    buyerAccountId = body.data.counterpart_account_id;
    if (!(await threadExists(c.env, listing.id, buyerAccountId, sellerAccountId))) {
      return c.json({ error: "No conversation with this buyer yet" }, 400);
    }
  }

  const message = await insertMessage(c.env, {
    listing_id: listing.id,
    buyer_account_id: buyerAccountId,
    seller_account_id: sellerAccountId,
    sender_account_id: actor.id,
    body: body.data.body,
  });
  return c.json(message, 201);
});

// Not gated by open mode — an in-progress conversation shouldn't vanish or
// 403 out from under two parties mid-deal just because the toggle flipped.
// Only new sends and new browsing are gated.
app.get("/conversations", requireAuth, requireRole("buyer", "seller"), async (c) => {
  const actor = c.get("account");
  const conversations = await listConversationsForAccount(c.env, actor.id);
  const enriched = await Promise.all(
    conversations.map(async (conv) => {
      const otherAccountId =
        actor.role === "buyer" ? conv.seller_account_id : conv.buyer_account_id;
      const [listing, counterpart] = await Promise.all([
        getListing(c.env, conv.listing_id),
        getAccount(c.env, otherAccountId),
      ]);
      return {
        ...conv,
        counterpart_account_id: otherAccountId,
        counterpart_company: counterpart?.company_name ?? null,
        listing_category: listing?.category ?? null,
        listing_brand: listing?.brand ?? null,
        listing_model: listing?.model ?? null,
      };
    }),
  );
  return c.json(enriched);
});

app.get("/:listingId/:otherAccountId", requireAuth, requireRole("buyer", "seller"), async (c) => {
  const listingId = Number(c.req.param("listingId"));
  const otherAccountId = Number(c.req.param("otherAccountId"));
  if (!Number.isInteger(listingId) || !Number.isInteger(otherAccountId)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const actor = c.get("account");
  // One side of the lookup is always the authenticated actor's own id —
  // never taken from the URL — so a buyer/seller can only ever land on
  // their own thread, regardless of what otherAccountId they pass.
  const buyerAccountId = actor.role === "buyer" ? actor.id : otherAccountId;
  const sellerAccountId = actor.role === "seller" ? actor.id : otherAccountId;

  const messages = await getThreadMessages(c.env, listingId, buyerAccountId, sellerAccountId);
  return c.json(messages);
});

export default app;
