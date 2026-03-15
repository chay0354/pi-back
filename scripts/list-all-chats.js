/**
 * List all chats and show between who and who each chat is.
 * Run from pi-back: node scripts/list-all-chats.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_*_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('=== ALL CHATS (who ↔ who) ===\n');

  const { data: convs, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, type, last_message_at, created_at')
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (convErr) {
    console.error('Failed to fetch conversations:', convErr.message);
    process.exit(1);
  }

  if (!convs || convs.length === 0) {
    console.log('No chats found.');
    return;
  }

  const convIds = convs.map((c) => c.id);

  const { data: allParts, error: partErr } = await supabase
    .from('chat_participants')
    .select('conversation_id, user_id, display_name')
    .in('conversation_id', convIds);

  if (partErr) {
    console.error('Failed to fetch participants:', partErr.message);
    process.exit(1);
  }

  const { data: msgCounts } = await supabase
    .from('chat_messages')
    .select('conversation_id')
    .in('conversation_id', convIds);

  const countByConv = {};
  (msgCounts || []).forEach((m) => {
    countByConv[m.conversation_id] = (countByConv[m.conversation_id] || 0) + 1;
  });

  const participantsByConv = {};
  const allUserIds = new Set();
  (allParts || []).forEach((p) => {
    if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
    participantsByConv[p.conversation_id].push({
      user_id: p.user_id,
      display_name: p.display_name || null,
    });
    allUserIds.add(p.user_id);
  });

  let namesByUserId = {};
  if (allUserIds.size > 0) {
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('id, name, contact_person_name, business_name, broker_office_name, subscription_type')
      .in('id', [...allUserIds]);
    (subs || []).forEach((s) => {
      const type = (s.subscription_type || '').toLowerCase();
      let name = s.name || s.contact_person_name || s.business_name || s.broker_office_name || s.id;
      namesByUserId[s.id] = name || s.id;
    });
  }
  (allParts || []).forEach((p) => {
    if (!namesByUserId[p.user_id] && p.display_name) namesByUserId[p.user_id] = p.display_name;
  });
  [...allUserIds].forEach((id) => {
    if (!namesByUserId[id]) namesByUserId[id] = id;
  });

  convs.forEach((c, i) => {
    const participants = participantsByConv[c.id] || [];
    const count = countByConv[c.id] || 0;
    const lastAt = c.last_message_at ? new Date(c.last_message_at).toISOString().slice(0, 16) : '—';

    const who = participants.map((p) => {
      const name = namesByUserId[p.user_id] || p.display_name || p.user_id;
      return `${name} (${p.user_id})`;
    });

    const between = who.length >= 2 ? who.join(' ↔ ') : who.length === 1 ? `${who[0]} (only 1 participant)` : '—';
    console.log(`${i + 1}. Chat ${c.id}`);
    console.log(`   Between: ${between}`);
    console.log(`   Messages: ${count}  |  Last: ${lastAt}`);
    console.log('');
  });

  console.log('---');
  console.log(`Total chats: ${convs.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
