// ตอน 13: ส่วนที่ใช้เฉพาะบน Cloudflare Workers ทดสอบบน Node
// ตัวต่อฐานแบบทีละคำขอ (Hyperdrive) ต่อ PGlite ผ่านเซิร์ฟเวอร์ Postgres จำลอง · งานตามเวลา · ข้อความบนจอแบบคลาวด์ · IP จาก CF-Connecting-IP
// ใช้ฐานชั่วคราวในหน่วยความจำ ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-workers-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.SESSION_SECRET = 'test-session-secret-workers-0123456789';

const db = require('../src/db');
const { q } = db;
const config = require('../src/config');
const jobs = require('../src/jobs');
const { createApp } = require('../src/app');

let pg;
let pgServer;
let server;
let base;

// สลับให้โค้ดเห็นว่ารันบน Workers (config.WORKERS อ่าน navigator.userAgent ทุกครั้งที่ใช้)
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function onWorkers(on) {
  if (on) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  else if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
}

const active = () => pgServer.getStats().activeConnections;
// การปิดการเชื่อมต่อเกิดหลังส่งคำตอบ รอให้เซิร์ฟเวอร์จำลองนับจำนวนใหม่
async function settle(n = 0) {
  for (let i = 0; i < 50 && active() !== n; i++) await new Promise((r) => setTimeout(r, 20));
  return active();
}

test.before(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  pg = await PGlite.create({ extensions: { pgcrypto } });
  const port = 40000 + Math.floor(Math.random() * 20000);
  // รับได้ 3 การเชื่อมต่อ ถ้าตัวต่อไม่ปิดหลังจบคำขอ คำขอที่ 4 จะค้าง
  pgServer = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 3 });
  await pgServer.start();
  db.openWorkers(() => `postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  await db.withScope(() => db.migrate());
  onWorkers(true);
  server = createApp({ assetVersion: 'build123' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  onWorkers(false);
  server.close();
  await pgServer.stop();
  await pg.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

class Client {
  constructor() {
    this.cookies = {};
  }
  async req(method, url, body, headers = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie, ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields, headers) {
    return this.req('POST', url, new URLSearchParams(fields), headers);
  }
}

test('ตัวต่อฐานบน Workers: เปิดเมื่อมีคำสั่งแรก ปิดเมื่อจบขอบเขต ไม่ค้างแม้หลายสิบครั้ง', async () => {
  assert.equal(db.kind(), 'hyperdrive');
  assert.equal(await settle(), 0);
  await db.withScope(async () => {
    assert.equal(active(), 0, 'ยังไม่มีคำสั่ง ยังไม่ต่อฐาน');
    assert.equal((await q.get('SELECT 1 AS one')).one, 1);
    await q.get('SELECT 2 AS two');
    assert.equal(active(), 1, 'ทั้งขอบเขตใช้การเชื่อมต่อเดียว');
  });
  assert.equal(await settle(), 0, 'จบขอบเขตแล้วปิด');
  // เพดาน 3 การเชื่อมต่อ ถ้าไม่ปิดจะค้างตั้งแต่รอบที่ 4
  for (let i = 0; i < 30; i++) await db.withScope(() => q.get('SELECT ? AS n', i));
  assert.equal(await settle(), 0);
});

test('ในคำขอเดียว คำสั่งนอก transaction รอจน transaction จบ ไม่หลุดเข้าไปข้างใน', async () => {
  await db.withScope(async () => {
    let inside;
    const tx = q // ตั้งใจไม่ await รอทีหลัง
      .tx(async () => {
        await q.run("INSERT INTO departments (name, sort) VALUES ('กลุ่มรอ', 99)");
        inside = await q.get("SELECT COUNT(*) AS n FROM departments WHERE name = 'กลุ่มรอ'");
        await new Promise((r) => setTimeout(r, 50));
        throw new Error('ย้อนกลับ');
      })
      .catch((e) => e.message);
    const outside = q.get("SELECT COUNT(*) AS n FROM departments WHERE name = 'กลุ่มรอ'"); // ตั้งใจไม่ await ยิงระหว่าง transaction
    assert.equal(await tx, 'ย้อนกลับ');
    assert.equal(inside.n, 1, 'ข้างใน transaction เห็นแถวที่เพิ่ม');
    assert.equal((await outside).n, 0, 'คำสั่งข้างนอกรอจนย้อนกลับแล้ว จึงไม่เห็นแถว');
  });
});

test('คำขอผ่าน Express บน Workers ปิดการเชื่อมต่อทุกคำขอ และไม่เสิร์ฟไฟล์ static เอง', async () => {
  for (let i = 0; i < 12; i++) assert.equal((await new Client().get('/login')).status, 302); // ฐานว่าง ไปหน้าตั้งค่าครั้งแรก
  assert.equal(await settle(), 0);
  // บน Workers ไฟล์ static มาจาก dist/assets ที่ Cloudflare ส่งเอง Express ไม่ส่ง (ได้หน้าไม่พบ หรือพาไปตั้งค่า)
  const css = await new Client().get('/static/css/app.css');
  assert.notEqual(css.status, 200);
});

test('หน้าผู้ดูแลแสดงข้อความแบบคลาวด์บน Workers และแบบเดิมในคอมเครื่องเดียว', async () => {
  const admin = new Client();
  const r = await admin.post('/setup', { school_name: 'โรงเรียนทดลอง', full_name: 'นายสมมติ ผู้ดูแลทดลอง', username: 'wadmin', password: 'abcdef12', password2: 'abcdef12' });
  assert.equal(r.status, 302);
  const pages = async () => ({
    home: (await admin.get('/admin')).text,
    settings: (await admin.get('/admin/settings')).text,
    features: (await admin.get('/admin/features')).text,
    tt: (await admin.get('/admin/teach-import')).text,
  });
  const cloud = await pages();
  assert.match(cloud.home, /ครูเปิดเบราว์เซอร์จากที่ไหนก็ได้ที่มีอินเทอร์เน็ต/);
  assert.ok(cloud.home.includes(`https://127.0.0.1:${server.address().port}`), 'แสดงที่อยู่เว็บของระบบ');
  assert.doesNotMatch(cloud.home, /Wi-Fi/);
  assert.match(cloud.settings, /ถ้าเว้นว่าง ระบบใช้ที่อยู่เว็บที่เปิดอยู่ตอนพิมพ์เอกสาร/);
  assert.match(cloud.settings, /placeholder="เช่น ที่อยู่เว็บของระบบที่ได้ตอนติดตั้ง"/);
  assert.match(cloud.features, /ข้อความอาจถึงช้ากว่าเวลาที่ตั้งไว้ไม่เกิน 5 นาที/);
  assert.match(cloud.features, /ปิดอยู่ ครูพิมพ์ข้อความในช่องบันทึกเองตามปกติ/);
  assert.doesNotMatch(cloud.features, /เครื่องที่ติดตั้งระบบ/);
  assert.match(cloud.tt, /ถ้าโปรแกรมจัดตารางสอนอยู่เครื่องอื่น คัดลอกไฟล์นี้มาที่เครื่องที่ใช้อยู่ก่อน เช่น ผ่านแฟลชไดรฟ์หรือ Google Drive/);
  assert.match(cloud.home, /app\.css\?v=build123/, 'รุ่นไฟล์ static มาจากตอน build');

  onWorkers(false);
  try {
    const local = await pages();
    assert.match(local.home, /ครูที่ต่อ Wi-Fi เดียวกับเครื่องนี้/);
    assert.match(local.settings, /ระบบใช้ที่อยู่ในวง Wi-Fi ของเครื่องที่ติดตั้งระบบ/);
    assert.match(local.features, /เครื่องที่ติดตั้งระบบต้องต่ออินเทอร์เน็ต/);
    assert.match(local.features, /ใช้ได้เมื่อเปิดระบบผ่าน https หรือเปิดบนเครื่องที่ติดตั้งระบบ/);
    assert.match(local.tt, /ถ้าระบบส่งแผนอยู่คนละเครื่อง คัดลอกไฟล์นี้ใส่แฟลชไดรฟ์มาได้/);
  } finally {
    onWorkers(true);
  }
  assert.equal(await settle(), 0);
});

