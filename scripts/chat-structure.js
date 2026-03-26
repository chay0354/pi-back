/**
 * Inspect chat DB structure: tables, columns, and for a user_id list all conversations they're in.
 * Run from pi-back: node scripts/chat-structure.js [user_id]
 * Example: node scripts/chat-structure.js user-123
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
const userId = process.argv[2] || null;

async function main() {
  console.log('=== CHAT DB STRUCTURE ===\n');

  // 1) Conversations
  const { data: convs, error: convErr } = await supabase
    .from('chat_conversations')
    .select('*')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(5);
  if (convErr) {
    console.error('chat_conversations:', convErr.message);
  } else {
    console.log('--- chat_conversations (sample, up to 5) ---');
    console.log('Columns:', convs && convs[0] ? Object.keys(convs[0]).join(', ') : '(none)');
    (convs || []).forEach((c, i) => console.log(`${i + 1}.`, JSON.stringify(c)));
    console.log('');
  }

  // 2) Participants
  const convIds = (convs || []).map((c) => c.id);
  const partQuery = convIds.length
    ? supabase.from('chat_participants').select('*').in('conversation_id', convIds)
    : supabase.from('chat_participants').select('*').limit(10);
  const { data: parts, error: partErr } = await partQuery;
  if (partErr) {
    console.error('chat_participants:', partErr.message);
  } else {
    console.log('--- chat_participants (sample) ---');
    console.log('Columns:', parts && parts[0] ? Object.keys(parts[0]).join(', ') : '(none)');
    (parts || []).slice(0, 10).forEach((p, i) => console.log(`${i + 1}.`, JSON.stringify(p)));
    console.log('');
  }

  // 3) Messages
  const msgQuery = convIds.length
    ? supabase.from('chat_messages').select('*').in('conversation_id', convIds).order('created_at', { ascending: false }).limit(10)
    : supabase.from('chat_messages').select('*').order('created_at', { ascending: false }).limit(10);
  const { data: msgs, error: msgErr } = await msgQuery;
  if (msgErr) {
    console.error('chat_messages:', msgErr.message);
  } else {
    console.log('--- chat_messages (sample) ---');
    console.log('Columns:', msgs && msgs[0] ? Object.keys(msgs[0]).join(', ') : '(none)');
    (msgs || []).forEach((m, i) =>
      console.log(`${i + 1}. conv=${m.conversation_id} sender=${m.sender_id} receiver=${m.receiver_id || '(null)'} body=${(m.body || '').slice(0, 40)}...`)
    );
    console.log('');
  }

  // 4) For a given user_id: all conversations they are part of (same as API)
  if (userId) {
    console.log('=== CONVERSATIONS FOR user_id:', userId, '===\n');
    const { data: myParts } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userId);
    const myConvIds = [...new Set((myParts || []).map((p) => p.conversation_id))];
    console.log('Participant in', myConvIds.length, 'conversation(s):', myConvIds.join(', ') || '(none)');

    if (myConvIds.length > 0) {
      const { data: myConvs } = await supabase
        .from('chat_conversations')
        .select('id, last_message_at')
        .in('id', myConvIds)
        .order('last_message_at', { ascending: false, nullsFirst: false });
      const { data: allParts } = await supabase
        .from('chat_participants')
        .select('conversation_id, user_id, display_name')
        .in('conversation_id', myConvIds);
      const partsByConv = {};
      (allParts || []).forEach((p) => {
        if (!partsByConv[p.conversation_id]) partsByConv[p.conversation_id] = [];
        partsByConv[p.conversation_id].push(p);
      });
      (myConvs || []).forEach((c) => {
        const participants = partsByConv[c.id] || [];
        const other = participants.filter((p) => p.user_id !== userId);
        console.log(`  Conv ${c.id}  last_message_at=${c.last_message_at || '(null)'}  other: ${other.map((o) => o.user_id).join(', ') || '(none)'}`);
      });
    }
  } else {
    console.log('Tip: pass a user_id to see conversations for that user: node scripts/chat-structure.js <user_id>');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
