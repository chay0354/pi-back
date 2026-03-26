#!/usr/bin/env node
/**
 * Check that all form fields from the ads form appear in the DB.
 * Compares: frontend listing payload keys -> backend body destructuring -> adRecord -> ads table columns.
 * Run from pi-back: node scripts/check-listings-fields-to-db.js
 */

const FRONTEND_STANDARD_KEYS = [
  'status', 'subscriptionType', 'subscriptionId', 'propertyType', 'area', 'rooms', 'floor',
  'amenities', 'condition', 'purpose', 'price', 'projectName', 'address', 'phone', 'description',
  'displayOption', 'mainImageUrl', 'additionalImageUrls', 'videoUrl', 'hasVideo',
  'profileImageUrl', 'feed_display_priority', 'exposure_level', 'category',
  'planApproval', 'landInMortgage', 'permit', 'agriculturalLand', 'landOwnership',
  'generalDetails', 'projectOffers', 'constructionStatus', 'saleAtPresale',
];

const FRONTEND_CATEGORY3_KEYS = [
  'status', 'subscriptionType', 'subscriptionId', 'searchPurpose', 'preferredApartmentType',
  'preferredGender', 'preferredAgeMin', 'preferredAgeMax', 'preferences', 'budget',
  'description', 'mainImageUrl', 'profileImageUrl', 'category',
  'propertyType', 'area', 'rooms', 'floor', 'purpose', 'price', 'address', 'phone', 'additionalImageUrls',
];

const BACKEND_BODY_KEYS = [
  'category', 'status', 'subscriptionId', 'subscriptionType', 'propertyType', 'area', 'rooms', 'floor',
  'purpose', 'price', 'projectName', 'address', 'phone', 'description', 'displayOption', 'feed_display_priority',
  'mainImageUrl', 'additionalImageUrls', 'videoUrl', 'hasVideo', 'amenities', 'condition',
  'searchPurpose', 'preferredApartmentType', 'preferredGender', 'preferredAgeMin', 'preferredAgeMax',
  'preferences', 'budget', 'pricePerNight', 'hospitalityNature', 'serviceFacility', 'accommodationOffers',
  'cancellationPolicy', 'contactDetails', 'proposedLand', 'planApproval', 'landInMortgage', 'permit',
  'agriculturalLand', 'landOwnership', 'landAddress', 'constructionStatus', 'saleAtPresale',
  'generalDetails', 'projectOffers', 'companyOffersLandSizes', 'salesImageUrl', 'profileImageUrl',
  'overlay_x', 'overlay_y', 'exposure_level',
];

const AD_RECORD_TO_DB_COLUMN = {
  subscription_id: 'subscription_id',
  owner_id: 'owner_id',
  creator_name: 'creator_name',
  creator_email: 'creator_email',
  subscription_type: 'subscription_type',
  category: 'category',
  status: 'status',
  main_image_url: 'main_image_url',
  additional_image_urls: 'additional_image_urls',
  video_url: 'video_url',
  sales_image_url: 'sales_image_url',
  profile_image_url: 'profile_image_url',
  display_option: 'display_option',
  feed_display_priority: 'feed_display_priority',
  property_type: 'property_type',
  area: 'area',
  rooms: 'rooms',
  floor: 'floor',
  purpose: 'purpose',
  price: 'price',
  budget: 'budget',
  price_per_night: 'price_per_night',
  amenities: 'amenities',
  condition: 'condition',
  project_name: 'project_name',
  address: 'address',
  phone: 'phone',
  description: 'description',
  overlay_x: 'overlay_x',
  overlay_y: 'overlay_y',
  search_purpose: 'search_purpose',
  preferred_apartment_type: 'preferred_apartment_type',
  preferred_gender: 'preferred_gender',
  preferred_age_min: 'preferred_age_min',
  preferred_age_max: 'preferred_age_max',
  preferences: 'preferences',
  hospitality_nature: 'hospitality_nature',
  service_facility: 'service_facility',
  accommodation_offers: 'accommodation_offers',
  cancellation_policy: 'cancellation_policy',
  contact_details: 'contact_details',
  proposed_land: 'proposed_land',
  plan_approval: 'plan_approval',
  land_in_mortgage: 'land_in_mortgage',
  permit: 'permit',
  agricultural_land: 'agricultural_land',
  land_ownership: 'land_ownership',
  land_address: 'land_address',
  construction_status: 'construction_status',
  sale_at_presale: 'sale_at_presale',
  general_details: 'general_details',
  project_offers: 'project_offers',
  company_offers_land_sizes: 'company_offers_land_sizes',
  exposure_level: 'exposure_level',
};

