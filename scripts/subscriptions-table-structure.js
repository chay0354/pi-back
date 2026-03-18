/**
 * Print the structure of the subscriptions table (column names and sample types/values).
 * Run from pi-back: node scripts/subscriptions-table-structure.js
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

function valueType(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

async function main() {
  console.log('=== Subscriptions table structure ===\n');

  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('*')
    .limit(5);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('No rows in subscriptions. Table may be empty.');
    return;
  }

  const first = rows[0];
  const columns = Object.keys(first).sort();

  console.log('Columns (' + columns.length + '):\n');
  console.log('Column name                    | Type      | Sample value');
  console.log('-------------------------------|-----------|----------------------------------------');

  for (const col of columns) {
    const v = first[col];
    const type = valueType(v);
    let sample = v;
    if (v == null) sample = 'NULL';
    else if (typeof v === 'string' && v.length > 36) sample = v.slice(0, 33) + '...';
    else if (typeof v === 'object') sample = JSON.stringify(v).slice(0, 35) + (JSON.stringify(v).length > 35 ? '...' : '');
    const colPadded = col.padEnd(30);
    const typePadded = type.padEnd(9);
    console.log(`  ${colPadded} | ${typePadded} | ${sample}`);
  }

  console.log('\n--- Full sample row (first record) ---');
  console.log(JSON.stringify(first, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
