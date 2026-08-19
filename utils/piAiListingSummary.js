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

const PI_AI_CATEGORY_LEGEND = `1 חדש מקבלן, 2 משרד, 3 שותפים, 4 גלובל, 5 צימר/BNB, 6 מגזר דתי, 7 קרקע, 8 מסחרי, 10 דירה, 12 יוקרה. purpose_kind: rent=להשכרה, sale=למכירה.`;

const HOME_CATS = ['1', '6', '10', '12'];

/** Hard query constraints so Gemini cannot pad with unrelated types. */
function inferPiAiQueryConstraints(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  let cats = null;
  if (/שותפ/.test(q)) cats = ['3'];
  else if (/(?:צימר|\bbnb\b|לינה)/i.test(q)) cats = ['5'];
  else if (/משרד/.test(q)) cats = ['2'];
  else if (/(?:מגרש|קרקע|גוש|חלקה)/.test(q)) cats = ['7'];
  else if (/מסחר/.test(q)) cats = ['8'];
  else if (/(?:דיר|בית|יוקר|פנטהאוז)/.test(q)) cats = HOME_CATS;

  let purpose = null;
  const rent = /להשכרה|לשכור|שכירות|השכרה/.test(q);
  const sale = /למכירה|לקנות|קנייה|קניה/.test(q);
  if (rent && !sale) purpose = 'rent';
  else if (sale && !rent) purpose = 'sale';

  return {cats, purpose};
}

function listingFitsPiAiConstraints(item, constraints) {
  if (!item || !constraints) return true;
  if (constraints.cats && constraints.cats.length) {
    const c = String(item.category != null ? item.category : '');
    if (!constraints.cats.includes(c)) return false;
  }
  if (constraints.purpose) {
    const pk = String(item.purpose_kind || '').trim().toLowerCase();
    if (pk && pk !== constraints.purpose) return false;
  }
  return true;
}

function buildPiAiSearchPrompt(query, pool) {
  const q = String(query || '').trim().slice(0, 300);
  return `You rank Israeli real-estate ads. The query is Hebrew (typos OK). Use only the listings below.

QUERY: ${q}

CATEGORIES: ${PI_AI_CATEGORY_LEGEND}

LISTINGS (JSON):
${JSON.stringify(pool)}

Pick ads that actually match the query. Best first.
- If a city or neighborhood is named, keep only ads in that place.
- דירה/בית → 1,6,10,12. משרד → 2. קרקע/מגרש → 7. צימר/BNB → 5. שותפים → 3 only. Do not mix types.
- להשכרה → rent only. למכירה → sale only.
- If nothing fits, return an empty list. Do not fill with unrelated ads.
- Max 20 ids.

Reply JSON only: {"ids":["id1","id2"]}`;
}

module.exports = {
  buildPiAiListingSummary,
  sanitizePiAiPoolItem,
  inferPiAiQueryConstraints,
  listingFitsPiAiConstraints,
  buildPiAiSearchPrompt,
  PI_AI_CATEGORY_LEGEND,
  PI_AI_POOL_MAX: 250,
};
