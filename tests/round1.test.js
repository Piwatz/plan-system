// ทดสอบกติกาการส่งรอบ 1: รายวิชาที่สอน แผน 1 วิชาหลัก PDF ไฟล์เดียว ตัวรวม PDF และการลงนามงานของตัวเอง
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-r1-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const { sendForm } = require('./upload-client');
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
    const body = fields instanceof FormData ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body);
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const uid = async (username) => (await db.q.get('SELECT id FROM users WHERE username = ?', username)).id;
const teachRow = async (username, code) => (await db.q.get('SELECT * FROM teach_subjects WHERE teacher_id = ? AND subject_code = ?', (await uid(username)), code));

// PDF จริงจำนวน n หน้า ขนาดหน้ากว้าง width ใช้แยกว่าหน้าไหนมาจากไฟล์ไหน
async function realPdf(n, width) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([width, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

// ส่งงานแบบหน้าเว็บ: หลาย PDF รวมในเบราว์เซอร์ก่อนส่งเมื่อเปิดตัวรวม (ช่องไฟล์มี data-sortable)
async function sendWork(c, url, fields, files) {
  const merge = (await db.q.get("SELECT value FROM settings WHERE key = 'ff_pdfmerge'")).value === '1';
  return sendForm(c, url, fields, files, { merge });
}

test('หน้าสถานะกลุ่มสาระนับคู่มือครบตามรายวิชาที่สอน และแผนเฉพาะวิชาหลัก', async () => {
  const head = await as('scihead');
  const page = (await head.get('/dept')).text;
  // ครูพิมพ์ใจสอน 2 วิชา (ว21101 วิชาหลัก ส่งแล้ว และ ว22201 ยังไม่ส่งคู่มือ)
  const row = page.split('<tr>').find((x) => x.includes('นางสาวพิมพ์ใจ รักเรียน'));
  assert.ok(row);
  assert.match(row, /ส่ง 1 จาก 2/, 'คู่มือส่ง 1 จาก 2 วิชา');
  assert.match(row, /ว21101/);
  assert.match(row, /ว22201/);
});

test('หน้าแรกครู: วิชาที่ไม่ใช่วิชาหลักไม่ต้องส่งแผน วิชาที่สอนแต่ยังไม่ส่งคู่มือขึ้นเป็นงานค้าง', async () => {
  const t = await as('teacher');
  const home = (await t.get('/')).text;
  assert.match(home, /ไม่ต้องส่ง/);
  assert.match(home, /คู่มือ ว31101 ยังไม่ส่ง/);
  assert.doesNotMatch(home, /แผน ว30207 ยังไม่ส่ง/);
  assert.match(home, /href="\/works\/new\?type=manual&amp;code=%E0%B8%A731101"/, 'ลิงก์ส่งคู่มือเติมรหัสวิชาให้');
  const form = (await t.get('/works/new?type=manual&code=' + encodeURIComponent('ว31101'))).text;
  assert.match(form, /value="วิทยาศาสตร์กายภาพ"/, 'ชื่อวิชาเติมให้จากรายวิชาที่สอน');
  assert.match(form, /accept=".pdf,application\/pdf/);
  assert.match(form, /data-sortable/);
});

test('แผน 1 วิชาหลักต่อภาค ผู้ดูแลเพิ่มจำนวนให้บางคนได้', async () => {
  const t = await as('sci2');
  assert.equal((await t.get('/works/new?type=plan')).status, 400);
  const pdf = await realPdf(1, 300);
  let r = await sendWork(t, '/works', { doc_type: 'plan', subject_code: 'ว22201', subject_name: 'โครงงานวิทยาศาสตร์ 1', grade_level: 'ม.2', action: 'draft' }, [[pdf, 'แผน.pdf']]);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /ส่งแผนการจัดการเรียนรู้ได้ 1 วิชา/);
  assert.equal((await db.q.get("SELECT 1 AS x FROM submissions WHERE doc_type = 'plan' AND subject_code = 'ว22201'")), undefined);

  const admin = await as('admin');
  await admin.post(`/admin/users/${(await uid('sci2'))}/plan-quota`, { plan_quota: '2' });
  assert.equal((await db.q.get('SELECT plan_quota AS n FROM users WHERE id = ?', (await uid('sci2')))).n, 2);
  assert.ok((await db.q.get("SELECT 1 AS x FROM audit_log WHERE action ILIKE 'ตั้งจำนวนแผนต่อภาค%'")));
  r = await sendWork(t, '/works', { doc_type: 'plan', subject_code: 'ว22201', subject_name: 'โครงงานวิทยาศาสตร์ 1', grade_level: 'ม.2', action: 'draft' }, [[pdf, 'แผน.pdf']]);
  assert.equal(r.status, 200, r.text);
  assert.equal((await teachRow('sci2', 'ว22201')).is_main, 1, 'วิชาที่ส่งแผนกลายเป็นวิชาหลัก');
  await admin.post(`/admin/users/${(await uid('sci2'))}/plan-quota`, { plan_quota: '1' });

  // ปิดสวิตช์แล้วส่งแผนได้ทุกวิชาเหมือนเดิม
  await admin.post('/admin/features/onemain', { on: '0' });
  assert.equal((await t.get('/works/new?type=plan')).status, 200);
  await admin.post('/admin/features/onemain', { on: '1' });
});

test('แผนและคู่มือรับเฉพาะ PDF และรวมหลายไฟล์เป็นไฟล์เดียวตามลำดับที่เรียง', async () => {
  const t = await as('sci2');
  const base = { doc_type: 'manual', subject_code: 'ว30112', subject_name: 'ทดสอบรวมไฟล์', grade_level: 'ม.6', action: 'draft' };
  const word = new Blob(['PK\u0003\u0004 not really word'], { type: 'application/octet-stream' });
  let r = await sendWork(t, '/works', base, [[word, 'คู่มือ.docx']]);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /รับเฉพาะไฟล์ PDF/);

  r = await sendWork(t, '/works', base, [
    [await realPdf(1, 200), 'ปก.pdf'],
    [await realPdf(2, 300), 'เนื้อหา.pdf'],
  ]);
  assert.equal(r.status, 200, r.text);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  const files = (await db.q.all('SELECT * FROM files WHERE submission_id = ? AND is_current = 1', id));
  assert.equal(files.length, 1, 'เหลือไฟล์เดียว');
  assert.equal(files[0].original_name, 'คู่มือรายวิชา ว30112.pdf');
  const merged = await PDFDocument.load(fs.readFileSync(path.join(tmp, 'data-demo', 'files', files[0].stored_name.replace(/^local:/, ''))));
  assert.deepEqual(merged.getPages().map((p) => p.getWidth()), [200, 300, 300], 'ปกมาก่อน ตามด้วยเนื้อหา');
  assert.ok((await teachRow('sci2', 'ว30112')), 'ส่งคู่มือแล้ววิชานี้เข้าไปในรายวิชาที่สอน');
  assert.equal((await teachRow('sci2', 'ว30112')).is_main, 0);

  // แนบไฟล์ใหม่แทนไฟล์เดิม ไฟล์เดิมเก็บเป็นประวัติ
  r = await sendWork(t, `/s/${id}`, { ...base }, [[await realPdf(4, 250), 'ฉบับแก้.pdf']]);
  assert.equal(r.status, 200, r.text);
  const cur = (await db.q.all('SELECT * FROM files WHERE submission_id = ? AND is_current = 1', id));
  assert.equal(cur.length, 1);
  assert.equal(cur[0].original_name, 'ฉบับแก้.pdf');
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM files WHERE submission_id = ?', id)).n, 2);

  // งานเก่าที่แนบไว้หลายไฟล์ ส่งไม่ได้จนกว่าจะแนบ PDF ไฟล์เดียว
  await db.q.run("INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, 'main', 'เก่า.docx', 'x.docx', 'application/msword', 10, '2569-01-01')", id);
  await t.post(`/s/${id}/submit`, {});
  assert.equal((await db.q.get('SELECT status FROM submissions WHERE id = ?', id)).status, 'draft');

  // ปิดตัวรวม PDF แล้วแนบหลายไฟล์ไม่ได้
  const admin = await as('admin');
  await admin.post('/admin/features/pdfmerge', { on: '0' });
  r = await sendWork(t, '/works', { ...base, subject_code: 'ว30113' }, [
    [await realPdf(1, 200), 'ปก.pdf'],
    [await realPdf(1, 300), 'เนื้อหา.pdf'],
  ]);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /PDF ไฟล์เดียว/);
  await admin.post('/admin/features/pdfmerge', { on: '1' });
});

