/** Category labels — keep in sync with pi-front/utils/chatListingCategory.js */
const CATEGORY_LABELS = {
  1: 'חדש מקבלן',
  2: 'משרדים',
  3: 'שותפים',
  4: 'גלובל',
  5: 'BNB',
  6: 'מגזר דתי',
  7: 'קרקעות',
  8: 'מסחרי',
  10: 'דירות',
  12: 'יוקרה',
};

function clip(v, max) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function purposeKind(listing) {
  const raw = String(listing?.purpose || '')
    .trim()
    .toLowerCase();
  if (raw === 'rent' || raw === 'להשכרה' || raw.includes('השכר')) {
    return 'rent';
  }
  if (raw === 'sale' || raw === 'למכירה' || raw.includes('מכיר')) {
    return 'sale';
  }
  return '';
}

function amenitiesText(listing) {
  const a = listing?.amenities;
  if (Array.isArray(a)) {
    return a
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  if (typeof a === 'string') return a.trim();
  return '';
}

function preferencesText(listing) {
  const p = listing?.preferences;
  if (Array.isArray(p)) {
    return p
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  if (p && typeof p === 'object') {
    try {
      return JSON.stringify(p);
    } catch (_) {
      return '';
    }
  }
  if (typeof p === 'string') return p.trim();
  return '';
}

/**
 * Compact listing payload for Pi AI (Gemini) search.
 * @param {Record<string, unknown>} listing
 * @returns {Record<string, string>}
 */
function buildPiAiListingSummary(listing) {
  if (!listing || listing.id == null) return null;
  const item = {id: clip(listing.id, 48)};
  const put = (key, value, max) => {
    const s = clip(value, max);
    if (s) item[key] = s;
  };

  const catNum = Number(listing.category);
  put('category', listing.category, 10);
  if (Number.isFinite(catNum) && CATEGORY_LABELS[catNum]) {
    put('category_label', CATEGORY_LABELS[catNum], 30);
  }

  put('purpose', listing.purpose, 30);
  const pk = purposeKind(listing);
  if (pk) put('purpose_kind', pk, 10);

  put('property_type', listing.property_type, 40);
  put('apartment_type', listing.apartment_type, 40);
  put(
    'address',
    listing.address || listing.search_address || listing.land_address,
    160,
  );
  put('land_address', listing.land_address, 120);
  put('land_parcel', listing.land_parcel, 40);
  put('land_block', listing.land_block, 40);
  put('project_name', listing.project_name, 80);
  put('price', listing.price, 20);
  put('budget', listing.budget, 20);
  put('price_per_night', listing.price_per_night, 20);
  put('rooms', listing.rooms, 10);
  put('area', listing.area, 12);
  put('floor', listing.floor, 10);
  put(
    'search_purpose',
    listing.search_purpose || listing.searchPurposeKey,
    20,
  );
  put('condition', listing.condition, 30);
  put('construction_status', listing.construction_status, 30);
  put('permit', listing.permit, 30);
  put('hospitality_nature', listing.hospitality_nature, 40);
  put('service_facility', listing.service_facility, 40);
  put('preferred_gender', listing.preferred_gender, 20);
  put('preferred_apartment_type', listing.preferred_apartment_type, 40);
  if (listing.preferred_age_min != null && listing.preferred_age_min !== '') {
    put('preferred_age_min', listing.preferred_age_min, 6);
  }
  if (listing.preferred_age_max != null && listing.preferred_age_max !== '') {
    put('preferred_age_max', listing.preferred_age_max, 6);
  }
  put('preferences', preferencesText(listing), 120);
  put('amenities', amenitiesText(listing), 120);
  put('description', listing.description, 400);

  return item;
}

const PI_AI_POOL_FIELD_LIMITS = {
  id: 48,
  category: 10,
  category_label: 30,
  purpose: 30,
  purpose_kind: 10,
  property_type: 40,
  apartment_type: 40,
  address: 160,
  land_address: 120,
  land_parcel: 40,
  land_block: 40,
  project_name: 80,
  price: 20,
  budget: 20,
  price_per_night: 20,
  rooms: 10,
  area: 12,
  floor: 10,
  search_purpose: 20,
  condition: 30,
  construction_status: 30,
  permit: 30,
  hospitality_nature: 40,
  service_facility: 40,
  preferred_gender: 20,
  preferred_apartment_type: 40,
  preferred_age_min: 6,
  preferred_age_max: 6,
  preferences: 120,
  amenities: 120,
  description: 400,
};

function sanitizePiAiPoolItem(raw) {
  if (!raw || raw.id == null) return null;
  const item = {id: clip(raw.id, PI_AI_POOL_FIELD_LIMITS.id)};
  for (const [key, max] of Object.entries(PI_AI_POOL_FIELD_LIMITS)) {
    if (key === 'id') continue;
    const s = clip(raw[key], max);
    if (s) item[key] = s;
  }
  return item;
}

const PI_AI_CATEGORY_LEGEND = `Listing categories (category / category_label):
1 = חדש מקבלן (new developer apartments)
2 = משרדים (offices)
3 = שותפים (roommates / shared apartment — NOT regular rent)
4 = גלובל
5 = BNB / צימר / lodging (price_per_night, hospitality_nature)
6 = מגזר דתי
7 = קרקעות / land (land_address, land_parcel, land_block, permit)
8 = מסחרי / commercial
10 = דירות (regular apartments — default)
12 = יוקרה / luxury

purpose_kind: rent = להשכרה, sale = למכירה (Hebrew purpose field may also appear).`;

module.exports = {
  buildPiAiListingSummary,
  sanitizePiAiPoolItem,
  PI_AI_CATEGORY_LEGEND,
  PI_AI_POOL_MAX: 250,
};
