/**
 * Create a verified regular user in Supabase (subscription_type=user).
 * Usage: node scripts/create-regular-user.js [email] [password] [name]
 */
require('dotenv').config();
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const stamp = Date.now();
const email = (process.argv[2] || `regular.user.${stamp}@test.com`).trim().toLowerCase();
const password = process.argv[3] || 'Test1234!';
const name = process.argv[4] || 'יוסי כהן';
const phone = '050-1112233';

(async () => {
  const row = {
    subscription_type: 'user',
    email,
    name,
    phone,
    password_hash: hashPassword(password),
    status: 'verified',
    verified_at: new Date().toISOString(),
  };

  const {data: existing} = await supabase
    .from('subscriptions')
    .select('id')
    .ilike('email', email)
    .maybeSingle();

  let sub;
  let created = false;
  if (existing?.id) {
    const {data, error} = await supabase
      .from('subscriptions')
      .update(row)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    sub = data;
  } else {
    const {data, error} = await supabase.from('subscriptions').insert(row).select('*').single();
    if (error) throw new Error(error.message);
    sub = data;
    created = true;
  }

  console.log(created ? 'Created regular user:' : 'Updated regular user:');
  console.log('  email:', sub.email);
  console.log('  password:', password);
  console.log('  name:', sub.name);
  console.log('  id:', sub.id);
  console.log('  subscription_type:', sub.subscription_type);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
