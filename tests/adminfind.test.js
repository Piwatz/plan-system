// ทดสอบช่องค้นหาฟังก์ชันของผู้ดูแลระบบ (ฟังก์ชันเสริม adminfind): รายการที่ค้นได้ ลิงก์ปลายทาง หัวข้อที่ลิงก์ไปมีอยู่จริง
// เปิดปิดสวิตช์จากผลค้นหาแล้วกลับที่เดิม สิทธิ์ · ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-adminfind-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const features = require('../src/features');
const adminfind = require('../src/adminfind');

let base;
let server;

test.before(async () => {
  await seed.main({ target: ':memory:', keepOpen: true });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

class Client {
  constructor() {
    this.cookies = {};
  }
  async req(method, url, body) {
    const cookie = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie } });
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
  post(url, fields) {
    return this.req('POST', url, new URLSearchParams(fields));
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

test('รายการค้นหา: ฟังก์ชันเสริมครบทุกตัว หน้าที่ผูกฟังก์ชันเสริมซ่อนเมื่อปิด ลิงก์หัวข้อมี found=1 คำพ้องชี้ไปคำที่มีอยู่จริง', () => {
  for (const p of adminfind.PLACES) if (p.ff) assert.ok(features.BY_KEY[p.ff], `หน้า ${p.title} ผูกฟังก์ชันเสริม ${p.ff} ที่ไม่มีอยู่`);
  const all = Object.fromEntries(features.FEATURES.map((f) => [f.key, true]));
  const none = Object.fromEntries(features.FEATURES.map((f) => [f.key, false]));
  const on = adminfind.items({}, all);
  assert.equal(on.items.filter((x) => x.kind === 'feature').length, features.FEATURES.length);
  assert.equal(on.items.filter((x) => x.kind === 'place').length, adminfind.PLACES.length);
  const off = adminfind.items({}, none);
  assert.ok(!off.items.some((x) => x.href === '/admin/trash'), 'ปิดถังขยะแล้วไม่มีหน้าถังขยะในผล');
  assert.ok(on.items.some((x) => x.href === '/admin/settings?found=1#docno'));
  assert.ok(on.items.some((x) => x.href === '/admin/rubric?type=plan'));
  assert.ok(on.items.some((x) => x.href === '/admin/features?found=1#f-sigrotate'));
  const text = on.items.map((x) => [x.title, x.desc, x.words, x.where].join(' ').toLowerCase()).join(' ');
  for (const w of adminfind.POPULAR) assert.ok(text.includes(w.toLowerCase()), `คำค้นบ่อย ${w} ต้องค้นเจอ`);
  for (const [k, list] of Object.entries(adminfind.SYNONYMS)) assert.ok([k, ...list].some((w) => text.includes(w.toLowerCase())), `คำพ้อง ${k} ไม่เจออะไรเลย`);
});

test('หน้าผู้ดูแลมีช่องค้นหา หัวข้อปลายทางทุกอันมี id จริง เปิดปิดสวิตช์จากผลค้นหาแล้วกลับไปผลเดิม ปิดฟังก์ชันแล้วช่องหาย', async () => {
  const admin = await as('admin');
  const home = await admin.get('/admin');
  assert.equal(home.status, 200);
  assert.match(home.text, /data-adminfind/);
  assert.match(home.text, /data-af-word="ลายเซ็น"/);
  const json = JSON.parse((await admin.get('/admin/find.json')).text);
  assert.ok(json.items.length > 100);

  // ทุกลิงก์ที่มีหัวข้อ (#) ต้องมี id นั้นในหน้าปลายทาง
  const pages = new Map();
  for (const it of json.items) {
    const m = /^([^#]+?)(?:\?[^#]*)?#(.+)$/.exec(it.href);
    if (!m) continue;
    if (!pages.has(m[1])) pages.set(m[1], (await admin.get(m[1])).text);
    assert.match(pages.get(m[1]), new RegExp(`id="${m[2]}"`), `${it.title} ลิงก์ไป ${it.href} แต่ไม่มีหัวข้อนี้`);
  }

  const back = '/admin?find=' + encodeURIComponent('ลายเซ็น') + '&fs=on';
  const r = await admin.post('/admin/features/sigrotate', { on: '0', back });
  assert.equal(r.location, back, 'เปิดปิดจากผลค้นหา กลับไปผลค้นหาเดิม');
  assert.equal(features.isOn(await db.getSettings(), 'sigrotate'), false);
  const evil = await admin.post('/admin/features/sigrotate', { on: '1', back: 'https://evil.example/' });
  assert.equal(evil.location, '/admin/features', 'ที่อยู่กลับต้องเป็นหน้าผู้ดูแลเท่านั้น');

  await admin.post('/admin/features/adminfind', { on: '0' });
  assert.doesNotMatch((await admin.get('/admin')).text, /data-adminfind/);
  assert.equal((await admin.get('/admin/find.json')).status, 404);
  await admin.post('/admin/features/adminfind', { on: '1' });

  const teacher = await as('section');
  assert.equal((await teacher.get('/admin')).status, 403);
  assert.equal((await teacher.get('/admin/find.json')).status, 403);
});
