/**
 * List columns of the subscriptions table (and sample row).
 * Run from pi-back: node scripts/list-subscriptions-columns.js
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
  console.log('=== Subscriptions table: columns and sample row ===\n');

  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('*')
    .limit(3);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('No rows in subscriptions.');
    return;
  }

  const first = rows[0];
  const columns = Object.keys(first).sort();
  console.log('Columns (' + columns.length + '):');
  columns.forEach(c => console.log('  -', c));

  console.log('\n--- Sample row (first subscription) ---');
  console.log(JSON.stringify(first, null, 2));

  console.log('\n--- Name/email fields for first 3 rows ---');
  rows.forEach((r, i) => {
    console.log(`Row ${i + 1}: name=${r.name ?? '(null)'}, email=${r.email ?? '(null)'}, business_name=${r.business_name ?? '(null)'}, contact_person_name=${r.contact_person_name ?? '(null)'}, broker_office_name=${r.broker_office_name ?? '(null)'}`);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
