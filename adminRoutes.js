/**
 * Password-gated stats for the site and the app. They share one database.
 * ADMIN_PASSWORD in the server environment overrides the built-in password.
 */
const crypto = require('crypto');
const {Resend} = require('resend');
const {sendPropertyAlertSample} = require('./propertyAlerts');

const B2B = new Set(['broker', 'company', 'professional', 'project_marketer']);

const TYPE_LABELS = {
  user: 'משתמש',
  broker: 'תיווך',
  company: 'חברה',
  professional: 'בעל מקצוע',
  project_marketer: 'משווק פרויקטים',
};

const CATEGORY_LABELS = {
  1: 'חדש מקבלן',
  2: 'משרדים',
  3: 'שותפים',
  4: 'גלובל',
  5: 'BNB',
  6: 'מגזר דתי',
  7: 'קרקעות',
  8: 'מסחר',
  10: 'דירות',
  12: 'יוקרה',
};

/** Furthest point a person reached. Order matters. */
const STAGES = [
  {id: 'started', label: 'התחיל הרשמה'},
  {id: 'verified', label: 'אימת מייל'},
  {id: 'registered', label: 'סיים הרשמה'},
  {id: 'subscribed', label: 'פתח מנוי'},
  {id: 'drafted', label: 'שמר טיוטה'},
  {id: 'published', label: 'פרסם מודעה'},
  {id: 'posted', label: 'פרסם פוסט'},
];

function adminPassword() {
  return String(process.env.ADMIN_PASSWORD || 'PIADMIN0386').trim();
}

function adminToken(password) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_URL || 'pi-admin';
  return crypto.createHmac('sha256', secret).update(String(password)).digest('hex');
}

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const password = adminPassword();
  if (!password) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_PASSWORD לא הוגדר בשרת',
    });
  }
  if (!tokensMatch(req.get('x-admin-token'), adminToken(password))) {
    return res.status(401).json({success: false, error: 'unauthorized'});
  }
  return next();
}

async function fetchAll(supabase, table, columns) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const {data, error} = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    if (from > 20000) break;
  }
  return rows;
}

