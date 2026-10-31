// ทดสอบจุดที่ครูต้องระวัง: รายการตรวจก่อนส่ง · กันส่งไฟล์ซ้ำกับงานอื่นของตัวเอง · ความเห็นผู้ตรวจตัวใหญ่ · แถบเตือนหน้าแรก
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-precheck-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const features = require('../src/features');
const { todayStr } = require('../src/time');
const { sendForm } = require('./upload-client');

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

async function pdf(pages, subject) {
  const doc = await PDFDocument.create();
  doc.setSubject(subject || `ไฟล์ทดลอง ${Math.random()}`);
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const subOf = (id) => db.q.get('SELECT id, status FROM submissions WHERE id = ?', id);
const fields = (code) => ({ doc_type: 'manual', subject_code: code, subject_name: 'ทดสอบไฟล์ซ้ำ', grade_level: 'ม.4', doc_no: 'วก.3/2569', action: 'draft' });
async function newDraft(t, code, file) {
  const r = await sendForm(t, '/works', fields(code), [[file, 'คู่มือ.pdf']]);
  return Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
}
function addDays(n) {
  const d = new Date(`${todayStr()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('สวิตช์ใหม่ทั้ง 7 ตัวอยู่ในหน้าฟังก์ชันเสริม เปิดเป็นค่าเริ่มต้น', () => {
  for (const k of ['precheck', 'precheckforce', 'dupfile', 'blankcover', 'retfocus', 'duealert', 'callout']) {
    assert.ok(features.BY_KEY[k], k);
    assert.equal(features.BY_KEY[k].on, true, k);
  }
});

test('หน้าส่งงานมีรายการตรวจก่อนส่ง ข้อแดงเขียวและข้อส้มที่ต้องติ๊ก ปิดสวิตช์กลับเป็นแบบเดิม', async () => {
  const t = await as('sci2');
  let page = (await t.get('/works/new?type=manual')).text;
  assert.match(page, /data-precheck data-mode="form"/);
  assert.match(page, /data-ck="fields"/);
  assert.match(page, /data-ck="cover"[\s\S]*?name="cover_ok" value="1"> ดูแล้ว/);
  assert.match(page, /data-ck="blank"[^>]*hidden/);
  assert.match(page, /data-force/, 'ข้อส้มต้องติ๊ก');
  assert.match(page, /data-precheck-btn/);
  assert.match(page, /data-cover-warn/);

  await db.setSetting('ff_precheckforce', '0');
  assert.doesNotMatch((await t.get('/works/new?type=manual')).text, /data-force/);
  await db.setSetting('ff_precheckforce', '1');

  await db.setSetting('ff_precheck', '0');
  page = (await t.get('/works/new?type=manual')).text;
  assert.doesNotMatch(page, /data-precheck/);
  assert.match(page, /<label class="check cover-ok">/, 'ช่องติ๊กหน้าปกแบบเดิม');
  await db.setSetting('ff_precheck', '1');
});

test('ไฟล์ซ้ำกับงานอื่นของตัวเองทุกไบต์ ส่งไม่ได้ หน้างานขึ้นข้อแดง ปิดสวิตช์แล้วส่งได้', async () => {
  const t = await as('sci2');
  const same = await pdf(3, 'ไฟล์เดียวกัน');
  const a = await newDraft(t, 'ว39001', same);
  const b = await newDraft(t, 'ว39002', same);
  const c = await newDraft(t, 'ว39003', await pdf(3));

  // หน้าแก้ไขบอกไฟล์ของงานอื่นให้เบราว์เซอร์เทียบ และขึ้นข้อแดงทันทีเพราะไฟล์เดิมซ้ำ
  const edit = (await t.get(`/s/${b}/edit`)).text;
  assert.match(edit, /data-dup="\[/);
  assert.match(edit, /เป็นไฟล์เดียวกับคู่มือรายวิชา ว39001/);

  const detail = (await t.get(`/s/${b}`)).text;
  assert.match(detail, /data-mode="detail"/);
  assert.match(detail, /data-blocked="ยังส่งไม่ได้ ไฟล์นี้เป็นไฟล์เดียวกับคู่มือรายวิชา ว39001/);

  // เซิร์ฟเวอร์ไม่ให้ส่ง ทั้งสองงานที่ไฟล์ซ้ำกัน
  const r = await t.post(`/s/${b}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal(r.status, 302);
  assert.equal((await subOf(b)).status, 'draft');
  await t.post(`/s/${a}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(a)).status, 'draft');

  // งานที่ไฟล์ไม่ซ้ำส่งได้ตามปกติ
  await t.post(`/s/${c}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(c)).status, 'pending');

  await db.setSetting('ff_dupfile', '0');
  await t.post(`/s/${b}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(b)).status, 'pending', 'ปิดสวิตช์แล้วส่งได้');
  await db.setSetting('ff_dupfile', '1');
});

test('ปิดรับส่งแล้ว หน้างานฉบับร่างขึ้นข้อแดง อยู่ในกำหนดส่ง', async () => {
  const t = await as('sci2');
  const id = await newDraft(t, 'ว39004', await pdf(3));
  await db.setSetting('submit_end', addDays(-1));
  const page = (await t.get(`/s/${id}`)).text;
  assert.match(page, /data-ck="window"/);
  assert.match(page, /data-blocked="ยังส่งไม่ได้ ปิดรับส่งแล้วตั้งแต่/);
  await db.setSetting('submit_end', '');
});

test('งานที่ถูกส่งกลับ ความเห็นผู้ตรวจในกรอบแดงบนสุด ทั้งหน้างานและหน้าแก้ไข', async () => {
  const sub = await db.q.get(
    "SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.status = 'pending' AND s.doc_type IN ('manual', 'plan') AND u.is_admin = 0 ORDER BY s.id LIMIT 1"
  );
  const a = await as('admin');
  await a.post(`/s/${sub.id}/admin-return`, { comment: 'กรุณาเพิ่มตารางวิเคราะห์หลักสูตร' });
  const t = await as(sub.username);
  for (const url of [`/s/${sub.id}`, `/s/${sub.id}/edit`]) {
    const page = (await t.get(url)).text;
    assert.match(page, /class="ret-box"[\s\S]*?ความเห็นของผู้ตรวจ[\s\S]*?กรุณาเพิ่มตารางวิเคราะห์หลักสูตร/, url);
  }
  await db.setSetting('ff_retfocus', '0');
  assert.doesNotMatch((await t.get(`/s/${sub.id}`)).text, /class="ret-box"/);
  await db.setSetting('ff_retfocus', '1');
});

test('หน้าแรกครู: แถบส้มงานร่างที่ยังไม่ส่ง และแถบแดงเมื่อใกล้กำหนด', async () => {
  const t = await as('sci2');
  await newDraft(t, 'ว39005', await pdf(3));
  await db.setSetting('submit_open', '1');
  await db.setSetting('submit_end', addDays(20));
  let home = (await t.get('/')).text;
  assert.match(home, /class="call check draft-alert"/);
  assert.match(home, /คู่มือ ว39005/);
  assert.doesNotMatch(home, /due-alert/);

  await db.setSetting('submit_end', addDays(2));
  home = (await t.get('/')).text;
  assert.match(home, /class="call must due-alert"[\s\S]*?เหลืออีก 2 วัน/);
  assert.doesNotMatch(home, /draft-alert/);

  await db.setSetting('ff_duealert', '0');
  assert.doesNotMatch((await t.get('/')).text, /due-alert|draft-alert/);
  await db.setSetting('ff_duealert', '1');
  await db.setSetting('submit_end', '');
});

test('ผู้ดูแลระบบตั้งจำนวนหน้าขั้นต่ำที่ไม่ต้องเตือนได้', async () => {
  const a = await as('admin');
  const page = (await a.get('/admin/settings')).text;
  assert.match(page, /name="min_pages" value="5"/);
  const t = await as('sci2');
  assert.match((await t.get('/works/new?type=manual')).text, /data-min-pages="5"/);
});

test('หน้างานมีการ์ดเอกสารสำหรับพิมพ์และแถบพิมพ์บนมือถือ แบบประเมินที่ยังไม่มีคะแนนเป็นเส้นประ ปิดสวิตช์แล้วหาย', async () => {
  const t = await as('sci2');
  const id = await newDraft(t, 'ว39006', await pdf(3));
  let page = (await t.get(`/s/${id}`)).text;
  assert.match(page, /class="card print-card"/);
  assert.match(page, new RegExp(`class="pc-tile" href="/s/${id}/print"`));
  assert.match(page, /class="pc-tile off"[\s\S]*?พิมพ์ได้เมื่อผู้ตรวจให้คะแนนแล้ว/);
  assert.match(page, /class="print-bar"/);
  await db.setSetting('ff_printcard', '0');
  await db.setSetting('ff_printbar', '0');
  page = (await t.get(`/s/${id}`)).text;
  assert.doesNotMatch(page, /print-card|class="print-bar"/);
  await db.setSetting('ff_printcard', '1');
  await db.setSetting('ff_printbar', '1');
});

test('ผู้ตรวจที่กำลังลงนามไม่เห็นการ์ดและแถบพิมพ์ เจ้าของงานยังเห็น', async () => {
  // หาคู่ งานรอตรวจ + ผู้ตรวจที่มีปุ่มลงนามงานนั้น
  const rows = await db.q.all(
    `SELECT s.id, o.username AS owner, u.username AS reviewer FROM submissions s
     JOIN users o ON o.id = s.teacher_id JOIN user_roles r ON r.role = s.current_role JOIN users u ON u.id = r.user_id
     WHERE s.status = 'pending' AND s.doc_type IN ('manual', 'plan') AND u.id <> s.teacher_id ORDER BY s.id`
  );
  let found = null;
  for (const x of rows) {
    const c = await as(x.reviewer);
    const page = (await c.get(`/s/${x.id}`)).text;
    if (page.includes(`/s/${x.id}/approve`)) {
      found = { ...x, page };
      break;
    }
  }
  assert.ok(found, 'มีงานที่ผู้ตรวจลงนามได้');
  assert.doesNotMatch(found.page, /print-card|class="print-bar"/);
  assert.match(found.page, new RegExp(`href="/s/${found.id}/print"`), 'ยังมีปุ่มพิมพ์เล็กมุมขวาบน');
  const t = await as(found.owner);
  assert.match((await t.get(`/s/${found.id}`)).text, /class="card print-card"/);
});

test('เลขที่บันทึกข้อความ: กรอกเฉพาะตัวเลข ระบบเติม วก. และ /ปี ไม่กรอกส่งไม่ได้ ผู้ดูแลส่งแทนได้ ปิดสวิตช์ไม่บังคับ', async () => {
  const t = await as('sci2');
  const page = (await t.get('/works/new?type=manual')).text;
  assert.match(page, /<span>วก\.<\/span><input type="text" id="doc_no_num" name="doc_no_num"/);
  assert.match(page, /data-ck="docno"/);
  const base = { doc_type: 'manual', subject_name: 'ทดสอบเลข', grade_level: 'ม.4', action: 'submit', cover_check: '1', cover_ok: '1' };
  let r = await sendForm(t, '/works', { ...base, subject_code: 'ว39010', doc_no_num: '' }, [[await pdf(6), 'คู่มือ.pdf']]);
  let id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  assert.equal((await subOf(id)).status, 'draft', 'ไม่มีเลข ยังไม่ส่ง');
  assert.match((await t.get(`/s/${id}`)).text, /ยังขาด เลขที่บันทึกข้อความ/);
  // ผู้ดูแลระบบส่งแทนได้โดยไม่มีเลข
  const a = await as('admin');
  await a.post(`/s/${id}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(id)).status, 'pending', 'ผู้ดูแลส่งแทนได้');

  r = await sendForm(t, '/works', { ...base, subject_code: 'ว39011', doc_no_num: '๒๑๔' }, [[await pdf(6), 'คู่มือ.pdf']]);
  id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  const row = await db.q.get('SELECT status, doc_no, academic_year FROM submissions WHERE id = ?', id);
  assert.equal(row.doc_no, `วก.214/${row.academic_year}`, 'เลขไทยแปลงเป็นเลขอารบิก เติม วก. และปี');
  assert.equal(row.status, 'pending');

  await db.setSetting('ff_docnoreq', '0');
  r = await sendForm(t, '/works', { ...base, subject_code: 'ว39012' }, [[await pdf(6), 'คู่มือ.pdf']]);
  id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  assert.equal((await subOf(id)).status, 'pending', 'ปิดสวิตช์ ไม่บังคับ');
  await db.setSetting('ff_docnoreq', '1');
});

