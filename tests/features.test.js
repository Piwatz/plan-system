// ทดสอบฟังก์ชันเสริม: สวิตช์เปิดปิดและประวัติ ธีม บันทึกหลังแผนแบบแนบไฟล์ ตรวจไฟล์ ลงนามแบบไล่การ์ด ส่งเตือน QR Code
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ff-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');

let base;
let server;

test.before(async () => {
  seed.main();
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
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
    const body = fields instanceof FormData || fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body);
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const setting = (k) => db.q.get('SELECT value FROM settings WHERE key = ?', k).value;
const planOf = (code) => db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = ?", code).id;
const pdf = () => new Blob(['%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'], { type: 'application/pdf' });

test('เฉพาะผู้ดูแลระบบเปิดปิดฟังก์ชันเสริมได้ และทุกครั้งถูกบันทึกในประวัติที่ลบไม่ได้', async () => {
  const t = await as('teacher');
  assert.equal((await t.get('/admin/features')).status, 403);
  assert.equal((await t.post('/admin/features/chips', { on: '0' })).status, 403);
  const head = await as('scihead');
  assert.equal((await head.post('/admin/features/chips', { on: '0' })).status, 403);
  const dir = await as('director');
  assert.equal((await dir.post('/admin/features/chips', { on: '0' })).status, 403, 'ผู้อำนวยการต้องเปิดปิดฟังก์ชันไม่ได้');
  assert.equal(setting('ff_chips'), '1');

  const admin = await as('admin');
  const planId = planOf('ว30203');
  assert.match((await t.get(`/notes/new?plan=${planId}`)).text, /data-chip=/);
  assert.equal((await admin.post('/admin/features/chips', { on: '0' })).status, 302);
  assert.equal(setting('ff_chips'), '0');
  assert.doesNotMatch((await t.get(`/notes/new?plan=${planId}`)).text, /data-chip=|data-copy-prev/, 'ปิดแล้วครูต้องไม่เห็นประโยคสำเร็จรูป');
  await admin.post('/admin/features/chips', { on: '1' });

  const log = db.q.all('SELECT * FROM audit_log ORDER BY id');
  assert.deepEqual(
    log.map((l) => l.action),
    ['ปิด ประโยคสำเร็จรูปในบันทึกหลังแผน', 'เปิด ประโยคสำเร็จรูปในบันทึกหลังแผน']
  );
  assert.equal(log[0].user_name, 'ผู้ดูแลระบบ ทดลอง');
  assert.throws(() => db.q.exec('DELETE FROM audit_log'), /append-only/);
  assert.throws(() => db.q.exec("UPDATE audit_log SET action = 'x'"), /append-only/);
  assert.match((await admin.get('/admin/features')).text, /ปิด ประโยคสำเร็จรูปในบันทึกหลังแผน/);

  // เปิด LINE ไม่ได้จนกว่าจะตั้งค่า
  await admin.post('/admin/features/line', { on: '1' });
  assert.equal(setting('ff_line'), '0');

  // ปิดหน้าฟังก์ชันเสริม คนอื่นเปิดหน้าไม่ได้
  await admin.post('/admin/features/pa', { on: '0' });
  assert.equal((await t.get('/pa')).status, 404);
  assert.doesNotMatch((await t.get('/')).text, /href="\/pa"/);
  await admin.post('/admin/features/pa', { on: '1' });
});

test('ผู้อำนวยการและรองผู้อำนวยการเป็นผู้ดูแลระบบไม่ได้', async () => {
  const admin = await as('admin');
  const dirId = db.q.get("SELECT id FROM users WHERE username = 'director'").id;
  await admin.post(`/admin/users/${dirId}`, { username: 'director', full_name: 'นายมงคล นำพา', roles: 'director', is_admin: '1', is_active: '1' });
  assert.equal(db.q.get('SELECT is_admin FROM users WHERE id = ?', dirId).is_admin, 0);
  await admin.post('/admin/users', { username: 'newdep', full_name: 'รองทดสอบ', roles: 'deputy_academic', is_admin: '1', is_active: '1', password: 'abcdef' });
  assert.equal(db.q.get("SELECT 1 AS x FROM users WHERE username = 'newdep'"), undefined);
  const imp = await admin.post('/admin/users-import', { password: 'abcdef', data: 'imp1\tนายนำเข้า ทดสอบ\tผู้อำนวยการ\t\tผู้อำนวยการ, ผู้ดูแลระบบ' });
  assert.match(imp.text, /เป็นผู้ดูแลระบบไม่ได้/);
  assert.equal(db.q.get("SELECT 1 AS x FROM users WHERE username = 'imp1'"), undefined);
  // ให้สิทธิ์ผู้ดูแลแก่ครูทั่วไปได้ และถูกบันทึกในประวัติ
  const t2 = db.q.get("SELECT id, full_name FROM users WHERE username = 'eng2'");
  await admin.post(`/admin/users/${t2.id}`, { username: 'eng2', full_name: t2.full_name, is_teacher: '1', is_admin: '1', is_active: '1' });
  assert.equal(db.q.get('SELECT is_admin FROM users WHERE id = ?', t2.id).is_admin, 1);
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ให้สิทธิ์ผู้ดูแลระบบ%'"));
  await admin.post(`/admin/users/${t2.id}`, { username: 'eng2', full_name: t2.full_name, is_teacher: '1', is_active: '1' });
});

test('เปลี่ยนธีมแล้วสีและฟอนต์เปลี่ยนทั้งระบบ ค่าที่ไม่รู้จักกลับเป็นธีม I', async () => {
  const admin = await as('admin');
  const t = await as('teacher');
  assert.match((await t.get('/')).text, /noto-sans-thai-looped\/400\.css/);
  assert.match((await t.get('/')).text, /--side:#1B3762/);
  const fields = { school_name: 'โรงเรียนทดสอบ', academic_year: '2569', semester: '2', submit_open: '1', max_upload_mb: '20', grade_levels: 'ม.1', teaching_methods: 'Active Learning' };
  const save = (theme) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...fields, theme })) fd.set(k, v);
    return admin.post('/admin/settings', fd);
  };
  await save('b');
  assert.equal(setting('theme'), 'b');
  const page = (await t.get('/')).text;
  assert.match(page, /anuphan\/400\.css/);
  assert.match(page, /--primary:#C8102E/);
  // การจัดวางบนมือถือ: ค่าเริ่มต้นแบบเรียบง่าย แอดมินสลับเป็นแบบเต็มได้ และสลับกลับได้
  assert.match(page, /ml-simple/);
  assert.match(page, /สิ่งที่ต้องทำต่อ/);
  assert.match(page, /bnav-fab/);
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...fields, theme: 'b', mobile_layout: 'classic' })) fd.set(k, v);
  await admin.post('/admin/settings', fd);
  assert.equal(setting('mobile_layout'), 'classic');
  const classic = (await t.get('/')).text;
  assert.match(classic, /ml-classic/);
  assert.doesNotMatch(classic, /bnav-fab/);
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'เปลี่ยนการจัดวางบนมือถือ%'"));
  await save('zzz');
  assert.equal(setting('theme'), 'i');
  assert.equal(setting('mobile_layout'), 'simple');
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'เปลี่ยนธีมเป็น B%'"));
});

