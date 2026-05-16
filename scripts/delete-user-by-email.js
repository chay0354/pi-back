/**
 * Delete subscription user and related rows by email.
 * Usage: node scripts/delete-user-by-email.js <email>
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const email = (process.argv[2] || '').trim().toLowerCase();

if (!email) {
  console.error('Usage: node scripts/delete-user-by-email.js <email>');
  process.exit(1);
}

async function deleteWhere(table, applyFilter) {
  let q = supabase.from(table).delete();
  q = applyFilter(q);
  const { data, error } = await q.select('id');
  if (error) {
    if (/does not exist|42P01|schema cache/i.test(error.message)) {
      console.log(`[delete-user] skip ${table} (not found)`);
      return 0;
    }
    throw new Error(`${table}: ${error.message}`);
  }
  return data?.length ?? 0;
}

async function main() {
  console.log('[delete-user] email:', email);

  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('id, email, subscription_type, status')
    .ilike('email', email);

  if (subErr) throw subErr;
  if (!subs?.length) {
    console.log('[delete-user] no subscription found');
    return;
  }

  for (const sub of subs) {
    const subId = sub.id;
    console.log('[delete-user] subscription:', subId, sub.subscription_type, sub.status);

    const { data: ads } = await supabase
      .from('ads')
      .select('id')
      .eq('subscription_id', subId);
    const adIds = (ads || []).map(a => a.id);
    console.log('[delete-user] ads to remove:', adIds.length);

    if (adIds.length) {
      await deleteWhere('listing_boosts', q => q.in('ad_id', adIds));
      await deleteWhere('post_comment_reactions', q => q.in('ad_id', adIds));
      await deleteWhere('post_comments', q => q.in('ad_id', adIds));
      await deleteWhere('post_likes', q => q.in('ad_id', adIds));
      await deleteWhere('ad_likes', q => q.in('ad_id', adIds));
      const adsDel = await deleteWhere('ads', q => q.eq('subscription_id', subId));
      console.log('[delete-user] deleted ads:', adsDel);
    }

    await deleteWhere('listing_boosts', q => q.eq('subscription_id', subId));
    await deleteWhere('profile_reviews', q => q.eq('target_subscription_id', subId));
    await deleteWhere('profile_reviews', q => q.eq('reviewer_subscription_id', subId));
    await deleteWhere('user_search_history', q => q.eq('user_subscription_id', subId));
    await deleteWhere('user_search_history', q => q.eq('target_subscription_id', subId));
    await deleteWhere('company_reports', q => q.eq('reported_subscription_id', subId));
    await deleteWhere('company_reports', q =>
      q.eq('reporter_subscription_id', subId),
    );
    await deleteWhere('user_follows', q => q.eq('follower_subscription_id', subId));
    await deleteWhere('user_follows', q => q.eq('following_subscription_id', subId));
    await deleteWhere('user_follow_requests', q =>
      q.eq('requester_subscription_id', subId),
    );
    await deleteWhere('user_follow_requests', q =>
      q.eq('target_subscription_id', subId),
    );
    await deleteWhere('stories', q => q.eq('subscription_id', subId));

    const chatDel = await deleteWhere('chat_participants', q => q.eq('user_id', email));
    console.log('[delete-user] deleted chat_participants:', chatDel);

    await deleteWhere('ad_likes', q => q.eq('user_id', email));

    const { error: delSubErr } = await supabase
      .from('subscriptions')
      .delete()
      .eq('id', subId);
    if (delSubErr) throw delSubErr;
    console.log('[delete-user] deleted subscription:', subId);
  }

  const { data: remaining } = await supabase
    .from('subscriptions')
    .select('id')
    .ilike('email', email);
  console.log(
    '[delete-user] done. remaining subscriptions:',
    remaining?.length ?? 0,
  );
}

main().catch(err => {
  console.error('[delete-user] failed:', err.message || err);
  process.exit(1);
});