test('คู่มือใช้เลขบันทึกข้อความเลขเดียว: เล่มใหม่ของภาคเดียวกันเติมเลขเดิมให้ แผนไม่เติม ปิดสวิตช์ไม่เติม (docnoshare)', async () => {
  const t = await as('sci2');
  const row = await db.q.get("SELECT doc_no, subject_code FROM submissions WHERE subject_code = 'ว39011'");
  const num = /วก\.(\d+)\//.exec(row.doc_no)[1];
  const page = (await t.get('/works/new?type=manual')).text;
  assert.match(page, new RegExp(`name="doc_no_num" inputmode="numeric" maxlength="6" value="${num}"`));
  assert.match(page, /ใช้เลขเดียวกับคู่มือ ว39011 ระบบเติมให้แล้ว/);
  assert.doesNotMatch((await t.get('/works/new?type=plan')).text, /ใช้เลขเดียวกับคู่มือ/, 'แผนไม่เติม');
  // ครูอีกคนไม่ได้เลขของคนอื่น
  const other = (await (await as('scihead')).get('/works/new?type=manual')).text;
  assert.doesNotMatch(other, new RegExp(`value="${num}"`));
  await db.setSetting('ff_docnoshare', '0');
  try {
    assert.doesNotMatch((await t.get('/works/new?type=manual')).text, /ใช้เลขเดียวกับคู่มือ/);
  } finally {
    await db.setSetting('ff_docnoshare', '1');
  }
});

