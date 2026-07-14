/**
 * Seed 2 published broker ads per feed category for חי תיווך.
 * Run: node scripts/seed-chay-category-ads.js [email]
 */
require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in pi-back/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const ownerEmail = (process.argv[2] || 'chay.moalem@gmail.com').trim().toLowerCase();

const IMG = {
  apt: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=80',
  apt2: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1200&q=80',
  office: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80',
  office2: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1200&q=80',
  bnb: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80',
  bnb2: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=1200&q=80',
  land: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=1200&q=80',
  land2: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80',
  shop: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&q=80',
  shop2: 'https://images.unsplash.com/photo-1555529669-2269763671d0?w=1200&q=80',
  luxury: 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80',
  luxury2: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1200&q=80',
  global: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=1200&q=80',
  global2: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&q=80',
  religious: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1200&q=80',
  religious2: 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1200&q=80',
  newProj: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1200&q=80',
  newProj2: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1200&q=80',
};

function contact(phone, address) {
  return {
    full_name: 'חי תיווך',
    email: ownerEmail,
    phone,
    address,
    description: 'סוכנות תיווך מקצועית — נשמח לתאם סיור בשטח',
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

/** Broker seed ads (excludes BnB/partners — those are regular-user only). */
const ADS = [
  // 1 — חדש מקבלן
  {
    category: 1,
    property_type: 'apartment',
    project_name: 'מגדלי הראל — רמת גן',
    address: 'רחוב הראל 18, רמת גן',
    purpose: 'sale',
    price: 2890000,
    area: 105,
    rooms: 4,
    floor: 12,
    condition: 'new',
    construction_status: 'in_progress',
    sale_at_presale: true,
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.newProj,
    additional_image_urls: [IMG.newProj2, IMG.apt],
    description:
      'דירת 4 חדרים בפרויקט בוטיק חדש במרכז רמת גן. מפרט פרימיום, חדר ממ"ד, מרפסת שמש 14 מ"ר, חניה כפולה. מסירה משוערת Q2 2027.',
    project_offers: {
      apartment_4: {min: 95, max: 115},
      penthouse: {min: 160, max: 210},
    },
    general_details: {delivery_date: '2027-06', developer: 'אזורים'},
    amenities: amenities(2, {storage: true, smart_home: true}),
  },
  {
    category: 1,
    property_type: 'penthouse',
    project_name: 'נוף הים — הרצליה פיתוח',
    address: 'שדה דב 5, הרצליה',
    purpose: 'sale',
    price: 8900000,
    area: 220,
    rooms: 5,
    floor: 18,
    condition: 'new',
    construction_status: 'ready',
    sale_at_presale: false,
    display_option: 'slideshow',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.newProj2,
    additional_image_urls: [IMG.luxury, IMG.newProj],
    description:
      'פנטהאוז דופлекс עם בריכה פרטית ונוף לים. 5 חדרים, 220 מ"ר בנוי + 80 מ"ר מרפסות. מעלית פרטית, 3 חניות. מוכן לכניסה.',
    project_offers: {
      penthouse: {min: 200, max: 250},
      private_house: {min: 280, max: 350},
    },
    amenities: amenities(3, {pool: true, sea_view: true}),
  },

  // 2 — משרדים
  {
    category: 2,
    property_type: 'office',
    project_name: 'משרד מסחרי — מגדל עזריאלי',
    address: 'דרך מנחם בגין 132, תל אביב',
    purpose: 'rent',
    price: 18500,
    area: 145,
    rooms: 5,
    floor: 28,
    condition: 'renovated',
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.office,
    additional_image_urls: [IMG.office2],
    description:
      'משרד מרוהט ברמת A במגדל עזריאלי. 145 מ"ר, 5 חדרי עבודה, חדר ישיבות, מטבחון, 2 חניות. כניסה מיידית.',
    amenities: amenities(2, {reception: true, server_room: true}),
  },
  {
    category: 2,
    property_type: 'office',
    project_name: 'חלל פתוח — מגדל הלל, חיפה',
    address: 'הנביאים 58, חיפה',
    purpose: 'sale',
    price: 4200000,
    area: 210,
    rooms: 8,
    floor: 14,
    condition: 'old',
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.office2,
    additional_image_urls: [IMG.office],
    description:
      'קומת משרדים שלמה עם נוף לים. מתאים לחברת הייטק / מוקד שירות. 210 מ"ר, חלל פתוח, מעלית משא, 4 חניות.',
    amenities: amenities(4, {open_space: true, sea_view: true}),
  },

  // 3 — שותפים / 5 — BnB: regular-user only — do not seed broker ads here.

  // 4 — גלובל
  {
    category: 4,
    property_type: 'apartment',
    project_name: 'דירת השקעה — Miami Beach',
    address: 'Collins Avenue 1200, Miami Beach, FL',
    purpose: 'sale',
    price: 650000,
    area: 92,
    rooms: 2,
    floor: 8,
    condition: 'renovated',
    display_option: 'images',
    main_image_url: IMG.global,
    additional_image_urls: [IMG.global2],
    description:
      'דירת 2 חדרים למגורים / השקעה ב-Miami Beach. בניין עם קונסיירז\', בריכה, נוף לאוקיינוס. תשואה שנתית ~5%.',
    contact_details: contact('050-3232323', 'Miami Beach, FL'),
  },
  {
    category: 4,
    property_type: 'villa',
    project_name: 'וילה — לרנקה, קפריסין',
    address: 'Agios Tychonas, Larnaca, Cyprus',
    purpose: 'sale',
    price: 890000,
    area: 180,
    rooms: 4,
    floor: 1,
    condition: 'new',
    display_option: 'images',
    main_image_url: IMG.global2,
    additional_image_urls: [IMG.global],
    description:
      'וילה חדשה 4 חדרים במרחק 300 מטר מהים. מתאימה לתושבי חוזר / נופש. אפשרות לקבלת תוכניות EU.',
  },

  // 6 — מגזר דתי
  {
    category: 6,
    property_type: 'apartment',
    project_name: 'דירה 4 חדרים — בני ברק',
    address: 'רבי עקיבא 45, בני ברק',
    purpose: 'sale',
    price: 1950000,
    area: 98,
    rooms: 4,
    floor: 3,
    condition: 'renovated',
    display_option: 'images',
    main_image_url: IMG.religious,
    additional_image_urls: [IMG.religious2],
    description:
      'דירה מרווחת בקומה 3, בניין עם מעלית ומרפסת סוכה. קרוב לישיבות ותחבורה.',
    amenities: amenities(1, {sukkah_balcony: true, near_synagogue: true}),
  },
  {
    category: 6,
    property_type: 'apartment',
    project_name: 'דירה חדשה — רעמות, ירושלים',
    address: 'משה דיין 12, רעמות, ירושלים',
    purpose: 'rent',
    price: 7200,
    area: 110,
    rooms: 5,
    floor: 2,
    condition: 'new',
    display_option: 'images',
    main_image_url: IMG.religious2,
    additional_image_urls: [IMG.religious],
    description:
      'דירת 5 חדרים חדשה בשכונת רעמות. שתי מקלחות, חציצה בין מטבח לסאלון, חניה ומחסן. מתאים למשפחה.',
    amenities: amenities(1, {mamad: true, storage: true}),
  },

  // 7 — קרקעות
  {
    category: 7,
    property_type: 'land',
    project_name: 'מגרש למכירה — רעננה',
    address: 'שדרות בן גוריון 45, רעננה',
    land_parcel: '12',
    land_block: '3850',
    land_address: 'שדרות בן גוריון 45, רעננה | חלקה 12 | גוש 3850',
    purpose: 'sale',
    price: 3200000,
    area: 2500,
    rooms: 1,
    floor: 1,
    proposed_land: {unit: 'dunam', area: 2.5},
    plan_approval: 'happy',
    land_in_mortgage: 'yes',
    permit: 'there_is',
    agricultural_land: 'not',
    land_ownership: 'private',
    display_option: 'images',
    main_image_url: IMG.land,
    additional_image_urls: [IMG.land2],
    sales_image_url: IMG.land,
    description:
      'מגרש בנוי 2.5 דונם במיקום מבוקש. תב"ע מאושרת, היתר בנייה, מתאים לוילה או בניין דו-משפחתי.',
  },
  {
    category: 7,
    property_type: 'land',
    project_name: 'קרקע חקלאית — הגולן',
    address: 'כפר חנניה, רמת ההגולן',
    land_parcel: '88',
    land_block: '12001',
    land_address: 'כפר חנניה | חלקה 88 | גוש 12001',
    purpose: 'sale',
    price: 1800000,
    area: 8000,
    proposed_land: {unit: 'dunam', area: 8},
    plan_approval: 'in_process',
    land_in_mortgage: 'no',
    permit: 'none',
    agricultural_land: 'yes',
    land_ownership: 'private',
    display_option: 'images',
    main_image_url: IMG.land2,
    additional_image_urls: [IMG.land],
    description:
      '8 דונם קרקע חקלאית עם נוף להכנרת. מתאים לחקלאות / תיירות אקולוגית. גישה בכביש עפר מטופח.',
  },

  // 8 — מסחר
  {
    category: 8,
    property_type: 'commercial',
    project_name: 'חנות ברחוב בן יהודה',
    address: 'רחוב בן יהודה 28, ירושלים',
    purpose: 'rent',
    price: 22000,
    area: 65,
    rooms: 1,
    floor: 0,
    condition: 'renovated',
    display_option: 'images',
    main_image_url: IMG.shop,
    additional_image_urls: [IMG.shop2],
    description:
      'חנות בקומת קרקע ברחוב בן יהודה הסגור. 65 מ"ר, חזית 6 מטר, תאורה מעוצבת. מתאים לקמעונאות / בית קפה.',
    amenities: amenities(0, {street_front: true, high_foot_traffic: true}),
  },
  {
    category: 8,
    property_type: 'warehouse',
    project_name: 'מחסן לוגיסטי — מודיעין',
    address: 'אזור תעשייה שפירים, מודיעין',
    purpose: 'rent',
    price: 38000,
    area: 450,
    rooms: 1,
    floor: 0,
    condition: 'old',
    display_option: 'images',
    main_image_url: IMG.shop2,
    additional_image_urls: [IMG.shop],
    description:
      'מחסן 450 מ"ר עם שער משא 4.5 מ\', גובה 8 מ\'. משרד קטן + שירותים. גישה לכביש 6.',
    amenities: amenities(6, {loading_dock: true, crane: false}),
  },

  // 10 — דירות
  {
    category: 10,
    property_type: 'apartment',
    project_name: '3 חדרים — לב תל אביב',
    address: 'דיזנגוף 140, תל אביב',
    purpose: 'sale',
    price: 3450000,
    area: 78,
    rooms: 3,
    floor: 4,
    condition: 'renovated',
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.apt,
    additional_image_urls: [IMG.apt2],
    description:
      'דירת 3 חדרים משופצת בלב דיזנגוף. מרפסת 8 מ"ר, מטבח חדש, מעלית. 5 דקות מהים.',
    amenities: amenities(0, {renovated: true, near_beach: true}),
  },
  {
    category: 10,
    property_type: 'apartment',
    project_name: '5 חדרים — רעננה',
    address: 'אחוזת בית 8, רעננה',
    purpose: 'rent',
    price: 9800,
    area: 130,
    rooms: 5,
    floor: 2,
    condition: 'old',
    display_option: 'images',
    main_image_url: IMG.apt2,
    additional_image_urls: [IMG.apt],
    description:
      'דירת 5 חדרים מרווחת בשכונת אחוזת בית. 2 חניות, מחסן, גינה משותפת. מתאים למשפחה.',
    amenities: amenities(2, {garden_access: true, storage: true}),
  },

  // 12 — יוקרה
  {
    category: 12,
    property_type: 'penthouse',
    project_name: 'פנטהאוז — הרצליה פיתוח',
    address: 'הרב ניסים 3, הרצליה פיתוח',
    purpose: 'sale',
    price: 18500000,
    area: 320,
    rooms: 6,
    floor: 12,
    condition: 'renovated',
    display_option: 'images',
    feed_display_priority: 'mainImage',
    main_image_url: IMG.luxury,
    additional_image_urls: [IMG.luxury2],
    description:
      'פנטהאוז ייחודי 320 מ"ר + 120 מ"ר מרפסות. בריכה פרטית, מעלית פרטית, 4 חניות, בית חכם מלא.',
    amenities: amenities(4, {pool: true, sea_view: true, smart_home: true}),
  },
  {
    category: 12,
    property_type: 'villa',
    project_name: 'וילה — קיסריה',
    address: 'רחוב הים 1, קיסריה',
    purpose: 'sale',
    price: 22000000,
    area: 480,
    rooms: 7,
    floor: 1,
    condition: 'new',
    display_option: 'images',
    main_image_url: IMG.luxury2,
    additional_image_urls: [IMG.luxury],
    description:
      'וילה יוקרתית על המים בקיסריה. 7 חדרים, בריכת אינפיניטי, חדר קולנוע ביתי, 800 מ"ר מגרש מטופח.',
    amenities: amenities(3, {pool: true, sea_view: true, home_cinema: true}),
  },
];

async function main() {
  const {data: subs, error: subErr} = await supabase
    .from('subscriptions')
    .select(
      'id, email, name, contact_person_name, business_name, broker_office_name, subscription_type, profile_picture_url, phone',
    )
    .ilike('email', ownerEmail);

  if (subErr) {
    console.error('Subscription lookup failed:', subErr.message);
    process.exit(1);
  }
  if (!subs?.length) {
    console.error(`No subscription for ${ownerEmail}`);
    process.exit(1);
  }

  const sub = subs[0];
  const creatorName =
    (sub.broker_office_name && String(sub.broker_office_name).trim()) ||
    (sub.business_name && String(sub.business_name).trim()) ||
    'חי תיווך';
  const phone = sub.phone ? String(sub.phone).replace(/\D/g, '') : '0503232323';
  const phoneFmt =
    phone.length >= 9 ? `0${phone.slice(-9, -7)}-${phone.slice(-7)}` : '050-3232323';

  const rows = ADS.map(ad => ({
    ...ad,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: creatorName,
    creator_email: sub.email || ownerEmail,
    subscription_type: sub.subscription_type || 'broker',
    profile_image_url: sub.profile_picture_url || null,
    status: 'published',
    feed_post: false,
    phone: phoneFmt,
    contact_details: ad.contact_details || contact(phoneFmt, ad.address),
    exposure_level: 'high',
    overlay_x: 80,
    overlay_y: 80,
    updated_at: new Date().toISOString(),
  }));

  const {data: inserted, error: insErr} = await supabase
    .from('ads')
    .insert(rows)
    .select('id, category, project_name, address, price, purpose');

  if (insErr) {
    console.error('Insert failed:', insErr.message);
    console.error(insErr.details || insErr.hint || '');
    process.exit(1);
  }

  const byCat = inserted.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});

  console.log(`Created ${inserted.length} ads for ${creatorName} (${ownerEmail})`);
  console.log('By category:', byCat);
  inserted.forEach(r => {
    console.log(`  [${r.category}] ${r.project_name} — ${r.address}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