test('รายวิชาที่สอน: เพิ่ม ตั้งวิชาหลัก เอาออก และผู้ดูแลแก้แทนครูได้', async () => {
  const t = await as('teacher');
  assert.equal((await t.get('/teaching')).status, 200);
  await t.post('/teaching/add', { subject_code: 'ว30299', subject_name: 'วิชาทดลอง', grade_level: 'ม.6' });
  const row = (await teachRow('teacher', 'ว30299'));
  assert.ok(row);
  assert.equal(row.is_main, 0);
  // ส่งแผนวิชาหลักไปแล้ว ตั้งวิชาอื่นเป็นวิชาหลักแทนไม่ได้
  await t.post(`/teaching/${row.id}/main`, {});
  assert.equal((await teachRow('teacher', 'ว30299')).is_main, 0);
  // วิชาที่มีงานแล้วเอาออกไม่ได้ วิชาที่ยังไม่มีงานเอาออกได้
  await t.post(`/teaching/${(await teachRow('teacher', 'ว30203')).id}/delete`, {});
  assert.ok((await teachRow('teacher', 'ว30203')));
  await t.post(`/teaching/${row.id}/delete`, {});
  assert.equal((await teachRow('teacher', 'ว30299')), undefined);

  // ครูที่ยังไม่มีแผน เลือกวิชาหลักใหม่ได้ วิชาหลักเดิมที่ยังไม่มีแผนถูกยกเลิก
  const thai = await as('thaihead');
  await thai.post('/teaching/add', { subject_code: 'ท31101', subject_name: 'ภาษาไทย 4', grade_level: 'ม.4', is_main: '1' });
  await thai.post('/teaching/add', { subject_code: 'ท32101', subject_name: 'ภาษาไทย 5', grade_level: 'ม.5', is_main: '1' });
  assert.equal((await teachRow('thaihead', 'ท31101')).is_main, 0);
  assert.equal((await teachRow('thaihead', 'ท32101')).is_main, 1);
  const home = (await thai.get('/')).text;
  assert.match(home, /แผน ท32101 ยังไม่ส่ง/);

  // ครูแก้รายวิชาของคนอื่นไม่ได้ ผู้ดูแลระบบแก้แทนได้และบันทึกประวัติ
  await t.post('/teaching/add', { u: String((await uid('sci2'))), subject_code: 'ว39999', subject_name: 'แอบเพิ่ม' });
  assert.equal((await teachRow('sci2', 'ว39999')), undefined);
  const admin = await as('admin');
  assert.equal((await admin.get(`/teaching?u=${(await uid('teacher'))}`)).status, 200);
  await admin.post('/teaching/add', { u: String((await uid('teacher'))), subject_code: 'ว30298', subject_name: 'วิชาจากผู้ดูแล' });
  assert.ok((await teachRow('teacher', 'ว30298')));
  assert.ok((await db.q.get("SELECT 1 AS x FROM audit_log WHERE action ILIKE 'เพิ่มรายวิชาที่สอน ว30298 แทน%'")));
});

