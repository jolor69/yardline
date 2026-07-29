import type {
  Account,
  BuyerCriteria,
  Env,
  Listing,
  ListingPhoto,
  MatchRow,
  MessageRow,
  PasswordResetToken,
  PublicAccount,
  Session,
} from "./types";

// Every query here uses .bind() parameterization — never string-interpolate
// user input into SQL text.

export function toPublicAccount(account: Account): PublicAccount {
  const { password_hash, ...rest } = account;
  return rest;
}

export async function insertAccount(
  env: Env,
  input: Pick<Account, "role" | "company_name" | "email" | "password_hash"> &
    Partial<Pick<Account, "phone" | "city" | "region" | "lat" | "lng">>,
): Promise<Account> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (role, company_name, email, password_hash, phone, city, region, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      input.role,
      input.company_name,
      input.email,
      input.password_hash,
      input.phone ?? null,
      input.city ?? null,
      input.region ?? null,
      input.lat ?? null,
      input.lng ?? null,
    )
    .first<Account>();
  if (!row) throw new Error("Failed to insert account");
  return row;
}

export async function getAccount(env: Env, id: number): Promise<Account | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

export async function getAccountByEmail(env: Env, email: string): Promise<Account | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<Account>();
}

export async function listAccounts(env: Env, role?: string): Promise<Account[]> {
  if (role) {
    const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE role = ? ORDER BY id")
      .bind(role)
      .all<Account>();
    return results;
  }
  const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id").all<Account>();
  return results;
}

