// ทดสอบหน้าปก: ติ๊กยืนยันหน้าปกก่อนส่ง · ปุ่มเพิ่มหน้าปกให้งานที่ส่งแล้ว (ครูและผู้ดูแลระบบ) · ผู้ดูแลระบบส่งกลับแทนผู้ตรวจ
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cover-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const { uploadOne, sendForm, XHR } = require('./upload-client');

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
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

async function pdf(pages) {
  const doc = await PDFDocument.create();
  doc.setSubject(`ไฟล์ทดลอง ${Math.random()}`); // ไฟล์ไม่ซ้ำกัน (ฟังก์ชันเสริม dupfile ไม่ให้ส่งไฟล์เดียวกันสองงาน)
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const subOf = (id) => db.q.get('SELECT id, status, current_role, returned_role, teacher_id FROM submissions WHERE id = ?', id);
const currentFiles = (id) => db.q.all("SELECT id, original_name FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1", id);

test('ติ๊กยืนยันหน้าปกก่อนส่ง: ไม่ติ๊กบันทึกร่างไว้แต่ไม่ส่ง ติ๊กแล้วส่งได้ ปิดสวิตช์แล้วไม่ถาม', async () => {
  const t = await as('sci2');
  const page = (await t.get('/works/new?type=manual')).text;
  assert.match(page, /name="cover_ok" value="1">/);
  assert.match(page, /data-need-checked="cover_ok"/);
  const fields = { doc_type: 'manual', subject_code: 'ว30199', subject_name: 'ทดสอบปก', grade_level: 'ม.4', doc_no: 'วก.1/2569', action: 'submit', cover_check: '1' };
  let r = await sendForm(t, '/works', fields, [[await pdf(2), 'คู่มือ.pdf']]);
  const id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  assert.equal((await subOf(id)).status, 'draft', 'ไม่ติ๊ก ยังไม่ส่ง');
  assert.match((await t.get(`/s/${id}`)).text, /ติ๊กยืนยันก่อนว่าไฟล์นี้มีหน้าปก/, 'หน้างานมีช่องติ๊กก่อนส่ง');
  r = await t.post(`/s/${id}/submit`, { cover_check: '1' });
  assert.equal((await subOf(id)).status, 'draft');
  r = await t.post(`/s/${id}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(id)).status, 'pending', 'ติ๊กแล้วส่งได้');

  await db.setSetting('ff_coverconfirm', '0');
  assert.doesNotMatch((await t.get('/works/new?type=manual')).text, /name="cover_ok"/);
  await db.setSetting('ff_coverconfirm', '1');
});

test('เพิ่มหน้าปก: ครูเพิ่มเองได้ระหว่างรอตรวจ ไฟล์ใหม่แทน ไฟล์เดิมเป็นประวัติ ขั้นการตรวจไม่เปลี่ยน คนอื่นทำไม่ได้', async () => {
  const t = await as('sci2');
  const sub = await db.q.get(
    "SELECT s.id, s.current_role FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE u.username = 'sci2' AND s.status = 'pending' AND s.doc_type IN ('manual', 'plan') ORDER BY s.id LIMIT 1"
  );
  assert.ok(sub, 'ครูทดลองมีงานรอตรวจ');
  const before = await currentFiles(sub.id);
  assert.match((await t.get(`/s/${sub.id}`)).text, /data-add-cover/);

  // ครูคนอื่นเริ่มส่งไฟล์ปกให้งานนี้ไม่ได้
  const other = await as('teacher');
  const stolen = await uploadOne(other, await pdf(3), 'merged.pdf', { form: `/s/${sub.id}/cover`, field: 'main_files', merged: '2' });
  assert.equal(typeof stolen, 'object');

  const token = await uploadOne(t, await pdf(3), 'merged.pdf', { form: `/s/${sub.id}/cover`, field: 'main_files', merged: '2' });
  assert.equal(typeof token, 'string', JSON.stringify(token));
  const r = await t.req('POST', `/s/${sub.id}/cover`, new URLSearchParams({ upload_main_files: token }), XHR);
  assert.equal(r.status, 200, r.text);
  const after = await subOf(sub.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.current_role, sub.current_role, 'ยังรอผู้ตรวจขั้นเดิม');
  const now = await currentFiles(sub.id);
  assert.equal(now.length, 1);
  assert.ok(!before.some((f) => f.id === now[0].id));
  const old = await db.q.get('SELECT is_current FROM files WHERE id = ?', before[0].id);
  assert.equal(old.is_current, 0, 'ไฟล์เดิมเก็บเป็นประวัติ');
  const rev = await db.q.get("SELECT step_label FROM reviews WHERE submission_id = ? AND action = 'cover' ORDER BY id DESC LIMIT 1", sub.id);
  assert.equal(rev.step_label, 'ครูผู้สอน');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'เพิ่มหน้าปก%'"));
  assert.match((await t.get(`/s/${sub.id}`)).text, /เพิ่มหน้าปก \(ไฟล์เดิมเก็บไว้ในประวัติ\)/);
});

test('เพิ่มหน้าปก: งานที่ผ่านครบแล้วครูทำเองไม่ได้ ผู้ดูแลระบบเพิ่มแทนได้ทุกขั้น', async () => {
  const done = await db.q.get(
    "SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.status = 'approved' AND s.doc_type IN ('manual', 'plan') AND u.is_admin = 0 ORDER BY s.id LIMIT 1"
  );
  const owner = await as(done.username);
  assert.doesNotMatch((await owner.get(`/s/${done.id}`)).text, /data-add-cover/);
  const no = await uploadOne(owner, await pdf(2), 'merged.pdf', { form: `/s/${done.id}/cover`, field: 'main_files', merged: '2' });
  assert.equal(typeof no, 'object');

  const a = await as('admin');
  assert.match((await a.get(`/s/${done.id}`)).text, /เพิ่มหน้าปกแทนครู/);
  const token = await uploadOne(a, await pdf(2), 'merged.pdf', { form: `/s/${done.id}/cover`, field: 'main_files', merged: '2' });
  assert.equal(typeof token, 'string');
  const r = await a.req('POST', `/s/${done.id}/cover`, new URLSearchParams({ upload_main_files: token }), XHR);
  assert.equal(r.status, 200, r.text);
  assert.equal((await subOf(done.id)).status, 'approved', 'ยังผ่านครบเหมือนเดิม');
  const rev = await db.q.get("SELECT step_label FROM reviews WHERE submission_id = ? AND action = 'cover' ORDER BY id DESC LIMIT 1", done.id);
  assert.equal(rev.step_label, 'ผู้ดูแลระบบ');
});

test('ผู้ดูแลระบบส่งกลับแทนผู้ตรวจ: ต้องเขียนเหตุผล ครูส่งใหม่แล้วกลับมารอขั้นเดิม ปิดสวิตช์แล้วไม่มีปุ่ม', async () => {
  const sub = await db.q.get(
    "SELECT s.id, s.current_role, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.status = 'pending' AND s.doc_type IN ('manual', 'plan') AND u.is_admin = 0 ORDER BY s.id DESC LIMIT 1"
  );
  const a = await as('admin');
  assert.match((await a.get(`/s/${sub.id}`)).text, new RegExp(`formaction="/s/${sub.id}/admin-return"`));
  await a.post(`/s/${sub.id}/admin-return`, { comment: '' });
  assert.equal((await subOf(sub.id)).status, 'pending', 'ไม่เขียนเหตุผล ส่งกลับไม่ได้');
  const r = await a.post(`/s/${sub.id}/admin-return`, { comment: 'กรุณาเพิ่มหน้าปก' });
  assert.equal(r.status, 302);
  const back = await subOf(sub.id);
  assert.equal(back.status, 'returned');
  assert.equal(back.returned_role, sub.current_role);
  const rev = await db.q.get("SELECT step_label, comment FROM reviews WHERE submission_id = ? AND action = 'return' ORDER BY id DESC LIMIT 1", sub.id);
  assert.match(rev.step_label, /^ผู้ดูแลระบบส่งกลับแทน/);
  assert.equal(rev.comment, 'กรุณาเพิ่มหน้าปก');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ส่งกลับแทน%'"));

  const t = await as(sub.username);
  await t.post(`/s/${sub.id}/submit`, { cover_check: '1', cover_ok: '1' });
  const again = await subOf(sub.id);
  assert.equal(again.status, 'pending');
  assert.equal(again.current_role, sub.current_role, 'กลับมารอขั้นเดิม');

  await db.setSetting('ff_adminreturn', '0');
  assert.doesNotMatch((await a.get(`/s/${sub.id}`)).text, /admin-return/);
  await db.setSetting('ff_adminreturn', '1');
});

test('เปลี่ยนปก: ลบหน้าที่ติ๊กแล้วต่อปกใหม่ (รูปปกที่ระบบวาด หรือไฟล์ปก) เหลือหน้าถูก ลบทุกหน้าไม่ได้', async () => {
  const { editFront } = require('../public/js/pdfmerge');
  const PDFLib = require('pdf-lib');
  const src = await PDFLib.PDFDocument.create();
  for (const w of [301, 302, 303, 304]) src.addPage([w, 400]);
  const bytes = await src.save();
  const widths = async (b) => (await PDFLib.PDFDocument.load(b)).getPages().map((p) => Math.round(p.getWidth()));
  // ปกผิด 2 หน้า ลบหน้า 1 และ 2 แล้วต่อรูปปก A4
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let r = await editFront(PDFLib, bytes, { remove: [2, 1], coverPng: png });
  assert.deepEqual(await widths(r.bytes), [595, 303, 304]);
  assert.equal(r.removed, 2);
  assert.equal(r.added, 1);
  // ลบเฉพาะหน้า 2 ไม่ต่อปก
  r = await editFront(PDFLib, bytes, { remove: [2] });
  assert.deepEqual(await widths(r.bytes), [301, 303, 304]);
  // ต่อไฟล์ปก 2 หน้าไว้หน้าแรก
  const cover = await PDFLib.PDFDocument.create();
  cover.addPage([500, 400]);
  cover.addPage([501, 400]);
  r = await editFront(PDFLib, bytes, { remove: [1], coverPdf: await cover.save() });
  assert.deepEqual(await widths(r.bytes), [500, 501, 302, 303, 304]);
  await assert.rejects(editFront(PDFLib, bytes, { remove: [1, 2, 3, 4] }), /ลบทุกหน้าไม่ได้/);
});

test('เปลี่ยนปก: ผู้ดูแลระบบต่อปกที่ระบบวาดในงานที่ผ่านครบได้ ครูต่อปกที่ระบบวาดไม่ได้ บันทึกประวัติและ audit_log ปิดสวิตช์แล้วไม่มีปุ่ม', async () => {
  const done = await db.q.get(
    "SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.status = 'approved' AND s.doc_type IN ('manual', 'plan') AND u.is_admin = 0 ORDER BY s.id DESC LIMIT 1"
  );
  const a = await as('admin');
  const page = (await a.get(`/s/${done.id}`)).text;
  assert.match(page, /data-front-open="front-dlg"/);
  assert.match(page, /เปลี่ยนปกแทนครู/);
  assert.match(page, /data-front-drawn>\s*<span class="lib-cover drawn cv cv-d/, 'มีปกที่ระบบวาดแบบที่เลือกไว้ (ค่าเริ่มต้นแบบ ง)');
  assert.match(page, /school-logo\.png/, 'ตราใช้รูปใหญ่');

  // เจ้าของงานที่ผ่านครบแล้วไม่มีปุ่ม
  const owner = await as(done.username);
  assert.doesNotMatch((await owner.get(`/s/${done.id}`)).text, /data-front-open/);

  const token = await uploadOne(a, await pdf(3), 'merged.pdf', { form: `/s/${done.id}/cover`, field: 'main_files', merged: '2' });
  const r = await a.req('POST', `/s/${done.id}/cover`, new URLSearchParams({ front: '1', removed: '2,1,x', drawn: '1', upload_main_files: token }), XHR);
  assert.equal(r.status, 200, r.text);
  assert.equal((await subOf(done.id)).status, 'approved', 'ยังผ่านครบเหมือนเดิม');
  const rev = await db.q.get("SELECT step_label, comment FROM reviews WHERE submission_id = ? AND action = 'frontpages' ORDER BY id DESC LIMIT 1", done.id);
  assert.equal(rev.step_label, 'ผู้ดูแลระบบ');
  assert.equal(rev.comment, 'ลบหน้า 1, 2 แล้วต่อปกที่ระบบวาด');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'เปลี่ยนปก%ต่อปกที่ระบบวาด'"));
  assert.match((await a.get(`/s/${done.id}`)).text, /เปลี่ยนปก \(ไฟล์เดิมเก็บไว้ในประวัติ\)/);

  // ครูเปลี่ยนปกงานที่รอตรวจของตัวเองได้ แต่ต่อปกที่ระบบวาดไม่ได้
  const mine = await db.q.get(
    "SELECT s.id FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE u.username = 'sci2' AND s.status = 'pending' AND s.doc_type IN ('manual', 'plan') ORDER BY s.id LIMIT 1"
  );
  const t = await as('sci2');
  const tp = (await t.get(`/s/${mine.id}`)).text;
  assert.match(tp, /data-front-open/);
  assert.doesNotMatch(tp, /data-front-drawn/);
  let tk = await uploadOne(t, await pdf(2), 'merged.pdf', { form: `/s/${mine.id}/cover`, field: 'main_files', merged: '2' });
  let x = await t.req('POST', `/s/${mine.id}/cover`, new URLSearchParams({ front: '1', drawn: '1', upload_main_files: tk }), XHR);
  assert.notEqual(x.status, 200);
  tk = await uploadOne(t, await pdf(2), 'merged.pdf', { form: `/s/${mine.id}/cover`, field: 'main_files', merged: '2' });
  x = await t.req('POST', `/s/${mine.id}/cover`, new URLSearchParams({ front: '1', removed: '1', upload_main_files: tk }), XHR);
  assert.equal(x.status, 200, x.text);
  const tr = await db.q.get("SELECT step_label, comment FROM reviews WHERE submission_id = ? AND action = 'frontpages' ORDER BY id DESC LIMIT 1", mine.id);
  assert.equal(tr.step_label, 'ครูผู้สอน');
  assert.equal(tr.comment, 'ลบหน้า 1');

  await db.setSetting('ff_coverpdf', '0');
  assert.doesNotMatch((await a.get(`/s/${done.id}`)).text, /data-front-open/);
  tk = await uploadOne(a, await pdf(2), 'merged.pdf', { form: `/s/${done.id}/cover`, field: 'main_files', merged: '2' });
  x = await a.req('POST', `/s/${done.id}/cover`, new URLSearchParams({ front: '1', removed: '1', upload_main_files: tk }), XHR);
  assert.notEqual(x.status, 200);
  await db.setSetting('ff_coverpdf', '1');
});
