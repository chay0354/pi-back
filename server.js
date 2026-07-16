require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { Pool } = require('pg');
const { Resend } = require('resend');
const muxVideo = require('./muxVideo');

const B2B_SUBSCRIPTION_TYPES = new Set(['broker', 'company', 'professional']);
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_MONTHLY_LISTING_QUOTA = 65;
// Every account starts with 3 months of usage; coupons extend by 3/6/12 months.
const BASE_ACCESS_MONTHS = 3;
const ALLOWED_PROMO_BONUS_MONTHS = [3, 6, 12];

function normalizePromoCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Coupon time bonus, clamped to the supported tiers (3 / 6 / 12 months). */
function promoBonusMonths(promo) {
  const raw = Number(promo?.bonus_months);
  if (ALLOWED_PROMO_BONUS_MONTHS.includes(raw)) return raw;
  return ALLOWED_PROMO_BONUS_MONTHS[0];
}

function promoCodeIsCurrentlyValid(promo, now = new Date()) {
  if (!promo || !promo.is_active) return false;
  if (promo.valid_from) {
    const from = new Date(promo.valid_from);
    if (!Number.isNaN(from.getTime()) && from > now) return false;
  }
  if (promo.valid_until) {
    const until = new Date(promo.valid_until);
    if (!Number.isNaN(until.getTime()) && until < now) return false;
  }
  if (
    promo.max_redemptions != null &&
    Number(promo.redemption_count) >= Number(promo.max_redemptions)
  ) {
    return false;
  }
  return true;
}

async function findPromoCodeRow(codeNorm) {
  const { data: rows, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('is_active', true);
  if (error) throw error;
  return (rows || []).find((r) => normalizePromoCode(r.code) === codeNorm) || null;
}

async function applyPromoCodeToSubscription(subscriptionId, codeRaw) {
  const codeNorm = normalizePromoCode(codeRaw);
  if (!codeNorm) {
    const err = new Error('יש להזין קוד קופון');
    err.statusCode = 400;
    throw err;
  }

  const { data: subscription, error: subErr } = await supabase
    .from('subscriptions')
    .select('id, promo_code, max_published_listings, status, access_expires_at')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (subErr || !subscription) {
    const err = new Error('מנוי לא נמצא');
    err.statusCode = 404;
    throw err;
  }

  if (subscription.promo_code) {
    const err = new Error('כבר הופעל קופון לחשבון זה');
    err.statusCode = 400;
    throw err;
  }

  const promo = await findPromoCodeRow(codeNorm);
  if (!promo) {
    const err = new Error('קוד הקופון אינו תקף');
    err.statusCode = 404;
    throw err;
  }

  if (!promoCodeIsCurrentlyValid(promo)) {
    const err = new Error('קוד הקופון אינו פעיל או שפג תוקפו');
    err.statusCode = 400;
    throw err;
  }

  // Coupons extend the subscription period (base 3 months) by 3/6/12 months.
  // The 65-listing monthly quota stays untouched.
  const bonusMonths = promoBonusMonths(promo);
  const updates = {
    promo_code: normalizePromoCode(promo.code),
    promo_bonus_months: bonusMonths,
  };
  // Verified accounts already have an expiry — extend it now. Pending
  // registrations get the bonus folded in at verification time.
  if (subscription.access_expires_at) {
    updates.access_expires_at = addMonths(
      subscription.access_expires_at,
      bonusMonths,
    ).toISOString();
  }

  const { data: updated, error: updErr } = await supabase
    .from('subscriptions')
    .update(updates)
    .eq('id', subscriptionId)
    .select('*')
    .single();

  if (updErr) {
    console.error('[applyPromoCodeToSubscription]', updErr.message);
    const err = new Error(updErr.message || 'Failed to apply promo code');
    err.statusCode = 500;
    throw err;
  }

  const nextCount = (Number(promo.redemption_count) || 0) + 1;
  const { error: promoUpdErr } = await supabase
    .from('promo_codes')
    .update({ redemption_count: nextCount })
    .eq('id', promo.id);

  if (promoUpdErr) {
    console.warn('[applyPromoCodeToSubscription] redemption_count:', promoUpdErr.message);
  }

  return {
    subscription: updated,
    promoCode: normalizePromoCode(promo.code),
    bonusMonths,
    totalMonths: BASE_ACCESS_MONTHS + bonusMonths,
    accessExpiresAt: updated.access_expires_at || null,
    maxPublishedListings:
      Number(updated.max_published_listings) || DEFAULT_MONTHLY_LISTING_QUOTA,
  };
}

function isB2BSubscriptionType(type) {
  return B2B_SUBSCRIPTION_TYPES.has(String(type || '').trim().toLowerCase());
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const EMAIL_ALREADY_REGISTERED_HE =
  'כתובת המייל כבר רשומה במערכת. התחבר עם המייל הקיים או השתמש במייל אחר.';

function normalizeSubscriptionEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidSubscriptionEmail(emailNorm) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
}

/** First subscription row for an email (any type / status). */
async function findSubscriptionByEmail(email) {
  const emailNorm = normalizeSubscriptionEmail(email);
  if (!isValidSubscriptionEmail(emailNorm)) return null;
  const {data, error} = await supabase
    .from('subscriptions')
    .select('id, email, subscription_type, status')
    .ilike('email', emailNorm)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function assertEmailAvailableForRegistration(email) {
  const existing = await findSubscriptionByEmail(email);
  if (existing) {
    const err = new Error(EMAIL_ALREADY_REGISTERED_HE);
    err.statusCode = 409;
    err.code = 'EMAIL_ALREADY_EXISTS';
    throw err;
  }
}

function registrationEmailTakenResponse(res) {
  return res.status(409).json({
    success: false,
    error: EMAIL_ALREADY_REGISTERED_HE,
    code: 'EMAIL_ALREADY_EXISTS',
  });
}

function generateTemporaryPassword(length = 12) {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  if (out.length < MIN_PASSWORD_LENGTH) {
    return generateTemporaryPassword(MIN_PASSWORD_LENGTH);
  }
  return out;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
}

async function persistSubscriptionPasswordHash(subscriptionId, passwordRaw) {
  const pwd = String(passwordRaw || '');
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(
      `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
    );
    err.statusCode = 400;
    throw err;
  }
  const { error } = await supabase
    .from('subscriptions')
    .update({ password_hash: hashPassword(pwd) })
    .eq('id', subscriptionId);
  if (error) {
    console.error('[persistSubscriptionPasswordHash]', subscriptionId, error.message);
    const err = new Error(error.message || 'Failed to save password');
    err.statusCode = 500;
    throw err;
  }
}

/** Never expose password_hash or verification_code to clients. */
function sanitizeSubscriptionForClient(subscription) {
  if (!subscription || typeof subscription !== 'object') return subscription;
  const {
    password_hash: _ph,
    verification_code: _vc,
    ...safe
  } = subscription;
  return safe;
}

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Reflect the request Origin on every response (localhost:8081, 8084, production, etc.).
 * Vary: Origin avoids CDN/proxy serving one port's ACAO header to another (common on Vercel).
 */
function applyReflectCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  );
  const requestedHeaders = req.headers['access-control-request-headers'];
  res.setHeader(
    'Access-Control-Allow-Headers',
    requestedHeaders ||
      'Content-Type, Authorization, Accept, X-Requested-With',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private',
  );
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}

app.set('etag', false);

app.use(applyReflectCors);
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((err, req, res, next) => {
  if (err && err instanceof SyntaxError && 'body' in err) {
    console.error(`[JSON PARSE ERROR] ${req.method} ${req.originalUrl}`, {
      message: err.message,
      rawBodyPreview: String(req.rawBody || '').slice(0, 300),
    });
    return res.status(400).json({
      success: false,
      error:
        'Invalid JSON body. Send Content-Type: application/json with JSON.stringify payload (quoted keys and string values).',
    });
  }
  return next(err);
});

// Initialize Supabase client with longer timeout to reduce ConnectTimeoutError (e.g. 30s)
const FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS) || 30000;
const customFetch = (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: options.signal || controller.signal })
    .finally(() => clearTimeout(timeoutId));
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
// Support correct name and common typo (SUPABASE_SERVICCE_ROLE_KEY)
let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

// Check if service role key is set and not a placeholder
if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
  console.warn('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY not set or is a placeholder.');
  console.warn('⚠️  Using anon key as fallback. Some operations may fail.');
  console.warn('⚠️  Please set service_role key in .env from Supabase Dashboard > Settings > API');
  console.warn('⚠️  Broker search (/api/brokers/search) often returns empty with anon + RLS — use service role or set DATABASE_URL for direct Postgres.');
  supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
}

const supabase = createClient(supabaseUrl, supabaseKey, { global: { fetch: customFetch } });
const { buildAdRecordFromListingBody } = require('./listingAdRecord');

/** Direct Postgres for broker search when REST/RLS returns no rows (set DATABASE_URL from Supabase → Settings → Database). */
let brokerSearchPgPool = null;
let brokerSearchPgInited = false;
function getBrokerSearchPgPool() {
  if (brokerSearchPgInited) return brokerSearchPgPool;
  brokerSearchPgInited = true;
  const conn = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
  if (!conn || !String(conn).trim()) return null;
  try {
    brokerSearchPgPool = new Pool({
      connectionString: String(conn).trim(),
      max: 4,
      ssl: String(conn).includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
    });
    console.log('Broker search: DATABASE_URL set — using direct Postgres (bypasses PostgREST/RLS).');
  } catch (e) {
    console.error('Broker search: failed to create Postgres pool:', e.message);
    brokerSearchPgPool = null;
  }
  return brokerSearchPgPool;
}

// Initialize Resend for email sending (optional - can use other services)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Configure multer for file uploads (in-memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Helper function to send verification email
const sendVerificationEmail = async (email, verificationCode, subscriptionType) => {
  const typeNames = {
    broker: 'מתווכים',
    company: 'חברות',
    professional: 'בעלי מקצוע'
  };
  
  const typeName = typeNames[subscriptionType] || 'מנוי';
  
  // Try Resend first (if configured)
  if (resend) {
    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev', // Use Resend test domain if not configured
        to: email,
        subject: `קוד אימות - מנוי ${typeName}`,
        html: `
          <div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
            <h2>שלום,</h2>
            <p>תודה על הרשמתך למנוי ${typeName}.</p>
            <p>קוד האימות שלך הוא:</p>
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; margin: 20px 0; border-radius: 8px;">
              ${verificationCode}
            </div>
            <p>קוד זה תקף ל-15 דקות.</p>
            <p>אם לא ביקשת קוד זה, אנא התעלם מהמייל.</p>
            <p>בברכה,<br>צוות PI</p>
          </div>
        `,
      });
      console.log(`✅ Verification email sent to ${email} via Resend`);
      return true;
    } catch (error) {
      console.error('❌ Error sending email via Resend:', error);
      // Fall through to console log
    }
  }
  
  // Fallback: log to console (for development)
  console.log(`\n📧 === VERIFICATION EMAIL ===`);
  console.log(`To: ${email}`);
  console.log(`Subject: קוד אימות - מנוי ${typeName}`);
  console.log(`Code: ${verificationCode}`);
  console.log(`==========================\n`);
  return false;
};

/** Send login password after forgot-password (stored as hash only — email contains new password). */
const sendPasswordRecoveryEmail = async (email, passwordPlain, subscriptionType) => {
  const typeNames = { broker: 'מתווכים', company: 'חברות', professional: 'בעלי מקצוע' };
  const typeName = typeNames[subscriptionType] || 'מנוי';
  const safePassword = String(passwordPlain || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
      <h2>שלום,</h2>
      <p>ביקשת לקבל את הסיסמה לחשבון ${typeName} שלך ב-PI.</p>
      <p><strong>הסיסמה שלך לכניסה למערכת:</strong></p>
      <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 22px; font-weight: bold; margin: 20px 0; border-radius: 8px; letter-spacing: 1px;">
        ${safePassword}
      </div>
      <p>מומלץ להחליף סיסמה לאחר ההתחברות. אם לא ביקשת מייל זה, אנא התעלם ופנה לתמיכה.</p>
      <p>בברכה,<br>צוות PI</p>
    </div>
  `;
  if (resend) {
    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: email,
        subject: 'הסיסמה שלך – PI',
        html,
      });
      console.log(`✅ Password recovery email sent to ${email}`);
      return true;
    } catch (error) {
      console.error('❌ Error sending password recovery email:', error);
    }
  }
  console.log(
    `\n📧 === PASSWORD RECOVERY EMAIL ===\nTo: ${email}\nPassword: ${passwordPlain}\n==========================\n`,
  );
  return false;
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// ==================== AI SMART INFO (Gemini) ====================
function buildSmartInfoPrompt(topic, topicLabel, address) {
  const addr = (address && String(address).trim()) || '';
  const area = addr || 'ישראל';
  const label = (topicLabel && String(topicLabel).trim()) || (topic && String(topic)) || 'נושא';
  const topicKey = String(topic || '').trim().toLowerCase();

  if (topicKey === 'pests' || topicKey === 'nuisances') {
    return `You are a helpful real-estate assistant for Israel. Answer in Hebrew only, in 2-4 short sentences.
The user asks about "מטרדים" (environmental nuisances and disturbances) near: ${area}.
Describe realistic nuisances someone might experience when living there — for example: nearby construction or renovation, road/street works, heavy traffic noise, train or light-rail lines and stations, bus terminals, airports or flight paths, industrial/commercial noise, nightlife venues, garbage collection, or other urban disturbances.
Do NOT write about insects, pests, rodents, or bug infestations unless explicitly relevant to sanitation (prefer to skip entirely).
If you are unsure about a specific nuisance at this exact address, speak generally about what is typical for that city/neighborhood type and note uncertainty briefly.
No preamble.`;
  }

  return `You are a helpful real-estate assistant. Answer in Hebrew only, in 2-4 short sentences.
Question: What can you tell me about "${label}" (${topic || label}) for the address/area: ${area}?
Give practical, factual info relevant to someone considering a property there. No preamble.`;
}

// POST /api/ai/smart-info - body: { topic, topicLabel, address }
// Returns short Hebrew answer about the topic for the given address.
app.post('/api/ai/smart-info', async (req, res) => {
  try {
    const { topic, topicLabel, address } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, error: 'AI not configured', text: 'שירות המידע החכם לא מוגדר.' });
    }
    const prompt = buildSmartInfoPrompt(topic, topicLabel, address);
    // Use 2.5-flash-lite for better free-tier quota (15 RPM, 1000 RPD); fallback to 2.5-flash
    const modelsToTry = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastError = null;
    let response = null;
    let triedUrl = '';
    for (const model of modelsToTry) {
      triedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      response = await fetch(triedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0.4 }
        })
      });
      if (response.ok) break;
      lastError = await response.text();
      if (response.status === 429) break; // quota - don't hammer other models
      if (response.status === 404) continue; // try next model
      break;
    }
    if (!response.ok) {
      const errText = lastError != null ? lastError : (await response.text());
      console.error('Gemini API error:', response.status, errText);
      if (response.status === 429) {
        return res.status(429).json({
          success: false,
          error: 'quota_exceeded',
          text: 'המכסה היומית של שירות המידע החכם הותשתה. נסה שוב מחר או בדוק את המכסות ב-Google AI Studio.'
        });
      }
      if (response.status === 404) {
        return res.status(502).json({ success: false, error: 'model_not_found', text: 'מודל AI לא זמין. נסה שוב מאוחר יותר.' });
      }
      return res.status(502).json({ success: false, error: 'AI request failed', text: 'לא ניתן לקבל מידע כרגע. נסה שוב מאוחר יותר.' });
    }
    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const text = (textPart && String(textPart).trim()) || 'לא התקבל מידע.';
    return res.json({ success: true, text });
  } catch (err) {
    console.error('POST /api/ai/smart-info:', err);
    return res.status(500).json({ success: false, error: err.message, text: 'שגיאה בקבלת מידע. נסה שוב.' });
  }
});

// ==================== PI AI SEARCH (Gemini) ====================
// POST /api/ai/pi-search - body: { query, listings: [{ id, ...compact fields }] }
// Gemini ranks the candidate listings against the free-text (Hebrew) query and
// returns { success, ids } — listing ids ordered best-match first. The client
// keeps its keyword ranking as a fallback when this endpoint is unavailable.
app.post('/api/ai/pi-search', async (req, res) => {
  try {
    const { query, listings } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, error: 'AI not configured' });
    }
    const q = (query && String(query).trim()) || '';
    if (!q) {
      return res.status(400).json({ success: false, error: 'missing query' });
    }
    const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));
    // Whitelist + clip fields server-side so the prompt stays small and safe.
    const pool = (Array.isArray(listings) ? listings : [])
      .filter(l => l && l.id != null)
      .slice(0, 150)
      .map(l => {
        const item = { id: clip(l.id, 48) };
        const put = (key, max) => {
          const s = clip(l[key], max).trim();
          if (s) item[key] = s;
        };
        put('purpose', 30);
        put('category', 10);
        put('property_type', 40);
        put('apartment_type', 40);
        put('address', 120);
        put('project_name', 80);
        put('price', 20);
        put('budget', 20);
        put('rooms', 10);
        put('area', 12);
        put('floor', 10);
        put('description', 240);
        return item;
      });
    if (!pool.length) {
      return res.json({ success: true, ids: [] });
    }

    const prompt = `You are Pi AI, the search engine of an Israeli real-estate listings app. User queries are usually in Hebrew.

USER QUERY: "${q.slice(0, 300)}"

CANDIDATE LISTINGS (JSON array, each object has an "id" plus property fields; prices in ILS):
${JSON.stringify(pool)}

Task: pick the listings that genuinely match the query and order them best-match first.
Rules:
- Understand Hebrew synonyms and morphology (דירה/דירות, להשכרה/שכירות/לשכור, למכירה/לקנות, צימר/לינה, משרד, מגרש/קרקע, שותף/שותפים, פנטהאוז, דירת גן...).
- purpose "rent" = להשכרה, "sale" = למכירה. If the query clearly implies one, exclude the other.
- Location: if the query names a city/neighborhood/street, prefer matching addresses and exclude clearly different cities. Recognize spelling variants (תל אביב/ת"א).
- Numeric constraints: price/budget within roughly ±20% of what the query asks, rooms/area/floor respected when specified ("עד 2 מיליון" means a maximum).
- Prefer strong matches; include weaker partial matches only when fewer than 3 strong ones exist. Never include clearly irrelevant listings.
- Return at most 20 ids. If nothing reasonably matches, return an empty array.

Output strict JSON only, exactly in this format: {"ids": ["id1", "id2"]}`;

    const modelsToTry = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastError = null;
    let response = null;
    for (const model of modelsToTry) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      });
      if (response.ok) break;
      lastError = await response.text();
      if (response.status === 429) break; // quota - don't hammer other models
      if (response.status === 404) continue; // try next model
      break;
    }
    if (!response.ok) {
      console.error('Gemini pi-search error:', response.status, lastError);
      const status = response.status === 429 ? 429 : 502;
      return res.status(status).json({
        success: false,
        error: response.status === 429 ? 'quota_exceeded' : 'AI request failed'
      });
    }
    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    let ids = [];
    try {
      const cleaned = String(textPart || '')
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed?.ids)) {
        ids = parsed.ids;
      } else if (Array.isArray(parsed)) {
        ids = parsed;
      }
    } catch (parseErr) {
      console.error('Gemini pi-search: unparseable response:', textPart);
      return res.status(502).json({ success: false, error: 'AI returned invalid response' });
    }
    const validIds = new Set(pool.map(l => String(l.id)));
    const seen = new Set();
    const ranked = [];
    for (const id of ids) {
      const key = String(id);
      if (!validIds.has(key) || seen.has(key)) continue;
      seen.add(key);
      ranked.push(key);
      if (ranked.length >= 20) break;
    }
    return res.json({ success: true, ids: ranked });
  } catch (err) {
    console.error('POST /api/ai/pi-search:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== DISTANCE (Gemini) ====================
async function callGeminiJsonPrompt(prompt, maxOutputTokens = 512) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: 'AI not configured' };
  }
  const modelsToTry = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastError = null;
  let response = null;
  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (response.ok) break;
    lastError = await response.text();
    if (response.status === 429) break;
    if (response.status === 404) continue;
    break;
  }
  if (!response?.ok) {
    return {
      ok: false,
      status: response?.status === 429 ? 429 : 502,
      error: response?.status === 429 ? 'quota_exceeded' : 'AI request failed',
      detail: lastError,
    };
  }
  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return { ok: true, textPart: String(textPart || '').trim() };
}

function parseGeminiJsonText(textPart) {
  const cleaned = String(textPart || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

function normalizeDistanceKm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

async function geocodeAddressForDistance(address) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  let url;
  if (parts.length >= 2) {
    const city = parts[parts.length - 1];
    const streetPart = parts
      .slice(0, -1)
      .join(', ')
      .replace(/^רחוב\s+/u, '')
      .replace(/^שדרות\s+/u, '')
      .trim();
    const houseMatch = streetPart.match(/(\d+)/u);
    const houseNum = houseMatch ? houseMatch[1] : null;
    const streetName = streetPart.replace(/\d+/gu, '').trim();
    if (streetName && city && houseNum) {
      const params = new URLSearchParams({
        format: 'json',
        limit: '1',
        street: `${houseNum} ${streetName}`,
        city,
        country: 'Israel',
      });
      url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    }
  }
  if (!url) {
    const q = /israel/i.test(raw) || raw.includes('ישראל') ? raw : `${raw}, Israel`;
    url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  }
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Pi2701App/1.0 (real-estate; contact@pi2701.com)',
      'Accept-Language': 'he,en',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  const latitude = Number(first?.lat);
  const longitude = Number(first?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function haversineDistanceKmServer(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h =
    s1 * s1 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return normalizeDistanceKm(6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

async function measureDistanceWithGeminiCoords(origin, destinationCoords, destinationAddress) {
  const lat = Number(origin?.latitude);
  const lon = Number(origin?.longitude);
  const destLat = Number(destinationCoords?.latitude);
  const destLon = Number(destinationCoords?.longitude);
  const dest = String(destinationAddress || '').trim();

  const prompt = `You are a precise geographic calculator.
Point A (user phone GPS in Israel): latitude ${lat}, longitude ${lon}
Point B (property "${dest.slice(0, 120)}"): latitude ${destLat}, longitude ${destLon}

Calculate ONLY the straight-line great-circle distance in kilometers between A and B (NOT driving distance).
Round to one decimal place.

Output strict JSON only: {"distanceKm": number}`;

  const gemini = await callGeminiJsonPrompt(prompt, 128);
  if (!gemini.ok) {
    return {
      ok: false,
      status: gemini.status || 502,
      error: gemini.error || 'AI request failed',
    };
  }
  try {
    const parsed = parseGeminiJsonText(gemini.textPart);
    const distanceKm = normalizeDistanceKm(parsed?.distanceKm);
    if (distanceKm == null) {
      return { ok: false, status: 502, error: 'AI returned invalid distance' };
    }
    return { ok: true, distanceKm, destinationCoords };
  } catch (parseErr) {
    console.error('Gemini distance: unparseable response:', gemini.textPart);
    return { ok: false, status: 502, error: 'AI returned invalid response' };
  }
}

// POST /api/ai/distance - body: { origin: { latitude, longitude }, destinationAddress }
app.post('/api/ai/distance', async (req, res) => {
  try {
    const { origin, destinationAddress } = req.body || {};
    const lat = Number(origin?.latitude);
    const lon = Number(origin?.longitude);
    const dest = String(destinationAddress || '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !dest) {
      return res.status(400).json({
        success: false,
        error: 'missing origin or destinationAddress',
      });
    }

    const destinationCoords = await geocodeAddressForDistance(dest);
    if (!destinationCoords) {
      return res.status(502).json({
        success: false,
        error: 'Could not geocode destination address',
      });
    }

    const measured = await measureDistanceWithGeminiCoords(
      { latitude: lat, longitude: lon },
      destinationCoords,
      dest,
    );
    if (!measured.ok) {
      const fallbackKm = haversineDistanceKmServer(
        { latitude: lat, longitude: lon },
        destinationCoords,
      );
      if (fallbackKm != null) {
        return res.json({
          success: true,
          distanceKm: fallbackKm,
          origin: { latitude: lat, longitude: lon },
          destinationAddress: dest,
          destinationCoords,
          source: 'haversine_fallback',
        });
      }
      return res.status(measured.status || 502).json({
        success: false,
        error: measured.error || 'AI request failed',
      });
    }

    return res.json({
      success: true,
      distanceKm: measured.distanceKm,
      origin: { latitude: lat, longitude: lon },
      destinationAddress: dest,
      destinationCoords: measured.destinationCoords,
      source: 'gemini',
    });
  } catch (err) {
    console.error('POST /api/ai/distance:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/ai/distance-batch - body: { origin, destinations: [{ key, address }] }
app.post('/api/ai/distance-batch', async (req, res) => {
  try {
    const { origin, destinations } = req.body || {};
    const lat = Number(origin?.latitude);
    const lon = Number(origin?.longitude);
    const destList = (Array.isArray(destinations) ? destinations : [])
      .map(d => ({
        key: String(d?.key || '').trim(),
        address: String(d?.address || '').trim(),
      }))
      .filter(d => d.key && d.address)
      .slice(0, 40);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !destList.length) {
      return res.status(400).json({
        success: false,
        error: 'missing origin or destinations',
      });
    }

    const resolved = [];
    for (const item of destList) {
      const coords = await geocodeAddressForDistance(item.address);
      if (coords) {
        resolved.push({ ...item, latitude: coords.latitude, longitude: coords.longitude });
      }
    }

    if (!resolved.length) {
      return res.status(502).json({ success: false, error: 'Could not geocode destinations' });
    }

    const prompt = `You are a precise geographic calculator.
Origin phone GPS in Israel: latitude ${lat}, longitude ${lon}

For each destination below, calculate ONLY the straight-line great-circle distance in kilometers from the origin to that destination (NOT driving distance). Round each to one decimal.

DESTINATIONS (JSON with coordinates):
${JSON.stringify(
  resolved.map(r => ({
    key: r.key,
    address: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
  })),
)}

Output strict JSON only:
{"distances":[{"key":"same key as input","distanceKm": number}]}`;

    const gemini = await callGeminiJsonPrompt(prompt, 2048);
    const out = {};
    if (gemini.ok) {
      try {
        const parsed = parseGeminiJsonText(gemini.textPart);
        for (const row of Array.isArray(parsed?.distances) ? parsed.distances : []) {
          const key = String(row?.key || '').trim();
          const km = normalizeDistanceKm(row?.distanceKm);
          if (key && km != null) out[key] = km;
        }
      } catch (parseErr) {
        console.error('Gemini distance-batch: unparseable response:', gemini.textPart);
      }
    }

    for (const item of resolved) {
      if (out[item.key] != null) continue;
      const fallbackKm = haversineDistanceKmServer(
        { latitude: lat, longitude: lon },
        { latitude: item.latitude, longitude: item.longitude },
      );
      if (fallbackKm != null) out[item.key] = fallbackKm;
    }

    return res.json({
      success: true,
      distances: out,
      origin: { latitude: lat, longitude: lon },
      source: gemini.ok ? 'gemini' : 'haversine_fallback',
    });
  } catch (err) {
    console.error('POST /api/ai/distance-batch:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Test-only skip verify. Enabled by default; set ALLOW_SKIP_EMAIL_VERIFICATION=0 to disable.
 */
function allowSkipEmailVerificationTest() {
  const v = String(process.env.ALLOW_SKIP_EMAIL_VERIFICATION || '')
    .trim()
    .toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') {
    return false;
  }
  return true;
}

/** Assign subscriber number and mark subscription verified (shared by /verify and test skip). */
async function finalizeSubscriptionVerification(subscription) {
  const { data: fresh, error: freshErr } = await supabase
    .from('subscriptions')
    .select('id, subscription_type, password_hash, promo_bonus_months, access_expires_at')
    .eq('id', subscription.id)
    .single();
  if (freshErr || !fresh) {
    const err = new Error('Subscription not found');
    err.statusCode = 404;
    throw err;
  }
  if (
    isB2BSubscriptionType(fresh.subscription_type) &&
    !fresh.password_hash
  ) {
    const err = new Error('יש להגדיר סיסמה לפני אימות המייל');
    err.statusCode = 400;
    throw err;
  }

  let subscriberNumber;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    subscriberNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('subscriber_number', subscriberNumber)
      .single();

    if (!existing) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    subscriberNumber = (Date.now() % 900000000 + 100000000).toString();
    console.warn(
      'Could not generate unique subscriber number, using timestamp-based:',
      subscriberNumber,
    );
  }

  console.log('Generated subscriber number:', subscriberNumber);

  // Access window: base 3 months from verification + any coupon bonus
  // (3/6/12 months) redeemed during registration.
  const verifiedAt = new Date();
  const totalAccessMonths =
    BASE_ACCESS_MONTHS + (Number(fresh.promo_bonus_months) || 0);

  const { data: updatedSubscription, error: updateError } = await supabase
    .from('subscriptions')
    .update({
      status: 'verified',
      subscriber_number: subscriberNumber,
      verified_at: verifiedAt.toISOString(),
      access_expires_at:
        fresh.access_expires_at ||
        addMonths(verifiedAt, totalAccessMonths).toISOString(),
    })
    .eq('id', subscription.id)
    .select()
    .single();

  if (updateError) {
    const err = new Error('Failed to verify subscription');
    err.statusCode = 500;
    throw err;
  }

  return { updatedSubscription, subscriberNumber };
}

// ==================== SUBSCRIPTION ENDPOINTS ====================

const subscriptionSubmitUpload = upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'additionalImages', maxCount: 10 },
  { name: 'companyLogo', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]);

/** JSON submits skip multer (Android app sends application/json when there are no file parts). */
function subscriptionSubmitParser(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    return next();
  }
  if (ct.includes('multipart/form-data')) {
    return subscriptionSubmitUpload(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message || 'Invalid multipart upload',
        });
      }
      return next();
    });
  }
  return next();
}

// Submit subscription form (all types: broker, company, professional)
app.post('/api/subscription/submit', subscriptionSubmitParser, async (req, res) => {
  try {
    const {
      subscriptionType, // 'broker', 'company', 'professional'
      email,
      phone,
      name,
      businessName,
      businessAddress,
      brokerageLicenseNumber, // For broker subscriptions
      brokerOfficeName, // For broker subscriptions
      agentName, // For broker subscriptions
      dealerNumber,
      companyId,
      contactPersonName,
      officePhone,
      mobilePhone,
      companyWebsite,
      description,
      types, // Array of selected types (for professional)
      specializations, // Array of selected specializations (for professional)
      activityRegions, // Array of selected regions (for broker)
      agreedToTerms,
      profile_picture_url, // Optional: URL from stage-1 upload (profile-pics bucket)
      company_logo_url, // Optional: pre-uploaded logo URL (saved as-is to company_logo_url column for all 3 subscription types)
      video_url, // Optional: pre-uploaded intro video URL (Android JSON submit)
      deferVerificationEmail, // When true, email is sent only from POST /api/subscription/resend-code
    } = req.body;

    // Validate required fields based on subscription type
    if (subscriptionType === 'company') {
      if (!businessName || !contactPersonName || !email || !officePhone) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields for company subscription (businessName, contactPersonName, email, officePhone)' 
        });
      }
    } else if (subscriptionType === 'broker') {
      // For broker: email, phone, name (agentName), brokerageLicenseNumber, brokerOfficeName are required
      if (!email || !phone || !name || !brokerageLicenseNumber || !brokerOfficeName) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields for broker subscription. Please provide email, phone, agent name, brokerage license number, and broker office name.' 
        });
      }
    } else {
      // For professional: email, phone, and name (or businessName) are required
      if (!email || !phone || (!name && !businessName)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields. Please provide email, phone, and name/business name.' 
        });
      }
    }

    const emailNorm = normalizeSubscriptionEmail(email);
    if (!isValidSubscriptionEmail(emailNorm)) {
      return res.status(400).json({
        success: false,
        error: 'כתובת מייל לא תקינה',
      });
    }

    try {
      await assertEmailAvailableForRegistration(emailNorm);
    } catch (emailErr) {
      if (emailErr.statusCode === 409) {
        return registrationEmailTakenResponse(res);
      }
      throw emailErr;
    }

    // Upload files to Supabase Storage (or use profile_picture_url if already uploaded at stage 1)
    const fileUrls = {};
    if (profile_picture_url && typeof profile_picture_url === 'string' && profile_picture_url.trim()) {
      fileUrls.profilePicture = profile_picture_url.trim();
    }
    if (company_logo_url && typeof company_logo_url === 'string' && company_logo_url.trim()) {
      fileUrls.companyLogo = company_logo_url.trim();
    }
    if (video_url && typeof video_url === 'string' && video_url.trim()) {
      fileUrls.video = video_url.trim();
    }
    if (req.files) {
      // Upload profile picture only if not already provided (e.g. uploaded when moving stage 1 → 2)
      if (!fileUrls.profilePicture && req.files.profilePicture && req.files.profilePicture[0]) {
        const profileFile = req.files.profilePicture[0];
        const safeName = (profileFile.originalname || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'photo';
        const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '.jpg';
        const fileName = `profile-${Date.now()}${ext}`;
        const { data, error } = await supabase.storage
          .from('profile-pics')
          .upload(fileName, profileFile.buffer, {
            contentType: profileFile.mimetype,
            upsert: false
          });
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('profile-pics')
            .getPublicUrl(fileName);
          fileUrls.profilePicture = urlData.publicUrl;
        } else if (error) {
          console.error('Profile picture upload to profile-pics failed:', error.message, '- Ensure bucket "profile-pics" exists in Supabase Storage.');
        }
      }

      // Upload additional images
      if (req.files.additionalImages) {
        fileUrls.additionalImages = [];
        for (const file of req.files.additionalImages) {
          const fileName = `additional-${Date.now()}-${file.originalname}`;
          const { data, error } = await supabase.storage
            .from('user-pohto-video')
            .upload(`additional/${fileName}`, file.buffer, {
              contentType: file.mimetype,
              upsert: false
            });
          
          if (!error && data) {
            const { data: urlData } = supabase.storage
              .from('user-pohto-video')
              .getPublicUrl(`additional/${fileName}`);
            fileUrls.additionalImages.push(urlData.publicUrl);
          }
        }
      }

      // Upload company logo (applies to all 3 subscription types: company, broker, professional).
      // Saved URL is stored in the `company_logo_url` column below.
      if (!fileUrls.companyLogo && req.files.companyLogo && req.files.companyLogo[0]) {
        const logoFile = req.files.companyLogo[0];
        const fileName = `logo-${Date.now()}-${logoFile.originalname}`;
        const { data, error } = await supabase.storage
          .from('user-pohto-video')
          .upload(`logos/${fileName}`, logoFile.buffer, {
            contentType: logoFile.mimetype,
            upsert: false
          });
        
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('user-pohto-video')
            .getPublicUrl(`logos/${fileName}`);
          fileUrls.companyLogo = urlData.publicUrl;
        }
      }

      // Upload profile intro video (profile-vids; fallback to user-pohto-video if bucket missing)
      if (req.files.video && req.files.video[0]) {
        const videoFile = req.files.video[0];
        const safeVideoName = (videoFile.originalname || 'video.mp4')
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/^_+|_+$/g, '') || 'video.mp4';
        const fileName = `video-${Date.now()}-${safeVideoName}`;
        const objectPath = `profile-videos/${fileName}`;
        let bucket = 'profile-vids';
        let { data, error } = await supabase.storage
          .from(bucket)
          .upload(objectPath, videoFile.buffer, {
            contentType: videoFile.mimetype || 'video/mp4',
            upsert: false,
          });

        if (error) {
          console.warn(
            '[subscription] profile-vids upload failed, trying user-pohto-video:',
            error.message,
          );
          bucket = 'user-pohto-video';
          const fallbackPath = `profile-videos/${fileName}`;
          const r2 = await supabase.storage
            .from(bucket)
            .upload(fallbackPath, videoFile.buffer, {
              contentType: videoFile.mimetype || 'video/mp4',
              upsert: false,
            });
          data = r2.data;
          error = r2.error;
          if (!error && data) {
            const { data: urlData } = supabase.storage
              .from(bucket)
              .getPublicUrl(fallbackPath);
            fileUrls.video = urlData.publicUrl;
          } else if (error) {
            console.error(
              'Profile video upload failed (profile-vids and fallback):',
              error.message,
            );
          }
        } else if (data) {
          const { data: urlData } = supabase.storage
            .from(bucket)
            .getPublicUrl(objectPath);
          fileUrls.video = urlData.publicUrl;
        }
      }
    }

    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save subscription data to database
    // Ensure subscription_type is preserved correctly for all 3 flows: broker, company, professional
    const subscriptionData = {
      subscription_type: subscriptionType, // 'broker', 'company', or 'professional' - PRESERVED
      email: emailNorm,
      phone: phone || officePhone,
      name: name || agentName || businessName || contactPersonName, // Use name, agentName, businessName, or contactPersonName
      business_name: businessName || brokerOfficeName, // For broker: brokerOfficeName, for others: businessName
      business_address: businessAddress,
      brokerage_license_number: brokerageLicenseNumber || null, // For broker subscriptions
      broker_office_name: brokerOfficeName || null, // For broker subscriptions
      dealer_number: dealerNumber,
      company_id: companyId,
      contact_person_name: contactPersonName,
      office_phone: officePhone,
      mobile_phone: mobilePhone,
      company_website: companyWebsite,
      description,
      types: types ? (Array.isArray(types) ? JSON.stringify(types) : types) : null, // For professional
      specializations: specializations ? (Array.isArray(specializations) ? JSON.stringify(specializations) : specializations) : null, // For professional
      activity_regions: activityRegions ? (Array.isArray(activityRegions) ? JSON.stringify(activityRegions) : activityRegions) : null, // For broker
      profile_picture_url: fileUrls.profilePicture || null,
      additional_images_urls: fileUrls.additionalImages ? JSON.stringify(fileUrls.additionalImages) : null,
      company_logo_url: fileUrls.companyLogo || null,
      video_url: fileUrls.video || null,
      verification_code: verificationCode,
      verification_code_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes from now (UTC)
      agreed_to_terms: agreedToTerms || false,
      status: 'pending_verification',
      max_published_listings: DEFAULT_MONTHLY_LISTING_QUOTA,
      created_at: new Date().toISOString()
    };

    const { data: subscription, error: dbError } = await supabase
      .from('subscriptions')
      .insert([subscriptionData])
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save subscription data',
        details: dbError.message 
      });
    }

    const submitPassword = req.body?.password != null ? String(req.body.password) : '';
    if (isB2BSubscriptionType(subscriptionType) && submitPassword.length >= MIN_PASSWORD_LENGTH) {
      try {
        await persistSubscriptionPasswordHash(subscription.id, submitPassword);
      } catch (pwdErr) {
        console.error('[subscription/submit] password save failed:', pwdErr.message);
        return res.status(pwdErr.statusCode || 500).json({
          success: false,
          error: pwdErr.message || 'Failed to save password',
        });
      }
    }

    const shouldDeferEmail =
      deferVerificationEmail === true ||
      deferVerificationEmail === 'true' ||
      deferVerificationEmail === 1 ||
      deferVerificationEmail === '1';

    if (!shouldDeferEmail) {
      await sendVerificationEmail(emailNorm, verificationCode, subscriptionType);
    }

    if (subscription.video_url && muxVideo.isVideoUrl(subscription.video_url)) {
      muxVideo.scheduleVideoProcessing(
        supabase,
        'subscription',
        subscription.id,
        subscription.video_url,
      );
    }

    res.json({
      success: true,
      subscriptionId: subscription.id,
      verificationCode: verificationCode, // Remove in production
      verificationEmailDeferred: shouldDeferEmail,
      message: shouldDeferEmail
        ? 'Subscription saved. Set a password and tap send verification code to receive the email.'
        : 'Subscription submitted. Verification code sent by email.',
    });

  } catch (error) {
    console.error('Error submitting subscription:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Verify email with code
app.post('/api/subscription/verify', async (req, res) => {
  try {
    const { email, verificationCode, subscriptionId, password: passwordRaw } =
      req.body;

    if (!verificationCode) {
      return res.status(400).json({ 
        success: false, 
        error: 'Verification code is required' 
      });
    }

    if (!email && !subscriptionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscription ID is required' 
      });
    }

    // Find subscription by ID (preferred) or email and verification code
    let query = supabase
      .from('subscriptions')
      .select('*');
    
    if (subscriptionId) {
      query = query.eq('id', subscriptionId);
    } else {
      query = query.eq('email', email);
    }
    
    query = query
      .eq('verification_code', verificationCode)
      .eq('status', 'pending_verification');
    
    const { data: subscription, error } = await query.maybeSingle();

    if (error || !subscription) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid verification code' 
      });
    }

    if (
      isB2BSubscriptionType(subscription.subscription_type) &&
      !subscription.password_hash
    ) {
      const pwd = String(passwordRaw || '');
      if (pwd.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          success: false,
          error: 'יש להגדיר סיסמה לפני אימות המייל',
        });
      }
      try {
        await persistSubscriptionPasswordHash(subscription.id, pwd);
        subscription.password_hash = 'set';
      } catch (pwdErr) {
        return res.status(pwdErr.statusCode || 500).json({
          success: false,
          error: pwdErr.message || 'Failed to save password',
        });
      }
    }

    // Check if code is expired
    if (!subscription.verification_code_expires_at) {
      console.warn('No expiration date found for subscription:', subscription.id);
      // If no expiration date, allow verification (for backward compatibility)
    } else {
      // Parse expiration date - handle timezone issues
      // Supabase TIMESTAMP columns store dates in UTC, but may return them without 'Z'
      let expiresAt;
      const rawExpiresAt = subscription.verification_code_expires_at;
      
      if (typeof rawExpiresAt === 'string') {
        // If it already has timezone info, parse directly
        if (rawExpiresAt.endsWith('Z') || rawExpiresAt.includes('+') || rawExpiresAt.match(/-\d{2}:\d{2}$/)) {
          expiresAt = new Date(rawExpiresAt);
        } else {
          // Date without timezone - Supabase stores TIMESTAMP as UTC, so append 'Z' to treat as UTC
          // Handle both formats: '2026-01-29T13:36:46.32' and '2026-01-29T13:36:46'
          const dateStr = rawExpiresAt.includes('.') ? rawExpiresAt : rawExpiresAt + '.000';
          expiresAt = new Date(dateStr + 'Z');
        }
      } else {
        expiresAt = new Date(rawExpiresAt);
      }
      
      // Validate the parsed date
      if (isNaN(expiresAt.getTime())) {
        console.error('Invalid expiration date:', rawExpiresAt);
        // If we can't parse it, allow verification (better UX than blocking)
        expiresAt = new Date(Date.now() + 15 * 60 * 1000); // Set to 15 min from now
      }
      
      const now = new Date();
      
      // Add logging for debugging
      const timeUntilExpiry = expiresAt - now;
      const minutesUntilExpiry = Math.round(timeUntilExpiry / 1000 / 60);
      
      console.log('Verification code expiration check:', {
        subscriptionId: subscription.id,
        email: subscription.email,
        expiresAt: expiresAt.toISOString(),
        now: now.toISOString(),
        expiresInMinutes: minutesUntilExpiry,
        isExpired: expiresAt < now,
        rawExpiresAt: rawExpiresAt,
        rawType: typeof rawExpiresAt
      });
      
      // Check if expired
      // Note: We check if expiresAt is less than now (code has expired)
      if (expiresAt < now) {
        console.warn('Code expired:', {
          expiresAt: expiresAt.toISOString(),
          now: now.toISOString(),
          differenceMinutes: minutesUntilExpiry
        });
        return res.status(400).json({ 
          success: false, 
          error: `Verification code has expired. Please request a new code. (Expired ${Math.abs(minutesUntilExpiry)} minutes ago)` 
        });
      }
    }

    let updatedSubscription;
    let subscriberNumber;
    try {
      ({ updatedSubscription, subscriberNumber } =
        await finalizeSubscriptionVerification(subscription));
    } catch (finalizeErr) {
      const code = finalizeErr.statusCode || 500;
      return res.status(code).json({
        success: false,
        error: finalizeErr.message || 'Failed to verify subscription',
      });
    }

    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(updatedSubscription),
      subscriberNumber: subscriberNumber,
      message: 'Email verified successfully',
    });
  } catch (error) {
    console.error('Error verifying subscription:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Apply promo code during registration (extends the base 3-month access period by 3/6/12 months).
app.post('/api/subscription/apply-promo-code', async (req, res) => {
  try {
    const { subscriptionId, code } = req.body || {};
    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'subscriptionId is required',
      });
    }

    const result = await applyPromoCodeToSubscription(subscriptionId, code);
    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(result.subscription),
      promoCode: result.promoCode,
      bonusMonths: result.bonusMonths,
      totalMonths: result.totalMonths,
      baseMonths: BASE_ACCESS_MONTHS,
      accessExpiresAt: result.accessExpiresAt,
      maxPublishedListings: result.maxPublishedListings,
      defaultQuota: DEFAULT_MONTHLY_LISTING_QUOTA,
      message: 'קוד הקופון הופעל בהצלחה',
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      console.error('POST /api/subscription/apply-promo-code:', err);
    }
    res.status(status).json({
      success: false,
      error: err.message || 'Failed to apply promo code',
    });
  }
});

