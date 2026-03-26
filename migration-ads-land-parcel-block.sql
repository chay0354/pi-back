-- OPTIONAL: Land listings — dedicated חלקה / גוש columns.
-- The API merges חלקה and גוש into land_address (TEXT) if these columns are absent,
-- so the app works without this migration. Run only if you want separate columns for reporting/UI.

ALTER TABLE ads ADD COLUMN IF NOT EXISTS land_parcel TEXT NULL;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS land_block TEXT NULL;

COMMENT ON COLUMN ads.land_parcel IS 'Israel land registry: חלקה';
COMMENT ON COLUMN ads.land_block IS 'Israel land registry: גוש';
