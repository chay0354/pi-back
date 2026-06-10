/**
 * Delete a user and all related data by email (subscriptions + chat + ads + auth).
 * Usage: node scripts/delete-user-by-email.js <email>
 */
require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');

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
  const {data, error} = await q.select('id');
  if (error) {
    if (/does not exist|42P01|schema cache/i.test(error.message)) {
      console.log(`[delete-user] skip ${table} (not found)`);
      return 0;
    }
    throw new Error(`${table}: ${error.message}`);
  }
  return data?.length ?? 0;
}

async function deleteWhereEither(table, colA, colB, value) {
  const nA = await deleteWhere(table, q => q.eq(colA, value));
  const nB = await deleteWhere(table, q => q.eq(colB, value));
  return nA + nB;
}

async function deleteAuthUserByEmail(targetEmail) {
  try {
    let page = 1;
    let found = null;
    while (page <= 20 && !found) {
      const {data, error} = await supabase.auth.admin.listUsers({
        page,
        perPage: 200,
      });
      if (error) {
        console.log('[delete-user] auth list skip:', error.message);
        return;
      }
      const users = data?.users || [];
      found = users.find(
        u => (u.email || '').trim().toLowerCase() === targetEmail,
      );
      if (users.length < 200) break;
      page += 1;
    }
    if (!found) {
      console.log('[delete-user] no Supabase Auth user for this email');
      return;
    }
    const {error: delErr} = await supabase.auth.admin.deleteUser(found.id);
    if (delErr) throw delErr;
    console.log('[delete-user] deleted Supabase Auth user:', found.id);
  } catch (e) {
    console.log('[delete-user] auth delete skip:', e.message || e);
  }
}

async function cleanupChatForEmail(targetEmail) {
  const {data: parts, error: partsErr} = await supabase
    .from('chat_participants')
    .select('conversation_id')
    .eq('user_id', targetEmail);
  if (partsErr && !/does not exist|42P01/i.test(partsErr.message)) {
    throw partsErr;
  }
  const convIds = [
    ...new Set((parts || []).map(p => p.conversation_id).filter(Boolean)),
  ];

  const msgBySender = await deleteWhere('chat_messages', q =>
    q.eq('sender_id', targetEmail),
  );
  const msgByReceiver = await deleteWhere('chat_messages', q =>
    q.eq('receiver_id', targetEmail),
  );
  if (msgBySender + msgByReceiver > 0) {
    console.log(
      `[delete-user] deleted ${msgBySender + msgByReceiver} chat_messages (sender/receiver)`,
    );
  }

  if (convIds.length) {
    const msgInConv = await deleteWhere('chat_messages', q =>
      q.in('conversation_id', convIds),
    );
    if (msgInConv > 0) {
      console.log(`[delete-user] deleted ${msgInConv} chat_messages in user convs`);
    }
  }

  const partDel = await deleteWhere('chat_participants', q =>
    q.eq('user_id', targetEmail),
  );
  console.log('[delete-user] deleted chat_participants:', partDel);

  for (const convId of convIds) {
    const {data: remaining, error: remErr} = await supabase
      .from('chat_participants')
      .select('user_id')
      .eq('conversation_id', convId)
      .limit(1);
    if (remErr) continue;
    if (!remaining?.length) {
      await deleteWhere('chat_messages', q => q.eq('conversation_id', convId));
      const {error: convDelErr} = await supabase
        .from('chat_conversations')
        .delete()
        .eq('id', convId);
      if (!convDelErr) {
        console.log('[delete-user] removed empty conversation:', convId);
      }
    }
  }
}

async function main() {
  console.log('[delete-user] email:', email);

  const {data: subs, error: subErr} = await supabase
    .from('subscriptions')
    .select('id, email, subscription_type, status')
    .ilike('email', email);

  if (subErr) throw subErr;

  if (!subs?.length) {
    console.log('[delete-user] no subscription row — cleaning chat/auth by email only');
    await cleanupChatForEmail(email);
    await deleteAuthUserByEmail(email);
    console.log('[delete-user] done (no subscription was found)');
    return;
  }

  for (const sub of subs) {
    const subId = sub.id;
    const subIdStr = String(subId);
    console.log('[delete-user] subscription:', subId, sub.subscription_type, sub.status);

    const {data: ads} = await supabase
      .from('ads')
      .select('id')
      .or(`subscription_id.eq.${subId},owner_id.eq.${subIdStr}`);
    const adIds = [...new Set((ads || []).map(a => a.id))];
    console.log('[delete-user] ads to remove:', adIds.length);

    if (adIds.length) {
      await deleteWhere('listing_boosts', q => q.in('ad_id', adIds));
      await deleteWhere('post_comment_reactions', q => q.in('ad_id', adIds));
      await deleteWhere('post_comments', q => q.in('ad_id', adIds));
      await deleteWhere('post_likes', q => q.in('ad_id', adIds));
      await deleteWhere('ad_likes', q => q.in('ad_id', adIds));
    }

    const adsDelSub = await deleteWhere('ads', q => q.eq('subscription_id', subId));
    const adsDelOwner = await deleteWhere('ads', q => q.eq('owner_id', subIdStr));
    console.log('[delete-user] deleted ads:', adsDelSub + adsDelOwner);

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
    await deleteWhere('improvements_feedback', q =>
      q.eq('created_by_subscription_id', subId),
    );

    await deleteWhere('ad_likes', q => q.eq('user_id', email));
    await deleteWhere('post_likes', q => q.eq('user_id', email));

    const {error: delSubErr} = await supabase
      .from('subscriptions')
      .delete()
      .eq('id', subId);
    if (delSubErr) throw delSubErr;
    console.log('[delete-user] deleted subscription:', subId);
  }

  await cleanupChatForEmail(email);
  await deleteAuthUserByEmail(email);

  const {data: remaining} = await supabase
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
