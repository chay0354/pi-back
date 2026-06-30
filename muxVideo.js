'use strict';

const crypto = require('crypto');

const MUX_API = 'https://api.mux.com/video/v1';

function muxAuthHeader() {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) return null;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

function isConfigured() {
  return Boolean(muxAuthHeader());
}

/** Set MUX_VIDEO_ENABLED=0 to skip Mux and keep legacy Supabase MP4-only flow. */
function isProcessingEnabled() {
  const flag = String(process.env.MUX_VIDEO_ENABLED || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') {
    return false;
  }
  return isConfigured();
}

function isVideoUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return false;
  if (/\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(s)) return true;
  if (/\/videos?\//i.test(s)) return true;
  if (s.includes('video')) return true;
  return false;
}

function hlsFromPlaybackId(playbackId) {
  const id = String(playbackId || '').trim();
  if (!id) return null;
  return `https://stream.mux.com/${id}.m3u8`;
}

async function muxFetch(path, options = {}) {
  const auth = muxAuthHeader();
  if (!auth) {
    const err = new Error('Mux is not configured (MUX_TOKEN_ID / MUX_TOKEN_SECRET missing)');
    err.statusCode = 503;
    throw err;
  }
  const res = await fetch(`${MUX_API}${path}`, {
    ...options,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data && data.error && data.error.messages && data.error.messages.join('; ')) ||
      (data && data.error && data.error.type) ||
      res.statusText ||
      'Mux API error';
    const err = new Error(msg);
    err.statusCode = res.status;
    err.muxResponse = data;
    throw err;
  }
  return data;
}

function buildPassthrough(kind, id) {
  return JSON.stringify({ kind, id: String(id) });
}

function parsePassthrough(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !parsed.kind || !parsed.id) return null;
    return { kind: String(parsed.kind), id: String(parsed.id) };
  } catch (_) {
    return null;
  }
}

const TABLE_BY_KIND = {
  ad: 'ads',
  story: 'stories',
  subscription: 'subscriptions',
};

const URL_FIELD_BY_KIND = {
  ad: 'video_url',
  story: 'media_url',
  subscription: 'video_url',
};

const HLS_FIELD_BY_KIND = {
  ad: 'video_hls_url',
  story: 'media_hls_url',
  subscription: 'video_hls_url',
};

