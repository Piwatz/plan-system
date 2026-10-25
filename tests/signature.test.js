// ทดสอบแชท I: ใช้ลายเซ็นใหม่ในงานที่ลงนามแล้ว (ทีละงานและทั้งหมด) และช่องติ๊กจำลายเซ็นตอนลงนาม
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-sig-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const resign = require('../src/resign');

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

// รูป PNG สมมติ ต่างกันตามเลข (ใช้เป็นลายเซ็นใหม่)
const png = (n) => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`sig-${n}`)]).toString('base64');
const uid = async (username) => (await db.q.get('SELECT id FROM users WHERE username = ?', username)).id;
const sigOf = async (username) => (await db.q.get('SELECT signature FROM users WHERE username = ?', username)).signature;

test('เปลี่ยนลายเซ็นแล้วกดใช้ลายเซ็นใหม่ในงานนี้ เปลี่ยนเฉพาะงานนั้นและเฉพาะลายเซ็นของตัวเอง', async () => {
  const id = await uid('scihead');
  assert.equal((await resign.staleWorks(id)).length, 0, 'ตอนแรกทุกงานใช้ลายเซ็นปัจจุบัน');
  const subs = (await db.q.all('SELECT DISTINCT submission_id AS s FROM reviews WHERE user_id = ? AND signature IS NOT NULL ORDER BY 1', id)).map((r) => r.s);
  assert.ok(subs.length >= 2, 'หัวหน้ากลุ่มสาระทดลองลงนามไว้หลายงาน');
  const [one, two] = subs;

  const c = await as('scihead');
  assert.doesNotMatch((await c.get(`/s/${one}`)).text, /ใช้ลายเซ็นใหม่ของฉันในงานนี้/);
  await c.post('/profile', { position: 'ครู', signature: png(1) });
  const fresh = await sigOf('scihead');
  assert.equal(fresh, png(1));

  const page = (await c.get(`/s/${one}`)).text;
  assert.match(page, new RegExp(`action="/s/${one}/resign" data-confirm="ใช้ลายเซ็นปัจจุบัน`));
  assert.match(page, /คุณลงนามงานนี้ด้วยลายเซ็นเดิม/);
  const stale = (await resign.staleWorks(id)).length;
  assert.ok(stale >= subs.length);
  assert.match((await c.get('/profile')).text, new RegExp(`มีงานที่ลงนามด้วยลายเซ็นเดิม ${stale} งาน`));

  // คนอื่นกดในงานเดียวกัน ไม่เปลี่ยนลายเซ็นของหัวหน้ากลุ่มสาระ
  await (await as('director')).post(`/s/${one}/resign`, {});
  assert.equal((await resign.staleWorks(id, one)).length, 1);

  const r = await c.post(`/s/${one}/resign`, {});
  assert.equal(r.status, 302);
  const rows = await db.q.all('SELECT signature FROM reviews WHERE user_id = ? AND submission_id = ? AND signature IS NOT NULL', id, one);
  assert.ok(rows.every((x) => x.signature === fresh));
  assert.equal((await resign.staleWorks(id, two)).length, 1, 'งานอื่นยังเป็นลายเซ็นเดิม');
  assert.doesNotMatch((await c.get(`/s/${one}`)).text, /ใช้ลายเซ็นใหม่ของฉันในงานนี้/);
  const log = await db.q.get("SELECT action, user_name FROM audit_log WHERE action LIKE 'ใช้ลายเซ็นใหม่ใน%' ORDER BY id DESC LIMIT 1");
  assert.equal(log.user_name, 'นางวันดี ศรีวิทย์');

  // ปิดสวิตช์: ไม่มีปุ่ม และกดไม่ได้
  await db.setSetting('ff_resign', '0');
  assert.doesNotMatch((await c.get(`/s/${two}`)).text, /\/resign"/);
  await c.post(`/s/${two}/resign`, {});
  assert.equal((await resign.staleWorks(id, two)).length, 1);
  await db.setSetting('ff_resign', '1');

  // ทั้งหมดครั้งเดียวจากหน้าข้อมูลส่วนตัว
  const all = await c.post('/profile/resign-all', {});
  assert.equal(all.location, '/profile');
  assert.equal((await resign.staleWorks(id)).length, 0);
  assert.doesNotMatch((await c.get('/profile')).text, /มีงานที่ลงนามด้วยลายเซ็นเดิม/);
  assert.ok(await db.q.get('SELECT 1 AS x FROM audit_log WHERE action = ?', `ใช้ลายเซ็นใหม่ในงานที่ลงนามแล้วทั้งหมด ${stale - 1} งาน`));
});

test('ครูเปลี่ยนลายเซ็นตอนส่งงานของตัวเองได้ ลายเซ็นในเอกสารที่พิมพ์เปลี่ยนตาม', async () => {
  const id = await uid('teacher');
  const sub = await db.q.get('SELECT id FROM submissions WHERE teacher_id = ? AND teacher_signature IS NOT NULL ORDER BY id LIMIT 1', id);
  const c = await as('teacher');
  await c.post('/profile', { position: 'ครู', signature: png(2) });
  assert.ok((await resign.staleWorks(id)).includes(sub.id));
  await c.post(`/s/${sub.id}/resign`, {});
  assert.equal((await db.q.get('SELECT teacher_signature FROM submissions WHERE id = ?', sub.id)).teacher_signature, png(2));
});

test('เซ็นในกรอบตอนลงนามแล้วไม่ติ๊กจำ ใช้กับงานนี้อย่างเดียว ไม่เก็บทับข้อมูลส่วนตัว ติ๊กจำแล้วเก็บ', async () => {
  // งานที่รอผู้ตรวจระดับโรงเรียน (ไม่ต้องให้คะแนน) ของผู้ตรวจคนเดียวกัน 2 งาน
  const subs = await db.q.all(
    `SELECT s.id, r.user_id FROM submissions s JOIN user_roles r ON r.role = s.current_role
     WHERE s.status = 'pending' AND s.doc_type <> 'note' AND s.current_role IN ('academic_head', 'deputy_academic', 'director') ORDER BY r.user_id, s.id`
  );
  const byUser = new Map();
  for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s.id]);
  const [userId, ids] = [...byUser].find(([, list]) => list.length >= 2) || [];
  assert.ok(userId, 'ผู้ตรวจคนเดียวกันมีงานรอ 2 งาน');
  const [a, b] = ids;
  const who = (await db.q.get('SELECT username FROM users WHERE id = ?', userId)).username;
  await db.q.run('UPDATE users SET signature = NULL WHERE id = ?', userId);
  const c = await as(who);
  assert.match((await c.get(`/s/${a}`)).text, /name="remember_signature" value="1" checked> จำลายเซ็นนี้ไว้ใช้ครั้งต่อไป/);

  let r = await c.post(`/s/${a}/approve`, { signature: png(3), sig_choice: '1', comment: 'ทดลอง' });
  assert.equal(r.status, 302, r.text);
  assert.equal(await sigOf(who), null, 'ไม่ติ๊กจำ ไม่เก็บในข้อมูลส่วนตัว');
  const sig = await db.q.get("SELECT signature FROM reviews WHERE submission_id = ? AND user_id = ? AND action = 'approve' ORDER BY id DESC LIMIT 1", a, userId);
  assert.equal(sig.signature, png(3), 'งานนี้ได้ลายเซ็นที่เซ็นในกรอบ');

  r = await c.post(`/s/${b}/approve`, { signature: png(4), sig_choice: '1', remember_signature: '1', comment: 'ทดลอง' });
  assert.equal(r.status, 302, r.text);
  assert.equal(await sigOf(who), png(4), 'ติ๊กจำ เก็บในข้อมูลส่วนตัว');
});

