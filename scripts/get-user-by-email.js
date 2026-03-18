/**
 * Get all data for the user with the given email.
 * Run from pi-back: node scripts/get-user-by-email.js
 * Usage: node scripts/get-user-by-email.js [email]
 * Default email: chay.moalem@gmail.com
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const email = (process.argv[2] || 'chay.moalem@gmail.com').trim().toLowerCase();

async function main() {
  console.log('=== User data for:', email, '===\n');

  // 1) Subscription (main user record)
  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('*')
    .ilike('email', email);

  if (subErr) {
    console.error('Error fetching subscriptions:', subErr.message);
    process.exit(1);
  }

  if (!subs || subs.length === 0) {
    console.log('No subscription found with this email.');
    return;
  }

  const sub = subs[0];
  const subId = sub.id;
  console.log('--- Subscription (full row) ---');
  console.log(JSON.stringify(sub, null, 2));

  // 2) Ads owned by this subscription
  const { data: ads, error: adsErr } = await supabase
    .from('ads')
    .select('*')
    .eq('subscription_id', subId)
    .order('created_at', { ascending: false });

  if (adsErr) {
    console.error('Error fetching ads:', adsErr.message);
  } else {
    console.log('\n--- Ads (subscription_id =', subId + ') ---');
    console.log('Count:', (ads || []).length);
    if (ads && ads.length > 0) {
      console.log(JSON.stringify(ads, null, 2));
    }
  }

  // 3) Chat participants (conversations this user is in)
  const { data: participants, error: partErr } = await supabase
    .from('chat_participants')
    .select('*')
    .eq('user_id', email);

  if (partErr) {
    console.error('Error fetching chat_participants:', partErr.message);
  } else {
    console.log('\n--- Chat participants (user_id =', email + ') ---');
    console.log('Count:', (participants || []).length);
    if (participants && participants.length > 0) {
      console.log(JSON.stringify(participants, null, 2));
    }
  }

  // 4) Ad likes by this user (if user_id in ad_likes is email)
  const { data: likes, error: likesErr } = await supabase
    .from('ad_likes')
    .select('*')
    .eq('user_id', email);

  if (!likesErr && likes && likes.length > 0) {
    console.log('\n--- Ad likes (user_id =', email + ') ---');
    console.log('Count:', likes.length);
    console.log(JSON.stringify(likes, null, 2));
  }

  console.log('\n=== Done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
