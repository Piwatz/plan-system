// ทดสอบข้ามงานนี้ไปก่อน (ฟังก์ชันเสริม skipwork): เฉพาะผู้ดูแลระบบ งานถัดไปไม่วนกลับ เอากลับได้ ครูส่งฉบับใหม่กลับเข้าคิว สวิตช์ปิด
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-skip-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const wf = require('../src/workflow');

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
  post(url, fields = {}) {
    return this.req('POST', url, new URLSearchParams(fields));
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const setAdmin = (username, on) => db.q.run('UPDATE users SET is_admin = ? WHERE username = ?', on ? 1 : 0, username);
const skipCount = async () => Number((await db.q.get('SELECT COUNT(*) AS n FROM review_skips')).n);

// งานเดี่ยวที่รอผู้ตรวจคนนี้ เรียงตามคิว
async function waiting(username) {
  const u = await db.q.get('SELECT id, department_id FROM users WHERE username = ?', username);
  const roles = (await db.q.all('SELECT role FROM user_roles WHERE user_id = ?', u.id)).map((r) => r.role);
  return (await wf.inbox({ ...u, roles })).filter((s) => s.doc_type !== 'note');
}

test('ครูและผู้ตรวจที่ไม่ใช่ผู้ดูแลระบบ ไม่เห็นปุ่ม และกดข้ามไม่ได้', async () => {
  const list = await waiting('scihead');
  assert.ok(list.length >= 1, 'ข้อมูลทดลองต้องมีงานรอหัวหน้ากลุ่มสาระ');
  const head = await as('scihead');
  const page = await head.get(`/s/${list[0].id}`);
  assert.doesNotMatch(page.text, /ข้ามไปก่อน/);
  await head.post(`/s/${list[0].id}/skip`);
  assert.equal(await skipCount(), 0, 'ไม่มีแถวข้ามงาน');
});

test('ผู้ดูแลระบบกดข้าม งานถัดไปไม่วนกลับ แยกอยู่กลุ่มงานที่ข้ามไว้ เอากลับได้', async () => {
  await setAdmin('scihead', true);
  const list = await waiting('scihead');
  const head = await as('scihead');
  const first = list[0];

  const page = await head.get(`/s/${first.id}`);
  assert.match(page.text, /ข้ามไปก่อน/, 'มีปุ่มบนหัวงาน');

  const r = await head.post(`/s/${first.id}/skip`);
  assert.equal(r.status, 302);
  assert.notEqual(r.location, `/s/${first.id}`, 'งานที่ข้ามไม่ถูกเรียกเป็นงานถัดไป');

  const inbox = await head.get('/inbox');
  assert.match(inbox.text, /งานที่ข้ามไว้/);
  assert.match(inbox.text, new RegExp(`/s/${first.id}/unskip`));
  assert.doesNotMatch(inbox.text, new RegExp(`name="ids" value="${first.id}"`), 'งานที่ข้ามไม่มีช่องติ๊กลงนามหลายรายการ');
  assert.equal((await waiting('scihead')).find((s) => s.id === first.id).status, 'pending', 'งานยังรอที่ระดับเดิม');

  const opened = await head.get(`/s/${first.id}`);
  assert.match(opened.text, /เอากลับมาตรวจ/, 'เปิดงานที่ข้ามแล้วมีปุ่มเอากลับ');

  const back = await head.post(`/s/${first.id}/unskip`);
  assert.equal(back.location, '/inbox');
  assert.equal(await skipCount(), 0);
  assert.doesNotMatch((await head.get('/inbox')).text, /งานที่ข้ามไว้/);
});

test('ผู้ดูแลระบบข้ามงานแยกรายคน ผู้ตรวจอื่นไม่ได้รับผล และงานที่ไม่ได้รอตัวเองข้ามไม่ได้', async () => {
  const list = await waiting('scihead');
  const head = await as('scihead');
  await head.post(`/s/${list[0].id}/skip`);
  const admin = await as('admin');
  const before = await skipCount();
  await admin.post(`/s/${list[0].id}/skip`);
  assert.equal(await skipCount(), before, 'ผู้ดูแลที่ไม่ได้เป็นผู้ตรวจงานนี้ข้ามไม่ได้');
  await head.post(`/s/${list[0].id}/unskip`);
});

test('ส่งกลับแล้วครูส่งฉบับใหม่ งานกลับเข้าคิวปกติ', async () => {
  const list = await waiting('scihead');
  const sub = list[0];
  const head = await as('scihead');
  await head.post(`/s/${sub.id}/skip`);
  assert.equal(await skipCount(), 1);
  const user = await db.q.get('SELECT * FROM users WHERE username = ?', 'scihead');
  await wf.sendBack(sub.id, { ...user, roles: (await db.q.all('SELECT role FROM user_roles WHERE user_id = ?', user.id)).map((r) => r.role) }, { comment: 'ทดสอบส่งกลับ' });
  const teacher = await db.q.get('SELECT * FROM users WHERE id = ?', sub.teacher_id);
  await wf.submit(sub.id, { ...teacher, roles: [] });
  assert.equal(await skipCount(), 0, 'ส่งใหม่แล้วล้างการข้าม');
});

test('บันทึกหลังแผนทั้งเล่ม: ข้ามทั้งเล่ม คิวเล่มไม่วนกลับ ลงนามทั้งหมดไม่โดนเล่มที่ข้าม', async () => {
  const note = await db.q.get("SELECT parent_id, department_id FROM submissions WHERE doc_type = 'note' AND status = 'pending' AND current_role = 'dept_head' AND parent_id IS NOT NULL ORDER BY id LIMIT 1");
  assert.ok(note, 'ข้อมูลทดลองต้องมีบันทึกหลังแผนรอหัวหน้ากลุ่มสาระ');
  const who = await db.q.get("SELECT u.username FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'dept_head' WHERE u.department_id = ?", note.department_id);
  await setAdmin(who.username, true);
  const head = await as(who.username);
  const page = await head.get(`/s/${note.parent_id}/book`);
  assert.match(page.text, /ข้ามไปก่อน/);
  await head.post(`/s/${note.parent_id}/book/skip`);
  const inbox = await head.get('/inbox');
  assert.match(inbox.text, new RegExp(`/s/${note.parent_id}/book/unskip`));
  const qs = await head.get('/quicksign');
  assert.notEqual(qs.location, `/s/${note.parent_id}/book`, 'หน้าไล่ลงนามไม่เปิดเล่มที่ข้าม');
  await head.post(`/s/${note.parent_id}/book/unskip`);
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM review_skips WHERE kind = ?', 'book')).n, 0);
});

test('ปิดสวิตช์ ไม่มีปุ่ม คิวกลับเป็นแบบเดิม เปิดใหม่งานที่ข้ามไว้ยังอยู่', async () => {
  const list = await waiting('scihead');
  const head = await as('scihead');
  await head.post(`/s/${list[0].id}/skip`);
  assert.equal(await skipCount(), 1);
  const admin = await as('admin');
  await admin.post('/admin/features/skipwork', { on: '0' });
  assert.doesNotMatch((await head.get(`/s/${list[0].id}`)).text, /ข้ามไปก่อน|เอากลับมาตรวจ/);
  assert.doesNotMatch((await head.get('/inbox')).text, /งานที่ข้ามไว้/);
  const before = await skipCount();
  await head.post(`/s/${list[1] ? list[1].id : list[0].id}/skip`);
  assert.equal(await skipCount(), before, 'ปิดสวิตช์แล้วกดไม่ได้');
  await admin.post('/admin/features/skipwork', { on: '1' });
  assert.match((await head.get('/inbox')).text, /งานที่ข้ามไว้/);
});
