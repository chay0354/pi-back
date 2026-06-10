/**
 * Remove all company subscriptions except the seeded test company.
 *
 * Usage:
 *   node scripts/cleanup-company-users.js [keepSubscriptionIdOrEmail]
 *
 * Default keep: nadlan.company.1780412206833@test.com
 */
require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in pi-back/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_KEEP = 'nadlan.company.1780412206833@test.com';

async function resolveKeepId(keepArg) {
  const arg = (keepArg || DEFAULT_KEEP).trim();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
  const query = supabase
    .from('subscriptions')
    .select('id, email, business_name')
    .eq('subscription_type', 'company');
  const {data, error} = isUuid
    ? await query.eq('id', arg).maybeSingle()
    : await query.ilike('email', arg).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`Keep company not found: ${arg}`);
  return data;
}

async function deleteWhereIn(table, column, ids, selectColumns = 'id') {
  if (!ids.length) return 0;
  const {data, error} = await supabase
    .from(table)
    .delete()
    .in(column, ids)
    .select(selectColumns);
  if (error) throw new Error(`${table}.${column}: ${error.message}`);
  return data?.length ?? 0;
}

async function deleteWhereInEither(table, colA, colB, ids, selectColumns = 'id') {
  if (!ids.length) return 0;
  const nA = await deleteWhereIn(table, colA, ids, selectColumns);
  const nB = await deleteWhereIn(table, colB, ids, selectColumns);
  return nA + nB;
}

async function main() {
  const keep = await resolveKeepId(process.argv[2]);
  const {data: companies, error: listErr} = await supabase
    .from('subscriptions')
    .select('id, email, business_name')
    .eq('subscription_type', 'company')
    .order('created_at');
  if (listErr) throw new Error(listErr.message);

  const toDelete = (companies || []).filter(c => c.id !== keep.id);
  const delIds = toDelete.map(c => c.id);

  console.log('Keeping company:');
  console.log(`  ${keep.business_name || '(no name)'} — ${keep.email} — ${keep.id}`);
  console.log('');
  console.log(`Removing ${toDelete.length} other company account(s):`);
  toDelete.forEach(c =>
    console.log(`  - ${c.email || '(no email)'} | ${c.business_name || '(no name)'} | ${c.id}`),
  );

  if (!delIds.length) {
    console.log('\nNothing to delete.');
    return;
  }

  const delOwnerIds = delIds.map(String);
  const {data: adsBySub, error: adsSubErr} = await supabase
    .from('ads')
    .delete()
    .in('subscription_id', delIds)
    .select('id');
  if (adsSubErr) throw new Error(`ads.subscription_id: ${adsSubErr.message}`);

  const {data: adsByOwner, error: adsOwnerErr} = await supabase
    .from('ads')
    .delete()
    .in('owner_id', delOwnerIds)
    .select('id');
  if (adsOwnerErr) throw new Error(`ads.owner_id: ${adsOwnerErr.message}`);

  const related = [
    ['profile_reviews', 'target_subscription_id', delIds],
    ['profile_reviews', 'reviewer_subscription_id', delIds],
    ['company_reports', 'reported_subscription_id', delIds],
    ['company_reports', 'reporter_subscription_id', delIds],
    ['stories', 'subscription_id', delIds],
    ['listing_boosts', 'subscription_id', delIds],
    ['improvements_feedback', 'created_by_subscription_id', delIds],
    ['user_search_history', 'user_subscription_id', delIds],
    ['user_search_history', 'target_subscription_id', delIds],
  ];

  for (const [table, column, ids] of related) {
    const n = await deleteWhereIn(table, column, ids);
    if (n > 0) console.log(`  deleted ${n} from ${table}.${column}`);
  }

  const followDeleted = await deleteWhereInEither(
    'user_follows',
    'follower_subscription_id',
    'following_subscription_id',
    delIds,
    'follower_subscription_id',
  );
  if (followDeleted > 0) console.log(`  deleted ${followDeleted} from user_follows`);

  const reqDeleted = await deleteWhereInEither(
    'user_follow_requests',
    'requester_subscription_id',
    'target_subscription_id',
    delIds,
  );
  if (reqDeleted > 0) console.log(`  deleted ${reqDeleted} from user_follow_requests`);

  const adsDeleted = (adsBySub?.length ?? 0) + (adsByOwner?.length ?? 0);
  if (adsDeleted > 0) console.log(`  deleted ${adsDeleted} ads`);

  const {data: removed, error: delErr} = await supabase
    .from('subscriptions')
    .delete()
    .in('id', delIds)
    .select('id, email');
  if (delErr) throw new Error(`subscriptions: ${delErr.message}`);

  console.log(`\nDeleted ${removed?.length ?? 0} company subscription(s).`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
