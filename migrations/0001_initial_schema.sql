-- Yardline matching engine — initial schema.
-- No auth/session tables here on purpose: routes take account_id directly
-- for this pass (see docs/ai-matching-spec.md and the backend plan for why).

CREATE TABLE IF NOT EXISTS accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  role                 TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
  company_name         TEXT NOT NULL,
  phone                TEXT,
  email                TEXT NOT NULL UNIQUE,
  verification_status  TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified')),
  city                 TEXT,
  region               TEXT,
  lat                  REAL,
  lng                  REAL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_role ON accounts(role);

CREATE TABLE IF NOT EXISTS listings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category             TEXT NOT NULL CHECK (category IN ('excavator', 'wheel_loader', 'crane', 'dozer', 'compactor', 'attachment', 'other')),
  brand                TEXT,
  model                TEXT,
  year                 INTEGER,
  hours_or_mileage     INTEGER,
  condition            TEXT CHECK (condition IN ('new', 'used_good', 'used_fair', 'for_parts')),
  price                REAL,
  currency             TEXT NOT NULL DEFAULT 'USD',
  city                 TEXT,
  region               TEXT,
  lat                  REAL,
  lng                  REAL,
  features             TEXT NOT NULL DEFAULT '[]',   -- JSON array, stored as text (D1/SQLite has no native JSON type)
  raw_description      TEXT NOT NULL,
  extraction_status    TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'ok', 'needs_review')),
  active                INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_category_region ON listings(category, region);
CREATE INDEX IF NOT EXISTS idx_listings_account ON listings(account_id);

CREATE TABLE IF NOT EXISTS buyer_criteria (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category      TEXT NOT NULL CHECK (category IN ('excavator', 'wheel_loader', 'crane', 'dozer', 'compactor', 'attachment', 'other')),
  min_year      INTEGER,
  max_year      INTEGER,
  max_hours     INTEGER,
  budget_min    REAL,
  budget_max    REAL,
  region        TEXT,
  radius_km     REAL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_criteria_account_active ON buyer_criteria(account_id, active);
CREATE INDEX IF NOT EXISTS idx_criteria_category ON buyer_criteria(category);

CREATE TABLE IF NOT EXISTS matches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id           INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  criteria_id          INTEGER NOT NULL REFERENCES buyer_criteria(id) ON DELETE CASCADE,
  buyer_account_id     INTEGER NOT NULL REFERENCES accounts(id),
  seller_account_id    INTEGER NOT NULL REFERENCES accounts(id),
  criteria_fit_score   REAL NOT NULL,          -- 0-100, Phase A rule-based score (see lib/matching.ts)
  feature_snapshot     TEXT NOT NULL,          -- JSON text: the computed features behind the score
  status               TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'contacted', 'closed', 'declined')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_matches_criteria ON matches(criteria_id);
CREATE INDEX IF NOT EXISTS idx_matches_listing ON matches(listing_id);

CREATE TABLE IF NOT EXISTS match_outcomes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL CHECK (outcome IN ('contacted', 'closed_sale', 'closed_purchase', 'no_result')),
  reported_by   TEXT NOT NULL CHECK (reported_by IN ('buyer', 'seller')),
  reported_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_match ON match_outcomes(match_id);
