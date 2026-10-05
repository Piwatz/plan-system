// ขึ้นเว็บจริงบน Cloudflare (ตอน 14) รันในหน้าต่างคำสั่งของครูเต้ยเอง: node scripts/cloud-setup.js
//   1. เข้าบัญชี Cloudflare (wrangler login เปิดเบราว์เซอร์ให้กดอนุญาต)
//   2. สร้าง Hyperdrive ชื่อ plan-db ต่อฐาน Supabase แบบปิดการจำผลการอ่าน (ถามที่อยู่ฐานแบบไม่แสดงบนจอ) แล้วใส่ id ใน wrangler.jsonc
//   3. build แล้ว deploy พร้อมรหัสลับที่ยังไม่มีบน Cloudflare:
//      SESSION_SECRET สุ่มให้ · SETUP_TOKEN สุ่มให้ (แสดงบนจอและเก็บใน data-dev/production-setup-token.txt ไว้กรอกหน้าตั้งค่าครั้งแรก)
//      GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET GDRIVE_REFRESH_TOKEN อ่านจาก .dev.vars (ตั้งไว้แล้วตอน 10)
// รหัสลับไม่ขึ้นจอ ไม่เข้า Git · ไฟล์รหัสลับชั่วคราวสำหรับ deploy ลบทิ้งทันทีหลังใช้ · รันซ้ำได้ ขั้นที่ทำแล้วจะข้าม
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const ZERO_ID = '00000000000000000000000000000000';
const SECRETS = ['SESSION_SECRET', 'SETUP_TOKEN', 'GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN'];

// รันคำสั่ง wrangler · show = ให้เห็นและตอบคำถามบนจอได้ · ไม่ show = เก็บข้อความไว้อ่าน
function wrangler(args, { show = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let out = '';
    if (!show) {
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
    }
    p.on('close', (code) => resolve({ code, out }));
  });
}

// hidden = ไม่แสดงตัวอักษรที่วางบนจอ (แบบเดียวกับ scripts/google-auth.js)
async function ask(rl, label, hidden) {
  for (;;) {
    const write = rl._writeToOutput;
    if (hidden) rl._writeToOutput = (s) => (s.startsWith(label) ? write.call(rl, label) : s.includes('\n') ? write.call(rl, '\n') : undefined);
    const v = (await rl.question(label)).trim();
    rl._writeToOutput = write;
    if (hidden && v) console.log('  (ได้รับแล้ว ' + v.length + ' ตัวอักษร)');
    if (v) return v;
  }
}

function step(n, text) {
  console.log('');
  console.log(`== ขั้นที่ ${n} ${text} ==`);
}

async function login() {
  step(1, 'เข้าบัญชี Cloudflare');
  let who = await wrangler(['whoami']);
  if (/not authenticated/i.test(who.out)) {
    console.log('  เบราว์เซอร์จะเปิดหน้า Cloudflare ให้เข้าบัญชี แล้วกด Allow');
    await wrangler(['login'], { show: true });
    who = await wrangler(['whoami']);
  }
  if (/not authenticated/i.test(who.out)) throw new Error('ยังเข้าบัญชี Cloudflare ไม่สำเร็จ ลองรันใหม่อีกครั้ง');
  const email = (/associated with the email ([^\s]+)/i.exec(who.out) || [])[1];
  console.log(`  เข้าบัญชีแล้ว${email ? ' (' + email.replace(/\.$/, '') + ')' : ''}`);
}

// เปิดตัวรับข้อความเฉพาะตอนถาม (ตอน wrangler ถามเองบนจอ ต้องไม่มีตัวรับอื่นแย่งอ่านแป้นพิมพ์)
async function withPrompt(fn) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

// รหัสตั้งค่าครั้งแรกแบบพิมพ์ง่าย ไม่มีตัวที่สับสน (0 O 1 I L) เช่น K7PX-29QD-M4TB
function easyToken() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const s = Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

