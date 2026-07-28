import { Hono } from "hono";
import { requireAuth, requireRole } from "../lib/auth";
import { getAccount, getCriteria, insertMatch, listActiveListingsByCategory } from "../lib/db";
import { computeFeatures, criteriaFitScore, hardFilter } from "../lib/matching";
import type { Account, BuyerCriteria, Env, Listing } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

// Admin-only. Buyers and sellers never call this directly or see its raw
// output — a match is only known to admin until GET /api/admin/matches
// -> POST /api/admin/matches/:id/approve releases it, at which point it
// shows up (role-appropriately) via GET /api/matches/mine.
//
// Runs the full pipeline from spec §2.2: hard filter -> feature scoring ->
// Phase A criteria-fit score. Logs a `matches` row per candidate returned
// so outcome data (spec §3) can start accumulating from day one, even
// though nothing trains on it yet.
app.get("/", requireAuth, requireRole("admin"), async (c) => {
  const criteriaId = Number(c.req.query("criteria_id"));
  if (!Number.isInteger(criteriaId)) {
    return c.json({ error: "criteria_id query param is required" }, 400);
  }

  const criteria = await getCriteria(c.env, criteriaId);
  if (!criteria) return c.json({ error: "Criteria not found" }, 404);

  const buyerAccount = await getAccount(c.env, criteria.account_id);
  if (!buyerAccount) return c.json({ error: "Buyer account not found" }, 404);

  const candidateListings = await listActiveListingsByCategory(c.env, criteria.category);
  const eligible = hardFilter(candidateListings, criteria, buyerAccount);

  const scored = await scoreAndLog(c.env, eligible, criteria, buyerAccount);
  scored.sort((a, b) => b.criteria_fit_score - a.criteria_fit_score);

  return c.json({
    criteria_id: criteria.id,
    // Explicitly NOT "confidence" — this is a transparent rule-based score,
    // not a calibrated probability. See docs/ai-matching-spec.md §5.
    label: "criteria_fit_score",
    results: scored,
  });
});

interface ScoredResult {
  match_id: number;
  listing_id: number;
  criteria_fit_score: number;
}

async function scoreAndLog(
  env: Env,
  listings: Listing[],
  criteria: BuyerCriteria,
  buyerAccount: Account,
): Promise<ScoredResult[]> {
  const out: ScoredResult[] = [];
  for (const listing of listings) {
    const sellerAccount = await getAccount(env, listing.account_id);
    if (!sellerAccount) continue;

    const features = computeFeatures(listing, criteria, buyerAccount, sellerAccount);
    const score = criteriaFitScore(features);

    const match = await insertMatch(env, {
      listing_id: listing.id,
      criteria_id: criteria.id,
      buyer_account_id: buyerAccount.id,
      seller_account_id: sellerAccount.id,
      criteria_fit_score: score,
      feature_snapshot: JSON.stringify(features),
    });

    out.push({ match_id: match.id, listing_id: listing.id, criteria_fit_score: score });
  }
  return out;
}

export default app;
