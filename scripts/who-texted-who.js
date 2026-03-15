/**
 * Prints who texted whom: for each chat message, shows sender → receiver and the message body.
 * Run from pi-back: node scripts/who-texted-who.js
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

function displayNameFromSub(s) {
  if (!s) return null;
  const type = (s.subscription_type || '').toLowerCase();
  if (type === 'company') return s.business_name || s.name || s.contact_person_name || null;
  if (type === 'broker') return s.broker_office_name || s.name || s.contact_person_name || null;
  return s.name || s.contact_person_name || null;
}

async function main() {
  console.log('=== Who texted whom (chat_messages) ===\n');

  let selectMsg = supabase
    .from('chat_messages')
    .select('id, conversation_id, sender_id, receiver_id, body, created_at')
    .order('created_at', { ascending: true });
  const { data: messages, error: msgErr } = await selectMsg;
  if (msgErr) {
    console.error('Failed to fetch messages:', msgErr.message);
    process.exit(1);
  }
  if (!messages || messages.length === 0) {
    console.log('No messages found.');
    return;
  }

  const convIds = [...new Set(messages.map((m) => m.conversation_id).filter(Boolean))];
  let otherByConvAndSender = {};
  if (convIds.length > 0) {
    const { data: allParts } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds);
    const byConv = {};
    (allParts || []).forEach((p) => {
      if (!byConv[p.conversation_id]) byConv[p.conversation_id] = [];
      byConv[p.conversation_id].push(p.user_id);
    });
    convIds.forEach((cid) => {
      const userIdsInConv = byConv[cid] || [];
      userIdsInConv.forEach((uid) => {
        const other = userIdsInConv.find((x) => x !== uid);
        if (other) otherByConvAndSender[`${cid}:${uid}`] = other;
      });
    });
  }

  const allUserIds = new Set();
  messages.forEach((m) => {
    if (m.sender_id) allUserIds.add(m.sender_id);
    if (m.receiver_id) allUserIds.add(m.receiver_id);
  });
  Object.values(otherByConvAndSender).forEach((id) => allUserIds.add(id));
  const userIds = [...allUserIds];

  const namesById = {};
  const detailById = {}; // email, subscriber_number for clearer identification
  if (userIds.length > 0) {
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('id, name, contact_person_name, email, subscriber_number, subscription_type, business_name, broker_office_name')
      .in('id', userIds);
    (subs || []).forEach((s) => {
      namesById[s.id] = displayNameFromSub(s) || s.id;
      detailById[s.id] = { email: s.email || null, subscriber_number: s.subscriber_number || null };
    });
    const { data: participants } = await supabase
      .from('chat_participants')
      .select('user_id, display_name')
      .in('user_id', userIds);
    (participants || []).forEach((p) => {
      if (p.display_name && !namesById[p.user_id]) namesById[p.user_id] = p.display_name;
      else if (!namesById[p.user_id]) namesById[p.user_id] = p.user_id;
    });
  }
  userIds.forEach((id) => {
    if (!namesById[id]) namesById[id] = id;
  });

  const label = (id) => {
    const name = namesById[id] || id;
    const d = detailById[id];
    if (!d) return name;
    const parts = [name];
    if (d.email) parts.push(d.email);
    if (d.subscriber_number != null) parts.push(`מנוי ${d.subscriber_number}`);
    return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : name;
  };

  const fmtTime = (created_at) => {
    if (!created_at) return '';
    const d = new Date(created_at);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  };

  messages.forEach((m, i) => {
    const receiverId = m.receiver_id || (m.conversation_id && otherByConvAndSender[`${m.conversation_id}:${m.sender_id}`]);
    const senderLabel = m.sender_id ? label(m.sender_id) : '?';
    const receiverLabel = receiverId ? label(receiverId) : '?';
    const body = (m.body || '').slice(0, 80) + ((m.body || '').length > 80 ? '...' : '');
    console.log(`${i + 1}. ${fmtTime(m.created_at)}  ${senderLabel} → ${receiverLabel}: ${body}`);
  });

  console.log(`\nTotal: ${messages.length} message(s)`);

  console.log('\n--- Participants (id → email, מספר מנוי) ---');
  userIds.forEach((id) => {
    const d = detailById[id];
    const name = namesById[id] || id;
    if (d && (d.email || d.subscriber_number != null)) {
      console.log(`  ${id}  name: ${name}  email: ${d.email || '—'}  מספר מנוי: ${d.subscriber_number != null ? d.subscriber_number : '—'}`);
    } else {
      console.log(`  ${id}  name: ${name}  (no email/subscriber_number in DB)`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
