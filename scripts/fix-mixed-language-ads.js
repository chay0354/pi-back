/**
 * Fix ads with broken Hebrew/English mixed text (e.g. "קיסaria", "דuplex").
 * Run: node scripts/fix-mixed-language-ads.js
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

const REPLACEMENTS = [
  ['\u05E7\u05D9\u05E1aria', '\u05E7\u05D9\u05E1\u05E8\u05D9\u05D4'],
  ['\u05D5illa', '\u05D5\u05D9\u05DC\u05D4'],
  ['\u05D3uplex', '\u05D3\u05D5\u05E4\u05DC\u05E7\u05E1'],
  ['\u05D1egin', '\u05D1\u05D2\u05D9\u05DF'],
  ['\u05E4ituach', '\u05E4\u05D9\u05EA\u05D5\u05D7'],
  ['\u05E0issim', '\u05E0\u05D9\u05E1\u05D9\u05DD'],
  ['infiniti', '\u05D0\u05D9\u05E0\u05E4\u05D9\u05E0\u05D9\u05D8\u05D9'],
  ['home cinema', '\u05D7\u05D3\u05E8 \u05E7\u05D5\u05DC\u05E0\u05D5\u05E2 \u05D1\u05D9\u05EA\u05D9'],
  ['elevator prive', '\u05DE\u05E2\u05DC\u05D9\u05EA \u05E4\u05E8\u05D8\u05D9\u05EA'],
  ['smart home', '\u05D1\u05D9\u05EA \u05D7\u05DB\u05DD'],
  ['penthouse \u2014', '\u05E4\u05E0\u05D8\u05D4\u05D0\u05D5\u05D6 \u2014'],
  ['penthouse \u05D9\u05D9\u05D7\u05D5\u05D3\u05D9', '\u05E4\u05E0\u05D8\u05D4\u05D0\u05D5\u05D6 \u05D9\u05D9\u05D7\u05D5\u05D3\u05D9'],
  ['\u05DE\u05E8p\u05E1\u05D5\u05EA', '\u05DE\u05E8\u05E4\u05E1\u05D5\u05EA'],
  ['lev Tel Aviv', '\u05DC\u05D1 \u05EA\u05DC \u05D0\u05D1\u05D9\u05D1'],
  ['open space', '\u05D7\u05DC\u05DC \u05E4\u05EA\u05D5\u05D7'],
  ['\u05E4\u05DC\u05D5\u05E8al', '\u05D4\u05D0\u05E8\u05D2\u05DE\u05DF'],
  ['\u05D1\u05E4\u05DC\u05D5\u05E8al', '\u05D1\u05E8\u05D7\u05D5\u05D1 \u05D4\u05D0\u05E8\u05D2\u05DE\u05DF'],
  ['\u05D1\u05E8-\u05D0ilan', '\u05D1\u05E8-\u05D0\u05D9\u05DC\u05DF'],
  ['\u05DE\u05D9\u05D0mi', 'Miami'],
  [' \u05D1each', ' Beach'],
  ['\u05DCarnaca', '\u05DC\u05E8\u05E0\u05E7\u05D4'],
  ['\u05E4anoram\u05D9', '\u05E0\u05D5\u05E3 \u05E8\u05D7\u05D1 \u05E2\u05DC \u05D4\u05D9\u05DD'],
  ['\u05E1ofa bed', '\u05E1\u05E4\u05EA \u05E0\u05E4\u05EA\u05D7\u05EA'],
  ['retail / \u05E7af\u00E9', '\u05E7\u05DE\u05E2\u05D5\u05E0\u05D0\u05D5\u05EA / \u05D1\u05D9\u05EA \u05E7\u05E4\u05D4'],
  ['retail', '\u05E7\u05DE\u05E2\u05D5\u05E0\u05D0\u05D5\u05EA'],
  ['\u05E7af\u00E9', '\u05D1\u05D9\u05EA \u05E7\u05E4\u05D4'],
  ['\u05DEoffice', '\u05DE\u05E9\u05E8\u05D3'],
  [
    'agriculture / ecotourism',
    '\u05D7\u05E7\u05DC\u05D0\u05D5\u05EA / \u05EA\u05D9\u05D9\u05E8\u05D5\u05EA \u05D0\u05E7\u05D5\u05DC\u05D5\u05D2\u05D9\u05EA',
  ],
  ['business traveler', '\u05E0\u05D5\u05E1\u05E2\u05D9 \u05E2\u05E1\u05E7\u05D9\u05DD'],
  ['concierge', '\u05E7\u05D5\u05E0\u05E1\u05D9\u05D9\u05E8\u05D6\''],
  ['\u05EA programs', '\u05EA\u05D5\u05DB\u05E0\u05D9\u05D5\u05EA'],
  ['\u05D3izengoff', '\u05D3\u05D9\u05D6\u05E0\u05D2\u05D5\u05E3'],
  ['\u05D3\u05D9\u05D6engoff', '\u05D3\u05D9\u05D6\u05E0\u05D2\u05D5\u05E3'],
  ['\u05DEchon', '\u05DE\u05D8\u05D1\u05D7'],
  ['\u05E8aanana', '\u05E8\u05E2\u05E0\u05E0\u05D4'],
  ['\u05D1atei midrash', '\u05D9\u05E9\u05D9\u05D1\u05D5\u05EA'],
  ['\u05E8amot', '\u05E8\u05E2\u05DE\u05D5\u05EA'],
  ['\u05DCsalon', '\u05DC\u05E1\u05D0\u05DC\u05D5\u05DF'],
  ['\u05D1en Gurion', '\u05D1\u05DF \u05D2\u05D5\u05E8\u05D9\u05D5\u05DF'],
  ['\u05D1en Yehuda', '\u05D1\u05DF \u05D9\u05D4\u05D5\u05D3\u05D4'],
  ['\u05D3\u05D5\u05E0am', '\u05D3\u05D5\u05E0\u05DD'],
  ['\u05D1niin', '\u05D1\u05E0\u05D9\u05D9\u05DF'],
  ['\u05D2olan', '\u05D2\u05D5\u05DC\u05DF'],
  ['\u05E8\u05DE\u05EA \u05D4\u05D4\u05D2\u05D5\u05DC\u05DF', '\u05E8\u05DE\u05EA \u05D4\u05D2\u05D5\u05DC\u05DF'],
  ['\u05D7\u05E0ania', '\u05D7\u05E0\u05E0\u05D9\u05D4'],
  ['\u05DBinert', '\u05D4\u05DB\u05E0\u05E8\u05EA'],
  ['\u05DBbish', '\u05DB\u05D1\u05D9\u05E9'],
  ['\u05DB\u05D1ish', '\u05DB\u05D1\u05D9\u05E9'],
  ['\u05DE\u05D5\u05D3\u05D9\u05E2in', '\u05DE\u05D5\u05D3\u05D9\u05E2\u05D9\u05DF'],
  ['\u05E9apirim', '\u05E9\u05E4\u05D9\u05E8\u05D9\u05DD'],
  ['\u05D1\u05D9alik', '\u05D1\u05D9\u05D0\u05DC\u05D9\u05E7'],
  ['\u05E4lorentin', '\u05E4\u05DC\u05D5\u05E8\u05E0\u05D8\u05D9\u05DF'],
  ['\u05D9ehuda ha-Levi', '\u05D9\u05D4\u05D5\u05D3\u05D4 \u05D4\u05DC\u05D5\u05D9'],
  ['\u05E1okolov', '\u05E1\u05D5\u05E7\u05D5\u05DC\u05D5\u05D1'],
  ['\u05E1tudio', '\u05E1\u05D8\u05D5\u05D3\u05D9\u05D5'],
  ['\u05E1alon', '\u05E1\u05DC\u05D5\u05DF'],
  [
    '\u05D3\u05D9\u05E8\u05EA \u05D4\u05E9\u05E7\u05E2\u05D4 \u2014 \u05DE\u05D9\u05D0\u05DE\u05D9 \u05D1each',
    '\u05D3\u05D9\u05E8\u05EA \u05D4\u05E9\u05E7\u05E2\u05D4 \u2014 Miami Beach',
  ],
  [
    '\u05DE\u05D7\u05E4\u05E9 \u05E9\u05D5\u05EA\u05E3 \u2014 \u05E4\u05DC\u05D5\u05E8al',
    '\u05DE\u05D7\u05E4\u05E9 \u05E9\u05D5\u05EA\u05E3 \u2014 \u05E8\u05D7\u05D5\u05D1 \u05D4\u05D0\u05E8\u05D2\u05DE\u05DF',
  ],
  ['\u05E8\u05D7\u05D5\u05D1 \u05E4\u05DC\u05D5\u05E8al', '\u05E8\u05D7\u05D5\u05D1 \u05D4\u05D0\u05E8\u05D2\u05DE\u05DF'],
  ['\u05D0chuzat \u05D1ait', '\u05D0\u05D7\u05D5\u05D6\u05EA \u05D1\u05D9\u05EA'],
  ['\u05D1\u05D9\u05EA \u05D7ch\u05DD', '\u05D1\u05D9\u05EA \u05D7\u05DB\u05DD'],
  ['\u05E8\u05D7b', '\u05E8\u05D7\u05D1'],
  ['\u05E1\u05E4\u05EA \u05E0\u05E4\u05EAch\u05EA', '\u05E1\u05E4\u05EA \u05E0\u05E4\u05EA\u05D7\u05EA'],
  ['\u05DC\u05E8\u05E0aca', '\u05DC\u05E8\u05E0\u05E7\u05D4'],
  ['\u05D3\u05D9\u05D6ngoff', '\u05D3\u05D9\u05D6\u05E0\u05D2\u05D5\u05E3'],
  ['\u05E4\u05DC\u05D5\u05E8entin', '\u05E4\u05DC\u05D5\u05E8\u05E0\u05D8\u05D9\u05DF'],
  ['\u05E4\u05DCorentin', '\u05E4\u05DC\u05D5\u05E8\u05E0\u05D8\u05D9\u05DF'],
  ['\u05DE\u05D9\u05D0\u05DE\u05D9 Beach', 'Miami Beach'],
  ['\u05DE\u05D8bch', '\u05DE\u05D8\u05D1\u05D7'],
  ['\u05E8\u05E2\u05E0ana', '\u05E8\u05E2\u05E0\u05E0\u05D4'],
  ['\u05D1\u05E0\u05D9in', '\u05D1\u05E0\u05D9\u05D9\u05DF'],
  ['\u05D0 ideal', '\u05D0\u05D9\u05D3\u05D9\u05D0\u05DC\u05D9'],
  [' \u2014 \u05D2\u05D5\u05DC\u05DF', ' \u2014 \u05D4\u05D2\u05D5\u05DC\u05DF'],
];

function fixText(value) {
  if (value == null || typeof value !== 'string' || !value.trim()) return value;
  let out = value;
  for (const [from, to] of REPLACEMENTS) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function fixContactDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const next = {...details};
  if (typeof next.address === 'string') next.address = fixText(next.address);
  if (typeof next.description === 'string') {
    next.description = fixText(next.description);
  }
  return next;
}

async function main() {
  const {data: ads, error} = await supabase
    .from('ads')
    .select('id, project_name, address, description, land_address, contact_details');

  if (error) {
    console.error('Fetch failed:', error.message);
    process.exit(1);
  }

  let updated = 0;
  for (const ad of ads || []) {
    const patch = {};
    const pn = fixText(ad.project_name);
    const addr = fixText(ad.address);
    const desc = fixText(ad.description);
    const land = fixText(ad.land_address);
    const contact = fixContactDetails(ad.contact_details);

    if (pn !== ad.project_name) patch.project_name = pn;
    if (addr !== ad.address) patch.address = addr;
    if (desc !== ad.description) patch.description = desc;
    if (land !== ad.land_address) patch.land_address = land;
    if (JSON.stringify(contact) !== JSON.stringify(ad.contact_details)) {
      patch.contact_details = contact;
    }

    if (!Object.keys(patch).length) continue;

    patch.updated_at = new Date().toISOString();
    const {error: upErr} = await supabase.from('ads').update(patch).eq('id', ad.id);
    if (upErr) {
      console.error(`Update ${ad.id} failed:`, upErr.message);
      continue;
    }
    updated += 1;
    console.log(`Fixed: ${pn || ad.project_name}`);
  }

  console.log(`Done. Updated ${updated} of ${(ads || []).length} ads.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {REPLACEMENTS, fixText, fixContactDetails};
