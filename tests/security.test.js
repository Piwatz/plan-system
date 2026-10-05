// ตอน 12: ความปลอดภัยเมื่อเปิดสู่อินเทอร์เน็ต (APP_ENV=production) ใช้ฐานชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-security-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.APP_ENV = 'production';
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.SETUP_TOKEN = 'test-setup-token-ทดสอบ';
// ตั้งโหมดทดลองไว้ด้วย เว็บจริงต้องไม่เปิดให้
process.env.DEMO = '1';

const db = require('../src/db');
const auth = require('../src/auth');
const config = require('../src/config');
const { createApp } = require('../src/app');

let server;
let base;
let host;

async function listen() {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
}

test.before(async () => {
  await db.open(':memory:');
  await listen();
});

test.after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// เบราว์เซอร์บนเว็บจริง: มาทาง https (ตัวรับคำขอเติม x-forwarded-proto) มี Origin และ IP จาก Cloudflare
class Client {
  constructor(ip = '203.0.113.10') {
    this.ip = ip;
    this.cookies = {};
  }
  async req(method, url, fields, headers = {}) {
    const cookie = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const h = { cookie, 'x-forwarded-proto': 'https', ...(this.ip ? { 'cf-connecting-ip': this.ip } : {}) };
    if (method !== 'GET') h.origin = base;
    Object.assign(h, headers);
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const res = await fetch(base + url, { method, redirect: 'manual', headers: h, body: fields ? new URLSearchParams(fields) : undefined });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, setCookie, text: await res.text() };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields, headers) {
    return this.req('POST', url, fields, headers);
  }
}

const SETUP = { school_name: 'โรงเรียนทดสอบ', full_name: 'ผู้ดูแลสมมติ', username: 'admin', password: 'admin-pass-1', password2: 'admin-pass-1' };
let admin;

test('เว็บจริงไม่มี SESSION_SECRET (หรือสั้นเกินไป) ไม่เปิดระบบ', () => {
  const keep = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    assert.throws(() => createApp(), /SESSION_SECRET/);
    process.env.SESSION_SECRET = 'short';
    assert.throws(() => createApp(), /SESSION_SECRET/);
  } finally {
    process.env.SESSION_SECRET = keep;
  }
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'secret.key')), false, 'เว็บจริงไม่สร้างไฟล์กุญแจเอง');
});

test('ตั้งค่าครั้งแรกต้องกรอก SETUP_TOKEN · cookie มี Secure · มี HSTS', async () => {
  const c = new Client();
  assert.equal((await c.get('/')).location, '/setup');
  const page = await c.get('/setup');
  assert.match(page.text, /name="setup_token"/);
  assert.match(page.text, /รหัสสำหรับตั้งค่าครั้งแรก/);
  assert.match(page.headers.get('strict-transport-security') || '', /max-age=31536000/);

  const none = await c.post('/setup', SETUP);
  assert.equal(none.status, 403);
  assert.match(none.text, /รหัสสำหรับตั้งค่าครั้งแรกไม่ถูกต้อง/);
  const wrong = await c.post('/setup', { ...SETUP, setup_token: 'เดาเอา' });
  assert.equal(wrong.status, 403);

  const keep = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  const unset = await c.post('/setup', { ...SETUP, setup_token: '' });
  process.env.SETUP_TOKEN = keep;
  assert.equal(unset.status, 403);
  assert.match(unset.text, /ระบบยังไม่ได้ตั้งรหัสสำหรับตั้งค่าครั้งแรก กรุณาติดต่อผู้ติดตั้งระบบ/);
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM users')).n, 0, 'ยังไม่มีผู้ใช้ถูกสร้าง');

  const ok = await c.post('/setup', { ...SETUP, setup_token: keep });
  assert.equal(ok.location, '/admin');
  const session = ok.setCookie.find((x) => x.startsWith('plan_session='));
  assert.ok(session, 'ได้ cookie เข้าระบบ');
  assert.match(session, /;\s*secure/i);
  assert.match(session, /;\s*httponly/i);
  admin = c;
  assert.equal((await admin.get('/admin')).status, 200);
});

