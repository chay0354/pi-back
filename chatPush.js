'use strict';

/**
 * Chat push notifications through the Expo push service (delivers to FCM on Android
 * and APNs on iOS). Tokens live in `push_tokens` (migration-push-tokens.sql).
 * Optional env: EXPO_ACCESS_TOKEN when "enhanced push security" is on in the Expo project.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SEND_TIMEOUT_MS = 5000;
const EXPO_BATCH_SIZE = 100;
const PREVIEW_MAX_CHARS = 140;
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

function normEmail(value) {
  return value != null ? String(value).trim().toLowerCase() : '';
}

function isExpoPushToken(token) {
  return EXPO_TOKEN_RE.test(String(token || '').trim());
}

async function registerPushToken(supabase, { token, email, subscriptionId, platform }) {
  const t = String(token || '').trim();
  const userEmail = normEmail(email);
  if (!isExpoPushToken(t) || !userEmail) {
    const err = new Error('valid token and email required');
    err.statusCode = 400;
    throw err;
  }
  const { error } = await supabase.from('push_tokens').upsert(
    {
      token: t,
      user_email: userEmail,
      subscription_id: subscriptionId || null,
      platform: platform ? String(platform).slice(0, 20) : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
  if (error) throw error;
}

async function unregisterPushToken(supabase, token) {
  const t = String(token || '').trim();
  if (!t) return;
  const { error } = await supabase.from('push_tokens').delete().eq('token', t);
  if (error) throw error;
}

function messagePreview({ body, mediaType, listingShare }) {
  if (listingShare) return 'שיתף/ה מודעה';
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text) {
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text;
  }
  switch (mediaType) {
    case 'image':
      return '📷 תמונה';
    case 'video':
      return '🎥 סרטון';
    case 'audio':
      return '🎤 הודעה קולית';
    case 'file':
      return '📎 קובץ';
    default:
      return 'הודעה חדשה';
  }
}

async function resolveSender(supabase, conversationId, senderEmail) {
  const { data: part } = await supabase
    .from('chat_participants')
    .select('display_name, profile_picture_url')
    .eq('conversation_id', conversationId)
    .eq('user_id', senderEmail)
    .maybeSingle();
  let name = part?.display_name ? String(part.display_name).trim() : '';
  let image = part?.profile_picture_url ? String(part.profile_picture_url).trim() : '';
  if (!name || !image) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('name, business_name, broker_office_name, contact_person_name, profile_picture_url')
      .ilike('email', senderEmail)
      .limit(1)
      .maybeSingle();
    if (sub) {
      name =
        name ||
        [sub.name, sub.business_name, sub.broker_office_name, sub.contact_person_name]
          .map(v => (v ? String(v).trim() : ''))
          .find(Boolean) ||
        '';
      image = image || (sub.profile_picture_url ? String(sub.profile_picture_url).trim() : '');
    }
  }
  return { name: name || 'הודעה חדשה', image: image || null };
}

async function postToExpo(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    };
    if (process.env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn('[chatPush] Expo push rejected', res.status, json?.errors || json);
      return [];
    }
    return Array.isArray(json?.data) ? json.data : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify every recipient device about a new chat message. Never throws — a push
 * failure must not fail the message send.
 */
async function notifyChatMessage(
  supabase,
  { conversationId, senderEmail, recipientEmails, body, mediaType, listingShare, isGroup },
) {
  try {
    const sender = normEmail(senderEmail);
    const recipients = [...new Set((recipientEmails || []).map(normEmail))].filter(
      e => e && e !== sender,
    );
    if (!conversationId || recipients.length === 0) return;

    const { data: rows, error } = await supabase
      .from('push_tokens')
      .select('token')
      .in('user_email', recipients);
    if (error || !rows || rows.length === 0) return;

    const from = await resolveSender(supabase, conversationId, sender);
    const preview = messagePreview({ body, mediaType, listingShare });

    let title = from.name;
    let text = preview;
    let openName = from.name;
    let openImage = from.image;
    if (isGroup) {
      const { data: conv } = await supabase
        .from('chat_conversations')
        .select('title, group_image_url')
        .eq('id', conversationId)
        .maybeSingle();
      title = (conv?.title && String(conv.title).trim()) || 'קבוצה';
      text = `${from.name}: ${preview}`;
      openName = title;
      openImage = conv?.group_image_url || null;
    }

    const data = {
      type: 'chat',
      conversationId: String(conversationId),
      isGroup: !!isGroup,
      otherUserEmail: isGroup ? null : sender,
      name: openName,
      profileImageUrl: openImage,
    };
    const tokens = rows.map(r => r.token).filter(isExpoPushToken);
    const messages = tokens.map(to => ({
      to,
      title,
      body: text,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'chat',
    }));

    const deadTokens = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
      const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
      const tickets = await postToExpo(batch);
      tickets.forEach((ticket, idx) => {
        if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(batch[idx].to);
        }
      });
    }
    if (deadTokens.length > 0) {
      await supabase.from('push_tokens').delete().in('token', deadTokens);
    }
  } catch (err) {
    console.warn('[chatPush] notify failed', err?.message || err);
  }
}

module.exports = {
  isExpoPushToken,
  registerPushToken,
  unregisterPushToken,
  messagePreview,
  notifyChatMessage,
};
