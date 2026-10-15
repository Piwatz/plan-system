// ทดสอบส่งบันทึกหลังแผนทั้งเล่ม (ฟังก์ชันเสริม notebook) และบันทึกหลังแผนแนบได้เฉพาะ PDF (notepdf)
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-book-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const { sendForm } = require('./upload-client');
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
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), ...headers } });
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
    const body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body);
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const planOf = async (code) => (await db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = ?", code)).id;
const statusOf = async (id) => db.q.get('SELECT status, current_role, returned_role, teacher_signature FROM submissions WHERE id = ?', id);
const notesWhere = async (planId, sql, ...p) =>
  (await db.q.all(`SELECT id FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND ${sql} ORDER BY id`, planId, ...p)).map((r) => r.id);
const lastReview = (id) => db.q.get('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1', id);
const pdf = () => new Blob(['%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'], { type: 'application/pdf' });
const png = () => new Blob([Buffer.from('\x89PNG\r\n\x1a\nxxxx', 'latin1')]);

// ฟอร์มหน้าลงนามทั้งเล่ม: ทุกแผ่นที่เห็น + ความเห็นรายแผ่น + แผ่นที่ต้องแก้
function bookForm(ids, comments = {}, fix = []) {
  const f = new URLSearchParams();
  for (const id of ids) {
    f.append('ids', String(id));
    f.append(`comment_${id}`, comments[id] ?? 'รับทราบ');
  }
  for (const id of fix) f.append('fix', String(id));
  return f;
}

test('ส่งทั้งเล่ม: ร่างผู้ตรวจไม่เห็น ส่งทีละฉบับไม่ได้ ส่งทั้งเล่มครั้งเดียว ขาดแผ่นไหนไม่ส่งสักแผ่น', async () => {
  const t = await as('teacher');
  const head = await as('scihead');
  const planId = await planOf('ว30203');

  const form = (await t.get(`/notes/new?plan=${planId}`)).text;
  assert.doesNotMatch(form, /name="action" value="submit"/, 'เปิดส่งทั้งเล่ม ฟอร์มต้องไม่มีปุ่มส่งทีละฉบับ');
  assert.match(form, /ส่งทั้งเล่ม/);

  const r1 = await t.post('/notes', { plan_id: String(planId), plan_no: '41', topic: 'ร่างที่หนึ่ง', result_k: 'เข้าใจ', action: 'submit' });
  assert.equal(r1.location, `/s/${planId}#notes`, 'บันทึกแล้วกลับไปหน้าแผน');
  const id41 = (await notesWhere(planId, "plan_no = '41'"))[0];
  assert.equal((await statusOf(id41)).status, 'draft', 'กดส่งในฟอร์มต้องเป็นแค่บันทึกร่าง');
  await t.post('/notes', { plan_id: String(planId), plan_no: '42', topic: 'ร่างที่สอง', action: 'draft' });
  const id42 = (await notesWhere(planId, "plan_no = '42'"))[0];

  // ร่างผู้ตรวจไม่เห็น และส่งทีละฉบับไม่ได้
  assert.doesNotMatch((await head.get('/inbox')).text, /ร่างที่หนึ่ง/);
  await t.post(`/s/${id41}/submit`, {});
  assert.equal((await statusOf(id41)).status, 'draft');
  await t.post('/notes/submit-many', { ids: String(id41) });
  assert.equal((await statusOf(id41)).status, 'draft');

  // แผ่นที่ 42 ยังไม่กรอกผล ส่งทั้งเล่มไม่ได้ และไม่มีแผ่นไหนถูกส่ง
  const todo = await notesWhere(planId, "status IN ('draft', 'returned')");
  assert.ok(todo.length >= 3, 'มีร่างและฉบับส่งกลับจากข้อมูลทดลองด้วย');
  await t.post(`/s/${planId}/submit-book`, {});
  for (const id of todo) assert.notEqual((await statusOf(id)).status, 'pending');
  const plan = (await t.get(`/s/${planId}`)).text;
  assert.match(plan, /submit-book/);
  assert.match(plan, new RegExp(`ส่งทั้งเล่ม \\(${todo.length} แผ่น\\)`));

  // แก้ให้ครบแล้วส่งทั้งเล่ม ทุกแผ่นไปรอหัวหน้ากลุ่มสาระพร้อมลายเซ็นครู
  await t.post(`/s/${id42}`, { plan_no: '42', topic: 'ร่างที่สอง', result_k: 'ทำแบบฝึกได้', action: 'draft' });
  const r = await t.post(`/s/${planId}/submit-book`, {});
  assert.equal(r.location, `/s/${planId}#notes`);
  for (const id of todo) {
    const s = await statusOf(id);
    assert.equal(s.status, 'pending', `แผ่น ${id}`);
    assert.equal(s.current_role, 'dept_head');
    assert.ok(s.teacher_signature, 'ลายเซ็นครูอยู่ทุกแผ่น');
    const rv = await lastReview(id);
    assert.ok(['submit', 'resubmit'].includes(rv.action));
    assert.ok(rv.signature);
  }
  assert.equal((await lastReview(id41)).action, 'submit');
});

test('ผู้ตรวจเห็นงานเดียวต่อเล่ม ส่งกลับทั้งเล่มบอกแผ่นที่ต้องแก้ ลงนามครั้งเดียวขึ้นทุกแผ่น', async () => {
  const t = await as('teacher');
  const head = await as('scihead');
  const planId = await planOf('ว30203');
  const sheets = await notesWhere(planId, "status = 'pending' AND current_role = 'dept_head'");
  assert.ok(sheets.length >= 4);

  // งานรอตรวจ: เล่มนี้เป็นแถวเดียว ตัวเลขบนเมนูนับเป็นเล่ม
  const inbox = (await head.get('/inbox')).text;
  assert.equal(inbox.match(new RegExp(`href="/s/${planId}/book"`, 'g')).length, 2, 'แถวเดียวต่อเล่ม (มือถือ 1 จอใหญ่ 1)');
  const boxes = [...inbox.matchAll(/name="ids" value="([\d,]+)"/g)].map((m) => m[1].split(',').map(Number).sort((x, y) => x - y).join(','));
  assert.ok(boxes.includes(sheets.join(',')), 'ช่องเลือกของเล่มมีทุกแผ่น');
  for (const id of sheets) assert.doesNotMatch(inbox, new RegExp(`href="/s/${id}"`));
  const w = wf.inboxWhere({ ...(await db.q.get("SELECT id, department_id FROM users WHERE username = 'scihead'")), roles: ['dept_head'] }, 'i');
  const rows = await db.q.all(`SELECT i.* FROM submissions i WHERE ${w.sql}`, ...w.params);
  assert.match(inbox, new RegExp(`<span class="count amber">${wf.groupBooks(rows).length}</span>`));

  // หน้าลงนามทั้งเล่ม ทุกแผ่นตั้งความเห็นไว้ รับทราบ
  const page = (await head.get(`/s/${planId}/book`)).text;
  for (const id of sheets) assert.match(page, new RegExp(`name="comment_${id}" value="รับทราบ"`));
  // ลงนามทีละฉบับไม่ได้ หน้าฉบับเดียวพาไปหน้าทั้งเล่ม
  await head.post(`/s/${sheets[0]}/approve`, { comment: 'รับทราบ' });
  assert.equal((await statusOf(sheets[0])).current_role, 'dept_head');
  const one = (await head.get(`/s/${sheets[0]}`)).text;
  assert.match(one, new RegExp(`/s/${planId}/book`));
  assert.doesNotMatch(one, /id="review-form"/);

  // ส่งกลับ: ต้องติ๊กแผ่นและเขียนสิ่งที่ต้องแก้
  await head.post(`/s/${planId}/book/return`, bookForm(sheets));
  assert.equal((await statusOf(sheets[0])).status, 'pending');
  await head.post(`/s/${planId}/book/return`, bookForm(sheets, {}, [sheets[1]]));
  assert.equal((await statusOf(sheets[0])).status, 'pending', 'ติ๊กแล้วแต่ความเห็นยังเป็น รับทราบ ต้องส่งกลับไม่ได้');
  const back = await head.post(`/s/${planId}/book/return`, bookForm(sheets, { [sheets[1]]: 'เพิ่มผลด้านทักษะ' }, [sheets[1]]));
  assert.equal(back.location, '/inbox');
  for (const id of sheets) {
    const s = await statusOf(id);
    assert.equal(s.status, 'returned');
    assert.equal(s.returned_role, 'dept_head');
    const rv = await lastReview(id);
    assert.equal(rv.action, 'return');
    if (id === sheets[1]) assert.equal(rv.comment, 'เพิ่มผลด้านทักษะ');
    else assert.ok(rv.comment.startsWith(wf.BOOK_KEEP));
  }
  const plan = (await t.get(`/s/${planId}`)).text;
  assert.match(plan, /ต้องแก้<\/span> <span class="muted">เพิ่มผลด้านทักษะ/);
  assert.match(plan, /ไม่ต้องแก้/);

  // ครูส่งทั้งเล่มอีกครั้ง กลับไปที่หัวหน้ากลุ่มสาระโดยตรง
  await t.post(`/s/${planId}/submit-book`, {});
  for (const id of sheets) {
    assert.equal((await statusOf(id)).current_role, 'dept_head');
    assert.equal((await lastReview(id)).action, 'resubmit');
  }

  // แผ่นที่เพิ่งส่งมาหลังเปิดหน้า ไม่ถูกลงนามไปด้วย
  const seen = sheets.slice(1);
  const ok = await head.post(`/s/${planId}/book/approve`, bookForm(seen, { [seen[0]]: 'ดีมาก เป็นแบบอย่างได้' }));
  assert.equal(ok.status, 302);
  assert.equal((await statusOf(sheets[0])).current_role, 'dept_head');
  for (const id of seen) {
    assert.equal((await statusOf(id)).current_role, 'deputy_academic');
    const rv = (await db.q.all("SELECT * FROM reviews WHERE submission_id = ? AND action = 'approve' ORDER BY id DESC LIMIT 1", id))[0];
    assert.equal(rv.comment, id === seen[0] ? 'ดีมาก เป็นแบบอย่างได้' : 'รับทราบ');
    assert.ok(rv.signature, 'ลายเซ็นผู้ตรวจขึ้นทุกแผ่น');
  }
  // หน้าพิมพ์ทั้งเล่มมีลายเซ็นของหัวหน้ากลุ่มสาระทุกแผ่นที่ลงนาม
  const print = (await t.get(`/s/${planId}/print-notes`)).text;
  assert.ok(print.length > 1000);

  // รองผู้อำนวยการ ไล่ลงนามพาไปหน้าทั้งเล่ม
  const dep = await as('deputy');
  const qs = await dep.get('/quicksign');
  assert.equal(qs.status, 302);
  assert.match(qs.location, /^\/s\/\d+\/book$/);
  await dep.post(`/quicksign/${seen[0]}/approve`, { comment: 'x' });
  assert.equal((await statusOf(seen[0])).current_role, 'deputy_academic', 'ไล่การ์ดทีละฉบับต้องลงนามไม่ได้');

  // คนที่ไม่ใช่ผู้ตรวจของเล่มนี้ ลงนามไม่ได้
  const other = await as('mathhead');
  await other.post(`/s/${planId}/book/approve`, bookForm([sheets[0]]));
  assert.equal((await statusOf(sheets[0])).current_role, 'dept_head');
});

test('ผู้ดูแลระบบส่งทั้งเล่มแทนครูได้ ไม่ใส่ลายเซ็นครู · ปิดสวิตช์แล้วกลับเป็นแบบทีละฉบับ', async () => {
  const t = await as('teacher');
  const admin = await as('admin');
  const planId = await planOf('ว30203');
  await t.post('/notes', { plan_id: String(planId), plan_no: '51', result_k: 'เข้าใจ', action: 'draft' });
  const id = (await notesWhere(planId, "plan_no = '51'"))[0];
  assert.match((await admin.get(`/s/${planId}`)).text, /ส่งทั้งเล่มแทนครู/);
  await admin.post(`/s/${planId}/submit-book`, {});
  const s = await statusOf(id);
  assert.equal(s.status, 'pending');
  assert.equal(s.teacher_signature, null, 'ห้ามใส่ลายเซ็นครูแทน');
  const rv = await lastReview(id);
  assert.equal(rv.step_label, 'ผู้ดูแลระบบส่งแทนครู');
  assert.equal(rv.signature, null);

  await admin.post('/admin/features/notebook', { on: '0' });
  const head = await as('scihead');
  const inbox = (await head.get('/inbox')).text;
  assert.match(inbox, new RegExp(`href="/s/${id}"`), 'ปิดแล้วเห็นทีละฉบับ');
  assert.doesNotMatch(inbox, /\/book"/);
  assert.equal((await head.get(`/s/${planId}/book`)).status, 400);
  assert.match((await t.get(`/notes/new?plan=${planId}`)).text, /name="action" value="submit"/);
  await admin.post('/admin/features/notebook', { on: '1' });
});

test('บันทึกหลังแผนแนบได้เฉพาะ PDF ปิดสวิตช์แล้วแนบรูปได้', async () => {
  const t = await as('teacher');
  const admin = await as('admin');
  const planId = await planOf('ว30203');
  const send = (no, files) => sendForm(t, '/notes', { plan_id: String(planId), plan_no: no, result_k: 'เข้าใจ', action: 'draft' }, files, { field: 'attach_files' });
  const form = (await t.get(`/notes/new?plan=${planId}`)).text;
  assert.match(form, /accept="\.pdf"/);
  assert.match(form, /data-accept="pdf"/);
  const bad = await send('61', [[png(), 'ภาพ.png']]);
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /เฉพาะไฟล์ PDF/);
  assert.deepEqual(await notesWhere(planId, "plan_no = '61'"), []);
  assert.equal((await send('62', [[pdf(), 'ใบงาน.pdf']])).status, 200);

  await admin.post('/admin/features/notepdf', { on: '0' });
  assert.equal((await send('63', [[png(), 'ภาพ.png']])).status, 200);
  await admin.post('/admin/features/notepdf', { on: '1' });
});
