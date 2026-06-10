/**
 * Sign in as a user on the Android emulator by writing pi_current_user to RKStorage.
 * Usage: node scripts/set-emulator-current-user.js <email> <password>
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execSync, spawnSync} = require('child_process');

const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';

if (!email || !password) {
  console.error('Usage: node scripts/set-emulator-current-user.js <email> <password>');
  process.exit(1);
}

const apiBase = process.env.EXPO_PUBLIC_API_URL_ANDROID || 'http://127.0.0.1:3001';

async function login() {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email, password}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || !data.subscription) {
    throw new Error(data.error || `Login failed (${res.status})`);
  }
  return data.subscription;
}

function adb(cmd) {
  return execSync(`adb ${cmd}`, {encoding: 'utf8'});
}

function pullDb(localPath) {
  const buf = execSync(
    'adb exec-out run-as com.pi.frontend cat /data/data/com.pi.frontend/databases/RKStorage',
    {encoding: 'buffer', maxBuffer: 20 * 1024 * 1024},
  );
  fs.writeFileSync(localPath, buf);
}

function pushDb(localPath) {
  execSync(`adb push "${localPath}" /data/local/tmp/RKStorage`, {stdio: 'inherit'});
  adb('shell run-as com.pi.frontend cp /data/local/tmp/RKStorage /data/data/com.pi.frontend/databases/RKStorage');
}

function writeUserToDb(dbPath, user) {
  const py = `
import json, sqlite3
db = sqlite3.connect(r"""${dbPath.replace(/\\/g, '\\\\')}""")
user = json.loads(r'''${JSON.stringify(user).replace(/'/g, "\\'")}''')
db.execute("CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
db.execute("INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES (?, ?)", ("pi_current_user", json.dumps(user, ensure_ascii=False)))
db.commit()
db.close()
print("ok")
`;
  const r = spawnSync('python', ['-c', py], {encoding: 'utf8'});
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || 'sqlite write failed');
  }
}

(async () => {
  try {
    adb('devices');
  } catch {
    console.error('No adb / emulator found');
    process.exit(1);
  }

  const subscription = await login();
  const user = {
    ...subscription,
    id: subscription.id,
    subscription_type: subscription.subscription_type || 'user',
    email: subscription.email || email,
    name: subscription.name || null,
    phone: subscription.phone || null,
    profile_picture_url: subscription.profile_picture_url || null,
    status: subscription.status || 'verified',
  };

  const localDb = path.join(os.tmpdir(), 'pi-rkstorage-write.db');
  pullDb(localDb);
  writeUserToDb(localDb, user);
  pushDb(localDb);

  try {
    adb('shell am force-stop com.pi.frontend');
    adb('reverse tcp:3001 tcp:3001');
    adb('shell monkey -p com.pi.frontend -c android.intent.category.LAUNCHER 1');
  } catch (_) {}

  console.log('Signed in on emulator as:');
  console.log('  email:', user.email);
  console.log('  name:', user.name);
  console.log('  type:', user.subscription_type);
  console.log('  id:', user.id);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