test('บันทึกหลังแผนแบบแนบไฟล์ของครูเอง และบังคับกรอกจำนวนนักเรียนเมื่อเปิดสวิตช์', async () => {
  const t = await as('teacher');
  const planId = planOf('ว30203');
  const send = async (fields, file) => {
    const fd = new FormData();
    fd.set('plan_id', String(planId));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    if (file) fd.set('attach_files', file, 'บันทึกของฉัน.pdf');
    const r = await t.req('POST', '/notes', fd);
    return Number(r.location.split('/')[2]);
  };
  // แบบแนบไฟล์ ไม่มีไฟล์ ส่งไม่ได้
  let id = await send({ plan_no: '20', note_mode: 'file', action: 'submit' });
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', id).status, 'draft');
  // มีไฟล์ ส่งได้โดยไม่ต้องพิมพ์ K P A
  id = await send({ plan_no: '21', note_mode: 'file', action: 'submit' }, pdf());
  let s = db.q.get('SELECT * FROM submissions WHERE id = ?', id);
  assert.equal(s.note_mode, 'file');
  assert.equal(s.status, 'pending');
  const print = (await t.get(`/s/${id}/print`)).text;
  assert.match(print, /แนบเป็นไฟล์ในระบบ/);
  assert.match(print, /บันทึกของฉัน\.pdf/);

  const admin = await as('admin');
  await admin.post('/admin/features/notefile', { on: '0' });
  id = await send({ plan_no: '22', note_mode: 'file', result_k: 'เข้าใจ', action: 'draft' }, pdf());
  assert.equal(db.q.get('SELECT note_mode FROM submissions WHERE id = ?', id).note_mode, 'type', 'ปิดแล้วต้องเป็นแบบพิมพ์');
  await admin.post('/admin/features/notefile', { on: '1' });

  await admin.post('/admin/features/counts', { on: '1' });
  id = await send({ plan_no: '23', result_k: 'เข้าใจ', action: 'submit' });
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', id).status, 'draft', 'เปิดบังคับแล้วไม่กรอกจำนวนต้องส่งไม่ได้');
  id = await send({ plan_no: '24', result_k: 'เข้าใจ', students_total: '38', students_passed: '30', action: 'submit' });
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', id).status, 'pending');
  await admin.post('/admin/features/counts', { on: '0' });
});

