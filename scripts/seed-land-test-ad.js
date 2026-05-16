/**
 * Insert a published company קרקעות (category 7) test ad with all profile fields filled.
 * Run from pi-back: node scripts/seed-land-test-ad.js [owner-email]
 * Update existing: node scripts/seed-land-test-ad.js --update
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

const ownerEmail = (process.argv[2] || 'chaykaduri@gmail.com').trim().toLowerCase();
const UPDATE_ONLY = process.argv.includes('--update');
const TEST_AD_ID = 'a7c3e901-4b2d-4f8e-9c1a-00017e7ad001';

const IMG_MAIN =
  'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=1200&q=80';
const IMG_EXTRA = [
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80',
  'https://images.unsplash.com/photo-1416331108676-a22ccb276e35?w=1200&q=80',
];

const STREET_ADDRESS = 'רחוב הרצל 12, נתניה';
const LAND_PARCEL = '60';
const LAND_BLOCK = '40';

const COMPANY_LAND_PARCELS = [
  {unit: 'dunam', area: 1, price: 2000000},
  {unit: 'dunam', area: 2.5, price: 4500000},
  {unit: 'sqm', area: 850, price: 1200000},
];

const TEST_AD = {
  subscription_type: 'company',
  category: 7,
  status: 'published',
  feed_post: false,
  hot_deal: true,
  property_type: 'land',
  display_option: 'images',
  feed_display_priority: 'mainImage',
  purpose: 'sale',
  price: 4500000,
  project_name: 'אגי גרופ — קרקעות לבדיקה',
  address: STREET_ADDRESS,
  land_parcel: LAND_PARCEL,
  land_block: LAND_BLOCK,
  land_address: `${STREET_ADDRESS} | חלקה ${LAND_PARCEL} | גוש ${LAND_BLOCK}`,
  phone: '054-577-7754',
  description:
    'קרקעות פרימיום באזור מבוקש בנתניה. תב״ע מאושרת, היתר בנייה, קרקע חקלאית וזכויות מינהל. שלושה מגרשים בגדלים שונים — מתאים לפיתוח מגורים או מסחר. מודעת בדיקה מלאה לפרופיל קרקעות.',
  main_image_url: IMG_MAIN,
  additional_image_urls: IMG_EXTRA,
  video_url: null,
  sales_image_url: IMG_MAIN,
  profile_image_url: null,
  plan_approval: 'happy',
  land_in_mortgage: 'yes',
  permit: 'there_is',
  agricultural_land: 'yes',
  land_ownership: 'administration',
  company_offers_land_sizes: COMPANY_LAND_PARCELS,
  contact_details: {
    full_name: 'חי',
    email: 'chaykaduri@gmail.com',
    phone: '054-577-7754',
    address: STREET_ADDRESS,
    description: 'זמינים לפגישה והצגת תוכניות',
  },
  general_details: {
    building_count: 0,
    apartment_count: 0,
    floor_count: 0,
    shop_count: 0,
    parking_structured_count: 0,
  },
  overlay_x: 80,
  overlay_y: 80,
  exposure_level: 'high',
  area: 3,
  rooms: 1,
  floor: 1,
};

async function main() {
  if (UPDATE_ONLY) {
    const {data: updated, error: updErr} = await supabase
      .from('ads')
      .update({
        ...TEST_AD,
        updated_at: new Date().toISOString(),
      })
      .eq('id', TEST_AD_ID)
      .select(
        'id, category, project_name, land_parcel, land_block, company_offers_land_sizes, plan_approval, permit, agricultural_land, land_ownership',
      )
      .single();

    if (updErr) {
      console.error('Update failed:', updErr.message);
      process.exit(1);
    }
    console.log('Updated land test ad:', JSON.stringify(updated, null, 2));
    return;
  }

  const {data: subs, error: subErr} = await supabase
    .from('subscriptions')
    .select(
      'id, email, name, contact_person_name, business_name, broker_office_name, subscription_type, profile_picture_url, company_logo_url',
    )
    .ilike('email', ownerEmail);

  if (subErr) {
    console.error('Subscription lookup failed:', subErr.message);
    process.exit(1);
  }

  if (!subs?.length) {
    console.error(`No subscription found for email: ${ownerEmail}`);
    process.exit(1);
  }

  const sub = subs[0];
  const type = (sub.subscription_type || 'company').toLowerCase();
  if (type !== 'company') {
    console.warn(
      `Warning: ${ownerEmail} is subscription_type="${type}" — land company profile expects "company".`,
    );
  }

  const creatorName =
    sub.business_name ||
    sub.name ||
    sub.contact_person_name ||
    sub.broker_office_name ||
    'חי בע"מ';

  const profilePic =
    sub.profile_picture_url || sub.company_logo_url || null;

  const row = {
    ...TEST_AD,
    id: TEST_AD_ID,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: creatorName,
    creator_email: sub.email || ownerEmail,
    subscription_type: sub.subscription_type || 'company',
    profile_image_url: profilePic,
    updated_at: new Date().toISOString(),
  };

  const {data: existing} = await supabase
    .from('ads')
    .select('id')
    .eq('id', TEST_AD_ID)
    .maybeSingle();

  let result;
  if (existing?.id) {
    const {data, error} = await supabase
      .from('ads')
      .update(row)
      .eq('id', TEST_AD_ID)
      .select('id, category, status, project_name, address, land_parcel, land_block')
      .single();
    result = {data, error, action: 'updated'};
  } else {
    const {data, error} = await supabase
      .from('ads')
      .insert(row)
      .select('id, category, status, project_name, address, land_parcel, land_block')
      .single();
    result = {data, error, action: 'created'};
  }

  if (result.error) {
    console.error(`${result.action} failed:`, result.error.message);
    console.error(result.error.details || '');
    process.exit(1);
  }

  console.log(`${result.action === 'created' ? 'Created' : 'Updated'} company land test ad:`);
  console.log(JSON.stringify(result.data, null, 2));
  console.log('\nOwner:', ownerEmail, '| subscription_id:', sub.id);
  console.log('Ad ID:', TEST_AD_ID);
  console.log('Open category 7 (קרקעות) feed → company ad profile to test.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