export async function updateAccountAdminFields(
  env: Env,
  id: number,
  fields: Partial<
    Pick<Account, "verification_status" | "can_self_list" | "max_photos_override" | "role">
  >,
): Promise<Account> {
  // max_photos_override is nullable on the column itself (null = "use the
  // global default"), so COALESCE(?, col) can't tell "not sent, leave
  // unchanged" apart from "sent as null, clear the override." A separate
  // "was this key present in the request at all" flag disambiguates it.
  // Every `?` below is a plain sequential positional param, in bind() order
  // — no numbered ?1/?2 params, which is what caused the previous bug
  // (mixing sequential and numbered placeholders in one query).
  const touchesPhotoOverride = "max_photos_override" in fields;
  const row = await env.DB.prepare(
    `UPDATE accounts SET
       verification_status = COALESCE(?, verification_status),
       can_self_list = COALESCE(?, can_self_list),
       max_photos_override = CASE WHEN ? = 1 THEN ? ELSE max_photos_override END,
       role = COALESCE(?, role)
     WHERE id = ?
     RETURNING *`,
  )
    .bind(
      fields.verification_status ?? null,
      fields.can_self_list ?? null,
      touchesPhotoOverride ? 1 : 0,
      touchesPhotoOverride ? (fields.max_photos_override ?? null) : null,
      fields.role ?? null,
      id,
    )
    .first<Account>();
  if (!row) throw new Error(`Account ${id} not found`);
  return row;
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

export async function insertSession(
  env: Env,
  token: string,
  accountId: number,
  expiresAt: string,
): Promise<void> {
  await env.DB.prepare(`INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, accountId, expiresAt)
    .run();
}

export async function getSessionAccount(env: Env, token: string): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT accounts.* FROM sessions
     JOIN accounts ON accounts.id = sessions.account_id
     WHERE sessions.id = ? AND sessions.expires_at > datetime('now')`,
  )
    .bind(token)
    .first<Account>();
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(token).run();
}

export async function deleteSessionsForAccount(env: Env, accountId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(accountId).run();
}

// ---------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------

export async function insertResetToken(
  env: Env,
  token: string,
  accountId: number,
  expiresAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO password_reset_tokens (id, account_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, accountId, expiresAt)
    .run();
}

export async function getValidResetToken(
  env: Env,
  token: string,
): Promise<PasswordResetToken | null> {
  return env.DB.prepare(
    `SELECT * FROM password_reset_tokens WHERE id = ? AND used = 0 AND expires_at > datetime('now')`,
  )
    .bind(token)
    .first<PasswordResetToken>();
}

export async function markResetTokenUsed(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE id = ?`)
    .bind(token)
    .run();
}

export async function updateAccountPassword(
  env: Env,
  accountId: number,
  passwordHash: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE accounts SET password_hash = ? WHERE id = ?`)
    .bind(passwordHash, accountId)
    .run();
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

export async function insertDraftListing(
  env: Env,
  accountId: number,
  rawDescription: string,
): Promise<Listing> {
  const row = await env.DB.prepare(
    `INSERT INTO listings (account_id, category, raw_description, extraction_status)
     VALUES (?, 'other', ?, 'pending')
     RETURNING *`,
  )
    .bind(accountId, rawDescription)
    .first<Listing>();
  if (!row) throw new Error("Failed to insert draft listing");
  return row;
}

export async function updateListingFromExtraction(
  env: Env,
  id: number,
  fields: Partial<
    Pick<
      Listing,
      | "category"
      | "brand"
      | "model"
      | "year"
      | "hours_or_mileage"
      | "condition"
      | "price"
      | "currency"
      | "city"
      | "region"
      | "features"
    >
  >,
  extractionStatus: Listing["extraction_status"],
): Promise<Listing> {
  const row = await env.DB.prepare(
    `UPDATE listings SET
       category = COALESCE(?, category),
       brand = COALESCE(?, brand),
       model = COALESCE(?, model),
       year = COALESCE(?, year),
       hours_or_mileage = COALESCE(?, hours_or_mileage),
       condition = COALESCE(?, condition),
       price = COALESCE(?, price),
       currency = COALESCE(?, currency),
       city = COALESCE(?, city),
       region = COALESCE(?, region),
       features = COALESCE(?, features),
       extraction_status = ?,
       updated_at = datetime('now')
     WHERE id = ?
     RETURNING *`,
  )
    .bind(
      fields.category ?? null,
      fields.brand ?? null,
      fields.model ?? null,
      fields.year ?? null,
      fields.hours_or_mileage ?? null,
      fields.condition ?? null,
      fields.price ?? null,
      fields.currency ?? null,
      fields.city ?? null,
      fields.region ?? null,
      fields.features ?? null,
      extractionStatus,
      id,
    )
    .first<Listing>();
  if (!row) throw new Error(`Listing ${id} not found`);
  return row;
}

export async function confirmListing(
  env: Env,
  id: number,
  fields: Partial<
    Pick<
      Listing,
      | "category"
      | "brand"
      | "model"
      | "year"
      | "hours_or_mileage"
      | "condition"
      | "price"
      | "currency"
      | "city"
      | "region"
      | "features"
    >
  >,
): Promise<Listing> {
  return updateListingFromExtraction(env, id, fields, "ok");
}

export async function getListing(env: Env, id: number): Promise<Listing | null> {
  return env.DB.prepare("SELECT * FROM listings WHERE id = ?").bind(id).first<Listing>();
}

export async function listActiveListingsByCategory(
  env: Env,
  category: string,
): Promise<Listing[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM listings WHERE category = ? AND active = 1 AND extraction_status != 'needs_review'`,
  )
    .bind(category)
    .all<Listing>();
  return results;
}

export async function insertCriteria(
  env: Env,
  input: Omit<BuyerCriteria, "id" | "created_at" | "updated_at" | "active">,
): Promise<BuyerCriteria> {
  const row = await env.DB.prepare(
    `INSERT INTO buyer_criteria
       (account_id, category, min_year, max_year, max_hours, budget_min, budget_max, region, radius_km)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      input.account_id,
      input.category,
      input.min_year,
      input.max_year,
      input.max_hours,
      input.budget_min,
      input.budget_max,
      input.region,
      input.radius_km,
    )
    .first<BuyerCriteria>();
  if (!row) throw new Error("Failed to insert criteria");
  return row;
}

export async function getCriteria(env: Env, id: number): Promise<BuyerCriteria | null> {
  return env.DB.prepare("SELECT * FROM buyer_criteria WHERE id = ?")
    .bind(id)
    .first<BuyerCriteria>();
}

export async function listActiveCriteria(env: Env): Promise<BuyerCriteria[]> {
  const { results } = await env.DB.prepare("SELECT * FROM buyer_criteria WHERE active = 1")
    .all<BuyerCriteria>();
  return results;
}

