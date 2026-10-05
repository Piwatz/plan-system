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
  const plans = [];
  for (const r of (await mySubjects(req.me.id, t)).filter((x) => x.plan)) {
    plans.push({
      ...r,
      notes: await q.all("SELECT * FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY to_int_lenient(plan_no) DESC, id DESC", r.plan.id),
    });
  }
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
    `SELECT n.*, p.id AS plan_id FROM submissions n JOIN submissions p ON p.id = n.parent_id
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

async function paData(me, year) {
  const works = await q.all(
    `SELECT s.*, u.full_name AS teacher_name, u.position AS teacher_position, d.name AS dept_name
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.teacher_id = ? AND s.academic_year = ? AND s.status = 'approved' AND s.doc_type IN ('manual', 'plan')
     ORDER BY s.semester, s.subject_code, s.doc_type DESC`,
    me.id,
    year
  );
  const notes = await q.all(
    `SELECT s.*, u.full_name AS teacher_name, u.position AS teacher_position, d.name AS dept_name
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
  const { works, notes } = await paData(req.me, year);
  const { printData } = require('./work');
  const pack = async (s) => ({ ...(await printData(s)), qr: await qrSvg(req, s) });
  const workPages = [];
  for (const s of works) workPages.push(await pack(s));
  const notePages = [];
  if (inc.has('notes')) for (const s of notes) notePages.push(await pack(s));
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
async function boardRows(deptId, t, ff = {}) {
  const teachers = await q.all('SELECT id, full_name, position FROM users WHERE department_id = ? AND is_active = 1 AND is_teacher = 1 ORDER BY full_name', deptId);
  const out = [];
  for (const u of teachers) {
    const subs = await q.all(
      "SELECT id, doc_type, status, subject_code FROM submissions WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND doc_type IN ('manual', 'plan')",
      u.id,
      t.year,
      t.semester
    );
    const taught = ff.teachlist ? await teaching.list(u.id, t.year, t.semester) : [];
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
    const notes = await q.get(
      "SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status IN ('draft', 'returned')) AS todo FROM submissions WHERE teacher_id = ? AND doc_type = 'note' AND academic_year = ? AND semester = ?",
      u.id,
      t.year,
      t.semester
    );
    const last = await q.get("SELECT created_at FROM notifications WHERE user_id = ? AND link = '/my' ORDER BY id DESC LIMIT 1", u.id);
    const missingText = [];
    if (plan.missing) missingText.push('แผนการจัดการเรียนรู้');
    if (manual.missing) missingText.push('คู่มือรายวิชา');
    out.push({
      ...u,
      subjects: codes.join(' '),
      manual,
      plan,
      notes: notes.n || 0,
      notesTodo: notes.todo || 0,
      done: !manual.missing && !plan.missing,
      missingText: missingText.join(' และ '),
      reminded: last ? util.ago(last.created_at) : '',
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
    inboxCount: (await wf.inbox(req.me)).length,
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

function qsNext(req, signed, back) {
  return `/quicksign?signed=${signed}&back=${back}`;
}

router.post('/quicksign/:id/approve', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  const sub = await wf.getSub(util.idParam(req.params.id));
  if (!sub || sub.doc_type !== 'note') throw new wf.WorkflowError('ไม่พบบันทึกนี้');
  await wf.approve(sub.id, req.me, { comment: str(b.comment) || 'รับทราบ' });
  res.redirect(qsNext(req, (Number(b.signed) || 0) + 1, Number(b.back) || 0));
});

router.post('/quicksign/:id/return', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  const sub = await wf.getSub(util.idParam(req.params.id));
  if (!sub || sub.doc_type !== 'note') throw new wf.WorkflowError('ไม่พบบันทึกนี้');
  await wf.sendBack(sub.id, req.me, { comment: str(b.comment) });
  res.redirect(qsNext(req, Number(b.signed) || 0, (Number(b.back) || 0) + 1));
});

router.post('/quicksign/approve-rest', needFeature('quicksign'), async (req, res) => {
  const b = req.body || {};
  if (!req.me.signature) throw new wf.WorkflowError('กรุณาบันทึกลายเซ็นในหน้าข้อมูลส่วนตัวก่อน');
  let n = 0;
  for (const s of await noteQueue(req.me)) {
    await wf.approve(s.id, req.me, { comment: str(b.comment) || 'รับทราบ' });
    n += 1;
  }
  res.redirect(qsNext(req, (Number(b.signed) || 0) + n, Number(b.back) || 0));
});

module.exports = router;
