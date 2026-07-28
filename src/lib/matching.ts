import type { Account, BuyerCriteria, Listing, MatchFeatures } from "./types";

// ---------------------------------------------------------------------
// Step 1 — hard filter (deterministic eligibility, spec §2.2 Step 1)
// ---------------------------------------------------------------------

/**
 * Category filtering happens in SQL (see db.ts listActiveListingsByCategory).
 * This covers what SQL can't cheaply express: budget/price overlap and,
 * when both sides have coordinates, a radius check. Falls back to a plain
 * region-string match when coordinates are missing on either side — see
 * the "honest simplification" note in the backend plan / migration file.
 */
export function hardFilter(
  listings: Listing[],
  criteria: BuyerCriteria,
  buyerAccount: Account,
): Listing[] {
  return listings.filter((listing) => {
    if (!priceWithinBudget(listing.price, criteria.budget_min, criteria.budget_max)) {
      return false;
    }
    if (!withinLocation(listing, criteria, buyerAccount)) {
      return false;
    }
    return true;
  });
}

function priceWithinBudget(
  price: number | null,
  budgetMin: number | null,
  budgetMax: number | null,
): boolean {
  if (price === null) return true; // unpriced listings aren't excluded, just scored lower (see computeFeatures)
  if (budgetMin !== null && price < budgetMin) return false;
  if (budgetMax !== null && price > budgetMax) return false;
  return true;
}

function withinLocation(
  listing: Listing,
  criteria: BuyerCriteria,
  buyerAccount: Account,
): boolean {
  const hasCoords =
    listing.lat !== null && listing.lng !== null && buyerAccount.lat !== null && buyerAccount.lng !== null;

  if (hasCoords && criteria.radius_km !== null) {
    const km = haversineKm(buyerAccount.lat as number, buyerAccount.lng as number, listing.lat as number, listing.lng as number);
    return km <= criteria.radius_km;
  }

  // Fallback: no coordinates on one or both sides — match on region string instead.
  if (criteria.region && listing.region) {
    return criteria.region.trim().toLowerCase() === listing.region.trim().toLowerCase();
  }

  // Neither radius nor region can be evaluated — don't exclude on location.
  return true;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius, km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// ---------------------------------------------------------------------
// Step 2 — feature scoring (spec §2.2 Step 2)
// ---------------------------------------------------------------------

export function computeFeatures(
  listing: Listing,
  criteria: BuyerCriteria,
  buyerAccount: Account,
  sellerAccount: Account,
): MatchFeatures {
  return {
    spec_fit: specFit(listing, criteria),
    price_fit: priceFit(listing.price, criteria.budget_min, criteria.budget_max),
    distance_km: distanceOrNull(listing, buyerAccount),
    seller_verified: sellerAccount.verification_status === "verified",
    listing_freshness_days: daysSince(listing.created_at),
  };
}

function specFit(listing: Listing, criteria: BuyerCriteria): number {
  const checks: Array<boolean | null> = [
    yearWithinRange(listing.year, criteria.min_year, criteria.max_year),
    hoursWithinMax(listing.hours_or_mileage, criteria.max_hours),
  ];
  const applicable = checks.filter((c): c is boolean => c !== null);
  if (applicable.length === 0) return 1; // nothing to compare against — don't penalize
  const passed = applicable.filter(Boolean).length;
  return passed / applicable.length;
}

function yearWithinRange(year: number | null, min: number | null, max: number | null): boolean | null {
  if (year === null || (min === null && max === null)) return null;
  if (min !== null && year < min) return false;
  if (max !== null && year > max) return false;
  return true;
}

function hoursWithinMax(hours: number | null, max: number | null): boolean | null {
  if (hours === null || max === null) return null;
  return hours <= max;
}

function priceFit(price: number | null, budgetMin: number | null, budgetMax: number | null): number {
  if (price === null || (budgetMin === null && budgetMax === null)) return 1;
  const mid = midpoint(budgetMin, budgetMax);
  if (mid === null) return 1;
  const span = (budgetMax ?? mid) - (budgetMin ?? mid) || mid * 0.2 || 1;
  const distance = Math.abs(price - mid);
  return Math.max(0, 1 - distance / span);
}

function midpoint(min: number | null, max: number | null): number | null {
  if (min !== null && max !== null) return (min + max) / 2;
  return min ?? max;
}

function distanceOrNull(listing: Listing, buyerAccount: Account): number | null {
  if (listing.lat === null || listing.lng === null || buyerAccount.lat === null || buyerAccount.lng === null) {
    return null;
  }
  return haversineKm(buyerAccount.lat, buyerAccount.lng, listing.lat, listing.lng);
}

function daysSince(isoDate: string): number {
  const then = new Date(isoDate.replace(" ", "T") + "Z").getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

// ---------------------------------------------------------------------
// Step 3 — Phase A confidence: transparent rule-based "criteria fit"
// score, NOT a learned/calibrated probability. Labeled accordingly in
// API responses — see docs/ai-matching-spec.md §5 honesty guardrails.
// There is no Phase B (trained model) yet; there's no outcome data to
// train on. Don't call this "AI confidence" anywhere in the codebase.
// ---------------------------------------------------------------------

const WEIGHTS = {
  spec_fit: 0.4,
  price_fit: 0.35,
  verified: 0.15,
  freshness: 0.1,
} as const;

export function criteriaFitScore(features: MatchFeatures): number {
  const freshnessScore = Math.max(0, 1 - features.listing_freshness_days / 90); // decays over ~3 months
  const verifiedScore = features.seller_verified ? 1 : 0.3; // unverified isn't excluded, just scored down

  const score =
    features.spec_fit * WEIGHTS.spec_fit +
    features.price_fit * WEIGHTS.price_fit +
    verifiedScore * WEIGHTS.verified +
    freshnessScore * WEIGHTS.freshness;

  return Math.round(score * 100);
}
