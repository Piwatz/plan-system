// ทดสอบโอนงานระหว่างครู (ฟังก์ชันเสริม transfer): แบบในหน้างานและหน้าโอนงาน ชื่อบนเอกสาร 2 แบบ บันทึกหลังแผน รายวิชาที่สอน ไฟล์ใน Drive
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-transfer-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const storage = require('../src/storage');

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
  storage._set('gdrive', null);
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

const user = (username) => db.q.get('SELECT id, full_name, position, department_id, signature FROM users WHERE username = ?', username);
const sub = (id) => db.q.get('SELECT id, teacher_id, department_id, status, teacher_signature, doc_name, doc_position, subject_code, academic_year, semester FROM submissions WHERE id = ?', id);
// ข้อความแจ้งผลหลังกด (flash) อยู่ในหน้าที่ถูกส่งกลับไป
const flashOf = async (c, r) => (await c.get(r.location)).text;

// แผนที่ผ่านครบและมีบันทึกหลังแผน ของครูที่ไม่ใช่ผู้ดูแลระบบ
async function planWithNotes() {
  return db.q.get(
    `SELECT s.id, s.teacher_id, s.subject_code, s.academic_year, s.semester FROM submissions s JOIN users u ON u.id = s.teacher_id
     WHERE s.doc_type = 'plan' AND u.is_admin = 0 AND s.subject_code <> '' AND EXISTS (SELECT 1 FROM submissions n WHERE n.parent_id = s.id)
     ORDER BY (s.status = 'approved') DESC, s.id LIMIT 1`
  );
}

// ครูที่ไม่มีงานชนิดและวิชาเดียวกันในภาคนั้น และไม่ใช่เจ้าของเดิม
async function freeTeacher(s, docType) {
  return db.q.get(
    `SELECT u.id, u.full_name FROM users u WHERE u.is_teacher = 1 AND u.is_active = 1 AND u.is_admin = 0 AND u.department_id IS NOT NULL AND u.id <> ?
       AND NOT EXISTS (SELECT 1 FROM submissions x WHERE x.teacher_id = u.id AND x.doc_type = ? AND x.subject_code = ? AND x.academic_year = ? AND x.semester = ?)
     ORDER BY u.id LIMIT 1`,
    s.teacher_id,
    docType,
    s.subject_code,
    s.academic_year,
    s.semester
  );
}

