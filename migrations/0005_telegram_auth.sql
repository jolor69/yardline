-- Telegram-based signup/login alongside existing email/password.
-- See src/routes/telegram.ts and src/lib/telegram.ts.
--
-- Additive only — no accounts table rebuild. password_hash stays NOT NULL;
-- Telegram-only accounts get a sentinel value (see src/lib/auth.ts
-- NO_PASSWORD_SENTINEL) instead of NULL. The sentinel is deliberately
-- colon-free: verifyPassword() does stored.split(":"), and a colon-free
-- string makes hashB64 undefined, so it returns false safely with zero
-- changes needed to verifyPassword() itself.

ALTER TABLE accounts ADD COLUMN telegram_id INTEGER;
ALTER TABLE accounts ADD COLUMN telegram_username TEXT;

-- SQLite UNIQUE indexes treat every NULL as distinct, so this is safe for
-- all existing/future email-only accounts (telegram_id = NULL).
CREATE UNIQUE INDEX idx_accounts_telegram_id ON accounts(telegram_id);

CREATE TABLE telegram_pending_signups (
  token               TEXT PRIMARY KEY,
  intent              TEXT NOT NULL CHECK (intent IN ('signup', 'login')),
  role                TEXT CHECK (role IN ('buyer', 'seller') OR role IS NULL),
  company_name        TEXT,
  email               TEXT,
  city                TEXT,
  region              TEXT,
  lat                 REAL,
  lng                 REAL,
  chat_id             INTEGER,
  telegram_user_id    INTEGER,
  telegram_username   TEXT,
  status              TEXT NOT NULL DEFAULT 'awaiting_start'
                         CHECK (status IN (
                           'awaiting_start', 'awaiting_contact', 'completed',
                           'consumed', 'expired', 'error'
                         )),
  account_id          INTEGER REFERENCES accounts(id),
  detail              TEXT,
  requester_ip        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at          TEXT NOT NULL
);

CREATE INDEX idx_telegram_pending_status    ON telegram_pending_signups(status);
CREATE INDEX idx_telegram_pending_chat      ON telegram_pending_signups(chat_id, status);
CREATE INDEX idx_telegram_pending_ip_recent ON telegram_pending_signups(requester_ip, created_at);
