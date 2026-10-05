// ทดสอบกฎการส่งต่อ 5 ระดับ ด้วยฐานข้อมูลชั่วคราวในหน่วยความจำ (ไม่แตะข้อมูลจริง)
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const wf = require('../src/workflow');

db.open(':memory:');
const { q, nowStr } = db;

const SCI = q.get('SELECT id FROM departments WHERE name LIKE ?', 'วิทยาศาสตร์%').id;
const MATH = q.get('SELECT id FROM departments WHERE name = ?', 'คณิตศาสตร์').id;

function user(username, dept, roles = []) {
  const r = q.run(
    "INSERT INTO users (username, password_hash, full_name, department_id, signature, created_at) VALUES (?, 'x', ?, ?, 'data:image/png;base64,AAAA', ?)",
    username,
    `ครู ${username}`,
    dept,
    nowStr()
  );
  const id = Number(r.lastInsertRowid);
  for (const role of roles) q.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', id, role);
  const u = q.get('SELECT * FROM users WHERE id = ?', id);
  u.roles = roles;
  return u;
}

function work(teacher, type, code, parentId = null) {
  const r = q.run(
    `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2569, 2, ?, 'วิชาทดสอบ', 'ม.5', ?, ?)`,
    type,
    parentId,
    teacher.id,
    teacher.department_id,
    code,
    nowStr(),
    nowStr()
  );
  return Number(r.lastInsertRowid);
}

function fullScores(type, value = 5) {
  return Object.fromEntries(wf.rubric(type).map((it) => [it.id, String(value)]));
}

const teacher = user('t1', SCI);
const head = user('h1', SCI, ['dept_head']);
const section = user('s1', SCI, ['section_head']);
const academic = user('a1', MATH, ['academic_head']);
const deputy = user('d1', null, ['deputy_academic']);
const director = user('p1', null, ['director']);
const mathTeacher = user('m1', MATH);
const mathHead = user('mh', MATH, ['dept_head']);

test('คู่มือรายวิชาผ่านครบ 5 ระดับ หัวหน้ากลุ่มสาระต้องให้คะแนนก่อน', () => {
  const id = work(teacher, 'manual', 'ว30203');
  let s = wf.submit(id, teacher);
  assert.equal(s.status, 'pending');
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), true);
  assert.equal(wf.canReview(mathHead, s), false, 'หัวหน้ากลุ่มสาระอื่นตรวจไม่ได้');
  assert.throws(() => wf.approve(id, head, {}), /คะแนน/);
  s = wf.approve(id, head, { scores: fullScores('manual', 4), comment: 'ดี' });
  assert.equal(s.score_total, 80);
  assert.equal(s.score_max, 100);
  assert.equal(wf.scoreLevel(80), 'ดี');
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), false, 'ระดับถัดไปไม่ต้องให้คะแนน');
  for (const u of [section, academic, deputy]) s = wf.approve(id, u, { comment: 'เห็นชอบ' });
  assert.equal(s.current_role, 'director');
  s = wf.approve(id, director, {});
  assert.equal(s.status, 'approved');
  assert.ok(s.completed_at);
  assert.deepEqual(
    wf.progress(s).map((x) => x.state),
    ['done', 'done', 'done', 'done', 'done']
  );
});

test('ส่งกลับแก้ไข แล้วส่งใหม่ กลับไปที่ระดับที่ส่งคืน ไม่ต้องเริ่มใหม่', () => {
  const id = work(teacher, 'plan', 'ว30207');
  wf.submit(id, teacher);
  wf.approve(id, head, { scores: fullScores('plan') });
  wf.approve(id, section, {});
  assert.throws(() => wf.sendBack(id, academic, { comment: '  ' }), /เหตุผล/);
  let s = wf.sendBack(id, academic, { comment: 'แก้หน้า 3' });
  assert.equal(s.status, 'returned');
  assert.equal(s.returned_role, 'academic_head');
  assert.equal(wf.progress(s)[2].state, 'returned');
  s = wf.submit(id, teacher);
  assert.equal(s.current_role, 'academic_head');
  assert.equal(s.score_total, 100, 'คะแนนเดิมยังอยู่');
  assert.equal(wf.needsScore(s), false);
  const actions = wf.reviewsOf(id).map((r) => r.action);
  assert.deepEqual(actions, ['submit', 'approve', 'approve', 'return', 'resubmit']);
});

test('หัวหน้ากลุ่มสาระส่งกลับ แล้วครูส่งใหม่ หัวหน้ากลุ่มสาระให้คะแนนใหม่ได้', () => {
  const id = work(teacher, 'manual', 'ว22201');
  wf.submit(id, teacher);
  wf.sendBack(id, head, { comment: 'ยังไม่ครบ' });
  const s = wf.submit(id, teacher);
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), true);
});

test('ปิดการลงนามงานตัวเอง: ผู้ส่งเป็นผู้ตรวจระดับนั้นเอง ระบบข้ามให้ และระดับถัดไปให้คะแนนแทน', () => {
  db.setSetting('ff_selfsign', '0');
  // หัวหน้างาน (ระดับ 2) ส่งงานของตัวเอง
  const id1 = work(section, 'plan', 'ว30101');
  wf.submit(id1, section);
  let s = wf.approve(id1, head, { scores: fullScores('plan') });
  assert.equal(s.current_role, 'academic_head', 'ข้ามระดับ 2');
  assert.equal(wf.reviewsOf(id1).filter((r) => r.action === 'skip').length, 1);
  assert.equal(wf.progress(s)[1].state, 'skipped');

  // หัวหน้ากลุ่มสาระส่งงานของตัวเอง ไม่มีคนอื่นในระดับ 1 ระดับ 2 ต้องให้คะแนนแทน
  const id2 = work(head, 'plan', 'ว30102');
  s = wf.submit(id2, head);
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), true);
  s = wf.approve(id2, section, { scores: fullScores('plan', 3) });
  assert.equal(s.score_total, 60);
  assert.equal(wf.scoreLevel(60), 'ปานกลาง');
  db.setSetting('ff_selfsign', '1');
});

