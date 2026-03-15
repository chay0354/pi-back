/**
 * Shows who has messages from whom: conversations, participants (with display_name/profile_picture_url), and messages.
 * Run from pi-back: node scripts/who-messaged-who.js
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
  console.log('=== Who has messages from whom ===\n');

  const { data: convs, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, type, last_message_at')
    .order('last_message_at', { ascending: false, nullsFirst: false });
  if (convErr) {
    console.error('Failed to fetch conversations:', convErr.message);
    process.exit(1);
  }
  if (!convs || convs.length === 0) {
    console.log('No conversations.');
    return;
  }

  const convIds = convs.map((c) => c.id);

  const { data: allParts, error: partErr } = await supabase
    .from('chat_participants')
    .select('conversation_id, user_id, display_name, profile_picture_url')
    .in('conversation_id', convIds);
  if (partErr) {
    console.error('Failed to fetch participants:', partErr.message);
    process.exit(1);
  }

  const participantsByConv = {};
  (allParts || []).forEach((p) => {
    if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
    participantsByConv[p.conversation_id].push({
      user_id: p.user_id,
      display_name: p.display_name || null,
      profile_picture_url: p.profile_picture_url ? 'yes' : 'no',
    });
  });

  const { data: messages, error: msgErr } = await supabase
    .from('chat_messages')
    .select('id, conversation_id, sender_id, receiver_id, body, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: true });
  if (msgErr) {
    console.error('Failed to fetch messages:', msgErr.message);
    process.exit(1);
  }

  const messagesByConv = {};
  (messages || []).forEach((m) => {
    if (!messagesByConv[m.conversation_id]) messagesByConv[m.conversation_id] = [];
    messagesByConv[m.conversation_id].push(m);
  });

  console.log('--- CONVERSATIONS AND PARTICIPANTS ---\n');
  convs.forEach((c) => {
    const participants = participantsByConv[c.id] || [];
    const msgCount = (messagesByConv[c.id] || []).length;
    console.log(`Conversation ${c.id}  (${msgCount} message(s))`);
    participants.forEach((p) => {
      console.log(`  • user_id: ${p.user_id}  display_name: ${p.display_name || '(empty)'}  profile_pic: ${p.profile_picture_url}`);
    });
    console.log('');
  });

  console.log('--- MESSAGES (sender → receiver) ---\n');
  (messages || []).forEach((m, i) => {
    const body = (m.body || '').slice(0, 60) + ((m.body || '').length > 60 ? '...' : '');
    const time = m.created_at ? new Date(m.created_at).toISOString().slice(0, 19) : '';
    console.log(`${i + 1}. [conv ${m.conversation_id}]  ${time}`);
    console.log(`   ${m.sender_id} → ${m.receiver_id || '(receiver_id missing)'}: ${body}`);
  });

  console.log('\n--- SUMMARY ---');
  console.log('Conversations:', convs.length);
  console.log('Messages:', (messages || []).length);
  const missingReceiver = (messages || []).filter((m) => !m.receiver_id);
  if (missingReceiver.length > 0) {
    console.log('Messages missing receiver_id:', missingReceiver.length, '(receiver may not see this conv in list until repair runs)');
  }
  const emptyDisplay = (allParts || []).filter((p) => !p.display_name && !p.profile_picture_url);
  if (emptyDisplay.length > 0) {
    console.log('Participant rows with no display_name and no profile_picture_url:', emptyDisplay.length);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