// Stage 2: set password before email verification (B2B only)
app.post('/api/subscription/set-password', async (req, res) => {
  try {
    const { subscriptionId, password } = req.body || {};
    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'subscriptionId is required',
      });
    }
    const pwd = String(password || '');
    if (pwd.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
      });
    }

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('id, email, status, subscription_type, password_hash')
      .eq('id', subscriptionId)
      .single();

    if (error || !subscription) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found',
      });
    }
    const canSetPassword =
      subscription.status === 'pending_verification' ||
      ((subscription.status === 'verified' ||
        subscription.status === 'active') &&
        !subscription.password_hash);
    if (!canSetPassword) {
      return res.status(400).json({
        success: false,
        error: 'Cannot set password for this subscription state',
      });
    }
    if (!isB2BSubscriptionType(subscription.subscription_type)) {
      return res.status(400).json({
        success: false,
        error: 'Password registration applies to business subscriptions only',
      });
    }

    try {
      await persistSubscriptionPasswordHash(subscriptionId, pwd);
    } catch (pwdErr) {
      return res.status(pwdErr.statusCode || 500).json({
        success: false,
        error: pwdErr.message || 'Failed to save password',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('subscriptions')
      .select('id, email, status, subscription_type')
      .eq('id', subscriptionId)
      .single();

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: updateError.message || 'Failed to load subscription',
      });
    }

    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(updated),
      message: 'Password saved',
    });
  } catch (err) {
    console.error('Error in set-password:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// B2B sign-in: email + password
app.post('/api/auth/login', async (req, res) => {
  try {
    const emailRaw = req.body?.email != null ? String(req.body.email).trim() : '';
    const emailNorm = emailRaw.toLowerCase();
    const password = String(req.body?.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({
        success: false,
        error: 'כתובת מייל לא תקינה',
      });
    }
    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'נא להזין סיסמה',
      });
    }

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .ilike('email', emailNorm)
      .in('status', ['verified', 'active'])
      .limit(1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Login failed',
      });
    }

    if (!subscription) {
      return res.status(401).json({
        success: false,
        error: 'מייל או סיסמה שגויים',
      });
    }

    if (
      isB2BSubscriptionType(subscription.subscription_type) &&
      !subscription.password_hash
    ) {
      return res.status(401).json({
        success: false,
        code: 'NO_PASSWORD_SET',
        error:
          'לא הוגדרה סיסמה לחשבון. השלימו הרשמה (שלחו קוד אימות עם סיסמה) או הגדירו סיסמה מחדש.',
      });
    }

    if (
      !subscription.password_hash ||
      !verifyPassword(password, subscription.password_hash)
    ) {
      return res.status(401).json({
        success: false,
        error: 'מייל או סיסמה שגויים',
      });
    }

    // Time-limited usage: base 3 months, extendable with coupons (3/6/12 months).
    if (
      subscription.access_expires_at &&
      new Date(subscription.access_expires_at) < new Date()
    ) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_EXPIRED',
        error: 'תוקף המנוי הסתיים. לחידוש המנוי צרו קשר עם שירות הלקוחות.',
      });
    }

    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(subscription),
    });
  } catch (err) {
    console.error('Error in auth/login:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dev/test only: verify without email code (set ALLOW_SKIP_EMAIL_VERIFICATION=1 in .env)
app.post('/api/subscription/verify-skip-test', async (req, res) => {
  try {
    if (!allowSkipEmailVerificationTest()) {
      return res.status(403).json({
        success: false,
        code: 'SKIP_VERIFY_DISABLED',
        error:
          'דילוג אימות (בדיקה) כבוי בשרת זה.',
      });
    }
    const { subscriptionId, email, password: passwordRaw } = req.body || {};
    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'subscriptionId is required',
      });
    }

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .eq('status', 'pending_verification')
      .single();

    if (error || !subscription) {
      return res.status(400).json({
        success: false,
        error: 'Subscription not found or already verified',
      });
    }

    if (
      isB2BSubscriptionType(subscription.subscription_type) &&
      !subscription.password_hash
    ) {
      const pwd = String(passwordRaw || '');
      if (pwd.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          success: false,
          error: 'יש להגדיר סיסמה לפני אימות',
        });
      }
      try {
        await persistSubscriptionPasswordHash(subscription.id, pwd);
        subscription.password_hash = 'set';
      } catch (pwdErr) {
        return res.status(pwdErr.statusCode || 500).json({
          success: false,
          error: pwdErr.message || 'Failed to save password',
        });
      }
    }

    if (email && String(email).trim() && subscription.email !== String(email).trim()) {
      return res.status(400).json({
        success: false,
        error: 'Email does not match this subscription',
      });
    }

    let updatedSubscription;
    let subscriberNumber;
    try {
      ({ updatedSubscription, subscriberNumber } =
        await finalizeSubscriptionVerification(subscription));
    } catch (finalizeErr) {
      const code = finalizeErr.statusCode || 500;
      return res.status(code).json({
        success: false,
        error: finalizeErr.message || 'Failed to verify subscription',
      });
    }

    console.warn('[TEST] Email verification skipped for subscription', subscriptionId);

    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(updatedSubscription),
      subscriberNumber,
      message: 'Verification skipped (test mode)',
    });
  } catch (error) {
    console.error('Error in verify-skip-test:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Resend verification code
app.post('/api/subscription/resend-code', async (req, res) => {
  try {
    const { email, subscriptionId, password: passwordRaw } = req.body;

    if (!email && !subscriptionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscription ID is required' 
      });
    }

    // Find subscription by ID (preferred) or email
    let query = supabase
      .from('subscriptions')
      .select('*');
    
    if (subscriptionId) {
      query = query.eq('id', subscriptionId);
    } else {
      query = query.eq('email', email);
    }
    
    query = query.eq('status', 'pending_verification');
    
    const { data: subscription, error } = await query.single();

    if (error || !subscription) {
      console.error('Subscription lookup error:', error);
      console.error('Looking for:', { email, subscriptionId });
      return res.status(404).json({ 
        success: false, 
        error: 'Subscription not found. Please make sure you completed the form submission.' 
      });
    }

    let subscriptionRow = subscription;
    if (
      isB2BSubscriptionType(subscription.subscription_type) &&
      passwordRaw
    ) {
      try {
        await persistSubscriptionPasswordHash(subscription.id, passwordRaw);
        subscriptionRow = { ...subscription, password_hash: 'set' };
      } catch (pwdErr) {
        return res.status(pwdErr.statusCode || 500).json({
          success: false,
          error: pwdErr.message || 'Failed to save password before sending code',
        });
      }
    } else if (
      isB2BSubscriptionType(subscription.subscription_type) &&
      !subscription.password_hash
    ) {
      return res.status(400).json({
        success: false,
        error: 'יש להגדיר סיסמה לפני שליחת מייל האימות',
      });
    }

    // Generate new verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update subscription with new code
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        verification_code: verificationCode,
        verification_code_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      })
      .eq('id', subscriptionRow.id);

    if (updateError) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to resend verification code' 
      });
    }

    const sendTo =
      subscriptionRow.email ||
      (email && String(email).trim() ? String(email).trim() : '');
    if (!sendTo) {
      return res.status(400).json({
        success: false,
        error: 'No email on file for this subscription',
      });
    }

    await sendVerificationEmail(
      sendTo,
      verificationCode,
      subscriptionRow.subscription_type,
    );

    res.json({
      success: true,
      verificationCode: verificationCode, // Remove in production
      message: 'Verification code sent successfully',
    });

  } catch (error) {
    console.error('Error resending code:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/** Forgot password: reset B2B password and email the new one (hash-only storage). */
async function handleForgotPasswordByEmail(req, res) {
  try {
    const emailRaw = req.body && req.body.email != null ? String(req.body.email).trim() : '';
    const emailNorm = emailRaw.toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
    if (!emailOk) {
      return res.status(400).json({
        success: false,
        error: 'אנא הזן כתובת מייל תקינה',
      });
    }

    const { data: rows, error } = await supabase
      .from('subscriptions')
      .select('id, email, subscription_type, password_hash, status')
      .in('status', ['verified', 'active'])
      .ilike('email', emailNorm)
      .limit(1);

    if (error) {
      console.error('forgot-password lookup:', error);
    }

    const subscription = rows && rows[0];
    if (
      subscription &&
      isB2BSubscriptionType(subscription.subscription_type) &&
      subscription.password_hash
    ) {
      const toEmail = subscription.email || emailRaw;
      const newPassword = generateTemporaryPassword(12);
      try {
        await persistSubscriptionPasswordHash(subscription.id, newPassword);
        await sendPasswordRecoveryEmail(
          toEmail,
          newPassword,
          subscription.subscription_type,
        );
      } catch (pwdErr) {
        console.error('forgot-password reset failed:', pwdErr.message);
      }
    } else {
      console.log('forgot-password: no B2B account with password for email (masked)');
    }

    res.json({
      success: true,
      message: 'אם קיים חשבון למייל זה, נשלח אליו מייל עם הסיסמה.',
    });
  } catch (error) {
    console.error('forgot-password:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/api/auth/forgot-password', handleForgotPasswordByEmail);
// Legacy route — same forgot-password behavior
app.post('/api/subscription/recover-subscriber-code', handleForgotPasswordByEmail);

app.get('/api/subscription/email-available', async (req, res) => {
  try {
    const emailNorm = normalizeSubscriptionEmail(req.query?.email);
    if (!isValidSubscriptionEmail(emailNorm)) {
      return res.status(400).json({
        success: false,
        available: false,
        error: 'כתובת מייל לא תקינה',
      });
    }
    const existing = await findSubscriptionByEmail(emailNorm);
    return res.json({success: true, available: !existing});
  } catch (err) {
    console.error('[subscription/email-available]', err);
    return res.status(500).json({
      success: false,
      available: false,
      error: err?.message || 'Unexpected error',
    });
  }
});

// POST /api/users/register-regular – upsert a regular (subscription_type='user') verified subscription by email
// Returns the existing or newly created subscription so the client always gets a real UUID `id`.
app.post('/api/users/register-regular', async (req, res) => {
  try {
    const body = req.body || {};
    const emailRaw = body.email != null ? String(body.email).trim() : '';
    const emailNorm = emailRaw.toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
    console.log('[users/register-regular] incoming', {
      hasEmail: !!emailNorm,
      emailPreview: emailNorm ? `${emailNorm.slice(0, 3)}***` : null,
      hasName: !!(body.name && String(body.name).trim()),
      hasPhone: !!(body.phone && String(body.phone).trim()),
      hasProfilePicture: !!(body.profile_picture_url && String(body.profile_picture_url).trim()),
    });
    if (!emailOk) {
      console.warn('[users/register-regular] rejected: invalid email');
      return res.status(400).json({success: false, error: 'Invalid email'});
    }

    const name = body.name != null && String(body.name).trim() ? String(body.name).trim() : null;
    const phone = body.phone != null && String(body.phone).trim() ? String(body.phone).trim() : null;
    const businessAddress =
      body.business_address != null && String(body.business_address).trim()
        ? String(body.business_address).trim()
        : body.address != null && String(body.address).trim()
          ? String(body.address).trim()
          : null;
    const profilePictureUrl =
      body.profile_picture_url != null && String(body.profile_picture_url).trim()
        ? String(body.profile_picture_url).trim()
        : null;
    const password = body.password != null ? String(body.password) : '';

    // Check if a subscription already exists for this email.
    const { data: existing, error: existingErr } = await supabase
      .from('subscriptions')
      .select('*')
      .ilike('email', emailNorm)
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error('[users/register-regular] existing lookup error:', existingErr);
      return res.status(500).json({success: false, error: existingErr.message});
    }

    if (existing) {
      // Explicit registration (password provided) — email must be unique.
      if (password.length >= MIN_PASSWORD_LENGTH) {
        return registrationEmailTakenResponse(res);
      }

      // Promote/refresh fields if needed but keep a stable UUID id.
      const updates = {};
      if (existing.status !== 'verified') updates.status = 'verified';
      if (!existing.subscription_type) updates.subscription_type = 'user';
      if (name && !existing.name) updates.name = name;
      if (phone && !existing.phone) updates.phone = phone;
      if (businessAddress && !existing.business_address) {
        updates.business_address = businessAddress;
      }
      if (profilePictureUrl && !existing.profile_picture_url) {
        updates.profile_picture_url = profilePictureUrl;
      }
      if (password.length >= MIN_PASSWORD_LENGTH) {
        updates.password_hash = hashPassword(password);
      } else if (!existing.password_hash) {
        return res.status(400).json({
          success: false,
          error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
        });
      }
      if (Object.keys(updates).length > 0) {
        const { data: updated, error: updErr } = await supabase
          .from('subscriptions')
          .update(updates)
          .eq('id', existing.id)
          .select('*')
          .maybeSingle();
        if (updErr) {
          console.warn('[users/register-regular] update warn:', updErr.message);
        }
        console.log('[users/register-regular] existing user updated', {
          id: existing.id,
          updatedKeys: Object.keys(updates),
        });
        return res.json({
          success: true,
          subscription: sanitizeSubscriptionForClient(updated || existing),
          created: false,
        });
      }
      if (!existing.password_hash) {
        return res.status(400).json({
          success: false,
          error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
        });
      }
      console.log('[users/register-regular] existing user returned (no changes)', {
        id: existing.id,
      });
      return res.json({
        success: true,
        subscription: sanitizeSubscriptionForClient(existing),
        created: false,
      });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
      });
    }

    const insertRow = {
      subscription_type: 'user',
      email: emailNorm,
      name,
      phone,
      business_address: businessAddress,
      profile_picture_url: profilePictureUrl,
      password_hash: hashPassword(password),
      status: 'verified',
      verified_at: new Date().toISOString(),
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('subscriptions')
      .insert(insertRow)
      .select('*')
      .single();

    if (insertErr) {
      console.error('[users/register-regular] insert error:', insertErr);
      return res.status(500).json({ success: false, error: insertErr.message });
    }

    console.log('[users/register-regular] created new subscription', {
      id: inserted?.id || null,
      subscription_type: inserted?.subscription_type || null,
      status: inserted?.status || null,
    });
    return res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(inserted),
      created: true,
    });
  } catch (err) {
    console.error('[users/register-regular] unexpected:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Unexpected error' });
  }
});