test('ตรวจไฟล์ก่อนส่ง ไม่รับไฟล์ที่นามสกุลไม่ตรงกับไฟล์จริง', async () => {
  const t = await as('sci2');
  const send = (blob) => {
    const fd = new FormData();
    fd.set('doc_type', 'manual');
    fd.set('subject_code', 'ว30111');
    fd.set('subject_name', 'ทดสอบไฟล์');
    fd.set('grade_level', 'ม.4');
    fd.set('action', 'draft');
    fd.set('main_files', blob, 'แผน.pdf');
    return t.req('POST', '/works', fd, { 'x-requested-with': 'XMLHttpRequest' });
  };
  const before = fs.readdirSync(path.join(tmp, 'data-demo', 'uploads'), { recursive: true }).length;
  const bad = await send(new Blob(['นี่ไม่ใช่ PDF'], { type: 'application/pdf' }));
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /เปิดไม่ได้/);
  assert.equal(db.q.get("SELECT 1 AS x FROM submissions WHERE subject_code = 'ว30111'"), undefined);
  assert.equal(fs.readdirSync(path.join(tmp, 'data-demo', 'uploads'), { recursive: true }).length, before, 'ไฟล์ที่ไม่รับต้องถูกลบทิ้ง');
  const good = await send(pdf());
  assert.equal(good.status, 200);
  assert.ok(db.q.get("SELECT 1 AS x FROM submissions WHERE subject_code = 'ว30111'"));
});

