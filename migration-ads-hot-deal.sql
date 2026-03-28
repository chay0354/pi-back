-- BnB / לילה: "מחיר במבצע" (Hot deal) flag on the ad
ALTER TABLE ads ADD COLUMN IF NOT EXISTS hot_deal BOOLEAN DEFAULT false;

COMMENT ON COLUMN ads.hot_deal IS 'When true, the published price is highlighted as a promotional / hot-deal price (e.g. price per night).';