export async function insertMatch(
  env: Env,
  input: Omit<
    MatchRow,
    "id" | "created_at" | "status" | "admin_approved_at" | "approved_by_admin_id"
  >,
): Promise<MatchRow> {
  const row = await env.DB.prepare(
    `INSERT INTO matches
       (listing_id, criteria_id, buyer_account_id, seller_account_id, criteria_fit_score, feature_snapshot)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      input.listing_id,
      input.criteria_id,
      input.buyer_account_id,
      input.seller_account_id,
      input.criteria_fit_score,
      input.feature_snapshot,
    )
    .first<MatchRow>();
  if (!row) throw new Error("Failed to insert match");
  return row;
}

export async function getMatch(env: Env, id: number): Promise<MatchRow | null> {
  return env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first<MatchRow>();
}

export async function insertOutcome(
  env: Env,
  matchId: number,
  outcome: string,
  reportedBy: "buyer" | "seller",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO match_outcomes (match_id, outcome, reported_by) VALUES (?, ?, ?)`,
  )
    .bind(matchId, outcome, reportedBy)
    .run();
}

// ---------------------------------------------------------------------
// Admin-mediated matching — a match is invisible to buyer/seller until
// admin_approved_at is set. See the plan: "a match is only known to admin."
// ---------------------------------------------------------------------

export interface PendingMatchAdminView {
  match_id: number;
  criteria_fit_score: number;
  created_at: string;
  buyer_company: string;
  seller_company: string;
  listing_category: string;
  listing_brand: string | null;
  listing_model: string | null;
}

export async function listPendingMatches(env: Env): Promise<PendingMatchAdminView[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       matches.id AS match_id,
       matches.criteria_fit_score,
       matches.created_at,
       buyer.company_name AS buyer_company,
       seller.company_name AS seller_company,
       listings.category AS listing_category,
       listings.brand AS listing_brand,
       listings.model AS listing_model
     FROM matches
     JOIN accounts buyer ON buyer.id = matches.buyer_account_id
     JOIN accounts seller ON seller.id = matches.seller_account_id
     JOIN listings ON listings.id = matches.listing_id
     WHERE matches.approval_status = 'pending'
     ORDER BY matches.created_at DESC`,
  ).all<PendingMatchAdminView>();
  return results;
}

export interface ApprovedMatchAdminView extends PendingMatchAdminView {
  approved_at: string;
}

export async function listApprovedMatches(env: Env): Promise<(ApprovedMatchAdminView & { approval_status: string })[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       matches.id AS match_id,
       matches.criteria_fit_score,
       matches.created_at,
       matches.admin_approved_at AS approved_at,
       matches.approval_status,
       buyer.company_name AS buyer_company,
       seller.company_name AS seller_company,
       listings.category AS listing_category,
       listings.brand AS listing_brand,
       listings.model AS listing_model
     FROM matches
     JOIN accounts buyer ON buyer.id = matches.buyer_account_id
     JOIN accounts seller ON seller.id = matches.seller_account_id
     JOIN listings ON listings.id = matches.listing_id
     WHERE matches.approval_status IN ('buyer_only', 'seller_only', 'both')
     ORDER BY matches.admin_approved_at DESC`,
  ).all<ApprovedMatchAdminView & { approval_status: string }>();
  return results;
}

export async function approveMatch(
  env: Env,
  matchId: number,
  adminId: number,
  approvalStatus: "buyer_only" | "seller_only" | "both",
): Promise<MatchRow> {
  const row = await env.DB.prepare(
    `UPDATE matches SET admin_approved_at = datetime('now'), approved_by_admin_id = ?, approval_status = ?
     WHERE id = ? RETURNING *`,
  )
    .bind(adminId, approvalStatus, matchId)
    .first<MatchRow>();
  if (!row) throw new Error(`Match ${matchId} not found`);
  return row;
}

export interface ApprovedMatchForBuyer {
  match_id: number;
  criteria_fit_score: number;
  approved_at: string;
  listing_category: string;
  listing_brand: string | null;
  listing_model: string | null;
  listing_year: number | null;
  listing_hours_or_mileage: number | null;
  listing_condition: string | null;
  listing_price: number | null;
  listing_currency: string;
  listing_region: string | null;
  listing_id: number;
  seller_company: string;
  seller_phone: string | null;
  seller_email: string;
}