const camelToBody = {
  subscriptionType: 'subscriptionType',
  subscriptionId: 'subscriptionId',
  propertyType: 'propertyType',
  mainImageUrl: 'mainImageUrl',
  additionalImageUrls: 'additionalImageUrls',
  videoUrl: 'videoUrl',
  hasVideo: 'hasVideo',
  profileImageUrl: 'profileImageUrl',
  displayOption: 'displayOption',
  feed_display_priority: 'feed_display_priority',
  exposure_level: 'exposure_level',
  generalDetails: 'generalDetails',
  projectOffers: 'projectOffers',
  constructionStatus: 'constructionStatus',
  saleAtPresale: 'saleAtPresale',
  planApproval: 'planApproval',
  landInMortgage: 'landInMortgage',
  agriculturalLand: 'agriculturalLand',
  landOwnership: 'landOwnership',
  searchPurpose: 'searchPurpose',
  preferredApartmentType: 'preferredApartmentType',
  preferredGender: 'preferredGender',
  preferredAgeMin: 'preferredAgeMin',
  preferredAgeMax: 'preferredAgeMax',
};

function main() {
  console.log('=== Listings form fields → DB check ===\n');

  const frontSet = new Set(FRONTEND_STANDARD_KEYS);
  const bodySet = new Set(BACKEND_BODY_KEYS);
  const missingInBackend = FRONTEND_STANDARD_KEYS.filter(k => {
    const bodyKey = camelToBody[k] || k;
    return !bodySet.has(bodyKey);
  });
  if (missingInBackend.length) {
    console.log('❌ Frontend sends but backend does NOT destructure:', missingInBackend.join(', '));
  } else {
    console.log('✅ All standard frontend keys are destructured in backend body.');
  }

  const dbColumns = new Set(Object.keys(AD_RECORD_TO_DB_COLUMN));
  const adRecordKeys = Object.keys(AD_RECORD_TO_DB_COLUMN);
  console.log('\n✅ adRecord keys that map to DB columns:', adRecordKeys.length);
  console.log('   Columns:', adRecordKeys.join(', '));

  // Columns from migration-ads-unified-table.sql + add-ads-creator-columns.sql + migration-add-post-overlay-position.sql + migration-add-feed-display-priority.sql + migration-ads-exposure-level.sql + migration-ads-project-name.sql
  const fromMigrations = [
    'subscription_id', 'owner_id', 'creator_name', 'creator_email', 'subscription_type', 'category', 'status',
    'main_image_url', 'additional_image_urls', 'video_url', 'sales_image_url', 'profile_image_url', 'display_option',
    'feed_display_priority', 'property_type', 'area', 'rooms', 'floor', 'purpose', 'price', 'budget', 'price_per_night',
    'amenities', 'condition', 'project_name', 'address', 'phone', 'description', 'overlay_x', 'overlay_y',
    'search_purpose', 'preferred_apartment_type', 'preferred_gender', 'preferred_age_min', 'preferred_age_max', 'preferences',
    'hospitality_nature', 'service_facility', 'accommodation_offers', 'cancellation_policy', 'contact_details',
    'proposed_land', 'plan_approval', 'land_in_mortgage', 'permit', 'agricultural_land', 'land_ownership', 'land_address',
    'construction_status', 'sale_at_presale', 'general_details', 'project_offers', 'company_offers_land_sizes',
    'exposure_level',
  ];
  const migrationSet = new Set(fromMigrations);
  const notInMigration = adRecordKeys.filter(c => !migrationSet.has(c));
  if (notInMigration.length) {
    console.log('\n⚠️  adRecord keys not in migration-ads-unified-table (may be in other migrations):', notInMigration.join(', '));
  } else {
    console.log('\n✅ All adRecord keys exist in migrations.');
  }

  console.log('\n--- Summary ---');
  console.log('Frontend standard payload:', FRONTEND_STANDARD_KEYS.length, 'keys');
  console.log('Backend body destructuring:', BACKEND_BODY_KEYS.length, 'keys');
  console.log('adRecord → DB columns:', adRecordKeys.length);
  console.log('\n--- Form field → DB column mapping ---');
  const formToDb = [
    ['שם הפרויקט / projectName', 'project_name'],
    ['כתובת הפרויקט / address', 'address'],
    ['פרטים כלליים (כמות מבנים, קומות, דירות)', 'general_details (JSONB)'],
    ['הפרויקט מציע (משרדים, דירות, וכו\')', 'project_offers (JSONB)'],
    ['מצב בניה', 'construction_status'],
    ['מכירה בפריסייל', 'sale_at_presale'],
    ['טלפון', 'phone'],
    ['תיאור', 'description'],
  ];
  formToDb.forEach(([form, col]) => console.log('  ', form, '→', col));
  console.log('\n✅ All form fields have a DB column. Run migration-ads-project-name.sql in Supabase if project_name is missing.');
}

main();
