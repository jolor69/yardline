-- Self-service "unregister" (soft-delete). See src/lib/db.ts's
-- deactivateAccount() and src/routes/auth.ts's POST /deactivate.
--
-- Additive only. NULL = active (every existing row today); a timestamp
-- means deactivated. Deliberately a separate column from
-- verification_status, which is a distinct concept (admin-verified
-- business), not account lifecycle.

ALTER TABLE accounts ADD COLUMN deactivated_at TEXT;
