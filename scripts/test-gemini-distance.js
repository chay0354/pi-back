require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ORIGIN = { latitude: 32.159723, longitude: 34.795447 };
const DESTINATION = 'רחוב מוריה 22, חיפה';
const PORT = process.env.PORT || 3001;

async function testApiEndpoint() {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/ai/distance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: ORIGIN,
      destinationAddress: DESTINATION,
    }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text.slice(0, 200) };
  }
  console.log('\n=== API /api/ai/distance ===');
  console.log('HTTP', response.status);
  console.log(JSON.stringify(data, null, 2));
  return data;
}

(async () => {
  console.log('Phone (latest fused GPS):', ORIGIN);
  console.log('Location: יורדי ים, הרצליה פיתוח, הרצליה');
  console.log('Ad address:', DESTINATION);
  await testApiEndpoint();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
