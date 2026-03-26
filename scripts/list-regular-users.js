/**
 * Inspects how regular users (e.g. user-xxx IDs) are stored in the DB.
 * Regular users are not in subscriptions; their name/pic come from chat_participants
 * when they send a message (sender_display_name, sender_profile_picture_url).
 *
 * Run from pi-back: node scripts/list-regular-users.js
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isLikelyRegularUser(id) {
  if (!id || typeof id !== 'string') return false;
  return id.startsWith('user-') || !UUID_REGEX.test(id.trim());
}

async function main() {
  console.log('=== Regular users: how details are stored ===\n');

  const { data: allParticipants, error: partErr } = await supabase
    .from('chat_participants')
    .select('conversation_id, user_id, display_name, profile_picture_url');
  if (partErr) {
    console.error('Failed to fetch chat_participants:', partErr.message);
    process.exit(1);
  }

  const byUserId = {};
  (allParticipants || []).forEach((p) => {
    if (!byUserId[p.user_id]) byUserId[p.user_id] = { user_id: p.user_id, display_name: p.display_name, profile_picture_url: p.profile_picture_url, conversations: [] };
    byUserId[p.user_id].conversations.push(p.conversation_id);
    if (p.display_name) byUserId[p.user_id].display_name = p.display_name;
    if (p.profile_picture_url) byUserId[p.user_id].profile_picture_url = p.profile_picture_url;
  });

  const regularUserIds = Object.keys(byUserId).filter(isLikelyRegularUser);
  console.log('Chat participants with non-UUID user_id (regular users):', regularUserIds.length);
  console.log('');

  if (regularUserIds.length === 0) {
    console.log('No regular user IDs found in chat_participants.');
    console.log('Regular users get name/pic stored when THEY send a message (sender_display_name, sender_profile_picture_url).');
    return;
  }

  for (const uid of regularUserIds) {
    const row = byUserId[uid];
    console.log('user_id:', uid);
    console.log('  display_name:', row.display_name || '(empty – will show "משתמש" until they send a message)');
    console.log('  profile_picture_url:', row.profile_picture_url ? row.profile_picture_url.slice(0, 60) + '...' : '(empty)');
    console.log('  in conversations:', row.conversations.length);
    console.log('');
  }

  const inSubs = await supabase.from('subscriptions').select('id').in('id', regularUserIds);
  const foundInSubs = (inSubs.data || []).map((s) => s.id);
  if (foundInSubs.length > 0) console.log('Also found in subscriptions (unexpected for user-xxx):', foundInSubs);
  console.log('\nDone. Chats use display_name/profile_picture_url from chat_participants for these users.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
