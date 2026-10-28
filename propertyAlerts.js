/**
 * Broker opt-in: an email when a property is published in a chosen category.
 * Columns: subscriptions.property_email_alerts, subscriptions.property_alert_categories.
 */
const CATEGORIES = [
  {id: 10, label: 'דירות'},
  {id: 1, label: 'חדש מקבלן'},
  {id: 12, label: 'יוקרה'},
  {id: 2, label: 'משרדים'},
  {id: 8, label: 'מסחר'},
  {id: 7, label: 'קרקעות'},
  {id: 5, label: 'BNB'},
  {id: 3, label: 'שותפים'},
  {id: 6, label: 'מגזר דתי'},
  {id: 4, label: 'גלובל'},
];

const ALLOWED = new Set(CATEGORIES.map(item => item.id));
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function categoryLabel(id) {
  const found = CATEGORIES.find(item => item.id === Number(id));
  return found ? found.label : '';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isMissingColumn(error) {
  const msg = String((error && error.message) || error || '');
  return /property_email_alerts|property_alert_categories|PGRST204|schema cache/i.test(msg);
}

function normalizeCategories(value) {
  const list = Array.isArray(value) ? value : [];
  const ids = [];
  list.forEach(item => {
    const id = Number(item);
    if (ALLOWED.has(id) && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return `${amount.toLocaleString('he-IL')} ₪`;
}

function purposeLabel(purpose) {
  const key = String(purpose || '').toLowerCase();
  if (key === 'sale') return 'למכירה';
  if (key === 'rent') return 'להשכרה';
  return '';
}

function isFeedPost(ad) {
  return ad?.feed_post === true || ad?.feed_post === 'true' || ad?.feed_post === 't';
}

function propertyTitle(ad) {
  const name = String(ad?.project_name || '').trim();
  const address = String(ad?.address || ad?.land_address || '').trim();
  const type = String(ad?.property_type || '').trim();
  if (name) return name;
  if (address) return address;
  if (type && type.toLowerCase() !== 'post') return type;
  return 'נכס חדש';
}

function propertyImage(ad) {
  const main = String(ad?.main_image_url || '').trim();
  if (/^https:\/\//i.test(main)) return main;
  const extra = Array.isArray(ad?.additional_image_urls) ? ad.additional_image_urls : [];
  const first = extra.map(item => String(item || '').trim()).find(item => /^https:\/\//i.test(item));
  return first || '';
}

function buildEmailHtml(ad) {
  const title = propertyTitle(ad);
  const category = categoryLabel(ad.category) || 'נדל״ן';
  const address = String(ad.address || ad.land_address || '').trim();
  const price = formatPrice(ad.price || ad.price_per_night);
  const purpose = purposeLabel(ad.purpose);
  const rooms = Number(ad.rooms);
  const area = Number(ad.area);
  const facts = [
    purpose,
    Number.isFinite(rooms) && rooms > 0 ? `${rooms} חדרים` : '',
    Number.isFinite(area) && area > 0 ? `${area} מ״ר` : '',
    price,
  ].filter(Boolean);
  const image = propertyImage(ad);
  const link = `https://pi-back.vercel.app/p/${encodeURIComponent(String(ad.id || ''))}`;
  const description = String(ad.description || '').trim();
  const blurb =
    description && description !== 'פוסט' && description.toLowerCase() !== 'post'
      ? description.slice(0, 160)
      : '';

  const factHtml = facts
    .map(
      fact =>
        `<td style="padding:0 0 8px 8px;"><span style="display:inline-block;padding:6px 12px;border-radius:999px;background:#2b2a39;color:#f7f3e6;font-size:13px;">${escapeHtml(fact)}</span></td>`,
    )
    .join('');

  return `<!doctype html>
<html lang="he" dir="rtl">
  <body style="margin:0;padding:0;background:#14131c;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#14131c;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#1e1d27;border-radius:28px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;text-align:right;">
                <div style="color:#ffc40a;font-weight:800;letter-spacing:0.08em;font-size:14px;">PI 2701</div>
                <div style="margin-top:18px;display:inline-block;padding:6px 12px;border-radius:999px;background:#ffc40a;color:#1e1d27;font-size:13px;font-weight:700;">${escapeHtml(category)}</div>
                <h1 style="margin:14px 0 0;color:#ffffff;font-size:28px;line-height:1.25;font-weight:700;">נכס חדש עלה</h1>
                <p style="margin:8px 0 0;color:#c8c2dc;font-size:16px;line-height:1.5;">${escapeHtml(title)}</p>
              </td>
            </tr>
            ${
              image
                ? `<tr><td style="padding:18px 28px 0;"><img src="${escapeHtml(image)}" alt="" width="504" style="display:block;width:100%;max-width:504px;height:240px;object-fit:cover;border-radius:18px;background:#2b2a39;" /></td></tr>`
                : ''
            }
            <tr>
              <td style="padding:18px 28px 0;font-family:Arial,Helvetica,sans-serif;text-align:right;">
                ${address ? `<p style="margin:0 0 12px;color:#f7f3e6;font-size:16px;">${escapeHtml(address)}</p>` : ''}
                ${blurb ? `<p style="margin:0 0 14px;color:#c8c2dc;font-size:14px;line-height:1.5;">${escapeHtml(blurb)}</p>` : ''}
                <table role="presentation" cellspacing="0" cellpadding="0"><tr>${factHtml}</tr></table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px;font-family:Arial,Helvetica,sans-serif;text-align:right;">
                <a href="${escapeHtml(link)}" style="display:inline-block;margin-top:8px;padding:14px 22px;border-radius:999px;background:#ffc40a;color:#1e1d27;font-size:16px;font-weight:700;text-decoration:none;">צפו בנכס</a>
                <p style="margin:18px 0 0;color:#8c85b3;font-size:12px;line-height:1.5;">המייל נשלח כי בחרתם לקבל עדכון על נכסים חדשים בקטגוריית ${escapeHtml(category)}. אפשר לכבות את זה בתפריט, בעדכון נכסים חדשים שעולים.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function loadSubscribers(supabase) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const {data, error} = await supabase
      .from('subscriptions')
      .select('id, email, property_alert_categories')
      .eq('property_email_alerts', true)
      .eq('subscription_type', 'broker')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function mapPool(items, limit, fn) {
  const queue = items.slice();
  const size = Math.min(limit, queue.length);
  await Promise.all(
    Array.from({length: size}, async () => {
      while (queue.length) {
        const item = queue.shift();
        await fn(item);
      }
    }),
  );
}

async function sendPropertyAlertSample(resend, to, ad) {
  const label = categoryLabel(ad && ad.category) || 'נדל״ן';
  const subject = `דוגמה · נכס חדש ב${label} · Pi 2701`;
  const html = buildEmailHtml(
    ad || {
      id: 'sample',
      category: 10,
      project_name: 'דירת דוגמה',
      address: 'תל אביב',
      price: 2500000,
      purpose: 'sale',
      rooms: 4,
      area: 110,
      description: 'זוהי דוגמה למייל עדכון על נכס חדש.',
    },
  );
  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  if (!resend) {
    const error = new Error('RESEND_API_KEY חסר בשרת');
    error.status = 503;
    throw error;
  }
  const result = await resend.emails.send({from, to, subject, html});
  if (result && result.error) {
    const error = new Error(result.error.message || 'שליחת המייל נכשלה');
    error.status = 502;
    throw error;
  }
  return {id: (result && (result.id || (result.data && result.data.id))) || null};
}

async function notifyNewPropertyEmail(supabase, resend, ad) {
  if (!ad || !ad.id || isFeedPost(ad) || ad.status !== 'published' || ad.is_frozen === true) return;
  const categoryId = Number(ad.category);
  if (!ALLOWED.has(categoryId)) return;

  let subscribers;
  try {
    subscribers = await loadSubscribers(supabase);
  } catch (error) {
    if (isMissingColumn(error)) {
      console.error('[property-alerts] columns missing; run migration-property-email-alerts.sql');
      return;
    }
    throw error;
  }

  const creator = String(ad.creator_email || '').trim().toLowerCase();
  const seen = new Set();
  const targets = subscribers.filter(row => {
    const email = String(row.email || '').trim().toLowerCase();
    if (!email || email === creator || seen.has(email)) return false;
    const chosen = normalizeCategories(row.property_alert_categories);
    if (!chosen.includes(categoryId)) return false;
    seen.add(email);
    return true;
  });
  if (targets.length === 0) return;

  const subject = `נכס חדש ב${categoryLabel(categoryId)} · Pi 2701`;
  const html = buildEmailHtml(ad);
  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  await mapPool(targets, 6, async row => {
    const to = String(row.email).trim();
    if (!resend) {
      console.log(`[property-alerts] would email ${to}: ${subject}`);
      return;
    }
    try {
      await resend.emails.send({from, to, subject, html});
    } catch (error) {
      console.error('[property-alerts] send failed', to, error.message || error);
    }
  });
}

function registerPropertyAlertRoutes(app, supabase) {
  app.get('/api/property-alerts', async (req, res) => {
    const subscriptionId = String(req.query.subscriptionId || '').trim();
    if (!UUID_RE.test(subscriptionId)) {
      return res.status(400).json({success: false, error: 'מזהה משתמש לא תקין'});
    }
    const {data, error} = await supabase
      .from('subscriptions')
      .select('id, subscription_type, email, property_email_alerts, property_alert_categories')
      .eq('id', subscriptionId)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) {
        return res.json({
          success: true,
          enabled: false,
          categories: [],
          options: CATEGORIES,
          schemaReady: false,
        });
      }
      return res.status(500).json({success: false, error: error.message});
    }
    if (!data || data.subscription_type !== 'broker') {
      return res.status(404).json({success: false, error: 'ההתראות זמינות למתווכים'});
    }
    res.json({
      success: true,
      enabled: data.property_email_alerts === true,
      categories: normalizeCategories(data.property_alert_categories),
      email: data.email || '',
      options: CATEGORIES,
      schemaReady: true,
    });
  });

  app.put('/api/property-alerts', async (req, res) => {
    const subscriptionId = String((req.body && req.body.subscriptionId) || '').trim();
    if (!UUID_RE.test(subscriptionId)) {
      return res.status(400).json({success: false, error: 'מזהה משתמש לא תקין'});
    }
    const enabled = req.body && req.body.enabled === true;
    const categories = normalizeCategories(req.body && req.body.categories);
    const {data: existing, error: readError} = await supabase
      .from('subscriptions')
      .select('id, subscription_type')
      .eq('id', subscriptionId)
      .maybeSingle();
    if (readError) return res.status(500).json({success: false, error: readError.message});
    if (!existing || existing.subscription_type !== 'broker') {
      return res.status(404).json({success: false, error: 'ההתראות זמינות למתווכים'});
    }
    const {error} = await supabase
      .from('subscriptions')
      .update({
        property_email_alerts: enabled,
        property_alert_categories: categories,
      })
      .eq('id', subscriptionId);
    if (error) {
      if (isMissingColumn(error)) {
        return res.status(503).json({
          success: false,
          error: 'השרת עדיין בלי עמודות ההתראות. צריך להריץ את המיגרציה בסופאבייס.',
        });
      }
      return res.status(500).json({success: false, error: error.message});
    }
    res.json({success: true, enabled, categories});
  });
}

module.exports = {
  CATEGORIES,
  registerPropertyAlertRoutes,
  notifyNewPropertyEmail,
  sendPropertyAlertSample,
};
