-- Optional text-overlay metadata for story slides (esp. video sales images).
-- Photo stories usually bake text into media_url; video stories use this JSON.

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS general_details JSONB;

COMMENT ON COLUMN stories.general_details IS
  'Optional post_text_overlays payload for live text on story media (mainly video).';
