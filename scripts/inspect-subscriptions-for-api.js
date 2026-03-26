/**
 * Inspect subscriptions table structure to understand how to fetch fields for the API
 * (including description, types, activity_regions, etc.).
 * Run from pi-back: node scripts/inspect-subscriptions-for-api.js [email_or_id]
 * Without args: prints table structure and first row. With email or id: prints that subscription's row.
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

const API_FIELDS = [
  'id',
  'email',
  'name',
  'contact_person_name',
  'subscription_type',
  'business_name',
  'broker_office_name',
  'profile_picture_url',
  'specializations',
  'activity_regions',
  'types',
  'description',
];

function valueType(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

async function main() {
  const arg = process.argv[2] ? process.argv[2].trim() : null;

  console.log('=== Subscriptions table: structure for API fetch ===\n');

  let rows;
  if (arg) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(arg) || /^[0-9a-f]{32}$/i.test(arg);
    if (isUuid || /^\d+$/.test(arg)) {
      const { data, error } = await supabase.from('subscriptions').select('*').eq('id', arg).limit(1);
      if (error) {
        console.error('Error fetching by id:', error.message);
        process.exit(1);
      }
      rows = data;
    } else {
      const { data, error } = await supabase.from('subscriptions').select('*').ilike('email', arg).limit(1);
      if (error) {
        console.error('Error fetching by email:', error.message);
        process.exit(1);
      }
      rows = data;
    }
    if (!rows || rows.length === 0) {
      console.log('No subscription found for:', arg);
      return;
    }
    console.log('Subscription for', isUuid || /^\d+$/.test(arg) ? 'id' : 'email', arg, '\n');
  } else {
    const { data, error } = await supabase.from('subscriptions').select('*').limit(5);
    if (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
    rows = data || [];
    if (rows.length === 0) {
      console.log('No rows in subscriptions table.');
      return;
    }
  }

  const first = rows[0];
  const allColumns = Object.keys(first).sort();

  console.log('--- All columns in table (' + allColumns.length + ') ---');
  allColumns.forEach((c) => {
    const v = first[c];
    const type = valueType(v);
    const inApi = API_FIELDS.includes(c) ? ' [API]' : '';
    let sample = v == null ? 'NULL' : String(v).slice(0, 40);
    if (typeof v === 'string' && v.length > 40) sample = v.slice(0, 37) + '...';
    console.log(`  ${c.padEnd(28)} ${type.padEnd(8)} ${sample}${inApi}`);
  });

  console.log('\n--- API select list (fields we use in GET /api/subscription/:id and listings) ---');
  const missing = API_FIELDS.filter((f) => !allColumns.includes(f));
  const present = API_FIELDS.filter((f) => allColumns.includes(f));
  console.log('Present:', present.join(', '));
  if (missing.length) {
    console.log('MISSING in DB (will be undefined):', missing.join(', '));
  }

  console.log('\n--- Description-related columns ---');
  const descCols = allColumns.filter((c) => /desc|bio|about|description/i.test(c));
  if (descCols.length === 0) {
    console.log('  No column name contains desc/bio/about/description.');
  } else {
    descCols.forEach((c) => {
      const v = first[c];
      console.log(`  ${c}:`, v == null ? 'NULL' : typeof v === 'string' ? `"${v.slice(0, 60)}${v.length > 60 ? '...' : ''}"` : valueType(v));
    });
  }

  console.log('\n--- Sample row: API fields only ---');
  const apiRow = {};
  for (const f of API_FIELDS) {
    if (first.hasOwnProperty(f)) apiRow[f] = first[f];
  }
  console.log(JSON.stringify(apiRow, null, 2));

  if (rows.length > 1 && !arg) {
    console.log('\n--- description field for first 3 rows ---');
    rows.slice(0, 3).forEach((r, i) => {
      const d = r.description ?? r.bio ?? r.desc ?? r.about;
      console.log(`  Row ${i + 1} (id=${r.id}): description=${d == null ? 'NULL' : `"${String(d).slice(0, 50)}..."`}`);
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