test('โอนแผนในหน้างาน แบบเปลี่ยนชื่อ: บันทึกหลังแผนและรายวิชาที่สอนไปด้วย ลายเซ็นครูเดิมออก ลายเซ็นผู้ตรวจคงเดิม จดประวัติ แจ้งครูผู้รับ', async () => {
  const plan = await planWithNotes();
  assert.ok(plan, 'ข้อมูลทดลองมีแผนพร้อมบันทึก');
  const to = await freeTeacher(plan, 'plan');
  const old = await db.q.get('SELECT full_name FROM users WHERE id = ?', plan.teacher_id);
  await db.q.run(
    `INSERT INTO teach_subjects (teacher_id, academic_year, semester, subject_code, subject_name, is_main) VALUES (?, ?, ?, ?, 'ทดสอบโอน', 1)
     ON CONFLICT (teacher_id, academic_year, semester, subject_code) DO UPDATE SET is_main = 1`,
    plan.teacher_id,
    plan.academic_year,
    plan.semester,
    plan.subject_code
  );
  await db.q.run('UPDATE submissions SET teacher_signature = ? WHERE id = ? OR parent_id = ?', 'data:image/png;base64,QUJD', plan.id, plan.id);
  const notes = await db.q.all('SELECT id FROM submissions WHERE parent_id = ?', plan.id);
  const signedBefore = await db.q.get("SELECT COUNT(*)::int AS n FROM reviews WHERE submission_id = ? AND action = 'approve' AND signature IS NOT NULL", plan.id);

  const a = await as('admin');
  const page = (await a.get(`/s/${plan.id}`)).text;
  assert.match(page, /โอนงานนี้ให้ครูคนอื่น/, 'ผู้ดูแลระบบเห็นกล่องโอนงาน');
  assert.match(page, new RegExp(`บันทึกหลังแผนของแผนนี้ ${notes.length} ฉบับ`));

  const r = await a.post('/admin/transfer', { ids: String(plan.id), to: String(to.id), name_mode: 'change', with_notes: '1', with_teach: '1', move_drive: '1', notify: '1', back: `/s/${plan.id}` });
  assert.equal(r.status, 302);
  assert.equal(r.location, `/s/${plan.id}`);
  assert.match(await flashOf(a, r), new RegExp(`โอนแล้ว 1 งาน ให้ ${to.full_name} พร้อมบันทึกหลังแผน ${notes.length} ฉบับ รายวิชาที่สอน 1 วิชา`));

  const after = await sub(plan.id);
  assert.equal(after.teacher_id, to.id);
  assert.equal(after.teacher_signature, null, 'เอาลายเซ็นครูคนเดิมออก');
  assert.equal(after.doc_name, '');
  for (const n of notes) assert.equal((await sub(n.id)).teacher_id, to.id, 'บันทึกหลังแผนไปด้วย');
  const signedAfter = await db.q.get("SELECT COUNT(*)::int AS n FROM reviews WHERE submission_id = ? AND action = 'approve' AND signature IS NOT NULL", plan.id);
  assert.equal(signedAfter.n, signedBefore.n, 'ลายเซ็นผู้ตรวจคงเดิม');
  const log = await db.q.get("SELECT comment FROM reviews WHERE submission_id = ? AND action = 'transfer'", plan.id);
  assert.equal(log.comment, `โอนงานจาก ${old.full_name} ให้ ${to.full_name} พร้อมบันทึกหลังแผน ${notes.length} ฉบับ`);
  assert.equal((await db.q.get("SELECT COUNT(*)::int AS n FROM reviews WHERE action = 'transfer' AND submission_id = ANY(?)", notes.map((n) => n.id))).n, notes.length);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE ?", `โอนงาน 1 งาน จาก ${old.full_name} ให้ ${to.full_name}%`));
  assert.ok(await db.q.get('SELECT 1 AS x FROM notifications WHERE user_id = ? AND link = ?', to.id, `/s/${plan.id}`), 'แจ้งครูผู้รับ');
  const ts = await db.q.get('SELECT teacher_id, is_main FROM teach_subjects WHERE academic_year = ? AND semester = ? AND subject_code = ? AND teacher_id IN (?, ?)', plan.academic_year, plan.semester, plan.subject_code, plan.teacher_id, to.id);
  assert.equal(ts.teacher_id, to.id, 'รายวิชาที่สอนย้ายไปครูผู้รับ');
  assert.equal(ts.is_main, 1, 'ยังเป็นวิชาหลัก');

  // หน้าพิมพ์เป็นชื่อครูผู้รับ ประวัติแสดงการโอน
  assert.ok((await a.get(`/s/${plan.id}/print`)).text.includes(`ตามที่ข้าพเจ้า ${to.full_name}`));
  assert.match((await a.get(`/s/${plan.id}`)).text, /ผู้ดูแลระบบโอนงานให้ครูคนอื่น/);
});

