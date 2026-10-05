// ทดสอบกฎการส่งต่อ 5 ระดับ ด้วยฐานข้อมูลชั่วคราวในหน่วยความจำ (PGlite ไม่แตะข้อมูลจริง)
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const wf = require('../src/workflow');

const { q, nowStr } = db;
let SCI, MATH, teacher, head, section, academic, deputy, director, mathTeacher, mathHead;

async function user(username, dept, roles = []) {
  const { id } = await q.get(
    "INSERT INTO users (username, password_hash, full_name, department_id, signature, created_at) VALUES (?, 'x', ?, ?, 'data:image/png;base64,AAAA', ?) RETURNING id",
    username,
    `ครู ${username}`,
    dept,
    nowStr()
  );
  for (const role of roles) await q.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', id, role);
  const u = await q.get('SELECT * FROM users WHERE id = ?', id);
  u.roles = roles;
  return u;
}

async function work(t, type, code, parentId = null) {
  const r = await q.get(
    `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2569, 2, ?, 'วิชาทดสอบ', 'ม.5', ?, ?) RETURNING id`,
    type,
    parentId,
    t.id,
    t.department_id,
    code,
    nowStr(),
    nowStr()
  );
  return r.id;
}

function fullScores(type, value = 5) {
  return Object.fromEntries(wf.rubric(type).map((it) => [it.id, String(value)]));
}

test.before(async () => {
  await db.open(':memory:');
  SCI = (await q.get('SELECT id FROM departments WHERE name ILIKE ?', 'วิทยาศาสตร์%')).id;
  MATH = (await q.get('SELECT id FROM departments WHERE name = ?', 'คณิตศาสตร์')).id;
  teacher = await user('t1', SCI);
  head = await user('h1', SCI, ['dept_head']);
  section = await user('s1', SCI, ['section_head']);
  academic = await user('a1', MATH, ['academic_head']);
  deputy = await user('d1', null, ['deputy_academic']);
  director = await user('p1', null, ['director']);
  mathTeacher = await user('m1', MATH);
  mathHead = await user('mh', MATH, ['dept_head']);
});
// ฟังก์ชันที่ template เรียก (needsScore canReview rubric ฯลฯ) อ่านข้อมูลอ้างอิง ต้องโหลดก่อนทุกข้อ
test.beforeEach(() => db.ensureRefs());
test.after(() => db.close());

test('คู่มือรายวิชาผ่านครบ 5 ระดับ หัวหน้ากลุ่มสาระต้องให้คะแนนก่อน', async () => {
  const id = await work(teacher, 'manual', 'ว30203');
  let s = await wf.submit(id, teacher);
  assert.equal(s.status, 'pending');
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), true);
  assert.equal(wf.canReview(mathHead, s), false, 'หัวหน้ากลุ่มสาระอื่นตรวจไม่ได้');
  await assert.rejects(wf.approve(id, head, {}), /คะแนน/);
  s = await wf.approve(id, head, { scores: fullScores('manual', 4), comment: 'ดี' });
  assert.equal(s.score_total, 80);
  assert.equal(s.score_max, 100);
  assert.equal(wf.scoreLevel(80), 'ดี');
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), false, 'ระดับถัดไปไม่ต้องให้คะแนน');
  for (const u of [section, academic, deputy]) s = await wf.approve(id, u, { comment: 'เห็นชอบ' });
  assert.equal(s.current_role, 'director');
  s = await wf.approve(id, director, {});
  assert.equal(s.status, 'approved');
  assert.ok(s.completed_at);
  assert.deepEqual(
    (await wf.progress(s)).map((x) => x.state),
    ['done', 'done', 'done', 'done', 'done']
  );
  // ลายเซ็นที่บันทึกเป็นรูปจริงจากฐาน
  const sigs = (await wf.reviewsOf(id)).map((r) => r.signature);
  assert.ok(sigs.every((x) => x === 'data:image/png;base64,AAAA'));
  assert.equal((await wf.getSub(id)).teacher_signature, 'data:image/png;base64,AAAA');
});

test('ส่งกลับแก้ไข แล้วส่งใหม่ กลับไปที่ระดับที่ส่งคืน ไม่ต้องเริ่มใหม่', async () => {
  const id = await work(teacher, 'plan', 'ว30207');
  await wf.submit(id, teacher);
  await wf.approve(id, head, { scores: fullScores('plan') });
  await wf.approve(id, section, {});
  await assert.rejects(wf.sendBack(id, academic, { comment: '  ' }), /เหตุผล/);
  let s = await wf.sendBack(id, academic, { comment: 'แก้หน้า 3' });
  assert.equal(s.status, 'returned');
  assert.equal(s.returned_role, 'academic_head');
  assert.equal((await wf.progress(s))[2].state, 'returned');
  s = await wf.submit(id, teacher);
  assert.equal(s.current_role, 'academic_head');
  assert.equal(s.score_total, 100, 'คะแนนเดิมยังอยู่');
  assert.equal(wf.needsScore(s), false);
  const actions = (await wf.reviewsOf(id)).map((r) => r.action);
  assert.deepEqual(actions, ['submit', 'approve', 'approve', 'return', 'resubmit']);
});