async function fetchAds(supabase) {
  const attempts = [
    'id, subscription_id, status, feed_post, category, created_at, view_count, like_count, is_frozen, project_name, address, property_type',
    'id, subscription_id, status, feed_post, category, created_at, view_count, like_count, is_frozen',
    'id, subscription_id, status, category, created_at',
  ];
  let lastError = null;
  for (const columns of attempts) {
    try {
      return await fetchAll(supabase, 'ads', columns);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function countRows(supabase, table) {
  const {count, error} = await supabase.from(table).select('*', {count: 'exact', head: true});
  if (error) return null;
  return count || 0;
}

function stageOf(user, stats) {
  const verified = user.status === 'verified' || user.status === 'active';
  if (stats.posts > 0) return 'posted';
  if (stats.published > 0) return 'published';
  if (stats.drafts > 0) return 'drafted';
  if (B2B.has(user.subscription_type) && verified) return 'subscribed';
  if (user.hasPassword) return 'registered';
  if (verified) return 'verified';
  return 'started';
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function lastDays(n) {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = new Date(start);
    date.setDate(start.getDate() - i);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

module.exports = function registerAdminRoutes(app, supabase) {
  app.post('/api/admin/login', (req, res) => {
    const password = adminPassword();
    if (!password) {
      return res.status(503).json({success: false, error: 'ADMIN_PASSWORD לא הוגדר בשרת'});
    }
    const given = req.body && req.body.password != null ? String(req.body.password) : '';
    if (!tokensMatch(given, password)) {
      return res.status(401).json({success: false, error: 'סיסמה שגויה'});
    }
    return res.json({success: true, token: adminToken(password)});
  });

  app.post('/api/admin/property-alert-sample', requireAdmin, async (req, res) => {
    try {
      const to = String((req.body && req.body.to) || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({success: false, error: 'מייל לא תקין'});
      }
      const {data, error} = await supabase
        .from('ads')
        .select(
          'id, project_name, address, land_address, category, price, price_per_night, purpose, rooms, area, description, main_image_url, additional_image_urls, property_type, status, feed_post, is_frozen, created_at',
        )
        .eq('status', 'published')
        .order('created_at', {ascending: false})
        .limit(12);
      if (error) return res.status(500).json({success: false, error: error.message});
      const ad = (data || []).find(row => row.feed_post !== true && row.is_frozen !== true);
      if (!ad) return res.status(404).json({success: false, error: 'אין נכס לדוגמה'});
      const key = process.env.RESEND_API_KEY;
      const resend = key ? new Resend(key) : null;
      const sent = await sendPropertyAlertSample(resend, to, ad);
      return res.json({success: true, to, adId: ad.id, messageId: sent.id});
    } catch (err) {
      return res.status(err.status || 500).json({success: false, error: err.message || 'שליחה נכשלה'});
    }
  });

  app.get('/api/admin/overview', requireAdmin, async (req, res) => {
    try {
      let users;
      try {
        users = await fetchAll(
          supabase,
          'subscriptions',
          'id, email, name, phone, subscription_type, status, created_at, verified_at, business_name, company_plan, password_hash, access_expires_at',
        );
      } catch {
        users = await fetchAll(
          supabase,
          'subscriptions',
          'id, email, name, phone, subscription_type, status, created_at, verified_at, business_name, password_hash',
        );
      }

      const ads = await fetchAds(supabase);

      const [conversations, messages, reviews, follows, stories, comments, feedback, reports] = await Promise.all([
        countRows(supabase, 'chat_conversations'),
        countRows(supabase, 'chat_messages'),
        countRows(supabase, 'profile_reviews'),
        countRows(supabase, 'user_follows'),
        countRows(supabase, 'stories'),
        countRows(supabase, 'post_comments'),
        countRows(supabase, 'improvements_feedback'),
        countRows(supabase, 'company_reports'),
      ]);

      const adStats = new Map();
      const bump = (id, key) => {
        if (!id) return;
        const row = adStats.get(String(id)) || {drafts: 0, published: 0, posts: 0, views: 0};
        row[key] += 1;
        adStats.set(String(id), row);
      };

      let publishedAds = 0;
      let draftAds = 0;
      let posts = 0;
      let frozen = 0;
      let views = 0;
      let likes = 0;
      const byCategory = {};
      for (const ad of ads) {
        const isPost = ad.feed_post === true;
        const published = ad.status === 'published';
        views += Number(ad.view_count) || 0;
        likes += Number(ad.like_count) || 0;
        if (ad.is_frozen) frozen += 1;
        if (isPost && published) {
          posts += 1;
          bump(ad.subscription_id, 'posts');
        } else if (published) {
          publishedAds += 1;
          bump(ad.subscription_id, 'published');
          const cat = Number(ad.category) || 0;
          byCategory[cat] = (byCategory[cat] || 0) + 1;
        } else {
          draftAds += 1;
          bump(ad.subscription_id, 'drafts');
        }
        const stats = ad.subscription_id ? adStats.get(String(ad.subscription_id)) : null;
        if (stats && published) stats.views += Number(ad.view_count) || 0;
      }

      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const byType = {};
      const byStatus = {};
      const stageCounts = Object.fromEntries(STAGES.map(stage => [stage.id, 0]));
      let new7 = 0;
      let new30 = 0;
      let withPassword = 0;
      let verified = 0;
      let subscribed = 0;
      let expired = 0;
      const signups = Object.fromEntries(lastDays(14).map(key => [key, 0]));

      const people = users.map(user => {
        const type = String(user.subscription_type || 'user');
        const status = String(user.status || '');
        byType[type] = (byType[type] || 0) + 1;
        byStatus[status] = (byStatus[status] || 0) + 1;
        const created = new Date(user.created_at).getTime();
        if (Number.isFinite(created)) {
          if (now - created <= 7 * day) new7 += 1;
          if (now - created <= 30 * day) new30 += 1;
          const key = dayKey(user.created_at);
          if (key in signups) signups[key] += 1;
        }
        const hasPassword = Boolean(user.password_hash);
        if (hasPassword) withPassword += 1;
        if (status === 'verified' || status === 'active') verified += 1;
        if (B2B.has(type) && (status === 'verified' || status === 'active')) subscribed += 1;
        const expires = user.access_expires_at ? new Date(user.access_expires_at).getTime() : null;
        if (expires && expires < now) expired += 1;
        const stats = adStats.get(String(user.id)) || {drafts: 0, published: 0, posts: 0, views: 0};
        const stage = stageOf({...user, hasPassword}, stats);
        stageCounts[stage] += 1;
        return {
          id: user.id,
          name: user.name || user.business_name || '',
          email: user.email || '',
          phone: user.phone || '',
          type,
          typeLabel: TYPE_LABELS[type] || type,
          status,
          plan: user.company_plan || '',
          stage,
          hasPassword,
          createdAt: user.created_at || null,
          drafts: stats.drafts,
          ads: stats.published,
          posts: stats.posts,
          views: stats.views,
        };
      });

      people.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      const recentAds = [...ads]
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 12)
        .map(ad => ({
          id: ad.id,
          title: ad.project_name || ad.address || ad.property_type || (ad.feed_post ? 'פוסט' : 'מודעה'),
          kind: ad.feed_post ? 'פוסט' : 'מודעה',
          status: ad.status === 'published' ? 'פורסם' : 'טיוטה',
          category: CATEGORY_LABELS[Number(ad.category)] || '',
          createdAt: ad.created_at || null,
          views: Number(ad.view_count) || 0,
        }));

      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        stages: STAGES,
        totals: {
          users: users.length,
          new7,
          new30,
          withPassword,
          verified,
          subscribed,
          expired,
          publishedAds,
          draftAds,
          posts,
          frozen,
          views,
          likes,
          conversations,
          messages,
          reviews,
          follows,
          stories,
          comments,
          feedback,
          reports,
        },
        byType: Object.entries(byType).map(([id, count]) => ({
          id,
          label: TYPE_LABELS[id] || id,
          count,
        })),
        byStatus,
        byCategory: Object.entries(byCategory)
          .map(([id, count]) => ({id: Number(id), label: CATEGORY_LABELS[id] || id, count}))
          .sort((a, b) => b.count - a.count),
        stageCounts,
        signups: Object.entries(signups).map(([day, count]) => ({day, count})),
        users: people,
        recentAds,
      });
    } catch (error) {
      console.error('GET /api/admin/overview', error);
      res.status(500).json({success: false, error: error.message || 'טעינה נכשלה'});
    }
  });
};