test('โอนแบบคงชื่อครูคนเดิม: เอกสารเป็นชื่อเดิม ลายเซ็นเดิมอยู่ ครูผู้รับใส่ลายเซ็นตัวเองทับไม่ได้ โอนกลับแล้วเป็นปกติ', async () => {
  const s = await db.q.get(
    "SELECT s.id, s.teacher_id, s.subject_code, s.academic_year, s.semester FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type = 'manual' AND s.status <> 'draft' AND u.is_admin = 0 AND s.subject_code <> '' ORDER BY s.id LIMIT 1"
  );
  const from = await db.q.get('SELECT id, full_name, position FROM users WHERE id = ?', s.teacher_id);
  const to = await freeTeacher(s, 'manual');
  await db.q.run('UPDATE submissions SET teacher_signature = ? WHERE id = ?', 'data:image/png;base64,T0xE', s.id);
  await db.q.run("UPDATE users SET signature = 'data:image/png;base64,TkVX' WHERE id = ?", to.id);
  const a = await as('admin');
  const r = await a.post('/admin/transfer', { ids: String(s.id), to: String(to.id), name_mode: 'keep', with_teach: '1', back: `/s/${s.id}` });
  assert.equal(r.status, 302);
  let after = await sub(s.id);
  assert.equal(after.teacher_id, to.id);
  assert.equal(after.doc_name, from.full_name);
  assert.equal(after.doc_position, from.position);
  assert.equal(after.teacher_signature, 'data:image/png;base64,T0xE', 'ลายเซ็นเดิมอยู่');
  const print = (await a.get(`/s/${s.id}/print`)).text;
  assert.ok(print.includes(`ตามที่ข้าพเจ้า ${from.full_name} ตำแหน่ง ${from.position}`), 'เอกสารยังเป็นชื่อครูคนเดิม');
  assert.ok(!print.includes(`ตามที่ข้าพเจ้า ${to.full_name}`));
  // ครูผู้รับเข้าระบบ ระบบไม่ใส่หรือเปลี่ยนลายเซ็นในงานนี้
  await db.setSetting('ff_sigfillauto', '1');
  const mine = await as(await db.q.get('SELECT username FROM users WHERE id = ?', to.id).then((u) => u.username));
  await mine.get('/');
  assert.equal((await sub(s.id)).teacher_signature, 'data:image/png;base64,T0xE');
  // โอนกลับให้ครูคนเดิม แบบคงชื่อ ก็กลับเป็นปกติ
  await a.post('/admin/transfer', { ids: String(s.id), to: String(from.id), name_mode: 'keep', back: `/s/${s.id}` });
  after = await sub(s.id);
  assert.equal(after.teacher_id, from.id);
  assert.equal(after.doc_name, '');
  assert.equal(after.teacher_signature, 'data:image/png;base64,T0xE');
});

test('หน้าโอนงาน: เลือกครูแล้วเห็นงาน ติ๊กโอนหลายงานพร้อมกัน ไม่ติ๊กบันทึกหลังแผน บันทึกยังเป็นของครูเดิม', async () => {
  const sci2 = await user('sci2');
  const math2 = await user('math2');
  const st = await db.getSettings();
  const y = Number(st.academic_year);
  const m = Number(st.semester);
  const mk = (type, code) =>
    db.q
      .get(
        `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ทดสอบหลายงาน', 'draft', '2569-10-23 08:00:00', '2569-10-23 08:00:00') RETURNING id`,
        type,
        sci2.id,
        sci2.department_id,
        y,
        m,
        code
      )
      .then((r) => r.id);
  const m1 = await mk('manual', 'ว39901');
  const p1 = await mk('plan', 'ว39902');
  const note = await db.q.get(
    `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, plan_no, status, created_at, updated_at)
     VALUES ('note', ?, ?, ?, ?, ?, 'ว39902', '1', 'draft', '2569-10-23 08:00:00', '2569-10-23 08:00:00') RETURNING id`,
    p1,
    sci2.id,
    sci2.department_id,
    y,
    m
  );
  const a = await as('admin');
  const page = (await a.get(`/admin/transfer?from=${sci2.id}&to=${math2.id}&year=${y}&semester=${m}`)).text;
  assert.ok(page.includes(`value="${m1}"`) && page.includes(`value="${p1}"`), 'เห็นงานของครูต้นทาง');
  assert.match(page, new RegExp(`โอนงานที่ติ๊กให้ ${math2.full_name}`));
  assert.match((await a.get('/admin')).text, /href="\/admin\/transfer"/);

  const body = new URLSearchParams({ to: String(math2.id), name_mode: 'change', back: `/admin/transfer?from=${sci2.id}&to=${math2.id}` });
  body.append('ids', String(m1));
  body.append('ids', String(p1));
  const r = await a.req('POST', '/admin/transfer', body);
  assert.equal(r.status, 302);
  assert.equal(r.location, `/admin/transfer?from=${sci2.id}&to=${math2.id}`);
  assert.equal((await sub(m1)).teacher_id, math2.id);
  assert.equal((await sub(p1)).teacher_id, math2.id);
  assert.equal((await sub(p1)).department_id, sci2.department_id, 'กลุ่มสาระของงานคงเดิม แม้ครูผู้รับอยู่กลุ่มสาระอื่น');
  assert.equal((await sub(note.id)).teacher_id, sci2.id, 'ไม่ติ๊กบันทึกหลังแผน บันทึกไม่ไป');
  assert.ok(!(await db.q.get("SELECT 1 AS x FROM notifications WHERE user_id = ? AND text LIKE 'ผู้ดูแลระบบโอนงาน%'", math2.id)), 'ไม่ติ๊กแจ้ง ไม่แจ้ง');
});

