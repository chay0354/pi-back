/**
 * Inspect DB structure for chat + subscriptions (emails, participants, messages).
 * Run from pi-back: node scripts/chat-db-structure.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or key in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function norm(s) {
  return (s != null ? String(s).trim().toLowerCase() : '') || '';
}

async function main() {
  console.log('=== SUBSCRIPTIONS (id, email, type) ===\n');
  const { data: subs, error: eSubs } = await supabase
    .from('subscriptions')
    .select('id, email, subscription_type')
    .order('created_at', { ascending: false });
  if (eSubs) {
    console.error('subscriptions:', eSubs.message);
  } else {
    (subs || []).forEach((s) => {
      console.log(`  ${s.id}  email=${s.email || '(null)'}  type=${s.subscription_type || ''}`);
    });
  }

  console.log('\n=== CHAT_CONVERSATIONS ===\n');
  const { data: convs } = await supabase.from('chat_conversations').select('id, last_message_at').order('last_message_at', { ascending: false });
  (convs || []).forEach((c) => console.log(`  ${c.id}  last=${c.last_message_at || ''}`));

  console.log('\n=== CHAT_PARTICIPANTS (conv -> user_id) ===\n');
  const { data: parts } = await supabase.from('chat_participants').select('conversation_id, user_id');
  const byConv = {};
  (parts || []).forEach((p) => {
    if (!byConv[p.conversation_id]) byConv[p.conversation_id] = [];
    byConv[p.conversation_id].push(p.user_id);
  });
  Object.keys(byConv).forEach((cid) => {
    console.log(`  ${cid}  ->  ${byConv[cid].join(', ')}`);
  });

  console.log('\n=== CHAT_MESSAGES (conv, sender_id -> receiver_id, body preview) ===\n');
  const { data: msgs } = await supabase.from('chat_messages').select('conversation_id, sender_id, receiver_id, body, created_at').order('created_at', { ascending: false }).limit(20);
  (msgs || []).forEach((m) => {
    const body = (m.body || '').slice(0, 30) + ((m.body || '').length > 30 ? '...' : '');
    console.log(`  conv=${m.conversation_id}  ${m.sender_id} -> ${m.receiver_id || '(null)'}  ${body}`);
  });

  console.log('\n=== EMAIL -> subscription ids (for same-email link) ===\n');
  const emailToIds = {};
  (subs || []).forEach((s) => {
    const e = norm(s.email);
    if (!e) return;
    if (!emailToIds[e]) emailToIds[e] = [];
    emailToIds[e].push(s.id);
  });
  Object.keys(emailToIds).forEach((e) => {
    console.log(`  ${e}  ->  ${emailToIds[e].join(', ')}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
