// ทดสอบหน้างานของฉันแบบมีปกเล่ม (ฟังก์ชันเสริม myshelf): ปุ่มครบเท่าหน้าเดิม ปกเดียวกับคลังงาน ขั้นอนุมัติ ผู้ดูแลระบบสลับแบบได้ ปิดสวิตช์กลับเป็นหน้าเดิม
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-myshelf-'));
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

// งานในภาคเรียนปัจจุบันของครูคนหนึ่ง
const OWNER = "SELECT s.id, s.status, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type IN ('plan', 'manual')";

// ลิงก์ที่กดได้ในเนื้อหาหน้างานของฉัน ไม่นับเมนู ใช้เทียบปุ่มกับหน้าเดิม
function workLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="(\/s\/[^"]+|\/f\/[^"]+|\/notes\/new[^"]*|\/works\/new[^"]*)"/g)) out.add(m[1].replace(/&amp;/g, '&'));
  return out;
}

test('ค่าเริ่มต้นเป็นแบบ ก มีชั้นปก จุดขั้นอนุมัติ และตัวเลขสรุป ไม่มีตารางเดิม', async () => {
  const w = await db.q.get(`${OWNER} AND s.status = 'pending' ORDER BY s.id LIMIT 1`);
  const my = (await (await as(w.username)).get('/my')).text;
  assert.match(my, /class="myc-shelf"/);
  assert.match(my, /class="myc-dots"/);
  assert.match(my, /class="myc-sum"/);
  assert.match(my, /ตอนนี้อยู่ที่ <b>/);
  assert.doesNotMatch(my, /<table class="table">/);
});

test('ทุกปุ่มในหน้าเดิมยังอยู่ในแบบ ก ทุกสถานะ', async () => {
  const rows = await db.q.all(`SELECT DISTINCT u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type IN ('plan', 'manual') ORDER BY u.username LIMIT 12`);
  assert.ok(rows.length > 1);
  for (const { username } of rows) {
    const c = await as(username);
    const now = workLinks((await c.get('/my')).text);
    await db.setSetting('ff_myshelf', '0');
    try {
      const old = workLinks((await c.get('/my')).text);
      assert.deepEqual([...now].sort(), [...old].sort(), `ปุ่มของ ${username} ต้องเท่าหน้าเดิม`);
    } finally {
      await db.setSetting('ff_myshelf', '1');
    }
  }
});

test('ปกดึงรูปเดียวกับคลังงาน งานไม่มีรูปใช้ปกที่ระบบวาด ฉบับร่างไม่ดึงรูป', async () => {
  const w = await db.q.get(`${OWNER} AND s.status = 'pending' ORDER BY s.id LIMIT 1`);
  const c = await as(w.username);
  await db.q.run('UPDATE submissions SET cover_ref = NULL WHERE id = ?', w.id);
  assert.doesNotMatch((await c.get('/my')).text, new RegExp(`/library/cover/${w.id}\\?`));
  await db.q.run("UPDATE submissions SET cover_ref = 'ทดลองปก' WHERE id = ?", w.id);
  try {
    assert.match((await c.get('/my')).text, new RegExp(`src="/library/cover/${w.id}\\?v=`));
    await db.q.run("UPDATE submissions SET status = 'draft' WHERE id = ?", w.id);
    assert.doesNotMatch((await c.get('/my')).text, new RegExp(`/library/cover/${w.id}\\?`));
  } finally {
    await db.q.run("UPDATE submissions SET cover_ref = NULL, status = 'pending' WHERE id = ?", w.id);
  }
});

test('งานที่ถูกส่งกลับ มีกรอบแดง ปุ่มแก้ไข และเหตุผลที่ส่งกลับ', async () => {
  const w = await db.q.get(`${OWNER} AND s.status = 'returned' ORDER BY s.id LIMIT 1`);
  assert.ok(w, 'ข้อมูลทดลองต้องมีงานส่งกลับ');
  const r = await db.q.get("SELECT comment FROM reviews WHERE submission_id = ? AND action = 'return' ORDER BY id DESC LIMIT 1", w.id);
  const my = (await (await as(w.username)).get('/my')).text;
  assert.match(my, /myc-tile is-back/);
  assert.match(my, /แก้ไขแล้วส่งใหม่/);
  if (r && r.comment) assert.ok(my.includes(r.comment), 'เหตุผลที่ส่งกลับ');
});

