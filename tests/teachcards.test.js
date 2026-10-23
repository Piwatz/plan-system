// ทดสอบรายวิชาที่สอนเป็นกล่องบนมือถือ (ฟังก์ชันเสริม teachcards): 3 แบบ ผู้ดูแลระบบเลือกแบบ ปิดสวิตช์กลับเป็นแบบเดิม
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-teachcards-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');

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

test('ครูเห็นกล่องแบบ ก เป็นค่าเริ่มต้น มีปุ่มส่งและปุ่มเพิ่มวิชา แถวเดิมยังอยู่สำหรับจอคอม', async () => {
  const page = (await (await as('sci2')).get('/teaching')).text;
  assert.match(page, /has-tc tc-a/);
  assert.match(page, /class="tc-list"/);
  assert.match(page, /class="teach-row"/, 'แถวแบบเดิมยังอยู่');
  assert.match(page, /data-tc-add/);
  assert.match(page, /tc-go[^>]*>.*ส่งคู่มือ/s);
});

test('ผู้ดูแลระบบเลือกแบบ ข แล้วทุกคนเห็นแบบ ข · หน้าครูของผู้ดูแลเป็นปุ่มสร้างแทนครู · ครูเปลี่ยนแบบไม่ได้', async () => {
  const a = await as('admin');
  assert.match((await a.get('/admin/features')).text, /action="\/admin\/teachstyle"/);
  const r = await a.post('/admin/teachstyle', { teach_style: 'b' });
  assert.equal(r.status, 302);
  assert.equal((await db.getSettings()).teach_style, 'b');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ตั้งแบบหน้ารายวิชาที่สอนบนมือถือ แบบ ข%'"));
  assert.match((await (await as('sci2')).get('/teaching')).text, /has-tc tc-b/);
  const t = await db.q.get("SELECT id FROM users WHERE username = 'teacher'");
  const list = (await a.get(`/teaching?u=${t.id}`)).text;
  if (list.includes('tc-go')) assert.match(list, /tc-go[^>]*>.*สร้างแทนครู/s);
  // ไม่มีแบบนี้
  await a.post('/admin/teachstyle', { teach_style: 'z' });
  assert.equal((await db.getSettings()).teach_style, 'b');
  // ครูเรียกเส้นทางผู้ดูแลไม่ได้
  await (await as('sci2')).post('/admin/teachstyle', { teach_style: 'c' });
  assert.equal((await db.getSettings()).teach_style, 'b');
});

test('ปิดสวิตช์ teachcards แล้วมือถือเห็นแบบเดิม ไม่มีกล่องและไม่พับช่องเพิ่มวิชา', async () => {
  await db.setSetting('ff_teachcards', '0');
  try {
    const page = (await (await as('sci2')).get('/teaching')).text;
    assert.doesNotMatch(page, /tc-list|has-tc|data-tc-add|tc-addform/);
    assert.match(page, /class="teach-row"/);
  } finally {
    await db.setSetting('ff_teachcards', '1');
  }
});
