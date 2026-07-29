-- Admin-controlled "open mode": when enabled, buyers and sellers can browse
-- the full live listings catalog directly and message each other about a
-- specific listing, bypassing the admin-mediated matches/approval flow.
-- Additive — the existing matches pipeline is untouched.

INSERT INTO settings (key, value) VALUES ('open_mode_enabled', '0');

-- No separate conversations table: (listing_id, buyer_account_id,
-- seller_account_id) is a stable natural composite key for a thread, and
-- "my conversations" / "does a thread exist" can be derived from messages
-- directly with GROUP BY.
CREATE TABLE messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id           INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seller_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sender_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body                 TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (sender_account_id = buyer_account_id OR sender_account_id = seller_account_id),
  CHECK (buyer_account_id != seller_account_id)
);

-- Fetching one thread, in order.
CREATE INDEX idx_messages_thread ON messages(listing_id, buyer_account_id, seller_account_id, created_at);
-- "My conversations" for a buyer / a seller.
CREATE INDEX idx_messages_buyer  ON messages(buyer_account_id, created_at);
CREATE INDEX idx_messages_seller ON messages(seller_account_id, created_at);