test('กติกา: ครูโอนไม่ได้ ห้ามโอนงานตัวเองหรือให้ตัวเอง ห้ามงานซ้ำ ปิดสวิตช์แล้วไม่มีปุ่ม', async () => {
  const sci2 = await user('sci2');
  const tch = await user('teacher');
  const admin = await user('admin');
  const s = await db.q.get("SELECT id FROM submissions WHERE teacher_id = ? AND doc_type IN ('manual', 'plan') ORDER BY id LIMIT 1", tch.id);
  // ครูโอนไม่ได้ และไม่เห็นกล่อง
  const t = await as('teacher');
  await t.post('/admin/transfer', { ids: String(s.id), to: String(sci2.id) });
  assert.equal((await sub(s.id)).teacher_id, tch.id);
  assert.doesNotMatch((await t.get(`/s/${s.id}`)).text, /โอนงานนี้ให้ครูคนอื่น/);

  const a = await as('admin');
  // ให้ตัวเองไม่ได้
  let r = await a.post('/admin/transfer', { ids: String(s.id), to: String(admin.id), back: `/s/${s.id}` });
  assert.equal((await sub(s.id)).teacher_id, tch.id);
  // ซ้ำ: ครูผู้รับมีงานชนิดและวิชาเดียวกันในภาคเดียวกันแล้ว
  const x = await db.q.get('SELECT doc_type, subject_code, academic_year, semester FROM submissions WHERE id = ?', s.id);
  await db.q.run(
    `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', '2569-10-23 08:00:00', '2569-10-23 08:00:00')`,
    x.doc_type,
    sci2.id,
    sci2.department_id,
    x.academic_year,
    x.semester,
    x.subject_code
  );
  r = await a.post('/admin/transfer', { ids: String(s.id), to: String(sci2.id), back: `/s/${s.id}` });
  assert.match(await flashOf(a, r), /อยู่แล้ว โอนซ้ำไม่ได้/);
  assert.equal((await sub(s.id)).teacher_id, tch.id);

  await db.setSetting('ff_transfer', '0');
  assert.doesNotMatch((await a.get(`/s/${s.id}`)).text, /โอนงานนี้ให้ครูคนอื่น/);
  assert.equal((await a.get('/admin/transfer')).status, 404);
  await db.setSetting('ff_transfer', '1');
});

