/**
 * Trace why receiver might not see messages.
 * For every receiver_id in chat_messages: check subscription, same-email ids, participants, and simulated API result.
 * Run from pi-back: node scripts/why-receiver-sees-nothing.js
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

function normId(id) {
  return (id != null ? String(id).trim().toLowerCase() : '') || '';
}
function normEmail(email) {
  return (email != null ? String(email).trim().toLowerCase() : '') || '';
}

async function getSameEmailIds(userId) {
  const { data: mySub } = await supabase.from('subscriptions').select('email').eq('id', userId).maybeSingle();
  if (!mySub || !normEmail(mySub.email)) return { ids: [userId], reason: 'no_sub_or_no_email', sub: mySub };
  const { data: allSubs } = await supabase.from('subscriptions').select('id, email');
  const myEmailNorm = normEmail(mySub.email);
  const ids = (allSubs || []).filter((s) => normEmail(s.email) === myEmailNorm).map((s) => s.id).filter(Boolean);
  return { ids: ids.length ? ids : [userId], reason: 'same_email', sub: mySub };
}

async function main() {
  const { data: msgs } = await supabase
    .from('chat_messages')
    .select('id, conversation_id, sender_id, receiver_id, body, created_at')
    .order('created_at', { ascending: false });
  const withReceiver = (msgs || []).filter((m) => m.receiver_id != null && String(m.receiver_id).trim());
  const receiverIds = [...new Set(withReceiver.map((m) => String(m.receiver_id).trim()))];

  console.log('=== MESSAGES WITH receiver_id (who received what) ===\n');
  withReceiver.forEach((m) => {
    const body = (m.body || '').slice(0, 40) + ((m.body || '').length > 40 ? '...' : '');
    console.log(`  conv=${m.conversation_id}  sender=${m.sender_id} -> receiver=${m.receiver_id}  ${body}`);
  });

  console.log('\n=== UNIQUE receiver_ids FROM MESSAGES ===\n');
  console.log(receiverIds.join('\n'));

  const allConvIds = (await supabase.from('chat_conversations').select('id')).data?.map((c) => c.id) || [];
  const { data: allParts } = await supabase.from('chat_participants').select('conversation_id, user_id').in('conversation_id', allConvIds);
  const participantsByConv = {};
  (allParts || []).forEach((p) => {
    if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
    participantsByConv[p.conversation_id].push(p.user_id);
  });

  const { data: allMessages } = await supabase.from('chat_messages').select('conversation_id, receiver_id').in('conversation_id', allConvIds);

  console.log('\n=== FOR EACH RECEIVER: WHY THEY SEE / DON\'T SEE CONVS ===\n');

  for (const receiverId of receiverIds) {
    console.log(`--- receiver_id = ${receiverId} ---`);
    const subRow = (await supabase.from('subscriptions').select('id, email').eq('id', receiverId).maybeSingle()).data;
    console.log(`  In subscriptions? ${subRow ? `yes, email=${subRow.email || '(null)'}` : 'NO (id not in subscriptions)'}`);

    const { ids: myIds, reason } = await getSameEmailIds(receiverId);
    const myIdNorms = myIds.map(normId);
    console.log(`  getSameEmailIds: ${reason}, ids=[${myIds.join(', ')}], norms=[${myIdNorms.join(', ')}]`);

    const convsWhereParticipant = allConvIds.filter((cid) =>
      (participantsByConv[cid] || []).some((uid) => myIdNorms.includes(normId(uid)))
    );
    const receivedConvIds = [...new Set((allMessages || [])
      .filter((m) => m.receiver_id != null && myIdNorms.includes(normId(m.receiver_id)))
      .map((m) => m.conversation_id)
      .filter(Boolean))];

    console.log(`  Convs where receiver is PARTICIPANT: ${convsWhereParticipant.length}  ${convsWhereParticipant.join(', ') || '(none)'}`);
    console.log(`  Convs where receiver RECEIVED a message (receiver_id match): ${receivedConvIds.length}  ${receivedConvIds.join(', ') || '(none)'}`);

    const receiverNorm = normId(receiverId);
    const messageReceiverNorms = (allMessages || []).filter((m) => m.receiver_id != null).map((m) => normId(m.receiver_id));
    const match = messageReceiverNorms.includes(receiverNorm);
    console.log(`  Does any message have receiver_id (normalized) = ${receiverNorm}? ${match ? 'YES' : 'NO'} (message receiver norms sample: ${[...new Set(messageReceiverNorms)].slice(0, 5).join(', ')})`);

    const wouldGetConvs = [...new Set([...convsWhereParticipant, ...receivedConvIds])];
    console.log(`  => API would return convIds for this user: ${wouldGetConvs.length}  ${wouldGetConvs.join(', ') || '(none)'}`);
    if (wouldGetConvs.length === 0) {
      console.log(`  >>> PROBLEM: receiver gets 0 conversations. Likely: receiver_id in DB does not match their subscription id (e.g. they log in as different id), or not in participants and receivedConvIds empty.`);
    }
    console.log('');
  }

  console.log('=== PARTICIPANTS PER CONV (for reference) ===\n');
  Object.keys(participantsByConv).forEach((cid) => {
    console.log(`  ${cid}  ->  ${participantsByConv[cid].join(', ')}`);
  });

  console.log('\n=== SUBSCRIPTION IDS vs CHAT: who gets 0 convs? ===\n');
  const { data: subs } = await supabase.from('subscriptions').select('id, email');
  const inParticipants = new Set((allParts || []).map((p) => normId(p.user_id)));
  const inReceiverId = new Set((allMessages || []).filter((m) => m.receiver_id).map((m) => normId(m.receiver_id)));
  const inChat = (sid) => inParticipants.has(normId(sid)) || inReceiverId.has(normId(sid));

  (subs || []).forEach((s) => {
    const inP = inParticipants.has(normId(s.id));
    const inR = inReceiverId.has(normId(s.id));
    const getsConvs = inP || inR;
    if (!getsConvs) {
      console.log(`  NO CONVS if logged in as: ${s.id}  email=${s.email || ''}  (not in participants, not in receiver_id)`);
    }
  });
  console.log('\n  Receiver IDs in messages that are NOT in subscriptions table:');
  receiverIds.forEach((rid) => {
    const inSubs = (subs || []).some((s) => normId(s.id) === normId(rid));
    if (!inSubs) console.log(`    ${rid}  <- if app sends this id, backend finds conv. If app sends ANOTHER id (e.g. from subscriptions), that id may get 0 convs.`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
