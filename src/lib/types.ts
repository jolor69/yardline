export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PHOTOS: R2Bucket;
  OPENROUTER_API_KEY: string;
  RESEND_API_KEY: string;
}

export type Role = "buyer" | "seller" | "admin";
export type VerificationStatus = "pending" | "verified";
export type Category =
  | "excavator"
  | "wheel_loader"
  | "crane"
  | "dozer"
  | "compactor"
  | "attachment"
  | "other";
export type Condition = "new" | "used_good" | "used_fair" | "for_parts";
export type ExtractionStatus = "pending" | "ok" | "needs_review";
export type MatchStatus = "shown" | "contacted" | "closed" | "declined";
export type Outcome = "contacted" | "closed_sale" | "closed_purchase" | "no_result";

export interface Account {
  id: number;
  role: Role;
  company_name: string;
  phone: string | null;
  email: string;
  password_hash: string;
  verification_status: VerificationStatus;
  can_self_list: number; // SQLite boolean (0/1), seller-only
  max_photos_override: number | null;
  city: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
}

export type PublicAccount = Omit<Account, "password_hash">;

export interface Session {
  id: string;
  account_id: number;
  expires_at: string;
  created_at: string;
}

export interface PasswordResetToken {
  id: string;
  account_id: number;
  expires_at: string;
  used: number;
  created_at: string;
}

export interface ListingPhoto {
  id: number;
  listing_id: number;
  r2_key: string;
  is_primary: number;
  uploaded_by: "seller" | "admin";
  created_at: string;
}

export interface Listing {
  id: number;
  account_id: number;
  category: Category;
  brand: string | null;
  model: string | null;
  year: number | null;
  hours_or_mileage: number | null;
  condition: Condition | null;
  price: number | null;
  currency: string;
  city: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  features: string; // JSON-encoded string[]
  raw_description: string;
  extraction_status: ExtractionStatus;
  active: number; // SQLite boolean (0/1)
  created_at: string;
  updated_at: string;
}

export interface BuyerCriteria {
  id: number;
  account_id: number;
  category: Category;
  min_year: number | null;
  max_year: number | null;
  max_hours: number | null;
  budget_min: number | null;
  budget_max: number | null;
  region: string | null;
  radius_km: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface MatchRow {
  id: number;
  listing_id: number;
  criteria_id: number;
  buyer_account_id: number;
  seller_account_id: number;
  criteria_fit_score: number;
  feature_snapshot: string; // JSON-encoded MatchFeatures
  status: MatchStatus;
  admin_approved_at: string | null; // null = not yet released to either party
  approved_by_admin_id: number | null;
  created_at: string;
}

export interface MatchFeatures {
  spec_fit: number; // 0-1
  price_fit: number; // 0-1
  distance_km: number | null;
  seller_verified: boolean;
  listing_freshness_days: number;
}

export interface MessageRow {
  id: number;
  listing_id: number;
  buyer_account_id: number;
  seller_account_id: number;
  sender_account_id: number;
  body: string;
  created_at: string;
}
