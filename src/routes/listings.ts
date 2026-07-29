import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import {
  confirmListing,
  getAccount,
  getListing,
  insertDraftListing,
  isOpenModeEnabled,
  listAllListings,
  listBrowsableListings,
  listListingsBySeller,
  updateListingFromExtraction,
} from "../lib/db";
import { safeJson } from "../lib/http";
import { extractListingFields } from "../lib/openrouter";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

const draftSchema = z.object({
  // Only present (and only honoured) when an admin is listing on behalf of
  // a seller — a seller submitting their own listing never sends this;
  // the account is taken from their session instead.
  account_id: z.number().int().optional(),
  raw_description: z.string().min(10, "Description is too short to extract anything useful from"),
});

// Seller submits free text. We extract structured fields via OpenRouter and
// save them as a draft — NOT yet a live listing. The seller must confirm
// (POST /confirm) before it's eligible for matching. See spec §2.1.
//
// Two ways to reach this route:
//   - A seller with can_self_list=1, listing for themselves.
//   - An admin, listing on behalf of any seller (account_id in the body).
// This also satisfies the "admin can list for sellers" requirement from
// the plan — there's no separate /api/admin/listings POST; admin just
// calls this same route with an explicit account_id.
app.post("/", requireAuth, async (c) => {
  const actor = c.get("account");
  const body = draftSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid listing payload", details: body.error.issues }, 400);
  }

  let sellerAccountId: number;
  if (actor.role === "seller") {
    if (!actor.can_self_list) {
      return c.json(
        { error: "Self-listing isn't enabled for your account. Ask an admin to list this for you." },
        403,
      );
    }
    sellerAccountId = actor.id;
  } else if (actor.role === "admin") {
    if (!body.data.account_id) {
      return c.json({ error: "Admin requests must include account_id of the seller" }, 400);
    }
    const seller = await getAccount(c.env, body.data.account_id);
    if (!seller || seller.role !== "seller") {
      return c.json({ error: "account_id must belong to a seller account" }, 400);
    }
    sellerAccountId = seller.id;
  } else {
    return c.json({ error: "Only sellers and admins can create listings" }, 403);
  }

  const draft = await insertDraftListing(c.env, sellerAccountId, body.data.raw_description);

  let extraction;
  try {
    extraction = await extractListingFields(body.data.raw_description, c.env);
  } catch (err) {
    // Extraction failing shouldn't lose the seller's text — leave the draft
    // as 'pending' and let them fill fields in manually via /confirm.
    console.error("Extraction failed", err);
    return c.json({ listing: draft, extraction_error: "Extraction failed — fill in fields manually" }, 202);
  }

  const updated = await updateListingFromExtraction(
    c.env,
    draft.id,
    {
      category: extraction.fields.category,
      brand: extraction.fields.brand ?? undefined,
      model: extraction.fields.model ?? undefined,
      year: extraction.fields.year ?? undefined,
      hours_or_mileage: extraction.fields.hours_or_mileage ?? undefined,
      condition: extraction.fields.condition ?? undefined,
      price: extraction.fields.price ?? undefined,
      currency: extraction.fields.currency ?? undefined,
      city: extraction.fields.city ?? undefined,
      region: extraction.fields.region ?? undefined,
      features: JSON.stringify(extraction.fields.features),
    },
    extraction.needsReview ? "needs_review" : "ok",
  );

  return c.json({ listing: updated, needs_review: extraction.needsReview }, 201);
});

const confirmSchema = z.object({
  id: z.number().int(),
  category: z
    .enum(["excavator", "wheel_loader", "crane", "dozer", "compactor", "attachment", "other"])
    .optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  hours_or_mileage: z.number().nullable().optional(),
  condition: z.enum(["new", "used_good", "used_fair", "for_parts"]).nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});

// Seller reviews/edits the extracted draft and confirms it live. This is
// the human-in-the-loop step from spec §2.1 — bad extraction shouldn't
// silently become bad matching data.
app.post("/confirm", requireAuth, async (c) => {
  const body = confirmSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid confirm payload", details: body.error.issues }, 400);
  }

  const actor = c.get("account");
  const existing = await getListing(c.env, body.data.id);
  if (!existing) return c.json({ error: "Listing not found" }, 404);

  const isOwner = actor.role === "seller" && existing.account_id === actor.id;
  if (!isOwner && actor.role !== "admin") {
    return c.json({ error: "You don't have permission to confirm this listing" }, 403);
  }

  const { id, ...fields } = body.data;
  const listing = await confirmListing(c.env, id, fields);
  return c.json(listing);
});

// Backs the seller dashboard's "My Listings" table. A seller gets their own
// listings (including drafts still needing review); an admin gets every
// listing, or one seller's via ?account_id= for the same admin-on-behalf-of
// pattern used by POST /.
app.get("/", requireAuth, async (c) => {
  const actor = c.get("account");
  if (actor.role === "seller") {
    return c.json(await listListingsBySeller(c.env, actor.id));
  }
  if (actor.role === "admin") {
    const accountIdParam = c.req.query("account_id");
    if (accountIdParam) {
      const accountId = Number(accountIdParam);
      if (!Number.isInteger(accountId)) {
        return c.json({ error: "account_id must be an integer" }, 400);
      }
      return c.json(await listListingsBySeller(c.env, accountId));
    }
    return c.json(await listAllListings(c.env));
  }
  return c.json({ error: "Only sellers and admins can list listings" }, 403);
});

// Open-mode browse: the public live catalog (active + confirmed listings
// from every seller), available to buyers and sellers alike when the admin
// has open mode enabled. Kept separate from GET /: that route is "my
// mutable listings including drafts," this one is read-only and cross-seller.
app.get("/browse", requireAuth, async (c) => {
  const actor = c.get("account");
  if (actor.role !== "buyer" && actor.role !== "seller") {
    return c.json({ error: "Only buyers and sellers can browse the marketplace" }, 403);
  }
  if (!(await isOpenModeEnabled(c.env))) {
    return c.json({ error: "Marketplace browsing is currently disabled" }, 403);
  }
  return c.json(await listBrowsableListings(c.env));
});

// Normally buyers never see raw listing rows directly — they only ever see
// listing data through GET /api/matches/mine after an admin approves the
// match, scoped to the fields defined in getApprovedMatchesForBuyer.
// Sellers can see their own; admins can see any. When open mode is on,
// buyers and sellers can also view any live (active + confirmed) listing —
// contact still only ever happens through the message thread, never a
// plaintext email/phone the way approved matches expose it.
app.get("/:id", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid listing id" }, 400);

  const listing = await getListing(c.env, id);
  if (!listing) return c.json({ error: "Listing not found" }, 404);

  const actor = c.get("account");
  const isOwner = actor.role === "seller" && listing.account_id === actor.id;
  if (isOwner || actor.role === "admin") return c.json(listing);

  const isLive = listing.active === 1 && listing.extraction_status === "ok";
  if (
    isLive &&
    (actor.role === "buyer" || actor.role === "seller") &&
    (await isOpenModeEnabled(c.env))
  ) {
    return c.json(listing);
  }

  return c.json({ error: "You don't have permission to view this listing" }, 403);
});

export default app;
