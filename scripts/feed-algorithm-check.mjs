/**
 * Integration checks for GET /api/listings feed ordering (TikTok / smart feed).
 *
 * The server applies `sortListingsByFeedAlgorithm` when:
 *   - `user_id` query param is present
 *   - NOT owner view (`subscription_id` omitted)
 *   - NOT `favorites_only=true`
 *   - There is at least one listing
 *
 * Cold users (no favorites / post likes, no passive “viral” thresholds) get
 * exposure-level ordering only. Anonymous requests skip the algorithm and keep
 * DB `created_at` order.
 *
 * Usage:
 *   node scripts/feed-algorithm-check.mjs
 *   FEED_CHECK_BASE_URL=http://127.0.0.1:3000 node scripts/feed-algorithm-check.mjs
 */

const BASE = process.env.FEED_CHECK_BASE_URL || 'http://127.0.0.1:3000';

const randUuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

async function fetchListings(searchParams) {
  const url = `${BASE}/api/listings?${searchParams.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${res.status}) ${url}: ${text.slice(0, 200)}`);
  }
  return { res, json, url };
}

function listingIds(body) {
  const list = body?.listings ?? body?.data ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((r) => r?.id).filter(Boolean);
}

function summarizeExposure(body) {
  const list = body?.listings ?? [];
  if (!Array.isArray(list) || list.length === 0) return { n: 0, levels: {} };
  const levels = {};
  for (const r of list) {
    const lv = (r.exposure_level || 'medium').toLowerCase();
    levels[lv] = (levels[lv] || 0) + 1;
  }
  return { n: list.length, levels };
}

function sequenceEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function scenario(name, fn) {
  process.stdout.write(`\n▸ ${name}\n`);
  try {
    await fn();
    process.stdout.write(`   ✓ ${name}\n`);
  } catch (e) {
    process.stdout.write(`   ✗ ${name}: ${e.message}\n`);
    throw e;
  }
}

async function main() {
  const failures = [];

  await scenario('Server reachable', async () => {
    const p = new URLSearchParams({ status: 'published' });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json.success !== true && json.listings == null) {
      throw new Error('Unexpected body (expected success + listings)');
    }
  }).catch((e) => failures.push(e.message));

  let anonIds = [];
  let coldUserIds = [];
  let coldUserBIds = [];
  let intentPropIds = [];
  let intentEntIds = [];

  await scenario('Anonymous feed returns listings (no user_id)', async () => {
    const p = new URLSearchParams({ status: 'published' });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    anonIds = listingIds(json);
    if (anonIds.length === 0) {
      throw new Error('No published listings — cannot compare ordering (seed DB or use staging)');
    }
  }).catch((e) => failures.push(e.message));

  await scenario('Logged-in-style feed (user_id, cold user)', async () => {
    const p = new URLSearchParams({ status: 'published', user_id: randUuid() });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    coldUserIds = listingIds(json);
    if (coldUserIds.length !== anonIds.length && anonIds.length > 0) {
      throw new Error(`Count mismatch anonymous (${anonIds.length}) vs user (${coldUserIds.length})`);
    }
  }).catch((e) => failures.push(e.message));

  await scenario('Second cold user: same candidate set size', async () => {
    const p = new URLSearchParams({ status: 'published', user_id: randUuid() });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    coldUserBIds = listingIds(json);
    if (coldUserBIds.length !== anonIds.length && anonIds.length > 0) {
      throw new Error('Cold user B count differs');
    }
  }).catch((e) => failures.push(e.message));

  await scenario('feed_intent=properties (cold user — may match baseline)', async () => {
    const p = new URLSearchParams({
      status: 'published',
      user_id: randUuid(),
      feed_intent: 'properties',
    });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    intentPropIds = listingIds(json);
  }).catch((e) => failures.push(e.message));

  await scenario('feed_intent=entertainment (cold user)', async () => {
    const p = new URLSearchParams({
      status: 'published',
      user_id: randUuid(),
      feed_intent: 'entertainment',
    });
    const { res, json } = await fetchListings(p);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    intentEntIds = listingIds(json);
  }).catch((e) => failures.push(e.message));

  await scenario('favorites_only without user_id returns 400', async () => {
    const p = new URLSearchParams({ status: 'published', favorites_only: 'true' });
    const { res } = await fetchListings(p);
    if (res.status !== 400) {
      throw new Error(`Expected HTTP 400, got ${res.status}`);
    }
  }).catch((e) => failures.push(e.message));

  // Informational block (not a hard failure)
  process.stdout.write('\n--- Ordering notes ---\n');
  const { res: anonRes, json: anonJson } = await fetchListings(
    new URLSearchParams({ status: 'published' }),
  );
  if (anonRes.ok) {
    const exp = summarizeExposure(anonJson);
    process.stdout.write(
      `Exposure mix (first page): n=${exp.n} levels=${JSON.stringify(exp.levels)}\n`,
    );
  }
  if (anonIds.length && coldUserIds.length) {
    const sameAsAnon = sequenceEqual(anonIds, coldUserIds);
    process.stdout.write(
      `Anonymous vs signed-in (new UUID) order identical: ${sameAsAnon} (often false: signed-in runs smart sort; passive view/share/like counts can build a profile and re-rank)\n`,
    );
  }
  if (coldUserIds.length && coldUserBIds.length) {
    const sameCold = sequenceEqual(coldUserIds, coldUserBIds);
    process.stdout.write(`Two random cold users same order: ${sameCold} (expected true)\n`);
  }
  if (intentPropIds.length && intentEntIds.length) {
    const intentDiff = !sequenceEqual(intentPropIds, intentEntIds);
    process.stdout.write(
      `properties vs entertainment order differs: ${intentDiff} (with no engagement, often false — personalization needs likes/favorites)\n`,
    );
  }
  process.stdout.write(
    '\nClient: TikTok passes user_id when currentUser.id is set (see getListings in TikTokFeedScreen).\n',
  );
  process.stdout.write(
    'Backend: sortListingsByFeedAlgorithm in server.js — uses ad_likes + post_likes + passive thresholds.\n',
  );

  if (failures.length) {
    process.stdout.write(`\nDone: ${failures.length} scenario(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write('\nDone: all scenarios passed.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
