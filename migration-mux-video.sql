-- Mux HLS fields for ad videos (ads) and story videos (stories + profile intro on subscriptions).
-- Run in Supabase SQL Editor after enabling Mux credentials on pi-back.

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS video_hls_url TEXT,
  ADD COLUMN IF NOT EXISTS mux_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS mux_playback_id TEXT,
  ADD COLUMN IF NOT EXISTS video_status TEXT DEFAULT 'ready';

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS media_hls_url TEXT,
  ADD COLUMN IF NOT EXISTS mux_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS mux_playback_id TEXT,
  ADD COLUMN IF NOT EXISTS video_status TEXT DEFAULT 'ready';

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS video_hls_url TEXT,
  ADD COLUMN IF NOT EXISTS mux_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS mux_playback_id TEXT,
  ADD COLUMN IF NOT EXISTS video_status TEXT;

COMMENT ON COLUMN ads.video_hls_url IS 'Mux HLS (.m3u8) playback URL for listing/ad feed videos';
COMMENT ON COLUMN stories.media_hls_url IS 'Mux HLS playback URL for ephemeral story slide videos';
COMMENT ON COLUMN subscriptions.video_hls_url IS 'Mux HLS playback URL for profile intro story video';
