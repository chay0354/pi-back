require('dotenv').config();
const {
  buildPiAiListingSummary,
  sanitizePiAiPoolItem,
} = require('../utils/piAiListingSummary');

const BASE = process.argv[2] || 'http://localhost:3011';

const CASES = [
  {
    query: 'דירה למכירה בתל אביב',
    check: l => {
      const blob = `${l.address || ''} ${l.project_name || ''} ${l.description || ''}`;
      if (!blob.includes('תל אביב') && !/tel aviv/i.test(blob)) {
        return `not Tel Aviv: ${l.address}`;
      }
      if (!['1', '6', '10', '12'].includes(String(l.category))) {
        return `cat ${l.category} not apartment`;
      }
      return null;
    },
  },
  {
    query: 'משרד להשכרה',
    check: l =>
      String(l.category) === '2' ? null : `cat ${l.category} not office`,
  },
  {
    query: 'קרקע למכירה',
    check: l =>
      String(l.category) === '7' ? null : `cat ${l.category} not land`,
  },
];

function isFeedPost(listing) {
  if (listing?.feed_post === true || listing?.feed_post === 'true') return true;
  const d = String(listing?.description || '').trim().toLowerCase();
  return d === 'פוסט' || d === 'post';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const res = await fetch(`${BASE}/api/listings?status=published`);
  if (!res.ok) throw new Error(`listings ${res.status}`);
  const listings = ((await res.json())?.listings || []).filter(
    l => l && !isFeedPost(l),
  );
  const byId = new Map(listings.map(l => [String(l.id), l]));
  console.log(`Published ads: ${listings.length}  base=${BASE}\n`);

  let fail = 0;
  for (let i = 0; i < CASES.length; i++) {
    const {query, check} = CASES[i];
    if (i) await sleep(5000);
    const summaries = listings
      .map(l => sanitizePiAiPoolItem(buildPiAiListingSummary(l)))
      .filter(Boolean);
    const r = await fetch(`${BASE}/api/ai/pi-search`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, listings: summaries}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) {
      console.log(`FAIL "${query}" HTTP ${r.status} ${data.error || ''}`);
      fail++;
      continue;
    }
    const ids = data.ids || [];
    const problems = [];
    for (const id of ids) {
      const l = byId.get(String(id));
      if (!l) {
        problems.push(`unknown id ${id}`);
        continue;
      }
      const err = check(l);
      if (err) problems.push(err);
    }
    const sample = ids.slice(0, 3).map(id => {
      const l = byId.get(String(id));
      return l
        ? `[${l.category}] ${(l.address || l.project_name || '').slice(0, 50)}`
        : id;
    });
    if (problems.length) {
      console.log(`FAIL "${query}" model=${data.model} n=${ids.length}`);
      problems.slice(0, 5).forEach(p => console.log(`  - ${p}`));
      fail++;
    } else {
      console.log(
        `OK   "${query}" model=${data.model || data.source} n=${ids.length}` +
          (sample.length ? `\n     ${sample.join(' | ')}` : ' (empty)'),
      );
    }
  }
  console.log(fail ? `\n${fail}/${CASES.length} failed` : `\nAll ${CASES.length} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