test('เปิดการลงนามงานตัวเอง: หัวหน้ากลุ่มสาระให้คะแนนงานตัวเอง หัวหน้างานลงนามงานตัวเองในช่องของตน', () => {
  assert.equal(wf.selfSign(), true, 'ค่าเริ่มต้นเปิดอยู่');
  const id = work(head, 'plan', 'ว30301');
  let s = wf.submit(id, head);
  assert.equal(s.current_role, 'dept_head', 'ไม่ข้ามระดับของตัวเอง');
  assert.equal(wf.canReview(head, s), true);
  assert.ok(wf.inbox(head).some((x) => x.id === id), 'งานของตัวเองขึ้นในงานรอตรวจ');
  assert.equal(wf.needsScore(s), true);
  s = wf.approve(id, head, { scores: fullScores('plan', 4) });
  assert.equal(s.score_total, 80);
  assert.equal(s.score_role, 'dept_head');
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.needsScore(s), false, 'ระดับถัดไปไม่ต้องให้คะแนนซ้ำ');

  const id2 = work(section, 'manual', 'ว30302');
  wf.submit(id2, section);
  s = wf.approve(id2, head, { scores: fullScores('manual') });
  assert.equal(s.current_role, 'section_head');
  assert.equal(wf.canReview(section, s), true);
  assert.deepEqual(wf.progress(s)[1].people.map((u) => u.id), [section.id]);
  s = wf.approve(id2, section, { comment: 'เห็นชอบ' });
  assert.equal(s.current_role, 'academic_head');
  assert.equal(wf.reviewsOf(id2).filter((r) => r.action === 'skip').length, 0);
  assert.equal(wf.canReview(teacher, s), false, 'ครูทั่วไปยังลงนามไม่ได้');
});

test('บันทึกหลังแผนผ่าน 3 ระดับ ไม่ต้องให้คะแนน', () => {
  const planId = work(teacher, 'plan', 'ว30299');
  wf.submit(planId, teacher);
  const noteId = work(teacher, 'note', 'ว30299', planId);
  let s = wf.submit(noteId, teacher);
  assert.deepEqual(
    wf.activeSteps('note').map((x) => x.role),
    ['dept_head', 'deputy_academic', 'director']
  );
  assert.equal(s.current_role, 'dept_head');
  assert.equal(wf.needsScore(s), false);
  s = wf.approve(noteId, head, {});
  assert.equal(s.current_role, 'deputy_academic');
  s = wf.approve(noteId, deputy, {});
  s = wf.approve(noteId, director, {});
  assert.equal(s.status, 'approved');
  assert.equal(wf.statusText(s), 'ลงนามครบแล้ว');
});

test('ระดับที่ยังไม่มีใครรับผิดชอบ งานรอไว้ ไม่ข้ามไปเอง', () => {
  q.run("DELETE FROM user_roles WHERE role = 'academic_head'");
  const id = work(teacher, 'manual', 'ว30500');
  wf.submit(id, teacher);
  wf.approve(id, head, { scores: fullScores('manual') });
  const s = wf.approve(id, section, {});
  assert.equal(s.status, 'pending');
  assert.equal(s.current_role, 'academic_head');
  assert.equal(wf.progress(s)[2].people.length, 0);
  q.run("INSERT INTO user_roles (user_id, role) VALUES (?, 'academic_head')", academic.id);
  assert.equal(wf.inbox(academic).some((x) => x.id === id), true, 'กำหนดคนแล้ว งานเข้ากล่องทันที');
});

test('ดึงงานกลับได้เฉพาะตอนยังไม่มีใครลงนาม', () => {
  const id = work(teacher, 'plan', 'ว30600');
  wf.submit(id, teacher);
  assert.equal(wf.canWithdraw(teacher, wf.getSub(id)), true);
  let s = wf.withdraw(id, teacher);
  assert.equal(s.status, 'draft');
  wf.submit(id, teacher);
  wf.approve(id, head, { scores: fullScores('plan') });
  s = wf.getSub(id);
  assert.equal(wf.canWithdraw(teacher, s), false);
  assert.throws(() => wf.withdraw(id, teacher), /ลงนามแล้ว/);
});

test('สิทธิ์เปิดดู: ครูต่างกลุ่มสาระและหัวหน้ากลุ่มสาระอื่นดูไม่ได้ ผู้ตรวจระดับโรงเรียนดูได้', () => {
  const id = work(teacher, 'manual', 'ว30700');
  const s = wf.getSub(id);
  assert.equal(wf.canView(teacher, s), true);
  assert.equal(wf.canView(mathTeacher, s), false);
  assert.equal(wf.canView(mathHead, s), false);
  assert.equal(wf.canView(head, s), true);
  assert.equal(wf.canView(director, s), true);
});

test('เกณฑ์ระดับคุณภาพตามแบบประเมินของโรงเรียน', () => {
  assert.equal(wf.scoreLevel(95), 'ดีมาก');
  assert.equal(wf.scoreLevel(90), 'ดีมาก');
  assert.equal(wf.scoreLevel(89), 'ดี');
  assert.equal(wf.scoreLevel(50), 'ปานกลาง');
  assert.equal(wf.scoreLevel(30), 'พอใช้');
  assert.equal(wf.scoreLevel(20), 'ปรับปรุง');
});
