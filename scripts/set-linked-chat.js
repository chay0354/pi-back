/**
 * Set linked_chat_subscription_id for a subscription (so they see the other id's chats).
 * Run from pi-back: node scripts/set-linked-chat.js <subscription_id> <linked_to_id>
 * Example: node scripts/set-linked-chat.js 20be5e65-9cf8-4a12-b88f-b6d9d07219ae 440ff1f1-bc63-40c3-86bc-39b97ffe6c15
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or key in .env');
  process.exit(1);
}

const subscriptionId = process.argv[2];
const linkedToId = process.argv[3];

if (!subscriptionId || !linkedToId) {
  console.log('Usage: node scripts/set-linked-chat.js <subscription_id> <linked_to_id>');
  console.log('Example: node scripts/set-linked-chat.js 20be5e65-9cf8-4a12-b88f-b6d9d07219ae 440ff1f1-bc63-40c3-86bc-39b97ffe6c15');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase
    .from('subscriptions')
    .update({ linked_chat_subscription_id: linkedToId })
    .eq('id', subscriptionId)
    .select('id, linked_chat_subscription_id')
    .single();

  if (error) {
    if (error.message && error.message.includes('linked_chat_subscription_id')) {
      console.error('Column may not exist. Run migration-chat-link-subscription.sql in Supabase first.');
    }
    console.error('Error:', error.message);
    process.exit(1);
  }
  console.log('Updated:', data);
  console.log('Subscription', subscriptionId, 'will now see chats for', linkedToId);
}

main();
