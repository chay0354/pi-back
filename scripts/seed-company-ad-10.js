/**
 * Create a second verified company user + 1 published ad in category 10 (דירות).
 * Distinct profile, logo, and project details from seed-company-ads-1-6.js.
 *
 * Usage: node scripts/seed-company-ad-10.js [email] [password]
 */
require('dotenv').config();
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in pi-back/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const stamp = Date.now();
const ownerEmail = (process.argv[2] || `ofek.company.${stamp}@test.com`)
  .trim()
  .toLowerCase();
const password = process.argv[3] || 'PiCompany2026!';

const COMPANY = {
  business_name: 'אופק התיישבות — יזמות ודיור',
  contact_person_name: 'מיכל רוזנברג',
  name: 'מיכל רוזנברג',
  phone: '052-4411223',
  office_phone: '04-8112233',
  mobile_phone: '052-4411223',
  company_id: '515992441',
  dealer_number: '992441002',
  company_website: 'https://www.ofek-hityashvut.co.il',
  business_address: 'שדרות הנשיא 45, חיפה',
  description:
    'יזמות נדל״ן בצפון הארץ — פרויקטים למגורים בלעדיים, תכנון עירוני מוקפד וליווי אישי לכל רוכש.',
  company_logo_url:
    'https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=400&q=80',
  profile_picture_url:
    'https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=400&q=80',
};

const IMG = {
  main: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=80',
  alt1: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1200&q=80',
  alt2: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=1200&q=80',
};

function contact(phone, address) {
  return {
    full_name: COMPANY.business_name,
    email: ownerEmail,
    phone,
    address,
    description:
      'נשמח לפגישת ייעוץ וסיור במשרד המכירות — זמינים גם בערב לפי תיאום.',
  };
}

function amenities(parking = 1, extra = {}) {
  return {
    'כמות חניות': parking,
    parking,
    elevator: true,
    mamad: true,
    ...extra,
  };
}

const AD = {
  category: 10,
  property_type: 'apartment',
  project_name: 'מגדלי הכרמל — חיפה',
  address: 'רחוב מוריה 22, חיפה',
  purpose: 'sale',
  price: 2280000,
  area: 96,
  rooms: 4,
  floor: 7,
  condition: 'new',
  construction_status: 'beginning_of_construction',
  sale_at_presale: true,
  display_option: 'slideshow',
  feed_display_priority: 'mainImage',
  main_image_url: IMG.main,
  additional_image_urls: [IMG.alt1, IMG.alt2],
  description:
    'פרויקט בלעדי למגורים בלב הכרמל — דירות 3–5 חדרים עם נוף לים. מפרט פרימיום, חדרי ממ"ד, מרפסות שמש, חניה ומחסן. מסירה משוערת 2028. הזדמנות לרכישה בשלב תחילת הבנייה.',
  general_details: {
    sqm_area: 8200,
    building_count: 3,
    floor_count: 18,
    apartment_count: 156,
    delivery_date: '2028-06',
    developer: 'אופק התיישבות',
    sea_view: true,
  },
  project_offers: {
    rooms_3_area: 72,
    rooms_3_price: 1780000,
    rooms_3_balcony_area: 9,
    rooms_4_area: 96,
    rooms_4_price: 2280000,
    rooms_4_balcony_area: 12,
    rooms_5_area: 118,
    rooms_5_price: 2790000,
    rooms_5_balcony_area: 16,
    penthouse_area: 195,
    penthouse_price: 6200000,
    garden_area: 128,
    garden_price: 3850000,
  },
  amenities: amenities(1, {
    storage: true,
    sea_view: true,
    smart_home: true,
    gym: true,
  }),
};

async function ensureCompanyUser() {
  const {data: existing, error: findErr} = await supabase
    .from('subscriptions')
    .select('*')
    .ilike('email', ownerEmail)
    .maybeSingle();

  if (findErr) throw new Error(findErr.message);

  const row = {
    subscription_type: 'company',
    email: ownerEmail,
    password_hash: hashPassword(password),
    status: 'verified',
    verified_at: new Date().toISOString(),
    max_published_listings: 65,
    agreed_to_terms: true,
    ...COMPANY,
  };

  if (existing?.id) {
    const {data, error} = await supabase
      .from('subscriptions')
      .update(row)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return {sub: data, created: false};
  }

  const {data, error} = await supabase.from('subscriptions').insert(row).select('*').single();
  if (error) throw new Error(error.message);
  return {sub: data, created: true};
}

async function upsertCompanyAd(sub) {
  const payload = {
    ...AD,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: COMPANY.business_name,
    creator_email: sub.email || ownerEmail,
    subscription_type: 'company',
    profile_image_url: sub.company_logo_url || sub.profile_picture_url || null,
    status: 'published',
    feed_post: false,
    phone: COMPANY.phone,
    contact_details: contact(COMPANY.phone, AD.address),
    exposure_level: 'high',
    overlay_x: 72,
    overlay_y: 84,
    updated_at: new Date().toISOString(),
  };

  const {data: existing} = await supabase
    .from('ads')
    .select('id')
    .eq('subscription_id', sub.id)
    .eq('category', AD.category)
    .eq('status', 'published')
    .order('created_at', {ascending: false})
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    const {data, error} = await supabase
      .from('ads')
      .update(payload)
      .eq('id', existing.id)
      .select(
        'id, category, project_name, address, price, general_details, project_offers, profile_image_url',
      )
      .single();
    if (error) throw new Error(error.message);
    return {...data, action: 'updated'};
  }

  const {data, error} = await supabase
    .from('ads')
    .insert(payload)
    .select(
      'id, category, project_name, address, price, general_details, project_offers, profile_image_url',
    )
    .single();
  if (error) throw new Error(error.message);
  return {...data, action: 'created'};
}

async function main() {
  const {sub, created} = await ensureCompanyUser();
  const saved = await upsertCompanyAd(sub);
  const gd = saved.general_details || {};

  console.log(created ? 'Created company user:' : 'Updated company user:');
  console.log('  email:', sub.email);
  console.log('  password:', password);
  console.log('  company:', COMPANY.business_name);
  console.log('  logo:', sub.company_logo_url);
  console.log('  id:', sub.id);
  console.log('');
  console.log(`  [דירות] ${saved.project_name} (${saved.action})`);
  console.log(`    ${saved.address} — ₪${Number(saved.price).toLocaleString('he-IL')}`);
  console.log(
    `    בניינים: ${gd.building_count ?? 0} | קומות: ${gd.floor_count ?? 0} | דירות: ${gd.apartment_count ?? 0}`,
  );
  console.log(`    ad id: ${saved.id}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