function getGoogleClientIds() {
  return String(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function verifyGoogleIdToken(idToken) {
  const token = String(idToken || '').trim();
  if (!token) {
    throw new Error('Missing Google ID token');
  }
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`,
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error_description || payload?.error || 'Invalid Google token');
  }
  const allowed = getGoogleClientIds();
  if (allowed.length > 0 && !allowed.includes(String(payload.aud || ''))) {
    throw new Error('Google token audience mismatch');
  }
  const email = payload.email ? String(payload.email).trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Google account has no valid email');
  }
  const verified =
    payload.email_verified === true ||
    payload.email_verified === 'true' ||
    payload.email_verified === 1 ||
    payload.email_verified === '1';
  if (!verified) {
    throw new Error('Google email is not verified');
  }
  return {
    email,
    name: payload.name ? String(payload.name).trim() : null,
    picture: payload.picture ? String(payload.picture).trim() : null,
    sub: payload.sub ? String(payload.sub) : null,
  };
}

// POST /api/auth/google – verify Google ID token, upsert regular user subscription
app.post('/api/auth/google', async (req, res) => {
  try {
    const idToken = req.body?.id_token || req.body?.idToken;
    let googleUser;
    try {
      googleUser = await verifyGoogleIdToken(idToken);
    } catch (verifyErr) {
      console.warn('[auth/google] token verify failed:', verifyErr.message);
      return res.status(401).json({success: false, error: verifyErr.message});
    }

    const emailNorm = googleUser.email;
    const name = googleUser.name || null;
    const profilePictureUrl = googleUser.picture || null;

    const {data: existing, error: existingErr} = await supabase
      .from('subscriptions')
      .select('*')
      .ilike('email', emailNorm)
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error('[auth/google] lookup error:', existingErr);
      return res.status(500).json({success: false, error: existingErr.message});
    }

    if (existing) {
      return registrationEmailTakenResponse(res);
    }

    const insertRow = {
      subscription_type: 'user',
      email: emailNorm,
      name,
      profile_picture_url: profilePictureUrl,
      status: 'verified',
      verified_at: new Date().toISOString(),
    };

    const {data: inserted, error: insertErr} = await supabase
      .from('subscriptions')
      .insert(insertRow)
      .select('*')
      .single();

    if (insertErr) {
      console.error('[auth/google] insert error:', insertErr);
      return res.status(500).json({success: false, error: insertErr.message});
    }

    return res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(inserted),
      created: true,
    });
  } catch (err) {
    console.error('[auth/google] unexpected:', err);
    return res.status(500).json({success: false, error: err?.message || 'Unexpected error'});
  }
});

// Get subscription by ID – same fields as listings builder so description and all subscription fields are returned
const SUBSCRIPTION_SELECT =
  'id, email, name, subscription_type, status, subscriber_number, ' +
  'business_name, contact_person_name, company_id, office_phone, mobile_phone, company_website, ' +
  'brokerage_license_number, broker_office_name, dealer_number, business_address, ' +
  'profile_picture_url, company_logo_url, video_url, additional_images_urls, ' +
  'specializations, activity_regions, types, description, phone, created_at, updated_at';
app.get('/api/subscription/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_SELECT)
      .eq('id', id)
      .single();

    if (error || !subscription) {
      return res.status(200).json({
        success: false,
        subscription: null
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[GET /api/subscription/:id] id=', id, 'description=', subscription.description != null ? `"${String(subscription.description).slice(0, 50)}..."` : subscription.description);
    }
    res.json({
      success: true,
      subscription
    });

  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/** Profile fields a user may edit from the "edit profile" screen (all account types). */
const EDITABLE_SUBSCRIPTION_FIELDS = [
  'name',
  'business_name',
  'contact_person_name',
  'broker_office_name',
  'phone',
  'mobile_phone',
  'office_phone',
  'company_website',
  'business_address',
  'company_id',
  'brokerage_license_number',
  'dealer_number',
  'description',
  'profile_picture_url',
  'company_logo_url',
];

// PATCH /api/subscription/:id — update editable profile fields (all account types).
app.patch('/api/subscription/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !LISTING_AD_UUID_RE.test(String(id).trim())) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const body = req.body || {};
    const updates = {};
    for (const key of EDITABLE_SUBSCRIPTION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      let value = body[key];
      if (typeof value === 'string') {
        value = value.trim();
        if (value === '') value = null;
      }
      updates[key] = value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }
    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from('subscriptions')
      .update(updates)
      .eq('id', String(id).trim())
      .select(SUBSCRIPTION_SELECT)
      .single();

    if (updateError || !updated) {
      console.error('Error updating subscription profile:', updateError);
      return res.status(500).json({
        success: false,
        error: updateError?.message || 'Failed to update profile',
      });
    }

    res.json({ success: true, subscription: sanitizeSubscriptionForClient(updated) });
  } catch (error) {
    console.error('Error in PATCH /api/subscription/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/brokers/search?q=...&exclude_email=... — brokers only (not suspended); text match on name / contact / office fields
app.get('/api/brokers/search', async (req, res) => {
  try {
    const rawQ = req.query.q != null ? String(req.query.q).trim() : '';
    if (rawQ.length < 2) {
      return res.json({ success: true, brokers: [] });
    }
    const safeQ = rawQ.replace(/%/g, '').replace(/,/g, '').replace(/\(/g, '').replace(/\)/g, '').replace(/\*/g, '').slice(0, 80);
    const like = `%${safeQ}%`;
    const excludeEmail = normEmail(req.query.exclude_email || '');

    const mapRowToBroker = (sub) => {
      const person = sub.name || sub.contact_person_name || '';
      const office = sub.broker_office_name || sub.business_name || '';
      const title = person.trim() || office.trim() || 'מתווך';
      let subtitle = '';
      if (office && office.trim() !== person.trim()) {
        subtitle = `תיווך ${office.trim()}`;
      } else if (office) {
        subtitle = `תיווך ${office.trim()}`;
      } else {
        subtitle = 'מתווך נדל"ן';
      }
      return {
        id: sub.id,
        email: sub.email || null,
        title,
        subtitle,
        profileImageUrl: sub.profile_picture_url || null,
      };
    };

    let list = [];

    const pool = getBrokerSearchPgPool();
    if (pool) {
      try {
        const r = await pool.query(
          `SELECT id, email, name, contact_person_name, broker_office_name, business_name, profile_picture_url
           FROM subscriptions
           WHERE subscription_type = 'broker'
             AND status IN ('verified', 'active', 'pending_verification')
             AND (
               COALESCE(name, '') ILIKE $1
               OR COALESCE(contact_person_name, '') ILIKE $1
               OR COALESCE(broker_office_name, '') ILIKE $1
               OR COALESCE(business_name, '') ILIKE $1
             )
           LIMIT 35`,
          [like],
        );
        list = r.rows || [];
      } catch (pgErr) {
        console.error('GET /api/brokers/search (Postgres):', pgErr.message);
      }
    }

    if (list.length === 0) {
      const selectCols = 'id, email, name, contact_person_name, broker_office_name, business_name, profile_picture_url';
      const orFilters = `name.ilike.${like},contact_person_name.ilike.${like},broker_office_name.ilike.${like},business_name.ilike.${like}`;
      const { data: rows, error } = await supabase
        .from('subscriptions')
        .select(selectCols)
        .eq('subscription_type', 'broker')
        .in('status', ['verified', 'active', 'pending_verification'])
        .or(orFilters)
        .limit(35);

      if (error) {
        console.error('GET /api/brokers/search (Supabase):', error.message);
        return res.status(500).json({ success: false, error: error.message, brokers: [] });
      }
      list = rows || [];
    }

    if (excludeEmail) {
      list = list.filter((r) => normEmail(r.email) !== excludeEmail);
    }

    const brokers = list.map(mapRowToBroker);
    res.json({ success: true, brokers });
  } catch (err) {
    console.error('GET /api/brokers/search:', err);
    res.status(500).json({ success: false, error: err.message, brokers: [] });
  }
});

// GET /api/brokers/group-picker?q=&exclude_email= — brokers for multi-select; empty/short q lists first brokers (for group creation)
app.get('/api/brokers/group-picker', async (req, res) => {
  try {
    const rawQ = req.query.q != null ? String(req.query.q).trim() : '';
    const excludeEmail = normEmail(req.query.exclude_email || '');
    const limit = 60;

    const mapRowToBroker = (sub) => {
      const person = sub.name || sub.contact_person_name || '';
      const office = sub.broker_office_name || sub.business_name || '';
      const title = person.trim() || office.trim() || 'מתווך';
      let subtitle = '';
      if (office && office.trim() !== person.trim()) subtitle = `תיווך ${office.trim()}`;
      else if (office) subtitle = `תיווך ${office.trim()}`;
      else subtitle = 'מתווך נדל"ן';
      return {
        id: sub.id,
        email: sub.email || null,
        title,
        subtitle,
        profileImageUrl: sub.profile_picture_url || null,
      };
    };

    let list = [];
    const pool = getBrokerSearchPgPool();
    const useFilter = rawQ.length >= 2;
    const safeQ = rawQ.replace(/%/g, '').replace(/,/g, '').replace(/\(/g, '').replace(/\)/g, '').replace(/\*/g, '').slice(0, 80);
    const like = `%${safeQ}%`;

    if (pool) {
      try {
        if (useFilter) {
          const r = await pool.query(
            `SELECT id, email, name, contact_person_name, broker_office_name, business_name, profile_picture_url
             FROM subscriptions
             WHERE subscription_type = 'broker'
               AND status IN ('verified', 'active', 'pending_verification')
               AND (
                 COALESCE(name, '') ILIKE $1
                 OR COALESCE(contact_person_name, '') ILIKE $1
                 OR COALESCE(broker_office_name, '') ILIKE $1
                 OR COALESCE(business_name, '') ILIKE $1
               )
             ORDER BY name NULLS LAST
             LIMIT ${limit}`,
            [like],
          );
          list = r.rows || [];
        } else {
          const r = await pool.query(
            `SELECT id, email, name, contact_person_name, broker_office_name, business_name, profile_picture_url
             FROM subscriptions
             WHERE subscription_type = 'broker'
               AND status IN ('verified', 'active', 'pending_verification')
             ORDER BY name NULLS LAST
             LIMIT ${limit}`,
          );
          list = r.rows || [];
        }
      } catch (pgErr) {
        console.error('GET /api/brokers/group-picker (Postgres):', pgErr.message);
      }
    }

    if (list.length === 0) {
      const selectCols = 'id, email, name, contact_person_name, broker_office_name, business_name, profile_picture_url';
      let q = supabase
        .from('subscriptions')
        .select(selectCols)
        .eq('subscription_type', 'broker')
        .in('status', ['verified', 'active', 'pending_verification'])
        .order('name', { ascending: true })
        .limit(limit);
      if (useFilter) {
        const orFilters = `name.ilike.${like},contact_person_name.ilike.${like},broker_office_name.ilike.${like},business_name.ilike.${like}`;
        q = q.or(orFilters);
      }
      const { data: rows, error } = await q;
      if (error) {
        console.error('GET /api/brokers/group-picker (Supabase):', error.message);
        return res.status(500).json({ success: false, error: error.message, brokers: [] });
      }
      list = rows || [];
    }

    if (excludeEmail) list = list.filter((r) => normEmail(r.email) !== excludeEmail);
    const brokers = list.map(mapRowToBroker);
    res.json({ success: true, brokers });
  } catch (err) {
    console.error('GET /api/brokers/group-picker:', err);
    res.status(500).json({ success: false, error: err.message, brokers: [] });
  }
});

// GET /api/users/group-picker?q=&exclude_email=&audience=regular|broker_only|non_regular|all
// Used by "create group" picker:
// - regular => only regular users
// - broker_only => only brokers
// - non_regular => only broker/company/professional
app.get('/api/users/group-picker', async (req, res) => {
  try {
    const rawQ = req.query.q != null ? String(req.query.q).trim().toLowerCase() : '';
    const excludeEmail = normEmail(req.query.exclude_email || '');
    const audienceRaw = req.query.audience != null ? String(req.query.audience).trim().toLowerCase() : 'all';
    const audience =
      audienceRaw === 'regular' || audienceRaw === 'broker_only' || audienceRaw === 'non_regular'
        ? audienceRaw
        : 'all';
    const limit = 120;

    const isRegularType = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      if (!t) return true;
      return t === 'user' || t === 'private' || t === 'regular' || t === 'customer';
    };
    const isNonRegularType = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      return t === 'broker' || t === 'company' || t === 'professional';
    };
    const typeLabel = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      if (t === 'broker') return 'מתווך';
      if (t === 'company') return 'חברה';
      if (t === 'professional') return 'בעל מקצוע';
      return 'לקוח';
    };

    const { data: rows, error } = await supabase
      .from('subscriptions')
      .select(
        'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url, status',
      )
      .order('name', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('GET /api/users/group-picker:', error.message);
      return res.status(500).json({ success: false, error: error.message, users: [] });
    }

    let list = (rows || []).filter((r) => {
      const em = normEmail(r?.email);
      if (!em) return false;
      if (excludeEmail && em === excludeEmail) return false;
      // Keep active/verified-like rows; also allow null status to avoid hiding older regular users.
      const st = r?.status != null ? String(r.status).trim().toLowerCase() : '';
      if (st && st === 'suspended') return false;
      return true;
    });

    if (audience === 'regular') {
      list = list.filter((r) => isRegularType(r?.subscription_type));
    } else if (audience === 'broker_only') {
      list = list.filter((r) => String(r?.subscription_type || '').trim().toLowerCase() === 'broker');
    } else if (audience === 'non_regular') {
      list = list.filter((r) => isNonRegularType(r?.subscription_type));
    }

    if (rawQ.length >= 1) {
      list = list.filter((r) => {
        const name = r?.name != null ? String(r.name).toLowerCase() : '';
        const cp = r?.contact_person_name != null ? String(r.contact_person_name).toLowerCase() : '';
        const bn = r?.business_name != null ? String(r.business_name).toLowerCase() : '';
        const bo = r?.broker_office_name != null ? String(r.broker_office_name).toLowerCase() : '';
        const em = r?.email != null ? String(r.email).toLowerCase() : '';
        return (
          name.includes(rawQ) ||
          cp.includes(rawQ) ||
          bn.includes(rawQ) ||
          bo.includes(rawQ) ||
          em.includes(rawQ)
        );
      });
    }

    const users = list.map((sub) => {
      const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
      const email = normEmail(sub.email);
      const title = (name && String(name).trim()) || email || 'משתמש';
      return {
        id: sub.id || email,
        email,
        title,
        subtitle: typeLabel(sub.subscription_type),
        profileImageUrl: imageUrl || null,
        subscriptionType:
          sub.subscription_type != null ? String(sub.subscription_type).trim().toLowerCase() : null,
      };
    });

    res.json({ success: true, users });
  } catch (err) {
    console.error('GET /api/users/group-picker:', err);
    res.status(500).json({ success: false, error: err.message, users: [] });
  }
});

// GET /api/chat/direct-contacts?user_email=&q= — people from 1:1 chats (for customer group picker)
app.get('/api/chat/direct-contacts', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    const qRaw = req.query.q != null ? String(req.query.q).trim().toLowerCase() : '';
    const audienceRaw = req.query.audience != null ? String(req.query.audience).trim().toLowerCase() : 'all';
    const audience = audienceRaw === 'regular' || audienceRaw === 'non_regular' ? audienceRaw : 'all';
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });

    const { data: myParts } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', userEmail);
    const convIds = [...new Set((myParts || []).map((p) => p.conversation_id))];
    if (convIds.length === 0) return res.json({ success: true, contacts: [] });

    const { data: allParts } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id, display_name, profile_picture_url')
      .in('conversation_id', convIds);

    const countByConv = {};
    (allParts || []).forEach((p) => {
      countByConv[p.conversation_id] = (countByConv[p.conversation_id] || 0) + 1;
    });
    const directConvIds = new Set(convIds.filter((cid) => countByConv[cid] === 2));

    const byEmail = new Map();
    (allParts || []).forEach((p) => {
      if (!directConvIds.has(p.conversation_id)) return;
      const em = normEmail(p.user_id);
      if (!em || em === userEmail) return;
      const disp = (p.display_name && String(p.display_name).trim()) || '';
      const pic = p.profile_picture_url || null;
      const prev = byEmail.get(em);
      const title = prev ? disp || prev.title : disp || em;
      const profileImageUrl = (prev && prev.profileImageUrl) || pic;
      const subscriptionType = prev?.subscriptionType || null;
      byEmail.set(em, { email: em, title, subtitle: em, profileImageUrl, subscriptionType });
    });

    const refs = [...byEmail.keys()];
    const emailRefs = refs.filter((r) => r.includes('@'));
    const idRefs = refs.filter((r) => !r.includes('@') && CHAT_UUID_RE.test(r));
    const subsByRef = {};
    if (emailRefs.length > 0) {
      const orFilter = emailRefs.map((e) => `email.ilike.${e}`).join(',');
      const { data: subsByEmail } = await supabase
        .from('subscriptions')
        .select(
          'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
        )
        .or(orFilter);
      (subsByEmail || []).forEach((s) => {
        const e = normEmail(s.email);
        if (e) subsByRef[e] = s;
      });
    }
    if (idRefs.length > 0) {
      const { data: subsById } = await supabase
        .from('subscriptions')
        .select(
          'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
        )
        .in('id', idRefs);
      (subsById || []).forEach((s) => {
        if (s.id) subsByRef[String(s.id).toLowerCase()] = s;
      });
    }
    for (const ref of refs) {
      const sub = subsByRef[ref];
      if (!sub) continue;
      const row = byEmail.get(ref);
      if (!row) continue;
      const subName = subscriptionDisplayNameFromRow(sub);
      const subPic = subscriptionProfilePicFromRow(sub);
      const subType = sub?.subscription_type != null ? String(sub.subscription_type).trim().toLowerCase() : '';
      if (subName) row.title = subName;
      if (subPic) row.profileImageUrl = subPic;
      row.subscriptionType = subType || null;
      if ((!row.subtitle || row.subtitle === ref) && sub.email) {
        row.subtitle = String(sub.email).trim();
      }
      byEmail.set(ref, row);
    }

    let contacts = [...byEmail.values()];
    const isRegularType = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      if (!t) return true;
      return t === 'user' || t === 'private' || t === 'regular' || t === 'customer';
    };
    if (audience === 'regular') {
      contacts = contacts.filter((c) => isRegularType(c?.subscriptionType));
    } else if (audience === 'non_regular') {
      contacts = contacts.filter((c) => !isRegularType(c?.subscriptionType));
    }
    if (qRaw.length >= 1) {
      contacts = contacts.filter(
        (c) =>
          c.email.includes(qRaw) ||
          (c.title && String(c.title).toLowerCase().includes(qRaw)) ||
          (c.subtitle && String(c.subtitle).toLowerCase().includes(qRaw)),
      );
    }
    contacts.sort((a, b) => String(a.title).localeCompare(String(b.title), 'he'));
    res.json({ success: true, contacts });
  } catch (err) {
    console.error('GET /api/chat/direct-contacts:', err);
    res.status(500).json({ success: false, error: err.message, contacts: [] });
  }
});

/**
 * Load subscriptions by normalized emails. PostgREST `.or('email.ilike.x@y.com')` is unsafe — `@`
 * breaks filter parsing — so we use `.in('email', …)` with a per-email ilike fallback.
 */
async function fetchSubscriptionsByEmails(emails) {
  const unique = [...new Set((emails || []).map(normEmail).filter(Boolean))];
  if (unique.length === 0) return [];
  const { data: batch, error } = await supabase
    .from('subscriptions')
    .select('email, subscription_type')
    .in('email', unique);
  const out = [];
  const seen = new Set();
  if (!error && Array.isArray(batch)) {
    for (const row of batch) {
      if (!row?.email) continue;
      const k = normEmail(row.email);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
  } else if (error) {
    console.warn('[fetchSubscriptionsByEmails] .in failed, using per-email lookup:', error.message);
  }
  const missing = unique.filter((e) => !seen.has(e));
  for (const e of missing) {
    const { data: row, error: oneErr } = await supabase
      .from('subscriptions')
      .select('email, subscription_type')
      .ilike('email', e)
      .maybeSingle();
    if (oneErr || !row?.email) continue;
    const k = normEmail(row.email);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// POST /api/chat/groups — create group conversation + participants
app.post('/api/chat/groups', async (req, res) => {
  try {
    const creator = normEmail(req.body.creator_email);
    const rawMembers = Array.isArray(req.body.member_emails) ? req.body.member_emails : [];
    const memberEmails = [...new Set(rawMembers.map(normEmail).filter(Boolean))].filter((e) => e !== creator);
    const titleIn = req.body.title != null ? String(req.body.title).trim().slice(0, 120) : '';
    const kind = req.body.kind === 'brokers' ? 'brokers' : 'customers';
    const groupImageUrl =
      req.body.group_image_url != null && String(req.body.group_image_url).trim()
        ? String(req.body.group_image_url).trim().slice(0, 2000)
        : null;
    const isRegularType = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      if (!t) return true;
      return t === 'user' || t === 'private' || t === 'regular' || t === 'customer';
    };
    const isBrokerType = (st) => String(st || '').trim().toLowerCase() === 'broker';

    if (!creator) return res.status(400).json({ success: false, error: 'creator_email required' });
    if (memberEmails.length < 1) return res.status(400).json({ success: false, error: 'At least one member required' });

    // Rule 1: only brokers can open any group.
    const { data: creatorSub, error: creatorErr } = await supabase
      .from('subscriptions')
      .select('email, subscription_type')
      .ilike('email', creator)
      .limit(1)
      .maybeSingle();
    if (creatorErr) {
      return res.status(500).json({ success: false, error: creatorErr.message });
    }
    if (!isBrokerType(creatorSub?.subscription_type)) {
      return res.status(403).json({ success: false, error: 'רק מתווכים יכולים לפתוח קבוצות' });
    }

    // Rule 2: enforce allowed member types by group kind.
    const memberTypeByEmail = new Map();
    if (memberEmails.length > 0) {
      const memberSubs = await fetchSubscriptionsByEmails(memberEmails);
      memberSubs.forEach((s) => {
        const em = normEmail(s?.email);
        if (!em) return;
        memberTypeByEmail.set(em, s?.subscription_type || null);
      });
    }
    const invalidMembers = memberEmails.filter((em) => {
      const st = memberTypeByEmail.get(em);
      if (kind === 'brokers') return !isBrokerType(st);
      return !isRegularType(st);
    });
    if (invalidMembers.length > 0) {
      return res.status(400).json({
        success: false,
        error:
          kind === 'brokers'
            ? 'בקבוצת מתווכים ניתן לצרף רק מתווכים'
            : 'בקבוצה רגילה ניתן לצרף רק משתמשים רגילים',
      });
    }

    const defaultTitle = kind === 'brokers' ? 'קבוצת מתווכים' : 'קבוצת לקוחות';
    const title = titleIn || defaultTitle;

    const insertRow = { type: 'group', title };
    if (groupImageUrl) insertRow.group_image_url = groupImageUrl;

    let { data: newConv, error: convErr } = await supabase
      .from('chat_conversations')
      .insert(insertRow)
      .select('id, type, title, group_image_url')
      .single();
    if (convErr && isMissingGroupImageUrlColumnError(convErr)) {
      console.warn(
        '[chat] chat_conversations.group_image_url is missing — run pi-back/migration-chat-group-image.sql in Supabase. Creating group without persisting image URL.',
      );
      const retry = await supabase
        .from('chat_conversations')
        .insert({ type: 'group', title })
        .select('id, type, title')
        .single();
      newConv = retry.data;
      convErr = retry.error;
    }
    if (convErr || !newConv?.id) {
      console.error('POST /api/chat/groups conv:', convErr?.message);
      return res.status(500).json({ success: false, error: convErr?.message || 'Failed to create conversation' });
    }
    const convId = newConv.id;

    const rows = [{ conversation_id: convId, user_id: creator }, ...memberEmails.map((e) => ({ conversation_id: convId, user_id: e }))];
    const { error: partErr } = await supabase.from('chat_participants').insert(rows);
    if (partErr) {
      await supabase.from('chat_conversations').delete().eq('id', convId);
      return res.status(500).json({ success: false, error: partErr.message });
    }

    const setCreator = await supabase
      .from('chat_conversations')
      .update({ group_creator_email: creator })
      .eq('id', convId);
    if (setCreator.error && !isMissingGroupCreatorEmailColumnError(setCreator.error)) {
      console.warn('POST /api/chat/groups set group_creator_email:', setCreator.error.message);
    }
    const markOwner = await supabase
      .from('chat_participants')
      .update({ group_role: 'owner' })
      .eq('conversation_id', convId)
      .eq('user_id', creator);
    if (markOwner.error && !isMissingGroupRoleColumnError(markOwner.error)) {
      console.warn('POST /api/chat/groups set creator group_role:', markOwner.error.message);
    }

    // Fallback persistence path when chat_conversations.group_image_url is unavailable:
    // store group avatar URL on participants rows for this conversation only.
    if (groupImageUrl && (!newConv?.group_image_url || isMissingGroupImageUrlColumnError(convErr))) {
      const { error: participantPicErr } = await supabase
        .from('chat_participants')
        .update({ profile_picture_url: groupImageUrl })
        .eq('conversation_id', convId);
      if (participantPicErr) {
        console.warn('POST /api/chat/groups participant group image fallback failed:', participantPicErr.message);
      }
    }

    res.json({
      success: true,
      conversation: {
        id: convId,
        type: 'group',
        title,
        isGroup: true,
        otherUserEmail: null,
        name: title,
        profileImageUrl: newConv?.group_image_url || groupImageUrl || null,
      },
    });
  } catch (err) {
    console.error('POST /api/chat/groups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/groups/add-members — body: user_email, conversation_id, member_emails[]
app.post('/api/chat/groups/add-members', async (req, res) => {
  try {
    const actorEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const rawMembers = Array.isArray(req.body.member_emails) ? req.body.member_emails : [];
    const memberEmails = [...new Set(rawMembers.map(normEmail).filter(Boolean))];
    const isRegularType = (st) => {
      const t = st != null ? String(st).trim().toLowerCase() : '';
      if (!t) return true;
      return t === 'user' || t === 'private' || t === 'regular' || t === 'customer';
    };
    const isBrokerType = (st) => String(st || '').trim().toLowerCase() === 'broker';

    if (!actorEmail || !convId) {
      return res.status(400).json({ success: false, error: 'user_email and conversation_id required' });
    }
    if (memberEmails.length < 1) {
      return res.status(400).json({ success: false, error: 'At least one member required' });
    }

    const { data: conv } = await supabase.from('chat_conversations').select('id, type, title').eq('id', convId).maybeSingle();
    if (!conv || String(conv.type || '').trim().toLowerCase() !== 'group') {
      return res.status(400).json({ success: false, error: 'Not a group conversation' });
    }

    const { data: actorSub, error: actorErr } = await supabase
      .from('subscriptions')
      .select('email, subscription_type')
      .ilike('email', actorEmail)
      .limit(1)
      .maybeSingle();
    if (actorErr) return res.status(500).json({ success: false, error: actorErr.message });
    if (!isBrokerType(actorSub?.subscription_type)) {
      return res.status(403).json({ success: false, error: 'Only brokers can add members to groups' });
    }

    const { data: parts, error: partsErr } = await supabase
      .from('chat_participants')
      .select('user_id')
      .eq('conversation_id', convId);
    if (partsErr) return res.status(500).json({ success: false, error: partsErr.message });
    const existingMembers = [...new Set((parts || []).map((p) => normEmail(p.user_id)).filter(Boolean))];
    if (!existingMembers.includes(actorEmail)) {
      return res.status(403).json({ success: false, error: 'Not a participant' });
    }

    const currentEmails = [...new Set(existingMembers)];
    const currentSubs = await fetchSubscriptionsByEmails(currentEmails);
    const currentTypeByEmail = new Map();
    (currentSubs || []).forEach((s) => {
      const e = normEmail(s?.email);
      if (e) currentTypeByEmail.set(e, String(s?.subscription_type || '').trim().toLowerCase());
    });
    const currentKind =
      currentEmails.some((e) => isRegularType(currentTypeByEmail.get(e))) ? 'customers' : 'brokers';

    const targetMembers = memberEmails.filter((e) => !existingMembers.includes(e));
    if (targetMembers.length === 0) {
      return res.json({ success: true, added: 0 });
    }

    const addSubs = await fetchSubscriptionsByEmails(targetMembers);
    const addTypeByEmail = new Map();
    (addSubs || []).forEach((s) => {
      const e = normEmail(s?.email);
      if (e) addTypeByEmail.set(e, String(s?.subscription_type || '').trim().toLowerCase());
    });

    const invalid = targetMembers.filter((e) => {
      const st = addTypeByEmail.get(e);
      if (currentKind === 'brokers') return !isBrokerType(st);
      return !isRegularType(st);
    });
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        error:
          currentKind === 'brokers'
            ? 'In broker groups, only brokers can be added'
            : 'In regular groups, only regular users can be added',
      });
    }

    const rows = targetMembers.map((e) => ({ conversation_id: convId, user_id: e }));
    const { error: addErr } = await supabase.from('chat_participants').insert(rows);
    if (addErr) return res.status(500).json({ success: false, error: addErr.message });

    res.json({ success: true, added: targetMembers.length });
  } catch (err) {
    console.error('POST /api/chat/groups/add-members:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/chat/group-description — body: user_email, conversation_id, group_description
app.patch('/api/chat/group-description', async (req, res) => {
  try {
    const userEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const descIn = req.body.group_description != null ? String(req.body.group_description) : '';
    const groupDescription = descIn.trim().slice(0, 2000);

    if (!userEmail || !convId) {
      return res.status(400).json({ success: false, error: 'user_email and conversation_id required' });
    }

    const { data: parts } = await supabase.from('chat_participants').select('user_id').eq('conversation_id', convId);
    const members = (parts || []).map((p) => normEmail(p.user_id));
    if (!members.includes(userEmail)) {
      return res.status(403).json({ success: false, error: 'Not a participant' });
    }

    const { data: conv } = await supabase.from('chat_conversations').select('type').eq('id', convId).maybeSingle();
    if (!conv || conv.type !== 'group') {
      return res.status(400).json({ success: false, error: 'Not a group conversation' });
    }

    const { error: upErr } = await supabase
      .from('chat_conversations')
      .update({ group_description: groupDescription })
      .eq('id', convId);

    if (upErr && isMissingGroupDescriptionColumnError(upErr)) {
      return res.status(500).json({
        success: false,
        error: 'Database column group_description missing — run migration-chat-group-description.sql',
      });
    }
    if (upErr) {
      console.error('PATCH /api/chat/group-description:', upErr);
      return res.status(500).json({ success: false, error: upErr.message });
    }

    res.json({ success: true, group_description: groupDescription });
  } catch (err) {
    console.error('PATCH /api/chat/group-description:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/chat/group-title — body: user_email, conversation_id, title
app.patch('/api/chat/group-title', async (req, res) => {
  try {
    const actorEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const titleIn = req.body.title != null ? String(req.body.title).trim().slice(0, 120) : '';

    if (!actorEmail || !convId) {
      return res.status(400).json({ success: false, error: 'user_email and conversation_id required' });
    }
    if (!titleIn) return res.status(400).json({ success: false, error: 'title required' });

    const { data: actorSub } = await supabase
      .from('subscriptions')
      .select('subscription_type')
      .ilike('email', actorEmail)
      .maybeSingle();
    const actorBroker = String(actorSub?.subscription_type || '').trim().toLowerCase() === 'broker';
    if (!actorBroker) return res.status(403).json({ success: false, error: 'רק מתווכים יכולים לערוך את שם הקבוצה' });

    let partsSel = await supabase
      .from('chat_participants')
      .select('user_id, group_role')
      .eq('conversation_id', convId);
    if (partsSel.error && isMissingGroupRoleColumnError(partsSel.error)) {
      partsSel = await supabase.from('chat_participants').select('user_id').eq('conversation_id', convId);
    }
    if (partsSel.error) return res.status(500).json({ success: false, error: partsSel.error.message });

    const partsRows = partsSel.data || [];
    const actorRow = partsRows.find((p) => normEmail(p.user_id) === actorEmail);
    if (!actorRow) return res.status(403).json({ success: false, error: 'Not a participant' });

    let convMeta = await supabase
      .from('chat_conversations')
      .select('type, group_creator_email')
      .eq('id', convId)
      .maybeSingle();
    if (convMeta.error && isMissingGroupCreatorEmailColumnError(convMeta.error)) {
      convMeta = await supabase.from('chat_conversations').select('type').eq('id', convId).maybeSingle();
    }
    const conv = convMeta.data;
    if (!conv || String(conv.type || '').trim().toLowerCase() !== 'group') {
      return res.status(400).json({ success: false, error: 'Not a group conversation' });
    }

    const creatorEm = conv.group_creator_email != null ? normEmail(conv.group_creator_email) : '';
    const ar = resolvedGroupRole({ user_id: actorRow.user_id, group_role: actorRow.group_role }, creatorEm);
    if (ar !== 'owner' && ar !== 'manager') {
      return res.status(403).json({ success: false, error: 'רק יוצר או מנהל יכולים לערוך את שם הקבוצה' });
    }

    const { error: upErr } = await supabase.from('chat_conversations').update({ title: titleIn }).eq('id', convId);
    if (upErr) {
      console.error('PATCH /api/chat/group-title:', upErr);
      return res.status(500).json({ success: false, error: upErr.message });
    }
    res.json({ success: true, title: titleIn });
  } catch (err) {
    console.error('PATCH /api/chat/group-title:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/groups/remove-member — body: user_email, conversation_id, member_email
app.post('/api/chat/groups/remove-member', async (req, res) => {
  try {
    const actorEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const targetEmail = normEmail(req.body.member_email);

    if (!actorEmail || !convId || !targetEmail) {
      return res.status(400).json({ success: false, error: 'user_email, conversation_id, and member_email required' });
    }

    const { data: convRow } = await supabase.from('chat_conversations').select('id, type').eq('id', convId).maybeSingle();
    if (!convRow || String(convRow.type || '').trim().toLowerCase() !== 'group') {
      return res.status(400).json({ success: false, error: 'Not a group conversation' });
    }

    let convFull = await supabase
      .from('chat_conversations')
      .select('group_creator_email')
      .eq('id', convId)
      .maybeSingle();
    if (convFull.error && isMissingGroupCreatorEmailColumnError(convFull.error)) {
      convFull = { data: {} };
    }
    const creatorEmailStored =
      convFull.data?.group_creator_email != null ? normEmail(convFull.data.group_creator_email) : '';

    let pSel = await supabase
      .from('chat_participants')
      .select('user_id, group_role, joined_at')
      .eq('conversation_id', convId);
    if (pSel.error && isMissingGroupRoleColumnError(pSel.error)) {
      pSel = await supabase.from('chat_participants').select('user_id, joined_at').eq('conversation_id', convId);
    }
    if (pSel.error) return res.status(500).json({ success: false, error: pSel.error.message });

    const allParts = pSel.data || [];
    const actorPart = allParts.find((p) => normEmail(p.user_id) === actorEmail);
    const targetPart = allParts.find((p) => normEmail(p.user_id) === targetEmail);
    if (!actorPart) return res.status(403).json({ success: false, error: 'Not a participant' });
    if (!targetPart) return res.status(400).json({ success: false, error: 'Member not in group' });

    const actorRole = resolvedGroupRole(actorPart, creatorEmailStored);
    const targetRole = resolvedGroupRole(targetPart, creatorEmailStored);

    const isSelf = actorEmail === targetEmail;
    if (!isSelf) {
      const { data: actorSub } = await supabase
        .from('subscriptions')
        .select('subscription_type')
        .ilike('email', actorEmail)
        .maybeSingle();
      const actorBroker = String(actorSub?.subscription_type || '').trim().toLowerCase() === 'broker';
      if (!actorBroker) return res.status(403).json({ success: false, error: 'רק מתווכים יכולים להסיר משתתפים אחרים' });
      if (targetRole === 'owner') {
        return res.status(403).json({ success: false, error: 'לא ניתן להסיר את יוצר הקבוצה' });
      }
      if (actorRole !== 'owner' && actorRole !== 'manager') {
        return res.status(403).json({ success: false, error: 'רק יוצר או מנהל יכולים להסיר חברים' });
      }
    }

    const { error: delErr } = await supabase
      .from('chat_participants')
      .delete()
      .eq('conversation_id', convId)
      .eq('user_id', targetPart.user_id);

    if (delErr) return res.status(500).json({ success: false, error: delErr.message });

    const { count: remainingCount } = await supabase
      .from('chat_participants')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', convId);

    if (!remainingCount || remainingCount === 0) {
      await supabase.from('chat_conversations').delete().eq('id', convId);
      return res.json({ success: true, removed: true, conversationDeleted: true });
    }

    if (targetRole === 'owner' || (creatorEmailStored && targetEmail === creatorEmailStored)) {
      let rest = await supabase
        .from('chat_participants')
        .select('user_id, joined_at, group_role')
        .eq('conversation_id', convId)
        .order('joined_at', { ascending: true, nullsFirst: true });
      if (rest.error && isMissingGroupRoleColumnError(rest.error)) {
        rest = await supabase
          .from('chat_participants')
          .select('user_id, joined_at')
          .eq('conversation_id', convId)
          .order('joined_at', { ascending: true, nullsFirst: true });
      }
      const restRows = rest.data || [];
      const successor = restRows[0];
      if (successor) {
        const succEmail = normEmail(successor.user_id);
        const upRole = await supabase
          .from('chat_participants')
          .update({ group_role: 'owner' })
          .eq('conversation_id', convId)
          .eq('user_id', successor.user_id);
        if (upRole.error && !isMissingGroupRoleColumnError(upRole.error)) {
          console.warn('succession group_role update:', upRole.error.message);
        }
        const upCr = await supabase
          .from('chat_conversations')
          .update({ group_creator_email: succEmail })
          .eq('id', convId);
        if (upCr.error && !isMissingGroupCreatorEmailColumnError(upCr.error)) {
          console.warn('succession group_creator_email update:', upCr.error.message);
        }
      }
    }

    res.json({ success: true, removed: true, conversationDeleted: false });
  } catch (err) {
    console.error('POST /api/chat/groups/remove-member:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/groups/member-role — body: user_email, conversation_id, target_email, role: manager | member
app.post('/api/chat/groups/member-role', async (req, res) => {
  try {
    const actorEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const targetEmail = normEmail(req.body.target_email);
    const roleRaw = req.body.role != null ? String(req.body.role).trim().toLowerCase() : '';
    const nextRole = roleRaw === 'manager' || roleRaw === 'member' ? roleRaw : null;

    if (!actorEmail || !convId || !targetEmail || !nextRole) {
      return res.status(400).json({
        success: false,
        error: 'user_email, conversation_id, target_email, and role (manager|member) required',
      });
    }

    let convFull = await supabase
      .from('chat_conversations')
      .select('type, group_creator_email')
      .eq('id', convId)
      .maybeSingle();
    if (convFull.error && isMissingGroupCreatorEmailColumnError(convFull.error)) {
      convFull = await supabase.from('chat_conversations').select('type').eq('id', convId).maybeSingle();
    }
    const conv = convFull.data;
    if (!conv || String(conv.type || '').trim().toLowerCase() !== 'group') {
      return res.status(400).json({ success: false, error: 'Not a group conversation' });
    }
    const creatorEmailStored =
      conv.group_creator_email != null ? normEmail(conv.group_creator_email) : '';

    let pSel = await supabase
      .from('chat_participants')
      .select('user_id, group_role')
      .eq('conversation_id', convId);
    if (pSel.error && isMissingGroupRoleColumnError(pSel.error)) {
      return res.status(500).json({
        success: false,
        error: 'Database column group_role missing — run migration-chat-group-management.sql',
      });
    }
    if (pSel.error) return res.status(500).json({ success: false, error: pSel.error.message });

    const rows = pSel.data || [];
    const actorPart = rows.find((p) => normEmail(p.user_id) === actorEmail);
    const targetPart = rows.find((p) => normEmail(p.user_id) === targetEmail);
    if (!actorPart || !targetPart) return res.status(403).json({ success: false, error: 'Not a participant' });

    const actorRole = resolvedGroupRole(actorPart, creatorEmailStored);
    if (actorRole !== 'owner') {
      return res.status(403).json({ success: false, error: 'רק יוצר הקבוצה יכול לנהל תפקידי מנהל' });
    }

    const targetRole = resolvedGroupRole(targetPart, creatorEmailStored);
    if (targetRole === 'owner') {
      return res.status(400).json({ success: false, error: 'לא ניתן לשנות את תפקיד יוצר הקבוצה' });
    }

    const { error: upErr } = await supabase
      .from('chat_participants')
      .update({ group_role: nextRole })
      .eq('conversation_id', convId)
      .eq('user_id', targetPart.user_id);

    if (upErr) {
      console.error('POST /api/chat/groups/member-role:', upErr);
      return res.status(500).json({ success: false, error: upErr.message });
    }

    res.json({ success: true, group_role: nextRole });
  } catch (err) {
    console.error('POST /api/chat/groups/member-role:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/group-messages?user_email=&conversation_id=
app.get('/api/chat/group-messages', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    const convId = req.query.conversation_id != null ? String(req.query.conversation_id).trim() : '';
    if (!userEmail || !convId) return res.status(400).json({ success: false, error: 'user_email and conversation_id required' });

    let partsRes = await supabase
      .from('chat_participants')
      .select('user_id, display_name, profile_picture_url, group_role')
      .eq('conversation_id', convId);
    if (partsRes.error && isMissingGroupRoleColumnError(partsRes.error)) {
      partsRes = await supabase
        .from('chat_participants')
        .select('user_id, display_name, profile_picture_url')
        .eq('conversation_id', convId);
    }
    if (partsRes.error) return res.status(500).json({ success: false, error: partsRes.error.message });
    const parts = partsRes.data;

    const members = (parts || []).map((p) => normEmail(p.user_id)).filter(Boolean);
    if (!members.includes(userEmail)) return res.status(403).json({ success: false, error: 'Not a participant' });

    markChatConversationRead(userEmail, convId);

    let list;
    try {
      list = await loadChatMessagesForConversation(convId, userEmail);
    } catch (loadErr) {
      return res.status(500).json({ success: false, error: loadErr?.message || 'Unable to load group messages' });
    }

    let group = { title: 'קבוצה', profileImageUrl: null, description: null };
    let convMeta = null;
    const [rAll, rCreator] = await Promise.all([
      supabase
        .from('chat_conversations')
        .select('title, group_image_url, group_description')
        .eq('id', convId)
        .maybeSingle(),
      supabase
        .from('chat_conversations')
        .select('group_creator_email')
        .eq('id', convId)
        .maybeSingle(),
    ]);
    if (!rAll.error && rAll.data) {
      convMeta = rAll.data;
    } else if (rAll.error && isMissingGroupDescriptionColumnError(rAll.error)) {
      const r2 = await supabase.from('chat_conversations').select('title, group_image_url').eq('id', convId).maybeSingle();
      if (!r2.error && r2.data) convMeta = { ...r2.data, group_description: null };
      else if (r2.error && isMissingGroupImageUrlColumnError(r2.error)) {
        const r3 = await supabase.from('chat_conversations').select('title').eq('id', convId).maybeSingle();
        convMeta = r3.data ? { ...r3.data, group_image_url: null, group_description: null } : null;
      }
    } else if (rAll.error && isMissingGroupImageUrlColumnError(rAll.error)) {
      const r2 = await supabase.from('chat_conversations').select('title, group_description').eq('id', convId).maybeSingle();
      if (!r2.error && r2.data) convMeta = { ...r2.data, group_image_url: null };
      else if (r2.error && isMissingGroupDescriptionColumnError(r2.error)) {
        const r3 = await supabase.from('chat_conversations').select('title').eq('id', convId).maybeSingle();
        convMeta = r3.data ? { ...r3.data, group_image_url: null, group_description: null } : null;
      }
    }
    let creatorEmailForRoles = '';
    if (!rCreator.error && rCreator.data?.group_creator_email) {
      creatorEmailForRoles = normEmail(rCreator.data.group_creator_email);
    }

    if (convMeta) {
      const t = convMeta.title != null ? String(convMeta.title).trim() : '';
      const pic =
        convMeta.group_image_url != null && String(convMeta.group_image_url).trim()
          ? String(convMeta.group_image_url).trim()
          : null;
      const desc =
        convMeta.group_description != null && String(convMeta.group_description).trim()
          ? String(convMeta.group_description).trim()
          : null;
      group = {
        title: t || 'קבוצה',
        profileImageUrl: pic,
        description: desc,
        creatorEmail: creatorEmailForRoles || null,
      };
    } else if (creatorEmailForRoles) {
      group = { ...group, creatorEmail: creatorEmailForRoles };
    }

    const memberList = [];
    for (const p of parts || []) {
      const em = normEmail(p.user_id);
      if (!em) continue;
      memberList.push({
        userRef: p.user_id != null ? String(p.user_id).trim() : null,
        email: em,
        groupRole: resolvedGroupRole(p, creatorEmailForRoles),
        name: p.display_name != null && String(p.display_name).trim() ? String(p.display_name).trim() : null,
        participantProfileImageUrl:
          p.profile_picture_url != null && String(p.profile_picture_url).trim()
            ? String(p.profile_picture_url).trim()
            : null,
        profileImageUrl: null,
        subscriptionType: null,
      });
    }
    const memberEmails = [
      ...new Set(memberList.map((m) => m.email).filter((em) => em.includes('@'))),
    ];
    const memberIds = [
      ...new Set(
        memberList
          .map((m) => (m.userRef ? String(m.userRef).trim().toLowerCase() : ''))
          .filter((id) => id && CHAT_UUID_RE.test(id)),
      ),
    ];
    const subsByRef = new Map();
    const subSelect =
      'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url';
    const subLookups = [];
    if (memberEmails.length > 0) {
      subLookups.push(
        supabase.from('subscriptions').select(subSelect).in('email', memberEmails),
      );
    }
    if (memberIds.length > 0) {
      subLookups.push(
        supabase.from('subscriptions').select(subSelect).in('id', memberIds),
      );
    }
    if (subLookups.length > 0) {
      const subResults = await Promise.all(subLookups);
      for (const subsRes of subResults) {
        for (const sub of subsRes.data || []) {
          const emailKey = normEmail(sub.email);
          if (emailKey) subsByRef.set(emailKey, sub);
          if (sub.id != null) subsByRef.set(String(sub.id).trim().toLowerCase(), sub);
        }
      }
    }
    for (const m of memberList) {
      const sub =
        subsByRef.get(m.email) ||
        (m.userRef ? subsByRef.get(String(m.userRef).trim().toLowerCase()) : null);
      if (sub) {
        if (!m.name) m.name = subscriptionDisplayNameFromRow(sub);
        m.subscriptionType =
          sub?.subscription_type != null ? String(sub.subscription_type).trim().toLowerCase() : null;
        m.profileImageUrl = asPublicImageUrl(subscriptionProfilePicFromRow(sub));
      }
      if (!m.profileImageUrl && m.participantProfileImageUrl) {
        m.profileImageUrl = asPublicImageUrl(m.participantProfileImageUrl);
      }
      if (!m.name) m.name = m.email.includes('@') ? m.email.split('@')[0] : m.email || m.email;
    }
    memberList.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'));

    res.json({ success: true, messages: list, conversation_id: convId, group, members: memberList });
  } catch (err) {
    console.error('GET /api/chat/group-messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/group-messages — body: conversation_id, sender_email, body, optional media
app.post('/api/chat/group-messages', async (req, res) => {
  try {
    const senderEmail = normEmail(req.body.sender_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const bodyRaw = req.body.body != null ? String(req.body.body).trim() : '';
    const mediaTypeRaw = req.body.media_type != null ? String(req.body.media_type).trim().toLowerCase() : '';
    const mediaUrlRaw = req.body.media_url != null ? String(req.body.media_url).trim() : '';
    const mediaType = mediaTypeRaw === 'image' || mediaTypeRaw === 'audio' ? mediaTypeRaw : '';
    const mediaUrl = mediaUrlRaw;
    const listingIdRaw = req.body.listing_id != null ? String(req.body.listing_id).trim() : '';
    const listingIdForMessage =
      listingIdRaw && CHAT_LISTING_ID_UUID_RE.test(listingIdRaw) ? listingIdRaw : null;
    const listingShareToStore =
      req.body.listing_share === true ||
      req.body.listing_share === 'true' ||
      req.body.listing_share === 1 ||
      req.body.listing_share === '1';

    if (!senderEmail || !convId) return res.status(400).json({ success: false, error: 'sender_email and conversation_id required' });
    if (!bodyRaw && !mediaUrl) return res.status(400).json({ success: false, error: 'body or media_url required' });
    if (mediaUrl && !mediaType) return res.status(400).json({ success: false, error: 'media_type required with media_url' });

    const { data: parts } = await supabase.from('chat_participants').select('user_id').eq('conversation_id', convId);
    const members = (parts || []).map((p) => normEmail(p.user_id));
    if (!members.includes(senderEmail)) return res.status(403).json({ success: false, error: 'Not a participant' });

    let listingToStore = null;
    if (listingIdForMessage) {
      if (listingShareToStore) {
        listingToStore = listingIdForMessage;
      } else {
        const { data: adRow } = await supabase
          .from('ads')
          .select('id')
          .eq('id', listingIdForMessage)
          .maybeSingle();
        if (adRow?.id) listingToStore = listingIdForMessage;
      }
    }

    const insertPayload = {
      conversation_id: convId,
      sender_id: senderEmail,
      receiver_id: null,
      body: bodyRaw || '',
    };
    if (mediaType && mediaUrl) {
      insertPayload.media_type = mediaType;
      insertPayload.media_url = mediaUrl;
    }
    if (listingToStore) {
      insertPayload.listing_id = listingToStore;
    }
    if (listingShareToStore) {
      insertPayload.is_listing_share = true;
    }

    const { data: msg, error } = await supabase
      .from('chat_messages')
      .insert(insertPayload)
      .select('id, sender_id, body, created_at, media_type, media_url, listing_id, is_listing_share')
      .single();
    if (error) {
      const fallbackRow = { conversation_id: convId, sender_id: senderEmail, receiver_id: null, body: bodyRaw || '' };
      if (listingToStore) fallbackRow.listing_id = listingToStore;
      if (listingShareToStore) fallbackRow.is_listing_share = true;
      if (mediaType && mediaUrl) {
        fallbackRow.media_type = mediaType;
        fallbackRow.media_url = mediaUrl;
      }
      const fallback = await supabase
        .from('chat_messages')
        .insert(fallbackRow)
        .select('id, sender_id, body, created_at, media_type, media_url, listing_id, is_listing_share')
        .single();
      if (fallback.error) return res.status(500).json({ success: false, error: fallback.error.message });
      await supabase.from('chat_conversations').update({ last_message_at: fallback.data.created_at }).eq('id', convId);
      const fd = fallback.data;
      return res.json({
        success: true,
        message: {
          id: fd.id,
          senderId: fd.sender_id,
          body: fd.body,
          mediaType: fd.media_type || null,
          mediaUrl: fd.media_url || null,
          listingId: fd.listing_id != null ? String(fd.listing_id) : null,
          listingShare: fd.is_listing_share === true,
          createdAt: fd.created_at,
          isMe: true,
        },
      });
    }
    await supabase.from('chat_conversations').update({ last_message_at: msg.created_at }).eq('id', convId);
    res.json({
      success: true,
      message: {
        id: msg.id,
        senderId: msg.sender_id,
        body: msg.body,
        mediaType: msg.media_type || null,
        mediaUrl: msg.media_url || null,
        listingId: msg.listing_id != null ? String(msg.listing_id) : null,
        listingShare: msg.is_listing_share === true,
        createdAt: msg.created_at,
        isMe: true,
      },
    });
  } catch (err) {
    console.error('POST /api/chat/group-messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== PROFILE REVIEWS ====================
// POST /api/improvements-feedback – save product improvement suggestions
app.post('/api/improvements-feedback', async (req, res) => {
  try {
    const {
      rating,
      improvement_text,
      created_by_subscription_id,
      created_by_email,
      created_by_name,
      created_by_subscription_type,
      created_by_subscriber_number,
      source_screen,
    } = req.body || {};

    const numRating = rating != null ? parseInt(rating, 10) : null;
    if (numRating == null || Number.isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ success: false, error: 'rating must be 1–5' });
    }

    const improvementText = improvement_text != null ? String(improvement_text).trim() : '';
    if (!improvementText) {
      return res.status(400).json({ success: false, error: 'improvement_text is required' });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const creatorSubId =
      created_by_subscription_id && uuidRegex.test(String(created_by_subscription_id).trim())
        ? String(created_by_subscription_id).trim()
        : null;

    let creatorEmail =
      created_by_email && String(created_by_email).trim()
        ? String(created_by_email).trim().toLowerCase()
        : null;
    let creatorName =
      created_by_name && String(created_by_name).trim()
        ? String(created_by_name).trim()
        : null;
    let creatorType =
      created_by_subscription_type && String(created_by_subscription_type).trim()
        ? String(created_by_subscription_type).trim().toLowerCase()
        : null;
    let creatorSubscriberNumber =
      created_by_subscriber_number && String(created_by_subscriber_number).trim()
        ? String(created_by_subscriber_number).trim()
        : null;

    // Prefer canonical identity fields from subscriptions when we have a valid subscription id.
    if (creatorSubId) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select(
          'id, email, subscription_type, subscriber_number, name, contact_person_name, business_name, broker_office_name, profile_picture_url, company_logo_url',
        )
        .eq('id', creatorSubId)
        .maybeSingle();
      if (sub) {
        const { name } = getSubscriptionDisplayNameAndImage(sub);
        if (sub.email && String(sub.email).trim()) creatorEmail = String(sub.email).trim().toLowerCase();
        if (sub.subscription_type && String(sub.subscription_type).trim()) {
          creatorType = String(sub.subscription_type).trim().toLowerCase();
        }
        if (sub.subscriber_number && String(sub.subscriber_number).trim()) {
          creatorSubscriberNumber = String(sub.subscriber_number).trim();
        }
        if (name) creatorName = name;
      }
    }

    const rowToInsert = {
      rating: numRating,
      improvement_text: improvementText,
      created_by_subscription_id: creatorSubId,
      created_by_email: creatorEmail,
      created_by_name: creatorName,
      created_by_subscription_type: creatorType,
      created_by_subscriber_number: creatorSubscriberNumber,
      source_screen:
        source_screen && String(source_screen).trim() ? String(source_screen).trim() : 'feedbackSuggestion',
    };

    const { data: inserted, error } = await supabase
      .from('improvements_feedback')
      .insert(rowToInsert)
      .select(
        'id, rating, improvement_text, created_by_subscription_id, created_by_email, created_by_name, created_by_subscription_type, created_by_subscriber_number, source_screen, created_at',
      )
      .single();

    if (error) {
      console.error('POST /api/improvements-feedback error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, feedback: inserted });
  } catch (err) {
    console.error('POST /api/improvements-feedback:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/company-reports — report a company profile (saved to company_reports)
app.post('/api/company-reports', async (req, res) => {
  try {
    const body = req.body || {};
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reportedSubscriptionId =
      body.reported_subscription_id && uuidRegex.test(String(body.reported_subscription_id).trim())
        ? String(body.reported_subscription_id).trim()
        : null;
    if (!reportedSubscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'reported_subscription_id (uuid) is required',
      });
    }

    const reasonKeysIn = Array.isArray(body.reason_keys) ? body.reason_keys : [];
    const subjectTypeRaw = String(body.subject_type || 'company')
      .trim()
      .toLowerCase();
    const subject_type =
      subjectTypeRaw === 'broker'
        ? 'broker'
        : subjectTypeRaw === 'professional'
          ? 'professional'
          : subjectTypeRaw === 'bnb'
            ? 'bnb'
            : 'company';

    const allowedCompany = new Set([
      'construction_quality',
      'delivery_deadline',
      'apartment_spec',
      'plan_changed_no_notice',
      'marketing_promises',
      'other',
    ]);
    const allowedProfessional = new Set([
      'fictitious_listing',
      'listing_error',
      'listing_not_current',
      'wrong_phone_in_listing',
      'offensive_content',
      'other',
    ]);
    /** Figma 34:9182 — broker profile דווח על מתווך זה */
    const allowedBroker = new Set([
      'fictitious_listing',
      'listing_error',
      'listing_not_current',
      'wrong_phone_in_listing',
      'offensive_content',
      'broker_exclusivity_deadline',
      'price_or_details_mismatch',
      'business_listing_as_private',
      'other',
    ]);
    /** Figma 5:413570 — BnB profile report drawer */
    const allowedBnb = new Set([
      'fictitious_listing',
      'listing_error',
      'wrong_phone_in_listing',
      'offensive_content',
      'fraud',
      'other',
    ]);
    const allowed =
      subject_type === 'broker'
        ? allowedBroker
        : subject_type === 'professional'
          ? allowedProfessional
          : subject_type === 'bnb'
            ? allowedBnb
            : allowedCompany;

    const reason_keys = [
      ...new Set(
        reasonKeysIn
          .map(k => String(k || '').trim())
          .filter(k => allowed.has(k)),
      ),
    ];

    const description =
      body.description != null ? String(body.description).trim() : '';
    if (reason_keys.length === 0 && !description) {
      return res.status(400).json({
        success: false,
        error: 'Select at least one reason or enter a description',
      });
    }

    const reporter_name =
      body.reporter_name != null && String(body.reporter_name).trim()
        ? String(body.reporter_name).trim()
        : null;
    const reporter_email =
      body.reporter_email != null && String(body.reporter_email).trim()
        ? String(body.reporter_email).trim().toLowerCase()
        : null;
    if (!reporter_name || !reporter_email) {
      return res.status(400).json({
        success: false,
        error: 'reporter_name and reporter_email are required',
      });
    }

    const reporter_phone =
      body.reporter_phone != null && String(body.reporter_phone).trim()
        ? String(body.reporter_phone).trim()
        : null;

    const reported_listing_id =
      body.reported_listing_id && uuidRegex.test(String(body.reported_listing_id).trim())
        ? String(body.reported_listing_id).trim()
        : null;

    const reporter_subscription_id =
      body.reporter_subscription_id &&
      uuidRegex.test(String(body.reporter_subscription_id).trim())
        ? String(body.reporter_subscription_id).trim()
        : null;

    const company_display_name =
      body.company_display_name != null && String(body.company_display_name).trim()
        ? String(body.company_display_name).trim()
        : null;

    const row = {
      reported_subscription_id: reportedSubscriptionId,
      reported_listing_id,
      company_display_name,
      subject_type,
      reason_keys,
      description: description || null,
      reporter_name,
      reporter_phone,
      reporter_email,
      reporter_subscription_id,
    };

    const { data: inserted, error } = await supabase
      .from('company_reports')
      .insert(row)
      .select(
        'id, created_at, reported_subscription_id, reported_listing_id, subject_type, reason_keys, description, reporter_email',
      )
      .single();

    if (error) {
      console.error('POST /api/company-reports error:', error);
      const msg = error.message || 'insert failed';
      if (/relation|does not exist|schema cache/i.test(msg)) {
        return res.status(503).json({
          success: false,
          error:
            'Reports table not ready. Run migration-company-reports.sql in Supabase.',
        });
      }
      return res.status(500).json({ success: false, error: msg });
    }

    return res.json({ success: true, report: inserted });
  } catch (err) {
    console.error('POST /api/company-reports:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const FOLLOW_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeFollowSubId = value => {
  const s = value != null ? String(value).trim() : '';
  return s && FOLLOW_UUID_REGEX.test(s) ? s : null;
};
const followTypeLabel = type => {
  const t = String(type || '')
    .trim()
    .toLowerCase();
  if (t === 'broker') return 'תיווך';
  if (t === 'company') return 'חברה';
  if (t === 'professional') return 'מקצועי';
  return 'משתמש';
};

// POST /api/follows/request – create or refresh a follow request
app.post('/api/follows/request', async (req, res) => {
  try {
    const requesterId = normalizeFollowSubId(req.body?.requester_subscription_id);
    const targetId = normalizeFollowSubId(req.body?.target_subscription_id);
    if (!requesterId || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'requester_subscription_id and target_subscription_id are required',
      });
    }
    if (requesterId === targetId) {
      return res.status(400).json({ success: false, error: 'cannot follow yourself' });
    }

    const { data: targetSub, error: targetSubErr } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('id', targetId)
      .maybeSingle();
    if (targetSubErr) {
      return res.status(500).json({ success: false, error: targetSubErr.message });
    }
    if (!targetSub) {
      return res.status(404).json({
        success: false,
        error: 'target account not found',
      });
    }

    const { data: alreadyFollow } = await supabase
      .from('user_follows')
      .select('follower_subscription_id')
      .eq('follower_subscription_id', requesterId)
      .eq('following_subscription_id', targetId)
      .maybeSingle();
    if (alreadyFollow) {
      return res.json({ success: true, already_following: true, request: null });
    }

    const { data: row, error } = await supabase
      .from('user_follow_requests')
      .upsert(
        {
          requester_subscription_id: requesterId,
          target_subscription_id: targetId,
          status: 'pending',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'requester_subscription_id,target_subscription_id' },
      )
      .select(
        'id, requester_subscription_id, target_subscription_id, status, created_at, updated_at',
      )
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    return res.json({ success: true, already_following: false, request: row });
  } catch (err) {
    console.error('POST /api/follows/request:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/follows/requests/respond – accept/reject incoming request
app.post('/api/follows/requests/respond', async (req, res) => {
  try {
    const requestId = req.body?.request_id ? String(req.body.request_id).trim() : '';
    const actorId = normalizeFollowSubId(req.body?.actor_subscription_id);
    const action = String(req.body?.action || '')
      .trim()
      .toLowerCase();
    if (!requestId || !actorId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'request_id, actor_subscription_id and valid action are required' });
    }

    const { data: reqRow, error: reqErr } = await supabase
      .from('user_follow_requests')
      .select('id, requester_subscription_id, target_subscription_id, status')
      .eq('id', requestId)
      .maybeSingle();
    if (reqErr) return res.status(500).json({ success: false, error: reqErr.message });
    if (!reqRow) return res.status(404).json({ success: false, error: 'request not found' });
    if (String(reqRow.target_subscription_id) !== actorId) {
      return res.status(403).json({ success: false, error: 'not allowed to respond this request' });
    }
    if (reqRow.status !== 'pending') {
      return res.json({ success: true, request: reqRow, already_resolved: true });
    }

    if (action === 'accept') {
      const { error: followErr } = await supabase
        .from('user_follows')
        .upsert(
          {
            follower_subscription_id: reqRow.requester_subscription_id,
            following_subscription_id: reqRow.target_subscription_id,
          },
          { onConflict: 'follower_subscription_id,following_subscription_id' },
        );
      if (followErr) return res.status(500).json({ success: false, error: followErr.message });
    }

    const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
    const { data: updated, error: updErr } = await supabase
      .from('user_follow_requests')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .select('id, requester_subscription_id, target_subscription_id, status, created_at, updated_at')
      .single();
    if (updErr) return res.status(500).json({ success: false, error: updErr.message });
    return res.json({ success: true, request: updated });
  } catch (err) {
    console.error('POST /api/follows/requests/respond:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/follows/requests/cancel – requester withdraws a pending outgoing follow request
app.post('/api/follows/requests/cancel', async (req, res) => {
  try {
    const requesterId = normalizeFollowSubId(req.body?.requester_subscription_id);
    const targetId = normalizeFollowSubId(req.body?.target_subscription_id);
    if (!requesterId || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'requester_subscription_id and target_subscription_id are required',
      });
    }
    if (requesterId === targetId) {
      return res.status(400).json({ success: false, error: 'invalid target' });
    }
    const { data: deleted, error: delErr } = await supabase
      .from('user_follow_requests')
      .delete()
      .eq('requester_subscription_id', requesterId)
      .eq('target_subscription_id', targetId)
      .eq('status', 'pending')
      .select('id');
    if (delErr) {
      return res.status(500).json({ success: false, error: delErr.message });
    }
    if (!Array.isArray(deleted) || deleted.length === 0) {
      return res.json({ success: true, cancelled: false });
    }
    return res.json({ success: true, cancelled: true, id: deleted[0]?.id || null });
  } catch (err) {
    console.error('POST /api/follows/requests/cancel:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/follows/unfollow – remove follow relation
app.post('/api/follows/unfollow', async (req, res) => {
  try {
    const followerId = normalizeFollowSubId(req.body?.follower_subscription_id);
    const followingId = normalizeFollowSubId(req.body?.following_subscription_id);
    if (!followerId || !followingId) {
      return res.status(400).json({
        success: false,
        error: 'follower_subscription_id and following_subscription_id are required',
      });
    }
    if (followerId === followingId) {
      return res.status(400).json({success: false, error: 'cannot unfollow yourself'});
    }

    const {error} = await supabase
      .from('user_follows')
      .delete()
      .eq('follower_subscription_id', followerId)
      .eq('following_subscription_id', followingId);
    if (error) return res.status(500).json({success: false, error: error.message});

    return res.json({success: true});
  } catch (err) {
    console.error('POST /api/follows/unfollow:', err);
    return res.status(500).json({success: false, error: err.message});
  }
});

// GET /api/follows/status?viewer_id=...&target_id=...
app.get('/api/follows/status', async (req, res) => {
  try {
    const viewerId = normalizeFollowSubId(req.query?.viewer_id);
    const targetId = normalizeFollowSubId(req.query?.target_id);
    if (!viewerId || !targetId) {
      return res.status(400).json({ success: false, error: 'viewer_id and target_id are required' });
    }
    if (viewerId === targetId) {
      return res.json({
        success: true,
        is_self: true,
        is_following: false,
        has_pending_request: false,
      });
    }

    const { data: followRow } = await supabase
      .from('user_follows')
      .select('follower_subscription_id')
      .eq('follower_subscription_id', viewerId)
      .eq('following_subscription_id', targetId)
      .maybeSingle();
    const { data: pendingRow } = await supabase
      .from('user_follow_requests')
      .select('id')
      .eq('requester_subscription_id', viewerId)
      .eq('target_subscription_id', targetId)
      .eq('status', 'pending')
      .maybeSingle();

    return res.json({
      success: true,
      is_self: false,
      is_following: !!followRow,
      has_pending_request: !!pendingRow,
    });
  } catch (err) {
    console.error('GET /api/follows/status:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/follows/status-batch — { viewer_id, target_ids: string[] }
// Returns per-target is_following / has_pending_request for the viewer.
app.post('/api/follows/status-batch', async (req, res) => {
  try {
    const viewerId = normalizeFollowSubId(req.body?.viewer_id);
    const rawIds = req.body?.target_ids;
    const list = Array.isArray(rawIds) ? rawIds : [];
    if (!viewerId) {
      return res.status(400).json({success: false, error: 'viewer_id is required'});
    }
    const targetIds = [
      ...new Set(
        list
          .map(x => (x != null ? String(x).trim() : ''))
          .filter(s => s !== '' && s !== viewerId)
          .slice(0, 200),
      ),
    ];
    if (targetIds.length === 0) {
      return res.json({success: true, status: {}});
    }

    const [{data: followRows}, {data: pendingRows}] = await Promise.all([
      supabase
        .from('user_follows')
        .select('following_subscription_id')
        .eq('follower_subscription_id', viewerId)
        .in('following_subscription_id', targetIds),
      supabase
        .from('user_follow_requests')
        .select('target_subscription_id')
        .eq('requester_subscription_id', viewerId)
        .eq('status', 'pending')
        .in('target_subscription_id', targetIds),
    ]);

    const status = {};
    for (const id of targetIds) {
      status[id] = {is_following: false, has_pending_request: false};
    }
    for (const row of followRows || []) {
      const tid = String(row?.following_subscription_id || '').trim();
      if (status[tid]) status[tid].is_following = true;
    }
    for (const row of pendingRows || []) {
      const tid = String(row?.target_subscription_id || '').trim();
      if (status[tid]) status[tid].has_pending_request = true;
    }

    return res.json({success: true, status});
  } catch (err) {
    console.error('POST /api/follows/status-batch:', err);
    return res.status(500).json({success: false, error: err.message});
  }
});

// POST /api/follows/mutual-batch — { viewer_id, target_ids: string[] }
// For each target: true iff both follow each other in user_follows and no pending request from viewer.
app.post('/api/follows/mutual-batch', async (req, res) => {
  try {
    const viewerId = normalizeFollowSubId(req.body?.viewer_id);
    const rawIds = req.body?.target_ids;
    const list = Array.isArray(rawIds) ? rawIds : [];
    if (!viewerId) {
      return res.status(400).json({ success: false, error: 'viewer_id is required' });
    }
    const targetIds = [
      ...new Set(
        list
          .map(x => (x != null ? String(x).trim() : ''))
          .filter(s => s !== '' && s !== viewerId)
          .slice(0, 200),
      ),
    ];
    if (targetIds.length === 0) {
      return res.json({ success: true, mutual: {} });
    }

    const [{ data: iFollow }, { data: theyFollow }, { data: pendingOut }] = await Promise.all([
      supabase
        .from('user_follows')
        .select('following_subscription_id')
        .eq('follower_subscription_id', viewerId)
        .in('following_subscription_id', targetIds),
      supabase
        .from('user_follows')
        .select('follower_subscription_id')
        .eq('following_subscription_id', viewerId)
        .in('follower_subscription_id', targetIds),
      supabase
        .from('user_follow_requests')
        .select('target_subscription_id')
        .eq('requester_subscription_id', viewerId)
        .eq('status', 'pending')
        .in('target_subscription_id', targetIds),
    ]);

    const iFollowSet = new Set(
      (iFollow || [])
        .map(r => String(r?.following_subscription_id || ''))
        .filter(Boolean),
    );
    const theyFollowSet = new Set(
      (theyFollow || [])
        .map(r => String(r?.follower_subscription_id || ''))
        .filter(Boolean),
    );
    const pendingSet = new Set(
      (pendingOut || [])
        .map(r => String(r?.target_subscription_id || ''))
        .filter(Boolean),
    );

    const mutual = {};
    for (const id of targetIds) {
      if (
        iFollowSet.has(id) &&
        theyFollowSet.has(id) &&
        !pendingSet.has(id)
      ) {
        mutual[id] = true;
      }
    }
    return res.json({ success: true, mutual });
  } catch (err) {
    console.error('POST /api/follows/mutual-batch:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/follows/stats?user_id=...
app.get('/api/follows/stats', async (req, res) => {
  try {
    const userId = normalizeFollowSubId(req.query?.user_id);
    if (!userId) {
      return res.status(400).json({ success: false, error: 'user_id is required' });
    }

    const [
      { count: followers },
      { count: following },
      { count: pendingRequests },
      { count: followingOutgoingPending },
    ] = await Promise.all([
      supabase
        .from('user_follows')
        .select('following_subscription_id', { count: 'exact', head: true })
        .eq('following_subscription_id', userId),
      supabase
        .from('user_follows')
        .select('follower_subscription_id', { count: 'exact', head: true })
        .eq('follower_subscription_id', userId),
      supabase
        .from('user_follow_requests')
        .select('id', { count: 'exact', head: true })
        .eq('target_subscription_id', userId)
        .eq('status', 'pending'),
      supabase
        .from('user_follow_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_subscription_id', userId)
        .eq('status', 'pending'),
    ]);

    let likes = 0;
    try {
      const { data: likesRows } = await supabase
        .from('ads')
        .select('post_like_count')
        .eq('subscription_id', userId);
      likes = (likesRows || []).reduce(
        (sum, row) => sum + (Number(row?.post_like_count) || 0),
        0,
      );
    } catch (_) {}

    let mutualFollows = 0;
    try {
      const [{ data: whoFollowsMe }, { data: whoIFollow }] = await Promise.all([
        supabase
          .from('user_follows')
          .select('follower_subscription_id')
          .eq('following_subscription_id', userId),
        supabase
          .from('user_follows')
          .select('following_subscription_id')
          .eq('follower_subscription_id', userId),
      ]);
      const followerSet = new Set(
        (whoFollowsMe || [])
          .map(r => String(r?.follower_subscription_id || ''))
          .filter(Boolean),
      );
      (whoIFollow || []).forEach(r => {
        const id = String(r?.following_subscription_id || '');
        if (id && followerSet.has(id)) {
          mutualFollows += 1;
        }
      });
    } catch (_) {
      mutualFollows = 0;
    }

    return res.json({
      success: true,
      stats: {
        likes,
        followers: Number(followers || 0),
        // user_follows only (accepted). Pending outgoing requests are in following_outgoing_pending.
        following: Number(following || 0),
        pending_requests: Number(pendingRequests || 0),
        following_outgoing_pending: Number(followingOutgoingPending || 0),
        /** You follow them and they follow you (for עוקבים / highlights). */
        mutual_follows: Number(mutualFollows || 0),
      },
    });
  } catch (err) {
    console.error('GET /api/follows/stats:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/follows/hub?user_id=...&viewer_id=...&tab=requests|followers|following&q=...
app.get('/api/follows/hub', async (req, res) => {
  try {
    const userId = normalizeFollowSubId(req.query?.user_id);
    const viewerId = normalizeFollowSubId(req.query?.viewer_id);
    const tab = String(req.query?.tab || 'followers')
      .trim()
      .toLowerCase();
    const q = String(req.query?.q || '')
      .trim()
      .toLowerCase();
    if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
    if (!['requests', 'followers', 'following', 'likes'].includes(tab)) {
      return res.status(400).json({ success: false, error: 'tab must be requests|followers|following|likes' });
    }
    if (tab === 'requests' && viewerId !== userId) {
      return res.status(403).json({ success: false, error: 'requests are private to account owner' });
    }

    let relationRows = [];
    if (tab === 'likes') {
      // Everyone who liked any of this profile's POSTS (post likes only, not ad favorites).
      const { data: ownAds, error: adsErr } = await supabase
        .from('ads')
        .select('id')
        .eq('subscription_id', userId);
      if (adsErr) return res.status(500).json({ success: false, error: adsErr.message });
      const ownAdIds = (ownAds || []).map(r => r.id).filter(Boolean);
      if (ownAdIds.length === 0) {
        return res.json({ success: true, tab, rows: [] });
      }
      const { data: postLikeRows } = await supabase
        .from('post_likes')
        .select('user_id, created_at')
        .in('ad_id', ownAdIds);
      const byLiker = new Map();
      (postLikeRows || []).forEach(r => {
        const likerId = r?.user_id != null ? String(r.user_id) : '';
        if (!likerId) return;
        const existing = byLiker.get(likerId);
        // Keep the most recent like timestamp per liker.
        if (!existing || new Date(r.created_at) > new Date(existing.created_at)) {
          byLiker.set(likerId, { user_id: r.user_id, created_at: r.created_at });
        }
      });
      relationRows = [...byLiker.values()].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at),
      );
    } else if (tab === 'followers') {
      const { data, error } = await supabase
        .from('user_follows')
        .select('follower_subscription_id, created_at')
        .eq('following_subscription_id', userId)
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ success: false, error: error.message });
      relationRows = data || [];
    } else if (tab === 'following') {
      const [{ data: followRows, error: fErr }, { data: pendingRows, error: pErr }] =
        await Promise.all([
          supabase
            .from('user_follows')
            .select('following_subscription_id, created_at')
            .eq('follower_subscription_id', userId)
            .order('created_at', { ascending: false }),
          supabase
            .from('user_follow_requests')
            .select('id, target_subscription_id, created_at')
            .eq('requester_subscription_id', userId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false }),
        ]);
      if (fErr) {
        return res.status(500).json({ success: false, error: fErr.message });
      }
      if (pErr) {
        return res.status(500).json({ success: false, error: pErr.message });
      }
      const byTarget = new Map();
      (followRows || []).forEach(r => {
        if (!r?.following_subscription_id) {
          return;
        }
        const id = String(r.following_subscription_id);
        if (!byTarget.has(id)) {
          byTarget.set(id, {
            following_subscription_id: r.following_subscription_id,
            created_at: r.created_at,
            pending_request_id: null,
          });
        }
      });
      (pendingRows || []).forEach(r => {
        if (!r?.target_subscription_id) {
          return;
        }
        const id = String(r.target_subscription_id);
        if (!byTarget.has(id)) {
          byTarget.set(id, {
            following_subscription_id: r.target_subscription_id,
            created_at: r.created_at,
            pending_request_id: r.id,
          });
        }
      });
      relationRows = [...byTarget.values()].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at),
      );
    } else {
      const { data, error } = await supabase
        .from('user_follow_requests')
        .select('id, requester_subscription_id, created_at')
        .eq('target_subscription_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ success: false, error: error.message });
      relationRows = data || [];
    }

    const idField =
      tab === 'followers'
        ? 'follower_subscription_id'
        : tab === 'following'
          ? 'following_subscription_id'
          : tab === 'likes'
            ? 'user_id'
            : 'requester_subscription_id';
    const idsInOrder = relationRows.map(r => String(r[idField]));
    const uniqueIds = [...new Set(idsInOrder)];
    if (uniqueIds.length === 0) {
      return res.json({ success: true, tab, rows: [] });
    }

    const { data: subs, error: subsErr } = await supabase
      .from('subscriptions')
      .select(
        'id, email, subscription_type, name, contact_person_name, business_name, broker_office_name, profile_picture_url, company_logo_url',
      )
      .in('id', uniqueIds);
    if (subsErr) return res.status(500).json({ success: false, error: subsErr.message });
    const byId = {};
    (subs || []).forEach(s => {
      byId[String(s.id)] = s;
    });

    /** Subset of uniqueIds who follow `userId` (the profile) — for mutual on the "following" tab. */
    const theyFollowUserIdSet = new Set();
    {
      const { data: theyFollowMe } = await supabase
        .from('user_follows')
        .select('follower_subscription_id')
        .eq('following_subscription_id', userId)
        .in('follower_subscription_id', uniqueIds);
      (theyFollowMe || []).forEach(r => {
        const sid = String(r?.follower_subscription_id || '');
        if (sid) {
          theyFollowUserIdSet.add(sid);
        }
      });
    }

    const viewerFollowingSet = new Set();
    const viewerPendingSet = new Set();
    const viewerRatingAvgByTargetId = {};
    if (viewerId) {
      const { data: viewerFollowing } = await supabase
        .from('user_follows')
        .select('following_subscription_id')
        .eq('follower_subscription_id', viewerId)
        .in('following_subscription_id', uniqueIds);
      (viewerFollowing || []).forEach(r =>
        viewerFollowingSet.add(String(r.following_subscription_id)),
      );

      const { data: viewerPending } = await supabase
        .from('user_follow_requests')
        .select('target_subscription_id')
        .eq('requester_subscription_id', viewerId)
        .eq('status', 'pending')
        .in('target_subscription_id', uniqueIds);
      (viewerPending || []).forEach(r => {
        const tid = String(r.target_subscription_id || '');
        // If already following, ignore a leftover pending request so the hub still lists them.
        if (tid && !viewerFollowingSet.has(tid)) {
          viewerPendingSet.add(tid);
        }
      });

      const { data: viewerRatings } = await supabase
        .from('profile_reviews')
        .select('target_subscription_id, rating')
        .eq('reviewer_subscription_id', viewerId)
        .in('target_subscription_id', uniqueIds);
      const agg = {};
      (viewerRatings || []).forEach(r => {
        const target = String(r?.target_subscription_id || '');
        if (!target) return;
        if (!agg[target]) agg[target] = { sum: 0, count: 0 };
        agg[target].sum += Number(r?.rating) || 0;
        agg[target].count += 1;
      });
      Object.keys(agg).forEach(target => {
        const { sum, count } = agg[target];
        if (count > 0) viewerRatingAvgByTargetId[target] = sum / count;
      });
    }

    const rows = idsInOrder
      .map(id => {
        const sub = byId[id];
        if (!sub) return null;
        const relation = relationRows.find(r => String(r[idField]) === id);
        const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
        const subtitle = followTypeLabel(sub?.subscription_type);
        const isSelf = viewerId && viewerId === id;
        const isMutualFollow =
          (tab === 'followers' || tab === 'following') &&
          !!viewerId &&
          viewerId === userId &&
          !viewerPendingSet.has(id) &&
          (tab === 'followers'
            ? !!viewerFollowingSet.has(id) && !!theyFollowUserIdSet.has(id)
            : !!theyFollowUserIdSet.has(id) && !relation?.pending_request_id);
        return {
          id,
          request_id: tab === 'requests' ? relation?.id || null : null,
          /** Following tab: set when this row is an unapproved outgoing follow request. */
          outgoing_follow_pending:
            tab === 'following' && !!relation?.pending_request_id,
          /**
           * Own profile: "followers" — you follow this follower back;
           * "following" — this account also follows you. Not pending-only.
           */
          is_mutual_follow: isMutualFollow,
          name: name || 'משתמש',
          subtitle,
          subscription_type:
            sub?.subscription_type != null
              ? String(sub.subscription_type).trim().toLowerCase()
              : null,
          viewer_rating_avg:
            viewerRatingAvgByTargetId[id] != null
              ? Number(viewerRatingAvgByTargetId[id])
              : null,
          image_url: imageUrl,
          is_self: !!isSelf,
          is_following_by_viewer: !!viewerFollowingSet.has(id),
          has_pending_request_by_viewer: !!viewerPendingSet.has(id),
          created_at: relation?.created_at || null,
        };
      })
      .filter(Boolean)
      .filter(row => {
        if (!q) return true;
        const hay = `${row.name} ${row.subtitle}`.toLowerCase();
        return hay.includes(q);
      });

    return res.json({ success: true, tab, rows });
  } catch (err) {
    console.error('GET /api/follows/hub:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reviews?target_subscription_id=uuid – list reviews for a profile
app.get('/api/reviews', async (req, res) => {
  try {
    const targetId = typeof req.query.target_subscription_id === 'string' ? req.query.target_subscription_id.trim() : null;
    if (!targetId) {
      return res.status(400).json({ success: false, error: 'target_subscription_id required' });
    }
    let { data: rows, error } = await supabase
      .from('profile_reviews')
      .select('id, target_subscription_id, listing_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
      .eq('target_subscription_id', targetId)
      .order('created_at', { ascending: false });

    if (error && String(error.message || '').includes('listing_id')) {
      const retry = await supabase
        .from('profile_reviews')
        .select('id, target_subscription_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
        .eq('target_subscription_id', targetId)
        .order('created_at', { ascending: false });
      rows = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('GET /api/reviews error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const reviews = rows || [];
    const needEnrich = reviews.filter(r => r.reviewer_subscription_id && (!r.reviewer_name || !r.reviewer_image_url));
    if (needEnrich.length > 0) {
      const ids = [...new Set(needEnrich.map(r => r.reviewer_subscription_id))];
      const { data: subs } = await supabase
        .from('subscriptions')
        .select('id, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url')
        .in('id', ids);
      const byId = {};
      (subs || []).forEach(s => { byId[s.id] = s; });
      reviews.forEach(r => {
        if (!r.reviewer_subscription_id) return;
        const sub = byId[r.reviewer_subscription_id];
        const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
        if (name && !r.reviewer_name) r.reviewer_name = name;
        if (imageUrl && !r.reviewer_image_url) r.reviewer_image_url = imageUrl;
      });
    }
    res.json({ success: true, reviews });
  } catch (err) {
    console.error('GET /api/reviews:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: get display name and image URL for a subscription (all 4 types: broker, company, professional, user)
function getSubscriptionDisplayNameAndImage(sub) {
  if (!sub) return { name: null, imageUrl: null };
  const type = (sub.subscription_type || '').toLowerCase();
  let name = null;
  if (type === 'company') name = sub.business_name || sub.name || sub.contact_person_name || null;
  else if (type === 'broker') name = sub.broker_office_name || sub.name || sub.contact_person_name || null;
  else if (type === 'professional') name = sub.name || sub.business_name || sub.contact_person_name || null;
  else name = sub.name || sub.contact_person_name || sub.business_name || sub.broker_office_name || null;
  const imageUrl =
    sub.profile_picture_url ||
    ((type === 'company' || type === 'broker') ? sub.company_logo_url : null) ||
    null;
  return {
    name: name && String(name).trim() ? String(name).trim() : null,
    imageUrl: imageUrl && String(imageUrl).trim() ? String(imageUrl).trim() : null,
  };
}

// POST /api/reviews – add a review (rating 1–5 + optional comment)
app.post('/api/reviews', async (req, res) => {
  try {
    const {
      target_subscription_id,
      rating,
      comment,
      reviewer_name,
      reviewer_image_url,
      reviewer_subscription_id,
      listing_id: listingIdRaw,
    } = req.body || {};
    const targetId = target_subscription_id && String(target_subscription_id).trim() ? String(target_subscription_id).trim() : null;
    if (!targetId) {
      return res.status(400).json({ success: false, error: 'target_subscription_id required' });
    }
    const uuidRegexReviews = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let listingIdForReview = null;
    if (listingIdRaw != null && String(listingIdRaw).trim() !== '') {
      const cand = String(listingIdRaw).trim();
      if (uuidRegexReviews.test(cand)) {
        const { data: adRow, error: adErr } = await supabase
          .from('ads')
          .select('id, subscription_id, owner_id')
          .eq('id', cand)
          .maybeSingle();
        if (!adErr && adRow?.id) {
          const sub = adRow.subscription_id != null ? String(adRow.subscription_id).trim() : '';
          const owner = adRow.owner_id != null ? String(adRow.owner_id).trim() : '';
          if (
            (sub && sub === targetId) ||
            (owner && owner === targetId)
          ) {
            listingIdForReview = cand;
          }
        }
      }
    }
    const numRating = rating != null ? parseInt(rating, 10) : null;
    if (numRating == null || isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ success: false, error: 'rating must be 1–5' });
    }
    const commentStr = comment != null ? String(comment).trim() : '';
    const rawReviewerSubId = reviewer_subscription_id && String(reviewer_subscription_id).trim() ? String(reviewer_subscription_id).trim() : null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reviewerSubId = rawReviewerSubId && uuidRegex.test(rawReviewerSubId) ? rawReviewerSubId : null;

    let finalReviewerName = reviewer_name && String(reviewer_name).trim() ? String(reviewer_name).trim() : null;
    let finalReviewerImageUrl = reviewer_image_url && String(reviewer_image_url).trim() ? String(reviewer_image_url).trim() : null;

    if (reviewerSubId) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url')
        .eq('id', reviewerSubId)
        .maybeSingle();
      const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
      if (name) finalReviewerName = name;
      if (imageUrl) finalReviewerImageUrl = imageUrl;
    }

    const insertPayload = {
      target_subscription_id: targetId,
      reviewer_subscription_id: reviewerSubId || null,
      rating: numRating,
      comment: commentStr || null,
      reviewer_name: finalReviewerName,
      reviewer_image_url: finalReviewerImageUrl,
    };
    if (listingIdForReview) {
      insertPayload.listing_id = listingIdForReview;
    }

    let { data: row, error } = await supabase
      .from('profile_reviews')
      .insert(insertPayload)
      .select('id, target_subscription_id, listing_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
      .single();

    if (
      error &&
      insertPayload.listing_id &&
      (String(error.message || '').includes('listing_id') ||
        String(error.message || '').includes('schema cache'))
    ) {
      const fallbackPayload = { ...insertPayload };
      delete fallbackPayload.listing_id;
      const retry = await supabase
        .from('profile_reviews')
        .insert(fallbackPayload)
        .select('id, target_subscription_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
        .single();
      row = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('POST /api/reviews error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, review: row });
  } catch (err) {
    console.error('POST /api/reviews:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get current user subscription by email or subscriber number
app.get('/api/user/current', async (req, res) => {
  try {
    const { email, subscriberNumber } = req.query;
    const normalizedEmail =
      email && String(email).trim() ? String(email).trim().toLowerCase() : '';
    const normalizedSubscriberNumber =
      subscriberNumber && String(subscriberNumber).trim()
        ? String(subscriberNumber).trim()
        : '';

    console.log('[user/current] incoming lookup', {
      hasEmail: !!normalizedEmail,
      emailPreview: normalizedEmail ? normalizedEmail.slice(0, 3) : null,
      hasSubscriberNumber: !!normalizedSubscriberNumber,
      subscriberNumberPreview: normalizedSubscriberNumber
        ? `${normalizedSubscriberNumber.slice(0, 2)}***`
        : null,
    });

    if (!normalizedEmail && !normalizedSubscriberNumber) {
      console.warn('[user/current] rejected: missing email and subscriberNumber');
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscriber number is required' 
      });
    }

    let query = supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'verified'); // Only return verified subscriptions
    
    if (normalizedSubscriberNumber) {
      query = query.eq('subscriber_number', normalizedSubscriberNumber);
      console.log('[user/current] querying by subscriber_number');
    } else {
      query = query.eq('email', normalizedEmail);
      console.log('[user/current] querying by email');
    }
    
    const { data: subscription, error } = await query.maybeSingle();

    if (error) {
      console.warn('[user/current] query error', {
        errorCode: error?.code || null,
        errorMessage: error?.message || null,
        lookedUpBy: normalizedSubscriberNumber ? 'subscriber_number' : 'email',
      });
      return res.status(500).json({
        success: false,
        error: error.message || 'Query error',
      });
    }

    if (!subscription) {
      console.log('[user/current] not found', {
        lookedUpBy: normalizedSubscriberNumber ? 'subscriber_number' : 'email',
      });
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    console.log('[user/current] success', {
      subscriptionId: subscription?.id || null,
      subscriptionType: subscription?.subscription_type || null,
      status: subscription?.status || null,
    });

    res.json({
      success: true,
      subscription: sanitizeSubscriptionForClient(subscription),
    });

  } catch (error) {
    console.error('[user/current] unexpected error', {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== LISTINGS ENDPOINTS ====================

// ===== Smart feed ranking algorithm =====
//
// Goal:
//   Order ads/posts in the TikTok-style feed by:
//     final_score = match_score(0..1) × exposure_multiplier
//
// Match score is a per-user score derived from the items the user showed
// "high interest" in (favorites for listings, likes for posts, plus highly
// viewed/shared items). Exposure multiplier is the publisher-controlled
// reach knob saved on each ad.
//
// Notes that match the product spec:
//  - Listings (properties): users CAN'T like; saving to favorites (ad_likes)
//    counts as the strong positive signal.
//  - Posts: users CAN like (post_likes) but CAN'T favorite. Likes count as
//    the strong positive signal for posts.
//  - Private (regular-user) posts can't receive likes, so they don't drive
//    preference.
//  - Items with view_count / share_count / post_like_count above a threshold
//    are also treated as engaged interactions.
//  - Optional `feed_intent` ('properties' | 'entertainment') biases ranking
//    toward listings or posts.
//
// Public API used elsewhere in this file:
//   - buildUserPreferenceProfile(rows)                  -> profile
//   - scoreAdMatch(ad, profile)                         -> 0..1
//   - EXPOSURE_MULTIPLIER                               -> { low, medium, high }
//   - sortListingsByFeedAlgorithm(rows, userId, supa,
//                                 { intent } )         -> rows sorted

const EXPOSURE_MULTIPLIER = { low: 0.5, medium: 1, high: 1.5 };

// Threshold for considering an item "engaged with" via passive signals.
const FEED_ENGAGEMENT_THRESHOLDS = {
  minViewCount: 8,    // listing view counts are tracked via /listings/:id/view
  minShareCount: 1,
  minPostLikeCount: 5,
};

const median = (arr) => {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => Number(a) - Number(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? Number(s[mid]) : (Number(s[mid - 1]) + Number(s[mid])) / 2;
};

const freq = (arr) => {
  const m = {};
  (arr || []).forEach((x) => {
    if (x == null || x === '') return;
    m[x] = (m[x] || 0) + 1;
  });
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ value: k, count: v }));
};

const tokenizeAddress = (addr) => {
  if (!addr) return [];
  return String(addr)
    .split(/\s+|,|;/)
    .map((w) => w.trim().replace(/[^\w\u0590-\u05FF]/g, '').toLowerCase())
    .filter((w) => w.length >= 2);
};

// Build a preference profile from "engaged" ad rows.
// rows must include: price, category, purpose, rooms, area, address, feed_post
function buildUserPreferenceProfile(rows) {
  if (!rows || rows.length === 0) return null;
  const prices = [];
  const categories = [];
  const purposes = [];
  const roomsArr = [];
  const areas = [];
  const locationWords = new Set();
  let postCount = 0;
  let listingCount = 0;

  for (const r of rows) {
    if (r == null) continue;
    const p = r.price != null ? Number(r.price) : null;
    if (Number.isFinite(p)) prices.push(p);
    if (r.category != null) categories.push(r.category);
    if (r.purpose != null && String(r.purpose).trim()) purposes.push(r.purpose);
    if (r.rooms != null && Number.isFinite(Number(r.rooms))) roomsArr.push(Number(r.rooms));
    if (r.area != null && Number.isFinite(Number(r.area))) areas.push(Number(r.area));
    tokenizeAddress(r.address).forEach((w) => locationWords.add(w));
    if (r.feed_post === true || r.description === 'פוסט') postCount += 1;
    else listingCount += 1;
  }

  return {
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    priceMedian: median(prices),
    categoryFreq: freq(categories),
    purposeFreq: freq(purposes),
    roomsMedian: median(roomsArr),
    areaMedian: median(areas),
    locationWords,
    sampleSize: rows.length,
    postCount,
    listingCount,
  };
}

// Score how well a single ad matches the user's preference profile.
// Returns a number in [0, 1].
function scoreAdMatch(ad, pref) {
  if (!pref || pref.sampleSize === 0) return 0.5;

  const partials = []; // { score, weight }

  const adPrice = ad.price != null ? Number(ad.price) : null;
  if (pref.priceMedian != null && Number.isFinite(adPrice)) {
    const span = Math.max((pref.priceMax || pref.priceMedian) - (pref.priceMin || pref.priceMedian), 1);
    const dist = Math.min(Math.abs(adPrice - pref.priceMedian) / span, 1);
    partials.push({ score: 1 - dist, weight: 0.30 });
  }

  if (pref.categoryFreq.length > 0 && ad.category != null) {
    const top = pref.categoryFreq[0].value;
    const inSet = pref.categoryFreq.some((c) => Number(c.value) === Number(ad.category));
    const score = Number(ad.category) === Number(top) ? 1 : inSet ? 0.5 : 0.1;
    partials.push({ score, weight: 0.20 });
  }

  if (pref.purposeFreq.length > 0 && ad.purpose) {
    const top = String(pref.purposeFreq[0].value).toLowerCase();
    const inSet = pref.purposeFreq.some(
      (p) => String(p.value).toLowerCase() === String(ad.purpose).toLowerCase(),
    );
    const score = String(ad.purpose).toLowerCase() === top ? 1 : inSet ? 0.5 : 0.1;
    partials.push({ score, weight: 0.15 });
  }

  if (pref.locationWords.size > 0 && ad.address) {
    const adWords = tokenizeAddress(ad.address);
    if (adWords.length > 0) {
      const overlap = adWords.filter((w) => pref.locationWords.has(w)).length;
      const score = Math.min(1, overlap / adWords.length + 0.2);
      partials.push({ score, weight: 0.20 });
    }
  }

  if (pref.roomsMedian != null && ad.rooms != null) {
    const diff = Math.abs(Number(ad.rooms) - pref.roomsMedian);
    partials.push({ score: Math.max(0, 1 - diff / 4), weight: 0.10 });
  }

  if (pref.areaMedian != null && ad.area != null) {
    const range = Math.max(pref.areaMedian * 0.5, 1);
    const diff = Math.min(Math.abs(Number(ad.area) - pref.areaMedian) / range, 1);
    partials.push({ score: 1 - diff, weight: 0.05 });
  }

  if (partials.length === 0) return 0.5;
  const totalWeight = partials.reduce((s, p) => s + p.weight, 0);
  const weighted = partials.reduce((s, p) => s + p.score * p.weight, 0);
  return Math.max(0, Math.min(1, weighted / totalWeight));
}

// Detect intent based on engaged signals. If user mostly favorites listings -> 'properties'.
// If user mostly likes posts -> 'entertainment'. Returns null if not enough signal.
function detectFeedIntent(profile) {
  if (!profile || profile.sampleSize === 0) return null;
  const { postCount, listingCount } = profile;
  if (postCount + listingCount < 3) return null;
  if (postCount > listingCount * 1.5) return 'entertainment';
  if (listingCount > postCount * 1.5) return 'properties';
  return null;
}

function intentBias(row, intent) {
  if (!intent) return 1;
  const isPost = row.feed_post === true || row.description === 'פוסט';
  if (intent === 'properties') return isPost ? 0.7 : 1.1;
  if (intent === 'entertainment') return isPost ? 1.1 : 0.7;
  return 1;
}

// Smart feed sort.
// `options.intent` can be 'properties' | 'entertainment' | null (auto-detected).
async function sortListingsByFeedAlgorithm(adsRows, userIdParam, supabaseClient, options = {}) {
  if (!adsRows || adsRows.length === 0) return adsRows;

  // Without a user we can only rank by exposure.
  if (!userIdParam) {
    const ranked = adsRows.map((row) => {
      const lvl = (row.exposure_level || 'medium').toLowerCase();
      const mult = EXPOSURE_MULTIPLIER[lvl] ?? 1;
      return { row, finalScore: mult };
    });
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return ranked.map((x) => x.row);
  }

  // Collect "engaged" ad ids: favorites (ad_likes) + post likes (post_likes).
  let favoriteAdIds = [];
  try {
    const { data } = await supabaseClient
      .from('ad_likes')
      .select('ad_id')
      .eq('user_id', userIdParam);
    favoriteAdIds = (data || []).map((r) => r.ad_id).filter(Boolean);
  } catch (_) {
    favoriteAdIds = [];
  }

  let likedPostAdIds = [];
  try {
    const { data } = await supabaseClient
      .from('post_likes')
      .select('ad_id')
      .eq('user_id', userIdParam);
    likedPostAdIds = (data || []).map((r) => r.ad_id).filter(Boolean);
  } catch (_) {
    likedPostAdIds = [];
  }

  const directEngagedIds = [...new Set([...favoriteAdIds, ...likedPostAdIds])];

  // Add highly engaged items (passive signals) within the current candidate set.
  const passiveEngagedIds = adsRows
    .filter((row) => {
      const views = Number(row.view_count || 0);
      const shares = Number(row.share_count || 0);
      const postLikes = Number(row.post_like_count || 0);
      return (
        views >= FEED_ENGAGEMENT_THRESHOLDS.minViewCount ||
        shares >= FEED_ENGAGEMENT_THRESHOLDS.minShareCount ||
        postLikes >= FEED_ENGAGEMENT_THRESHOLDS.minPostLikeCount
      );
    })
    .map((row) => row.id);

  const engagedIdSet = new Set([...directEngagedIds, ...passiveEngagedIds]);

  // No signal at all -> rank by exposure only (per spec).
  if (engagedIdSet.size === 0) {
    const ranked = adsRows.map((row) => {
      const lvl = (row.exposure_level || 'medium').toLowerCase();
      const mult = EXPOSURE_MULTIPLIER[lvl] ?? 1;
      return { row, finalScore: mult };
    });
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return ranked.map((x) => x.row);
  }

  // Fetch the engaged rows (need price/category/purpose/rooms/area/address/feed_post).
  let engagedRows = [];
  try {
    const ids = Array.from(engagedIdSet);
    const { data } = await supabaseClient
      .from('ads')
      .select('id, price, category, purpose, rooms, area, address, feed_post, description')
      .in('id', ids);
    engagedRows = data || [];
  } catch (_) {
    engagedRows = adsRows.filter((row) => engagedIdSet.has(row.id));
  }

  const profile = buildUserPreferenceProfile(engagedRows);
  const intent = options.intent || detectFeedIntent(profile);

  const ranked = adsRows.map((row) => {
    const matchScore = scoreAdMatch(row, profile);
    const lvl = (row.exposure_level || 'medium').toLowerCase();
    const mult = EXPOSURE_MULTIPLIER[lvl] ?? 1;
    const bias = intentBias(row, intent);
    const finalScore = matchScore * mult * bias;
    return { row, finalScore };
  });
  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked.map((x) => x.row);
}

// Backwards-compatible alias used elsewhere in this file.
function buildPreferenceFromLikedAds(rows) {
  return buildUserPreferenceProfile(rows);
}

// GET /api/listings - optional: category, subscription_type, has_video, condition, search_purpose, feed_post, hospitality_nature, land_in_mortgage, permit
// Optional query: user_id - if provided, each listing gets liked: true/false and feed is sorted by smart algorithm (preferences from likes + exposure level).
// Media (images/video) are stored in bucket user-photo-video; URLs are in ads row.
app.get('/api/listings', async (req, res) => {
  try {
    const status = req.query.status || 'published';
    const category = req.query.category ? parseInt(req.query.category, 10) : null;
    const subscriptionTypeParam = typeof req.query.subscription_type === 'string' ? req.query.subscription_type.trim() : null;
    const hasVideo = req.query.has_video === 'true' || req.query.has_video === true;
    const conditionParam =
      typeof req.query.condition === 'string' ? req.query.condition.trim().toLowerCase() : '';
    const allowedListingConditions = new Set(['new', 'renovated', 'old']);
    const applyConditionFilter = (q) => {
      if (!allowedListingConditions.has(conditionParam)) return q;
      if (conditionParam === 'new') return q.in('condition', ['new', 'חדש']);
      if (conditionParam === 'renovated') return q.in('condition', ['renovated', 'משופץ']);
      if (conditionParam === 'old') return q.in('condition', ['old', 'ישן']);
      return q;
    };
    const subscriptionIdParam = typeof req.query.subscription_id === 'string' ? req.query.subscription_id.trim() : null;
    const userIdParam = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : null;
    // 'properties' | 'entertainment' (caller-controlled). When omitted the algorithm tries to detect intent.
    const feedIntentParam = typeof req.query.feed_intent === 'string'
      ? req.query.feed_intent.trim().toLowerCase()
      : '';
    const feedIntent = ['properties', 'entertainment'].includes(feedIntentParam)
      ? feedIntentParam
      : null;
    // שותפים (category 3) feed: filter by roommate search intent or graphic posts
    const searchPurposeParam =
      typeof req.query.search_purpose === 'string' ? req.query.search_purpose.trim().toLowerCase() : '';
    const allowedSearchPurposes = new Set(['enter', 'bring_in', 'partner']);
    const feedPostOnly =
      req.query.feed_post === 'true' || req.query.feed_post === true;
    const applySearchPurposeAndFeedPost = (q) => {
      let out = q;
      if (searchPurposeParam && allowedSearchPurposes.has(searchPurposeParam)) {
        out = out.eq('search_purpose', searchPurposeParam);
      }
      if (feedPostOnly) {
        // Match feed posts like `isPostListingRow` / client `isFeedPost` — not only description = 'פוסט'
        out = out.or(
          'feed_post.eq.true,description.eq.פוסט,description.eq.post,property_type.ilike.*post*',
        );
      }
      return out;
    };
    // BnB (category 5): אופי האירוח — must match HospitalityNature / ads.hospitality_nature
    const hospitalityNatureParam =
      typeof req.query.hospitality_nature === 'string'
        ? req.query.hospitality_nature.trim()
        : '';
    const allowedHospitalityNatures = new Set([
      'landscapes',
      'on_the_beach',
      'with_pool',
      'nature',
      'experiences',
      'special',
      'rural',
      'desert',
    ]);
    const applyHospitalityNature = (q) => {
      if (!hospitalityNatureParam || !allowedHospitalityNatures.has(hospitalityNatureParam)) {
        return q;
      }
      return q.eq('hospitality_nature', hospitalityNatureParam);
    };
    // קרקעות (category 7) sidebar: מושב / היתר — match ads.land_in_mortgage / ads.permit (canonical codes: yes, there_is, …)
    const landInMortgageParam =
      typeof req.query.land_in_mortgage === 'string'
        ? req.query.land_in_mortgage.trim()
        : '';
    const permitParam =
      typeof req.query.permit === 'string' ? req.query.permit.trim() : '';
    const planApprovalParam =
      typeof req.query.plan_approval === 'string'
        ? req.query.plan_approval.trim()
        : '';
    const applyLandSidebar = (q) => {
      let out = q;
      if (landInMortgageParam) {
        if (landInMortgageParam === 'yes') {
          // Canonical code + legacy Hebrew from older clients
          out = out.or('land_in_mortgage.eq.yes,land_in_mortgage.eq.כן');
        } else {
          out = out.eq('land_in_mortgage', landInMortgageParam);
        }
      }
      if (permitParam) {
        if (permitParam === 'there_is') {
          out = out.or('permit.eq.there_is,permit.eq.יש');
        } else {
          out = out.eq('permit', permitParam);
        }
      }
      if (planApprovalParam) {
        // תב״ע: "there_is" means a plan exists — match there_is/approved (happy) + legacy Hebrew.
        if (planApprovalParam === 'there_is') {
          out = out.or(
            'plan_approval.eq.there_is,plan_approval.eq.happy,plan_approval.eq.יש,plan_approval.eq.מאושרת',
          );
        } else {
          out = out.eq('plan_approval', planApprovalParam);
        }
      }
      return out;
    };
    const favoritesOnly =
      req.query.favorites_only === 'true' ||
      req.query.favorites_only === true ||
      req.query.liked_only === 'true';

    let favoriteAdIds = null;
    if (favoritesOnly) {
      if (!userIdParam) {
        return res.status(400).json({
          success: false,
          error: 'user_id is required when favorites_only=true',
        });
      }
      try {
        const { data: likeRows, error: likeErr } = await supabase
          .from('ad_likes')
          .select('ad_id')
          .eq('user_id', userIdParam);
        if (likeErr) {
          console.warn('ad_likes query (favorites):', likeErr.message);
        }
        let postRows = [];
        try {
          const { data, error: postErr } = await supabase
            .from('post_likes')
            .select('ad_id')
            .eq('user_id', userIdParam);
          if (postErr) {
            console.warn('post_likes query (favorites):', postErr.message);
          } else {
            postRows = data || [];
          }
        } catch (e) {
          console.warn('post_likes favorites:', e.message);
        }
        favoriteAdIds = [...new Set([...(likeRows || []), ...postRows].map((r) => r.ad_id).filter(Boolean))];
      } catch (e) {
        console.warn('ad_likes favorites:', e.message);
        favoriteAdIds = [];
      }
      if (!favoriteAdIds || favoriteAdIds.length === 0) {
        return res.json({ success: true, listings: [] });
      }
    }

    const allowedSubscriptionTypes = ['user', 'broker', 'company', 'professional'];
    const subscriptionTypes = subscriptionTypeParam
      ? subscriptionTypeParam.split(',').map(s => s.trim()).filter(s => allowedSubscriptionTypes.includes(s))
      : [];

    // BnB (5) + שותפים (3): public feed is regular-user ads only.
    // Exception: שותפים "נותני שירות" may request subscription_type=professional.
    // Owner view (subscription_id) keeps all of that owner's ads unfiltered by type.
    const REGULAR_USER_ONLY_CATEGORIES = new Set([3, 5]);
    const isOwnerViewEarly =
      !favoritesOnly && subscriptionIdParam != null && subscriptionIdParam.trim() !== '';
    const isRegularUserOnlyCategory =
      category != null &&
      !isNaN(category) &&
      REGULAR_USER_ONLY_CATEGORIES.has(category);
    let effectiveSubscriptionTypes = subscriptionTypes;
    if (isRegularUserOnlyCategory && !favoritesOnly && !isOwnerViewEarly) {
      const wantsProfessionalOnly =
        category === 3 &&
        subscriptionTypes.length === 1 &&
        subscriptionTypes[0] === 'professional';
      if (!wantsProfessionalOnly) {
        effectiveSubscriptionTypes = ['user'];
      }
    }

    let query = supabase
      .from('ads')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (favoriteAdIds && favoriteAdIds.length > 0) {
      query = query.in('id', favoriteAdIds);
    }

    // Favorites: optional category (from feed) narrows to that category; omit for all categories.
    if (category && !isNaN(category)) {
      query = query.eq('category', category);
    }
    // Other feed-only filters never apply to favorites_only (avoid hiding cross-category likes).
    if (!favoritesOnly) {
      if (effectiveSubscriptionTypes.length === 1) {
        query = query.eq('subscription_type', effectiveSubscriptionTypes[0]);
      } else if (effectiveSubscriptionTypes.length > 1) {
        query = query.in('subscription_type', effectiveSubscriptionTypes);
      }
      if (hasVideo) {
        query = query.not('video_url', 'is', null);
      }
      query = applyConditionFilter(query);
      query = applySearchPurposeAndFeedPost(query);
      query = applyHospitalityNature(query);
      query = applyLandSidebar(query);
    }
    // subscription_id param = "owner view" (Edit/Publish Ad): show that owner's ads including frozen
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validSubscriptionId = subscriptionIdParam && uuidRegex.test(subscriptionIdParam) ? subscriptionIdParam : null;
    const isOwnerView =
      !favoritesOnly && subscriptionIdParam != null && subscriptionIdParam.trim() !== '';
    if (isOwnerView) {
      if (validSubscriptionId) {
        query = query.eq('subscription_id', validSubscriptionId);
      } else {
        query = query.eq('owner_id', subscriptionIdParam.trim());
      }
      // Owner view: do not filter by is_frozen so frozen ads still appear in "my listings"
    } else {
      // Public feed: exclude frozen ads
      query = query.or('is_frozen.is.null,is_frozen.eq.false');
    }

    let result = await query;
    let { data: adsRows, error } = result;

    // If column doesn't exist or not in schema cache (is_frozen), retry without that filter
    const isFrozenColumnError = error && (
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      (error.message && String(error.message).includes('is_frozen'))
    );
    if (isFrozenColumnError) {
      let fallbackQuery = supabase
        .from('ads')
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: false });
      if (favoriteAdIds && favoriteAdIds.length > 0) {
        fallbackQuery = fallbackQuery.in('id', favoriteAdIds);
      }
      if (category && !isNaN(category)) {
        fallbackQuery = fallbackQuery.eq('category', category);
      }
      if (!favoritesOnly) {
        if (effectiveSubscriptionTypes.length === 1) {
          fallbackQuery = fallbackQuery.eq('subscription_type', effectiveSubscriptionTypes[0]);
        } else if (effectiveSubscriptionTypes.length > 1) {
          fallbackQuery = fallbackQuery.in('subscription_type', effectiveSubscriptionTypes);
        }
        if (hasVideo) {
          fallbackQuery = fallbackQuery.not('video_url', 'is', null);
        }
        fallbackQuery = applyConditionFilter(fallbackQuery);
        fallbackQuery = applySearchPurposeAndFeedPost(fallbackQuery);
        fallbackQuery = applyHospitalityNature(fallbackQuery);
        fallbackQuery = applyLandSidebar(fallbackQuery);
      }
      if (isOwnerView) {
        if (validSubscriptionId) fallbackQuery = fallbackQuery.eq('subscription_id', validSubscriptionId);
        else fallbackQuery = fallbackQuery.eq('owner_id', subscriptionIdParam.trim());
      }
      result = await fallbackQuery;
      adsRows = result.data;
      error = result.error;
    }

    if (error) {
      console.error('Error fetching listings:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch listings',
        details: error.message
      });
    }

    // Smart feed: when user_id provided and not owner view, sort by preference match (from liked ads) × exposure level
    if (userIdParam && !isOwnerView && adsRows && adsRows.length > 0 && !favoritesOnly) {
      try {
        adsRows = await sortListingsByFeedAlgorithm(adsRows, userIdParam, supabase, {
          intent: feedIntent,
        });
      } catch (err) {
        console.warn('Feed algorithm sort failed, using default order:', err.message);
      }
    }

    // Optionally get liked ad ids for this user (view_count/like_count are on row; ensure they exist)
    let likedAdIds = new Set();
    let likedPostIds = new Set();
    if (favoritesOnly && adsRows && adsRows.length > 0) {
      adsRows.forEach((r) => {
        if (!r?.id) return;
        if (isPostListingRow(r)) likedPostIds.add(r.id);
        else likedAdIds.add(r.id);
      });
    } else if (userIdParam && adsRows && adsRows.length > 0) {
      try {
        const adIds = adsRows.map(r => r.id).filter(Boolean);
        const adRowById = new Map(adsRows.map(r => [r.id, r]));
        const { data: likesRows } = await supabase
          .from('ad_likes')
          .select('ad_id')
          .eq('user_id', userIdParam)
          .in('ad_id', adIds);
        if (likesRows && likesRows.length) {
          likesRows.forEach((r) => {
            if (!r.ad_id) return;
            const sourceRow = adRowById.get(r.ad_id);
            if (isPostListingRow(sourceRow)) likedPostIds.add(r.ad_id);
            else likedAdIds.add(r.ad_id);
          });
        }
      } catch (_) { /* ad_likes table may not exist yet */ }
      try {
        const adIds = adsRows.map(r => r.id).filter(Boolean);
        const { data: postRows } = await supabase
          .from('post_likes')
          .select('ad_id')
          .eq('user_id', userIdParam)
          .in('ad_id', adIds);
        if (postRows && postRows.length) {
          postRows.forEach(r => { if (r.ad_id) likedPostIds.add(r.ad_id); });
        }
      } catch (_) { /* post_likes table may not exist yet */ }
    }

    // Fetch creator (uploader) info from subscriptions for profile/chat display name
    const creatorBySubId = {};
    const fromSubscriptionId = [...new Set((adsRows || []).map(r => r.subscription_id).filter(Boolean))];
    const fromOwnerId = [...new Set((adsRows || []).map(r => r.owner_id).filter(Boolean).filter(id => uuidRegex.test(String(id))))];
    const subIds = [...new Set([...fromSubscriptionId, ...fromOwnerId])];
    if (subIds.length > 0) {
      try {
        const { data: subs } = await supabase
          .from('subscriptions')
          .select(SUBSCRIPTION_SELECT)
          .in('id', subIds);
        if (subs && subs.length) {
          subs.forEach(s => {
            // Display name by registration type (subscriptions has no agent_name column; broker agent is in "name")
            let displayName = null;
            const type = (s.subscription_type || '').toLowerCase();
            if (type === 'company') {
              displayName = s.business_name || s.name || s.contact_person_name || null;
            } else if (type === 'broker') {
              displayName = s.broker_office_name || s.name || s.contact_person_name || null;
            } else {
              displayName = s.name || s.business_name || s.contact_person_name || null;
            }
            let creatorSpecialties = null;
            if (s.specializations != null) {
              if (Array.isArray(s.specializations)) creatorSpecialties = s.specializations;
              else if (typeof s.specializations === 'string') {
                try {
                  const parsed = JSON.parse(s.specializations);
                  creatorSpecialties = Array.isArray(parsed) ? parsed : s.specializations.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorSpecialties = s.specializations.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            let creatorActivityRegions = null;
            if (s.activity_regions != null) {
              if (Array.isArray(s.activity_regions)) creatorActivityRegions = s.activity_regions;
              else if (typeof s.activity_regions === 'string') {
                try {
                  const parsed = JSON.parse(s.activity_regions);
                  creatorActivityRegions = Array.isArray(parsed) ? parsed : s.activity_regions.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorActivityRegions = s.activity_regions.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            let creatorTypes = null;
            if (s.types != null) {
              if (Array.isArray(s.types)) creatorTypes = s.types;
              else if (typeof s.types === 'string') {
                try {
                  const parsed = JSON.parse(s.types);
                  creatorTypes = Array.isArray(parsed) ? parsed : s.types.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorTypes = s.types.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            creatorBySubId[s.id] = {
              creator_email: s.email || null,
              creator_name: displayName || null,
              creator_profile_image_url:
                s.profile_picture_url ||
                (type === 'company' ? s.company_logo_url : null) ||
                null,
              creator_subscription_type:
                s.subscription_type != null && String(s.subscription_type).trim() !== ''
                  ? String(s.subscription_type).trim()
                  : null,
              creator_specialties: creatorSpecialties || null,
              creator_activity_regions: creatorActivityRegions || null,
              creator_types: creatorTypes || null,
              creator_bio: (s.description && String(s.description).trim()) ? String(s.description).trim() : null,
              creator_business_address:
                s.business_address && String(s.business_address).trim()
                  ? String(s.business_address).trim()
                  : null,
            };
          });
        }
      } catch (_) {
        try {
          const { data: subs } = await supabase
            .from('subscriptions')
            .select('id, email, name, contact_person_name, subscription_type')
            .in('id', subIds);
          if (subs && subs.length) {
            subs.forEach(s => {
              const name = s.name || s.contact_person_name || null;
              creatorBySubId[s.id] = {
                creator_email: s.email || null,
                creator_name: name || null,
                creator_subscription_type:
                  s.subscription_type != null && String(s.subscription_type).trim() !== ''
                    ? String(s.subscription_type).trim()
                    : null,
              };
            });
          }
        } catch (_) { /* ignore */ }
      }
      // Regular users (e.g. user-xxx) are not in subscriptions; use chat_participants for creator name/pic
      const missingSubIds = subIds.filter((id) => !creatorBySubId[id]);
      if (missingSubIds.length > 0) {
        try {
          const { data: participantRows } = await supabase
            .from('chat_participants')
            .select('user_id, display_name, profile_picture_url')
            .in('user_id', missingSubIds);
          const byUser = {};
          (participantRows || []).forEach((p) => {
            if (p.user_id && !byUser[p.user_id] && (p.display_name || p.profile_picture_url)) {
              byUser[p.user_id] = {
                creator_email: null,
                creator_name: p.display_name || null,
                creator_profile_image_url: p.profile_picture_url || null,
              };
            }
          });
          Object.assign(creatorBySubId, byUser);
        } catch (_) { /* ignore */ }
      }
    }

    /** Per-ad profile reviews (listing_id set on profile_reviews). Omit if column/table unavailable. */
    const reviewCountByListingId = {};
    try {
      const listingIdsForReviews = [...new Set((adsRows || []).map((r) => r.id).filter(Boolean))];
      if (listingIdsForReviews.length > 0) {
        const { data: rcRows, error: rcErr } = await supabase
          .from('profile_reviews')
          .select('listing_id')
          .in('listing_id', listingIdsForReviews)
          .not('listing_id', 'is', null);
        if (!rcErr && rcRows && rcRows.length > 0) {
          rcRows.forEach((r) => {
            const lid = r.listing_id != null ? String(r.listing_id) : '';
            if (!lid) return;
            reviewCountByListingId[lid] = (reviewCountByListingId[lid] || 0) + 1;
          });
        }
      }
    } catch (_) {
      /* missing listing_id column or profile_reviews */
    }

    // Shape for frontend: add listing_images, listing_videos, view_count, like_count, liked, creator_*
    const listings = (adsRows || []).map((row) => {
      const isPostRow = isPostListingRow(row);
      const creator = (row.subscription_id && creatorBySubId[row.subscription_id])
        ? creatorBySubId[row.subscription_id]
        : (row.owner_id && creatorBySubId[row.owner_id])
          ? creatorBySubId[row.owner_id]
          : {};
      // Prefer creator saved on the ad at upload time (real uploader details)
      const listing_images = [];
      if (row.main_image_url) {
        listing_images.push({ image_url: row.main_image_url, image_type: 'main' });
      }
      const additional = Array.isArray(row.additional_image_urls) ? row.additional_image_urls : [];
      additional.forEach((url) => {
        if (url) listing_images.push({ image_url: url, image_type: 'additional' });
      });
      const videoFields = muxVideo.shapeListingVideoFields(row);
      const listing_videos = videoFields.listing_videos;
      const lidStr = row.id != null ? String(row.id) : '';
      return {
        ...row,
        video_playback_url: videoFields.video_playback_url,
        review_count: lidStr ? (reviewCountByListingId[lidStr] ?? 0) : 0,
        view_count: row.view_count != null ? Number(row.view_count) : 0,
        like_count: row.like_count != null ? Number(row.like_count) : 0,
        post_like_count:
          row.post_like_count != null
            ? Number(row.post_like_count)
            : (row.like_count != null ? Number(row.like_count) : 0),
        liked: userIdParam
          ? (isPostRow ? likedPostIds.has(row.id) : likedAdIds.has(row.id))
          : undefined,
        listing_images,
        listing_videos,
        is_frozen: row.is_frozen === true || row.is_frozen === 't',
        creator_name: row.creator_name ?? creator.creator_name ?? null,
        creator_email: row.creator_email ?? creator.creator_email ?? null,
        creator_profile_image_url: row.profile_image_url ?? creator.creator_profile_image_url ?? null,
        creator_subscription_type: creator.creator_subscription_type ?? null,
        subscription_type:
          creator.creator_subscription_type ??
          row.subscription_type ??
          row.created_by_subscription_type ??
          null,
        creator_specialties: creator.creator_specialties || null,
        creator_activity_regions: creator.creator_activity_regions || null,
        creator_types: creator.creator_types || null,
        creator_bio: creator.creator_bio || null,
        creator_business_address: creator.creator_business_address || null
      };
    });

    res.json({
      success: true,
      listings
    });
  } catch (error) {
    console.error('Error in GET /api/listings:', error);
    const isNetworkError =
      error.message === 'fetch failed' ||
      (error.cause && typeof error.cause.message === 'string') ||
      (error.message && String(error.message).includes('fetch failed')) ||
      (error.code && ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code));
    if (isNetworkError) {
      // Return empty listings so the app can load instead of showing a hard error
      console.warn('Supabase unreachable; returning empty listings.');
      return res.status(200).json({
        success: true,
        listings: [],
        offline: true,
        message: 'Could not reach database. Showing empty feed.'
      });
    }
    const message = error.message || 'Failed to fetch listings';
    res.status(500).json({
      success: false,
      error: message,
      details: error.cause?.message || error.message
    });
  }
});

// ==================== STORIES (separate from ads) ====================

function subscriptionDisplayNameForStory(sub) {
  if (!sub) return 'משתמש';
  const type = String(sub.subscription_type || '').toLowerCase();
  if (type === 'company') {
    return sub.business_name || sub.name || sub.contact_person_name || 'משתמש';
  }
  if (type === 'broker') {
    return sub.broker_office_name || sub.name || sub.contact_person_name || 'משתמש';
  }
  return sub.name || sub.business_name || sub.contact_person_name || 'משתמש';
}

function storyHasVideoUrl(u) {
  return u != null && String(u).trim().length > 0;
}

function storyMediaTypeFromUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return 'image';
  if (/\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(s)) return 'video';
  if (/\/videos?\//i.test(s)) return 'video';
  return 'image';
}

const SUBSCRIPTION_SELECT_STORY =
  'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url, video_url, video_hls_url, video_status, status, updated_at';

// GET /api/stories/feed — strip: profile intro video + explicit story slides only.
// TikTok feed posts (ads.feed_post) are never mirrored here.
app.get('/api/stories/feed', async (req, res) => {
  try {
    const limit = Math.min(
      80,
      Math.max(1, parseInt(String(req.query.limit || '80'), 10) || 80),
    );

    const storyCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const storiesBySubId = new Map();
    try {
      const { data: storyRows, error: storyErr } = await supabase
        .from('stories')
        .select('id, subscription_id, media_url, media_hls_url, video_status, created_at')
        .gte('created_at', storyCutoff)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (!storyErr && storyRows) {
        for (const row of storyRows) {
          const sid = row.subscription_id;
          const url = row.media_url && String(row.media_url).trim();
          if (!sid || !url) continue;
          if (!storiesBySubId.has(sid)) storiesBySubId.set(sid, []);
          storiesBySubId.get(sid).push(row);
        }
      }
    } catch (_) {
      /* stories table may not exist yet */
    }

    const idsFromStorySlides = [...storiesBySubId.keys()];

    const { data: subsProfileVideo, error: profErr } = await supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_SELECT_STORY)
      .in('status', ['verified', 'active'])
      .not('video_url', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(2000);

    if (profErr) {
      console.error('GET /api/stories/feed (subscriptions profile video):', profErr);
      return res.status(500).json({ success: false, error: profErr.message });
    }

    const subById = new Map();
    for (const s of subsProfileVideo || []) {
      if (s?.id) subById.set(s.id, s);
    }

    const chunkSize = 80;
    const storyOnlySubIds = idsFromStorySlides.filter((id) => !subById.has(id));
    for (let i = 0; i < storyOnlySubIds.length; i += chunkSize) {
      const chunk = storyOnlySubIds.slice(i, i + chunkSize);
      const { data: chunkSubs, error: chErr } = await supabase
        .from('subscriptions')
        .select(SUBSCRIPTION_SELECT_STORY)
        .in('id', chunk)
        .in('status', ['verified', 'active']);
      if (chErr) {
        console.warn('GET /api/stories/feed chunk story subs:', chErr.message);
        continue;
      }
      for (const s of chunkSubs || []) {
        if (s?.id && !subById.has(s.id)) subById.set(s.id, s);
      }
    }

    const ringSubIds = [
      ...new Set([...subById.keys(), ...storiesBySubId.keys()]),
    ];

    const rings = [];
    for (const sid of ringSubIds) {
      const s = subById.get(sid);
      if (!s) continue;
      const slides = [];
      const profileVideoUrl = storyHasVideoUrl(s.video_url)
        ? String(s.video_url).trim()
        : null;
      if (profileVideoUrl) {
        const profileMedia = muxVideo.shapeStorySlideFields(s, 'profile');
        if (profileMedia) {
          slides.push({
            id: `${s.id}-profile-video`,
            ...profileMedia,
            media_type: 'video',
            kind: 'profile',
          });
        }
      }
      const tableStories = storiesBySubId.get(s.id) || [];
      for (const st of tableStories) {
        const storyUrl = st.media_url && String(st.media_url).trim();
        if (!storyUrl) continue;
        // Profile intro already appears as kind:profile — skip duplicate story rows.
        if (profileVideoUrl && storyUrl === profileVideoUrl) continue;
        const storyMedia = muxVideo.shapeStorySlideFields(st, 'story');
        if (!storyMedia) continue;
        slides.push({
          id: `${s.id}-story-${st.id}`,
          ...storyMedia,
          media_type: storyMediaTypeFromUrl(storyMedia.media_url),
          kind: 'story',
        });
      }
      if (slides.length === 0) continue;

      const st = (s.subscription_type || '').toLowerCase();
      const pic =
        s.profile_picture_url ||
        (st === 'company' ? s.company_logo_url : null) ||
        null;

      let ringUpdatedAt = s.updated_at;
      if (tableStories[0]?.created_at) {
        ringUpdatedAt = tableStories[0].created_at;
      }

      rings.push({
        subscription_id: s.id,
        display_name: subscriptionDisplayNameForStory(s),
        profile_image_url: pic,
        subscription_type: st || null,
        slides,
        updated_at: ringUpdatedAt,
      });
    }

    rings.sort((a, b) => {
      const aProf = a.slides.some((sl) => sl.kind === 'profile') ? 1 : 0;
      const bProf = b.slides.some((sl) => sl.kind === 'profile') ? 1 : 0;
      if (bProf !== aProf) return bProf - aProf;
      const ta = new Date(a.updated_at || 0).getTime();
      const tb = new Date(b.updated_at || 0).getTime();
      return tb - ta;
    });

    const out = rings.slice(0, limit).map(({ updated_at, ...rest }) => rest);

    res.json({ success: true, rings: out });
  } catch (err) {
    console.error('GET /api/stories/feed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/stories — body: { subscription_id, media_url }
app.post('/api/stories', async (req, res) => {
  try {
    const { subscription_id: subscriptionId, media_url: mediaUrl } = req.body || {};
    const sid = subscriptionId && String(subscriptionId).trim();
    const url = mediaUrl && String(mediaUrl).trim();
    if (!sid || !url) {
      return res.status(400).json({
        success: false,
        error: 'subscription_id and media_url are required',
      });
    }

    const { data, error } = await supabase
      .from('stories')
      .insert([{ subscription_id: sid, media_url: url }])
      .select()
      .single();

    if (error) {
      console.error('POST /api/stories:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    if (muxVideo.isVideoUrl(url)) {
      try {
        const result = await muxVideo.startProcessing(
          supabase,
          'story',
          data.id,
          url,
        );
        if (result && result.playbackId) {
          data.mux_asset_id = result.assetId || data.mux_asset_id;
          data.mux_playback_id = result.playbackId;
          data.media_hls_url = muxVideo.hlsFromPlaybackId(result.playbackId);
          data.video_status = result.status || 'processing';
        }
      } catch (muxErr) {
        console.error('[mux] story create processing failed:', muxErr.message);
      }
    }

    res.status(201).json({ success: true, story: data });
  } catch (err) {
    console.error('POST /api/stories:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/companies/directory — company subscriptions + listing counts (home "חפשו עוד")
app.get('/api/companies/directory', async (req, res) => {
  try {
    const { data: companies, error } = await supabase
      .from('subscriptions')
      .select('id, business_name, name, company_logo_url, business_address, status')
      .eq('subscription_type', 'company')
      .in('status', ['verified', 'active'])
      .order('business_name', { ascending: true });

    if (error) {
      console.error('GET /api/companies/directory:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const list = companies || [];
    const ids = list.map((c) => c.id).filter(Boolean);
    const countBySub = {};
    if (ids.length > 0) {
      // Match CompanyProjectsScreen: published projects only (exclude feed posts).
      const { data: adRows, error: adErr } = await supabase
        .from('ads')
        .select('subscription_id, feed_post, property_type, description')
        .in('subscription_id', ids)
        .eq('status', 'published');
      if (adErr) {
        console.warn('GET /api/companies/directory ads count:', adErr.message);
      } else {
        for (const row of adRows || []) {
          const sid = row.subscription_id;
          if (!sid || isPostListingRow(row)) continue;
          countBySub[sid] = (countBySub[sid] || 0) + 1;
        }
      }
    }

    const companiesOut = list.map((c) => ({
      id: c.id,
      name: (c.business_name && String(c.business_name).trim()) || (c.name && String(c.name).trim()) || 'חברה',
      logo_url: c.company_logo_url && String(c.company_logo_url).trim() ? String(c.company_logo_url).trim() : null,
      address_hint: c.business_address && String(c.business_address).trim() ? String(c.business_address).trim() : null,
      project_count: countBySub[c.id] || 0,
    }));

    res.json({ success: true, companies: companiesOut });
  } catch (err) {
    console.error('GET /api/companies/directory:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/professionals/directory — professional subscriptions for home "חפשו עוד"
app.get('/api/professionals/directory', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('subscriptions')
      .select(
        'id, email, name, contact_person_name, business_name, business_address, description, profile_picture_url, video_url, video_hls_url, video_status, mux_playback_id, specializations, types, status, updated_at',
      )
      .eq('subscription_type', 'professional')
      .in('status', ['verified', 'active'])
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('GET /api/professionals/directory:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const list = rows || [];
    const ids = list.map(r => r.id).filter(Boolean);
    const listingCountBySub = {};
    const ratingBySub = {};
    if (ids.length > 0) {
      const { data: adRows, error: adErr } = await supabase
        .from('ads')
        .select('subscription_id')
        .in('subscription_id', ids);
      if (adErr) {
        console.warn('GET /api/professionals/directory ads count:', adErr.message);
      } else {
        for (const row of adRows || []) {
          const sid = row.subscription_id;
          if (!sid) continue;
          listingCountBySub[sid] = (listingCountBySub[sid] || 0) + 1;
        }
      }

      const { data: reviewRows, error: reviewErr } = await supabase
        .from('profile_reviews')
        .select('target_subscription_id, rating')
        .in('target_subscription_id', ids);
      if (reviewErr) {
        console.warn('GET /api/professionals/directory ratings:', reviewErr.message);
      } else {
        const agg = {};
        for (const row of reviewRows || []) {
          const sid = row?.target_subscription_id ? String(row.target_subscription_id) : '';
          if (!sid) continue;
          if (!agg[sid]) agg[sid] = {sum: 0, count: 0};
          agg[sid].sum += Number(row?.rating) || 0;
          agg[sid].count += 1;
        }
        for (const sid of Object.keys(agg)) {
          if (agg[sid].count > 0) ratingBySub[sid] = agg[sid].sum / agg[sid].count;
        }
      }
    }

    const parseJsonArray = value => {
      if (Array.isArray(value)) return value.filter(Boolean).map(v => String(v));
      if (typeof value === 'string') {
        const raw = value.trim();
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed)
            ? parsed.filter(Boolean).map(v => String(v))
            : [];
        } catch (_) {
          return [raw];
        }
      }
      return [];
    };

    const professionals = list.map(row => {
      const displayName =
        (row.name && String(row.name).trim()) ||
        (row.business_name && String(row.business_name).trim()) ||
        (row.contact_person_name && String(row.contact_person_name).trim()) ||
        'בעל מקצוע';
      const specializations = parseJsonArray(row.specializations);
      const types = parseJsonArray(row.types);
      return {
        id: row.id,
        email: row.email || null,
        subscription_type: 'professional',
        display_name: displayName,
        profile_image_url: asPublicImageUrl(row.profile_picture_url),
        video_url: asPublicImageUrl(row.video_url),
        video_hls_url: row.video_hls_url || null,
        video_playback_url: muxVideo.resolveSubscriptionPlaybackUrl(row),
        video_status: row.video_status || null,
        address: row.business_address && String(row.business_address).trim() ? String(row.business_address).trim() : null,
        bio: row.description && String(row.description).trim() ? String(row.description).trim() : null,
        specializations,
        types,
        listing_count: listingCountBySub[row.id] || 0,
        average_rating: ratingBySub[row.id] != null ? Number(ratingBySub[row.id]) : 5,
        updated_at: row.updated_at || null,
      };
    });

    res.json({ success: true, professionals });
  } catch (err) {
    console.error('GET /api/professionals/directory:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CHAT ENDPOINTS ====================
// Simple email-based chat: users identified by email (chat_participants.user_id and chat_messages.sender_id/receiver_id store normalized email).

function normEmail(email) {
  return (email != null ? String(email).trim().toLowerCase() : '') || '';
}
const CHAT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asPublicImageUrl(value) {
  const raw = value != null ? String(value).trim() : '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  // File/blob URLs from local devices are not shareable on web clients.
  if (/^(file:|blob:)/i.test(raw)) return null;
  if (!supabaseUrl || !String(supabaseUrl).trim()) return raw;
  let origin = String(supabaseUrl).trim();
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
  try {
    const u = new URL(origin);
    origin = `${u.protocol}//${u.host}`;
  } catch (_) {
    origin = origin.replace(/\/+$/, '');
  }
  if (raw.startsWith('/storage/v1/object/public/')) return `${origin}${raw}`;
  if (raw.startsWith('storage/v1/object/public/')) return `${origin}/${raw}`;
  if (raw.startsWith('/storage/v1/object/sign/')) return `${origin}${raw}`;
  if (raw.startsWith('storage/v1/object/sign/')) return `${origin}/${raw}`;
  if (raw.startsWith('/object/public/')) return `${origin}/storage/v1${raw}`;
  if (raw.startsWith('object/public/')) return `${origin}/storage/v1/${raw}`;
  if (raw.startsWith('/public/')) return `${origin}/storage/v1/object${raw}`;
  if (raw.startsWith('public/')) return `${origin}/storage/v1/object/${raw}`;
  if (raw.startsWith('/profile-pics/')) return `${origin}/storage/v1/object/public${raw}`;
  if (raw.startsWith('profile-pics/')) return `${origin}/storage/v1/object/public/${raw}`;
  if (raw.startsWith('/company-logos/')) return `${origin}/storage/v1/object/public${raw}`;
  if (raw.startsWith('company-logos/')) return `${origin}/storage/v1/object/public/${raw}`;
  if (/^[^/]+\/.+/.test(raw)) return `${origin}/storage/v1/object/public/${raw}`;
  return raw;
}

function getSupabaseHost() {
  if (!supabaseUrl || !String(supabaseUrl).trim()) return null;
  let origin = String(supabaseUrl).trim();
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
  try {
    const u = new URL(origin);
    return String(u.host || '').toLowerCase();
  } catch (_) {
    return null;
  }
}

function extractBucketAndPath(value) {
  const raw = value != null ? String(value).trim() : '';
  if (!raw) return null;
  let pathLike = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      pathLike = decodeURIComponent(String(u.pathname || ''));
    } catch (_) {
      pathLike = raw;
    }
  }
  if (!pathLike) return null;
  const patterns = [
    /\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/i,
    /^storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/i,
    /\/object\/public\/([^/]+)\/(.+)$/i,
    /^object\/public\/([^/]+)\/(.+)$/i,
    /\/public\/([^/]+)\/(.+)$/i,
    /^public\/([^/]+)\/(.+)$/i,
  ];
  for (const re of patterns) {
    const m = pathLike.match(re);
    if (m && m[1] && m[2]) {
      return { bucket: String(m[1]).trim(), path: String(m[2]).trim() };
    }
  }
  const cleaned = pathLike.replace(/^\/+/, '');
  const m2 = cleaned.match(/^([^/]+)\/(.+)$/);
  if (!m2) return null;
  const bucket = String(m2[1]).trim();
  const path = String(m2[2]).trim();
  if (!bucket || !path) return null;
  return { bucket, path };
}

