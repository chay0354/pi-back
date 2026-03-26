/**
 * Debug script: see how we get display name for each subscription type.
 * Run from pi-back: node scripts/debug-creator-names.js
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

function getCreatorDisplayName(s) {
  // agent_name may not exist in DB; server stores broker agent in "name"
  const type = (s.subscription_type || '').toLowerCase();
  if (type === 'company') {
    return s.business_name || s.name || s.contact_person_name || null;
  }
  if (type === 'broker') {
    return s.broker_office_name || s.name || s.contact_person_name || null;
  }
  return s.name || s.business_name || s.contact_person_name || null;
}

async function main() {
  console.log('=== Subscriptions table: columns we need for creator name ===\n');

  // 1) Fetch subscriptions - try with columns that exist (agent_name may not exist in DB)
  let subs = [];
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('id, email, subscription_type, name, contact_person_name, business_name, broker_office_name')
      .limit(20);
    if (error) throw error;
    subs = data || [];
    console.log('Fetched', subs.length, 'subscriptions (columns: id, email, subscription_type, name, contact_person_name, business_name, broker_office_name).\n');
  } catch (e) {
    console.log('Select failed:', e.message);
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .limit(5);
      if (error) throw error;
      subs = data || [];
      console.log('Fetched', subs.length, 'subscriptions with select(*). First row keys:', subs[0] ? Object.keys(subs[0]).join(', ') : 'none');
    } catch (e2) {
      console.error('Fallback also failed:', e2.message);
      process.exit(1);
    }
  }

  if (subs.length === 0) {
    console.log('No subscriptions in DB. Add a subscription and run again.');
    return;
  }

  console.log('--- Per-row raw data and computed display name ---\n');
  subs.forEach((s, i) => {
    const displayName = getCreatorDisplayName(s);
    console.log(`[${i + 1}] id: ${s.id}`);
    console.log('    subscription_type:', s.subscription_type ?? '(null)');
    console.log('    name:', s.name ?? '(null)');
    console.log('    contact_person_name:', s.contact_person_name ?? '(null)');
    console.log('    business_name:', s.business_name ?? '(null)');
    console.log('    broker_office_name:', s.broker_office_name ?? '(null)');
    console.log('    => creator_display_name:', displayName ?? '(null) → would show "משתמש" on frontend');
    console.log('');
  });

  // 2) How listings get creator_name (same as server)
  console.log('=== How listings get creator_name (sample from ads) ===\n');
  let adsRows = [];
  try {
    const { data, error } = await supabase
      .from('ads')
      .select('id, subscription_id')
      .eq('status', 'published')
      .limit(5);
    if (error) throw error;
    adsRows = data || [];
  } catch (e) {
    console.log('Could not fetch ads:', e.message);
  }

  if (adsRows.length > 0) {
    const subIds = [...new Set(adsRows.map(r => r.subscription_id).filter(Boolean))];
    const creatorBySubId = {};
    for (const s of subs) {
      if (subIds.includes(s.id)) {
        creatorBySubId[s.id] = {
          creator_email: s.email || null,
          creator_name: getCreatorDisplayName(s) || null,
        };
      }
    }
    adsRows.forEach((row) => {
      const creator = creatorBySubId[row.subscription_id] || {};
      console.log(`Ad ${row.id} subscription_id=${row.subscription_id} => creator_name="${creator.creator_name ?? '(null)'}"`);
    });
  } else {
    console.log('No published ads found.');
  }

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
