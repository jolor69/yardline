import { Hono } from "hono";
import { requireAuth } from "../lib/auth";
import {
  countPhotosForListing,
  deletePhotoRow,
  effectiveMaxPhotos,
  getAccount,
  getListing,
  getPhoto,
  hasApprovedMatchForBuyerAndListing,
  insertPhoto,
  isOpenModeEnabled,
  listPhotosForListing,
  setPrimaryPhoto,
} from "../lib/db";
import { safeJson } from "../lib/http";
import type { Env } from "../lib/types";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8MB — sane default, not specified by the product brief
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Mounted at /api/listings — nested under the listing it belongs to.
// Managing photos on an existing listing does NOT require can_self_list:
// that flag only gates *creating* new listings via the LLM-extraction
// flow (routes/listings.ts). A seller whose listings were all admin-
// created should still be able to manage that listing's photos.
export const listingPhotos = new Hono<{ Bindings: Env }>();

async function assertCanManage(c: { env: Env; get: (k: "account") => import("../lib/types").Account }, listingId: number) {
  const listing = await getListing(c.env, listingId);
  if (!listing) return { error: "Listing not found" as const, status: 404 as const };
  const actor = c.get("account");
  const isOwner = actor.role === "seller" && listing.account_id === actor.id;
  if (!isOwner && actor.role !== "admin") {
    return { error: "You don't have permission to manage this listing's photos" as const, status: 403 as const };
  }
  return { listing };
}

listingPhotos.post("/:id/photos", requireAuth, async (c) => {
  const listingId = Number(c.req.param("id"));
  if (!Number.isInteger(listingId)) return c.json({ error: "Invalid listing id" }, 400);

  const check = await assertCanManage(c, listingId);
  if ("error" in check) return c.json({ error: check.error }, check.status);
  const { listing } = check;

  const seller = await getAccount(c.env, listing.account_id);
  if (!seller) return c.json({ error: "Listing owner not found" }, 404);
  const maxPhotos = await effectiveMaxPhotos(c.env, seller);
  const currentCount = await countPhotosForListing(c.env, listingId);
  if (currentCount >= maxPhotos) {
    return c.json({ error: `This listing already has the maximum of ${maxPhotos} photos` }, 409);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "Expected multipart/form-data with a 'photo' field" }, 400);
  }
  const file = body["photo"];
  if (!(file instanceof File)) {
    return c.json({ error: "Missing 'photo' file field" }, 400);
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return c.json({ error: "Photo must be JPEG, PNG, or WebP" }, 415);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return c.json({ error: `Photo exceeds the ${MAX_PHOTO_BYTES / 1024 / 1024}MB limit` }, 413);
  }

  const r2Key = `listings/${listingId}/${crypto.randomUUID()}.${ext}`;
  await c.env.PHOTOS.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  // First photo on a listing becomes primary automatically — otherwise a
  // listing could sit with photos but no primary, and buyers see nothing.
  const isFirst = currentCount === 0;
  const photo = await insertPhoto(
    c.env,
    listingId,
    r2Key,
    isFirst,
    c.get("account").role === "admin" ? "admin" : "seller",
  );
  return c.json(photo, 201);
});

listingPhotos.get("/:id/photos", requireAuth, async (c) => {
  const listingId = Number(c.req.param("id"));
  if (!Number.isInteger(listingId)) return c.json({ error: "Invalid listing id" }, 400);
  const check = await assertCanManage(c, listingId);
  if ("error" in check) return c.json({ error: check.error }, check.status);
  return c.json(await listPhotosForListing(c.env, listingId));
});

listingPhotos.patch("/:id/photos/:photoId/primary", requireAuth, async (c) => {
  const listingId = Number(c.req.param("id"));
  const photoId = Number(c.req.param("photoId"));
  if (!Number.isInteger(listingId) || !Number.isInteger(photoId)) {
    return c.json({ error: "Invalid id" }, 400);
  }
  const check = await assertCanManage(c, listingId);
  if ("error" in check) return c.json({ error: check.error }, check.status);

  const photo = await getPhoto(c.env, photoId);
  if (!photo || photo.listing_id !== listingId) {
    return c.json({ error: "Photo not found on this listing" }, 404);
  }
  await setPrimaryPhoto(c.env, listingId, photoId);
  return c.json({ ok: true });
});

listingPhotos.delete("/:id/photos/:photoId", requireAuth, async (c) => {
  const listingId = Number(c.req.param("id"));
  const photoId = Number(c.req.param("photoId"));
  if (!Number.isInteger(listingId) || !Number.isInteger(photoId)) {
    return c.json({ error: "Invalid id" }, 400);
  }
  const check = await assertCanManage(c, listingId);
  if ("error" in check) return c.json({ error: check.error }, check.status);

  const photo = await getPhoto(c.env, photoId);
  if (!photo || photo.listing_id !== listingId) {
    return c.json({ error: "Photo not found on this listing" }, 404);
  }
  await c.env.PHOTOS.delete(photo.r2_key);
  await deletePhotoRow(c.env, photoId);
  // Deliberately no auto-reassignment of a new primary if the deleted one
  // was primary and others remain — owner/admin picks the next one
  // explicitly via the PATCH route above, rather than an implicit choice.
  return c.json({ ok: true });
});

// Mounted at /api/photos — serves the actual image bytes. Permission is
// checked per request, not per bucket: the bucket itself is never public.
//   - owner seller or admin: any photo on their own listing
//   - buyer: ONLY the primary photo, and ONLY if they have an admin-
//     approved match on that listing — not "any buyer, any primary photo
//     by guessing IDs." This is what "buyer can see only one photo" means
//     in practice, scoped to their own match.
export const photoServe = new Hono<{ Bindings: Env }>();

photoServe.get("/:id", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid photo id" }, 400);

  const photo = await getPhoto(c.env, id);
  if (!photo) return c.json({ error: "Photo not found" }, 404);
  const listing = await getListing(c.env, photo.listing_id);
  if (!listing) return c.json({ error: "Photo not found" }, 404);

  const actor = c.get("account");
  const isOwner = actor.role === "seller" && listing.account_id === actor.id;
  let allowed = isOwner || actor.role === "admin";
  if (!allowed && actor.role === "buyer" && photo.is_primary) {
    allowed = await hasApprovedMatchForBuyerAndListing(c.env, actor.id, listing.id);
  }
  const isLive = listing.active === 1 && listing.extraction_status === "ok";
  if (
    !allowed &&
    photo.is_primary &&
    isLive &&
    (actor.role === "buyer" || actor.role === "seller")
  ) {
    allowed = await isOpenModeEnabled(c.env);
  }
  if (!allowed) return c.json({ error: "Photo not found" }, 404); // don't reveal existence

  const object = await c.env.PHOTOS.get(photo.r2_key);
  if (!object) return c.json({ error: "Photo not found" }, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});
