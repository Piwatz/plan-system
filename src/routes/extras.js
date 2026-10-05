// หน้าฟังก์ชันเสริม: บันทึกหลังแผนของฉัน การแจ้งเตือน ผลการสอน แฟ้ม PA สถานะกลุ่มสาระ ลงนามแบบไล่การ์ด
// ทุกหน้าที่เป็นฟังก์ชันเสริม ผู้ดูแลระบบปิดได้ในหน้าฟังก์ชันเสริม
const express = require('express');
const { q, nowStr } = require('../db');
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const { mySubjects, currentTerm, registryScope } = require('./pages');
const { qrSvg } = require('./verify');
const teaching = require('../teaching');

const router = express.Router();
router.use(auth.requireLogin);

function featureOff(res) {
  return res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดฟังก์ชันนี้ไว้' });
}

function needFeature(key) {
  return (req, res, next) => (req.ff[key] ? next() : featureOff(res));
}

function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function str(v, max = 2000) {
  return String(v ?? '').trim().slice(0, max);
}

function respond(req, res, url, type, text) {
  if (text) req.flash(type, text);
  res.redirect(url);
}

// ---------- บันทึกหลังแผนของฉัน ----------

router.get('/notes', async (req, res) => {
  const t = currentTerm(req.settings);
  const withPlan = (await mySubjects(req.me.id, t)).filter((x) => x.plan);
  // บันทึกของทุกแผนในคำสั่งเดียว แล้วแยกตามแผนโดยคงลำดับเดิม
  const byPlan = new Map(withPlan.map((r) => [r.plan.id, []]));
  if (byPlan.size) {
    for (const n of await q.all(
      `SELECT ${wf.subCols()} FROM submissions WHERE parent_id = ANY(?) AND doc_type = 'note' ORDER BY to_int_lenient(plan_no) DESC, id DESC`,
      [...byPlan.keys()]
    )) {
      byPlan.get(n.parent_id).push(n);
    }
  }
  const plans = withPlan.map((r) => ({ ...r, notes: byPlan.get(r.plan.id) }));
  res.render('notes', { title: 'บันทึกหลังแผน', plans, term: t });
});

// ---------- ปุ่มส่งงานตรงกลาง: เลือกว่าจะส่งอะไร ----------

router.get('/send', async (req, res) => {
  const t = currentTerm(req.settings);
  const plans = (await mySubjects(req.me.id, t)).filter((r) => r.plan && r.plan.status !== 'draft');
  const canPlan = !req.ff.onemain || !(await teaching.planBlocked(req.me, t.year, t.semester));
  res.render('send', { title: 'ส่งงาน', plans, canPlan });
});

// ---------- การแจ้งเตือน ----------

router.get('/alerts', async (req, res) => {
  const rows = await q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.me.id);
  // เปิดดูแล้วถือว่าอ่านแล้ว
  await q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowStr(), req.me.id);
  res.locals.badges.alerts = 0;
  res.render('alerts', { title: 'การแจ้งเตือน', rows });
});

// ---------- ผลการสอนของฉัน ----------

router.get('/results', needFeature('results'), async (req, res) => {
  const t = currentTerm(req.settings);
  const notes = await q.all(
    `SELECT ${wf.subCols('n')}, p.id AS plan_id FROM submissions n JOIN submissions p ON p.id = n.parent_id
     WHERE n.teacher_id = ? AND n.doc_type = 'note' AND n.status != 'draft' AND n.academic_year = ? AND n.semester = ?
       AND n.students_total > 0 AND n.students_passed IS NOT NULL
     ORDER BY n.subject_code, to_int_lenient(n.plan_no), n.id`,
    req.me.id,
    t.year,
    t.semester
  );
  const codes = [...new Set(notes.map((n) => n.subject_code))];
  const code = codes.includes(req.query.code) ? req.query.code : codes[0] || '';
  const rows = notes
    .filter((n) => n.subject_code === code)
    .map((n) => ({
      id: n.id,
      no: n.plan_no || '',
      topic: n.topic,
      passed: n.students_passed,
      total: n.students_total,
      pct: Math.round((Math.min(n.students_passed, n.students_total) / n.students_total) * 100),
    }));
  const lows = rows.filter((r) => r.pct < 70);
  const lowest = rows.reduce((m, r, i) => (r.pct < rows[m].pct ? i : m), 0);
  res.render('results', {
    title: 'ผลการสอนของฉัน',
    term: t,
    codes,
    code,
    rows,
    lows,
    start: rows.length ? lowest : 0,
    avg: rows.length ? Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length) : null,
    subjectName: (notes.find((n) => n.subject_code === code) || {}).subject_name || '',
  });
});