export async function getApprovedMatchesForBuyer(
  env: Env,
  buyerAccountId: number,
): Promise<ApprovedMatchForBuyer[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       matches.id AS match_id,
       matches.criteria_fit_score,
       matches.admin_approved_at AS approved_at,
       listings.id AS listing_id,
       listings.category AS listing_category,
       listings.brand AS listing_brand,
       listings.model AS listing_model,
       listings.year AS listing_year,
       listings.hours_or_mileage AS listing_hours_or_mileage,
       listings.condition AS listing_condition,
       listings.price AS listing_price,
       listings.currency AS listing_currency,
       listings.region AS listing_region,
       seller.company_name AS seller_company,
       seller.phone AS seller_phone,
       seller.email AS seller_email
     FROM matches
     JOIN listings ON listings.id = matches.listing_id
     JOIN accounts seller ON seller.id = matches.seller_account_id
     WHERE matches.buyer_account_id = ? AND matches.approval_status IN ('buyer_only', 'both')
     ORDER BY matches.admin_approved_at DESC`,
  )
    .bind(buyerAccountId)
    .all<ApprovedMatchForBuyer>();
  return results;
}

export interface ApprovedMatchForSeller {
  match_id: number;
  criteria_fit_score: number;
  approved_at: string;
  criteria_category: string;
  criteria_min_year: number | null;
  criteria_max_year: number | null;
  criteria_max_hours: number | null;
  criteria_budget_min: number | null;
  criteria_budget_max: number | null;
  criteria_region: string | null;
  buyer_company: string;
  buyer_phone: string | null;
  buyer_email: string;
}

export async function getApprovedMatchesForSeller(
  env: Env,
  sellerAccountId: number,
): Promise<ApprovedMatchForSeller[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       matches.id AS match_id,
       matches.criteria_fit_score,
       matches.admin_approved_at AS approved_at,
       buyer_criteria.category AS criteria_category,
       buyer_criteria.min_year AS criteria_min_year,
       buyer_criteria.max_year AS criteria_max_year,
       buyer_criteria.max_hours AS criteria_max_hours,
       buyer_criteria.budget_min AS criteria_budget_min,
       buyer_criteria.budget_max AS criteria_budget_max,
       buyer_criteria.region AS criteria_region,
       buyer.company_name AS buyer_company,
       buyer.phone AS buyer_phone,
       buyer.email AS buyer_email
     FROM matches
     JOIN buyer_criteria ON buyer_criteria.id = matches.criteria_id
     JOIN accounts buyer ON buyer.id = matches.buyer_account_id
     WHERE matches.seller_account_id = ? AND matches.approval_status IN ('seller_only', 'both')
     ORDER BY matches.admin_approved_at DESC`,
  )
    .bind(sellerAccountId)
    .all<ApprovedMatchForSeller>();
  return results;
}

// ---------------------------------------------------------------------
// Admin listing/account browsing
// ---------------------------------------------------------------------

export async function listAllListings(env: Env): Promise<Listing[]> {
  const { results } = await env.DB.prepare("SELECT * FROM listings ORDER BY id DESC").all<Listing>();
  return results;
}

export async function listListingsBySeller(env: Env, accountId: number): Promise<Listing[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM listings WHERE account_id = ? ORDER BY id DESC",
  )
    .bind(accountId)
    .all<Listing>();
  return results;
}

// ---------------------------------------------------------------------
// Photos — see src/routes/photos.ts for the upload/serve logic. This is
// just the primary-photo lookup that matches-mine.ts needs to attach a
// single visible photo to an approved match's listing.
// ---------------------------------------------------------------------

export async function getPrimaryPhoto(env: Env, listingId: number): Promise<ListingPhoto | null> {
  return env.DB.prepare(
    "SELECT * FROM listing_photos WHERE listing_id = ? AND is_primary = 1 LIMIT 1",
  )
    .bind(listingId)
    .first<ListingPhoto>();
}

export async function countPhotosForListing(env: Env, listingId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_photos WHERE listing_id = ?")
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listPhotosForListing(env: Env, listingId: number): Promise<ListingPhoto[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM listing_photos WHERE listing_id = ? ORDER BY id",
  )
    .bind(listingId)
    .all<ListingPhoto>();
  return results;
}

export async function getPhoto(env: Env, id: number): Promise<ListingPhoto | null> {
  return env.DB.prepare("SELECT * FROM listing_photos WHERE id = ?").bind(id).first<ListingPhoto>();
}

export async function insertPhoto(
  env: Env,
  listingId: number,
  r2Key: string,
  isPrimary: boolean,
  uploadedBy: "seller" | "admin",
): Promise<ListingPhoto> {
  const row = await env.DB.prepare(
    `INSERT INTO listing_photos (listing_id, r2_key, is_primary, uploaded_by)
     VALUES (?, ?, ?, ?) RETURNING *`,
  )
    .bind(listingId, r2Key, isPrimary ? 1 : 0, uploadedBy)
    .first<ListingPhoto>();
  if (!row) throw new Error("Failed to insert photo");
  return row;
}

