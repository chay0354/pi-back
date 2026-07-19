/**
 * Apply pi-back/run-pending-migrations.sql when DATABASE_URL is set.
 * Get it from Supabase Dashboard → Project Settings → Database → Connection string (URI).
 *
 * Usage:
 *   set DATABASE_URL=postgresql://postgres.[ref]:[password]@...
 *   node scripts/run-pending-migrations.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const conn =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL;
  if (!conn) {
    console.error(
      'Missing DATABASE_URL. Add it to pi-back/.env from Supabase → Settings → Database → Connection string.',
    );
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'run-pending-migrations.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('Connected. Applying pending migrations...');
    await client.query(sql);
    console.log('Done. Schema cache reload notified.');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
