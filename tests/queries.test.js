// จำนวนคำสั่งฐานข้อมูลต่อหน้า (ตอน 9): บน Supabase ทุกคำสั่งคือการเดินทางไปกลับ และ Hyperdrive แบบฟรีจำกัดจำนวนต่อวัน
// หน้าสำคัญใช้ไม่เกิน 15 คำสั่ง ไม่โตตามจำนวนงาน หน้ารายการไม่ดึงรูปลายเซ็น
// งานหลายรายการ (ลงนามหลายงาน นำเข้ารายชื่อ นำเข้ารายวิชา) รวมคำสั่งแล้วต้องได้ผลเหมือนทำทีละรายการ
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const wf = require('../src/workflow');
const auth = require('../src/auth');

const LIMIT = db.QUERY_LIMIT;
let base;
let server;
// ตัวเลขของคำขอล่าสุด (บันทึกก่อนส่งหัวคำตอบ จึงพร้อมทันทีที่ได้คำตอบ)
let last = null;

test.before(async () => {
  await seed.main({ target: ':memory:', keepOpen: true });
  db.watchQueries((req, stat) => {
    last = { url: req.originalUrl, ...stat };
  });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  db.watchQueries(null);
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
    last = null;
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    assert.ok(last && last.url === url, `ไม่ได้ตัวเลขของ ${url}`);
    return { status: res.status, text, location: res.headers.get('location'), ...last };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields) {
    return this.req('POST', url, fields instanceof URLSearchParams ? fields : new URLSearchParams(fields));
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

async function uid(username) {
  return (await db.q.get('SELECT id FROM users WHERE username = ?', username)).id;
}

// หน้ารายการทั้งหมด: ไม่เกิน 15 คำสั่ง และไม่มีรูปลายเซ็นติดมา
const LIST_PAGES = [
  '/',
  '/my',
  '/inbox',
  '/inbox?type=note',
  '/registry?type=plan',
  '/registry?type=manual',
  '/registry?type=note',
  '/registry.csv?type=note',
  '/dept',
  '/stats',
  '/notes',
  '/send',
  '/results',
  '/pa',
  '/quicksign',
  '/teaching',
  '/alerts',
];
const PA_PRINT = '/pa/print?year=2569&inc=memo&inc=eval&inc=summary&inc=results&inc=notes';

test('หน้าสำคัญใช้ไม่เกิน 15 คำสั่ง หน้ารายการและหน้ารายละเอียดไม่ดึงรูปลายเซ็น', async () => {
  const subs = await db.q.all('SELECT id, doc_type, status, verify_code FROM submissions ORDER BY id');
  for (const user of ['admin', 'director', 'deputy', 'acad', 'section', 'scihead', 'mathhead', 'teacher', 'sci2']) {
    const c = await as(user);
    for (const url of LIST_PAGES) {
      const r = await c.get(url);
      assert.ok(r.queries <= LIMIT, `${user} ${url} ใช้ ${r.queries} คำสั่ง`);
      assert.equal(r.blobs, 0, `${user} ${url} ดึงรูปลายเซ็น ${r.blobs} รูป`);
    }
    const pa = await c.get(PA_PRINT);
    assert.ok(pa.queries <= LIMIT, `${user} แฟ้ม PA ใช้ ${pa.queries} คำสั่ง`);
    if (!['admin', 'director', 'teacher'].includes(user)) continue;
    for (const s of subs) {
      const detail = await c.get(`/s/${s.id}`);
      assert.ok(detail.queries <= LIMIT, `${user} /s/${s.id} ใช้ ${detail.queries} คำสั่ง`);
      assert.equal(detail.blobs, 0, `${user} /s/${s.id} ดึงรูปลายเซ็น`);
      const prints = [`/s/${s.id}/print`];
      if (s.doc_type !== 'note') prints.push(`/s/${s.id}/print?doc=eval`);
      if (s.doc_type === 'plan') prints.push(`/s/${s.id}/print-notes`);
      for (const url of prints) {
        const r = await c.get(url);
        assert.ok(r.queries <= LIMIT, `${user} ${url} ใช้ ${r.queries} คำสั่ง`);
      }
    }
  }
  // หน้าตรวจเอกสารจาก QR เปิดได้โดยไม่เข้าระบบ
  const guest = new Client();
  for (const s of subs.filter((x) => x.status !== 'draft')) {
    const r = await guest.get(`/v/${s.verify_code}`);
    assert.equal(r.status, 200);
    assert.ok(r.queries <= LIMIT);
    assert.equal(r.blobs, 0, 'หน้าตรวจเอกสารไม่ต้องใช้รูปลายเซ็น');
  }
});

test('หน้าพิมพ์ยังมีรูปลายเซ็นครบ และจำนวนคำสั่งไม่เพิ่มเมื่องานเพิ่ม', async () => {
  const plan = await db.q.get(
    `SELECT p.id, u.username FROM submissions p JOIN users u ON u.id = p.teacher_id
     WHERE p.doc_type = 'plan' AND EXISTS (SELECT 1 FROM submissions n WHERE n.parent_id = p.id AND n.status = 'approved')
     ORDER BY p.id LIMIT 1`
  );
  assert.ok(plan, 'ข้อมูลทดลองต้องมีแผนที่มีบันทึกหลังแผนผ่านครบ');
  const owner = await as(plan.username);
  const admin = await as('admin');
  const head = await as('scihead');
  const pages = [
    [owner, `/s/${plan.id}/print-notes`],
    [owner, PA_PRINT],
    [owner, '/notes'],
    [owner, '/'],
    [owner, '/my'],
    [owner, `/s/${plan.id}`],
    [admin, '/registry?type=note'],
    [admin, '/dept'],
    [head, '/inbox'],
    [head, '/'],
  ];
  const before = [];
  for (const [c, url] of pages) before.push((await c.get(url)).queries);
  const book = await owner.get(`/s/${plan.id}/print-notes`);
  assert.ok(book.blobs > 0, 'หน้าพิมพ์ต้องมีรูปลายเซ็น');

  // เพิ่มบันทึกที่ผ่านครบอีก 12 ฉบับ (ลอกฉบับเดิมพร้อมประวัติการลงนาม)
  const src = await db.q.get("SELECT id FROM submissions WHERE parent_id = ? AND status = 'approved' ORDER BY id LIMIT 1", plan.id);
  for (let i = 0; i < 12; i++) {
    const { id } = await db.q.get(
      `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level,
         plan_no, topic, status, current_role, students_total, students_passed, teacher_signature, created_at, updated_at, submitted_at, completed_at)
       SELECT doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level,
         ?, topic, status, current_role, students_total, students_passed, teacher_signature, created_at, updated_at, submitted_at, completed_at
       FROM submissions WHERE id = ? RETURNING id`,
      String(200 + i),
      src.id
    );
    await db.q.run(
      `INSERT INTO reviews (submission_id, role, step_label, user_id, user_name, user_position, action, comment, score_total, score_max, score_detail, signature, created_at)
       SELECT ?, role, step_label, user_id, user_name, user_position, action, comment, score_total, score_max, score_detail, signature, created_at
       FROM reviews WHERE submission_id = ? ORDER BY id`,
      id,
      src.id
    );
  }
  for (let i = 0; i < pages.length; i++) {
    const [c, url] = pages[i];
    assert.equal((await c.get(url)).queries, before[i], `${url} จำนวนคำสั่งต้องเท่าเดิมเมื่องานเพิ่ม`);
  }
  const bigger = await owner.get(`/s/${plan.id}/print-notes`);
  assert.equal(bigger.queries, book.queries);
  // ลายเซ็นครูและผู้ลงนามของทุกฉบับยังอยู่บนกระดาษ
  const sigs = (await db.q.all("SELECT DISTINCT signature FROM reviews WHERE submission_id = ? AND action = 'approve'", src.id)).map((r) => r.signature);
  sigs.push((await db.q.get('SELECT teacher_signature FROM submissions WHERE id = ?', src.id)).teacher_signature);
  for (const sig of sigs) assert.ok(bigger.text.split(sig).length - 1 >= 13, 'รูปลายเซ็นต้องอยู่ครบทุกฉบับ');
});

test('ลงนามหลายงานพร้อมกัน ได้ผลเหมือนลงนามทีละงาน และจำนวนคำสั่งคงที่', async () => {
  await db.setSetting('ff_selfsign', '0');
  await db.ensureRefs();
  const load = async (name) => auth.loadUser(await uid(name));
  const [teacher, acad, scihead, mathhead, section, deputy, director] = await Promise.all(
    ['teacher', 'acad', 'scihead', 'mathhead', 'section', 'deputy', 'director'].map(load)
  );
  const full = (type) => Object.fromEntries(wf.rubric(type).map((it) => [it.id, String(it.max_score)]));
  async function work(owner, type, code, parentId = null) {
    const now = db.nowStr();
    return (
      await db.q.get(
        `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 2569, 2, ?, 'วิชาทดสอบ', ?, ?) RETURNING id`,
        type,
        parentId,
        owner.id,
        owner.department_id,
        code,
        now,
        now
      )
    ).id;
  }
  // ชุดงานแบบเดียวกัน 2 ชุด: แผนรอหัวหน้างาน · บันทึกรอหัวหน้ากลุ่มสาระ · คู่มือที่ต้องให้คะแนน (ข้าม)
  // แผนของหัวหน้ากลุ่มบริหารวิชาการ (ระดับถัดไปเป็นตัวเอง ต้องข้ามระดับ) · id ซ้ำ · id ที่ไม่มี
  async function makeSet() {
    const plan1 = await work(teacher, 'plan', 'ว30203');
    await wf.submit(plan1, teacher);
    await wf.approve(plan1, scihead, { scores: full('plan') });
    const note1 = await work(teacher, 'note', 'ว30203', plan1);
    await wf.submit(note1, teacher);
    const manual1 = await work(teacher, 'manual', 'ว30207');
    await wf.submit(manual1, teacher);
    const plan2 = await work(acad, 'plan', 'ค21101');
    await wf.submit(plan2, acad);
    await wf.approve(plan2, mathhead, { scores: full('plan') });
    return [plan1, note1, manual1, plan2, plan1, 2000000000];
  }
  // วิธีเดิมของหน้ากล่องงาน (ลงนามทีละงาน)
  async function oneByOne(ids, actor, comment) {
    let done = 0;
    let skipped = 0;
    for (const id of ids) {
      const sub = await wf.getSub(id);
      if (!sub || !wf.canReview(actor, sub) || wf.needsScore(sub)) {
        skipped += 1;
        continue;
      }
      await wf.approve(id, actor, { comment });
      done += 1;
    }
    return { done, skipped };
  }
  const A = await makeSet();
  const B = await makeSet();
  const counts = [];
  for (const who of [scihead, section, acad, deputy, director]) {
    const a = await oneByOne(A, who, 'เห็นชอบ');
    const b = await db.withScope(async () => {
      const r = await wf.approveMany(B, who, { comment: 'เห็นชอบ' });
      if (r.done) counts.push(db.queryCount());
      return r;
    });
    assert.deepEqual(b, a, `ผลการลงนามของ ${who.username} ต้องเท่ากัน`);
  }
  const view = async (id) => {
    const s = await db.q.get('SELECT status, current_role, score_total, score_role, completed_at FROM submissions WHERE id = ?', id);
    const revs = await db.q.all(
      'SELECT role, step_label, user_id, user_name, user_position, action, comment, signature FROM reviews WHERE submission_id = ? ORDER BY id',
      id
    );
    return { ...s, completed_at: Boolean(s.completed_at), revs };
  };
  for (let i = 0; i < 4; i++) assert.deepEqual(await view(B[i]), await view(A[i]), `งานลำดับที่ ${i + 1} ต้องได้ผลเหมือนกัน`);
  const plan2 = await view(B[3]);
  assert.equal(plan2.status, 'approved');
  assert.ok(plan2.revs.some((r) => r.action === 'skip' && r.role === 'academic_head'), 'ข้ามระดับที่ผู้ส่งเป็นผู้ตรวจเอง');
  assert.equal((await view(B[2])).current_role, 'dept_head', 'งานที่ต้องให้คะแนนไม่ถูกลงนามแบบรวม');
  // ลงนาม 1 งาน หรือ 3 งาน ใช้จำนวนคำสั่งเท่ากัน
  assert.ok(counts.length >= 3);
  assert.equal(new Set(counts).size, 1, `จำนวนคำสั่งต้องคงที่ ได้ ${counts.join(' ')}`);
  await db.setSetting('ff_selfsign', '1');
});

test('นำเข้ารายชื่อครู: แถวซ้ำในชุดเดียวได้ผลเหมือนทำทีละแถว และจำนวนคำสั่งคงที่', async () => {
  const admin = await as('admin');
  const sci = (await db.q.get('SELECT department_id FROM users WHERE username = ?', 'teacher')).department_id;
  const sci2 = await db.q.get('SELECT full_name, position, department_id FROM users WHERE username = ?', 'sci2');
  const small = [
    'imp_a\tนายเอ ทดลอง\tครู\tวิทยาศาสตร์\t',
    'IMP_A\tนายเอ แก้ชื่อ\tครูชำนาญการ\t\tหัวหน้ากลุ่มสาระ',
    `sci2\t${sci2.full_name}\t${sci2.position}\t\t`,
  ].join('\n');
  const r1 = await admin.post('/admin/users-import', { password: 'abcdef', data: small });
  assert.match(r1.text, /เพิ่มใหม่ <b>1<\/b> คน ปรับปรุงข้อมูลเดิม <b>2<\/b> คน/);
  const a = await db.q.get('SELECT id, full_name, position, department_id, must_change_password FROM users WHERE username = ?', 'imp_a');
  assert.deepEqual(
    { full_name: a.full_name, position: a.position, department_id: a.department_id, must: a.must_change_password },
    { full_name: 'นายเอ แก้ชื่อ', position: 'ครูชำนาญการ', department_id: sci, must: 1 },
    'แถวหลังแก้คนเดิม กลุ่มสาระว่างใช้ของเดิม'
  );
  assert.deepEqual(await wf.rolesOf(a.id), ['dept_head']);
  assert.equal((await db.q.get('SELECT department_id FROM users WHERE username = ?', 'sci2')).department_id, sci2.department_id);
  assert.equal(await auth.verifyPassword('abcdef', a.id), true);

  const big = [
    ...Array.from({ length: 8 }, (_, i) => `imp_b${i}\tนายบี ทดลองที่${i}\tครู\tคณิตศาสตร์\t${i % 2 ? 'หัวหน้ากลุ่มสาระ' : ''}`),
    'imp_b0\tนายบี แก้ชื่อ\tครู\t\t',
    `sci2\t${sci2.full_name}\t${sci2.position}\t\t`,
  ].join('\n');
  const r2 = await admin.post('/admin/users-import', { password: 'abcdef', data: big });
  assert.match(r2.text, /เพิ่มใหม่ <b>8<\/b> คน ปรับปรุงข้อมูลเดิม <b>2<\/b> คน/);
  assert.equal(r2.queries, r1.queries, 'นำเข้า 3 แถวหรือ 10 แถว ใช้จำนวนคำสั่งเท่ากัน');
  assert.deepEqual(await wf.rolesOf(await uid('imp_b1')), ['dept_head']);
  assert.equal((await db.q.get('SELECT full_name FROM users WHERE username = ?', 'imp_b0')).full_name, 'นายบี แก้ชื่อ');
});

test('นำเข้ารายวิชาจากตารางสอน: ครูซ้ำในไฟล์ได้ผลเหมือนเพิ่มทีละวิชา และจำนวนคำสั่งคงที่', async () => {
  const admin = await as('admin');
  const t = await uid('teacher');
  const fields = (rows) => {
    const f = new URLSearchParams({ year: '2569', semester: '2', n: String(rows.length) });
    rows.forEach(([who, subjects], i) => {
      f.set(`map_${i}`, String(who));
      f.set(`subj_${i}`, JSON.stringify(subjects));
      for (const s of subjects) f.append(`pick_${i}`, s.code);
    });
    return f;
  };
  const r1 = await admin.post(
    '/admin/teach-import',
    fields([
      [t, [{ code: 'ว39001', name: 'วิชาทดลอง 1', grade: 'ม.6' }, { code: 'ว39002', name: 'วิชาทดลอง 2', grade: '' }]],
      [t, [{ code: 'ว39002', name: '', grade: 'ม.5' }]],
    ])
  );
  assert.equal(r1.status, 302);
  assert.match((await admin.get('/admin/teach-import')).text, /ครู 1 คน เพิ่มรายวิชาใหม่ 2 รายการ \(มีอยู่แล้ว 1 รายการ ไม่ซ้ำ\)/);
  const row = await db.q.get("SELECT subject_name, grade_level, is_main FROM teach_subjects WHERE teacher_id = ? AND subject_code = 'ว39002'", t);
  assert.deepEqual({ ...row }, { subject_name: 'วิชาทดลอง 2', grade_level: 'ม.5', is_main: 0 }, 'ชื่อและชั้นใช้ค่าล่าสุดที่ไม่ว่าง');
  assert.equal((await db.q.get("SELECT name FROM subjects WHERE code = 'ว39002'")).name, 'วิชาทดลอง 2', 'รายวิชาของโรงเรียนใช้ชื่อแรกที่พบ');

  const others = await Promise.all(['sci2', 'math2', 'thai2'].map(uid));
  const r2 = await admin.post(
    '/admin/teach-import',
    fields(others.map((id, i) => [id, [1, 2, 3].map((k) => ({ code: `ว3910${i}${k}`, name: `วิชา ${i}${k}`, grade: 'ม.4' }))]))
  );
  assert.equal(r2.status, 302);
  assert.equal(r2.queries, r1.queries, 'นำเข้า 3 วิชาหรือ 9 วิชา ใช้จำนวนคำสั่งเท่ากัน');
  assert.equal((await db.q.get("SELECT COUNT(*) AS n FROM teach_subjects WHERE subject_code LIKE 'ว3910%'")).n, 9);
});
