/**
 * Ensure subscription 20be5e65-9cf8-4a12-b88f-b6d9d07219ae exists so listings
 * get creator_name/creator_email and the profile screen shows correct details.
 * Run from pi-back: node scripts/ensure-subscription-for-ads.js
 *
 * Optional args: node scripts/ensure-subscription-for-ads.js [subscription_id] [email] [display_name]
 * Default: id=20be5e65-9cf8-4a12-b88f-b6d9d07219ae, email=broker-placeholder@example.com, name=מתווך
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

const SUB_ID = process.argv[2] || '20be5e65-9cf8-4a12-b88f-b6d9d07219ae';
const EMAIL = process.argv[3] || 'broker-placeholder@example.com';
const DISPLAY_NAME = process.argv[4] || 'מתווך';

async function main() {
  console.log('=== Ensure subscription exists for ads ===\n');
  console.log('Subscription ID:', SUB_ID);
  console.log('Email:', EMAIL);
  console.log('Display name:', DISPLAY_NAME);
  console.log('');

  const { data: existing, error: fetchErr } = await supabase
    .from('subscriptions')
    .select('id, email, name, broker_office_name')
    .eq('id', SUB_ID)
    .maybeSingle();

  if (fetchErr) {
    console.error('Error checking subscription:', fetchErr.message);
    process.exit(1);
  }

  if (existing) {
    console.log('Subscription already exists.');
    console.log('  name:', existing.name);
    console.log('  broker_office_name:', existing.broker_office_name);
    console.log('  email:', existing.email);
    return;
  }

  const now = new Date().toISOString();
  const row = {
    id: SUB_ID,
    subscription_type: 'broker',
    email: EMAIL,
    name: DISPLAY_NAME,
    broker_office_name: DISPLAY_NAME,
    status: 'verified',
    agreed_to_terms: true,
    subscriber_number: String(Date.now()).slice(-9),
    verification_code: '000000',
    verification_code_expires_at: now,
    created_at: now,
    updated_at: now,
    verified_at: now,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('subscriptions')
    .insert([row])
    .select('id, email, name, broker_office_name, status')
    .single();

  if (insertErr) {
    console.error('Error inserting subscription:', insertErr.message);
    process.exit(1);
  }

  console.log('Created subscription:');
  console.log(JSON.stringify(inserted, null, 2));
  console.log('\nListings with this subscription_id will now get creator_name and creator_email.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