test('ผู้ดูแลระบบเลือกหน้าเดิมแล้วครูเห็นตารางเดิม เลือกกลับได้ และจดประวัติ', async () => {
  const w = await db.q.get(`${OWNER} ORDER BY s.id LIMIT 1`);
  const c = await as(w.username);
  const a = await as('admin');
  assert.match((await a.get('/admin/features')).text, /action="\/admin\/mystyle"/);
  assert.equal((await a.post('/admin/mystyle', { my_style: 'old' })).status, 302);
  let my = (await c.get('/my')).text;
  assert.match(my, /<table class="table">/);
  assert.doesNotMatch(my, /myc-shelf/);
  assert.ok(await db.q.get("SELECT id FROM audit_log WHERE detail = 'my_style' AND action LIKE '%หน้าเดิม%'"));
  assert.equal((await a.post('/admin/mystyle', { my_style: 'a' })).status, 302);
  my = (await c.get('/my')).text;
  assert.match(my, /myc-shelf/);
});

test('แบบ ข และ ค ปุ่มครบเท่าหน้าเดิม แบบ ข มีแผงรายละเอียด แบบ ค เห็นเส้นทางอนุมัติในหน้า', async () => {
  const rows = await db.q.all(`SELECT DISTINCT u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type IN ('plan', 'manual') ORDER BY u.username LIMIT 12`);
  const a = await as('admin');
  try {
    for (const { username } of rows) {
      const c = await as(username);
      await a.post('/admin/mystyle', { my_style: 'old' });
      const old = [...workLinks((await c.get('/my')).text)].sort();
      for (const style of ['b', 'c']) {
        await a.post('/admin/mystyle', { my_style: style });
        assert.deepEqual([...workLinks((await c.get('/my')).text)].sort(), old, `ปุ่มของ ${username} แบบ ${style} ต้องเท่าหน้าเดิม`);
      }
    }
    await a.post('/admin/mystyle', { my_style: 'b' });
    const w = await db.q.get(`${OWNER} AND s.status = 'pending' ORDER BY s.id LIMIT 1`);
    const c = await as(w.username);
    let my = (await c.get('/my')).text;
    assert.match(my, /class="mys-grid"/);
    assert.ok(my.includes(`data-my-open="w${w.id}"`), 'แตะปกเปิดแผง');
    assert.ok(my.includes(`data-my-panel="w${w.id}"`), 'มีแผงของงาน');
    assert.ok(my.includes(`href="/s/${w.id}" data-my-open`), 'ไม่มี JavaScript ปกยังพาไปหน้างาน');
    assert.match(my, /อนุมัติถึงใครแล้ว/);
    await a.post('/admin/mystyle', { my_style: 'c' });
    my = (await c.get('/my')).text;
    assert.match(my, /class="myr-list"/);
    assert.match(my, /class="stepper-box"/);
    assert.doesNotMatch(my, /mys-grid/);
  } finally {
    await a.post('/admin/mystyle', { my_style: 'a' });
  }
});

test('เส้นทางการตรวจในหน้างานอยู่ในกล่องที่เรียงลงมาได้เมื่อจอแคบ', async () => {
  const w = await db.q.get(`${OWNER} AND s.status = 'pending' ORDER BY s.id LIMIT 1`);
  const page = (await (await as(w.username)).get(`/s/${w.id}`)).text;
  assert.match(page, /<div class="stepper-box"><div class="stepper">/);
});

test('แบบที่ไม่มีในรายการไม่ถูกบันทึก ครูทั่วไปตั้งแบบไม่ได้', async () => {
  const a = await as('admin');
  await a.post('/admin/mystyle', { my_style: 'x' });
  const row = await db.q.get("SELECT value FROM settings WHERE key = 'my_style'");
  assert.notEqual(row && row.value, 'x');
  const w = await db.q.get(`${OWNER} AND u.username <> 'admin' ORDER BY s.id LIMIT 1`);
  const r = await (await as(w.username)).post('/admin/mystyle', { my_style: 'old' });
  const after = await db.q.get("SELECT value FROM settings WHERE key = 'my_style'");
  assert.notEqual(after && after.value, 'old', `ครูตั้งแบบได้ สถานะ ${r.status}`);
});

test('ปิดสวิตช์ myshelf แล้วกลับเป็นหน้าเดิม กล่องเลือกแบบหายไป', async () => {
  const w = await db.q.get(`${OWNER} ORDER BY s.id LIMIT 1`);
  await db.setSetting('ff_myshelf', '0');
  try {
    const my = (await (await as(w.username)).get('/my')).text;
    assert.match(my, /<table class="table">/);
    assert.doesNotMatch(my, /myc-shelf/);
    assert.doesNotMatch((await (await as('admin')).get('/admin/features')).text, /action="\/admin\/mystyle"/);
  } finally {
    await db.setSetting('ff_myshelf', '1');
  }
});