async function createAssetFromUrl(sourceUrl, passthrough) {
  const body = {
    input: [{ url: String(sourceUrl).trim() }],
    playback_policy: ['public'],
    passthrough,
  };
  const result = await muxFetch('/assets', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result && result.data ? result.data : null;
}

async function markProcessing(supabase, kind, rowId) {
  const table = TABLE_BY_KIND[kind];
  if (!table) return;
  try {
    await supabase
      .from(table)
      .update({ video_status: 'processing' })
      .eq('id', rowId);
  } catch (_) {
    /* video_status column may be missing on older DBs */
  }
}

async function restoreLegacyReady(supabase, kind, rowId) {
  const table = TABLE_BY_KIND[kind];
  if (!table) return;
  try {
    await supabase
      .from(table)
      .update({ video_status: 'ready' })
      .eq('id', rowId);
  } catch (_) {
    /* ignore */
  }
}

async function startProcessing(supabase, kind, rowId, sourceUrl) {
  if (!isProcessingEnabled()) {
    return { skipped: true, reason: 'not_enabled' };
  }
  const url = String(sourceUrl || '').trim();
  if (!url || !isVideoUrl(url)) {
    return { skipped: true, reason: 'not_video' };
  }
  const table = TABLE_BY_KIND[kind];
  if (!table) {
    return { skipped: true, reason: 'invalid_kind' };
  }

  await markProcessing(supabase, kind, rowId);

  try {
    const passthrough = buildPassthrough(kind, rowId);
    const asset = await createAssetFromUrl(url, passthrough);
    if (!asset || !asset.id) {
      await restoreLegacyReady(supabase, kind, rowId);
      throw new Error('Mux asset creation returned no id');
    }

    const playbackId =
      asset.playback_ids && asset.playback_ids[0] && asset.playback_ids[0].id
        ? asset.playback_ids[0].id
        : null;
    const updates = {
      mux_asset_id: asset.id,
      video_status: asset.status === 'ready' ? 'ready' : 'processing',
    };
    if (playbackId) {
      updates.mux_playback_id = playbackId;
      updates[HLS_FIELD_BY_KIND[kind]] = hlsFromPlaybackId(playbackId);
    }

    await supabase.from(table).update(updates).eq('id', rowId);

    return { assetId: asset.id, playbackId, status: updates.video_status };
  } catch (err) {
    await restoreLegacyReady(supabase, kind, rowId);
    throw err;
  }
}

function scheduleProcessing(supabase, kind, rowId, sourceUrl) {
  if (!isProcessingEnabled()) return;
  setImmediate(() => {
    startProcessing(supabase, kind, rowId, sourceUrl).catch((err) => {
      console.error(`[mux] ${kind} ${rowId}:`, err.message);
    });
  });
}

async function applyWebhookAssetEvent(supabase, asset) {
  if (!asset || !asset.id) return { handled: false };
  const meta = parsePassthrough(asset.passthrough);
  if (!meta) {
    console.warn('[mux webhook] missing passthrough for asset', asset.id);
    return { handled: false };
  }

  const table = TABLE_BY_KIND[meta.kind];
  const hlsField = HLS_FIELD_BY_KIND[meta.kind];
  if (!table || !hlsField) return { handled: false };

  const playbackId =
    asset.playback_ids && asset.playback_ids[0] && asset.playback_ids[0].id
      ? asset.playback_ids[0].id
      : null;

  if (asset.status === 'errored') {
    await supabase
      .from(table)
      .update({
        video_status: 'ready',
        mux_asset_id: asset.id,
      })
      .eq('id', meta.id);
    return { handled: true, kind: meta.kind, id: meta.id, status: 'ready' };
  }

  if (asset.status === 'ready' && playbackId) {
    await supabase
      .from(table)
      .update({
        mux_asset_id: asset.id,
        mux_playback_id: playbackId,
        [hlsField]: hlsFromPlaybackId(playbackId),
        video_status: 'ready',
      })
      .eq('id', meta.id);
    return { handled: true, kind: meta.kind, id: meta.id, status: 'ready' };
  }

  await supabase
    .from(table)
    .update({
      mux_asset_id: asset.id,
      mux_playback_id: playbackId || null,
      video_status: asset.status || 'processing',
    })
    .eq('id', meta.id);

  return { handled: true, kind: meta.kind, id: meta.id, status: asset.status };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.MUX_WEBHOOK_SIGNING_SECRET;
  if (!secret) return true;
  if (!signatureHeader) return false;

  const parts = String(signatureHeader).split(',');
  const sigPart = parts.find((p) => p.trim().startsWith('v1='));
  if (!sigPart) return false;
  const theirSig = sigPart.trim().slice(3);
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody || '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(theirSig, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch (_) {
    return false;
  }
}

function resolveAdPlaybackUrl(row) {
  if (!row) return null;
  const hls = row.video_hls_url && String(row.video_hls_url).trim();
  if (hls && row.video_status !== 'failed') return hls;
  const mp4 = row.video_url && String(row.video_url).trim();
  return mp4 || null;
}

/** Original Supabase/direct URL — never rewritten to HLS. */
function resolveAdSourceUrl(row) {
  if (!row) return null;
  const mp4 = row.video_url && String(row.video_url).trim();
  return mp4 || null;
}

function resolveStoryPlaybackUrl(row) {
  if (!row) return null;
  const hls = row.media_hls_url && String(row.media_hls_url).trim();
  if (hls && row.video_status !== 'failed') return hls;
  const src = row.media_url && String(row.media_url).trim();
  return src || null;
}

function resolveStorySourceUrl(row) {
  if (!row) return null;
  const src = row.media_url && String(row.media_url).trim();
  return src || null;
}

function resolveSubscriptionPlaybackUrl(row) {
  if (!row) return null;
  const hls = row.video_hls_url && String(row.video_hls_url).trim();
  if (hls && row.video_status !== 'failed') return hls;
  const mp4 = row.video_url && String(row.video_url).trim();
  return mp4 || null;
}

function resolveSubscriptionSourceUrl(row) {
  if (!row) return null;
  const mp4 = row.video_url && String(row.video_url).trim();
  return mp4 || null;
}

module.exports = {
  isConfigured,
  isProcessingEnabled,
  isVideoUrl,
  hlsFromPlaybackId,
  startProcessing,
  scheduleProcessing,
  applyWebhookAssetEvent,
  verifyWebhookSignature,
  parsePassthrough,
  resolveAdPlaybackUrl,
  resolveAdSourceUrl,
  resolveStoryPlaybackUrl,
  resolveStorySourceUrl,
  resolveSubscriptionPlaybackUrl,
  resolveSubscriptionSourceUrl,
  TABLE_BY_KIND,
  URL_FIELD_BY_KIND,
};
