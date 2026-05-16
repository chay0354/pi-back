/**
 * Insert a published BnB (category 5) test ad with all profile fields filled.
 * Run from pi-back: node scripts/seed-bnb-test-ad.js [owner-email]
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in pi-back/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const ownerEmail = (process.argv[2] || 'chay.moalem@gmail.com').trim().toLowerCase();

const IMG_MAIN =
  'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80';
const IMG_EXTRA = [
  'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=1200&q=80',
  'https://images.unsplash.com/photo-1611892440504-42a792e524da?w=1200&q=80',
  'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1200&q=80',
];

const ALL_HOSPITALITY = [
  'landscapes',
  'on_the_beach',
  'with_pool',
  'nature',
  'special',
  'rural',
  'desert',
];

const ALL_SERVICES = [
  'pool',
  'merger',
  'fridge',
  'laundry',
  'eater',
  'kitchen',
  'locker',
  'tv',
  'safe',
  'smoke_detector',
  'wifi_internet',
  'private_services',
  'shared_services',
  'private_shower',
  'shared_shower',
  'accessible_place',
  'suitable_for_animals',
  'suitable_for_smokers',
];

const hospitalityNatures = Object.fromEntries(
  ALL_HOSPITALITY.map(k => [k, true]),
);

const serviceFacility = {
  selected: 'pool',
  ...Object.fromEntries(ALL_SERVICES.map(k => [k, true])),
};

const TEST_AD = {
  subscription_type: 'broker',
  category: 5,
  status: 'published',
  feed_post: false,
  hot_deal: true,
  property_type: 'B&B',
  display_option: 'images',
  feed_display_priority: 'mainImage',
  area: 120,
  rooms: 2,
  floor: 2,
  purpose: 'rent',
  price: 1000,
  price_per_night: 1000,
  hospitality_nature: 'with_pool',
  cancellation_policy: 'without_penalty',
  project_name: 'בית המעיינות',
  address: 'מושב לכיש, המסיק 140',
  phone: '050-1234567',
  description:
    'בית המעיינות במושב לכיש מציע לכם חוויית נופש אולטימטיבית ובלתי נשכחת, למרגלות יער עופר ושמורת טבע מעיינות. מתחם נופש מהמדרגה הראשונה עם חדרים מרווחים, בריכה מחוממת וארוחת בוקר עשירה.',
  main_image_url: IMG_MAIN,
  additional_image_urls: IMG_EXTRA,
  video_url: null,
  amenities: {
    'כמות חניות': 2,
    'חנייה בתשלום': 'ללא',
    parking: 2,
    paid_parking: false,
    elevator: false,
  },
  condition: 'renovated',
  service_facility: serviceFacility,
  accommodation_offers: {
    check_in_date: '2026-08-15',
    check_out_date: '2026-08-20',
    guest_count: 4,
  },
  contact_details: {
    full_name: 'תומר ליאור',
    email: 'tomer.test@example.com',
    phone: '050-1234567',
    address: 'מושב לכיש, המסיק 140',
    description: 'זמינים לשאלות בכל שעות היום',
  },
  general_details: {
    bnb_host_type: 'private',
    hospitality_natures: hospitalityNatures,
  },
  overlay_x: 80,
  overlay_y: 80,
  exposure_level: 'high',
};

const TEST_AD_ID = 'f8b19024-7a31-46c3-b7b0-f3cbfcd844cf';
const UPDATE_ONLY = process.argv.includes('--update');

async function main() {
  if (UPDATE_ONLY) {
    const { data: updated, error: updErr } = await supabase
      .from('ads')
      .update({
        floor: TEST_AD.floor,
        amenities: TEST_AD.amenities,
        service_facility: serviceFacility,
        general_details: {
          bnb_host_type: 'private',
          hospitality_natures: hospitalityNatures,
        },
        hospitality_nature: 'with_pool',
        updated_at: new Date().toISOString(),
      })
      .eq('id', TEST_AD_ID)
      .select('id, project_name, floor, amenities, service_facility, general_details')
      .single();

    if (updErr) {
      console.error('Update failed:', updErr.message);
      process.exit(1);
    }
    console.log('Updated BnB test ad:', JSON.stringify(updated, null, 2));
    return;
  }

  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('id, email, name, contact_person_name, business_name, broker_office_name, subscription_type')
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
  let creatorName =
    sub.name || sub.contact_person_name || sub.business_name || sub.broker_office_name;
  if (type === 'company') creatorName = sub.business_name || creatorName;
  if (type === 'broker') creatorName = sub.broker_office_name || creatorName;

  const row = {
    ...TEST_AD,
    subscription_id: sub.id,
    owner_id: String(sub.id),
    creator_name: creatorName || 'תומר ליאור',
    creator_email: sub.email || ownerEmail,
    subscription_type: sub.subscription_type || TEST_AD.subscription_type,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insErr } = await supabase
    .from('ads')
    .insert(row)
    .select('id, category, status, project_name, address, price_per_night, hospitality_nature')
    .single();

  if (insErr) {
    console.error('Insert failed:', insErr.message);
    console.error(insErr.details || '');
    process.exit(1);
  }

  console.log('Created BnB test ad:');
  console.log(JSON.stringify(inserted, null, 2));
  console.log('\nOwner:', ownerEmail, '| subscription_id:', sub.id);
  console.log('Open category 5 (שותפים/BnB) feed and view this listing profile.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
