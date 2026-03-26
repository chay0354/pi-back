/**
 * Find all subscription_id values in ads that don't exist in subscriptions,
 * and create those subscriptions so the foreign key (fk_ads_subscription) is satisfied.
 * Run from pi-back: node scripts/create-missing-subscriptions-for-ads.js
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

async function main() {
  console.log('=== Create missing subscriptions for ads (fix FK violation) ===\n');

  const { data: ads, error: adsErr } = await supabase
    .from('ads')
    .select('subscription_id')
    .not('subscription_id', 'is', null);

  if (adsErr) {
    console.error('Error fetching ads:', adsErr.message);
    process.exit(1);
  }

  const subIdsInAds = [...new Set((ads || []).map((r) => r.subscription_id).filter(Boolean))];
  if (subIdsInAds.length === 0) {
    console.log('No ads with subscription_id.');
    return;
  }

  const { data: existingSubs, error: subErr } = await supabase
    .from('subscriptions')
    .select('id')
    .in('id', subIdsInAds);

  if (subErr) {
    console.error('Error fetching subscriptions:', subErr.message);
    process.exit(1);
  }

  const existingIds = new Set((existingSubs || []).map((s) => s.id));
  const missingIds = subIdsInAds.filter((id) => !existingIds.has(id));

  if (missingIds.length === 0) {
    console.log('All subscription_ids in ads exist in subscriptions. Nothing to do.');
    return;
  }

  console.log('Missing subscriptions (ads reference these but they do not exist):', missingIds);
  const now = new Date().toISOString();

  for (const id of missingIds) {
    const row = {
      id,
      subscription_type: 'broker',
      email: `uploader-${id.slice(0, 8)}@placeholder.local`,
      name: 'משתמש',
      broker_office_name: 'משתמש',
      status: 'verified',
      agreed_to_terms: true,
      subscriber_number: String(Date.now() + Math.random()).slice(-9).replace('.', ''),
      verification_code: '000000',
      verification_code_expires_at: now,
      created_at: now,
      updated_at: now,
      verified_at: now,
    };

    const { error: insertErr } = await supabase.from('subscriptions').insert([row]).select('id').single();

    if (insertErr) {
      console.error('Failed to create subscription', id, ':', insertErr.message);
      continue;
    }
    console.log('Created subscription:', id);
  }

  console.log('\nDone. You can now insert/update ads with these subscription_ids.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