test('บน Workers นับรหัสผิดต่อเครื่องจาก CF-Connecting-IP (req.ip ว่างบน Workers)', async () => {
  const ip = (n) => ({ 'cf-connecting-ip': `203.0.113.${n}` });
  for (let i = 0; i < 8; i++) assert.equal((await new Client().post('/login', { username: 'wadmin', password: 'wrong' }, ip(7))).status, 401);
  const locked = await new Client().post('/login', { username: 'wadmin', password: 'abcdef12' }, ip(7));
  assert.match(locked.text, /รอ 10 นาที/);
  const other = await new Client().post('/login', { username: 'wadmin', password: 'abcdef12' }, ip(8));
  assert.equal(other.status, 302, 'เครื่องอื่นยังเข้าได้');
});

test('บน Workers ไม่ตั้ง SESSION_SECRET แล้วไม่เปิดระบบ (ไม่มีดิสก์ให้เก็บกุญแจ)', () => {
  const keep = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.throws(() => createApp(), /SESSION_SECRET/);
    assert.equal(fs.existsSync(path.join(config.DATA_DIR, 'secret.key')), false);
  } finally {
    process.env.SESSION_SECRET = keep;
  }
});

test('งานตามเวลาจาก Cron Trigger: รู้จัก 3 เวลา ปิดการเชื่อมต่อเมื่อจบ', async () => {
  assert.deepEqual(Object.keys(jobs.CRONS), ['*/5 * * * *', '0 * * * *', '0 19 * * *']);
  const wrangler = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  for (const c of Object.keys(jobs.CRONS)) assert.ok(wrangler.includes(`"${c}"`), `wrangler.jsonc มี ${c}`);
  await jobs.runCron('*/5 * * * *'); // LINE ปิดอยู่ ไม่ส่งอะไร
  await jobs.runCron('0 * * * *');
  await assert.rejects(jobs.runCron('1 2 3 4 5'), /ไม่รู้จัก/);
  assert.equal(await settle(), 0);
});
