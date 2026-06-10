/**
 * Seed 2 BnB (category 5) + 2 Partners (category 3) ads for a regular user.
 * Run: node scripts/seed-regular-user-bnb-partners.js [email]
 */
require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const ownerEmail = (process.argv[2] || 'regular.test.user@example.com').trim().toLowerCase();

const IMG = {
  apt: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=80',
  apt2: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1200&q=80',
  bnb: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80',
  bnb2: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=1200&q=80',
  room: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1200&q=80',
};

function contact(fullName, email, phone, address) {
  return {
    full_name: fullName,
    email,
    phone,
    address,
    description: 'זמין/ה לשיחה בשעות הערב',
  };
}

function amenities(parking = 0, extra = {}) {
  return {
    'כמות חניות': parking,
    parking,
    elevator: false,
    mamad: false,
    ...extra,
  };
}

const ADS = [
  // שותפים — מחפש שותף
  {
    category: 3,
    property_type: 'apartment',
    project_name: 'מחפש שותף לדירה — תל אביב',
    address: 'דיזנגוף 120, תל אביב',
    purpose: 'rent',
    budget: 4200,
    area: 90,
    rooms: 3,
    floor: 4,
    search_purpose: 'partner',
    preferred_apartment_type: 'shared_apt',
    preferred_gender: 'male',
    preferred_age_min: 25,
    preferred_age_max: 34,
    preferences: {
      non_smoker: true,
      students: false,
      stable_job: true,
      immediate_entry: true,
    },
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.apt,
    additional_image_urls: [IMG.apt2],
    description:
      'שלום, אני יוסי — עובד בהייטק, מחפש שותף נקי ושקט לדירת 3 חדרים בדיזנגוף. חדר פרטי 13 מ"ר, סלון ומטבח משותפים, מיזוג בכל הבית. כניסה מיידית.',
  },
  // שותפים — מחפש להיכנס
  {
    category: 3,
    property_type: 'apartment',
    project_name: 'מחפש להיכנס — רמת גן',
    address: 'ביאליק 18, רמת גן',
    purpose: 'rent',
    budget: 3600,
    area: 85,
    rooms: 4,
    floor: 2,
    search_purpose: 'enter',
    preferred_apartment_type: 'shared_apt',
    preferred_gender: 'male',
    preferred_age_min: 23,
    preferred_age_max: 32,
    preferences: {
      non_smoker: true,
      students: false,
      stable_job: true,
      occasional_job: false,
    },
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.apt2,
    additional_image_urls: [IMG.apt],
    description:
      'מחפש להיכנס לדירת שותפים ברמת גן, קרוב לתחנה ולקניון. עובד מסודר, לא מעשן, אוהב סביבה שקטה. תקציב עד 3,600 ₪ כולל ועד.',
  },

  // BnB — חדר פרטי
  {
    category: 5,
    property_type: 'room',
    project_name: 'חדר אירוח — פלורנטין, תל אביב',
    address: 'רחוב יהודה הלוי 45, תל אביב',
    purpose: 'rent',
    price_per_night: 380,
    price: 380,
    area: 18,
    rooms: 1,
    floor: 3,
    condition: 'renovated',
    hospitality_nature: 'special',
    cancellation_policy: 'without_penalty',
    hot_deal: false,
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.room,
    additional_image_urls: [IMG.bnb2, IMG.apt],
    description:
      'חדר פרטי ונעים בלב פלורנטין — מיטה זוגית, ארון, שולחן עבודה. שירותים ומקלחת משותפים, WiFi מהיר. מתאים לזוג או לנוסעי עסקים.',
    service_facility: {
      selected: 'wifi_internet',
      wifi_internet: true,
      tv: true,
      private_shower: false,
      shared_shower: true,
      kitchen: true,
      suitable_for_smokers: false,
    },
    accommodation_offers: {
      check_in_date: '2026-06-01',
      check_out_date: '2026-12-31',
      guest_count: 2,
    },
    general_details: {
      bnb_host_type: 'private',
      hospitality_natures: {special: true, landscapes: true},
    },
    amenities: amenities(0),
  },
  // BnB — דירה קטנה
  {
    category: 5,
    property_type: 'apartment',
    project_name: 'דירת סטודיו — הרצליה',
    address: 'רחוב סוקולוב 22, הרצליה',
    purpose: 'rent',
    price_per_night: 520,
    price: 520,
    area: 42,
    rooms: 1,
    floor: 6,
    condition: 'renovated',
    hospitality_nature: 'on_the_beach',
    cancellation_policy: 'partial_refund',
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.bnb,
    additional_image_urls: [IMG.bnb2],
    description:
      'סטודיו מואר עם מרפסת קטנה, 5 דקות מהים. מטבחון מלא, מיזוג, מכונת כביסה. חניה בשכונה. ideal לסוף שבוע או שהייה קצרה ליד הים.',
    service_facility: {
      selected: 'wifi_internet',
      wifi_internet: true,
      tv: true,
      kitchen: true,
      private_shower: true,
      suitable_for_animals: false,
    },
    accommodation_offers: {
      check_in_date: '2026-05-01',
      check_out_date: '2026-10-31',
      guest_count: 3,
    },
    general_details: {
      bnb_host_type: 'private',
      hospitality_natures: {on_the_beach: true, landscapes: true},
    },
    amenities: amenities(0, {sea_view: true}),
  },
];

async function main() {
  const {data: subs, error: subErr} = await supabase
    .from('subscriptions')
    .select('id, email, name, phone, subscription_type, profile_picture_url')
    .ilike('email', ownerEmail);

  if (subErr || !subs?.length) {
    console.error(subErr?.message || `No subscription for ${ownerEmail}`);
    process.exit(1);
  }

  const sub = subs[0];
  const creatorName = String(sub.name || 'יוסי כהן').trim();
  const phoneRaw = sub.phone ? String(sub.phone).replace(/\D/g, '') : '0501112233';
  const phoneFmt =
    phoneRaw.length >= 9 ? `0${phoneRaw.slice(-9, -7)}-${phoneRaw.slice(-7)}` : '050-1112233';

  const rows = ADS.map(ad => ({
    ...ad,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: creatorName,
    creator_email: sub.email || ownerEmail,
    subscription_type: 'user',
    profile_image_url: sub.profile_picture_url || null,
    status: 'published',
    feed_post: false,
    phone: phoneFmt,
    contact_details: contact(creatorName, sub.email || ownerEmail, phoneFmt, ad.address),
    exposure_level: 'high',
    overlay_x: 80,
    overlay_y: 80,
    updated_at: new Date().toISOString(),
  }));

  const {data: inserted, error: insErr} = await supabase
    .from('ads')
    .insert(rows)
    .select('id, category, project_name, address, creator_name');

  if (insErr) {
    console.error('Insert failed:', insErr.message);
    if (insErr.details) console.error(insErr.details);
    process.exit(1);
  }

  console.log(`Created ${inserted.length} ads for ${creatorName} (${ownerEmail})`);
  inserted.forEach(r => {
    const label = r.category === 3 ? 'שותפים' : 'BnB';
    console.log(`  [${label}] ${r.project_name} — ${r.address}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