async function hyperdrive() {
  step(2, 'เชื่อมฐานข้อมูล Supabase ผ่าน Hyperdrive');
  let text = fs.readFileSync(CONFIG, 'utf8');
  if (!text.includes(ZERO_ID)) {
    console.log('  ตั้งไว้แล้ว ข้าม');
    return;
  }
  // มีชื่อ plan-db อยู่แล้ว (รันครั้งก่อนสร้างแล้วแต่ยังไม่ได้ใส่ id) ใช้ตัวเดิม
  const list = await wrangler(['hyperdrive', 'list']);
  let id = (new RegExp(`([0-9a-f]{32})[^\\n]*plan-db`).exec(list.out) || new RegExp(`plan-db[^\\n]*?([0-9a-f]{32})`).exec(list.out) || [])[1];
  while (!id) {
    console.log('  วางที่อยู่ฐานข้อมูลจาก Supabase (ปุ่ม Connect แบบ Direct connection ที่ใส่รหัสผ่านฐานแทน [YOUR-PASSWORD] แล้ว)');
    console.log('  (วางแล้วจะไม่เห็นตัวอักษรบนจอ เป็นเรื่องปกติ กด Enter ได้เลย)');
    const conn = await withPrompt((rl) => ask(rl, '  ที่อยู่ฐานข้อมูล: ', true));
    if (!/^postgres(ql)?:\/\/[^:]+:[^@]+@[^/]+\/\w+/.test(conn) || /YOUR-PASSWORD/i.test(conn)) {
      console.log('  รูปแบบไม่ถูกต้อง ต้องขึ้นต้นด้วย postgresql:// และใส่รหัสผ่านฐานแล้ว ลองวางใหม่');
      continue;
    }
    console.log('  กำลังสร้าง Hyperdrive (ปิดการจำผลการอ่าน) ...');
    const r = await wrangler(['hyperdrive', 'create', 'plan-db', `--connection-string=${conn}`, '--caching-disabled']);
    id = (/"id":\s*"([0-9a-f]{32})"/.exec(r.out) || /\b([0-9a-f]{32})\b/.exec(r.out) || [])[1];
    if (!id) {
      // ไม่แสดงข้อความเต็ม เผื่อมีรหัสผ่านติดมา
      const why = r.out.split('\n').find((l) => /error|failed|could not|unable/i.test(l)) || 'ไม่ทราบสาเหตุ';
      console.log('  สร้างไม่สำเร็จ: ' + why.replace(/postgres(ql)?:\/\/\S+/g, '[ที่อยู่ฐาน]').trim().slice(0, 300));
      console.log('  ถ้าต่อไม่ได้ ให้ใช้ที่อยู่แบบ Session pooler (ห้ามใช้ Transaction pooler) แล้ววางใหม่');
    }
  }
  text = fs.readFileSync(CONFIG, 'utf8').replace(ZERO_ID, id);
  fs.writeFileSync(CONFIG, text);
  console.log(`  เรียบร้อย ใส่ id ของ Hyperdrive ใน wrangler.jsonc แล้ว (${id.slice(0, 6)}...)`);
}

// ค่าใน .dev.vars (รหัส Google Drive)
function devVars() {
  const out = {};
  const f = path.join(ROOT, '.dev.vars');
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

async function deploy() {
  step(3, 'build แล้วขึ้นเว็บ');
  const listed = await wrangler(['secret', 'list', '--format', 'json']);
  let have = [];
  try {
    have = JSON.parse(listed.out.slice(listed.out.indexOf('['))).map((s) => s.name);
  } catch {
    have = []; // ยังไม่เคย deploy
  }
  const local = devVars();
  const secrets = {};
  let setupToken = '';
  for (const name of SECRETS) {
    if (have.includes(name)) continue;
    if (name === 'SESSION_SECRET') secrets[name] = crypto.randomBytes(32).toString('hex');
    else if (name === 'SETUP_TOKEN') secrets[name] = setupToken = easyToken();
    else if (local[name]) secrets[name] = local[name];
    else throw new Error(`ไม่พบ ${name} ใน .dev.vars (ตั้งค่า Google Drive ตอน 10 ก่อน: node scripts/google-auth.js)`);
  }
  console.log(`  รหัสลับที่จะใส่ครั้งนี้: ${Object.keys(secrets).join(' ') || 'ไม่มี (ใส่ไว้ครบแล้ว)'}`);

  require('./build-views').build({ quiet: true });
  const assets = require('./build-assets').build({ quiet: true });
  console.log(`  build แล้ว ไฟล์ static ${assets.count} ไฟล์ รุ่น ${assets.version}`);

  const tmp = path.join(os.tmpdir(), `plan-secrets-${crypto.randomBytes(6).toString('hex')}.json`);
  let code;
  try {
    const args = ['deploy'];
    if (Object.keys(secrets).length) {
      fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
      args.push('--secrets-file', tmp);
    }
    ({ code } = await wrangler(args, { show: true }));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (code !== 0) throw new Error('deploy ไม่สำเร็จ ดูข้อความด้านบน');
  if (setupToken) {
    const f = path.join(ROOT, 'data-dev', 'production-setup-token.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, setupToken + '\n');
    console.log('');
    console.log('  รหัสสำหรับตั้งค่าครั้งแรก (ใช้ครั้งเดียวตอนสร้างผู้ดูแลระบบ):');
    console.log('      ' + setupToken);
    console.log('  เก็บไว้ในไฟล์ data-dev/production-setup-token.txt ด้วย');
  }
}

async function main() {
  console.log('');
  console.log('  ขึ้นเว็บจริง ระบบส่งแผนการสอน (Cloudflare + Supabase)');
  try {
    await login();
    await hyperdrive();
    await deploy();
    console.log('');
    console.log('  เสร็จแล้ว ที่อยู่เว็บอยู่ในบรรทัดที่ลงท้ายด้วย workers.dev ด้านบน');
    console.log('  แจ้ง Claude ได้เลยว่าเสร็จแล้ว');
  } catch (e) {
    console.log('');
    console.log('  ' + e.message);
  } finally {
    console.log('');
    // เปิดในหน้าต่างของผู้ใช้ รอให้อ่านก่อนปิด · รันจากสคริปต์อื่น (ไม่มีแป้นพิมพ์) ไม่ต้องรอ
    if (process.stdin.isTTY) await withPrompt((rl) => rl.question('  กด Enter เพื่อปิดหน้าต่าง '));
  }
}

main();
