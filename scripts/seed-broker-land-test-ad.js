/**
 * Insert a published broker קרקעות (category 7) test ad with land fields filled.
 * Run from pi-back: node scripts/seed-broker-land-test-ad.js [owner-email]
 * Update existing: node scripts/seed-broker-land-test-ad.js --update
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
const UPDATE_ONLY = process.argv.includes('--update');
const TEST_AD_ID = 'b8d4e902-5c3e-4f9f-9d2b-0001b70ad001';

const IMG_MAIN =
  'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=1200&q=80';
const IMG_EXTRA = [
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80',
  'https://images.unsplash.com/photo-1416331108676-a22ccb276e35?w=1200&q=80',
];

const STREET_ADDRESS = 'שדרות בן גוריון 45, רעננה';
const LAND_PARCEL = '12';
const LAND_BLOCK = '3850';

const TEST_AD = {
  subscription_type: 'broker',
  category: 7,
  status: 'published',
  feed_post: false,
  hot_deal: false,
  property_type: 'land',
  display_option: 'images',
  feed_display_priority: 'mainImage',
  purpose: 'sale',
  price: 3200000,
  project_name: 'מגרש ברעננה — תיווך חי',
  address: STREET_ADDRESS,
  land_parcel: LAND_PARCEL,
  land_block: LAND_BLOCK,
  land_address: `${STREET_ADDRESS} | חלקה ${LAND_PARCEL} | גוש ${LAND_BLOCK}`,
  phone: '050-1234567',
  description:
    'קרקע למכירה במיקום מבוקש ברעננה. תב״ע מאושרת, היתר בנייה, קרקע במושב. מתאים לבניית וילה או פרויקט קטן. מודעת בדיקה — מתווך.',
  main_image_url: IMG_MAIN,
  additional_image_urls: IMG_EXTRA,
  video_url: null,
  sales_image_url: IMG_MAIN,
  profile_image_url: null,
  proposed_land: {unit: 'dunam', area: 2.5},
  plan_approval: 'happy',
  land_in_mortgage: 'yes',
  permit: 'there_is',
  agricultural_land: 'not',
  land_ownership: 'private',
  company_offers_land_sizes: null,
  contact_details: {
    full_name: 'חי תיווך',
    email: 'chay.moalem@gmail.com',
    phone: '050-1234567',
    address: STREET_ADDRESS,
    description: 'לתיאום סיור בשטח',
  },
  overlay_x: 80,
  overlay_y: 80,
  exposure_level: 'high',
  area: 2500,
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
        'id, category, subscription_type, project_name, land_parcel, land_block, proposed_land, plan_approval',
      )
      .single();

    if (updErr) {
      console.error('Update failed:', updErr.message);
      process.exit(1);
    }
    console.log('Updated broker land test ad:', JSON.stringify(updated, null, 2));
    return;
  }

  const {data: subs, error: subErr} = await supabase
    .from('subscriptions')
    .select(
      'id, email, name, contact_person_name, business_name, broker_office_name, subscription_type, profile_picture_url',
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
  const type = (sub.subscription_type || 'broker').toLowerCase();
  if (type !== 'broker') {
    console.warn(
      `Warning: ${ownerEmail} is subscription_type="${type}" — expected "broker" for this seed.`,
    );
  }

  const creatorName =
    sub.broker_office_name ||
    sub.name ||
    sub.contact_person_name ||
    sub.business_name ||
    'מתווך';

  const profilePic = sub.profile_picture_url || null;

  const row = {
    ...TEST_AD,
    id: TEST_AD_ID,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: creatorName,
    creator_email: sub.email || ownerEmail,
    subscription_type: sub.subscription_type || 'broker',
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
      .select(
        'id, category, subscription_type, status, project_name, address, land_parcel, land_block, proposed_land',
      )
      .single();
    result = {data, error, action: 'updated'};
  } else {
    const {data, error} = await supabase
      .from('ads')
      .insert(row)
      .select(
        'id, category, subscription_type, status, project_name, address, land_parcel, land_block, proposed_land',
      )
      .single();
    result = {data, error, action: 'created'};
  }

  if (result.error) {
    console.error(`${result.action} failed:`, result.error.message);
    console.error(result.error.details || '');
    process.exit(1);
  }

  console.log(
    `${result.action === 'created' ? 'Created' : 'Updated'} broker land test ad:`,
  );
  console.log(JSON.stringify(result.data, null, 2));
  console.log('\nOwner:', ownerEmail, '| subscription_id:', sub.id);
  console.log('Ad ID:', TEST_AD_ID);
  console.log('Open category 7 (קרקעות) feed to find this broker listing.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