test('ลงนามแบบไล่การ์ด ลงนาม ส่งกลับ และลงนามที่เหลือทั้งหมด', async () => {
  const head = await as('scihead');
  const queue = () => db.q.all("SELECT id FROM submissions WHERE doc_type = 'note' AND status = 'pending' AND current_role = 'dept_head' AND department_id = (SELECT department_id FROM users WHERE username = 'scihead')").map((r) => r.id);
  const start = queue();
  assert.ok(start.length >= 3);
  const page = await head.get('/quicksign');
  assert.match(page.text, /qs-card/);
  const first = Number(page.text.match(/action="\/quicksign\/(\d+)\/approve"/)[1]);
  let r = await head.post(`/quicksign/${first}/approve`, { comment: 'รับทราบ', signed: '0', back: '0' });
  assert.equal(r.location, '/quicksign?signed=1&back=0');
  assert.equal(db.q.get('SELECT current_role FROM submissions WHERE id = ?', first).current_role, 'deputy_academic');
  const second = queue()[0];
  await head.post(`/quicksign/${second}/return`, { comment: '', signed: '1', back: '0' });
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', second).status, 'pending', 'ส่งกลับต้องมีเหตุผล');
  r = await head.post(`/quicksign/${second}/return`, { comment: 'เขียนเพิ่ม', signed: '1', back: '0' });
  assert.equal(r.location, '/quicksign?signed=1&back=1');
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', second).status, 'returned');
  r = await head.post('/quicksign/approve-rest', { comment: 'รับทราบ', signed: '1', back: '1' });
  assert.equal(queue().length, 0);
  assert.match((await head.get(r.location)).text, /ลงนามครบแล้ว/);
  // คนที่ไม่ใช่ผู้ตรวจของงานนั้น ลงนามไม่ได้
  const other = await as('mathhead');
  const any = db.q.get("SELECT id FROM submissions WHERE doc_type = 'note' AND status = 'pending'");
  if (any) {
    await other.post(`/quicksign/${any.id}/approve`, { comment: 'x' });
    assert.notEqual(db.q.get('SELECT current_role FROM submissions WHERE id = ?', any.id).current_role, null);
  }
});