// ---------- แฟ้มผลงาน PA ----------

const PA_ITEMS = [
  { key: 'memo', label: 'บันทึกข้อความขออนุญาตใช้แผนและคู่มือ', note: 'ที่ลงนามครบทุกระดับ' },
  { key: 'eval', label: 'แบบประเมินแผนและคู่มือ', note: 'พร้อมคะแนนและระดับคุณภาพ' },
  { key: 'summary', label: 'สรุปผลงานทั้งปี', note: 'ตารางรายวิชา คะแนน และจำนวนบันทึกหลังแผน' },
  { key: 'results', label: 'ผลการสอนรายแผน', note: 'ร้อยละนักเรียนที่ผ่านจุดประสงค์ จากบันทึกหลังแผน' },
  { key: 'notes', label: 'บันทึกหลังแผนทุกฉบับ', note: 'ฉบับที่ลงนามครบแล้ว ฉบับละ 1 หน้า' },
];

// งานที่ผ่านครบของทั้งปี · signatures = เอารูปลายเซ็นครูด้วย (หน้าพิมพ์แฟ้มเท่านั้น หน้ารายการไม่เอา)
async function paData(me, year, { signatures = false } = {}) {
  const cols = `${wf.subCols('s')}${signatures ? ', s.teacher_signature' : ''}, u.full_name AS teacher_name, u.position AS teacher_position, d.name AS dept_name`;
  const works = await q.all(
    `SELECT ${cols}
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.teacher_id = ? AND s.academic_year = ? AND s.status = 'approved' AND s.doc_type IN ('manual', 'plan')
     ORDER BY s.semester, s.subject_code, s.doc_type DESC`,
    me.id,
    year
  );
  const notes = await q.all(
    `SELECT ${cols}
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.teacher_id = ? AND s.academic_year = ? AND s.status = 'approved' AND s.doc_type = 'note'
     ORDER BY s.semester, s.subject_code, to_int_lenient(s.plan_no), s.id`,
    me.id,
    year
  );
  return { works, notes };
}

router.get('/pa', needFeature('pa'), async (req, res) => {
  const years = (await q.all('SELECT DISTINCT academic_year AS y FROM submissions WHERE teacher_id = ? ORDER BY academic_year DESC', req.me.id)).map((r) => r.y);
  const cur = Number(req.settings.academic_year);
  if (!years.includes(cur)) years.unshift(cur);
  const year = years.includes(Number(req.query.year)) ? Number(req.query.year) : cur;
  const { works, notes } = await paData(req.me, year);
  const scored = works.filter((w) => w.score_max);
  const pages = { memo: works.length, eval: scored.length, summary: 1, results: notes.some((n) => n.students_total) ? 1 : 0, notes: notes.length };
  res.render('pa', { title: 'แฟ้มผลงาน PA', years, year, works, notes, items: PA_ITEMS, pages });
});

