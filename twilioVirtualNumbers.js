'use strict';

/**
 * Twilio virtual numbers: an advertiser's real phone (mobile / office) is fronted by a
 * Twilio number. Inbound calls hit the voice webhook, which looks up the assignment in
 * `virtual_numbers` and <Dial>s the real phone; status callbacks land in
 * `virtual_number_calls`. Schema: migration-twilio-virtual-numbers.sql.
 *
 * Env:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   required
 *   TWILIO_VOICE_ENABLED                    must be 1/true/on, otherwise everything is off
 *   TWILIO_WEBHOOK_BASE_URL                 public origin, e.g. https://pi-back.vercel.app
 *   TWILIO_NUMBER_COUNTRY                   default IL
 *   TWILIO_NUMBER_TYPE                      Local | Mobile | TollFree (default Local)
 *   TWILIO_ADDRESS_SID, TWILIO_BUNDLE_SID   regulatory requirements for buying IL numbers
 *   TWILIO_SKIP_SIGNATURE_CHECK             1 only for local testing
 */

const crypto = require('crypto');
const express = require('express');

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const WEBHOOK_PREFIX = '/api/twilio/voice';
const DIAL_TIMEOUT_SECONDS = 25;
const HEBREW_VOICE = 'Google.he-IL-Standard-A';

const NUMBER_TYPE_PATHS = { local: 'Local', mobile: 'Mobile', toll_free: 'TollFree' };

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function accountSid() {
  return String(process.env.TWILIO_ACCOUNT_SID || '').trim();
}

function authToken() {
  return String(process.env.TWILIO_AUTH_TOKEN || '').trim();
}

function isConfigured() {
  return Boolean(accountSid() && authToken());
}

function isEnabled() {
  return envFlag('TWILIO_VOICE_ENABLED') && isConfigured();
}

function webhookBaseUrl() {
  return String(process.env.TWILIO_WEBHOOK_BASE_URL || '').trim().replace(/\/+$/, '');
}

function webhookUrl(path) {
  const base = webhookBaseUrl();
  return base ? `${base}${WEBHOOK_PREFIX}${path}` : null;
}

function defaultNumberType() {
  const raw = String(process.env.TWILIO_NUMBER_TYPE || 'Local').trim().toLowerCase();
  if (raw === 'mobile') return 'mobile';
  if (raw === 'tollfree' || raw === 'toll_free') return 'toll_free';
  return 'local';
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** Israeli local / international input → E.164 (+972…). Returns null if unusable. */
function toE164(phone, defaultCountryCode = '972') {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith(defaultCountryCode)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${defaultCountryCode}${digits.slice(1)}`;
  return digits.length >= 8 ? `+${defaultCountryCode}${digits}` : null;
}

function phoneKindOf(phone) {
  const e164 = toE164(phone);
  return e164 && e164.startsWith('+9725') ? 'mobile' : 'office';
}

// ---------------------------------------------------------------------------
// Twilio REST
// ---------------------------------------------------------------------------

async function twilioFetch(path, { method = 'GET', params, query } = {}) {
  if (!isConfigured()) {
    const err = new Error('Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)');
    err.statusCode = 503;
    throw err;
  }
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `${TWILIO_API}/Accounts/${accountSid()}${path}${qs}`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString('base64')}`,
  };
  let body;
  if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== ''),
    ).toString();
  }
  const res = await fetch(url, { method, headers, body });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText || 'Twilio API error');
    err.statusCode = res.status;
    err.twilioCode = data && data.code;
    err.twilioResponse = data;
    throw err;
  }
  return data;
}

async function searchAvailableNumbers({ country, numberType, contains, limit = 10 } = {}) {
  const cc = String(country || process.env.TWILIO_NUMBER_COUNTRY || 'IL').trim().toUpperCase();
  const typePath = NUMBER_TYPE_PATHS[numberType || defaultNumberType()] || 'Local';
  const data = await twilioFetch(`/AvailablePhoneNumbers/${cc}/${typePath}.json`, {
    query: {
      VoiceEnabled: 'true',
      PageSize: String(limit),
      ...(contains ? { Contains: String(contains) } : {}),
    },
  });
  return (data && data.available_phone_numbers) || [];
}

