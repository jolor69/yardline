-- Auth, role separation (buyer/seller/admin), admin-mediated matching,
-- and photo storage. See docs/ai-matching-spec.md and the backend plan
-- for why matches are invisible to both sides until an admin approves.
--
-- Wipes existing data on purpose: `accounts` needs a CHECK-constraint
-- change (SQLite requires recreating the table for that), and the prior
-- dummy dataset had no passwords anyway — already flagged as disposable
-- test data in the last report.

DELETE FROM match_outcomes;
DELETE FROM matches;
DELETE FROM listings;
DELETE FROM buyer_criteria;
DROP TABLE accounts;

CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  role                   TEXT NOT NULL,          -- 'buyer' | 'seller' | 'admin' — validated in app code (Zod), not CHECK; see plan for why
  company_name           TEXT NOT NULL,
  phone                  TEXT,
  email                  TEXT NOT NULL UNIQUE,   -- one email = one account = one role; this is what enforces "never both buyer and seller"
  password_hash          TEXT NOT NULL,          -- PBKDF2-SHA256, "saltB64:hashB64" — see src/lib/auth.ts
  verification_status    TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified')),
  can_self_list          INTEGER NOT NULL DEFAULT 0,   -- seller-only; must be granted by admin, default off
  max_photos_override    INTEGER,                 -- null = use settings.default_max_photos
  city                   TEXT,
  region                 TEXT,
  lat                    REAL,
  lng                    REAL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_accounts_role ON accounts(role);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,   -- random token; also the cookie value
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_account ON sessions(account_id);

CREATE TABLE password_reset_tokens (
  id           TEXT PRIMARY KEY,   -- random token
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reset_tokens_account ON password_reset_tokens(account_id);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('default_max_photos', '10');

CREATE TABLE listing_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id    INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0,   -- the one photo buyers are ever allowed to see
  uploaded_by   TEXT NOT NULL CHECK (uploaded_by IN ('seller', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photos_listing ON listing_photos(listing_id);

ALTER TABLE matches ADD COLUMN admin_approved_at TEXT;         -- null = not yet released to either party
ALTER TABLE matches ADD COLUMN approved_by_admin_id INTEGER;