test('ไฟล์ใน Drive: ย้ายไปโฟลเดอร์ของครูผู้รับ ที่ไม่สำเร็จค้างในคิว กดย้ายต่อได้', async () => {
  const moves = [];
  let fail = true;
  storage._set('gdrive', {
    kind: 'gdrive',
    async move(ref, folder) {
      if (fail && ref === 'bad') throw new Error('drive down');
      moves.push([ref, folder]);
      return true;
    },
  });
  const eng2 = await user('eng2');
  const soc1 = await user('soc1');
  const st = await db.getSettings();
  const s = await db.q.get(
    `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name, status, created_at, updated_at)
     VALUES ('manual', ?, ?, ?, ?, 'อ39901', 'ทดสอบไฟล์', 'pending', '2569-10-23 08:00:00', '2569-10-23 08:00:00') RETURNING id`,
    eng2.id,
    eng2.department_id,
    Number(st.academic_year),
    Number(st.semester)
  );
  const addFile = (stored, current = 1) =>
    db.q.run(
      "INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, is_current, uploaded_at) VALUES (?, 'main', 'คู่มือ.pdf', ?, 'application/pdf', 10, ?, '2569-10-23 08:00:00')",
      s.id,
      stored,
      current
    );
  await addFile('gdrive:good');
  await addFile('gdrive:bad');
  await addFile('gdrive:old', 0);
  await addFile('local-file.pdf');
  const a = await as('admin');
  const r = await a.post('/admin/transfer', { ids: String(s.id), to: String(soc1.id), move_drive: '1', back: `/s/${s.id}` });
  const msg = await flashOf(a, r);
  assert.match(msg, /ย้ายไฟล์ใน Drive 1 ไฟล์/);
  assert.match(msg, /รอย้ายอีก 1 ไฟล์/);
  assert.deepEqual(moves.map((x) => x[0]), ['good'], 'ย้ายเฉพาะไฟล์ปัจจุบันใน Drive');
  assert.ok(moves[0][1].endsWith(`/${soc1.full_name}/คู่มือรายวิชา`), moves[0][1]);
  assert.match((await a.get(`/s/${s.id}`)).text, /ไฟล์ใน Drive รอย้าย 1 ไฟล์/);
  fail = false;
  const again = await a.post('/admin/transfer/drive', { back: `/s/${s.id}` });
  assert.match(await flashOf(a, again), /ย้ายไฟล์ใน Drive 1 ไฟล์/);
  assert.deepEqual(moves.map((x) => x[0]), ['good', 'bad']);
  assert.equal(await require('../src/transfer').driveLeft(), 0);
});

test('หน้าแก้ไขผู้ใช้มีปุ่มโอนงานของครูคนนี้ ครูที่ปิดบัญชีแล้วยังโอนงานออกได้', async () => {
  const thai2 = await user('thai2');
  const eng2 = await user('eng2');
  const a = await as('admin');
  const form = (await a.get(`/admin/users/${thai2.id}`)).text;
  assert.ok(form.includes(`href="/admin/transfer?from=${thai2.id}"`), 'มีปุ่มโอนงานของครูคนนี้');
  const st = await db.getSettings();
  const w = await db.q.get(
    `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name, status, created_at, updated_at)
     VALUES ('manual', ?, ?, ?, ?, 'ท39901', 'ทดสอบลาออก', 'pending', '2569-10-23 08:00:00', '2569-10-23 08:00:00') RETURNING id`,
    thai2.id,
    thai2.department_id,
    Number(st.academic_year),
    Number(st.semester)
  );
  await db.q.run('UPDATE users SET is_active = 0 WHERE id = ?', thai2.id);
  const page = (await a.get(`/admin/transfer?from=${thai2.id}&to=${eng2.id}`)).text;
  assert.match(page, /ปิดบัญชีแล้ว/);
  assert.ok(page.includes(`value="${w.id}"`), 'เห็นงานของครูที่ปิดบัญชีแล้ว');
  await a.post('/admin/transfer', { ids: String(w.id), to: String(eng2.id), back: '/admin/transfer' });
  assert.equal((await sub(w.id)).teacher_id, eng2.id);
  await db.q.run('UPDATE users SET is_active = 1 WHERE id = ?', thai2.id);
  // ไม่มีปุ่มในหน้าของผู้ดูแลระบบเอง
  const admin = await user('admin');
  assert.doesNotMatch((await a.get(`/admin/users/${admin.id}`)).text, /โอนงานของครูคนนี้/);
});
