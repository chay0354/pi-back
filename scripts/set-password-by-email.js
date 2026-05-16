/**
 * Set password_hash for a verified B2B subscription (e.g. hash was never saved).
 * Usage: node scripts/set-password-by-email.js <email> <password>
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  if (!email || password.length < 8) {
    console.error('Usage: node scripts/set-password-by-email.js <email> <password-min-8-chars>');
    process.exit(1);
  }

  const { data: sub, error } = await supabase
    .from('subscriptions')
    .select('id, email, status, subscription_type, password_hash')
    .ilike('email', email)
    .in('status', ['verified', 'active', 'pending_verification'])
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!sub) {
    console.log('No subscription for', email);
    return;
  }

  const { error: updErr } = await supabase
    .from('subscriptions')
    .update({ password_hash: hashPassword(password) })
    .eq('id', sub.id);

  if (updErr) {
    console.error('Update failed:', updErr.message);
    console.error('Run migration-subscription-password.sql in Supabase if column is missing.');
    process.exit(1);
  }

  console.log('Password set for', sub.email, 'id=', sub.id, 'status=', sub.status);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
