/**
 * Apply mixed-language text fixes to seed scripts (does not touch DB).
 * Run: node scripts/apply-text-fixes-to-seeds.js
 */
const fs = require('fs');
const path = require('path');
const {fixText} = require('./fix-mixed-language-ads');

const SEED_FILES = [
  'seed-chay-category-ads.js',
  'seed-regular-user-bnb-partners.js',
];

function fixSeedFileContent(content) {
  return content.replace(/'([^'\\]|\\.)*'/g, match => {
    const inner = match.slice(1, -1);
    const fixed = fixText(inner);
    return fixed === inner ? match : `'${fixed}'`;
  });
}

for (const file of SEED_FILES) {
  const filePath = path.join(__dirname, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = fixSeedFileContent(original);
  if (updated === original) {
    console.log(`No changes: ${file}`);
    continue;
  }
  fs.writeFileSync(filePath, updated, 'utf8');
  console.log(`Updated: ${file}`);
}