test('เดา SETUP_TOKEN ผิดครบ 8 ครั้งถูกล็อก', async () => {
  // ทดสอบตัวนับกับกุญแจของหน้าตั้งค่า (ระบบมีผู้ใช้แล้ว หน้าตั้งค่าพาไปหน้าเข้าสู่ระบบ จึงเรียกตัวนับตรง)
  const keys = ['198.51.100.7|setup', 'user|setup'];
  await auth.clearFails(...keys);
  for (let i = 0; i < 7; i++) await auth.recordFail(...keys);
  assert.equal(await auth.isLocked(...keys), false);
  await auth.recordFail(...keys);
  assert.equal(await auth.isLocked(...keys), true);
  assert.equal(await auth.isLocked('198.51.100.8|setup', 'user|setup'), false, 'เครื่องอื่นยังไม่ล็อก รวมทุกเครื่องต้องถึง 20');
  await auth.clearFails(...keys);
});

test('เว็บจริงเปิดโหมดทดลองไม่ได้แม้ตั้ง DEMO=1', async () => {
  assert.equal(process.env.DEMO, '1');
  assert.equal(config.DEMO, false);
  assert.equal(config.FILE_STORE, 'local');
  const page = await new Client().get('/login');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-demo-user|data-demo-pass|demo1234/);
});

