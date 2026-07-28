import { Hono } from "hono";
import { requireAuth, requireRole } from "../lib/auth";
import {
  getApprovedMatchesForBuyer,
  getApprovedMatchesForSeller,
  getPrimaryPhoto,
} from "../lib/db";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

// Buyer/seller view of matches. Returns ONLY matches admin has approved —
// anything still pending review is simply absent, not flagged as
// "pending" — per the plan's decision that a match is only known to
// admin until released. Contact info and (for buyers) the single primary
// photo only ever appear here, never anywhere pre-approval.
app.get("/mine", requireAuth, requireRole("buyer", "seller"), async (c) => {
  const actor = c.get("account");

  if (actor.role === "buyer") {
    const matches = await getApprovedMatchesForBuyer(c.env, actor.id);
    const withPhotos = await Promise.all(
      matches.map(async (m) => {
        const photo = await getPrimaryPhoto(c.env, m.listing_id);
        return {
          match_id: m.match_id,
          criteria_fit_score: m.criteria_fit_score,
          approved_at: m.approved_at,
          listing: {
            category: m.listing_category,
            brand: m.listing_brand,
            model: m.listing_model,
            year: m.listing_year,
            hours_or_mileage: m.listing_hours_or_mileage,
            condition: m.listing_condition,
            price: m.listing_price,
            currency: m.listing_currency,
            region: m.listing_region,
          },
          seller_contact: {
            company_name: m.seller_company,
            phone: m.seller_phone,
            email: m.seller_email,
          },
          // Buyers only ever see ONE photo — the seller's designated
          // primary — never the full gallery. See src/routes/photos.ts.
          primary_photo_url: photo ? `/api/photos/${photo.id}` : null,
        };
      }),
    );
    return c.json(withPhotos);
  }

  // seller
  const matches = await getApprovedMatchesForSeller(c.env, actor.id);
  return c.json(
    matches.map((m) => ({
      match_id: m.match_id,
      criteria_fit_score: m.criteria_fit_score,
      approved_at: m.approved_at,
      criteria: {
        category: m.criteria_category,
        min_year: m.criteria_min_year,
        max_year: m.criteria_max_year,
        max_hours: m.criteria_max_hours,
        budget_min: m.criteria_budget_min,
        budget_max: m.criteria_budget_max,
        region: m.criteria_region,
      },
      buyer_contact: {
        company_name: m.buyer_company,
        phone: m.buyer_phone,
        email: m.buyer_email,
      },
    })),
  );
});

export default app;