test('หัวหน้ากลุ่มสาระให้คะแนนและลงนามงานของตัวเองผ่านหน้าเว็บ', async () => {
  const head = await as('scihead');
  const id = (await db.q.get("SELECT id FROM submissions WHERE doc_type = 'manual' AND subject_code = 'ว31101' AND teacher_id = ?", (await uid('scihead')))).id;
  assert.match((await head.get('/inbox')).text, new RegExp(`/s/${id}`));
  const page = (await head.get(`/s/${id}`)).text;
  assert.match(page, /งานของคุณเอง/);
  const scores = {};
  for (const it of (await db.q.all("SELECT id FROM rubric_items WHERE doc_type = 'manual' AND is_active = 1"))) scores[`score_${it.id}`] = '5';
  await head.post(`/s/${id}/approve`, { ...scores, comment: 'ตรวจทานแล้ว' });
  const s = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
  assert.equal(s.current_role, 'section_head');
  assert.equal(s.score_total, 100);
});

// ---------- นำเข้ารายวิชาจากโปรแกรมจัดตารางสอน (ไฟล์สมมติ ชื่อครูเป็นชื่อสมมติในข้อมูลทดลอง) ----------

function fakeTimetable() {
  return {
    school: 'โรงเรียนสมมติ',
    term: '2',
    year: '2569',
    teachers: [
      { id: 'T1', name: 'นายสมชาย ใจดี' },
      { id: 'T2', name: 'นางสาว พิมพ์ใจ  รักเรียน' },
      { id: 'T3', name: 'นายสมมติ ไม่มีในระบบ' },
      { id: 'T4', name: 'นางแนะแนว อย่างเดียว' },
    ],
    classes: [
      { id: '5/1', level: 'ม.5' },
      { id: '5/2', level: 'ม.5' },
      { id: '1/1', level: 'ม.1' },
    ],
    lessons: [
      { id: 'L1', cls: '5/1', subj: 'ว30205', subjName: 'ฟิสิกส์ 5', teachers: ['T1'], hours: 3 },
      { id: 'L2', cls: '5/2', subj: 'ว30205', subjName: 'ฟิสิกส์ 5', teachers: ['T1'], hours: 3 },
      { id: 'L3', cls: '1/1', subj: 'ก21901', subjName: 'แนะแนว', teachers: ['T1', 'T4'], hours: 1 },
      { id: 'L4', cls: '1/1', subj: 'ว21103', subjName: 'วิทยาศาสตร์ 3', teachers: ['T2', 'T1'], hours: 3 },
      { id: 'L5', cls: '1/1', subj: 'ว20299', subjName: 'วิชาของครูนอกระบบ', teachers: ['T3'], hours: 2 },
    ],
  };
}

