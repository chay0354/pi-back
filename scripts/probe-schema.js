require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function probe(table, cols) {
  const sel = cols.join(',');
  const { error } = await s.from(table).select(sel).limit(1);
  if (error) return { table, ok: false, error: error.message };
  return { table, ok: true, cols };
}

(async () => {
  const checks = await Promise.all([
    probe('subscriptions', ['block_exclusive_offers', 'block_collab_offers']),
    probe('chat_exclusive_offers', ['offer_kind']),
    probe('stories', ['general_details']),
    probe('ads', ['is_frozen', 'feed_post', 'share_count']),
    probe('chat_conversations', [
      'group_image_url',
      'group_description',
      'group_creator_email',
    ]),
    probe('chat_messages', [
      'media_type',
      'media_url',
      'is_listing_share',
      'receiver_id',
    ]),
    probe('chat_participants', ['group_role']),
  ]);
  console.log(JSON.stringify(checks, null, 2));
})();