test('หัวหน้ากลุ่มสาระส่งกลับ แล้วครูส่งใหม่ หัวหน้ากลุ่มสาระให้คะแนนใหม่ได้', async () => {
  const id = await work(teacher, 'manual', 'ว22201');
  await wf.submit(id, teacher);
  await wf.sendBack(id, head, { comment: 'ยังไม่ครบ' });
  const s = await wf.submit(id, teacher);
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), true);
});

test('ปิดการลงนามงานตัวเอง: ผู้ส่งเป็นผู้ตรวจระดับนั้นเอง ระบบข้ามให้ และระดับถัดไปให้คะแนนแทน', async () => {
  await db.setSetting('ff_selfsign', '0');
  // หัวหน้างาน (ระดับ 2) ส่งงานของตัวเอง
  const id1 = await work(section, 'plan', 'ว30101');
  await wf.submit(id1, section);
  let s = await wf.approve(id1, head, { scores: fullScores('plan') });
  assert.equal(s.current_role, 'academic_head', 'ข้ามระดับ 2');
  assert.equal((await wf.reviewsOf(id1)).filter((r) => r.action === 'skip').length, 1);
  assert.equal((await wf.progress(s))[1].state, 'skipped');

  // หัวหน้ากลุ่มสาระส่งงานของตัวเอง ไม่มีคนอื่นในระดับ 1 ระดับ 2 ต้องให้คะแนนแทน
  const id2 = await work(head, 'plan', 'ว30102');
  s = await wf.submit(id2, head);
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), true);
  s = await wf.approve(id2, section, { scores: fullScores('plan', 3) });
  assert.equal(s.score_total, 60);
  assert.equal(wf.scoreLevel(60), 'ปานกลาง');
  await db.setSetting('ff_selfsign', '1');
});

test('เปิดการลงนามงานตัวเอง: หัวหน้ากลุ่มสาระให้คะแนนงานตัวเอง หัวหน้างานลงนามงานตัวเองในช่องของตน', async () => {
  assert.equal(wf.selfSign(), true, 'ค่าเริ่มต้นเปิดอยู่');
  const id = await work(head, 'plan', 'ว30301');
  let s = await wf.submit(id, head);
  assert.equal(s.current_role, 'dept_head', 'ไม่ข้ามระดับของตัวเอง');
  assert.equal(wf.canReview(head, s), true);
  assert.ok((await wf.inbox(head)).some((x) => x.id === id), 'งานของตัวเองขึ้นในงานรอตรวจ');
  assert.equal(wf.needsScore(s), true);
  s = await wf.approve(id, head, { scores: fullScores('plan', 4) });
  assert.equal(s.score_total, 80);
  assert.equal(s.score_role, 'dept_head');
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), false, 'ระดับถัดไปไม่ต้องให้คะแนนซ้ำ');

  const id2 = await work(section, 'manual', 'ว30302');
  await wf.submit(id2, section);
  s = await wf.approve(id2, head, { scores: fullScores('manual') });
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.canReview(section, s), true);
  assert.deepEqual((await wf.progress(s))[1].people.map((u) => u.id), [section.id]);
  s = await wf.approve(id2, section, { comment: 'เห็นชอบ' });
  assert.equal(s.current_role, 'academic_head');
  assert.equal((await wf.reviewsOf(id2)).filter((r) => r.action === 'skip').length, 0);
  assert.equal(wf.canReview(teacher, s), false, 'ครูทั่วไปยังลงนามไม่ได้');
});

test('บันทึกหลังแผนผ่าน 3 ระดับ ไม่ต้องให้คะแนน', async () => {
  const planId = await work(teacher, 'plan', 'ว30299');
  await wf.submit(planId, teacher);
  const noteId = await work(teacher, 'note', 'ว30299', planId);
  let s = await wf.submit(noteId, teacher);
  assert.deepEqual(
    wf.activeSteps('note').map((x) => x.role),
    ['dept_head', 'deputy_academic', 'director']
  );
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), false);
  s = await wf.approve(noteId, head, {});
  assert.equal(s.current_role, 'deputy_academic');
  s = await wf.approve(noteId, deputy, {});
  s = await wf.approve(noteId, director, {});
  assert.equal(s.status, 'approved');
  assert.equal(wf.statusText(s), 'ลงนามครบแล้ว');
});