router.get('/pa/print', needFeature('pa'), async (req, res) => {
  const year = util.intOr(req.query.year, 0) || Number(req.settings.academic_year);
  const inc = new Set(asArray(req.query.inc).filter((k) => PA_ITEMS.some((i) => i.key === k)));
  const { works, notes } = await paData(req.me, year, { signatures: true });
  const { printDataMany } = require('./work');
  // ข้อมูลพิมพ์ของทุกหน้าในคำสั่งชุดเดียว ไม่ถามฐานทีละงาน
  const printed = [...works, ...(inc.has('notes') ? notes : [])];
  const data = await printDataMany(printed);
  const pages = [];
  for (let i = 0; i < printed.length; i++) pages.push({ ...data[i], qr: await qrSvg(req, printed[i]) });
  const workPages = pages.slice(0, works.length);
  const notePages = pages.slice(works.length);
  const resultRows = notes
    .filter((n) => n.students_total > 0 && n.students_passed != null)
    .map((n) => ({ ...n, pct: Math.round((Math.min(n.students_passed, n.students_total) / n.students_total) * 100) }));
  res.render('print_pa', {
    title: `แฟ้มผลงาน PA ปีการศึกษา ${year}`,
    year,
    inc,
    cover: req.query.cover === 'color' ? 'color' : 'formal',
    workPages,
    notePages,
    notes,
    resultRows,
    rubrics: { manual: wf.rubric('manual'), plan: wf.rubric('plan') },
  });
});

// ---------- สถานะกลุ่มสาระและส่งเตือน ----------

function boardScope(me) {
  const scope = registryScope(me);
  if (!scope) return null;
  return scope;
}

// จำนวนที่ต้องส่ง: คู่มือทุกวิชาที่สอน แผนเฉพาะวิชาหลัก (ถ้าเปิดฟังก์ชัน) ไม่มีรายวิชาเลยนับว่าต้องส่งอย่างละ 1
// ครูทั้งกลุ่มสาระใช้ 3 คำสั่งเสมอ: ครูพร้อมจำนวนบันทึกและวันที่ส่งเตือนล่าสุด · งานของทุกคน · รายวิชาที่สอนของทุกคน
async function boardRows(deptId, t, ff = {}) {
  const teachers = await q.all(
    `SELECT u.id, u.full_name, u.position,
       (SELECT COUNT(*) FROM submissions n WHERE n.teacher_id = u.id AND n.doc_type = 'note' AND n.academic_year = ? AND n.semester = ?) AS notes_n,
       (SELECT COUNT(*) FROM submissions n WHERE n.teacher_id = u.id AND n.doc_type = 'note' AND n.academic_year = ? AND n.semester = ? AND n.status IN ('draft', 'returned')) AS notes_todo,
       (SELECT x.created_at FROM notifications x WHERE x.user_id = u.id AND x.link = '/my' ORDER BY x.id DESC LIMIT 1) AS reminded_at
     FROM users u WHERE u.department_id = ? AND u.is_active = 1 AND u.is_teacher = 1 ORDER BY u.full_name`,
    t.year,
    t.semester,
    t.year,
    t.semester,
    deptId
  );
  const ids = teachers.map((u) => u.id);
  const subsOf = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    for (const s of await q.all(
      "SELECT id, teacher_id, doc_type, status, subject_code FROM submissions WHERE teacher_id = ANY(?) AND academic_year = ? AND semester = ? AND doc_type IN ('manual', 'plan') ORDER BY id",
      ids,
      t.year,
      t.semester
    )) {
      subsOf.get(s.teacher_id).push(s);
    }
  }
  const taughtOf = ff.teachlist ? await teaching.listMany(ids, t.year, t.semester) : new Map();
  const out = [];
  for (const { notes_n: notesN, notes_todo: notesTodo, reminded_at: remindedAt, ...u } of teachers) {
    const subs = subsOf.get(u.id);
    const taught = taughtOf.get(u.id) || [];
    const codes = [...new Set([...taught.map((x) => x.subject_code), ...subs.map((s) => s.subject_code)])];
    const planCodes = new Set([...taught.filter((x) => x.is_main).map((x) => x.subject_code), ...subs.filter((s) => s.doc_type === 'plan').map((s) => s.subject_code)]);
    const need = { manual: codes.length || 1, plan: ff.onemain ? planCodes.size || 1 : codes.length || 1 };
    const summary = (type) => {
      const list = subs.filter((s) => s.doc_type === type);
      const sent = list.filter((s) => s.status !== 'draft');
      const ret = list.filter((s) => s.status === 'returned').length;
      const missing = Math.max(0, need[type] - sent.length);
      if (ret) return { text: `รอแก้ไข ${ret}`, cls: 'badge-red', missing: missing + ret };
      if (!sent.length) return { text: 'ยังไม่ส่ง', cls: 'badge-gray', missing };
      if (missing > 0) return { text: `ส่ง ${sent.length} จาก ${need[type]}`, cls: 'badge-amber', missing };
      const done = sent.every((s) => s.status === 'approved');
      return { text: done ? 'ผ่านครบ' : 'ส่งครบ', cls: done ? 'badge-green' : 'badge-blue', missing: 0 };
    };
    const manual = summary('manual');
    const plan = summary('plan');
    const missingText = [];
    if (plan.missing) missingText.push('แผนการจัดการเรียนรู้');
    if (manual.missing) missingText.push('คู่มือรายวิชา');
    out.push({
      ...u,
      subjects: codes.join(' '),
      manual,
      plan,
      notes: notesN || 0,
      notesTodo: notesTodo || 0,
      done: !manual.missing && !plan.missing,
      missingText: missingText.join(' และ '),
      reminded: remindedAt ? util.ago(remindedAt) : '',
    });
  }
  return out;
}

