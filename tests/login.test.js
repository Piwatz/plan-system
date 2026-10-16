// ทดสอบหน้าเข้าสู่ระบบแบบเลือกชื่อ และรหัสผ่านตัวเลข 4 หลักสำหรับครู (ผู้บริหารและผู้ดูแลยังต้อง 6 ตัว)
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-login-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const auth = require('../src/auth');

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

async function login(username, password = seed.DEMO_PASSWORD) {
  const c = new Client();
  const r = await c.post('/login', { username, password });
  return { c, ok: r.status === 302, r };
}

const uid = async (username) => (await db.q.get('SELECT id FROM users WHERE username = ?', username)).id;

test('หน้าเข้าสู่ระบบมีรายชื่อให้เลือกแยกกลุ่มสาระ และแป้นตัวเลข ปิดสวิตช์แล้วกลับเป็นช่องพิมพ์', async () => {
  const page = (await new Client().get('/login')).text;
  assert.match(page, /<select id="username" name="username" class="pick-name"/);
  assert.match(page, /<optgroup label="กลุ่มสาระวิทยาศาสตร์และเทคโนโลยี">[\s\S]*?<option value="teacher"\s*>นายสมชาย ใจดี<\/option>/);
  assert.match(page, /<optgroup label="ผู้บริหารและผู้ดูแลระบบ">[\s\S]*?นายมงคล นำพา/);
  assert.match(page, /พิมพ์ชื่อผู้ใช้เอง/);

  const bad = await new Client().post('/login', { username: 'teacher', password: 'ผิด' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /รหัสผ่านไม่ถูกต้อง/);
  assert.match(bad.text, /<option value="teacher" selected>/, 'ใส่ผิดแล้วชื่อที่เลือกไว้ยังอยู่');

  await db.setSetting('ff_namepick', '0');
  await db.setSetting('ff_pin', '0');
  const off = (await new Client().get('/login')).text;
  assert.doesNotMatch(off, /pick-name/);
  assert.match(off, /<input type="text" id="username" name="username"/);
  await db.setSetting('ff_namepick', '1');
  await db.setSetting('ff_pin', '1');
});

test('ครูตั้งรหัสตัวเลข 4 หลักได้ ผู้อำนวยการและผู้ดูแลระบบต้อง 6 ตัว', async () => {
  const t = (await login('teacher')).c;
  let r = await t.post('/password', { current: seed.DEMO_PASSWORD, password: '123', password2: '123' });
  assert.match(r.text, /อย่างน้อย 4 ตัว/);
  r = await t.post('/password', { current: seed.DEMO_PASSWORD, password: '2569', password2: '2569' });
  assert.equal(r.status, 302);
  assert.ok((await login('teacher', '2569')).ok, 'เข้าด้วยรหัส 4 หลักได้');

  const d = (await login('director')).c;
  r = await d.post('/password', { current: seed.DEMO_PASSWORD, password: '1234', password2: '1234' });
  assert.match(r.text, /อย่างน้อย 6 ตัว/);
  assert.equal((await login('director', '1234')).ok, false);

  // ผู้ดูแลระบบตั้งรหัสให้: ครู 4 หลักได้ ผู้อำนวยการไม่ได้
  const a = (await login('admin')).c;
  await a.post(`/admin/users/${(await uid('sci2'))}/reset`, { password: '4321' });
  assert.ok((await login('sci2', '4321')).ok);
  await a.post(`/admin/users/${(await uid('director'))}/reset`, { password: '4321' });
  assert.equal((await login('director', '4321')).ok, false);
  assert.ok((await login('director')).ok, 'รหัสเดิมของผู้อำนวยการยังใช้ได้');

  // ปิดสวิตช์แล้วครูก็ต้อง 6 ตัวเหมือนเดิม
  await db.setSetting('ff_pin', '0');
  await a.post(`/admin/users/${(await uid('sci2'))}/reset`, { password: '9876' });
  assert.equal((await login('sci2', '9876')).ok, false);
  await db.setSetting('ff_pin', '1');
});

test('ใส่รหัสผิดเกิน 20 ครั้งต่อชื่อ ล็อกชื่อนั้นไม่ว่าจะเดาจากเครื่องไหน', async () => {
  const key = auth.userKey('ทดสอบล็อก');
  for (let i = 0; i < 19; i++) await auth.recordFail(key);
  assert.equal((await auth.isLocked(key)), false);
  await auth.recordFail(key);
  assert.equal((await auth.isLocked(key)), true);
  await auth.clearFails(key);
  assert.equal((await auth.minPassword({ is_admin: 1, roles: [] }, true)), 6);
  assert.equal((await auth.minPassword({ is_admin: 0, roles: ['director'] }, true)), 6);
  assert.equal((await auth.minPassword({ is_admin: 0, roles: ['dept_head'] }, true)), 4);
  assert.equal((await auth.minPassword({ is_admin: 0, roles: [] }, false)), 6);
});

test('นำเข้ารายชื่อแบบสร้างชื่อผู้ใช้อัตโนมัติ: ตัดคำนำหน้าและนามสกุล ชื่อซ้ำต่อท้ายด้วยเลข นำเข้าซ้ำไม่สร้างคนใหม่', async () => {
  const a = (await login('admin')).c;
  const data = [
    'ชื่อ สกุล\tตำแหน่ง\tกลุ่มสาระ\tหน้าที่ผู้ตรวจ',
    'นายสมศักดิ์ ทดลองดี\tครู\tวิทยาศาสตร์\t',
    'นางสาวสมศักดิ์ อื่นอีก\tครู\tคณิตศาสตร์\t',
    'ว่าที่ร้อยตรีวิชัย สมมติ\tครูผู้ช่วย\tภาษาไทย\t',
    'นางนายิกา ตัวอย่าง\tครู\tภาษาไทย\t',
  ].join('\n');
  const r = await a.post('/admin/users-import', { data, password: '1234', auto_username: '1' });
  assert.match(r.text, /เพิ่มใหม่ <b>4<\/b> คน/);
  const name = async (full) => (await db.q.get('SELECT username FROM users WHERE full_name = ?', full)).username;
  assert.equal((await name('นายสมศักดิ์ ทดลองดี')), 'สมศักดิ์');
  assert.equal((await name('นางสาวสมศักดิ์ อื่นอีก')), 'สมศักดิ์2');
  assert.equal((await name('ว่าที่ร้อยตรีวิชัย สมมติ')), 'วิชัย');
  assert.equal((await name('นางนายิกา ตัวอย่าง')), 'นายิกา', 'ชื่อที่ขึ้นต้นด้วย นาย ไม่ถูกตัดผิด');
  assert.match(r.text, /<td>นายสมศักดิ์ ทดลองดี<\/td><td><b>สมศักดิ์<\/b><\/td>/, 'แสดงชื่อผู้ใช้ที่ได้ให้ผู้ดูแลจด');

  const again = await a.post('/admin/users-import', { data, password: '1234', auto_username: '1' });
  assert.match(again.text, /เพิ่มใหม่ <b>0<\/b> คน ปรับปรุงข้อมูลเดิม <b>4<\/b> คน/);
  assert.ok((await login('สมศักดิ์', '1234')).ok, 'เข้าระบบด้วยชื่อผู้ใช้ภาษาไทยได้');

  // เพิ่มทีละคนโดยเว้นชื่อผู้ใช้ไว้
  await a.post('/admin/users', { full_name: 'นายสมศักดิ์ คนที่สาม', password: '5678', is_teacher: '1', is_active: '1' });
  assert.equal((await name('นายสมศักดิ์ คนที่สาม')), 'สมศักดิ์3');
});

test('ผู้ดูแลระบบเห็นชื่อที่ถูกใส่รหัสผิด กดปลดล็อกแล้วเข้าได้ทันที บันทึกใน audit_log ปิดสวิตช์แล้วไม่มีกล่อง', async () => {
  const who = await db.q.get("SELECT id, username, full_name FROM users WHERE username = 'eng2'");
  assert.ok(who, 'มีครูทดลองชื่อ eng2');
  for (let i = 0; i < 8; i++) await new Client().post('/login', { username: who.username, password: 'ผิด' });
  const locked = await new Client().post('/login', { username: who.username, password: seed.DEMO_PASSWORD });
  assert.equal(locked.status, 401);
  assert.match(locked.text, /ใส่รหัสผ่านผิดหลายครั้ง/);

  const a = (await login('admin')).c;
  const page = (await a.get('/admin')).text;
  assert.match(page, /id="accounts"/);
  assert.match(page, new RegExp(String.raw`<b>${who.full_name}</b>\s*<span>ใส่รหัสผิด 8 ครั้ง ล็อกถึง \d\d:\d\d น\.`));
  assert.match(page, new RegExp(`action="/admin/users/${who.id}/unlock" data-confirm="ปลดล็อกบัญชีของ`));
  assert.match(page, /ยังไม่เคยเข้าระบบ \d+ คน/);

  // ปิดสวิตช์: ไม่มีกล่อง และกดปลดล็อกไม่ได้
  await db.setSetting('ff_unlock', '0');
  assert.doesNotMatch((await a.get('/admin')).text, /id="accounts"/);
  await a.post(`/admin/users/${who.id}/unlock`, {});
  assert.equal((await login(who.username)).ok, false, 'ปิดสวิตช์แล้วยังล็อกอยู่');
  await db.setSetting('ff_unlock', '1');

  const r = await a.post(`/admin/users/${who.id}/unlock`, {});
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin#accounts');
  assert.ok((await login(who.username)).ok, 'ปลดล็อกแล้วเข้าได้ทันที');
  const log = await db.q.get("SELECT action, detail FROM audit_log WHERE action LIKE 'ปลดล็อกบัญชี%' ORDER BY id DESC LIMIT 1");
  assert.equal(log.action, `ปลดล็อกบัญชีของ ${who.full_name}`);
  assert.match(log.detail, /ใส่รหัสผิด 8 ครั้ง/);
  assert.doesNotMatch((await a.get('/admin')).text, new RegExp(`/admin/users/${who.id}/unlock`));
  // ล้างเฉพาะตัวนับของชื่อนี้ ชื่ออื่นที่ลงท้ายเหมือนกันไม่ถูกล้าง
  await auth.recordFail(auth.userKey('xeng2'), '1.2.3.4|xeng2');
  await auth.unlockUser('eng2');
  assert.equal((await db.q.get("SELECT COUNT(*)::int AS n FROM login_attempts WHERE key LIKE '%xeng2'")).n, 2);
});