test('ระดับที่ยังไม่มีใครรับผิดชอบ งานรอไว้ ไม่ข้ามไปเอง', async () => {
  await q.run("DELETE FROM user_roles WHERE role = 'academic_head'");
  const id = await work(teacher, 'manual', 'ว30500');
  await wf.submit(id, teacher);
  await wf.approve(id, head, { scores: fullScores('manual') });
  const s = await wf.approve(id, section, {});
  assert.equal(s.status, 'pending');
  assert.equal(s.current_role, 'academic_head');
  assert.equal((await wf.progress(s))[2].people.length, 0);
  await q.run("INSERT INTO user_roles (user_id, role) VALUES (?, 'academic_head')", academic.id);
  assert.equal((await wf.inbox(academic)).some((x) => x.id === id), true, 'กำหนดคนแล้ว งานเข้ากล่องทันที');
});

test('ดึงงานกลับได้เฉพาะตอนยังไม่มีใครลงนาม', async () => {
  const id = await work(teacher, 'plan', 'ว30600');
  await wf.submit(id, teacher);
  assert.equal(await wf.canWithdraw(teacher, await wf.getSub(id)), true);
  let s = await wf.withdraw(id, teacher);
  assert.equal(s.status, 'draft');
  await wf.submit(id, teacher);
  await wf.approve(id, head, { scores: fullScores('plan') });
  s = await wf.getSub(id);
  assert.equal(await wf.canWithdraw(teacher, s), false);
  await assert.rejects(wf.withdraw(id, teacher), /ลงนามแล้ว/);
});

test('สิทธิ์เปิดดู: ครูต่างกลุ่มสาระและหัวหน้ากลุ่มสาระอื่นดูไม่ได้ ผู้ตรวจระดับโรงเรียนดูได้', async () => {
  const id = await work(teacher, 'manual', 'ว30700');
  const s = await wf.getSub(id);
  assert.equal(await wf.canView(teacher, s), true);
  assert.equal(await wf.canView(mathTeacher, s), false);
  assert.equal(await wf.canView(mathHead, s), false);
  assert.equal(await wf.canView(head, s), true);
  assert.equal(await wf.canView(director, s), true);
});

test('เกณฑ์ระดับคุณภาพตามแบบประเมินของโรงเรียน', () => {
  assert.equal(wf.scoreLevel(95), 'ดีมาก');
  assert.equal(wf.scoreLevel(90), 'ดีมาก');
  assert.equal(wf.scoreLevel(89), 'ดี');
  assert.equal(wf.scoreLevel(50), 'ปานกลาง');
  assert.equal(wf.scoreLevel(30), 'พอใช้');
  assert.equal(wf.scoreLevel(20), 'ปรับปรุง');
});

test('ลงนามขั้นเดียวกันพร้อมกัน 2 คำขอ ผ่านแค่ครั้งเดียว (ล็อกแถว)', async () => {
  const id = await work(teacher, 'note', 'ว30800', null);
  await wf.submit(id, teacher);
  const results = await Promise.allSettled([db.withScope(() => wf.approve(id, head, {})), db.withScope(() => wf.approve(id, head, {}))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /ไม่ใช่ผู้ตรวจ/);
  assert.equal((await wf.reviewsOf(id)).filter((r) => r.action === 'approve').length, 1);
});

test('รหัสผ่านเข้ารหัสในฐานข้อมูล (bcrypt ของ pgcrypto) ตรวจถูกและผิดได้', async () => {
  const auth = require('../src/auth');
  const h = await auth.hashPassword('1234');
  assert.match(h, /^\$2a\$08\$/);
  await q.run('UPDATE users SET password_hash = ? WHERE id = ?', h, teacher.id);
  assert.equal(await auth.verifyPassword('1234', teacher.id), true);
  assert.equal(await auth.verifyPassword('1235', teacher.id), false);
  assert.equal(await auth.verifyPassword('1234', 999999), false);
  const me = await auth.loadUser(teacher.id);
  assert.equal(me.password_hash, undefined, 'ไม่ดึงรหัสผ่านที่เข้ารหัสแล้ว');
  assert.match(me.signature, /^\/media\/signature\?v=[0-9a-f]{8}$/);
  assert.equal(await auth.minPassword(me, true), 4);
  assert.equal(await auth.minPassword(await auth.loadUser(director.id), true), 6);
});