function numberWebhookParams() {
  return {
    VoiceUrl: webhookUrl('/incoming'),
    VoiceMethod: 'POST',
    StatusCallback: webhookUrl('/status'),
    StatusCallbackMethod: 'POST',
  };
}

async function purchaseNumber(phoneNumberE164, { friendlyName } = {}) {
  if (!webhookBaseUrl()) {
    const err = new Error('TWILIO_WEBHOOK_BASE_URL is required before buying numbers');
    err.statusCode = 503;
    throw err;
  }
  return twilioFetch('/IncomingPhoneNumbers.json', {
    method: 'POST',
    params: {
      PhoneNumber: phoneNumberE164,
      FriendlyName: friendlyName || `pi-virtual ${phoneNumberE164}`,
      AddressSid: process.env.TWILIO_ADDRESS_SID,
      BundleSid: process.env.TWILIO_BUNDLE_SID,
      ...numberWebhookParams(),
    },
  });
}

/** Re-point an owned number at our webhooks (e.g. after the base URL changes). */
async function syncNumberWebhooks(twilioSid) {
  return twilioFetch(`/IncomingPhoneNumbers/${twilioSid}.json`, {
    method: 'POST',
    params: numberWebhookParams(),
  });
}

async function releaseNumberAtTwilio(twilioSid) {
  return twilioFetch(`/IncomingPhoneNumbers/${twilioSid}.json`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Webhook signature (X-Twilio-Signature)
// ---------------------------------------------------------------------------

function computeSignature(url, params) {
  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, key) => acc + key + (params[key] == null ? '' : String(params[key])), url);
  return crypto.createHmac('sha1', authToken()).update(Buffer.from(data, 'utf8')).digest('base64');
}