// อ่านค่าในฟอร์มตรวจก่อนนำเข้า เหมือนที่เบราว์เซอร์ส่ง (ช่องซ่อน ตัวเลือกที่เลือก ช่องที่ติ๊ก)
function formFields(html) {
  const un = (s) => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const out = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)) out.append(m[1], un(m[2]));
  for (const m of html.matchAll(/<input type="number" id="\w+" name="(\w+)" value="(\d+)"/g)) out.append(m[1], m[2]);
  for (const m of html.matchAll(/<select name="(map_\d+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="(\d*)" selected>/.exec(m[2]);
    out.append(m[1], sel ? sel[1] : '');
  }
  for (const m of html.matchAll(/<input type="checkbox" name="(pick_\d+)" value="([^"]+)" checked>/g)) out.append(m[1], un(m[2]));
  return out;
}

test('นำเข้ารายวิชาจากตารางสอน: จับคู่ชื่อครู ตรวจก่อน แล้วนำเข้า ไม่รวมวิชากิจกรรม', async () => {
  const timetable = require('../src/timetable');
  assert.equal(timetable.normName('นางสาว พิมพ์ใจ  รักเรียน'), timetable.normName('นางสาวพิมพ์ใจ รักเรียน'));
  assert.throws(() => timetable.parse(Buffer.from('ไม่ใช่ json')), /ไม่ใช่ไฟล์งานของโปรแกรมจัดตารางสอน/);

  const teacher = await as('teacher');
  assert.equal((await teacher.get('/admin/teach-import')).status, 403);

  const admin = await as('admin');
  assert.equal((await admin.get('/admin/teach-import')).status, 200);
  const fd = new FormData();
  fd.set('ttfile', new Blob([JSON.stringify(fakeTimetable())], { type: 'application/json' }), 'งานล่าสุด.json');
  const preview = await admin.req('POST', '/admin/teach-import/preview', fd);
  assert.equal(preview.status, 200, preview.text.slice(0, 300));
  assert.match(preview.text, /ไม่รวมวิชากิจกรรม 2 รายการ/);
  assert.doesNotMatch(preview.text, /ก21901/);
  assert.doesNotMatch(preview.text, /แนะแนว อย่างเดียว/, 'ครูที่สอนแต่วิชากิจกรรมไม่ต้องขึ้น');
  assert.match(preview.text, /มีครู 1 คนที่ระบบหาชื่อในระบบส่งแผนไม่เจอ/);
  // ยังไม่บันทึกอะไรจนกว่าจะกดนำเข้า
  assert.equal((await teachRow('teacher', 'ว30205')), undefined);

  const fields = formFields(preview.text);
  assert.equal(fields.get('n'), '3');
  const r = await admin.post('/admin/teach-import', fields);
  assert.equal(r.status, 302);
  assert.equal((await teachRow('teacher', 'ว30205')).grade_level, 'ม.5');
  assert.equal((await teachRow('teacher', 'ว30205')).is_main, 0, 'ไม่ตั้งวิชาหลักให้ ครูเลือกเอง');
  assert.ok((await teachRow('teacher', 'ว21103')), 'วิชาที่สอนร่วมกันได้ทั้งสองคน');
  assert.ok((await teachRow('sci2', 'ว21103')), 'จับคู่ชื่อได้แม้เว้นวรรคต่างกัน');
  assert.equal((await teachRow('teacher', 'ก21901')), undefined);
  assert.equal((await db.q.get("SELECT 1 AS x FROM teach_subjects WHERE subject_code = 'ว20299'")), undefined, 'ครูที่ไม่ได้เลือกชื่อไม่ถูกนำเข้า');
  assert.ok((await db.q.get("SELECT 1 AS x FROM subjects WHERE code = 'ว30205'")), 'เพิ่มในรายวิชาของโรงเรียนด้วย');
  assert.ok((await db.q.get("SELECT 1 AS x FROM audit_log WHERE action ILIKE 'นำเข้ารายวิชาที่สอนจากตารางสอน%'")));
  // นำเข้าซ้ำไม่เกิดรายการซ้ำ
  await admin.post('/admin/teach-import', fields);
  assert.equal((await db.q.get("SELECT COUNT(*) AS n FROM teach_subjects WHERE teacher_id = ? AND subject_code = 'ว30205'", (await uid('teacher')))).n, 1);
});

test('วิชากิจกรรมพัฒนาผู้เรียนเพิ่มในรายวิชาที่สอนและส่งงานไม่ได้', async () => {
  const t = await as('teacher');
  await t.post('/teaching/add', { subject_code: 'ก21901', subject_name: 'แนะแนว', grade_level: 'ม.1' });
  assert.equal((await teachRow('teacher', 'ก21901')), undefined);
  const r = await sendWork(t, '/works', { doc_type: 'manual', subject_code: 'ก21901', subject_name: 'แนะแนว', grade_level: 'ม.1', action: 'draft' }, [[await realPdf(1, 300), 'คู่มือ.pdf']]);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /กิจกรรมพัฒนาผู้เรียน/);
  assert.match((await t.get('/works/new?type=manual')).text, /data-cover/, 'มีกรอบดูหน้าปกก่อนส่ง');
});
