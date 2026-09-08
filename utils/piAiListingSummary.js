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

/** Amenities arrive as an object, an array, or a JSON string. */
function parseAmenities(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return s;
    }
  }
  return s;
}

const AMENITY_OFF_VALUES = /^(?:false|לא|ללא|אין|0)$/i;

/**
 * Flatten amenities to readable text ("מעלית, כמות חניות 2"). The object form
 * used to serialize to nothing, which hid parking / elevator from Pi AI.
 */
function amenitiesText(listing) {
  const a = parseAmenities(listing?.amenities);
  if (Array.isArray(a)) {
    return a
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  if (a && typeof a === 'object') {
    const out = [];
    for (const [key, value] of Object.entries(a)) {
      const label = String(key || '').trim();
      if (!label) continue;
      if (value === true || value === 'true' || value === 'כן') {
        out.push(label);
        continue;
      }
      if (typeof value === 'number' && value > 0) {
        out.push(`${label} ${value}`);
        continue;
      }
      const s = value != null ? String(value).trim() : '';
      if (s && !AMENITY_OFF_VALUES.test(s)) out.push(`${label} ${s}`);
    }
    return out.join(', ');
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

function getProjectOffers(listing) {
  let po = listing?.project_offers ?? listing?.projectOffers;
  if (typeof po === 'string') {
    try {
      po = JSON.parse(po);
    } catch (_) {
      return null;
    }
  }
  return po && typeof po === 'object' ? po : null;
}

function offerLineActive(po, name) {
  if (!po || typeof po !== 'object') return false;
  const area = Number(po[`${name}_area`]);
  const price = Number(po[`${name}_price`]);
  return (
    (Number.isFinite(area) && area > 0) || (Number.isFinite(price) && price > 0)
  );
}

function projectOfferRoomTypes(listing) {
  const po = getProjectOffers(listing);
  const labels = [];
  const roomNums = [];
  const addNum = n => {
    const x = Number(n);
    if (Number.isFinite(x) && x > 0 && !roomNums.includes(x)) roomNums.push(x);
  };
  if (po) {
    for (const n of [3, 4, 5]) {
      if (offerLineActive(po, `rooms_${n}`)) {
        labels.push(`${n} חדרים`);
        addNum(n);
      }
    }
    if (offerLineActive(po, 'garden')) {
      labels.push('דירת גן');
      addNum(po.garden_rooms);
    }
    if (offerLineActive(po, 'penthouse')) {
      labels.push('פנטהאוז');
      addNum(po.penthouse_rooms);
    }
    if (offerLineActive(po, 'private')) {
      labels.push('בית פרטי');
      addNum(po.private_rooms);
    }
  }
  const roomsRaw = listing?.rooms != null ? String(listing.rooms).trim() : '';
  if (roomsRaw.includes(',')) {
    for (const bit of roomsRaw.split(',')) addNum(bit.trim());
  } else {
    const listingRooms = Number(listing?.rooms);
    if (Number.isFinite(listingRooms) && listingRooms > 0) {
      const dummyOne = listingRooms === 1 && roomNums.length > 0;
      if (!dummyOne) addNum(listingRooms);
    }
  }
  return {labels, roomNums};
}

function projectOfferNumbers(listing, suffix) {
  const po = getProjectOffers(listing);
  if (!po) return [];
  const out = [];
  for (const [key, value] of Object.entries(po)) {
    if (!key.endsWith(suffix)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function listingPublisherName(listing) {
  const parts = [
    listing?.creator_name,
    listing?.creator_business_name,
    listing?.business_name,
    listing?.broker_office_name,
    listing?.publisher,
    listing?.company_name,
  ];
  const seen = new Set();
  const out = [];
  for (const v of parts) {
    const s = v != null ? String(v).trim() : '';
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function listingSubscriberNumber(listing) {
  const v =
    listing?.creator_subscriber_number ??
    listing?.subscriber_number ??
    listing?.created_by_subscriber_number;
  return v != null ? String(v).trim() : '';
}

function listingOffersRoomCount(listing, want) {
  const n = Number(want);
  if (!Number.isFinite(n) || n <= 0) return true;
  const {roomNums, labels} = projectOfferRoomTypes(listing);
  if (roomNums.some(x => Number(x) === n)) return true;
  const compact = `${listing?.rooms || ''} ${listing?.rooms_offered || ''} ${labels.join(' ')}`;
  const nums = String(compact).match(/\d+(?:\.\d+)?/g) || [];
  if (nums.some(x => Number(x) === n)) return true;
  const blob = [
    listing?.description,
    listing?.project_name,
    listing?.rooms_offered,
    typeof listing?.general_details === 'string'
      ? listing.general_details
      : listing?.general_details
        ? JSON.stringify(listing.general_details)
        : '',
  ]
    .filter(Boolean)
    .join(' ');
  return new RegExp(`(?:^|\\D)${n}(?:\\.0+)?\\s*-?\\s*חדר`).test(blob);
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
  const publishers = listingPublisherName(listing);
  if (publishers.length) {
    put('publisher', publishers.join(', '), 80);
    put('company_name', publishers[0], 80);
  }
  put(
    'subscriber_number',
    listingSubscriberNumber(listing) || listing.subscriber_number,
    20,
  );
  // חדש מקבלן ads price/size each unit type separately — send them all so a
  // "עד 2 מיליון" or "100 מ״ר" query can match on any single offer.
  const offerPrices = projectOfferNumbers(listing, '_price');
  put('price', offerPrices.length ? offerPrices.join('/') : listing.price, 80);
  put('budget', listing.budget, 20);
  put('price_per_night', listing.price_per_night, 20);
  const offered = projectOfferRoomTypes(listing);
  if (offered.labels.length) {
    put('rooms_offered', offered.labels.join(', '), 80);
  } else {
    put('rooms_offered', listing.rooms_offered, 80);
  }
  if (offered.roomNums.length) {
    put('rooms', offered.roomNums.join(','), 20);
  } else {
    put('rooms', listing.rooms, 20);
  }
  const offerAreas = projectOfferNumbers(listing, '_area');
  put('area', offerAreas.length ? offerAreas.join('/') : listing.area, 60);
  put('floor', listing.floor, 10);
  put(
    'search_purpose',
    listing.search_purpose || listing.searchPurposeKey,
    20,
  );
  put('condition', listing.condition, 30);
  put('construction_status', listing.construction_status, 30);
  if (catNum === 1) {
    put('new_from_contractor', 'חדש מקבלן דירה חדשה', 40);
  }
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
  put('amenities', amenitiesText(listing), 200);
  const descExtra = [];
  for (const name of publishers) descExtra.push(`חברת ${name}`);
  const subForDesc = listingSubscriberNumber(listing);
  if (subForDesc) descExtra.push(subForDesc);
  if (offered.labels.length) descExtra.push(offered.labels.join(', '));
  const descBase =
    listing.description != null ? String(listing.description).trim() : '';
  put('description', [descBase, ...descExtra].filter(Boolean).join(' · '), 400);

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
  publisher: 80,
  company_name: 80,
  subscriber_number: 20,
  price: 80,
  budget: 20,
  price_per_night: 20,
  rooms: 20,
  rooms_offered: 80,
  area: 60,
  floor: 10,
  search_purpose: 20,
  condition: 30,
  construction_status: 30,
  new_from_contractor: 40,
  permit: 30,
  hospitality_nature: 40,
  service_facility: 40,
  preferred_gender: 20,
  preferred_apartment_type: 40,
  preferred_age_min: 6,
  preferred_age_max: 6,
  preferences: 120,
  amenities: 200,
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

const HE_ROOM_WORDS = {
  שלושה: 3,
  שלוש: 3,
  שלושת: 3,
  ארבעה: 4,
  ארבע: 4,
  חמישה: 5,
  חמש: 5,
  שישה: 6,
  שש: 6,
  שני: 2,
  שתיים: 2,
  שתי: 2,
};

function inferRoomsFromQuery(query) {
  const q = String(query || '').trim().toLowerCase();
  const withNoun = q.match(/(\d+(?:\.\d+)?)\s*-?\s*חדר/);
  if (withNoun) {
    const n = Number(withNoun[1]);
    if (Number.isFinite(n) && n > 0 && n < 20) return n;
  }
  for (const [word, n] of Object.entries(HE_ROOM_WORDS)) {
    if (new RegExp(`${word}\\s*חדר`).test(q) || q.includes(`${word} חדרים`)) {
      return n;
    }
  }
  return null;
}

/** Keep in sync with pi-front/utils/piAiMatchListings.js */
function normalizeHebrewQuery(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u0591-\u05c7]/g, '')
    .replace(/["'״׳]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM_RE = '(\\d[\\d,]*(?:\\.\\d+)?)';
const MONEY_UNIT_RE = '(מיליון|מליון|אלף|אלפים|k)';
const CURRENCY_RE = '(?:₪|שח|שקלים|שקל)';
/** A number is only read as money when a unit or a currency follows it. */
const MONEY_RE = `${NUM_RE}\\s*(?:${MONEY_UNIT_RE}\\s*(?:${CURRENCY_RE})?|${CURRENCY_RE})`;
/** normalizeHebrewQuery strips quotes, so מ"ר and מ״ר both arrive as מר. */
const SQM_RE = '(?:מר|מ2|sqm|מטר(?:ים)?(?:\\s*(?:רבוע(?:ים)?|מרובע(?:ים)?))?)';

function toPlainNumber(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function moneyValue(numStr, unitStr) {
  const n = toPlainNumber(numStr);
  if (n == null) return null;
  const unit = String(unitStr || '');
  if (/מיליון|מליון/.test(unit)) return n * 1000000;
  if (/אלף|אלפים|k/.test(unit)) return n * 1000;
  return n;
}

function boundedRange(min, max) {
  const lo = Number.isFinite(min) ? min : null;
  const hi = Number.isFinite(max) ? max : null;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null && lo > hi) return {min: hi, max: lo};
  return {min: lo, max: hi};
}

/** "בין 80 ל-100 מ״ר" · "עד 120 מ״ר" · "מעל 90 מ״ר" · "100 מ״ר" */
function inferAreaFromQuery(q) {
  const span = q.match(
    new RegExp(`בין\\s*${NUM_RE}\\s*(?:ל|עד|לבין)\\s*-?\\s*${NUM_RE}\\s*${SQM_RE}`),
  );
  if (span) {
    const lo = toPlainNumber(span[1]);
    const hi = toPlainNumber(span[2]);
    if (lo != null && hi != null) return boundedRange(lo, hi);
  }
  const upTo = q.match(
    new RegExp(`(?:עד|מקסימום|לא יותר מ|פחות מ)\\s*-?\\s*${NUM_RE}\\s*${SQM_RE}`),
  );
  if (upTo) {
    const v = toPlainNumber(upTo[1]);
    if (v != null) return boundedRange(null, v);
  }
  const from = q.match(
    new RegExp(
      `(?:מעל|לפחות|יותר מ|החל מ|מינימום)\\s*-?\\s*${NUM_RE}\\s*${SQM_RE}`,
    ),
  );
  if (from) {
    const v = toPlainNumber(from[1]);
    if (v != null) return boundedRange(v, null);
  }
  const bare = q.match(new RegExp(`${NUM_RE}\\s*${SQM_RE}`));
  if (bare) {
    const v = toPlainNumber(bare[1]);
    // A plain "100 מ״ר" is an approximation, not a spec — keep a band.
    if (v != null && v > 0) {
      return {...boundedRange(Math.floor(v * 0.85), Math.ceil(v * 1.15)), about: v};
    }
  }
  return null;
}

/** "קומת קרקע" · "קומה 3" · "עד קומה 4" · "מקומה 5 ומעלה" */
function inferFloorFromQuery(q) {
  if (/קומת\s*קרקע/.test(q) || /קומה\s*0(?!\d)/.test(q)) {
    return boundedRange(0, 0);
  }
  const upTo = q.match(new RegExp(`(?:עד|מתחת ל|לא מעל)\\s*קומה\\s*${NUM_RE}`));
  if (upTo) {
    const v = toPlainNumber(upTo[1]);
    if (v != null) return boundedRange(null, v);
  }
  const fromUp = q.match(
    new RegExp(`מ?קומה\\s*${NUM_RE}\\s*(?:ומעלה|ומעל|והלאה)`),
  );
  if (fromUp) {
    const v = toPlainNumber(fromUp[1]);
    if (v != null) return boundedRange(v, null);
  }
  const above = q.match(new RegExp(`מעל\\s*קומה\\s*${NUM_RE}`));
  if (above) {
    const v = toPlainNumber(above[1]);
    if (v != null) return boundedRange(v + 1, null);
  }
  const exact = q.match(new RegExp(`קומה\\s*${NUM_RE}`));
  if (exact) {
    const v = toPlainNumber(exact[1]);
    if (v != null) return boundedRange(v, v);
  }
  return null;
}

/** "עד 2 מיליון" · "בין 1.5 ל-2 מיליון" · "מעל 850 אלף" · "5000 ש״ח" */
function inferPriceFromQuery(q) {
  const span = q.match(
    new RegExp(
      `בין\\s*${NUM_RE}\\s*${MONEY_UNIT_RE}?\\s*(?:${CURRENCY_RE})?\\s*(?:ל|עד|לבין)\\s*-?\\s*${MONEY_RE}`,
    ),
  );
  if (span) {
    const hi = moneyValue(span[3], span[4]);
    // "בין 1.5 ל-2 מיליון": the unit is stated once, at the end.
    const lo = moneyValue(span[1], span[2] || span[4]);
    if (lo != null && hi != null) return boundedRange(lo, hi);
  }
  const upTo = q.match(
    new RegExp(
      `(?:עד|מקסימום|לא יותר מ|פחות מ|מתחת ל|תקציב(?:\\s*של)?)\\s*-?\\s*${MONEY_RE}`,
    ),
  );
  if (upTo) {
    const v = moneyValue(upTo[1], upTo[2]);
    if (v != null) return boundedRange(null, v);
  }
  const from = q.match(
    new RegExp(`(?:מעל|לפחות|יותר מ|החל מ)\\s*-?\\s*${MONEY_RE}`),
  );
  if (from) {
    const v = moneyValue(from[1], from[2]);
    if (v != null) return boundedRange(v, null);
  }
  const bare = q.match(new RegExp(MONEY_RE));
  if (bare) {
    const v = moneyValue(bare[1], bare[2]);
    // A bare budget reads as a ceiling; leave a little headroom.
    if (v != null) return {...boundedRange(null, Math.round(v * 1.1)), about: v};
  }
  return null;
}

/** Amenities the query explicitly asks for (never the "בלי מעלית" case). */
const AMENITY_QUERY_RULES = [
  {
    id: 'parking',
    label: 'חניה',
    ask: 'חני(?:ה|יה|ות|ון)',
    keys: ['חני', 'parking'],
  },
  {id: 'elevator', label: 'מעלית', ask: 'מעלית', keys: ['מעלית', 'elevator']},
  {id: 'balcony', label: 'מרפסת', ask: 'מרפס', keys: ['מרפס', 'balcony']},
  {
    id: 'mamad',
    label: 'ממ"ד',
    ask: 'ממד|מרחב מוגן',
    keys: ['ממד', 'mamad', 'מרחב מוגן'],
  },
];

function inferAmenitiesFromQuery(q) {
  const out = [];
  for (const rule of AMENITY_QUERY_RULES) {
    if (!new RegExp(rule.ask).test(q)) continue;
    if (new RegExp(`(?:בלי|ללא)\\s+(?:${rule.ask})`).test(q)) continue;
    out.push(rule);
  }
  return out.length ? out : null;
}

/** Splits the "/"-joined lists the summary uses for חדש מקבלן unit types. */
function numericListValues(raw) {
  if (raw == null || raw === '') return [];
  return String(raw)
    .split(/[/|;]/)
    .map(part => Number(String(part).replace(/,/g, '').trim()))
    .filter(n => Number.isFinite(n) && n > 0);
}

function listingAreaValues(item) {
  return [
    ...numericListValues(item?.area),
    ...projectOfferNumbers(item, '_area'),
  ];
}

function listingPriceValues(item) {
  return [
    ...numericListValues(item?.price),
    ...numericListValues(item?.budget),
    ...numericListValues(item?.price_per_night),
    ...projectOfferNumbers(item, '_price'),
  ];
}

function listingFloorValues(item) {
  const raw = item?.floor;
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (/קרקע|ground/i.test(s)) return [0];
  return (s.match(/-?\d+(?:\.\d+)?/g) || [])
    .map(Number)
    .filter(n => Number.isFinite(n));
}

/**
 * No value on the ad → keep it and let Gemini judge; a value outside the
 * requested range → drop it. Dropping silent ads would gut the results,
 * since plenty of listings never fill in area or floor.
 */
function valuesFitRange(values, range) {
  if (!range) return true;
  if (!values.length) return true;
  return values.some(
    v =>
      (range.min == null || v >= range.min) &&
      (range.max == null || v <= range.max),
  );
}

/** true / false / null when the ad simply does not mention it. */
function listingHasAmenity(item, keys) {
  const hit = text => {
    const norm = normalizeHebrewQuery(text);
    return keys.some(k => norm.includes(k));
  };
  const a = parseAmenities(item?.amenities);
  if (Array.isArray(a)) {
    return a.some(x => hit(String(x || '')));
  }
  if (a && typeof a === 'object') {
    let mentioned = false;
    for (const [key, value] of Object.entries(a)) {
      if (!hit(key)) continue;
      mentioned = true;
      if (value === true || value === 'true' || value === 'כן') return true;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return true;
    }
    return mentioned ? false : null;
  }
  if (typeof a === 'string' && a.trim()) return hit(a);
  return null;
}

/** Hard query constraints so Gemini cannot pad with unrelated types. */
function inferPiAiQueryConstraints(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const norm = normalizeHebrewQuery(q);
  // "קומת קרקע" is a floor, not a land ad — drop it before the type keywords.
  const typeQ = q.replace(/קומת\s*קרקע/g, ' ');
  let cats = null;
  if (/שותפ/.test(typeQ)) cats = ['3'];
  else if (/(?:צימר|\bbnb\b|לינה)/i.test(typeQ)) cats = ['5'];
  else if (/משרד/.test(typeQ)) cats = ['2'];
  else if (/(?:מגרש|קרקע|גוש|חלקה)/.test(typeQ)) cats = ['7'];
  else if (/מסחר/.test(typeQ)) cats = ['8'];
  else if (/(?:דיר|בית|יוקר|פנטהאוז)/.test(typeQ)) cats = HOME_CATS;

  let purpose = null;
  const rent = /להשכרה|לשכור|שכירות|השכרה/.test(q);
  const sale = /למכירה|לקנות|קנייה|קניה/.test(q);
  if (rent && !sale) purpose = 'rent';
  else if (sale && !rent) purpose = 'sale';

  return {
    cats,
    purpose,
    rooms: inferRoomsFromQuery(q),
    area: inferAreaFromQuery(norm),
    floor: inferFloorFromQuery(norm),
    price: inferPriceFromQuery(norm),
    amenities: inferAmenitiesFromQuery(norm),
  };
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
  if (constraints.rooms != null) {
    if (!listingOffersRoomCount(item, constraints.rooms)) return false;
  }
  if (!valuesFitRange(listingAreaValues(item), constraints.area)) return false;
  if (!valuesFitRange(listingFloorValues(item), constraints.floor)) return false;
  if (!valuesFitRange(listingPriceValues(item), constraints.price)) return false;
  if (constraints.amenities) {
    for (const rule of constraints.amenities) {
      if (listingHasAmenity(item, rule.keys) === false) return false;
    }
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
- Company / חדש מקבלן (category 1) ads list unit types in rooms_offered (e.g. "3 חדרים"). Match room-count queries to rooms_offered, not a dummy rooms=1.
- area is מ"ר, price is ₪, floor is קומה. On חדש מקבלן ads area and price are "/"-separated, one value per unit type — matching any single value counts.
- Honour explicit numbers: "עד X" is a ceiling, "מעל X" / "לפחות X" a floor, "בין X ל-Y" a range. Applies to מ"ר, קומה and מחיר/תקציב alike. "קומת קרקע" means floor 0.
- Treat a bare size like "100 מ\"ר" as approximate (±15%), and a bare budget as a ceiling.
- Requested features (מעלית, חניה, מרפסת, ממ"ד) live in the amenities field — do not return ads that lack a feature the query asked for.
- "דירה חדשה" / חדשה → prefer category 1 חדש מקבלן (new_from_contractor).
- "חברת X" / company name matches publisher, company_name, or subscriber_number.
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