test('หน้าแผนและคู่มือของฉันมีปุ่มพิมพ์ในแถวงานที่ส่งแล้ว ปิดสวิตช์แล้วหาย', async () => {
  await db.setSetting('ff_myshelf', '0');
  const w = await db.q.get(
    "SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.subject_code = 'ว39011' AND s.status <> 'draft'"
  );
  const t = await as(w.username);
  const my = (await t.get('/my')).text;
  assert.match(my, new RegExp(`class="my-print"><a class="btn btn-sm btn-ghost" href="/s/${w.id}/print"`));
  const f = await db.q.get("SELECT id FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1 ORDER BY id LIMIT 1", w.id);
  assert.ok(f);
  assert.ok(my.includes(`href="/f/${f.id}/view"`), 'ปุ่มเปิดไฟล์งาน');
  await db.setSetting('ff_printrow', '0');
  assert.doesNotMatch((await t.get('/my')).text, /my-print/);
  await db.setSetting('ff_printrow', '1');
});

test('เลขที่บันทึกข้อความ: ผู้ดูแลเปลี่ยนคำนำหน้าและปีหลังทับได้ ปุ่มปรับเลขย้อนหลังเปลี่ยนเฉพาะเลขรูปแบบเดิม', async () => {
  const docno = require('../src/docno');
  // ตัวช่วยคิดเลข
  assert.equal(docno.numOf('วก.214/2569'), '214');
  assert.equal(docno.numOf('ศธ.ชว. 15 / 2568'), '15');
  assert.equal(docno.numOf('ตามหนังสือเลขที่'), '');
  assert.deepEqual(
    docno.reformat({ docno_prefix: 'วก.ชว.', docno_year: 'calendar' }, [
      { id: 1, doc_no: 'วก.214/2569', academic_year: 2569, submitted_at: '2027-01-15 09:00:00' },
      { id: 2, doc_no: 'วก.5/2569', academic_year: 2569, submitted_at: null },
      { id: 3, doc_no: 'อิสระ', academic_year: 2569, submitted_at: null },
    ]),
    [
      { id: 1, from: 'วก.214/2569', to: 'วก.ชว.214/2570' },
      { id: 2, from: 'วก.5/2569', to: 'วก.ชว.5/2569' },
    ],
    'ปี พ.ศ. ตามวันที่ส่ง งานที่ยังไม่ส่งคงปีเดิม เลขอิสระไม่แตะ'
  );

  const a = await as('admin');
  let page = (await a.get('/admin/settings')).text;
  assert.match(page, /name="docno_prefix" value="วก\."/);
  assert.match(page, /ปรับเลขที่บันทึกข้อความย้อนหลัง/);
  assert.match(page, /เลขทุกงานเป็นรูปแบบปัจจุบันแล้ว/);

  // คำนำหน้าที่มีตัวเลขหรือทับ บันทึกไม่ได้ และไม่บันทึกค่าอื่นด้วย
  const s0 = await db.getSettings();
  const keep = { school_name: s0.school_name, school_location: s0.school_location, academic_year: s0.academic_year, semester: s0.semester, submit_open: s0.submit_open, max_upload_mb: s0.max_upload_mb, grade_levels: s0.grade_levels, teaching_methods: s0.teaching_methods, public_url: s0.public_url };
  const bad = await a.post('/admin/settings', { ...keep, docno_prefix: 'วก/1', docno_year: 'calendar' });
  assert.equal(bad.status, 302);
  assert.equal(docno.prefix(await db.getSettings()), 'วก.');
  const ok = await a.post('/admin/settings', { ...keep, docno_prefix: ' วก.ชว. ', docno_year: 'calendar' });
  assert.equal(ok.status, 302);
  const s1 = await db.getSettings();
  assert.equal(s1.docno_prefix, 'วก.ชว.');
  assert.equal(s1.docno_year, 'calendar');

  // ฟอร์มของครูใช้คำนำหน้าใหม่ ปีเป็นปี พ.ศ. ของวันนี้
  const be = String(Number(require('../src/time').todayStr().slice(0, 4)) + 543);
  const t = await as('sci2');
  const fp = (await t.get('/works/new?type=manual')).text;
  assert.match(fp, new RegExp(`<span>วก\.ชว\.</span><input type="text" id="doc_no_num"[^>]*><span>/${be}</span>`));
  const base = { doc_type: 'manual', subject_name: 'ทดสอบคำนำหน้า', grade_level: 'ม.4', action: 'draft' };
  const r = await sendForm(t, '/works', { ...base, subject_code: 'ว39020', doc_no_num: '077' }, [[await pdf(6), 'คู่มือ.pdf']]);
  const id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  assert.equal((await db.q.get('SELECT doc_no FROM submissions WHERE id = ?', id)).doc_no, `วก.ชว.77/${be}`);

  // ปรับเลขย้อนหลัง: เลขเดิม วก.214/ปี เปลี่ยนเป็นรูปแบบใหม่ เลขอิสระไม่แตะ
  await db.q.run("UPDATE submissions SET doc_no = 'เลขอิสระ' WHERE subject_code = 'ว39012'");
  const before = await db.q.get("SELECT id, doc_no FROM submissions WHERE subject_code = 'ว39011'");
  assert.match(before.doc_no, /^วก\.214\//);
  page = (await a.get('/admin/settings')).text;
  assert.match(page, /งานที่เลขยังไม่ตรงกับรูปแบบปัจจุบัน/);
  assert.match(page, /data-confirm="ปรับเลขที่บันทึกข้อความ \d+ งาน/);
  // ครูเรียกไม่ได้
  assert.notEqual((await t.post('/admin/docno/reformat', {})).location, '/admin/settings');
  assert.equal((await a.post('/admin/docno/reformat', {})).status, 302);
  assert.match((await db.q.get('SELECT doc_no FROM submissions WHERE id = ?', before.id)).doc_no, /^วก\.ชว\.214\/\d{4}$/);
  assert.equal((await db.q.get("SELECT doc_no FROM submissions WHERE subject_code = 'ว39012'")).doc_no, 'เลขอิสระ');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ปรับเลขที่บันทึกข้อความย้อนหลัง%'"));
  assert.match((await a.get('/admin/settings')).text, /เลขทุกงานเป็นรูปแบบปัจจุบันแล้ว/);

  await db.setSetting('docno_prefix', 'วก.');
  await db.setSetting('docno_year', 'academic');
});

test('หน้างานของฉันบนมือถือเป็นกล่องสีตามสถานะ ปุ่มหลักปุ่มเดียว ปิดสวิตช์แล้วเหลือตาราง (mycards)', async () => {
  await db.setSetting('ff_myshelf', '0');
  const w = await db.q.get(
    "SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.subject_code = 'ว39011' AND s.status <> 'draft'"
  );
  const t = await as(w.username);
  let my = (await t.get('/my')).text;
  assert.match(my, /class="card has-boxes"/);
  assert.match(my, /class="my-box tone-wait">\s*<div class="mb-head"><b>คู่มือรายวิชา<\/b>/, 'รอตรวจเป็นสีเหลือง');
  assert.ok(my.includes(`class="btn btn-block btn-ghost" href="/s/${w.id}">ดูรายละเอียด</a>`), 'ปุ่มหลักปุ่มเดียว');
  assert.ok(my.includes(`<div class="mb-links"><a href="/s/${w.id}/print"`), 'ปุ่มพิมพ์เป็นลิงก์เล็ก');
  assert.match(my, /<table class="table">/, 'จอกว้างยังมีตาราง');
  await db.setSetting('ff_mycards', '0');
  try {
    my = (await t.get('/my')).text;
    assert.doesNotMatch(my, /my-box|has-boxes/);
    assert.match(my, /<table class="table">/);
  } finally {
    await db.setSetting('ff_mycards', '1');
  }
});