test('หัวหน้ากลุ่มสาระส่งเตือนครูที่ยังส่งไม่ครบ ครูเห็นที่หน้าหลัก', async () => {
  const head = await as('scihead');
  const board = await head.get('/dept');
  assert.equal(board.status, 200);
  assert.match(board.text, /สถานะกลุ่มสาระวิทยาศาสตร์/);
  const teacher = db.q.get("SELECT id FROM users WHERE username = 'teacher'");
  const dept = db.q.get("SELECT department_id AS d FROM users WHERE username = 'scihead'").d;
  const r = await head.post('/dept/remind', new URLSearchParams([['dept', String(dept)], ['ids', String(teacher.id)], ['message', 'ส่งได้ที่ห้องกลุ่มสาระ']]));
  assert.equal(r.status, 302);
  const n = db.q.get('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC', teacher.id);
  assert.match(n.text, /เรียน คุณครูนายสมชาย ใจดี/);
  assert.match(n.text, /คู่มือรายวิชา/, 'ครูสมชายส่งแผนวิชาหลักแล้ว เหลือคู่มือที่ยังไม่ครบ');
  assert.match(n.text, /ส่งได้ที่ห้องกลุ่มสาระ/);
  const t = await as('teacher');
  assert.match((await t.get('/')).text, /ส่งได้ที่ห้องกลุ่มสาระ/);
  await t.get('/alerts');
  assert.equal(db.q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', teacher.id).n, 0);
  // ครูทั่วไปเปิดหน้าสถานะและส่งเตือนไม่ได้ หัวหน้ากลุ่มสาระอื่นเตือนข้ามกลุ่มไม่ได้
  assert.equal((await t.get('/dept')).status, 403);
  const before = db.q.get('SELECT COUNT(*) AS n FROM notifications').n;
  const math = await as('mathhead');
  await math.post('/dept/remind', new URLSearchParams([['dept', String(dept)], ['ids', String(teacher.id)]]));
  assert.equal(db.q.get('SELECT COUNT(*) AS n FROM notifications').n, before);
});

test('QR Code บนเอกสาร สแกนแล้วตรวจสอบได้โดยไม่ต้องเข้าระบบ', async () => {
  const admin = await as('admin');
  const sub = db.q.get("SELECT * FROM submissions WHERE status = 'approved' AND doc_type = 'manual' ORDER BY id LIMIT 1");
  const print = await admin.get(`/s/${sub.id}/print`);
  assert.match(print.text, /class="qr-corner"><svg/);
  const anon = new Client();
  const v = await anon.get(`/v/${sub.verify_code}`);
  assert.equal(v.status, 200);
  assert.match(v.text, /เป็นเอกสารจริง ลงนามครบทุกระดับแล้ว/);
  assert.match(v.text, new RegExp(sub.subject_code));
  assert.equal((await anon.get('/v/0123456789abcdef0123')).status, 404);
  assert.equal((await anon.get('/v/1')).status, 404);
  const draft = db.q.get("SELECT verify_code FROM submissions WHERE status = 'draft' LIMIT 1");
  assert.equal((await anon.get(`/v/${draft.verify_code}`)).status, 404, 'ฉบับร่างต้องตรวจสอบไม่ได้');
  await admin.post('/admin/features/qr', { on: '0' });
  assert.doesNotMatch((await admin.get(`/s/${sub.id}/print`)).text, /class="qr-corner"/);
  assert.equal((await anon.get(`/v/${sub.verify_code}`)).status, 404);
  await admin.post('/admin/features/qr', { on: '1' });
});

test('ผลการสอนและแฟ้ม PA ของครู', async () => {
  const t = await as('teacher');
  const r = await t.get('/results');
  assert.match(r.text, /data-bars=/);
  assert.match(r.text, /แผนที่ควรสอนซ่อมเสริม/);
  const pa = await t.get('/pa/print?year=2569&inc=memo&inc=eval&inc=summary&inc=results&inc=notes');
  assert.match(pa.text, /แฟ้มผลงานการจัดการเรียนรู้/);
  assert.match(pa.text, /สรุปผลงานการจัดการเรียนรู้/);
  assert.match(pa.text, /ผลการจัดการเรียนรู้รายแผน/);
  assert.match(pa.text, /บันทึกข้อความ/);
  // ไม่เห็นงานของครูคนอื่นในแฟ้ม
  assert.doesNotMatch(pa.text, /ว21101/);
});

test('ข้อความสรุปเข้า LINE มีเฉพาะจำนวนงาน ไม่มีชื่อครู', () => {
  const line = require('../src/line');
  const text = line.summaryText(db.getSettings());
  assert.match(text, /สรุปงานรอลงนาม/);
  assert.match(text, /รวม \d+ รายการ/);
  for (const u of db.q.all('SELECT full_name FROM users')) assert.ok(!text.includes(u.full_name));
});

test('ผู้ดูแลระบบดำเนินการแทนได้ทุกขั้น ไม่ใส่ลายเซ็นของผู้อื่น และบันทึกในประวัติ', async () => {
  const admin = await as('admin');
  const teacher = await as('teacher');
  // งานที่ค้างอยู่ที่ผู้ตรวจ: ครูทั่วไปกดแทนไม่ได้
  const pending = db.q.get("SELECT * FROM submissions WHERE doc_type = 'plan' AND status = 'pending' AND teacher_id != (SELECT id FROM users WHERE username = 'admin') LIMIT 1");
  await teacher.post(`/s/${pending.id}/admin-finish`, {});
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', pending.id).status, 'pending');
  // ดันผ่านทีละระดับ
  const before = pending.current_role;
  await admin.post(`/s/${pending.id}/admin-advance`, { comment: 'ผู้บริหารลงนามในกระดาษแล้ว' });
  const after = db.q.get('SELECT * FROM submissions WHERE id = ?', pending.id);
  assert.notEqual(after.current_role, before);
  const ov = db.q.get("SELECT * FROM reviews WHERE submission_id = ? AND action = 'override'", pending.id);
  assert.equal(ov.role, before);
  assert.equal(ov.signature, null, 'ต้องไม่ใส่ลายเซ็นของใครแทน');
  // ให้ผ่านครบทุกระดับ
  await admin.post(`/s/${pending.id}/admin-finish`, {});
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', pending.id).status, 'approved');
  const memo = (await admin.get(`/s/${pending.id}/print`)).text;
  assert.doesNotMatch(memo, /ผู้ดูแลระบบดำเนินการแทน/, 'เอกสารที่พิมพ์ต้องเว้นช่องว่างไว้ให้ผู้บริหารเซ็นมือ');
  assert.match((await admin.get(`/s/${pending.id}`)).text, /ผู้ดูแลระบบดำเนินการแทน/, 'ประวัติในระบบยังต้องบันทึกไว้');
  const director = db.q.get("SELECT signature FROM users WHERE username = 'director'").signature;
  assert.ok(!memo.includes(director), 'ลายเซ็นผู้อำนวยการต้องไม่ปรากฏ เมื่อผู้อำนวยการไม่ได้ลงนามเอง');
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ให้ผ่านครบทุกระดับแทน%'"));
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ดำเนินการแทน%'"));
  // ฉบับร่างของครู: ผู้ดูแลแก้และส่งแทนได้
  const draft = db.q.get("SELECT * FROM submissions WHERE doc_type = 'plan' AND status = 'draft' LIMIT 1");
  assert.equal((await admin.get(`/s/${draft.id}/edit`)).status, 200);
  await admin.post(`/s/${draft.id}/submit`, {});
  const sent = db.q.get('SELECT * FROM submissions WHERE id = ?', draft.id);
  assert.equal(sent.status, 'pending');
  assert.match(db.q.get("SELECT step_label FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') ORDER BY id DESC", draft.id).step_label, /ผู้ดูแลระบบส่งแทนครู/);
});

test('ผู้ดูแลระบบตั้งรหัสผ่านใหม่ให้ผู้ใช้ เลือกได้ว่าบังคับเปลี่ยนหรือไม่', async () => {
  const admin = await as('admin');
  const id = db.q.get("SELECT id FROM users WHERE username = 'thai2'").id;
  await admin.post(`/admin/users/${id}/reset`, { password: 'newpass99' });
  assert.equal(db.q.get('SELECT must_change_password AS m FROM users WHERE id = ?', id).m, 0);
  const c = new Client();
  const r = await c.post('/login', { username: 'thai2', password: 'newpass99' });
  assert.equal(r.location, '/');
  await admin.post(`/admin/users/${id}/reset`, { password: 'temp1234', must_change: '1' });
  assert.equal(db.q.get('SELECT must_change_password AS m FROM users WHERE id = ?', id).m, 1);
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ตั้งรหัสผ่านใหม่ให้%'"));
});

test('เปิดอ่านไฟล์ PDF ในหน้าเว็บได้ ไม่ต้องดาวน์โหลด', async () => {
  const t = await as('teacher');
  const f = db.q.get("SELECT f.id, f.submission_id FROM files f JOIN submissions s ON s.id = f.submission_id JOIN users u ON u.id = s.teacher_id WHERE u.username = 'teacher' AND f.mime = 'application/pdf' LIMIT 1");
  const page = await t.get(`/s/${f.submission_id}`);
  assert.match(page.text, /data-pdfbox/);
  assert.match(page.text, /pdfview\.js/);
  const view = await t.get(`/f/${f.id}/view`);
  assert.equal(view.status, 200);
  assert.match(view.text, new RegExp(`data-src="/f/${f.id}"`));
  // ข้อมูลไฟล์สำหรับตัวแสดง ไม่บอกชื่อและชนิด PDF (กันโปรแกรมช่วยดาวน์โหลดดัก)
  const raw = await fetch(base + '/f/' + f.id + '/raw', { headers: { cookie: t.header() } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-disposition'), null);
  assert.doesNotMatch(raw.headers.get('content-type'), /pdf/);
  assert.equal(Buffer.from(await raw.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const lib = await t.get('/vendor/pdfjs/legacy/build/pdf.min.mjs');
  assert.equal(lib.status, 200);
  // ครูต่างกลุ่มสาระเปิดดูไม่ได้
  const other = await as('math2');
  assert.equal((await other.get(`/f/${f.id}/view`)).status, 404);
  assert.equal((await other.get(`/f/${f.id}/raw`)).status, 404);
});
