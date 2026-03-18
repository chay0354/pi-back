/**
 * Backfill creator_name and creator_email on existing ads from their subscription.
 * Run after add-ads-creator-columns.sql: node scripts/backfill-ads-creator.js
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

function displayNameFromSub(s) {
  const type = (s.subscription_type || '').toLowerCase();
  if (type === 'company') return s.business_name || s.name || s.contact_person_name || null;
  if (type === 'broker') return s.broker_office_name || s.name || s.contact_person_name || null;
  return s.name || s.business_name || s.contact_person_name || null;
}

async function main() {
  console.log('=== Backfill creator_name, creator_email on ads ===\n');

  const { data: ads, error: adsErr } = await supabase
    .from('ads')
    .select('id, subscription_id, owner_id, creator_name, creator_email')
    .or('subscription_id.not.is.null,owner_id.not.is.null');

  if (adsErr) {
    console.error('Error fetching ads:', adsErr.message);
    process.exit(1);
  }

  const subIds = [...new Set([
    ...(ads || []).map(r => r.subscription_id).filter(Boolean),
    ...(ads || []).map(r => r.owner_id).filter(Boolean),
  ])];

  if (subIds.length === 0) {
    console.log('No ads with subscription_id or owner_id.');
    return;
  }

  const { data: subs, error: subsErr } = await supabase
    .from('subscriptions')
    .select('id, email, name, contact_person_name, subscription_type, business_name, broker_office_name')
    .in('id', subIds);

  if (subsErr) {
    console.error('Error fetching subscriptions:', subsErr.message);
    process.exit(1);
  }

  const byId = {};
  (subs || []).forEach(s => {
    byId[s.id] = { name: displayNameFromSub(s), email: s.email || null };
  });

  let updated = 0;
  for (const ad of ads || []) {
    const subId = ad.subscription_id || ad.owner_id;
    const creator = byId[subId];
    if (!creator) continue;
    const needsUpdate = !ad.creator_name || !ad.creator_email;
    if (!needsUpdate) continue;
    const { error: upErr } = await supabase
      .from('ads')
      .update({ creator_name: creator.name, creator_email: creator.email })
      .eq('id', ad.id);
    if (!upErr) updated++;
  }

  console.log('Updated', updated, 'ads with creator_name and creator_email.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