router.get('/dept', needFeature('board'), async (req, res) => {
  const scope = boardScope(req.me);
  if (!scope) return res.status(403).render('error', { title: 'ไม่มีสิทธิ์', message: 'หน้านี้สำหรับหัวหน้ากลุ่มสาระและผู้ตรวจ' });
  const departments = scope.all ? await q.all('SELECT * FROM departments ORDER BY sort, name') : await q.all('SELECT * FROM departments WHERE id = ?', scope.department_id);
  const want = util.idParam(req.query.dept, { optional: true }) || req.me.department_id;
  const dept = departments.find((d) => d.id === want) || departments[0];
  if (!dept) return res.render('error', { title: 'สถานะกลุ่มสาระ', message: 'ยังไม่มีกลุ่มสาระในระบบ' });
  const t = currentTerm(req.settings);
  const rows = await boardRows(dept.id, t, req.ff);
  const filter = ['todo', 'done'].includes(req.query.show) ? req.query.show : 'all';
  res.render('dept', {
    title: 'สถานะกลุ่มสาระ',
    dept,
    departments,
    rows: rows.filter((r) => filter === 'all' || (filter === 'done' ? r.done : !r.done)),
    allCount: rows.length,
    doneCount: rows.filter((r) => r.done).length,
    filter,
    term: t,
    // นับไว้แล้วในตัวเลขบนเมนู (app.js) เงื่อนไขเดียวกับ wf.inbox
    inboxCount: res.locals.badges.inbox,
    daysLeft: util.daysUntil(req.settings.submit_end),
  });
});

