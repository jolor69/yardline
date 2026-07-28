-- Selective match approval: allow admin to approve for buyer only, seller only, or both.
-- Replaces the binary admin_approved_at boolean with an approval_status field that
-- tracks visibility for each party independently.

ALTER TABLE matches ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'buyer_only', 'seller_only', 'both'));

-- Create index for faster filtering by approval status
CREATE INDEX idx_matches_approval_status ON matches(approval_status);