async function resolveExistingImageUrl(value, cache = null) {
  const normalized = asPublicImageUrl(value);
  if (!normalized) return null;
  const k = String(normalized);
  if (cache && cache.has(k)) return cache.get(k);
  const bp = extractBucketAndPath(k);
  if (!bp || !bp.bucket || !bp.path) {
    if (cache) cache.set(k, normalized);
    return normalized;
  }
  try {
    const { data, error } = await supabase.storage
      .from(bp.bucket)
      .createSignedUrl(bp.path, 60 * 60);
    const out =
      !error && data?.signedUrl && String(data.signedUrl).trim()
        ? String(data.signedUrl).trim()
        : null;
    if (cache) cache.set(k, out);
    return out;
  } catch (_) {
    if (cache) cache.set(k, null);
    return null;
  }
}

function subscriptionDisplayNameFromRow(sub) {
  if (!sub) return null;
  const type = (sub.subscription_type || '').toLowerCase();
  if (type === 'company') return sub.business_name || sub.name || sub.contact_person_name || null;
  if (type === 'broker') return sub.broker_office_name || sub.name || sub.contact_person_name || null;
  if (type === 'professional') return sub.name || sub.business_name || sub.contact_person_name || null;
  return sub.name || sub.contact_person_name || sub.business_name || null;
}