test('หน้าข้อมูลส่วนตัวมีปุ่มปรับขนาด สีเส้น และแก้ลายเซ็นที่บันทึกไว้ ปิดสวิตช์แล้วหายไป', async () => {
  const c = await as('sci2');
  let page = (await c.get('/profile')).text;
  assert.match(page, /data-size-range/);
  assert.match(page, /data-color="#1b2f9e"/);
  assert.match(page, /data-edit-saved>แก้ลายเซ็นที่บันทึกไว้/);
  assert.match(page, /data-current="\/media\/signature\?v=/);
  await db.setSetting('ff_sigadjust', '0');
  await db.setSetting('ff_sigrotate', '0');
  page = (await c.get('/profile')).text;
  assert.doesNotMatch(page, /data-size-range|data-edit-saved/);
  await db.setSetting('ff_sigadjust', '1');
  await db.setSetting('ff_sigrotate', '1');
});

test('หน้าข้อมูลส่วนตัวมีปุ่มหมุน กลับหัว และแถบเอียง ปิดสวิตช์แล้วหายไป', async () => {
  const c = await as('sci2');
  let page = (await c.get('/profile')).text;
  assert.match(page, /data-rot="-90"[^>]*>[\s\S]*?หมุนซ้าย/);
  assert.match(page, /data-rot="90"/);
  assert.match(page, /data-rot="180"[^>]*>[\s\S]*?กลับหัว/);
  assert.match(page, /data-tilt-range/);
  await db.setSetting('ff_sigrotate', '0');
  page = (await c.get('/profile')).text;
  assert.doesNotMatch(page, /data-rot=|data-tilt-range/);
  assert.match(page, /data-size-range/, 'ปุ่มปรับขนาดยังอยู่');
  await db.setSetting('ff_sigadjust', '0');
  page = (await c.get('/profile')).text;
  assert.doesNotMatch(page, /data-adjust|data-edit-saved/);
  await db.setSetting('ff_sigrotate', '1');
  page = (await c.get('/profile')).text;
  assert.match(page, /data-adjust/);
  assert.match(page, /data-edit-saved>แก้ลายเซ็นที่บันทึกไว้/, 'หมุนลายเซ็นที่บันทึกไว้ได้แม้ปิดปรับขนาด');
  assert.doesNotMatch(page, /data-size-range/);
  await db.setSetting('ff_sigadjust', '1');
});
