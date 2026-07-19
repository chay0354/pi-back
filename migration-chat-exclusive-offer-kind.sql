-- Optional kind for broker exclusivity vs broker↔ offers.
-- exclusive = broker → regular user; collab = broker → broker (שת״פ).

ALTER TABLE chat_exclusive_offers
  ADD COLUMN IF NOT EXISTS offer_kind TEXT DEFAULT 'exclusive';

COMMENT ON COLUMN chat_exclusive_offers.offer_kind IS
  'exclusive (בלעדיות) or collab (שת״פ). Same accept/reject workflow.';