function subscriptionProfilePicFromRow(sub) {
  if (!sub) return null;
  const type = (sub.subscription_type || '').toLowerCase();
  return asPublicImageUrl(
    sub.profile_picture_url || (type === 'company' ? sub.company_logo_url : null) || null,
  );
}

/** PostgREST/Postgres when `group_image_url` migration was not applied yet */
function isMissingGroupImageUrlColumnError(err) {
  const msg = String((err && err.message) || (err && err.details) || err || '');
  const code = String((err && err.code) || '');
  return (
    /group_image_url/i.test(msg) &&
    (/does not exist/i.test(msg) ||
      /42703/i.test(msg) ||
      /undefined column/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /PGRST204/i.test(code))
  );
}

/** When `group_description` migration was not applied yet */
function isMissingGroupDescriptionColumnError(err) {
  const msg = String((err && err.message) || (err && err.details) || err || '');
  const code = String((err && err.code) || '');
  return (
    /group_description/i.test(msg) &&
    (/does not exist/i.test(msg) ||
      /42703/i.test(msg) ||
      /undefined column/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /PGRST204/i.test(code))
  );
}

function isMissingGroupCreatorEmailColumnError(err) {
  const msg = String((err && err.message) || (err && err.details) || err || '');
  const code = String((err && err.code) || '');
  return (
    /group_creator_email/i.test(msg) &&
    (/does not exist/i.test(msg) ||
      /42703/i.test(msg) ||
      /undefined column/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /PGRST204/i.test(code))
  );
}

