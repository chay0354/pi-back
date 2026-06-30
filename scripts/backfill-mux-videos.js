/**
 * Send existing Supabase videos to Mux (ads, stories, profile intro).
 * Run from pi-back: node scripts/backfill-mux-videos.js
 * Options: --dry-run   only list rows, no Mux calls
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const muxVideo = require('../muxVideo');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in pi-back/.env');
  process.exit(1);
}

if (!muxVideo.isProcessingEnabled()) {
  console.error('Mux not configured. Set MUX_TOKEN_ID and MUX_TOKEN_SECRET in pi-back/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = Number(process.env.MUX_BACKFILL_DELAY_MS || 1200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPending(kind, table, urlField) {
  const { data, error } = await supabase
    .from(table)
    .select(`id, ${urlField}, mux_asset_id, video_status`)
    .not(urlField, 'is', null);

  if (error) throw new Error(`${table}: ${error.message}`);

  return (data || []).filter((row) => {
    const url = row[urlField] && String(row[urlField]).trim();
    if (!url || !muxVideo.isVideoUrl(url)) return false;
    const assetId = row.mux_asset_id && String(row.mux_asset_id).trim();
    return !assetId;
  }).map((row) => ({
    kind,
    id: row.id,
    url: String(row[urlField]).trim(),
  }));
}

async function main() {
  const jobs = [
    ...(await fetchPending('ad', 'ads', 'video_url')),
    ...(await fetchPending('story', 'stories', 'media_url')),
    ...(await fetchPending('subscription', 'subscriptions', 'video_url')),
  ];

  console.log(`Found ${jobs.length} video(s) without Mux asset.`);
  if (jobs.length === 0) return;

  for (const job of jobs) {
    console.log(`  [${job.kind}] ${job.id}`);
  }

  if (DRY_RUN) {
    console.log('Dry run — no Mux requests sent.');
    return;
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    process.stdout.write(`[${i + 1}/${jobs.length}] ${job.kind} ${job.id} … `);
    try {
      const result = await muxVideo.startProcessing(supabase, job.kind, job.id, job.url);
      console.log(result.status || result.skipped || 'ok');
      ok += 1;
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      fail += 1;
    }
    if (i < jobs.length - 1) await sleep(DELAY_MS);
  }

  console.log(`Done. success=${ok} failed=${fail}`);
  console.log('Mux webhooks will set video_hls_url when each asset is ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
