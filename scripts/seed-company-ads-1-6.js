/**
 * Create a verified company user + 2 published ads:
 *   category 1 — חדש מקבלן
 *   category 6 — מגזר דתי
 *
 * Usage: node scripts/seed-company-ads-1-6.js [email] [password]
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
const ownerEmail = (process.argv[2] || `nadlan.company.${stamp}@test.com`)
  .trim()
  .toLowerCase();
const password = process.argv[3] || 'PiCompany2026!';

const COMPANY = {
  business_name: 'נבוני נדל״ן — בנייה ופיתוח',
  contact_person_name: 'אוריאל שפירא',
  name: 'אוריאל שפירא',
  phone: '050-7788990',
  office_phone: '03-5557788',
  mobile_phone: '050-7788990',
  company_id: '514778899',
  dealer_number: '778899001',
  company_website: 'https://www.nevoni-nadlan.co.il',
  business_address: 'רחוב המלאכה 12, בני ברק',
  description:
    'חברת בנייה ויזמות נדל״ן המתמחה בפרויקטים למגורים, מגזר דתי וחדש מקבלן — ליווי מקצועי מהתכנון ועד המסירה.',
  company_logo_url:
    'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=400&q=80',
  profile_picture_url:
    'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=400&q=80',
};

const IMG = {
  newProj:
    'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1200&q=80',
  newProj2:
    'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1200&q=80',
  newProj3:
    'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&q=80',
  religious:
    'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1200&q=80',
  religious2:
    'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1200&q=80',
  religious3:
    'https://images.unsplash.com/photo-1600607687644-c7171b42498f?w=1200&q=80',
};

function contact(phone, address) {
  return {
    full_name: COMPANY.business_name,
    email: ownerEmail,
    phone,
    address,
    description: 'נשמח לתאם סיור בשטח ולהציג את הפרויקט — צוות מקצועי וזמין.',
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

const ADS = [
  {
    category: 1,
    property_type: 'apartment',
    project_name: 'מגדלי נווה שמחה — פתח תקווה',
    address: 'רחוב האורנים 8, פתח תקווה',
    purpose: 'sale',
    price: 2650000,
    area: 112,
    rooms: 4,
    floor: 9,
    condition: 'new',
    construction_status: 'on_paper',
    sale_at_presale: true,
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.newProj,
    additional_image_urls: [IMG.newProj2, IMG.newProj3],
    description:
      'דירות 4 חדרים בפרויקט יוקרתי חדש בלב פתח תקווה. מפרט גבוה, חדר ממ"ד, מרפסת שמש 12 מ"ר, חניה ומחסן. מסירה משוערת רבעון 3 2027. אפשרות לרכישה בפריסייל — מחירי הזדמנות לרוכשים ראשונים.',
    general_details: {
      building_count: 2,
      floor_count: 14,
      apartment_count: 84,
      delivery_date: '2027-09',
      developer: 'נבוני נדל״ן',
    },
    project_offers: {
      rooms_3_area: 88,
      rooms_3_price: 2150000,
      rooms_4_area: 112,
      rooms_4_price: 2650000,
      rooms_5_area: 132,
      rooms_5_price: 3100000,
      penthouse_area: 220,
      penthouse_price: 5800000,
      garden_area: 145,
      garden_price: 3400000,
    },
    amenities: amenities(1, {storage: true, smart_home: true, sukkah_balcony: true}),
  },
  {
    category: 6,
    property_type: 'apartment',
    project_name: 'שכונת היובל — בית שמש',
    address: 'רחוב היובל 24, בית שמש',
    purpose: 'sale',
    price: 1780000,
    area: 102,
    rooms: 4,
    floor: 4,
    condition: 'new',
    construction_status: 'on_paper',
    sale_at_presale: false,
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.religious,
    additional_image_urls: [IMG.religious2, IMG.religious3],
    description:
      'דירות 4 חדרים חדשות בשכונה שקטה ומבוקשת. מרפסת סוכה, חדר ממ"ד, שני חדרי רחצה, חניה ומחסן. קרוב לבתי כנסת, גנים ותחבורה ציבורית. מתאים למשפחות — מוכן לכניסה מיידית.',
    general_details: {
      building_count: 1,
      floor_count: 6,
      apartment_count: 24,
      delivery_date: '2026-03',
      developer: 'נבוני נדל״ן',
      near_synagogue: true,
    },
    project_offers: {
      rooms_3_area: 78,
      rooms_3_price: 1420000,
      rooms_3_balcony_area: 10,
      rooms_4_area: 102,
      rooms_4_price: 1780000,
      rooms_4_balcony_area: 14,
      rooms_5_area: 118,
      rooms_5_price: 2050000,
      rooms_5_balcony_area: 16,
    },
    amenities: amenities(1, {
      sukkah_balcony: true,
      near_synagogue: true,
      storage: true,
      separate_kitchen: true,
    }),
  },
];

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

async function upsertCompanyAds(sub) {
  const creatorName = COMPANY.business_name;
  const phoneFmt = COMPANY.phone;
  const saved = [];

  for (const ad of ADS) {
    const payload = {
      ...ad,
      subscription_id: sub.id,
      owner_id: String(sub.id),
      creator_name: creatorName,
      creator_email: sub.email || ownerEmail,
      subscription_type: 'company',
      profile_image_url: sub.company_logo_url || sub.profile_picture_url || null,
      status: 'published',
      feed_post: false,
      phone: phoneFmt,
      contact_details: contact(phoneFmt, ad.address),
      exposure_level: 'high',
      overlay_x: 80,
      overlay_y: 80,
      updated_at: new Date().toISOString(),
    };

    const {data: existing} = await supabase
      .from('ads')
      .select('id')
      .eq('subscription_id', sub.id)
      .eq('category', ad.category)
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
          'id, category, project_name, address, price, general_details, project_offers',
        )
        .single();
      if (error) throw new Error(error.message);
      saved.push({...data, action: 'updated'});
    } else {
      const {data, error} = await supabase
        .from('ads')
        .insert(payload)
        .select(
          'id, category, project_name, address, price, general_details, project_offers',
        )
        .single();
      if (error) throw new Error(error.message);
      saved.push({...data, action: 'created'});
    }
  }

  return saved;
}

async function main() {
  const {sub, created} = await ensureCompanyUser();
  const saved = await upsertCompanyAds(sub);

  console.log(created ? 'Created company user:' : 'Updated company user:');
  console.log('  email:', sub.email);
  console.log('  password:', password);
  console.log('  company:', COMPANY.business_name);
  console.log('  id:', sub.id);
  console.log('');
  saved.forEach(r => {
    const catLabel = r.category === 1 ? 'חדש מקבלן' : 'מגזר דתי';
    const gd = r.general_details || {};
    console.log(`  [${catLabel}] ${r.project_name} (${r.action})`);
    console.log(`    ${r.address} — ₪${Number(r.price).toLocaleString('he-IL')}`);
    console.log(
      `    בניינים: ${gd.building_count ?? 0} | קומות: ${gd.floor_count ?? 0} | דירות: ${gd.apartment_count ?? 0}`,
    );
    console.log(`    id: ${r.id}`);
  });
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