function isMissingGroupRoleColumnError(err) {
  const msg = String((err && err.message) || (err && err.details) || err || '');
  const code = String((err && err.code) || '');
  return (
    /group_role/i.test(msg) &&
    (/does not exist/i.test(msg) ||
      /42703/i.test(msg) ||
      /undefined column/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /PGRST204/i.test(code))
  );
}

/** Normalize participant role; infer owner from conversation creator email when column absent in row. */
function resolvedGroupRole(partRow, creatorEmailNorm) {
  const raw = partRow?.group_role != null ? String(partRow.group_role).trim().toLowerCase() : '';
  if (raw === 'owner' || raw === 'manager' || raw === 'member') return raw;
  const uid = normEmail(partRow?.user_id);
  const cr = creatorEmailNorm ? normEmail(creatorEmailNorm) : '';
  if (cr && uid && cr === uid) return 'owner';
  return 'member';
}

/** ads.category → Hebrew badge on chat list (when last message has listing_id) */
const CHAT_LISTING_CATEGORY_LABELS = {
  1: 'חדש מקבלן',
  2: 'משרדים',
  3: 'שותפים',
  4: 'גלובל',
  5: 'BnB',
  6: 'מגזר דתי',
  7: 'קרקעות',
  8: 'מסחרי',
  9: 'נכסים',
  10: 'דירות',
  12: 'יוקרה',
};

/** Accept standard hyphenated UUIDs from clients (any version). */
const CHAT_LISTING_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches Pi Chat exclusive-offer template body — sync with pi-front ChatScreen EXCLUSIVE_OFFER_BODY_MARKER */
const CHAT_EXCLUSIVE_OFFER_BODY_MARKER = 'להציע בלעדיות על הנכס';

function isMissingExclusiveOfferTableError(err) {
  const msg = String((err && err.message) || (err && err.details) || err || '');
  const code = String((err && err.code) || '');
  return (
    /chat_exclusive_offers/i.test(msg) &&
    (/does not exist/i.test(msg) ||
      /42703/i.test(msg) ||
      /undefined (column|table)/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /PGRST205/i.test(code) ||
      /PGRST204/i.test(code))
  );
}

async function upsertExclusiveOfferPending(supabase, { convId, body, listingId, brokerEmail, ownerEmail }) {
  if (!convId || !listingId || !body || !String(body).includes(CHAT_EXCLUSIVE_OFFER_BODY_MARKER)) return;
  const monthsMatch = String(body).match(/בתוך\s+(\d+)\s+חודשים/);
  const months = monthsMatch ? parseInt(monthsMatch[1], 10) : null;
  const row = {
    conversation_id: convId,
    listing_id: listingId,
    broker_email: brokerEmail,
    owner_email: ownerEmail,
    status: 'pending',
    months_committed: Number.isFinite(months) ? months : null,
    updated_at: new Date().toISOString(),
  };
  const r = await supabase.from('chat_exclusive_offers').upsert(row, { onConflict: 'conversation_id' });
  if (r.error && !isMissingExclusiveOfferTableError(r.error)) {
    console.warn('[chat] exclusive offer upsert:', r.error.message);
  }
}

// GET /api/chat/unread-count?user_email=...&after=:iso_timestamp
async function markChatConversationRead(userEmail, conversationId, selfRefs = null) {
  if (!userEmail || !conversationId) return;
  const now = new Date().toISOString();
  const refs =
    selfRefs && typeof selfRefs.size === 'number' && selfRefs.size > 0
      ? [...selfRefs]
      : [userEmail];
  const upd = await supabase
    .from('chat_participants')
    .update({ last_read_at: now })
    .eq('conversation_id', conversationId)
    .in('user_id', refs);
  if (upd.error && !isMissingColumnError(upd.error)) {
    console.warn('[chat] markChatConversationRead:', upd.error.message);
  }
}

const CHAT_MESSAGE_SELECT_FULL =
  'id, sender_id, body, created_at, media_type, media_url, listing_id, is_listing_share';
const CHAT_MESSAGE_SELECT_FALLBACK =
  'id, sender_id, body, created_at, media_type, media_url, listing_id';
/** Cap initial thread payload so opening a chat stays fast on long histories. */
const CHAT_MESSAGES_INITIAL_LIMIT = 100;

function mapChatMessageRow(m, myEmail, { withMedia = true, withListingShare = true } = {}) {
  const isMe = normEmail(m.sender_id) === myEmail;
  return {
    id: m.id,
    senderId: m.sender_id,
    body: m.body,
    mediaType: withMedia ? (m.media_type || null) : null,
    mediaUrl: withMedia ? (m.media_url || null) : null,
    listingId: m.listing_id != null ? String(m.listing_id) : null,
    listingShare:
      withListingShare && m.is_listing_share === true
        ? true
        : withListingShare && m.is_listing_share === false
          ? false
          : undefined,
    createdAt: m.created_at,
    isMe,
  };
}

async function loadChatMessagesForConversation(
  conversationId,
  myEmail,
  { limit = CHAT_MESSAGES_INITIAL_LIMIT } = {},
) {
  const cap = Number(limit);
  const useCap = Number.isFinite(cap) && cap > 0;
  const runSelect = async (selectCols, withListingShare) => {
    let q = supabase
      .from('chat_messages')
      .select(selectCols)
      .eq('conversation_id', conversationId);
    if (useCap) {
      q = q.order('created_at', { ascending: false }).limit(cap);
    } else {
      q = q.order('created_at', { ascending: true });
    }
    const r = await q;
    if (r.error) return { error: r.error, rows: null };
    let rows = r.data || [];
    if (useCap) rows = rows.slice().reverse();
    return {
      error: null,
      rows: rows.map((m) =>
        mapChatMessageRow(m, myEmail, {
          withMedia: selectCols.includes('media_type'),
          withListingShare,
        }),
      ),
    };
  };

  let r = await runSelect(CHAT_MESSAGE_SELECT_FULL, true);
  if (!r.error) return r.rows;
  if (!isMissingColumnError(r.error)) throw r.error;
  r = await runSelect(CHAT_MESSAGE_SELECT_FALLBACK, false);
  if (r.error) throw r.error;
  return r.rows;
}

async function userCanAccessConversation(userEmail, conversationId) {
  if (!userEmail || !conversationId) return false;
  const selfRefs = new Set([userEmail]);
  const { data: meSub } = await supabase
    .from('subscriptions')
    .select('id, email')
    .ilike('email', userEmail)
    .maybeSingle();
  if (meSub?.id) selfRefs.add(String(meSub.id).trim().toLowerCase());
  if (meSub?.email) selfRefs.add(normEmail(meSub.email));
  const refs = [...selfRefs];
  const { data: parts, error } = await supabase
    .from('chat_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .in('user_id', refs);
  if (error) return false;
  return (parts || []).length > 0;
}

function buildUnreadCountByConversation(convIds, lastMessages, isSelfRef, lastReadByConv = {}) {
  const unreadByConvId = {};
  (convIds || []).forEach((id) => {
    unreadByConvId[id] = 0;
  });
  (lastMessages || []).forEach((m) => {
    const cid = m.conversation_id;
    if (!cid || isSelfRef(m.sender_id)) return;
    const lastRead = lastReadByConv[cid];
    if (lastRead && new Date(m.created_at) <= new Date(lastRead)) return;
    unreadByConvId[cid] = (unreadByConvId[cid] || 0) + 1;
  });
  return unreadByConvId;
}

app.get('/api/chat/unread-count', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });
    const after = (req.query.after && String(req.query.after).trim()) || null;
    let query = supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('receiver_id', userEmail);
    if (after) query = query.gt('created_at', after);
    const { count, error } = await query;
    if (error) {
      console.error('GET /api/chat/unread-count:', error.message);
      return res.json({ success: true, count: 0 });
    }
    res.json({ success: true, count: typeof count === 'number' ? count : 0 });
  } catch (err) {
    console.error('GET /api/chat/unread-count:', err);
    res.json({ success: true, count: 0 });
  }
});

/** Inbox list preview for shared feed posts (not plain body "פוסט"). */
const CHAT_SHARED_POST_LIST_PREVIEW = 'פוסט משותף';

function chatLastMessageIsSharedPost(row) {
  if (!row) return false;
  if (row.is_listing_share === true || row.is_listing_share === 'true') return true;
  const lid = row.listing_id != null && String(row.listing_id).trim() !== '';
  if (!lid) return false;
  const mt = String(row.media_type || '').trim().toLowerCase();
  const body = String(row.body || '').trim();
  if (mt === 'image') return true;
  if (!body) return true;
  if (body === 'פוסט' || body === CHAT_SHARED_POST_LIST_PREVIEW) return true;
  if (/^פוסט\s*$/u.test(body)) return true;
  return false;
}

function chatPreviewFromLastMessage(row) {
  if (!row) return { preview: '', lastMessageIsSharedPost: false };
  const shared = chatLastMessageIsSharedPost(row);
  const body = String(row.body || '').trim();
  if (shared) {
    const generic =
      !body ||
      body === 'פוסט' ||
      body === CHAT_SHARED_POST_LIST_PREVIEW ||
      /^פוסט\s*$/u.test(body);
    if (generic) {
      return { preview: CHAT_SHARED_POST_LIST_PREVIEW, lastMessageIsSharedPost: true };
    }
    return { preview: body.slice(0, 120), lastMessageIsSharedPost: true };
  }
  if (body) return { preview: body.slice(0, 120), lastMessageIsSharedPost: false };
  const mt = String(row.media_type || '').trim().toLowerCase();
  if (mt === 'image') return { preview: 'תמונה', lastMessageIsSharedPost: false };
  if (mt === 'audio') return { preview: 'הודעה קולית', lastMessageIsSharedPost: false };
  return { preview: '', lastMessageIsSharedPost: false };
}