// Atomic via batch(): clears any existing primary for the listing, then
// sets the requested one — never a window where a listing has zero or
// two primaries visible to a concurrent reader.
export async function setPrimaryPhoto(env: Env, listingId: number, photoId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE listing_photos SET is_primary = 0 WHERE listing_id = ?").bind(listingId),
    env.DB.prepare("UPDATE listing_photos SET is_primary = 1 WHERE id = ? AND listing_id = ?").bind(
      photoId,
      listingId,
    ),
  ]);
}

export async function deletePhotoRow(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM listing_photos WHERE id = ?").bind(id).run();
}

export async function hasApprovedMatchForBuyerAndListing(
  env: Env,
  buyerAccountId: number,
  listingId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM matches
     WHERE buyer_account_id = ? AND listing_id = ? AND admin_approved_at IS NOT NULL
     LIMIT 1`,
  )
    .bind(buyerAccountId, listingId)
    .first();
  return row !== null;
}

export async function effectiveMaxPhotos(env: Env, seller: Account): Promise<number> {
  if (seller.max_photos_override !== null) return seller.max_photos_override;
  const value = await getSetting(env, "default_max_photos");
  return Number(value ?? 10);
}

// ---------------------------------------------------------------------
// Open mode — admin toggle that lets buyers/sellers browse all live
// listings directly and message each other, bypassing the admin-mediated
// matches/approval flow. See migrations/0004_open_mode_and_messages.sql.
// ---------------------------------------------------------------------

export async function isOpenModeEnabled(env: Env): Promise<boolean> {
  return (await getSetting(env, "open_mode_enabled")) === "1";
}

export async function listBrowsableListings(env: Env): Promise<Listing[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM listings WHERE active = 1 AND extraction_status = 'ok' ORDER BY id DESC`,
  ).all<Listing>();
  return results;
}

// ---------------------------------------------------------------------
// Messages — direct buyer<->seller conversations scoped to a listing.
// No separate conversations table: (listing_id, buyer_account_id,
// seller_account_id) is a stable natural key for a thread.
// ---------------------------------------------------------------------

export async function insertMessage(
  env: Env,
  input: Pick<
    MessageRow,
    "listing_id" | "buyer_account_id" | "seller_account_id" | "sender_account_id" | "body"
  >,
): Promise<MessageRow> {
  const row = await env.DB.prepare(
    `INSERT INTO messages (listing_id, buyer_account_id, seller_account_id, sender_account_id, body)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      input.listing_id,
      input.buyer_account_id,
      input.seller_account_id,
      input.sender_account_id,
      input.body,
    )
    .first<MessageRow>();
  if (!row) throw new Error("Failed to insert message");
  return row;
}

export async function getThreadMessages(
  env: Env,
  listingId: number,
  buyerAccountId: number,
  sellerAccountId: number,
): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE listing_id = ? AND buyer_account_id = ? AND seller_account_id = ?
     ORDER BY id`,
  )
    .bind(listingId, buyerAccountId, sellerAccountId)
    .all<MessageRow>();
  return results;
}

export async function threadExists(
  env: Env,
  listingId: number,
  buyerAccountId: number,
  sellerAccountId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM messages
     WHERE listing_id = ? AND buyer_account_id = ? AND seller_account_id = ?
     LIMIT 1`,
  )
    .bind(listingId, buyerAccountId, sellerAccountId)
    .first();
  return row !== null;
}

export interface ConversationKey {
  listing_id: number;
  buyer_account_id: number;
  seller_account_id: number;
  last_message_at: string;
}

export async function listConversationsForAccount(
  env: Env,
  accountId: number,
): Promise<ConversationKey[]> {
  const { results } = await env.DB.prepare(
    `SELECT listing_id, buyer_account_id, seller_account_id, MAX(created_at) AS last_message_at
     FROM messages
     WHERE buyer_account_id = ? OR seller_account_id = ?
     GROUP BY listing_id, buyer_account_id, seller_account_id
     ORDER BY last_message_at DESC`,
  )
    .bind(accountId, accountId)
    .all<ConversationKey>();
  return results;
}

export async function listAllConversations(env: Env): Promise<ConversationKey[]> {
  const { results } = await env.DB.prepare(
    `SELECT listing_id, buyer_account_id, seller_account_id, MAX(created_at) AS last_message_at
     FROM messages
     GROUP BY listing_id, buyer_account_id, seller_account_id
     ORDER BY last_message_at DESC`,
  ).all<ConversationKey>();
  return results;
}
