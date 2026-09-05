-- Allow listing comments without a star rating (BnB private ads).
-- Star reviews stay 1–5; comment-only rows store rating NULL.

ALTER TABLE profile_reviews
  ALTER COLUMN rating DROP NOT NULL;

ALTER TABLE profile_reviews
  DROP CONSTRAINT IF EXISTS profile_reviews_rating_check;

ALTER TABLE profile_reviews
  ADD CONSTRAINT profile_reviews_rating_check
  CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));

COMMENT ON COLUMN profile_reviews.rating IS
  '1–5 stars for business/profile reviews; NULL for comment-only (e.g. BnB private).';