// GET /api/chat/conversations?user_email=...
app.get('/api/chat/conversations', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });
    const selfRefs = new Set([userEmail]);
    const { data: meSub } = await supabase
      .from('subscriptions')
      .select('id, email')
      .ilike('email', userEmail)
      .maybeSingle();
    if (meSub?.id) selfRefs.add(String(meSub.id).trim().toLowerCase());
    if (meSub?.email) selfRefs.add(normEmail(meSub.email));
    const isSelfRef = (ref) => {
      const v = ref != null ? String(ref).trim().toLowerCase() : '';
      if (!v) return false;
      if (selfRefs.has(v)) return true;
      const em = normEmail(v);
      return em ? selfRefs.has(em) : false;
    };

    let myParts = [];
    const myPartsRes = await supabase
      .from('chat_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', userEmail);
    if (myPartsRes.error && isMissingColumnError(myPartsRes.error)) {
      const fb = await supabase
        .from('chat_participants')
        .select('conversation_id')
        .eq('user_id', userEmail);
      myParts = fb.data || [];
    } else {
      myParts = myPartsRes.data || [];
    }
    const convIds = [...new Set((myParts || []).map(p => p.conversation_id))];
    if (convIds.length === 0) return res.json({ success: true, conversations: [] });
    const lastReadByConv = {};
    (myParts || []).forEach((p) => {
      lastReadByConv[p.conversation_id] = p.last_read_at || null;
    });

    const { data: allParticipants } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id, display_name, profile_picture_url')
      .in('conversation_id', convIds);
    const participantsByConv = {};
    (allParticipants || []).forEach(p => {
      if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
      participantsByConv[p.conversation_id].push(p);
    });

    let offerStatusByConvId = {};
    const eoList = await supabase.from('chat_exclusive_offers').select('conversation_id, status').in('conversation_id', convIds);
    if (!eoList.error && eoList.data) {
      eoList.data.forEach((r) => {
        offerStatusByConvId[r.conversation_id] = r.status;
      });
    } else if (eoList.error && !isMissingExclusiveOfferTableError(eoList.error)) {
      console.warn('GET /api/chat/conversations exclusive offers:', eoList.error.message);
    }

    let { data: convs, error: convsSelectErr } = await supabase
      .from('chat_conversations')
      .select('id, last_message_at, type, title, group_image_url')
      .in('id', convIds)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (convsSelectErr && isMissingGroupImageUrlColumnError(convsSelectErr)) {
      const fb = await supabase
        .from('chat_conversations')
        .select('id, last_message_at, type, title')
        .in('id', convIds)
        .order('last_message_at', { ascending: false, nullsFirst: false });
      convs = fb.data;
    }

    let lastMessages;
    /** Include is_listing_share when column exists so inbox preview matches shared-post format (see chatPreviewFromLastMessage). */
    const lm1 = await supabase
      .from('chat_messages')
      .select(
        'conversation_id, body, created_at, sender_id, media_type, listing_id, is_listing_share',
      )
      .in('conversation_id', convIds);
    if (lm1.error) {
      const lm2 = await supabase
        .from('chat_messages')
        .select('conversation_id, body, created_at, sender_id, media_type, listing_id')
        .in('conversation_id', convIds);
      if (lm2.error) {
        const lm3 = await supabase
          .from('chat_messages')
          .select('conversation_id, body, created_at, sender_id, listing_id')
          .in('conversation_id', convIds);
        lastMessages = lm3.error ? [] : lm3.data;
        if (lm3.error && !isMissingColumnError(lm3.error)) {
          console.error('GET /api/chat/conversations last messages:', lm3.error.message);
        }
      } else {
        lastMessages = lm2.data;
      }
    } else {
      lastMessages = lm1.data;
    }
    const lastByConv = {};
    (lastMessages || []).forEach(m => {
      if (!lastByConv[m.conversation_id] || new Date(m.created_at) > new Date(lastByConv[m.conversation_id].created_at)) {
        lastByConv[m.conversation_id] = m;
      }
    });
    const unreadByConvId = buildUnreadCountByConversation(
      convIds,
      lastMessages,
      isSelfRef,
      lastReadByConv,
    );

    /** Newest message in thread that carries listing_id (so badges survive when latest text msg omitted listing_id). */
    const latestListingIdByConv = {};
    (lastMessages || []).forEach(m => {
      const lid = m.listing_id;
      if (lid == null || String(lid).trim() === '') return;
      const cid = m.conversation_id;
      const prev = latestListingIdByConv[cid];
      if (!prev || new Date(m.created_at) > new Date(prev.at)) {
        latestListingIdByConv[cid] = { listing_id: lid, at: m.created_at };
      }
    });

    const listingIds = [...new Set(
      [
        ...Object.values(lastByConv).map(m => m.listing_id),
        ...Object.values(latestListingIdByConv).map(x => x.listing_id),
      ].filter(id => id != null && String(id).trim() !== ''),
    )];
    const adsByListingId = {};
    /** ad id → 1-based index by upload order for that publisher (subscription_id, else owner_id-only). */
    let listingUploadOrderById = {};
    if (listingIds.length > 0) {
      const { data: adRows } = await supabase
        .from('ads')
        .select('id, category, subscription_id, owner_id, created_at')
        .in('id', listingIds);
      (adRows || []).forEach(a => {
        adsByListingId[String(a.id)] = a;
      });

      const subIds = [...new Set((adRows || []).map(a => a.subscription_id).filter(Boolean))];
      const ownerIdsForRank = [
        ...new Set(
          (adRows || [])
            .filter(a => !a.subscription_id && a.owner_id)
            .map(a => String(a.owner_id).trim())
            .filter(Boolean),
        ),
      ];

      const publisherAds = [];
      if (subIds.length > 0) {
        const { data: subAds } = await supabase
          .from('ads')
          .select('id, created_at, subscription_id, owner_id')
          .in('subscription_id', subIds);
        publisherAds.push(...(subAds || []));
      }
      if (ownerIdsForRank.length > 0) {
        const { data: ownAds } = await supabase
          .from('ads')
          .select('id, created_at, subscription_id, owner_id')
          .in('owner_id', ownerIdsForRank)
          .is('subscription_id', null);
        publisherAds.push(...(ownAds || []));
      }

      const seenPub = new Set();
      const uniquePublisherAds = [];
      for (const a of publisherAds) {
        const k = String(a.id);
        if (seenPub.has(k)) continue;
        seenPub.add(k);
        uniquePublisherAds.push(a);
      }

      const byPublisherKey = {};
      for (const a of uniquePublisherAds) {
        const key = a.subscription_id
          ? `s:${a.subscription_id}`
          : a.owner_id
            ? `o:${String(a.owner_id).trim()}`
            : null;
        if (!key) continue;
        if (!byPublisherKey[key]) byPublisherKey[key] = [];
        byPublisherKey[key].push(a);
      }
      for (const key of Object.keys(byPublisherKey)) {
        const list = byPublisherKey[key].sort((x, y) => {
          const tx = new Date(x.created_at || 0).getTime();
          const ty = new Date(y.created_at || 0).getTime();
          if (tx !== ty) return tx - ty;
          return String(x.id).localeCompare(String(y.id));
        });
        list.forEach((row, idx) => {
          listingUploadOrderById[String(row.id)] = idx + 1;
        });
      }
    }

    const otherRefs = [...new Set(
      (convs || []).flatMap(c =>
        (participantsByConv[c.id] || [])
          .map(p => (p.user_id != null ? String(p.user_id).trim() : ''))
          .filter((ref) => ref && !isSelfRef(ref)),
      )
    )];
    let displayByRef = {};
    if (otherRefs.length > 0) {
      const emailRefs = otherRefs.filter((r) => String(r).includes('@'));
      const idRefs = otherRefs.filter(
        (r) => !String(r).includes('@') && CHAT_UUID_RE.test(String(r)),
      );
      let subs = [];
      if (emailRefs.length > 0) {
        const orFilter = emailRefs.map(e => `email.ilike.${e}`).join(',');
        const { data: subsByEmail } = await supabase
          .from('subscriptions')
          .select(
            'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
          )
          .or(orFilter);
        subs.push(...(subsByEmail || []));
      }
      if (idRefs.length > 0) {
        const { data: subsById } = await supabase
          .from('subscriptions')
          .select(
            'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
          )
          .in('id', idRefs);
        subs.push(...(subsById || []));
      }
      (subs || []).forEach(s => {
        const e = normEmail(s.email);
        const type = (s.subscription_type || '').toLowerCase();
        let name = null;
        if (type === 'company') name = s.business_name || s.name || s.contact_person_name || null;
        else if (type === 'broker') name = s.broker_office_name || s.name || s.contact_person_name || null;
        else if (type === 'professional') name = s.name || s.business_name || s.contact_person_name || null;
        else name = s.name || s.contact_person_name || s.business_name || null;
        const pic =
          asPublicImageUrl(
            s.profile_picture_url ||
            (type === 'company' ? s.company_logo_url : null) ||
            null,
          ) ||
          null;
        if (e && otherRefs.some((r) => normEmail(r) === e)) {
          displayByRef[e] = {
            name: name || null,
            profile_picture_url: pic,
            subscription_type: type || null,
          };
        }
        if (s.id) {
          const idKey = String(s.id).toLowerCase();
          if (otherRefs.some((r) => String(r).trim().toLowerCase() === idKey)) {
            displayByRef[idKey] = {
              name: name || null,
              profile_picture_url: pic,
              subscription_type: type || null,
            };
          }
        }
      });
      (allParticipants || []).forEach(p => {
        const e = normEmail(p.user_id);
        if (!e) return;
        const pName =
          p.display_name != null && String(p.display_name).trim()
            ? String(p.display_name).trim()
            : null;
        const pPic =
          p.profile_picture_url != null && String(p.profile_picture_url).trim()
            ? asPublicImageUrl(String(p.profile_picture_url).trim())
            : null;
        const existing = displayByRef[e];
        if (!existing) {
          if (pName || pPic) {
            displayByRef[e] = {
              name: pName,
              profile_picture_url: pPic,
              subscription_type: null,
            };
          }
          return;
        }
        if (!existing.profile_picture_url && pPic) {
          displayByRef[e] = {...existing, profile_picture_url: pPic};
        }
        if (!existing.name && pName) {
          displayByRef[e] = {...displayByRef[e], name: pName};
        }
      });
    }

    const conversations = await Promise.all((convs || []).map(async (c) => {
      const participants = participantsByConv[c.id] || [];
      const isGroup = (c.type === 'group') || participants.length > 2;
      if (isGroup) {
        const last = lastByConv[c.id];
        let preview = '';
        if (last) {
          preview = chatPreviewFromLastMessage(last).preview;
        }
        const lastLid =
          last?.listing_id != null && String(last.listing_id).trim() !== '' ? last.listing_id : null;
        const listingId = lastLid || latestListingIdByConv[c.id]?.listing_id || null;
        const adRow = listingId ? adsByListingId[String(listingId)] : null;
        const catNum = adRow?.category != null ? Number(adRow.category) : NaN;
        const listingCategoryLabel = !Number.isNaN(catNum) ? (CHAT_LISTING_CATEGORY_LABELS[catNum] || null) : null;
        const listingDisplayNumber =
          listingId != null ? listingUploadOrderById[String(listingId)] ?? null : null;
        const gTitle = (c.title && String(c.title).trim()) || 'קבוצה';
        const gPic = c.group_image_url != null && String(c.group_image_url).trim() ? String(c.group_image_url).trim() : null;
        const participantPicCandidates = participants
          .map((p) =>
            p?.profile_picture_url != null && String(p.profile_picture_url).trim()
              ? String(p.profile_picture_url).trim()
              : null,
          )
          .filter(Boolean);
        const isPlaceholderPic = (v) => {
          const low = String(v || '').trim().toLowerCase();
          if (!low) return true;
          return (
            low.includes('/assets/assets/image-copy-10.png') ||
            low.endsWith('/image-copy-10.png') ||
            low === 'image-copy-10.png'
          );
        };
        const participantPicFreq = new Map();
        for (const u of participantPicCandidates) {
          if (isPlaceholderPic(u)) continue;
          participantPicFreq.set(u, (participantPicFreq.get(u) || 0) + 1);
        }
        const participantGroupPic =
          [...participantPicFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        const groupProfileImageUrl = asPublicImageUrl(
          gPic || participantGroupPic,
        );
        return {
          id: c.id,
          isGroup: true,
          otherUserEmail: null,
          name: gTitle,
          profileImageUrl: groupProfileImageUrl,
          preview,
          time: last ? new Date(last.created_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '',
          lastMessageAt: last?.created_at || c.last_message_at || null,
          listingId,
          listingDisplayNumber,
          listingCategoryLabel,
          exclusiveOfferStatus: null,
          unreadCount: unreadByConvId[c.id] || 0,
        };
      }
      const other =
        participants.find((p) => !isSelfRef(p.user_id)) ||
        participants.find((p) => p.user_id != null);
      const otherRefRaw = other?.user_id != null ? String(other.user_id).trim() : null;
      const otherRefNorm = otherRefRaw ? normEmail(otherRefRaw) : null;
      const otherRefLower = otherRefRaw ? String(otherRefRaw).toLowerCase() : null;
      const otherEmail = otherRefNorm || otherRefLower || null;
      const display =
        (otherRefNorm && displayByRef[otherRefNorm]) ||
        (otherRefLower && displayByRef[otherRefLower]) ||
        {};
      const name = display?.name || (other && other.display_name) || 'משתמש';
      const profileImageUrl = asPublicImageUrl(
        display?.profile_picture_url || (other && other.profile_picture_url) || null,
      );
      const subscriptionType =
        display?.subscription_type != null && String(display.subscription_type).trim()
          ? String(display.subscription_type).trim().toLowerCase()
          : null;
      const last = lastByConv[c.id];
      let preview = '';
      if (last) {
        preview = chatPreviewFromLastMessage(last).preview;
      }
      const lastLid =
        last?.listing_id != null && String(last.listing_id).trim() !== '' ? last.listing_id : null;
      const listingId = lastLid || latestListingIdByConv[c.id]?.listing_id || null;
      const adRow = listingId ? adsByListingId[String(listingId)] : null;
      const catNum = adRow?.category != null ? Number(adRow.category) : NaN;
      const listingCategoryLabel = !Number.isNaN(catNum) ? (CHAT_LISTING_CATEGORY_LABELS[catNum] || null) : null;
      const listingDisplayNumber =
        listingId != null ? listingUploadOrderById[String(listingId)] ?? null : null;
      return {
        id: c.id,
        isGroup: false,
        otherUserEmail: otherEmail,
        name,
        profileImageUrl,
        subscriptionType,
        subscription_type: subscriptionType,
        preview,
        time: last ? new Date(last.created_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '',
        lastMessageAt: last?.created_at || c.last_message_at || null,
        listingId,
        listingDisplayNumber,
        listingCategoryLabel,
        exclusiveOfferStatus: offerStatusByConvId[c.id] || null,
        unreadCount: unreadByConvId[c.id] || 0,
      };
    }));

    const byOther = {};
    conversations.forEach(conv => {
      const oid = conv.isGroup ? String(conv.id) : (conv.otherUserEmail || conv.id);
      const existing = byOther[oid];
      if (!existing || (conv.lastMessageAt && (!existing.lastMessageAt || new Date(conv.lastMessageAt) > new Date(existing.lastMessageAt)))) {
        byOther[oid] = conv;
      }
    });
    res.json({ success: true, conversations: Object.values(byOther) });
  } catch (err) {
    console.error('GET /api/chat/conversations:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/chat/conversations - body: user_email, other_user_email.
// Deletes a 1-on-1 (direct) conversation between the two users, including its
// messages, participants, and any exclusive offer. Group conversations are
// rejected (use group management to leave/remove instead).
app.delete('/api/chat/conversations', async (req, res) => {
  try {
    const userEmail = normEmail(req.body.user_email || req.query.user_email);
    const otherEmail = normEmail(
      req.body.other_user_email || req.query.other_user_email,
    );
    if (!userEmail || !otherEmail) {
      return res
        .status(400)
        .json({ success: false, error: 'user_email and other_user_email required' });
    }

    // Find conversations the requesting user participates in.
    const { data: myParts } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userEmail);
    const myConvIds = [...new Set((myParts || []).map(p => p.conversation_id))];
    if (myConvIds.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    // Of those, the ones the other user is also in.
    const { data: otherIn } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', otherEmail)
      .in('conversation_id', myConvIds);
    const sharedConvIds = [...new Set((otherIn || []).map(p => p.conversation_id))];
    if (sharedConvIds.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    // Keep only true direct (non-group) conversations with exactly these 2 members.
    const { data: convRows } = await supabase
      .from('chat_conversations')
      .select('id, type')
      .in('id', sharedConvIds);
    const typeById = {};
    (convRows || []).forEach(c => {
      typeById[c.id] = String(c.type || '').trim().toLowerCase();
    });

    const directConvIds = [];
    for (const convId of sharedConvIds) {
      if (typeById[convId] === 'group') continue;
      const { data: parts } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', convId);
      const emails = (parts || []).map(p => normEmail(p.user_id));
      if (
        emails.length === 2 &&
        emails.includes(userEmail) &&
        emails.includes(otherEmail)
      ) {
        directConvIds.push(convId);
      }
    }

    if (directConvIds.length === 0) {
      return res
        .status(403)
        .json({ success: false, error: 'Only direct chats can be deleted this way' });
    }

    // Delete dependent rows first, then the conversations themselves.
    await supabase.from('chat_messages').delete().in('conversation_id', directConvIds);
    const eoDel = await supabase
      .from('chat_exclusive_offers')
      .delete()
      .in('conversation_id', directConvIds);
    if (eoDel.error && !isMissingExclusiveOfferTableError(eoDel.error)) {
      console.warn('DELETE /api/chat/conversations exclusive offers:', eoDel.error.message);
    }
    await supabase.from('chat_participants').delete().in('conversation_id', directConvIds);
    const { error: convDelErr } = await supabase
      .from('chat_conversations')
      .delete()
      .in('id', directConvIds);
    if (convDelErr) {
      console.error('DELETE /api/chat/conversations conv:', convDelErr.message);
      return res.status(500).json({ success: false, error: convDelErr.message });
    }

    res.json({ success: true, deleted: directConvIds.length });
  } catch (err) {
    console.error('DELETE /api/chat/conversations:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resolve avatar URL (public/signed) to help web clients load mixed storage paths reliably.
app.get('/api/chat/avatar-url', async (req, res) => {
  try {
    const src = req.query.src != null ? String(req.query.src).trim() : '';
    if (!src) return res.status(400).json({ success: false, error: 'src required' });
    let resolved = asPublicImageUrl(src);
    const bp = extractBucketAndPath(src) || extractBucketAndPath(resolved);
    let signedUrl = null;
    if (bp && bp.bucket && bp.path) {
      try {
        const { data, error } = await supabase.storage.from(bp.bucket).createSignedUrl(bp.path, 60 * 60);
        if (!error && data?.signedUrl && String(data.signedUrl).trim()) {
          signedUrl = String(data.signedUrl).trim();
          resolved = signedUrl;
        }
      } catch (_) { /* ignore and keep resolved */ }
    }
    console.log('[chat-avatar-url] resolve', {
      src,
      bucket: bp?.bucket || null,
      path: bp?.path || null,
      resolved,
    });
    if (!resolved) return res.status(404).json({ success: false, error: 'avatar not found' });
    const allowedHost = getSupabaseHost();
    if (/^https?:\/\//i.test(resolved) && allowedHost) {
      try {
        const u = new URL(resolved);
        if (String(u.host || '').toLowerCase() !== allowedHost) {
          return res.status(400).json({ success: false, error: 'unsupported host' });
        }
      } catch (_) { /* ignore */ }
    }
    // Prefer same-origin streaming for web clients (avoids cross-origin/public-bucket issues).
    if (bp && bp.bucket && bp.path) {
      try {
        const { data, error } = await supabase.storage.from(bp.bucket).download(bp.path);
        if (!error && data) {
          const ab = await data.arrayBuffer();
          const buf = Buffer.from(ab);
          const contentType =
            (typeof data.type === 'string' && data.type.trim()) ||
            'application/octet-stream';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=300');
          return res.status(200).send(buf);
        }
      } catch (_) { /* ignore and fallback */ }
    }

    // If signed/public URL exists, fetch and stream it (still same-origin to browser).
    const upstream = signedUrl || resolved;
    if (/^https?:\/\//i.test(upstream)) {
      try {
        const r = await fetch(upstream);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          const buf = Buffer.from(ab);
          const ct = r.headers.get('content-type') || 'application/octet-stream';
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=300');
          return res.status(200).send(buf);
        }
      } catch (_) { /* fallback redirect */ }
    }

    return res.redirect(302, upstream);
  } catch (err) {
    console.error('GET /api/chat/avatar-url:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/participant-display?user_email=...
app.get('/api/chat/participant-display', async (req, res) => {
  try {
    const userRefRaw = req.query.user_ref != null ? String(req.query.user_ref).trim() : '';
    const userEmail = normEmail(req.query.user_email || userRefRaw);
    const userRef = userRefRaw ? userRefRaw.toLowerCase() : userEmail;
    if (!userRef) {
      return res
        .status(400)
        .json({success: false, error: 'user_ref or user_email required'});
    }

    const pickSubscriptionPhone = (row) => {
      if (!row) return null;
      const cands = [row.phone, row.mobile_phone, row.office_phone];
      for (const p of cands) {
        if (p != null && String(p).trim() !== '') return String(p).trim();
      }
      return null;
    };

    let sub = null;
    if (userRef.includes('@')) {
      const byEmail = await supabase
        .from('subscriptions')
        .select(
          'name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url, phone, mobile_phone, office_phone',
        )
        .ilike('email', userRef)
        .maybeSingle();
      sub = byEmail.data || null;
    } else if (CHAT_UUID_RE.test(userRef)) {
      const byId = await supabase
        .from('subscriptions')
        .select(
          'name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url, phone, mobile_phone, office_phone',
        )
        .eq('id', userRef)
        .maybeSingle();
      sub = byId.data || null;
    }
    if (sub) {
      const type = (sub.subscription_type || '').toLowerCase();
      let displayName = null;
      if (type === 'company') displayName = sub.business_name || sub.name || sub.contact_person_name || null;
      else if (type === 'broker') displayName = sub.broker_office_name || sub.name || sub.contact_person_name || null;
      else if (type === 'professional') displayName = sub.name || sub.business_name || sub.contact_person_name || null;
      else displayName = sub.name || sub.contact_person_name || sub.business_name || null;
      const profilePic = sub.profile_picture_url || (type === 'company' ? sub.company_logo_url : null) || null;
      const profileImageUrl = asPublicImageUrl(profilePic);
      const phone = pickSubscriptionPhone(sub);
      return res.json({
        success: true,
        name: displayName || null,
        profileImageUrl: profileImageUrl || null,
        phone: phone || null,
        subscription_type: type || null,
      });
    }

    const participantRef = userRef.includes('@') ? userEmail : userRef;
    const { data: participantRows } = await supabase
      .from('chat_participants')
      .select('display_name, profile_picture_url')
      .eq('user_id', participantRef)
      .limit(1);
    const row = participantRows && participantRows[0];
    if (row && (row.display_name || row.profile_picture_url)) {
      const profileImageUrl = asPublicImageUrl(row.profile_picture_url || null);
      return res.json({
        success: true,
        name: row.display_name || null,
        profileImageUrl: profileImageUrl || null,
      });
    }
    res.json({ success: true, name: null, profileImageUrl: null });
  } catch (err) {
    console.error('GET /api/chat/participant-display:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/messages?user_email=...&other_user_email=... OR conversation_id=...
app.get('/api/chat/messages', async (req, res) => {
  try {
    const myEmail = normEmail(req.query.user_email);
    const convIdParam =
      req.query.conversation_id != null
        ? String(req.query.conversation_id).trim()
        : '';
    const otherRefRaw =
      req.query.other_user_email != null
        ? String(req.query.other_user_email).trim().toLowerCase()
        : '';
    if (!myEmail) {
      return res.status(400).json({ success: false, error: 'user_email required' });
    }
    if (!convIdParam && !otherRefRaw) {
      return res.status(400).json({
        success: false,
        error: 'other_user_email or conversation_id required',
      });
    }

    let sharedConvId = convIdParam || null;

    if (sharedConvId) {
      const allowed = await userCanAccessConversation(myEmail, sharedConvId);
      if (!allowed) {
        return res.status(403).json({ success: false, error: 'Not a participant' });
      }
    } else {
      const otherRef = otherRefRaw;
      const [{ data: myParts }, { data: otherParts }] = await Promise.all([
        supabase.from('chat_participants').select('conversation_id').eq('user_id', myEmail),
        supabase.from('chat_participants').select('conversation_id').eq('user_id', otherRef),
      ]);
      const myConvIds = new Set((myParts || []).map((p) => p.conversation_id));
      const sharedConvIds = (otherParts || [])
        .map((p) => p.conversation_id)
        .filter((id) => myConvIds.has(id));
      if (sharedConvIds.length > 0) {
        if (sharedConvIds.length === 1) {
          sharedConvId = sharedConvIds[0];
        } else {
          const { data: latestRows } = await supabase
            .from('chat_messages')
            .select('conversation_id, created_at')
            .in('conversation_id', sharedConvIds)
            .order('created_at', { ascending: false })
            .limit(1);
          if (latestRows && latestRows.length > 0) {
            sharedConvId = latestRows[0].conversation_id;
          } else {
            const { data: convRows } = await supabase
              .from('chat_conversations')
              .select('id, last_message_at')
              .in('id', sharedConvIds)
              .order('last_message_at', { ascending: false, nullsFirst: false })
              .limit(1);
            sharedConvId =
              convRows && convRows[0] ? convRows[0].id : sharedConvIds[0];
          }
        }
      }

      if (!sharedConvId && (otherParts || []).length > 0) {
        const convId = (otherParts || [])[0].conversation_id;
        const { data: parts } = await supabase
          .from('chat_participants')
          .select('user_id')
          .eq('conversation_id', convId);
        if ((parts || []).length === 1) {
          await supabase
            .from('chat_participants')
            .insert({ conversation_id: convId, user_id: myEmail });
          sharedConvId = convId;
        }
      }
    }

    if (!sharedConvId) return res.json({ success: true, messages: [] });

    markChatConversationRead(myEmail, sharedConvId);

    let list;
    let exclusiveOfferOut = null;
    try {
      const [messages, eoRes] = await Promise.all([
        loadChatMessagesForConversation(sharedConvId, myEmail),
        supabase
          .from('chat_exclusive_offers')
          .select('*')
          .eq('conversation_id', sharedConvId)
          .maybeSingle(),
      ]);
      list = messages;
      if (!eoRes.error && eoRes.data) {
        exclusiveOfferOut = {
          conversationId: sharedConvId,
          status: eoRes.data.status,
          brokerEmail: normEmail(eoRes.data.broker_email),
          ownerEmail: normEmail(eoRes.data.owner_email),
          monthsCommitted:
            eoRes.data.months_committed != null
              ? Number(eoRes.data.months_committed)
              : null,
          listingId:
            eoRes.data.listing_id != null ? String(eoRes.data.listing_id) : null,
        };
      } else if (eoRes.error && !isMissingExclusiveOfferTableError(eoRes.error)) {
        console.warn('GET /api/chat/messages exclusive offer:', eoRes.error.message);
      }
    } catch (loadErr) {
      console.error('GET /api/chat/messages:', loadErr?.message || loadErr);
      return res.status(500).json({
        success: false,
        error: loadErr?.message || 'Unable to load chat messages',
      });
    }

    res.json({
      success: true,
      messages: list,
      conversation_id: sharedConvId,
      exclusiveOffer: exclusiveOfferOut,
    });
  } catch (err) {
    console.error('GET /api/chat/messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/exclusive-offer/respond — owner accepts or rejects (body: user_email, conversation_id, accept)
app.post('/api/chat/exclusive-offer/respond', async (req, res) => {
  try {
    const userEmail = normEmail(req.body.user_email);
    const convId = req.body.conversation_id != null ? String(req.body.conversation_id).trim() : '';
    const accept =
      req.body.accept === true ||
      req.body.accept === 'true' ||
      req.body.accept === 1 ||
      req.body.accept === '1';

    if (!userEmail || !convId) {
      return res.status(400).json({ success: false, error: 'user_email and conversation_id required' });
    }

    const { data: row, error: selErr } = await supabase
      .from('chat_exclusive_offers')
      .select('*')
      .eq('conversation_id', convId)
      .maybeSingle();
    if (selErr && !isMissingExclusiveOfferTableError(selErr)) {
      return res.status(500).json({ success: false, error: selErr.message });
    }
    if (!row) {
      return res.status(404).json({ success: false, error: 'לא נמצאה הצעת בלעדיות' });
    }
    if (normEmail(row.owner_email) !== userEmail) {
      return res.status(403).json({ success: false, error: 'רק בעל הנכס יכול לאשר או לדחות' });
    }

    const st = String(row.status || '').trim().toLowerCase();
    let nextStatus;

    if (accept) {
      if (st === 'accepted') {
        return res.json({ success: true, status: 'accepted' });
      }
      if (st !== 'pending' && st !== 'rejected') {
        return res.status(400).json({ success: false, error: 'לא ניתן לאשר במצב הנוכחי' });
      }
      nextStatus = 'accepted';
    } else {
      if (st === 'rejected') {
        return res.json({ success: true, status: 'rejected' });
      }
      if (st !== 'pending' && st !== 'accepted') {
        return res.status(400).json({ success: false, error: 'לא ניתן לדחות במצב הנוכחי' });
      }
      nextStatus = 'rejected';
    }

    const { error: upErr } = await supabase
      .from('chat_exclusive_offers')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('conversation_id', convId);
    if (upErr) {
      if (isMissingExclusiveOfferTableError(upErr)) {
        return res.status(500).json({
          success: false,
          error: 'טבלת הצעות בלעדיות חסרה — הרץ migration-chat-exclusive-offer.sql',
        });
      }
      return res.status(500).json({ success: false, error: upErr.message });
    }

    res.json({ success: true, status: nextStatus });
  } catch (err) {
    console.error('POST /api/chat/exclusive-offer/respond:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/chat/messages/:id - body/query: user_email. Only the sender may
// delete their own message (direct or group; both live in chat_messages).
app.delete('/api/chat/messages/:id', async (req, res) => {
  try {
    const messageId = req.params.id != null ? String(req.params.id).trim() : '';
    const userEmail = normEmail(req.body.user_email || req.query.user_email);
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'message id required' });
    }
    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'user_email required' });
    }

    const { data: row, error: findErr } = await supabase
      .from('chat_messages')
      .select('id, sender_id')
      .eq('id', messageId)
      .maybeSingle();
    if (findErr) {
      console.error('DELETE /api/chat/messages find:', findErr.message);
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!row) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    if (normEmail(row.sender_id) !== userEmail) {
      return res.status(403).json({ success: false, error: 'You can only delete your own messages' });
    }

    const { error: delErr } = await supabase
      .from('chat_messages')
      .delete()
      .eq('id', messageId);
    if (delErr) {
      console.error('DELETE /api/chat/messages delete:', delErr.message);
      return res.status(500).json({ success: false, error: delErr.message });
    }

    res.json({ success: true, id: messageId });
  } catch (err) {
    console.error('DELETE /api/chat/messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/messages - body: sender_email, receiver_email, body (optional if media); optional media_type, media_url
app.post('/api/chat/messages', async (req, res) => {
  try {
    const senderEmail = normEmail(req.body.sender_email || req.query.sender_email);
    const receiverEmail = normEmail(req.body.receiver_email || req.query.receiver_email);
    const bodyRaw = req.body.body != null ? String(req.body.body).trim() : '';
    const body = bodyRaw;
    const mediaTypeRaw = req.body.media_type != null ? String(req.body.media_type).trim().toLowerCase() : '';
    const mediaUrlRaw = req.body.media_url != null ? String(req.body.media_url).trim() : '';
    const mediaType = mediaTypeRaw === 'image' || mediaTypeRaw === 'audio' ? mediaTypeRaw : '';
    const mediaUrl = mediaUrlRaw;
    const receiverDisplayName = req.body.receiver_display_name != null ? String(req.body.receiver_display_name).trim() || null : null;
    const receiverProfilePictureUrl = req.body.receiver_profile_picture_url != null ? String(req.body.receiver_profile_picture_url).trim() || null : null;
    const senderDisplayName = req.body.sender_display_name != null ? String(req.body.sender_display_name).trim() || null : null;
    const senderProfilePictureUrl = req.body.sender_profile_picture_url != null ? String(req.body.sender_profile_picture_url).trim() || null : null;
    const listingIdRaw = req.body.listing_id != null ? String(req.body.listing_id).trim() : '';
    const listingIdForMessage =
      listingIdRaw && CHAT_LISTING_ID_UUID_RE.test(listingIdRaw) ? listingIdRaw : null;
    const listingShareToStore =
      req.body.listing_share === true ||
      req.body.listing_share === 'true' ||
      req.body.listing_share === 1 ||
      req.body.listing_share === '1';

    if (!senderEmail || !receiverEmail) {
      return res.status(400).json({ success: false, error: 'sender_email and receiver_email required' });
    }
    if (!body && !mediaUrl) {
      return res.status(400).json({ success: false, error: 'body or media_url required' });
    }
    if (mediaUrl && !mediaType) {
      return res.status(400).json({ success: false, error: 'media_type must be image or audio when media_url is set' });
    }
    if (mediaType && !mediaUrl) {
      return res.status(400).json({ success: false, error: 'media_url required when media_type is set' });
    }

    let convId = null;
    const { data: senderConvs } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', senderEmail);
    const senderConvIds = (senderConvs || []).map(p => p.conversation_id);
    if (senderConvIds.length > 0) {
      const { data: otherIn } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', receiverEmail).in('conversation_id', senderConvIds);
      const candidateConvIds = [];
      for (const r of otherIn || []) {
        const { data: parts } = await supabase.from('chat_participants').select('user_id').eq('conversation_id', r.conversation_id);
        const emails = (parts || []).map(p => normEmail(p.user_id));
        if (emails.length === 2 && emails.includes(senderEmail) && emails.includes(receiverEmail)) {
          candidateConvIds.push(r.conversation_id);
        }
      }
      if (candidateConvIds.length === 1) {
        convId = candidateConvIds[0];
      } else if (candidateConvIds.length > 1) {
        // Prefer the conversation with the most recent activity to avoid splitting threads.
        const { data: latestRows } = await supabase
          .from('chat_messages')
          .select('conversation_id, created_at')
          .in('conversation_id', candidateConvIds)
          .order('created_at', { ascending: false })
          .limit(1);
        if (latestRows && latestRows.length > 0) {
          convId = latestRows[0].conversation_id;
        } else {
          const { data: convRows } = await supabase
            .from('chat_conversations')
            .select('id, last_message_at')
            .in('id', candidateConvIds)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(1);
          convId = convRows && convRows[0] ? convRows[0].id : candidateConvIds[0];
        }
      }
    }
    if (!convId) {
      const { data: newConv, error: newConvErr } = await supabase.from('chat_conversations').insert({ type: 'direct' }).select('id').single();
      if (newConvErr || !newConv?.id) return res.status(500).json({ success: false, error: 'Failed to create conversation' });
      convId = newConv.id;
      const { error: insertErr } = await supabase.from('chat_participants').insert([
        { conversation_id: convId, user_id: senderEmail },
        { conversation_id: convId, user_id: receiverEmail },
      ]);
      if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
      if (receiverDisplayName != null || receiverProfilePictureUrl != null) {
        const u = {};
        if (receiverDisplayName != null) u.display_name = receiverDisplayName;
        if (receiverProfilePictureUrl != null) u.profile_picture_url = receiverProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', receiverEmail);
      }
      if (senderDisplayName != null || senderProfilePictureUrl != null) {
        const u = {};
        if (senderDisplayName != null) u.display_name = senderDisplayName;
        if (senderProfilePictureUrl != null) u.profile_picture_url = senderProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', senderEmail);
      }
    } else {
      if (receiverDisplayName != null || receiverProfilePictureUrl != null) {
        const u = {};
        if (receiverDisplayName != null) u.display_name = receiverDisplayName;
        if (receiverProfilePictureUrl != null) u.profile_picture_url = receiverProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', receiverEmail);
      }
      if (senderDisplayName != null || senderProfilePictureUrl != null) {
        const u = {};
        if (senderDisplayName != null) u.display_name = senderDisplayName;
        if (senderProfilePictureUrl != null) u.profile_picture_url = senderProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', senderEmail);
      }
    }

    /**
     * Listing id on insert: for explicit feed shares (`listing_share`), trust client UUID so chat can render
     * the post card. For normal messages, only attach when the row exists in ads (badge / FK safety).
     */
    let listingToStore = null;
    if (listingIdForMessage) {
      if (listingShareToStore) {
        listingToStore = listingIdForMessage;
      } else {
        const { data: adRow } = await supabase
          .from('ads')
          .select('id')
          .eq('id', listingIdForMessage)
          .maybeSingle();
        if (adRow?.id) listingToStore = listingIdForMessage;
      }
    }

    /** DBs without migration-chat-media.sql lack media_*; without migration-chat-listing-share-flag.sql lack is_listing_share. */
    const directInsertSelectVariants = [
      'id, sender_id, body, created_at, media_type, media_url, listing_id, is_listing_share',
      'id, sender_id, body, created_at, listing_id, is_listing_share',
      'id, sender_id, body, created_at, media_type, media_url, listing_id',
      'id, sender_id, body, created_at, listing_id',
      'id, sender_id, body, created_at, media_type, media_url',
      'id, sender_id, body, created_at',
    ];
    const mkInsertPayload = (withMedia, withListing) => {
      const p = {
        conversation_id: convId,
        sender_id: senderEmail,
        receiver_id: receiverEmail,
        body: body || '',
      };
      if (withMedia && mediaType && mediaUrl) {
        p.media_type = mediaType;
        p.media_url = mediaUrl;
      }
      if (withListing && listingToStore) p.listing_id = listingToStore;
      if (listingShareToStore) p.is_listing_share = true;
      return p;
    };

    const mapDirectMessageResponse = (row, insertPayload) => ({
      id: row.id,
      senderId: row.sender_id,
      body: row.body,
      mediaType: row.media_type != null ? row.media_type : insertPayload.media_type || null,
      mediaUrl: row.media_url != null ? row.media_url : insertPayload.media_url || null,
      listingId:
        row.listing_id != null
          ? String(row.listing_id)
          : insertPayload.listing_id != null
            ? String(insertPayload.listing_id)
            : null,
      listingShare:
        row.is_listing_share === true ||
        insertPayload.is_listing_share === true,
      createdAt: row.created_at,
      isMe: true,
    });

    const insertAttempts = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    let msg = null;
    let winningPayload = null;
    let insertErr = null;
    const triedKeys = new Set();
    outer: for (const [wm, wl] of insertAttempts) {
      const insertPayload = mkInsertPayload(wm, wl);
      const dedupeKey = JSON.stringify(insertPayload);
      if (triedKeys.has(dedupeKey)) continue;
      triedKeys.add(dedupeKey);
      const payloadHasMedia = !!(insertPayload.media_type && insertPayload.media_url);
      for (const sel of directInsertSelectVariants) {
        const attempt = await supabase
          .from('chat_messages')
          .insert(insertPayload)
          .select(sel)
          .single();
        if (!attempt.error) {
          msg = attempt.data;
          winningPayload = insertPayload;
          break outer;
        }
        insertErr = attempt.error;
        const em = String(attempt.error.message || '').toLowerCase();
        if (
          payloadHasMedia &&
          (em.includes('media_type') || em.includes('media_url'))
        ) {
          console.warn('[POST /api/chat/messages] insert attempt failed (no media columns?)', {
            withMedia: wm,
            withListing: wl,
            message: attempt.error.message,
          });
          continue outer;
        }
        if (!isMissingColumnError(attempt.error)) {
          console.warn('[POST /api/chat/messages] insert attempt failed', {
            withMedia: wm,
            withListing: wl,
            message: attempt.error.message,
          });
          continue outer;
        }
      }
    }

    if (!msg) {
      /** Last resort: try listing+share with media, then same without media columns (older DBs). */
      const rowBase = {
        conversation_id: convId,
        sender_id: senderEmail,
        receiver_id: receiverEmail,
        body: body || '',
      };
      const rowListingShare = { ...rowBase };
      if (listingShareToStore) rowListingShare.is_listing_share = true;
      if (listingToStore) rowListingShare.listing_id = listingToStore;

      const fallbackAttempts = [];
      if (mediaType && mediaUrl) {
        fallbackAttempts.push({
          ...rowListingShare,
          media_type: mediaType,
          media_url: mediaUrl,
        });
      }
      fallbackAttempts.push(rowListingShare);

      let fd = null;
      let fallbackPayload = null;
      const triedFb = new Set();
      inner: for (const fallbackRow of fallbackAttempts) {
        const dedupe = JSON.stringify(fallbackRow);
        if (triedFb.has(dedupe)) continue;
        triedFb.add(dedupe);
        for (const sel of directInsertSelectVariants) {
          const fallback = await supabase
            .from('chat_messages')
            .insert(fallbackRow)
            .select(sel)
            .single();
          if (!fallback.error) {
            fd = fallback.data;
            fallbackPayload = fallbackRow;
            break inner;
          }
          insertErr = fallback.error;
          const em = String(fallback.error.message || '').toLowerCase();
          if (
            (fallbackRow.media_type || fallbackRow.media_url) &&
            (em.includes('media_type') || em.includes('media_url'))
          ) {
            continue inner;
          }
          if (!isMissingColumnError(fallback.error)) {
            continue inner;
          }
        }
      }
      if (!fd || !fallbackPayload) {
        console.error('[POST /api/chat/messages] insert exhausted', insertErr?.message);
        return res.status(500).json({
          success: false,
          error: insertErr?.message || 'Failed to save message',
        });
      }
      await supabase.from('chat_conversations').update({ last_message_at: fd.created_at }).eq('id', convId);
      await upsertExclusiveOfferPending(supabase, {
        convId,
        body,
        listingId: listingToStore,
        brokerEmail: senderEmail,
        ownerEmail: receiverEmail,
      });
      return res.json({
        success: true,
        conversation_id: convId,
        message: mapDirectMessageResponse(fd, fallbackPayload),
      });
    }
    await supabase.from('chat_conversations').update({ last_message_at: msg.created_at }).eq('id', convId);
    await upsertExclusiveOfferPending(supabase, {
      convId,
      body,
      listingId: listingToStore,
      brokerEmail: senderEmail,
      ownerEmail: receiverEmail,
    });
    res.json({
      success: true,
      conversation_id: convId,
      message: mapDirectMessageResponse(msg, winningPayload),
    });
  } catch (err) {
    console.error('POST /api/chat/messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/listings/:id/preview - lightweight listing preview for chat shared-post cards
app.get('/api/listings/:id/preview', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || !CHAT_LISTING_ID_UUID_RE.test(String(id).trim())) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    let row = null;
    const primary = await supabase
      .from('ads')
      .select(
        'id, description, feed_post, property_type, main_image_url, additional_image_urls, video_url, price, address, purpose',
      )
      .eq('id', id)
      .maybeSingle();
    if (primary.error && isMissingColumnError(primary.error)) {
      const fb = await supabase
        .from('ads')
        .select('id, description, main_image_url, additional_image_urls, video_url, price, address, purpose')
        .eq('id', id)
        .maybeSingle();
      row = fb.error ? null : fb.data;
    } else if (!primary.error) {
      row = primary.data;
    } else {
      console.error('listing preview ad select err:', primary.error.message);
    }
    if (!row) {
      return res.json({
        success: true,
        listing: {
          id,
          description: '',
          mediaUrl: null,
          feedPost: false,
          propertyType: null,
          price: null,
          address: null,
          purpose: null,
          purposeLabel: 'למכירה',
        },
      });
    }
    const additional = Array.isArray(row.additional_image_urls) ? row.additional_image_urls : [];
    const mediaUrl =
      (row.main_image_url && String(row.main_image_url).trim()) ||
      (additional.find(u => u && String(u).trim()) || null);
    const purposeRaw = row.purpose != null ? String(row.purpose).trim().toLowerCase() : '';
    const purposeLabel = purposeRaw === 'rent' ? 'להשכרה' : 'למכירה';
    const priceNum = row.price != null ? Number(row.price) : null;
    return res.json({
      success: true,
      listing: {
        id: row.id,
        description: row.description || '',
        mediaUrl: mediaUrl || null,
        feedPost: row.feed_post === true || row.feed_post === 'true' || row.feed_post === 't',
        propertyType: row.property_type || null,
        price: Number.isFinite(priceNum) ? priceNum : null,
        address: row.address != null && String(row.address).trim() ? String(row.address).trim() : null,
        purpose: purposeRaw || null,
        purposeLabel,
      },
    });
  } catch (err) {
    console.error('GET /api/listings/:id/preview:', err);
    return res.json({
      success: true,
      listing: {
        id: req.params.id || null,
        description: '',
        mediaUrl: null,
        feedPost: false,
        propertyType: null,
        price: null,
        address: null,
        purpose: null,
        purposeLabel: 'למכירה',
      },
    });
  }
});

// POST /api/listings/:id/view - record a view (increment view_count)
app.post('/api/listings/:id/view', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Missing listing id' });
    const { data: row, error: selectError } = await supabase.from('ads').select('view_count').eq('id', id).maybeSingle();
    if (selectError) {
      console.warn('View count select failed (column may be missing):', selectError.message);
      return res.status(200).json({ success: true });
    }
    const current = row?.view_count != null ? Number(row.view_count) : 0;
    const { error } = await supabase.from('ads').update({ view_count: current + 1 }).eq('id', id);
    if (error) {
      console.warn('View count update failed:', error.message);
      return res.status(200).json({ success: true });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error recording view:', e);
    return res.status(200).json({ success: true });
  }
});

// POST /api/listings/:id/share - increment share_count once per share action
app.post('/api/listings/:id/share', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Missing listing id' });
    const countBy = Math.max(1, Number.isFinite(Number(req.body?.count)) ? Number(req.body.count) : 1);
    const { data: row, error: selectError } = await supabase
      .from('ads')
      .select('share_count')
      .eq('id', id)
      .maybeSingle();
    if (selectError) {
      console.warn('Share count select failed (column may be missing):', selectError.message);
      return res.status(200).json({ success: true });
    }
    const current = row?.share_count != null ? Number(row.share_count) : 0;
    const next = current + countBy;
    const { error } = await supabase.from('ads').update({ share_count: next }).eq('id', id);
    if (error) {
      console.warn('Share count update failed:', error.message);
      return res.status(200).json({ success: true, share_count: current });
    }
    return res.json({ success: true, share_count: next });
  } catch (e) {
    console.error('Error recording share:', e);
    return res.status(200).json({ success: true });
  }
});

function isPostListingRow(row) {
  if (!row) return false;
  const type = String(row.property_type || '').toLowerCase();
  if (type.includes('post')) return true;
  if (row.feed_post === true) return true;
  if (String(row.feed_post || '').toLowerCase() === 'true') return true;
  if (String(row.feed_post || '').toLowerCase() === 't') return true;
  const description = String(row.description || '').trim().toLowerCase();
  return description === 'פוסט' || description === 'post';
}

function isMissingTableError(err) {
  return err && (err.code === '42P01' || String(err.message || '').toLowerCase().includes('does not exist'));
}

function isMissingColumnError(err) {
  return err && err.code === '42703';
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );
}

async function fetchAdRowWithFallback(id, reqTag, selectVariants, defaults = {}) {
  for (let i = 0; i < selectVariants.length; i += 1) {
    const selectExpr = selectVariants[i];
    const result = await supabase.from('ads').select(selectExpr).eq('id', id).maybeSingle();
    if (!result.error) {
      return { row: { ...defaults, ...(result.data || {}) }, error: null };
    }
    if (!isMissingColumnError(result.error) || i === selectVariants.length - 1) {
      console.error(`${reqTag} select failed`, {
        selectExpr,
        code: result.error.code,
        message: result.error.message,
        details: result.error.details,
        hint: result.error.hint,
      });
      return { row: null, error: result.error };
    }
    console.warn(`${reqTag} select fallback due to missing column`, {
      from: selectExpr,
      code: result.error.code,
      message: result.error.message,
    });
  }
  return { row: null, error: new Error('No select variants configured') };
}

async function fetchPostRowForLikeRoutes(id, reqTag) {
  return fetchAdRowWithFallback(
    id,
    reqTag,
    [
      'property_type, feed_post, description, post_like_count',
      'property_type, description, post_like_count',
      'property_type, description',
      'property_type',
    ],
    { feed_post: null, description: null, post_like_count: null },
  );
}

// POST /api/listings/:id/like - add like (user_id in body); increment ads.like_count if column exists
app.post('/api/listings/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null) ? String(req.body.user_id).trim() : (req.query.user_id && String(req.query.user_id).trim());
    if (!id || !user_id) return res.status(400).json({ success: false, error: 'Missing listing id or user_id' });
    const { row: targetRow, error: targetErr } = await fetchAdRowWithFallback(
      id,
      '[POST /api/listings/:id/like]',
      ['property_type, feed_post, description', 'property_type, description', 'property_type'],
      { feed_post: null, description: null },
    );
    if (targetErr) return res.status(500).json({ success: false, error: targetErr.message });
    if (targetRow && isPostListingRow(targetRow)) {
      return res.status(400).json({
        success: false,
        error: 'This listing is a post. Use /api/posts/:id/like for post likes.',
      });
    }
    const { error } = await supabase.from('ad_likes').insert({ ad_id: id, user_id });
    if (error && error.code !== '23505') return res.status(500).json({ success: false, error: error.message }); // 23505 = duplicate key, already liked
    if (!error) {
      const { data: row, error: selectError } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
      if (!selectError && row != null) {
        const current = row.like_count != null ? Number(row.like_count) : 0;
        await supabase.from('ads').update({ like_count: current + 1 }).eq('id', id);
      }
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error adding like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/listings/:id/like - remove like (user_id in query or body); decrement ads.like_count if column exists
app.delete('/api/listings/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null) ? String(req.body.user_id).trim() : (req.query && req.query.user_id && String(req.query.user_id).trim());
    if (!id || !user_id) return res.status(400).json({ success: false, error: 'Missing listing id or user_id' });
    const { row: targetRow, error: targetErr } = await fetchAdRowWithFallback(
      id,
      '[DELETE /api/listings/:id/like]',
      ['property_type, feed_post, description', 'property_type, description', 'property_type'],
      { feed_post: null, description: null },
    );
    if (targetErr) return res.status(500).json({ success: false, error: targetErr.message });
    if (targetRow && isPostListingRow(targetRow)) {
      return res.status(400).json({
        success: false,
        error: 'This listing is a post. Use /api/posts/:id/like for post likes.',
      });
    }
    const { error } = await supabase.from('ad_likes').delete().eq('ad_id', id).eq('user_id', user_id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    const { data: row, error: selectError } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
    if (!selectError && row != null) {
      const current = row.like_count != null ? Number(row.like_count) : 0;
      await supabase.from('ads').update({ like_count: Math.max(0, current - 1) }).eq('id', id);
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error removing like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/posts/:id/like - add like (user_id in body); increment ads.post_like_count
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null)
      ? String(req.body.user_id).trim()
      : (req.query.user_id && String(req.query.user_id).trim());
    const reqTag = `[POST /api/posts/${id}/like]`;
    console.log(`${reqTag} start`, { user_id });
    if (!id || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing post id or user_id' });
    }
    const { row: rowType, error: typeErr } = await fetchPostRowForLikeRoutes(id, reqTag);
    if (typeErr) return res.status(500).json({ success: false, error: typeErr.message });
    if (!rowType) return res.status(404).json({ success: false, error: 'Post not found' });
    if (!isPostListingRow(rowType)) {
      return res.status(400).json({ success: false, error: 'Listing is not a post' });
    }
    let duplicateLike = false;
    let inserted = false;
    const { error: postLikesErr } = await supabase.from('post_likes').insert({ ad_id: id, user_id });
    if (postLikesErr) {
      if (postLikesErr.code === '23505') {
        duplicateLike = true;
      } else if (isMissingTableError(postLikesErr)) {
        console.warn(`${reqTag} post_likes table missing, fallback to ad_likes`, {
          code: postLikesErr.code,
          message: postLikesErr.message,
          details: postLikesErr.details,
          hint: postLikesErr.hint,
        });
        const { error: fallbackErr } = await supabase.from('ad_likes').insert({ ad_id: id, user_id });
        if (fallbackErr && fallbackErr.code !== '23505') {
          console.error(`${reqTag} fallback ad_likes insert failed`, fallbackErr);
          return res.status(500).json({ success: false, error: fallbackErr.message });
        }
        duplicateLike = fallbackErr?.code === '23505';
        inserted = !fallbackErr;
      } else {
        console.error(`${reqTag} post_likes insert failed`, postLikesErr);
        return res.status(500).json({ success: false, error: postLikesErr.message });
      }
    } else {
      inserted = true;
    }
    if (inserted && !duplicateLike) {
      const currentPostLikeCount =
        rowType.post_like_count != null ? Number(rowType.post_like_count) : 0;
      const { error: postCountErr } = await supabase
        .from('ads')
        .update({ post_like_count: currentPostLikeCount + 1 })
        .eq('id', id);
      if (postCountErr) {
        if (isMissingColumnError(postCountErr)) {
          console.warn(`${reqTag} post_like_count column missing, fallback to like_count`, {
            code: postCountErr.code,
            message: postCountErr.message,
          });
          const { data: likeRow } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
          const currentLikeCount = likeRow?.like_count != null ? Number(likeRow.like_count) : 0;
          const { error: likeCountErr } = await supabase
            .from('ads')
            .update({ like_count: currentLikeCount + 1 })
            .eq('id', id);
          if (likeCountErr) {
            console.error(`${reqTag} fallback like_count update failed`, likeCountErr);
            return res.status(500).json({ success: false, error: likeCountErr.message });
          }
        } else {
          console.error(`${reqTag} post_like_count update failed`, postCountErr);
          return res.status(500).json({ success: false, error: postCountErr.message });
        }
      }
    }
    console.log(`${reqTag} success`, { duplicateLike });
    return res.json({ success: true });
  } catch (e) {
    console.error('Error adding post like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/posts/:id/like - remove like; decrement ads.post_like_count
app.delete('/api/posts/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null)
      ? String(req.body.user_id).trim()
      : (req.query && req.query.user_id && String(req.query.user_id).trim());
    const reqTag = `[DELETE /api/posts/${id}/like]`;
    console.log(`${reqTag} start`, { user_id });
    if (!id || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing post id or user_id' });
    }
    const { row: rowType, error: typeErr } = await fetchPostRowForLikeRoutes(id, reqTag);
    if (typeErr) return res.status(500).json({ success: false, error: typeErr.message });
    if (!rowType) return res.status(404).json({ success: false, error: 'Post not found' });
    if (!isPostListingRow(rowType)) {
      return res.status(400).json({ success: false, error: 'Listing is not a post' });
    }
    let removedLike = false;
    const { data: deletedPostLikes, error: postLikesErr } = await supabase
      .from('post_likes')
      .delete()
      .eq('ad_id', id)
      .eq('user_id', user_id)
      .select('ad_id');
    if (postLikesErr) {
      if (isMissingTableError(postLikesErr)) {
        console.warn(`${reqTag} post_likes table missing, fallback delete from ad_likes`, {
          code: postLikesErr.code,
          message: postLikesErr.message,
        });
        const { data: deletedAdLikes, error: fallbackDelErr } = await supabase
          .from('ad_likes')
          .delete()
          .eq('ad_id', id)
          .eq('user_id', user_id)
          .select('ad_id');
        if (fallbackDelErr) {
          console.error(`${reqTag} fallback ad_likes delete failed`, fallbackDelErr);
          return res.status(500).json({ success: false, error: fallbackDelErr.message });
        }
        removedLike = Array.isArray(deletedAdLikes) && deletedAdLikes.length > 0;
      } else {
        console.error(`${reqTag} post_likes delete failed`, postLikesErr);
        return res.status(500).json({ success: false, error: postLikesErr.message });
      }
    } else {
      removedLike = Array.isArray(deletedPostLikes) && deletedPostLikes.length > 0;
    }
    if (!removedLike) {
      console.log(`${reqTag} no like row deleted (already unliked)`);
      return res.json({ success: true });
    }
    const current = rowType.post_like_count != null ? Number(rowType.post_like_count) : 0;
    const { error: postCountErr } = await supabase
      .from('ads')
      .update({ post_like_count: Math.max(0, current - 1) })
      .eq('id', id);
    if (postCountErr) {
      if (isMissingColumnError(postCountErr)) {
        console.warn(`${reqTag} post_like_count column missing, fallback decrement like_count`, {
          code: postCountErr.code,
          message: postCountErr.message,
        });
        const { data: likeRow } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
        const currentLikeCount = likeRow?.like_count != null ? Number(likeRow.like_count) : 0;
        const { error: likeCountErr } = await supabase
          .from('ads')
          .update({ like_count: Math.max(0, currentLikeCount - 1) })
          .eq('id', id);
        if (likeCountErr) {
          console.error(`${reqTag} fallback like_count decrement failed`, likeCountErr);
          return res.status(500).json({ success: false, error: likeCountErr.message });
        }
      } else {
        console.error(`${reqTag} post_like_count decrement failed`, postCountErr);
        return res.status(500).json({ success: false, error: postCountErr.message });
      }
    }
    console.log(`${reqTag} success`);
    return res.json({ success: true });
  } catch (e) {
    console.error('Error removing post like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

const POST_PUBLISHER_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function collectPostPublisherIds(supabase, postRow, adId) {
  const publisherIds = new Set();
  const addId = raw => {
    if (raw == null) return;
    const pid = String(raw).trim();
    if (POST_PUBLISHER_UUID_REGEX.test(pid)) publisherIds.add(pid);
  };
  if (postRow) {
    addId(postRow.subscription_id);
    addId(postRow.owner_id);
  }
  if (adId) {
    try {
      const { data: row } = await supabase
        .from('ads')
        .select('subscription_id, owner_id')
        .eq('id', adId)
        .maybeSingle();
      if (row) {
        addId(row.subscription_id);
        addId(row.owner_id);
      }
    } catch (_) {
      /* optional fallback */
    }
  }
  return publisherIds;
}

function commentIsFromPostPublisher(commentUserId, publisherIds, postRow = null) {
  const uid = commentUserId == null ? '' : String(commentUserId).trim();
  if (!uid) return false;
  if (publisherIds.has(uid)) return true;
  if (POST_PUBLISHER_UUID_REGEX.test(uid) && publisherIds.has(uid)) return true;
  if (postRow) {
    const owner = postRow.owner_id == null ? '' : String(postRow.owner_id).trim();
    const sub =
      postRow.subscription_id == null ? '' : String(postRow.subscription_id).trim();
    if (owner && owner === uid) return true;
    if (sub && sub === uid) return true;
  }
  return false;
}

// GET /api/posts/:id/comments - comments list for a post listing
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = req.params.id;
    const userIdParam =
      typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
    if (!id) return res.status(400).json({ success: false, error: 'Missing post id' });
    const { row: postRow, error: postErr } = await fetchAdRowWithFallback(
      id,
      `[GET /api/posts/${id}/comments]`,
      [
        'id, property_type, feed_post, description, subscription_id, owner_id',
        'id, property_type, description, subscription_id, owner_id',
        'id, property_type, subscription_id, owner_id',
        'id, property_type',
      ],
      { feed_post: null, description: null },
    );
    if (postErr) return res.status(500).json({ success: false, error: postErr.message });
    if (!postRow) return res.status(404).json({ success: false, error: 'Post not found' });
    if (!isPostListingRow(postRow)) {
      return res.status(400).json({ success: false, error: 'Listing is not a post' });
    }
    const publisherIds = await collectPostPublisherIds(supabase, postRow, id);
    const { data: rows, error } = await supabase
      .from('post_comments')
      .select('id, ad_id, user_id, comment_text, commenter_name, commenter_image_url, comment_image_url, likes_count, dislikes_count, created_at')
      .eq('ad_id', id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    let reactionByCommentId = {};
    if (userIdParam && rows && rows.length > 0) {
      try {
        const ids = rows.map(r => r.id).filter(Boolean);
        const { data: reactionRows } = await supabase
          .from('post_comment_reactions')
          .select('comment_id, reaction_type')
          .eq('user_id', userIdParam)
          .in('comment_id', ids);
        reactionByCommentId = (reactionRows || []).reduce((acc, r) => {
          if (r.comment_id) acc[r.comment_id] = r.reaction_type || null;
          return acc;
        }, {});
      } catch (_) { /* optional table may not exist yet */ }
    }
    return res.json({
      success: true,
      comments: (rows || []).map(r => ({
        id: r.id,
        ad_id: r.ad_id,
        user_id: r.user_id,
        comment_text: r.comment_text || '',
        commenter_name: r.commenter_name || 'משתמש',
        commenter_image_url: r.commenter_image_url || null,
        comment_image_url: r.comment_image_url || null,
        likes_count: r.likes_count != null ? Number(r.likes_count) : 0,
        dislikes_count: r.dislikes_count != null ? Number(r.dislikes_count) : 0,
        my_reaction: reactionByCommentId[r.id] || null,
        is_publisher: commentIsFromPostPublisher(r.user_id, publisherIds, postRow),
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    console.error('GET /api/posts/:id/comments:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/posts/:id/comments - add comment and increment ads.comment_count
app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id =
      req.body && req.body.user_id != null ? String(req.body.user_id).trim() : null;
    const text =
      req.body && req.body.text != null ? String(req.body.text).trim() : '';
    const imageUrlRaw =
      req.body && req.body.image_url != null ? String(req.body.image_url).trim() : '';
    if (!id || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing post id or user_id' });
    }
    if (!text && !imageUrlRaw) {
      return res.status(400).json({ success: false, error: 'Comment text or image is required' });
    }
    const { row: postRow, error: postErr } = await fetchAdRowWithFallback(
      id,
      `[POST /api/posts/${id}/comments]`,
      [
        'id, property_type, feed_post, description, comment_count, subscription_id, owner_id',
        'id, property_type, description, comment_count, subscription_id, owner_id',
        'id, property_type, description, comment_count',
        'id, property_type, description',
        'id, property_type',
      ],
      { feed_post: null, description: null, comment_count: 0 },
    );
    if (postErr) return res.status(500).json({ success: false, error: postErr.message });
    if (!postRow) return res.status(404).json({ success: false, error: 'Post not found' });
    if (!isPostListingRow(postRow)) {
      return res.status(400).json({ success: false, error: 'Listing is not a post' });
    }

    let commenterName = 'משתמש';
    let commenterImageUrl = null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(user_id)) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('subscription_type, name, business_name, contact_person_name, profile_picture_url, company_logo_url')
        .eq('id', user_id)
        .maybeSingle();
      if (sub) {
        const subType = String(sub.subscription_type || '').toLowerCase();
        commenterName =
          subType === 'company'
            ? (sub.business_name || sub.name || sub.contact_person_name || commenterName)
            : (sub.name || sub.contact_person_name || sub.business_name || commenterName);
        commenterImageUrl = sub.profile_picture_url || sub.company_logo_url || null;
      }
    } else {
      const { data: cp } = await supabase
        .from('chat_participants')
        .select('display_name, profile_picture_url')
        .eq('user_id', user_id)
        .maybeSingle();
      if (cp) {
        commenterName = cp.display_name || commenterName;
        commenterImageUrl = cp.profile_picture_url || null;
      }
    }

    const { data: inserted, error: insErr } = await supabase
      .from('post_comments')
      .insert({
        ad_id: id,
        user_id,
        comment_text: text,
        commenter_name: commenterName,
        commenter_image_url: commenterImageUrl,
        comment_image_url: imageUrlRaw || null,
      })
      .select('id, ad_id, user_id, comment_text, commenter_name, commenter_image_url, comment_image_url, likes_count, dislikes_count, created_at')
      .single();
    if (insErr) return res.status(500).json({ success: false, error: insErr.message });

    const currentCount = postRow.comment_count != null ? Number(postRow.comment_count) : 0;
    await supabase.from('ads').update({ comment_count: currentCount + 1 }).eq('id', id);

    const publisherIds = await collectPostPublisherIds(supabase, postRow, id);

    return res.json({
      success: true,
      comment: {
        id: inserted.id,
        ad_id: inserted.ad_id,
        user_id: inserted.user_id,
        comment_text: inserted.comment_text || '',
        commenter_name: inserted.commenter_name || commenterName,
        commenter_image_url: inserted.commenter_image_url || commenterImageUrl,
        comment_image_url: inserted.comment_image_url || null,
        likes_count: inserted.likes_count != null ? Number(inserted.likes_count) : 0,
        dislikes_count: inserted.dislikes_count != null ? Number(inserted.dislikes_count) : 0,
        my_reaction: null,
        is_publisher: commentIsFromPostPublisher(
          inserted.user_id,
          publisherIds,
          postRow,
        ),
        created_at: inserted.created_at,
      },
    });
  } catch (e) {
    console.error('POST /api/posts/:id/comments:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/posts/:id/comments/:commentId/reaction - set like/dislike reaction on comment
app.post('/api/posts/:id/comments/:commentId/reaction', async (req, res) => {
  try {
    const id = req.params.id;
    const commentId = req.params.commentId;
    const user_id =
      req.body && req.body.user_id != null ? String(req.body.user_id).trim() : null;
    const reaction_type =
      req.body && req.body.reaction_type != null
        ? String(req.body.reaction_type).trim().toLowerCase()
        : '';
    if (!id || !commentId || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing post id, comment id or user_id' });
    }
    if (!isUuidLike(commentId)) {
      return res.status(400).json({ success: false, error: 'Invalid comment id' });
    }
    if (reaction_type !== 'like' && reaction_type !== 'dislike') {
      return res.status(400).json({ success: false, error: 'reaction_type must be like/dislike' });
    }

    const { data: commentRow, error: commentErr } = await supabase
      .from('post_comments')
      .select('id, ad_id, likes_count, dislikes_count')
      .eq('id', commentId)
      .eq('ad_id', id)
      .maybeSingle();
    if (commentErr) return res.status(500).json({ success: false, error: commentErr.message });
    if (!commentRow) return res.status(404).json({ success: false, error: 'Comment not found' });

    const { data: existing } = await supabase
      .from('post_comment_reactions')
      .select('reaction_type')
      .eq('comment_id', commentId)
      .eq('user_id', user_id)
      .maybeSingle();
    const prevReaction = existing?.reaction_type || null;
    if (prevReaction === reaction_type) {
      return res.json({ success: true });
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('post_comment_reactions')
        .update({ reaction_type })
        .eq('comment_id', commentId)
        .eq('user_id', user_id);
      if (upErr) return res.status(500).json({ success: false, error: upErr.message });
    } else {
      const { error: insErr } = await supabase
        .from('post_comment_reactions')
        .insert({
          comment_id: commentId,
          ad_id: id,
          user_id,
          reaction_type,
        });
      if (insErr) return res.status(500).json({ success: false, error: insErr.message });
    }

    let likes = Number(commentRow.likes_count || 0);
    let dislikes = Number(commentRow.dislikes_count || 0);
    if (prevReaction === 'like') likes = Math.max(0, likes - 1);
    if (prevReaction === 'dislike') dislikes = Math.max(0, dislikes - 1);
    if (reaction_type === 'like') likes += 1;
    if (reaction_type === 'dislike') dislikes += 1;

    const { error: updCountErr } = await supabase
      .from('post_comments')
      .update({ likes_count: likes, dislikes_count: dislikes })
      .eq('id', commentId);
    if (updCountErr) return res.status(500).json({ success: false, error: updCountErr.message });

    return res.json({ success: true });
  } catch (e) {
    console.error('POST /api/posts/:id/comments/:commentId/reaction:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/posts/:id/comments/:commentId/reaction - clear reaction
app.delete('/api/posts/:id/comments/:commentId/reaction', async (req, res) => {
  try {
    const id = req.params.id;
    const commentId = req.params.commentId;
    const user_id =
      req.query && req.query.user_id != null ? String(req.query.user_id).trim() : null;
    if (!id || !commentId || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing post id, comment id or user_id' });
    }
    if (!isUuidLike(commentId)) {
      return res.status(400).json({ success: false, error: 'Invalid comment id' });
    }
    const { data: existing } = await supabase
      .from('post_comment_reactions')
      .select('reaction_type')
      .eq('comment_id', commentId)
      .eq('user_id', user_id)
      .maybeSingle();
    if (!existing) return res.json({ success: true });

    const { data: commentRow } = await supabase
      .from('post_comments')
      .select('likes_count, dislikes_count')
      .eq('id', commentId)
      .eq('ad_id', id)
      .maybeSingle();

    const { error: delErr } = await supabase
      .from('post_comment_reactions')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', user_id);
    if (delErr) return res.status(500).json({ success: false, error: delErr.message });

    if (commentRow) {
      let likes = Number(commentRow.likes_count || 0);
      let dislikes = Number(commentRow.dislikes_count || 0);
      if (existing.reaction_type === 'like') likes = Math.max(0, likes - 1);
      if (existing.reaction_type === 'dislike') dislikes = Math.max(0, dislikes - 1);
      await supabase
        .from('post_comments')
        .update({ likes_count: likes, dislikes_count: dislikes })
        .eq('id', commentId);
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/posts/:id/comments/:commentId/reaction:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});
// Media URLs reference files in storage bucket: user-photo-video
app.post('/api/listings', async (req, res) => {
  try {
    const adRecord = await buildAdRecordFromListingBody(req.body, supabase);

    const { data: ad, error: insertError } = await supabase
      .from('ads')
      .insert([adRecord])
      .select()
      .single();

    if (insertError) {
      console.error('Error creating ad:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create listing',
        details: insertError.message
      });
    }

    // Await Mux asset creation so the HLS URL is persisted before responding.
    // On serverless (Vercel) a fire-and-forget setImmediate is frozen once the
    // response is sent and never runs, which left video posts without a stream.
    if (ad.video_url && muxVideo.isVideoUrl(ad.video_url)) {
      try {
        const result = await muxVideo.startProcessing(
          supabase,
          'ad',
          ad.id,
          ad.video_url,
        );
        if (result && result.playbackId) {
          ad.mux_asset_id = result.assetId || ad.mux_asset_id;
          ad.mux_playback_id = result.playbackId;
          ad.video_hls_url = muxVideo.hlsFromPlaybackId(result.playbackId);
          ad.video_status = result.status || 'processing';
        }
      } catch (muxErr) {
        // Mux over quota or unavailable — keep the raw video_url so the client
        // can still play the MP4 directly.
        console.error('[mux] ad create processing failed:', muxErr.message);
      }
    }

    res.status(201).json({
      success: true,
      id: ad.id,
      listing: {
        ...ad,
        ...muxVideo.shapeListingVideoFields(ad),
      },
    });
  } catch (error) {
    console.error('Error in POST /api/listings:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const LISTING_AD_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// PUT /api/listings/:id — full update (same body shape as POST)
app.put('/api/listings/:id', async (req, res) => {
  try {
    const id = req.params.id != null ? String(req.params.id).trim() : '';
    if (!LISTING_AD_UUID_RE.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid listing id' });
    }
    const adRecord = await buildAdRecordFromListingBody(req.body, supabase);
    const { data: existingAd } = await supabase
      .from('ads')
      .select('video_url')
      .eq('id', id)
      .maybeSingle();
    const { data: ad, error: updateError } = await supabase
      .from('ads')
      .update(adRecord)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating ad:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to update listing',
        details: updateError.message,
      });
    }
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    if (ad.video_url && muxVideo.isVideoUrl(ad.video_url)) {
      const prev = existingAd?.video_url && String(existingAd.video_url).trim();
      const next = String(ad.video_url).trim();
      if (next !== prev) {
        try {
          const result = await muxVideo.startProcessing(
            supabase,
            'ad',
            ad.id,
            ad.video_url,
          );
          if (result && result.playbackId) {
            ad.mux_asset_id = result.assetId || ad.mux_asset_id;
            ad.mux_playback_id = result.playbackId;
            ad.video_hls_url = muxVideo.hlsFromPlaybackId(result.playbackId);
            ad.video_status = result.status || 'processing';
          }
        } catch (muxErr) {
          console.error('[mux] ad update processing failed:', muxErr.message);
        }
      }
    }

    res.status(200).json({
      success: true,
      id: ad.id,
      listing: {
        ...ad,
        ...muxVideo.shapeListingVideoFields(ad),
      },
    });
  } catch (error) {
    console.error('Error in PUT /api/listings/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PATCH /api/listings/:id - update a listing (e.g. is_frozen, exposure_level)
app.patch('/api/listings/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const { is_frozen: isFrozen, exposure_level: exposureLevel } = body;

    if (id == null || id === '') {
      return res.status(400).json({ success: false, error: 'Listing id required' });
    }

    const updates = {};
    if (['low', 'medium', 'high'].includes(String(exposureLevel || '').toLowerCase())) {
      updates.exposure_level = String(exposureLevel).toLowerCase();
    }
    if (typeof isFrozen === 'boolean') {
      updates.is_frozen = isFrozen;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { data: ad, error } = await supabase
      .from('ads')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating listing:', error);
      // PGRST204 = column not in schema cache (migration not run or Supabase cache stale)
      if (error.code === 'PGRST204' && (error.message || '').includes('is_frozen')) {
        return res.status(503).json({
          success: false,
          error: 'Database schema missing is_frozen column. Run the migration in Supabase SQL Editor (migration-ads-add-is-frozen.sql) and wait a few seconds for the schema cache to refresh.',
          code: 'SCHEMA_MIGRATION_NEEDED'
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update listing',
        details: error.message
      });
    }
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    res.json({ success: true, listing: ad });
  } catch (error) {
    console.error('Error in PATCH /api/listings/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/listings/:id — remove an ad/post owned by the current user.
// Query: user_email (required). Cleans related likes/comments/boosts then deletes the ad row.
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const id = req.params.id != null ? String(req.params.id).trim() : '';
    if (!LISTING_AD_UUID_RE.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid listing id' });
    }

    const userEmail =
      typeof req.query.user_email === 'string'
        ? req.query.user_email.trim()
        : typeof req.body?.user_email === 'string'
          ? req.body.user_email.trim()
          : '';
    const subscriptionId = await resolveSubscriptionIdByEmail(userEmail);
    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'user_email invalid or not a subscription',
      });
    }

    const { data: ad, error: fetchErr } = await supabase
      .from('ads')
      .select('id, subscription_id, owner_id')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) {
      return res.status(500).json({ success: false, error: fetchErr.message });
    }
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    const subStr = String(subscriptionId);
    const ownsAd =
      (ad.subscription_id != null && String(ad.subscription_id) === subStr) ||
      (ad.owner_id != null && String(ad.owner_id).trim() === subStr);
    if (!ownsAd) {
      return res.status(403).json({
        success: false,
        error: 'Not allowed to delete this listing',
      });
    }

    await supabase.from('listing_boosts').delete().eq('ad_id', id);
    await supabase.from('post_comment_reactions').delete().eq('ad_id', id);
    await supabase.from('post_comments').delete().eq('ad_id', id);
    await supabase.from('post_likes').delete().eq('ad_id', id);
    await supabase.from('ad_likes').delete().eq('ad_id', id);
    try {
      await supabase.from('profile_reviews').delete().eq('listing_id', id);
    } catch (_) {
      /* listing_id column may be absent */
    }

    const { error: delErr } = await supabase.from('ads').delete().eq('id', id);
    if (delErr) {
      console.error('Error deleting listing:', delErr);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete listing',
        details: delErr.message,
      });
    }

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error in DELETE /api/listings/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== USER SEARCH HISTORY ENDPOINTS ====================
// Recent user searches shown in the TikTok feed "אחרונים" list.

/** Limit for how many recent searches to return per user. */
const USER_SEARCH_RECENT_LIMIT = 25;

// GET /api/search/users/recent?user_email=...
// Returns the current user's recent searches, newest first, joined with the target's display info.
app.get('/api/search/users/recent', async (req, res) => {
  try {
    const userSubId = await resolveSubscriptionIdByEmail(req.query.user_email);
    if (!userSubId) {
      return res.status(400).json({ success: false, error: 'user_email invalid or not a subscription' });
    }
    const { data: rows, error } = await supabase
      .from('user_search_history')
      .select('id, target_subscription_id, updated_at')
      .eq('user_subscription_id', userSubId)
      .order('updated_at', { ascending: false })
      .limit(USER_SEARCH_RECENT_LIMIT);
    if (error) {
      if (error.code === '42P01' || (error.message || '').toLowerCase().includes('user_search_history')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-user-search-history.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
    const list = Array.isArray(rows) ? rows : [];
    const targetIds = [...new Set(list.map(r => r.target_subscription_id).filter(Boolean))];
    let subs = [];
    if (targetIds.length > 0) {
      const { data: subRows } = await supabase
        .from('subscriptions')
        .select(
          'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
        )
        .in('id', targetIds);
      subs = subRows || [];
    }
    const subsById = Object.fromEntries(subs.map(s => [String(s.id), s]));
    const recent = list
      .map(row => {
        const sub = subsById[String(row.target_subscription_id)];
        if (!sub) return null;
        const type = (sub.subscription_type || '').toLowerCase();
        let name = null;
        if (type === 'company') name = sub.business_name || sub.name || sub.contact_person_name || null;
        else if (type === 'broker') name = sub.broker_office_name || sub.name || sub.contact_person_name || null;
        else if (type === 'professional') name = sub.name || sub.business_name || sub.contact_person_name || null;
        else name = sub.name || sub.contact_person_name || sub.business_name || null;
        const pic = asPublicImageUrl(
          sub.profile_picture_url || (type === 'company' ? sub.company_logo_url : null) || null,
        );
        return {
          id: row.id,
          target_subscription_id: row.target_subscription_id,
          updated_at: row.updated_at,
          name: name || 'משתמש',
          email: sub.email || null,
          subscription_type: sub.subscription_type || null,
          profileImageUrl: pic || null,
        };
      })
      .filter(Boolean);
    res.json({ success: true, recent });
  } catch (err) {
    console.error('GET /api/search/users/recent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/search/users/recent - body: { user_email, target_subscription_id }
// Upserts a row so the same target bubbles to the top on re-search.
app.post('/api/search/users/recent', async (req, res) => {
  try {
    const userSubId = await resolveSubscriptionIdByEmail(req.body?.user_email);
    if (!userSubId) {
      return res.status(400).json({ success: false, error: 'user_email invalid or not a subscription' });
    }
    const targetId =
      req.body?.target_subscription_id != null
        ? String(req.body.target_subscription_id).trim()
        : '';
    if (!targetId || !CHAT_UUID_RE.test(targetId)) {
      return res.status(400).json({ success: false, error: 'target_subscription_id (UUID) required' });
    }
    if (targetId === userSubId) {
      return res.json({ success: true, skipped: true });
    }
    const now = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .from('user_search_history')
      .upsert(
        {
          user_subscription_id: userSubId,
          target_subscription_id: targetId,
          updated_at: now,
        },
        { onConflict: 'user_subscription_id,target_subscription_id' },
      );
    if (upsertErr) {
      if (upsertErr.code === '42P01' || (upsertErr.message || '').toLowerCase().includes('user_search_history')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-user-search-history.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: upsertErr.message });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/search/users/recent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/search/users/recent?user_email=...  → clears all recent searches for that user.
app.delete('/api/search/users/recent', async (req, res) => {
  try {
    const userSubId = await resolveSubscriptionIdByEmail(
      req.query.user_email || req.body?.user_email,
    );
    if (!userSubId) {
      return res.status(400).json({ success: false, error: 'user_email invalid or not a subscription' });
    }
    const { error } = await supabase
      .from('user_search_history')
      .delete()
      .eq('user_subscription_id', userSubId);
    if (error) {
      if (error.code === '42P01' || (error.message || '').toLowerCase().includes('user_search_history')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-user-search-history.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/search/users/recent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== LISTING BOOST ENDPOINTS ====================

/** Monthly boost quota per subscription. */
const BOOST_MONTHLY_QUOTA = 1;
/** Boost duration in hours. */
const BOOST_DURATION_HOURS = 24;

/** Start of the current calendar month in UTC as ISO string. */
function currentMonthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function resolveSubscriptionIdByEmail(emailRaw) {
  const email = normEmail(emailRaw);
  if (!email) return null;
  const { data } = await supabase
    .from('subscriptions')
    .select('id')
    .ilike('email', email)
    .maybeSingle();
  return data?.id || null;
}

// GET /api/listings/boost-quota?user_email=...
// Returns current month's boost usage/remaining for the caller.
app.get('/api/listings/boost-quota', async (req, res) => {
  try {
    const subscriptionId = await resolveSubscriptionIdByEmail(req.query.user_email);
    if (!subscriptionId) {
      return res.status(400).json({ success: false, error: 'user_email invalid or not a subscription' });
    }
    const monthStart = currentMonthStartIso();
    const { count, error } = await supabase
      .from('listing_boosts')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_id', subscriptionId)
      .gte('created_at', monthStart);
    if (error) {
      if (error.code === '42P01' || (error.message || '').toLowerCase().includes('listing_boosts')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-listing-boosts.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
    const used = count || 0;
    res.json({
      success: true,
      quota: BOOST_MONTHLY_QUOTA,
      used,
      remaining: Math.max(0, BOOST_MONTHLY_QUOTA - used),
      duration_hours: BOOST_DURATION_HOURS,
    });
  } catch (err) {
    console.error('GET /api/listings/boost-quota error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/listings/:id/boost - mark the listing as boosted for BOOST_DURATION_HOURS.
// Body: { user_email }. Enforces BOOST_MONTHLY_QUOTA per subscription per calendar month.
app.post('/api/listings/:id/boost', async (req, res) => {
  try {
    const adId = req.params.id;
    if (!adId) return res.status(400).json({ success: false, error: 'Listing id required' });
    const subscriptionId = await resolveSubscriptionIdByEmail(req.body?.user_email);
    if (!subscriptionId) {
      return res.status(400).json({ success: false, error: 'user_email invalid or not a subscription' });
    }

    const monthStart = currentMonthStartIso();
    const { count, error: countErr } = await supabase
      .from('listing_boosts')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_id', subscriptionId)
      .gte('created_at', monthStart);
    if (countErr) {
      if (countErr.code === '42P01' || (countErr.message || '').toLowerCase().includes('listing_boosts')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-listing-boosts.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: countErr.message });
    }
    const used = count || 0;
    if (used >= BOOST_MONTHLY_QUOTA) {
      return res.status(429).json({
        success: false,
        error: `הגעת למכסת ההקפצות החודשית (${BOOST_MONTHLY_QUOTA}).`,
        code: 'QUOTA_EXCEEDED',
        quota: BOOST_MONTHLY_QUOTA,
        used,
        remaining: 0,
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + BOOST_DURATION_HOURS * 60 * 60 * 1000);

    const { error: boostErr } = await supabase.from('listing_boosts').insert({
      subscription_id: subscriptionId,
      ad_id: adId,
      expires_at: expiresAt.toISOString(),
    });
    if (boostErr) {
      return res.status(500).json({ success: false, error: boostErr.message });
    }

    const { data: ad, error: updateErr } = await supabase
      .from('ads')
      .update({ boost_expires_at: expiresAt.toISOString() })
      .eq('id', adId)
      .select('id, boost_expires_at')
      .single();
    if (updateErr) {
      if (updateErr.code === 'PGRST204' && (updateErr.message || '').includes('boost_expires_at')) {
        return res.status(503).json({
          success: false,
          error: 'Run migration-listing-boosts.sql in Supabase SQL Editor.',
          code: 'SCHEMA_MIGRATION_NEEDED',
        });
      }
      return res.status(500).json({ success: false, error: updateErr.message });
    }

    res.json({
      success: true,
      listing: ad,
      boost_expires_at: expiresAt.toISOString(),
      quota: BOOST_MONTHLY_QUOTA,
      used: used + 1,
      remaining: Math.max(0, BOOST_MONTHLY_QUOTA - (used + 1)),
    });
  } catch (err) {
    console.error('POST /api/listings/:id/boost error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== FILE UPLOAD ENDPOINTS ====================

// Chat images / voice: bucket "chat" (public read recommended for getPublicUrl)
app.post('/api/chat/upload-media', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided. Use form field name "file".' });
    }
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      return res.status(503).json({ success: false, error: 'Server upload not configured.' });
    }
    const mime = (req.file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/') && !mime.startsWith('audio/')) {
      return res.status(400).json({ success: false, error: 'Only image or audio files are allowed.' });
    }
    const fromName = (req.file.originalname || '').match(/\.([a-zA-Z0-9]+)$/)?.[1];
    const guessExt =
      mime.includes('jpeg') || mime.includes('jpg')
        ? 'jpg'
        : mime.includes('png')
          ? 'png'
          : mime.includes('webp')
            ? 'webp'
            : mime.includes('gif')
              ? 'gif'
              : mime.includes('m4a')
                ? 'm4a'
                : mime.includes('mp3')
                  ? 'mp3'
                  : mime.includes('wav')
                    ? 'wav'
                    : mime.includes('ogg')
                      ? 'ogg'
                      : mime.includes('mpeg')
                        ? 'mp3'
                        : mime.includes('mp4') && mime.startsWith('audio/')
                          ? 'm4a'
                          : null;
    const safeExt = String(fromName || guessExt || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
    const { error } = await supabase.storage
      .from('chat')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false,
      });
    if (error) {
      console.error('Chat bucket upload error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload to storage. Create a public "chat" bucket in Supabase if missing.',
        details: error.message,
      });
    }
    const { data: urlData } = supabase.storage.from('chat').getPublicUrl(fileName);
    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    console.error('POST /api/chat/upload-media:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Group avatar image: bucket "group-pics" (expected public read)
app.post('/api/chat/upload-group-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided. Use form field name "file".' });
    }
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      return res.status(503).json({ success: false, error: 'Server upload not configured.' });
    }
    const mime = (req.file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ success: false, error: 'Only image files are allowed for group avatar.' });
    }
    const fromName = (req.file.originalname || '').match(/\.([a-zA-Z0-9]+)$/)?.[1];
    const guessExt =
      mime.includes('jpeg') || mime.includes('jpg')
        ? 'jpg'
        : mime.includes('png')
          ? 'png'
          : mime.includes('webp')
            ? 'webp'
            : mime.includes('gif')
              ? 'gif'
              : null;
    const safeExt = String(fromName || guessExt || 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
    const fileName = `group-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
    const { error } = await supabase.storage
      .from('group-pics')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'image/jpeg',
        upsert: false,
      });
    if (error) {
      console.error('Group-pics bucket upload error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload to storage. Create a public "group-pics" bucket in Supabase if missing.',
        details: error.message,
      });
    }
    const { data: urlData } = supabase.storage.from('group-pics').getPublicUrl(fileName);
    return res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    console.error('POST /api/chat/upload-group-image:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Upload profile picture to bucket profile-pics (e.g. when moving from stage 1 to stage 2)
app.post('/api/upload-profile-pic', upload.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No profile picture provided.' });
    }
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      return res.status(503).json({ success: false, error: 'Server upload not configured.' });
    }
    // Supabase storage keys must be ASCII-safe (no Hebrew/special chars)
    const ext = (req.file.originalname || '').includes('.') ? (req.file.originalname.match(/\.([a-zA-Z0-9]+)$/)?.[1] || 'jpg') : 'jpg';
    const fileName = `profile-${Date.now()}.${ext.replace(/[^a-zA-Z0-9]/g, '') || 'jpg'}`;
    const { data, error } = await supabase.storage
      .from('profile-pics')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype || 'image/jpeg', upsert: false });
    if (error) {
      console.error('Profile pic upload error:', error);
      return res.status(500).json({ success: false, error: 'Failed to upload profile picture.' });
    }
    const { data: urlData } = supabase.storage.from('profile-pics').getPublicUrl(fileName);
    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    console.error('Upload profile pic:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Signed upload URL — client PUTs the file directly to Supabase (avoids Vercel body-size limits for videos).
app.post('/api/upload/signed-url', async (req, res) => {
  try {
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      return res.status(503).json({
        success: false,
        error:
          'Server upload not configured. Set SUPABASE_SERVICE_ROLE_KEY in the backend .env.',
      });
    }

    const folder = (req.body && req.body.folder)
      ? String(req.body.folder).replace(/[^a-zA-Z0-9/_-]/g, '')
      : 'general';
    const safeName = (req.body?.fileName || 'file.mp4')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^_+|_+$/g, '') || 'file.mp4';
    const objectPath = `${folder}/${Date.now()}-${safeName}`;

    const { data, error } = await supabase.storage
      .from('user-pohto-video')
      .createSignedUploadUrl(objectPath);

    if (error) {
      console.error('Signed upload URL error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to prepare upload',
        details: error.message,
      });
    }

    const { data: urlData } = supabase.storage
      .from('user-pohto-video')
      .getPublicUrl(objectPath);

    res.json({
      success: true,
      signedUrl: data.signedUrl,
      path: data.path,
      token: data.token,
      publicUrl: urlData.publicUrl,
    });
  } catch (error) {
    console.error('Error in POST /api/upload/signed-url:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to prepare upload',
    });
  }
});

// Upload file to Supabase Storage
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided. Ensure the form field is named "file".' 
      });
    }

    // Service role key is required for storage uploads; anon key will fail with RLS
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      console.error('Upload failed: SUPABASE_SERVICE_ROLE_KEY is missing or still a placeholder.');
      return res.status(503).json({ 
        success: false, 
        error: 'Server upload not configured. Set SUPABASE_SERVICE_ROLE_KEY in the backend .env (Supabase Dashboard > Settings > API > service_role secret).' 
      });
    }

    const folder = (req.body && req.body.folder) ? String(req.body.folder).replace(/[^a-zA-Z0-9/_-]/g, '') : 'general';
    const safeName = (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${folder}/${Date.now()}-${safeName}`;

    const { data, error } = await supabase.storage
      .from('user-pohto-video')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (error) {
      console.error('Supabase storage upload error:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to upload file',
        details: error.message 
      });
    }

    const { data: urlData } = supabase.storage
      .from('user-pohto-video')
      .getPublicUrl(fileName);

    res.json({
      success: true,
      url: urlData.publicUrl,
      fileName: fileName
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Mux webhook — asset.ready / asset.errored updates HLS URLs on ads, stories, subscriptions
app.post('/api/mux/webhook', async (req, res) => {
  try {
    const signature = req.headers['mux-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    if (
      process.env.MUX_WEBHOOK_SIGNING_SECRET &&
      !muxVideo.verifyWebhookSignature(rawBody, signature)
    ) {
      return res.status(401).json({ success: false, error: 'Invalid Mux signature' });
    }

    const event = req.body || {};
    const type = event.type || '';
    const asset = event.data || event.object || null;

    if (type.startsWith('video.asset.')) {
      await muxVideo.applyWebhookAssetEvent(supabase, asset);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('POST /api/mux/webhook:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manually (re)start Mux ingest for an existing row.
 * Body: { kind: 'ad' | 'story' | 'subscription', id: '<uuid>' }
 */
app.post('/api/mux/reprocess', async (req, res) => {
  try {
    const kind = req.body?.kind != null ? String(req.body.kind).trim() : '';
    const rowId = req.body?.id != null ? String(req.body.id).trim() : '';
    const table = muxVideo.TABLE_BY_KIND[kind];
    const urlField = muxVideo.URL_FIELD_BY_KIND[kind];
    if (!table || !urlField || !rowId) {
      return res.status(400).json({
        success: false,
        error: 'kind (ad|story|subscription) and id are required',
      });
    }

    const { data: row, error } = await supabase
      .from(table)
      .select(`id, ${urlField}`)
      .eq('id', rowId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!row || !row[urlField]) {
      return res.status(404).json({ success: false, error: 'Row or source video not found' });
    }

    const result = await muxVideo.startProcessing(
      supabase,
      kind,
      rowId,
      row[urlField],
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/mux/reprocess:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = app;

// Start server (0.0.0.0 = accept connections from any network interface, so you can access from other devices)
if (require.main === module) {
  const HOST = process.env.HOST || '0.0.0.0';
  const server = app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL}`);
    if (allowSkipEmailVerificationTest()) {
      console.warn(
        '⚠️  ALLOW_SKIP_EMAIL_VERIFICATION is on — POST /api/subscription/verify-skip-test enabled (test only).',
      );
    }
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use. Stop the other process (e.g. taskkill /F /PID <pid>) or set PORT in .env.`,
      );
      process.exit(1);
    }
    throw err;
  });
}
