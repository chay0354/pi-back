/**
 * List ads columns and check subscription_id/owner_id + creator lookup.
 * Run from pi-back: node scripts/list-ads-columns-and-creator.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('=== Ads table: subscription_id / owner_id and creator lookup ===\n');

  const { data: adsRows, error: adsError } = await supabase
    .from('ads')
    .select('id, subscription_id, owner_id, status')
    .eq('status', 'published')
    .limit(5);

  if (adsError) {
    console.error('Ads error:', adsError.message);
    process.exit(1);
  }

  if (!adsRows || adsRows.length === 0) {
    console.log('No published ads.');
    return;
  }

  console.log('Sample ads (id, subscription_id, owner_id):');
  adsRows.forEach((r, i) => console.log(`  ${i + 1}. id=${r.id} subscription_id=${r.subscription_id ?? '(null)'} owner_id=${r.owner_id ?? '(null)'}`));

  const subIdsFromSubscriptionId = [...new Set((adsRows || []).map(r => r.subscription_id).filter(Boolean))];
  const subIdsFromOwnerId = [...new Set((adsRows || []).map(r => r.owner_id).filter(Boolean))];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ownerIdsAsUuid = subIdsFromOwnerId.filter(id => uuidRegex.test(id));

  console.log('\nsubIds from subscription_id:', subIdsFromSubscriptionId.length ? subIdsFromSubscriptionId : '(none)');
  console.log('owner_id values (UUIDs used for lookup):', ownerIdsAsUuid.length ? ownerIdsAsUuid : '(none)');

  const allSubIds = [...new Set([...subIdsFromSubscriptionId, ...ownerIdsAsUuid])];
  if (allSubIds.length === 0) {
    console.log('\nNo subscription IDs to look up. Creator name/email will be empty.');
    return;
  }

  const { data: subs, error: subsError } = await supabase
    .from('subscriptions')
    .select('id, email, name, business_name, contact_person_name, broker_office_name, subscription_type')
    .in('id', allSubIds);

  if (subsError) {
    console.error('Subscriptions error:', subsError.message);
    return;
  }
  console.log('\nSubscriptions found:', (subs || []).length);
  (subs || []).forEach((s, i) => {
    const type = (s.subscription_type || '').toLowerCase();
    let displayName = null;
    if (type === 'company') displayName = s.business_name || s.name || s.contact_person_name;
    else if (type === 'broker') displayName = s.broker_office_name || s.name || s.contact_person_name;
    else displayName = s.name || s.business_name || s.contact_person_name;
    console.log(`  ${i + 1}. id=${s.id} email=${s.email ?? '(null)'} creator_name=${displayName ?? '(null)'}`);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
