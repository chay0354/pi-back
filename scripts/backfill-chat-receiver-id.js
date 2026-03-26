/**
 * Backfill receiver_id on chat_messages where it's null.
 * For each message with receiver_id IS NULL, if the conversation has 2 participants,
 * set receiver_id = the other participant (the one who isn't sender_id).
 * Run from pi-back: node scripts/backfill-chat-receiver-id.js
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
  console.log('=== Backfill receiver_id on chat_messages ===\n');

  const { data: messages, error: msgErr } = await supabase
    .from('chat_messages')
    .select('id, conversation_id, sender_id, receiver_id')
    .is('receiver_id', null);

  if (msgErr) {
    console.error('chat_messages may not have receiver_id column:', msgErr.message);
    console.log('Run migration-chat-messages-receiver.sql in Supabase first.');
    process.exit(1);
  }

  if (!messages || messages.length === 0) {
    console.log('No messages with null receiver_id. Nothing to do.');
    return;
  }

  console.log('Messages with null receiver_id:', messages.length);

  const convIds = [...new Set(messages.map((m) => m.conversation_id).filter(Boolean))];
  const { data: allParts } = await supabase
    .from('chat_participants')
    .select('conversation_id, user_id')
    .in('conversation_id', convIds);

  const participantsByConv = {};
  (allParts || []).forEach((p) => {
    if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
    participantsByConv[p.conversation_id].push(p.user_id);
  });

  let updated = 0;
  for (const m of messages) {
    const participants = participantsByConv[m.conversation_id] || [];
    if (participants.length !== 2) continue;
    const sender = (m.sender_id && String(m.sender_id).trim()) || '';
    const other = participants.find((p) => String(p).trim() !== sender);
    if (!other) continue;
    const { error: upErr } = await supabase
      .from('chat_messages')
      .update({ receiver_id: other })
      .eq('id', m.id);
    if (!upErr) {
      updated++;
      console.log('  Updated message', m.id, '-> receiver_id=', other);
    }
  }

  console.log('\nDone. Updated', updated, 'message(s).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