test('ฟอร์มจากเว็บอื่นถูกปฏิเสธ · เว็บจริงไม่มีทั้ง Origin และ Referer ก็ปฏิเสธ', async () => {
  const c = new Client();
  assert.equal((await c.post('/login', { username: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.post('/login', { username: 'x' }, { origin: null })).status, 403, 'ไม่มีทั้งคู่');
  assert.equal((await c.post('/login', { username: 'x' }, { origin: 'null' })).status, 403, 'Origin null ไม่มี Referer');
  assert.equal((await c.post('/login', { username: 'x' }, { origin: null, referer: 'https://evil.example/login' })).status, 403);
  // Safari รุ่นเก่าบางกรณีไม่ส่ง Origin แต่ส่ง Referer ของเว็บเดียวกัน ต้องผ่าน
  assert.equal((await c.post('/login', { username: '' }, { origin: null, referer: `${base}/login` })).status, 401);
  assert.equal((await c.post('/login', { username: '' })).status, 401, 'มี Origin ของเว็บเดียวกัน');
  // ท่อนไฟล์ PUT ก็ตรวจเหมือนกัน
  assert.equal((await c.req('PUT', '/upload/x', null, { origin: null })).status, 403);
});

async function addTeacher(username, password) {
  await db.q.run(
    "INSERT INTO users (username, password_hash, full_name, position, is_teacher, created_at) VALUES (?, ?, ?, 'ครู', 1, ?)",
    username,
    await auth.hashPassword(password),
    'ครูสมมติ ' + username,
    db.nowStr()
  );
}

test('ใส่รหัสผิด 8 ครั้งแล้วล็อก และยังล็อกหลังเปิดแอปใหม่ (ตัวนับอยู่ในฐานข้อมูล)', async () => {
  await addTeacher('teacher1', 'right-pass');
  const a = new Client('203.0.113.20');
  for (let i = 0; i < 8; i++) {
    const r = await a.post('/login', { username: 'Teacher1', password: 'wrong' });
    assert.equal(r.status, 401);
    assert.match(r.text, /รหัสผ่านไม่ถูกต้อง/);
  }
  const locked = await a.post('/login', { username: 'teacher1', password: 'right-pass' });
  assert.equal(locked.status, 401);
  assert.match(locked.text, /ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ 10 นาที/);
  const rows = await db.q.all("SELECT key, count FROM login_attempts WHERE key LIKE '%teacher1' ORDER BY key");
  assert.deepEqual(
    rows.map((r) => [r.key, r.count]),
    [
      ['203.0.113.20|teacher1', 8],
      ['user|teacher1', 8],
    ]
  );

  // เครื่องอื่นยังเข้าได้ (ล็อกต่อเครื่อง 8 ครั้ง รวมทุกเครื่อง 20 ครั้ง)
  assert.equal((await new Client('203.0.113.21').post('/login', { username: 'teacher1', password: 'right-pass' })).location, '/');
  // เข้าสำเร็จจากเครื่องอื่น ล้างตัวนับของเครื่องนั้นกับตัวนับรวม แต่เครื่องที่เดายังล็อก

  // เปิดแอปใหม่ (เหมือน Workers ที่ไม่มีหน่วยความจำค้าง) ยังล็อกอยู่
  server.close();
  await listen();
  const again = await new Client('203.0.113.20').post('/login', { username: 'teacher1', password: 'right-pass' });
  assert.match(again.text, /ใส่รหัสผ่านผิดหลายครั้ง/);

  // หมดเวลา 10 นาทีแล้วเข้าได้ และงานรายชั่วโมงล้างแถวที่หมดอายุ
  await db.q.run("UPDATE login_attempts SET first_at = first_at - 600001 WHERE key LIKE '%teacher1'");
  await auth.cleanupAttempts();
  assert.equal((await db.q.get("SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE '%teacher1'")).n, 0);
  assert.equal((await new Client('203.0.113.20').post('/login', { username: 'teacher1', password: 'right-pass' })).location, '/');
});

test('ผิดรวมทุกเครื่อง 20 ครั้ง ล็อกชื่อนั้น · ไม่รู้ IP ไม่ล็อกต่อเครื่อง (กันคนนอกล็อกชื่อคนอื่นด้วย 8 ครั้ง)', async () => {
  await addTeacher('teacher2', 'right-pass');
  for (let i = 0; i < 8; i++) await new Client(null).post('/login', { username: 'teacher2', password: 'wrong' });
  assert.equal((await new Client(null).post('/login', { username: 'teacher2', password: 'right-pass' })).location, '/', 'ไม่มี IP ผิด 8 ครั้งยังไม่ล็อก');
  for (let i = 0; i < 20; i++) await new Client(`203.0.113.${100 + i}`).post('/login', { username: 'teacher2', password: 'wrong' });
  assert.match((await new Client('203.0.113.99').post('/login', { username: 'teacher2', password: 'right-pass' })).text, /ใส่รหัสผ่านผิดหลายครั้ง/);
});

test('ตัวนับพร้อมกันหลายคำขอไม่นับหาย', async () => {
  const key = 'user|พร้อมกัน';
  await Promise.all(Array.from({ length: 10 }, () => auth.recordFail(key)));
  assert.equal((await db.q.get('SELECT count FROM login_attempts WHERE key = ?', key)).count, 10);
});

test('หน้าเว็บไม่ได้รับรหัส LINE ได้แค่รู้ว่าตั้งไว้แล้ว', async () => {
  await db.setSetting('line_token', 'LINE-SECRET-ห้ามหลุด-123');
  const page = await admin.get('/admin/features');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /LINE-SECRET/);
  assert.match(page.text, /บันทึกไว้แล้ว เว้นว่างไว้ถ้าไม่เปลี่ยน/);
  await db.setSetting('line_token', '');
  assert.match((await admin.get('/admin/features')).text, /วางรหัสจาก LINE Developers/);
});

test('สคริปต์ปิดประตู Supabase ปิดครบทุกตาราง (จำลองบทบาท anon และ authenticated บน PGlite)', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'supabase-lockdown.sql'), 'utf8');
  const i = sql.indexOf('-- ตรวจผล');
  assert.ok(i > 0, 'มีคำสั่งตรวจผลท้ายไฟล์');
  await db.q.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  `);
  const before = await db.q.all(sql.slice(i));
  const tables = await db.q.all("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(before.length, tables.length, 'ก่อนรัน ทุกตารางเปิดอยู่');
  assert.ok(tables.some((t) => t.tablename === 'login_attempts'));
  await db.q.exec(sql.slice(0, i));
  assert.deepEqual(await db.q.all(sql.slice(i)), [], 'หลังรัน ไม่มีตารางที่ยังเปิด');
});