function isValidSignature(signature, url, params) {
  if (!signature || !url || !authToken()) return false;
  const expected = Buffer.from(computeSignature(url, params));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Twilio signs the public URL it called, so rebuild it from the configured base. */
function requireTwilioSignature(req, res, next) {
  if (envFlag('TWILIO_SKIP_SIGNATURE_CHECK')) return next();
  const base = webhookBaseUrl();
  const url = base ? `${base}${req.originalUrl}` : null;
  if (!isValidSignature(req.get('X-Twilio-Signature'), url, req.body)) {
    return res.status(403).type('text/plain').send('Invalid Twilio signature');
  }
  return next();
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function sayHebrew(text) {
  return `<Say language="he-IL" voice="${HEBREW_VOICE}">${xmlEscape(text)}</Say>`;
}

function forwardCallTwiml({ targetE164, callerIdE164 }) {
  const action = webhookUrl('/dial-complete');
  const attrs = [
    `timeout="${DIAL_TIMEOUT_SECONDS}"`,
    callerIdE164 ? `callerId="${xmlEscape(callerIdE164)}"` : '',
    action ? `action="${xmlEscape(action)}" method="POST"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return twiml(`<Dial ${attrs}><Number>${xmlEscape(targetE164)}</Number></Dial>`);
}

function unavailableTwiml() {
  return twiml(`${sayHebrew('המספר אינו זמין כרגע. נסו שוב מאוחר יותר.')}<Hangup/>`);
}

function noAnswerTwiml() {
  return twiml(`${sayHebrew('אין מענה כרגע. נסו שוב מאוחר יותר.')}<Hangup/>`);
}

// ---------------------------------------------------------------------------
// Database (expects a service-role Supabase client)
// ---------------------------------------------------------------------------

async function findAssignmentByVirtualNumber(supabase, virtualE164) {
  const { data, error } = await supabase
    .from('virtual_numbers')
    .select('id, phone_e164, subscription_id, phone_kind, target_phone_e164, status')
    .eq('phone_e164', virtualE164)
    .eq('status', 'assigned')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getAssignment(supabase, subscriptionId, phoneKind) {
  const { data, error } = await supabase
    .from('virtual_numbers')
    .select('id, phone_e164, phone_kind, target_phone_e164, status')
    .eq('subscription_id', subscriptionId)
    .eq('phone_kind', phoneKind)
    .eq('status', 'assigned')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Every active virtual number of an advertiser, keyed by phone kind. */
async function getAssignmentsForSubscription(supabase, subscriptionId) {
  const { data, error } = await supabase
    .from('virtual_numbers')
    .select('phone_e164, phone_kind')
    .eq('subscription_id', subscriptionId)
    .eq('status', 'assigned');
  if (error) throw error;
  return (data || []).reduce((acc, row) => ({ ...acc, [row.phone_kind]: row.phone_e164 }), {});
}

async function insertPoolNumber(supabase, purchased, numberType) {
  const { data, error } = await supabase
    .from('virtual_numbers')
    .insert({
      twilio_sid: purchased.sid,
      phone_e164: purchased.phone_number,
      number_type: numberType,
      status: 'available',
    })
    .select('id, phone_e164')
    .single();
  if (error) throw error;
  return data;
}

/** Buy a number from Twilio and park it in the pool as `available`. */
async function buyPoolNumber(supabase, { numberType, contains } = {}) {
  const type = numberType || defaultNumberType();
  const [candidate] = await searchAvailableNumbers({ numberType: type, contains, limit: 1 });
  if (!candidate) {
    const err = new Error('No Twilio numbers available for the requested country / type');
    err.statusCode = 409;
    throw err;
  }
  const purchased = await purchaseNumber(candidate.phone_number);
  return insertPoolNumber(supabase, purchased, type);
}

async function claimPoolNumber(supabase, fields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: free, error } = await supabase
      .from('virtual_numbers')
      .select('id')
      .eq('status', 'available')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!free) return null;
    // Conditional update guards against two requests grabbing the same row.
    const { data: claimed, error: claimError } = await supabase
      .from('virtual_numbers')
      .update({ ...fields, status: 'assigned', assigned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', free.id)
      .eq('status', 'available')
      .select('id, phone_e164, phone_kind, target_phone_e164')
      .maybeSingle();
    if (claimError) throw claimError;
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Give an advertiser phone a virtual number (idempotent). Reuses the existing
 * assignment, else claims a pool number, else buys one when `allowPurchase`.
 */
async function assignVirtualNumber(supabase, { subscriptionId, targetPhone, phoneKind, allowPurchase = false }) {
  const targetE164 = toE164(targetPhone);
  if (!subscriptionId || !targetE164) {
    const err = new Error('subscriptionId and a valid targetPhone are required');
    err.statusCode = 400;
    throw err;
  }
  const kind = phoneKind || phoneKindOf(targetE164);

  const existing = await getAssignment(supabase, subscriptionId, kind);
  if (existing) {
    if (existing.target_phone_e164 === targetE164) return existing;
    const { data, error } = await supabase
      .from('virtual_numbers')
      .update({ target_phone_e164: targetE164, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('id, phone_e164, phone_kind, target_phone_e164')
      .single();
    if (error) throw error;
    return data;
  }

  const fields = { subscription_id: subscriptionId, phone_kind: kind, target_phone_e164: targetE164 };
  let claimed = await claimPoolNumber(supabase, fields);
  if (!claimed && allowPurchase) {
    await buyPoolNumber(supabase);
    claimed = await claimPoolNumber(supabase, fields);
  }
  if (!claimed) {
    const err = new Error('No free virtual numbers in the pool');
    err.statusCode = 409;
    throw err;
  }
  return claimed;
}

/** Detach a number from its advertiser and return it to the pool (keeps the Twilio number). */
async function unassignVirtualNumber(supabase, { subscriptionId, phoneKind }) {
  const { error } = await supabase
    .from('virtual_numbers')
    .update({
      status: 'available',
      subscription_id: null,
      phone_kind: null,
      target_phone_e164: null,
      assigned_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('subscription_id', subscriptionId)
    .eq('phone_kind', phoneKind)
    .eq('status', 'assigned');
  if (error) throw error;
}

/** Give the number back to Twilio (stops billing) and mark the row released. */
async function releaseVirtualNumber(supabase, virtualNumberId) {
  const { data: row, error } = await supabase
    .from('virtual_numbers')
    .select('id, twilio_sid')
    .eq('id', virtualNumberId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return;
  await releaseNumberAtTwilio(row.twilio_sid);
  const { error: updateError } = await supabase
    .from('virtual_numbers')
    .update({
      status: 'released',
      subscription_id: null,
      phone_kind: null,
      target_phone_e164: null,
      released_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (updateError) throw updateError;
}

async function logCall(supabase, row) {
  if (!row.call_sid) return;
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  const { error } = await supabase
    .from('virtual_number_calls')
    .upsert({ ...clean, updated_at: new Date().toISOString() }, { onConflict: 'call_sid' });
  if (error) console.error('[twilio] call log failed', error.message);
}

// ---------------------------------------------------------------------------
// Webhook router (mount with: app.use(WEBHOOK_PREFIX, createVoiceWebhookRouter({ supabase })))
// ---------------------------------------------------------------------------

function createVoiceWebhookRouter({ supabase }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.post('/incoming', requireTwilioSignature, async (req, res) => {
    res.type('text/xml');
    if (!isEnabled()) return res.send(unavailableTwiml());
    const body = req.body || {};
    try {
      const assignment = await findAssignmentByVirtualNumber(supabase, body.To);
      if (!assignment || !assignment.target_phone_e164) {
        return res.send(unavailableTwiml());
      }
      await logCall(supabase, {
        call_sid: body.CallSid,
        virtual_number_id: assignment.id,
        subscription_id: assignment.subscription_id,
        phone_kind: assignment.phone_kind,
        from_e164: body.From || null,
        to_e164: body.To || null,
        forwarded_to_e164: assignment.target_phone_e164,
        status: body.CallStatus || 'ringing',
        started_at: new Date().toISOString(),
      });
      return res.send(
        forwardCallTwiml({ targetE164: assignment.target_phone_e164, callerIdE164: assignment.phone_e164 }),
      );
    } catch (err) {
      console.error('[twilio] incoming failed', err.message);
      return res.send(unavailableTwiml());
    }
  });

  router.post('/dial-complete', requireTwilioSignature, async (req, res) => {
    const body = req.body || {};
    await logCall(supabase, {
      call_sid: body.CallSid,
      dial_status: body.DialCallStatus || null,
      duration_seconds: body.DialCallDuration != null ? Number(body.DialCallDuration) : undefined,
    });
    const answered = body.DialCallStatus === 'completed';
    res.type('text/xml').send(answered ? twiml('<Hangup/>') : noAnswerTwiml());
  });

  router.post('/status', requireTwilioSignature, async (req, res) => {
    const body = req.body || {};
    const finished = ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(body.CallStatus);
    await logCall(supabase, {
      call_sid: body.CallSid,
      status: body.CallStatus || null,
      ended_at: finished ? new Date().toISOString() : undefined,
    });
    res.status(204).end();
  });

  return router;
}

module.exports = {
  WEBHOOK_PREFIX,
  isConfigured,
  isEnabled,
  toE164,
  phoneKindOf,
  searchAvailableNumbers,
  purchaseNumber,
  syncNumberWebhooks,
  releaseNumberAtTwilio,
  computeSignature,
  isValidSignature,
  requireTwilioSignature,
  forwardCallTwiml,
  unavailableTwiml,
  findAssignmentByVirtualNumber,
  getAssignmentsForSubscription,
  buyPoolNumber,
  assignVirtualNumber,
  unassignVirtualNumber,
  releaseVirtualNumber,
  logCall,
  createVoiceWebhookRouter,
};