router.post('/dept/remind', needFeature('board'), async (req, res) => {
  const scope = boardScope(req.me);
  if (!scope) return res.status(403).render('error', { title: 'ไม่มีสิทธิ์', message: 'หน้านี้สำหรับหัวหน้ากลุ่มสาระและผู้ตรวจ' });
  const b = req.body || {};
  const deptId = util.idParam(b.dept);
  if (!scope.all && deptId !== scope.department_id) return respond(req, res, '/dept', 'error', 'ส่งเตือนได้เฉพาะครูในกลุ่มสาระของคุณ');
  const t = currentTerm(req.settings);
  const ids = new Set(asArray(b.ids).map(Number));
  const targets = (await boardRows(deptId, t, req.ff)).filter((r) => ids.has(r.id) && !r.done);
  if (!targets.length) return respond(req, res, `/dept?dept=${deptId}`, 'error', 'ยังไม่ได้เลือกครูที่ยังส่งไม่ครบ');
  const steps = req.me.roles.map((r) => wf.stepOf(r)).filter(Boolean);
  const fromLabel = steps.length ? steps[0].label + (steps[0].scope === 'department' && req.me.dept_name ? req.me.dept_name : '') : 'ผู้ดูแลระบบ';
  const extra = str(b.message, 300);
  const due = req.settings.submit_end ? `\nกำหนดส่งวันที่ ${util.thaiDate(req.settings.submit_end)}` : '';
  const now = nowStr();
  await q.tx(async () => {
    for (const r of targets) {
      const text = `เรียน คุณครู${r.full_name}\nยังไม่ได้ส่ง ${r.missingText} ของภาคเรียนที่ ${t.semester}/${t.year}${due}${extra ? '\n' + extra : ''}`;
      await q.run(
        'INSERT INTO notifications (user_id, from_user_id, from_name, text, link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        r.id,
        req.me.id,
        `${req.me.full_name} (${fromLabel})`,
        text,
        '/my',
        now
      );
    }
  });
  respond(req, res, `/dept?dept=${deptId}`, 'success', `ส่งเตือนในระบบแล้ว ${targets.length} คน ครูจะเห็นข้อความที่หน้าหลักเมื่อเข้าระบบ`);
});

// ---------- ลงนามบันทึกหลังแผนแบบไล่การ์ด ----------

async function noteQueue(me) {
  return (await wf.inbox(me)).filter((s) => s.doc_type === 'note');
}

router.get('/quicksign', needFeature('quicksign'), async (req, res) => {
  const list = await noteQueue(req.me);
  const signed = Math.max(0, Number(req.query.signed) || 0);
  const back = Math.max(0, Number(req.query.back) || 0);
  const card = list[0] || null;
  let files = [];
  if (card) files = await q.all('SELECT id, original_name, mime FROM files WHERE submission_id = ? AND is_current = 1 ORDER BY id', card.id);
  res.render('quicksign', { title: 'ลงนามบันทึกหลังแผน', card, files, left: list.length, signed, back, total: list.length + signed + back });
});

// บันทึกหลังแผนที่จะลงนามหรือส่งคืน ดึงแค่ id (การลงนามล็อกแถวและตรวจสิทธิ์เองใน workflow)
async function noteOf(id) {
  return q.get("SELECT id FROM submissions WHERE id = ? AND doc_type = 'note'", util.idParam(id));
}

function qsNext(req, signed, back) {
  return `/quicksign?signed=${signed}&back=${back}`;
}

router.post('/quicksign/:id/approve', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  const sub = await noteOf(req.params.id);
  if (!sub) throw new wf.WorkflowError('ไม่พบบันทึกนี้');
  await wf.approve(sub.id, req.me, { comment: str(b.comment) || 'รับทราบ' });
  res.redirect(qsNext(req, (Number(b.signed) || 0) + 1, Number(b.back) || 0));
});

router.post('/quicksign/:id/return', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  const sub = await noteOf(req.params.id);
  if (!sub) throw new wf.WorkflowError('ไม่พบบันทึกนี้');
  await wf.sendBack(sub.id, req.me, { comment: str(b.comment) });
  res.redirect(qsNext(req, Number(b.signed) || 0, (Number(b.back) || 0) + 1));
});

router.post('/quicksign/approve-rest', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  if (!req.me.signature) throw new wf.WorkflowError('กรุณาบันทึกลายเซ็นในหน้าข้อมูลส่วนตัวก่อน');
  // ลงนามทุกฉบับที่เหลือใน transaction เดียว
  const ids = (await noteQueue(req.me)).map((s) => s.id);
  const { done: n } = await wf.approveMany(ids, req.me, { comment: str(b.comment) || 'รับทราบ' });
  res.redirect(qsNext(req, (Number(b.signed) || 0) + n, Number(b.back) || 0));
});

module.exports = router;
