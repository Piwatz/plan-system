// ทดสอบคำของฉันในช่องความเห็น (ฟังก์ชันเสริม myphrases): เพิ่ม ลบ คืนคำเดิม จำอัตโนมัติ แยกรายคน และสวิตช์
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-phrase-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const myphrases = require('../src/myphrases');

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
  async req(method, url, body, headers = {}) {
    const cookie = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
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
  post(url, fields) {
    return this.req('POST', url, new URLSearchParams(fields));
  }
  phrase(fields) {
    return this.req('POST', '/phrases', new URLSearchParams(fields), { 'X-Requested-With': 'XMLHttpRequest' });
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const idOf = async (username) => (await db.q.get('SELECT id FROM users WHERE username = ?', username)).id;
const rows = async (userId, kind) => (await db.q.all('SELECT text FROM user_phrases WHERE user_id = ? AND kind = ? ORDER BY id', userId, kind)).map((r) => r.text);

test('เพิ่มคำ ยุบเว้นวรรค ไม่เก็บซ้ำ แยกรายคน คนไม่เข้าระบบใช้ไม่ได้', async () => {
  const head = await as('scihead');
  const headId = await idOf('scihead');
  assert.equal((await head.phrase({ do: 'add', text: '  เนื้อหาครบ\n  ดีมาก  ' })).status, 200);
  assert.equal((await head.phrase({ do: 'add', text: 'เนื้อหาครบ ดีมาก' })).status, 200);
  assert.deepEqual(await rows(headId, 'mine'), ['เนื้อหาครบ ดีมาก']);
  assert.deepEqual(await rows(await idOf('teacher'), 'mine'), [], 'คนอื่นต้องไม่เห็นคำนี้');
  assert.equal((await new Client().phrase({ do: 'add', text: 'x' })).status, 302);
  assert.equal((await head.phrase({ do: 'add', text: '   ' })).status, 400);
  assert.equal((await head.phrase({ do: 'add', text: 'ก'.repeat(myphrases.MAX_LEN + 1) })).status, 400);
  assert.equal((await head.phrase({ do: 'hack' })).status, 400);
});

test('ลบคำของฉันออกจริง ปุ่มเดิมซ่อนได้และคืนได้', async () => {
  const head = await as('section');
  const uid = await idOf('section');
  await head.phrase({ do: 'add', text: 'คำทดลองลบ' });
  await head.phrase({ do: 'remove', text: 'คำทดลองลบ' });
  assert.deepEqual(await rows(uid, 'mine'), []);
  await head.phrase({ do: 'remove', text: 'เห็นชอบ' });
  await head.phrase({ do: 'remove', text: 'เห็นชอบ' });
  assert.deepEqual(await rows(uid, 'hidden'), ['เห็นชอบ']);
  // พิมพ์คำเดิมแล้วกดจำ = คืนปุ่มนั้น ไม่เก็บซ้ำเป็นคำของฉัน
  await head.phrase({ do: 'add', text: 'เห็นชอบ' });
  assert.deepEqual(await rows(uid, 'hidden'), []);
  assert.deepEqual(await rows(uid, 'mine'), []);
  await head.phrase({ do: 'remove', text: 'รับทราบ' });
  await head.phrase({ do: 'restore' });
  assert.deepEqual(await rows(uid, 'hidden'), []);
});

test('จำได้ไม่เกินจำนวนที่กำหนด', async () => {
  const uid = await idOf('acad');
  for (let i = 0; i < myphrases.MAX_MINE; i++) await myphrases.add(uid, `คำที่ ${i}`);
  await assert.rejects(() => myphrases.add(uid, 'เกินแล้ว'), /จำได้ไม่เกิน/);
  await myphrases.add(uid, 'คำที่ 0');
  assert.equal((await rows(uid, 'mine')).length, myphrases.MAX_MINE);
});

test('จำอัตโนมัติ: เก็บ 5 คำล่าสุด ข้ามปุ่มเดิมและคำที่จำไว้แล้ว ปิดสวิตช์ไม่จำ', async () => {
  const uid = await idOf('deputy');
  const req = { ff: { myphrases: true }, me: { id: uid } };
  await myphrases.add(uid, 'จำไว้แล้ว');
  await myphrases.remember(req, ['เห็นชอบ', 'รับทราบ', 'จำไว้แล้ว', '', undefined, 'ก'.repeat(myphrases.MAX_LEN + 1)]);
  assert.deepEqual(await rows(uid, 'recent'), []);
  for (const t of ['ล่าสุด 1', 'ล่าสุด 2', 'ล่าสุด 3', 'ล่าสุด 4', 'ล่าสุด 5', 'ล่าสุด 6']) {
    await myphrases.remember(req, [t]);
    await db.q.run("UPDATE user_phrases SET updated_at = ? WHERE user_id = ? AND text = ?", `2000-01-01 00:00:0${t.slice(-1)}`, uid, t);
  }
  const recent = await rows(uid, 'recent');
  assert.equal(recent.length, myphrases.MAX_RECENT);
  assert.ok(!recent.includes('ล่าสุด 1'), 'คำเก่าสุดต้องหลุดออก');
  // กดจำคำจาก ใช้ล่าสุด ย้ายไปเป็นคำของฉัน
  await myphrases.add(uid, 'ล่าสุด 6');
  assert.ok(!(await rows(uid, 'recent')).includes('ล่าสุด 6'));
  await myphrases.remember({ ...req, ff: { myphrases: false } }, ['ไม่ควรจำ']);
  assert.ok(!(await rows(uid, 'recent')).includes('ไม่ควรจำ'));
});

test('หน้าลงนาม: ลงนามด้วยความเห็นที่พิมพ์เองแล้วขึ้นใน ใช้ล่าสุด ปุ่มเดิมมีกากบาท ปิดสวิตช์กลับเป็นแบบเดิม', async () => {
  const uid = await idOf('scihead');
  const admin = await as('admin');
  const head = await as('scihead');
  // ไล่การ์ดทีละฉบับ ใช้เมื่อปิดส่งทั้งเล่ม
  await admin.post('/admin/features/notebook', { on: '0' });
  const page = await head.get('/quicksign');
  const first = Number(page.text.match(/action="\/quicksign\/(\d+)\/approve"/)?.[1]);
  assert.ok(first, 'ข้อมูลทดลองต้องมีบันทึกรอหัวหน้ากลุ่มสาระ');
  assert.match(page.text, /data-say-box/);
  assert.match(page.text, /data-say-del/);
  assert.match(page.text, /data-say-open/);
  assert.match(page.text, /เนื้อหาครบ ดีมาก/, 'คำที่จำไว้ต้องขึ้นในหน้า');
  assert.equal((await head.post(`/quicksign/${first}/approve`, { comment: 'พิมพ์เองตอนลงนาม', signed: '0', back: '0' })).status, 302);
  assert.deepEqual(await rows(uid, 'recent'), ['พิมพ์เองตอนลงนาม']);
  assert.match((await head.get('/quicksign')).text, /ใช้ล่าสุด[\s\S]*พิมพ์เองตอนลงนาม/);

  assert.equal((await admin.post('/admin/features/myphrases', { on: '0' })).status, 302);
  const off = await head.get('/quicksign');
  assert.doesNotMatch(off.text, /data-say-box|data-say-del/);
  assert.match(off.text, /class="chip on" data-say="รับทราบ"/, 'ปิดแล้วต้องเห็นปุ่มแบบเดิม');
  assert.equal((await head.phrase({ do: 'add', text: 'ปิดอยู่' })).status, 404);
  await admin.post('/admin/features/myphrases', { on: '1' });
  assert.deepEqual(await rows(uid, 'mine'), ['เนื้อหาครบ ดีมาก'], 'ปิดแล้วเปิดใหม่คำเดิมต้องอยู่');
});
