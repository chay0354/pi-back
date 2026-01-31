-- Fix NULL categories in existing listings
-- Set NULL categories to 1 (default category)
UPDATE listings
SET category = 1
WHERE category IS NULL;

-- Verify the update
SELECT 
  id, 
  category, 
  status,
  created_at
FROM listings
WHERE status = 'published'
ORDER BY created_at DESC;
