// หน้าแรก งานของฉัน งานรอตรวจ ทะเบียนงาน สถิติ ข้อมูลส่วนตัว
const express = require('express');
const { q } = require('../db');
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const teaching = require('../teaching');
const { submitWindow } = require('./work');
const library = require('../library');

const router = express.Router();
router.use(auth.requireLogin);

function currentTerm(settings) {
  return { year: Number(settings.academic_year), semester: Number(settings.semester) };
}

function term(req) {
  const cur = currentTerm(req.settings);
  return { year: util.intOr(req.query.year, 0) || cur.year, semester: util.intOr(req.query.semester, 0) || cur.semester };
}

function withCurrent(list, settings) {
  const cur = currentTerm(settings);
  if (!list.some((t) => t.year === cur.year && t.semester === cur.semester)) list.unshift(cur);
  return list;
}

async function termOptions() {
  return q.all('SELECT DISTINCT academic_year AS year, semester FROM submissions ORDER BY academic_year DESC, semester DESC');
}

// สิทธิ์ดูทะเบียนงาน: ผู้ดูแล หรือผู้ตรวจ (หัวหน้ากลุ่มสาระเห็นเฉพาะกลุ่มสาระตนเอง)
function registryScope(me) {
  if (me.is_admin) return { all: true };
  const steps = me.roles.map((r) => wf.stepOf(r)).filter(Boolean);
  if (steps.some((s) => s.scope === 'school')) return { all: true };
  if (steps.some((s) => s.scope === 'department')) return { all: false, department_id: me.department_id };
  return null;
}

// ระดับที่ยังไม่มีผู้ตรวจ ถามฐานคำสั่งเดียว: แถว h = ผู้ถือบทบาทที่ยังใช้งาน (บทบาท กลุ่มสาระ) · แถว d = กลุ่มสาระที่มีครู เรียงตาม id
async function setupWarnings() {
  const rows = await q.all(
    `SELECT 'h' AS k, r.role, u.department_id AS dept_id, NULL AS name FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.is_active = 1
     UNION ALL
     SELECT 'd', NULL, d.id, d.name FROM departments d
     WHERE EXISTS (SELECT 1 FROM users t WHERE t.department_id = d.id AND t.is_active = 1 AND t.is_teacher = 1)
     ORDER BY k, dept_id`
  );
  const held = rows.filter((r) => r.k === 'h');
  const depts = rows.filter((r) => r.k === 'd');
  const warn = [];
  for (const st of wf.allSteps()) {
    if (!st.for_plan && !st.for_manual && !st.for_note) continue;
    if (st.scope === 'school') {
      if (!held.some((h) => h.role === st.role)) warn.push(`ยังไม่ได้กำหนดผู้ใดเป็น ${st.label}`);
    } else {
      for (const d of depts) if (!held.some((h) => h.role === st.role && h.dept_id === d.dept_id)) warn.push(`กลุ่มสาระ ${d.name} ยังไม่มี ${st.label}`);
    }
  }
  return warn;
}

// รายวิชาของครูในภาคเรียน แต่ละวิชามีคู่มือ แผน และจำนวนบันทึกหลังแผน
async function mySubjects(userId, t) {
  const works = await q.all(
    `SELECT ${wf.subCols('s')},
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note') AS note_total,
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' AND n.status = 'approved') AS note_done,
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' AND n.status IN ('draft', 'returned')) AS note_todo,
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' AND n.status = 'returned') AS note_back
     FROM submissions s
     WHERE s.teacher_id = ? AND s.doc_type IN ('manual', 'plan') AND s.academic_year = ? AND s.semester = ?
     ORDER BY s.subject_code, s.id`,
    userId,
    t.year,
    t.semester
  );
  const subjects = [];
  const byCode = new Map();
  for (const w of works) {
    const key = w.subject_code || `#${w.id}`;
    if (!byCode.has(key)) {
      const row = { code: w.subject_code, name: w.subject_name, grade: w.grade_level, manual: null, plan: null };
      byCode.set(key, row);
      subjects.push(row);
    }
    byCode.get(key)[w.doc_type] = w;
  }
  return subjects;
}

// ป้ายสถานะสั้น ๆ ในตารางรายวิชา
function cell(s) {
  if (!s) return { text: 'ยังไม่ส่ง', cls: 'badge-gray' };
  if (s.status === 'draft') return { text: 'ฉบับร่าง', cls: 'badge-gray' };
  if (s.status === 'returned') return { text: 'ส่งกลับแก้ไข', cls: 'badge-red' };
  if (s.status === 'approved') return { text: s.score_max ? `ผ่านแล้ว ${s.score_total}` : 'ผ่านแล้ว', cls: 'badge-green' };
  return { text: `รอ ${util.SHORT_ROLE[s.current_role] || (wf.stepOf(s.current_role) || {}).label || 'ตรวจ'}`, cls: 'badge-blue' };
}

// แถวรายวิชาของครู: วิชาที่ส่งงานแล้ว รวมกับรายวิชาที่สอน (ถ้าเปิดฟังก์ชัน)
// needPlan = วิชานี้ต้องส่งแผนไหม (เปิดแผน 1 วิชาหลัก: เฉพาะวิชาหลักหรือวิชาที่มีแผนแล้ว)
async function subjectRows(user, t, ff) {
  const rows = await mySubjects(user.id, t);
  if (ff.teachlist) {
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const x of await teaching.list(user.id, t.year, t.semester)) {
      const r = byCode.get(x.subject_code);
      if (r) r.main = Boolean(x.is_main);
      else rows.push({ code: x.subject_code, name: x.subject_name, grade: x.grade_level, manual: null, plan: null, main: Boolean(x.is_main) });
    }
  }
  for (const r of rows) r.needPlan = !ff.onemain || Boolean(r.plan) || Boolean(ff.teachlist && r.main);
  rows.sort((a, b) => Number(b.needPlan) - Number(a.needPlan) || String(a.code).localeCompare(String(b.code)));
  return rows;
}

// ลิงก์ส่งงานชิ้นใหม่ของรายวิชา เติมรหัสและชื่อวิชาให้
function newHref(type, row) {
  const from = row.plan || row.manual;
  return from ? `/works/new?type=${type}&from=${from.id}` : `/works/new?type=${type}&code=${encodeURIComponent(row.code)}`;
}

// ส่งแผนได้อีกไหม (เปิดแผน 1 วิชาหลัก: ตามจำนวนที่ผู้ดูแลกำหนดให้ครูคนนี้)
async function planLeft(user, t, ff) {
  return !ff.onemain || (await teaching.plansOf(user.id, t.year, t.semester)).length < teaching.planQuota(user);
}

// ปุ่มถัดไปที่ครูควรกดในแต่ละรายวิชา
function nextAction(row) {
  for (const s of [row.plan, row.manual]) {
    if (s && s.status === 'returned') return { label: 'แก้ไข', href: `/s/${s.id}/edit`, primary: true };
  }
  if (row.needPlan && !row.plan) return { label: 'ส่งแผน', href: newHref('plan', row), primary: true };
  if (!row.manual) return { label: 'ส่งคู่มือ', href: newHref('manual', row), primary: true };
  for (const s of [row.plan, row.manual]) {
    if (s && s.status === 'draft') return { label: 'ส่งงาน', href: `/s/${s.id}`, primary: true };
  }
  if (row.plan) return { label: 'เขียนบันทึก', href: `/notes/new?plan=${row.plan.id}`, primary: false };
  return { label: 'ดูคู่มือ', href: `/s/${row.manual.id}`, primary: false };
}

// ช่องสถานะ 3 ช่องของแต่ละวิชา (แผน คู่มือ บันทึกหลังแผน) พร้อมลิงก์
function rowCells(r) {
  const plan = !r.needPlan
    ? { text: 'ไม่ต้องส่ง', cls: 'badge-gray', href: null }
    : { ...cell(r.plan), href: r.plan ? `/s/${r.plan.id}` : newHref('plan', r) };
  const manual = { ...cell(r.manual), href: r.manual ? `/s/${r.manual.id}` : newHref('manual', r) };
  const notes = r.plan
    ? { text: r.plan.note_total ? `${r.plan.note_total} ฉบับ` : 'ยังไม่มี', cls: r.plan.note_todo ? 'badge-amber' : 'badge-gray', href: `/s/${r.plan.id}#notes` }
    : { text: r.needPlan ? 'ยังไม่มี' : 'ไม่ต้องเขียน', cls: 'badge-gray', href: null };
  return [plan, manual, notes];
}

// ช่องแบบปุ่มลงมือ (ฟังก์ชันเสริม homeact): ช่องที่ครูต้องทำเป็นปุ่มเด่นกดได้ในช่องนั้นเลย (ถูกส่งกลับเป็นปุ่มแดง)
// ช่องที่ไม่ต้องส่งเป็นช่องเทาเรียบ (off) สถานะอื่นเป็นป้ายเหมือนเดิม · act = ช่องที่ครูต้องลงมือ ใช้นับ ต้องทำ N อย่าง
function actCells(r, ff) {
  const act = (text, href, red = false) => ({ text, href, act: true, red });
  const work = (s, type) => {
    if (!s) return act(type === 'plan' ? 'กดส่งแผน' : 'กดส่งคู่มือ', newHref(type, r));
    if (s.status === 'returned') return act('กดแก้ไข', `/s/${s.id}/edit`, true);
    if (s.status === 'draft') return act('ร่างไว้ กดส่ง', `/s/${s.id}`);
    return { ...cell(s), href: `/s/${s.id}` };
  };
  const plan = r.needPlan ? work(r.plan, 'plan') : { text: 'ไม่ต้องส่ง', off: true };
  const manual = work(r.manual, 'manual');
  const p = r.plan;
  let notes;
  if (!p || p.status === 'draft') notes = { text: r.needPlan ? 'ส่งแผนก่อน' : 'ไม่ต้องเขียน', off: true };
  else if (Number(p.note_back)) notes = act('กดแก้ไข', `/s/${p.id}#notes`, true);
  else if (Number(p.note_todo)) notes = act(ff.notebook ? 'กดส่งทั้งเล่ม' : 'กดส่ง', `/s/${p.id}#notes`);
  else if (!Number(p.note_total)) notes = act('กดเขียน', `/notes/new?plan=${p.id}`);
  else {
    const all = Number(p.note_done) === Number(p.note_total);
    notes = { text: `${all ? 'ผ่าน' : 'ส่งแล้ว'} ${p.note_total} ฉบับ`, cls: all ? 'badge-green' : 'badge-blue', href: `/s/${p.id}#notes` };
  }
  return [plan, manual, notes];
}

router.get('/', async (req, res) => {
  const me = req.me;
  const t = currentTerm(req.settings);
  const subjects = (await subjectRows(me, t, req.ff)).map((r) => {
    if (!req.ff.homeact) return { ...r, cells: rowCells(r), action: nextAction(r) };
    const cells = actCells(r, req.ff);
    // ปุ่มขวาสุดเหลือเฉพาะเขียนบันทึกฉบับถัดไป เมื่อช่องบันทึกไม่ได้เป็นปุ่มอยู่แล้ว
    const p = r.plan;
    const action = p && p.status !== 'draft' && !cells[2].act ? { label: 'เขียนบันทึก', href: `/notes/new?plan=${p.id}`, primary: false } : null;
    return { ...r, cells, action, todoCount: cells.filter((c) => c.act).length };
  });
  // เปิดแผน 1 วิชาหลักแล้ว แต่ยังไม่มีวิชาไหนต้องส่งแผน แปลว่ายังไม่ได้เลือกวิชาหลัก
  const mainMissing = Boolean(me.is_teacher && req.ff.onemain && !subjects.some((r) => r.needPlan));
  const mainHref = req.ff.teachlist ? '/teaching' : '/works/new?type=plan';
  const works = subjects.flatMap((r) => [r.manual, r.plan]).filter(Boolean);
  const pendingWorks = works.filter((s) => s.status === 'pending');
  const returnedWorks = works.filter((s) => s.status === 'returned');
  // บันทึกหลังแผนของภาคนี้ทั้งหมด (คอลัมน์สั้น ๆ) ใช้ทั้งนับจำนวนและรายการที่ค้าง
  const myNotes = await q.all(
    "SELECT id, parent_id, subject_code, plan_no, status FROM submissions WHERE teacher_id = ? AND doc_type = 'note' AND academic_year = ? AND semester = ? ORDER BY to_int_lenient(plan_no), id",
    me.id,
    t.year,
    t.semester
  );
  const noteTodo = myNotes.filter((x) => x.status === 'draft' || x.status === 'returned');
  const notes = { n: myNotes.length, todo: noteTodo.length };
  // ความเห็นล่าสุดที่ส่งกลับ ของทุกงานที่ถูกส่งกลับ ในคำสั่งเดียว
  const returnedIds = [...returnedWorks, ...noteTodo.filter((x) => x.status === 'returned')].map((s) => s.id);
  const returnComments = new Map();
  if (returnedIds.length) {
    for (const r of await q.all(
      "SELECT DISTINCT ON (submission_id) submission_id, comment FROM reviews WHERE submission_id = ANY(?) AND action = 'return' ORDER BY submission_id, id DESC",
      returnedIds
    )) {
      returnComments.set(r.submission_id, r.comment);
    }
  }
  const lastReturn = (id) => returnComments.get(id) || '';
  const warnings = me.is_admin ? await setupWarnings() : [];
  // สำรองข้อมูลไม่สำเร็จ หรือไม่ได้สำรองเกิน 2 วัน (ฟังก์ชันเสริม backupalert เฉพาะผู้ดูแลระบบ)
  const backupProblem = me.is_admin && req.ff.backupalert ? await require('../jobs').backupStatus() : null;
  // สิ่งที่ยังค้าง: ถูกส่งกลับ ยังเป็นร่าง หรือยังไม่ได้ส่งอีกชิ้น
  const todo = [];
  if (mainMissing) todo.push('แผนวิชาหลัก ยังไม่ได้เลือกวิชาหลัก');
  for (const r of subjects) {
    for (const type of r.needPlan ? ['plan', 'manual'] : ['manual']) {
      const s = r[type];
      const name = `${type === 'manual' ? 'คู่มือ' : 'แผน'} ${r.code}`;
      if (!s) todo.push(`${name} ยังไม่ส่ง`);
      else if (s.status === 'returned') todo.push(`${name} รอแก้ไข`);
      else if (s.status === 'draft') todo.push(`${name} ยังเป็นร่าง`);
    }
  }
  // แถบเตือนหน้าแรก (ฟังก์ชันเสริม duealert): ใกล้กำหนดแต่ยังไม่ส่ง = แดง · แผนหรือคู่มือที่บันทึกร่างไว้แต่ยังไม่กดส่ง = ส้ม
  let dueAlert = null;
  let draftAlert = [];
  if (me.is_teacher && req.ff.duealert) {
    const unsent = [];
    for (const r of subjects) {
      for (const type of r.needPlan ? ['plan', 'manual'] : ['manual']) {
        const s = r[type];
        const name = `${type === 'manual' ? 'คู่มือ' : 'แผน'} ${r.code}`;
        if (!s) unsent.push({ name, href: newHref(type, r) });
        else if (s.status === 'draft') {
          unsent.push({ name: `${name} (ร่าง)`, href: `/s/${s.id}` });
          draftAlert.push({ name, href: `/s/${s.id}` });
        }
      }
    }
    const left = util.daysUntil(req.settings.submit_end);
    if (submitWindow(req.settings).open && req.settings.submit_end && left != null && left >= 0 && left <= 3 && unsent.length) {
      dueAlert = { days: left, list: unsent };
      draftAlert = [];
    }
  }
  const recent = await q.all(
    `SELECT ${wf.reviewCols('r')}, s.doc_type, s.subject_code, s.subject_name, s.plan_no, s.parent_id FROM reviews r
     JOIN submissions s ON s.id = r.submission_id
     WHERE s.teacher_id = ? AND r.action IN ('approve', 'return')
     ORDER BY r.id DESC LIMIT ?`,
    me.id,
    req.ff.notebook ? 60 : 6
  );
  // ส่งทั้งเล่ม: ลงนามหรือส่งกลับทั้งเล่มครั้งเดียว รวมเป็นบรรทัดเดียว (planNos = แผนที่ทุกแผ่น)
  const activity = [];
  for (const r of recent) {
    const last = activity[activity.length - 1];
    const same = req.ff.notebook && last && r.doc_type === 'note' && last.doc_type === 'note' && r.parent_id === last.parent_id && r.action === last.action && r.user_id === last.user_id && r.role === last.role;
    if (same) last.planNos.push(r.plan_no);
    else activity.push({ ...r, planNos: [r.plan_no] });
  }
  activity.splice(6);
  for (const a of activity) a.planNos.sort((x, y) => (parseInt(x, 10) || 0) - (parseInt(y, 10) || 0));
  const inbox = req.ff.notebook ? wf.groupBooks(await wf.inbox(me)) : await wf.inbox(me);
  const alerts = await q.all('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 3', me.id);
  // รายการ "สิ่งที่ต้องทำต่อ" สำหรับหน้าแรกบนมือถือ เรียงจากเรื่องด่วน
  const nextUp = [];
  for (const w of warnings.slice(0, 3)) nextUp.push({ title: w, sub: 'แตะเพื่อตั้งค่าผู้ตรวจในรายชื่อผู้ใช้', href: '/admin/users', tone: 'wait' });
  if (inbox.length) nextUp.push({ title: `มีงานรอคุณลงนาม ${inbox.length} รายการ`, sub: 'แตะเพื่อเปิดงานรอตรวจ', href: '/inbox', tone: 'primary' });
  for (const s of returnedWorks) {
    nextUp.push({ title: `${s.doc_type === 'manual' ? 'คู่มือ' : 'แผน'} ${s.subject_code} ถูกส่งกลับให้แก้ไข`, sub: lastReturn(s.id).slice(0, 90), href: `/s/${s.id}`, tone: 'back' });
  }
  // ส่งกลับทั้งเล่ม: แผ่นที่ผู้ตรวจบอกว่าไม่ต้องแก้ ไม่ต้องขึ้นเป็นงานค้าง (ครูกดส่งทั้งเล่มอีกครั้งในหน้ารายวิชา)
  for (const n of noteTodo.filter((x) => x.status === 'returned' && !lastReturn(x.id).startsWith(wf.BOOK_KEEP))) {
    nextUp.push({ title: `บันทึกหลังแผน ${n.subject_code} แผนที่ ${n.plan_no} ถูกส่งกลับ`, sub: lastReturn(n.id).slice(0, 90), href: `/s/${n.id}/edit`, tone: 'back' });
  }
  if (req.ff.notebook) {
    for (const planId of new Set(noteTodo.filter((x) => x.status === 'returned').map((x) => x.parent_id))) {
      const n = noteTodo.find((x) => x.parent_id === planId);
      nextUp.push({ title: `บันทึกหลังแผน ${n.subject_code} รอส่งทั้งเล่มอีกครั้ง`, sub: 'แก้แผ่นที่ต้องแก้แล้ว กดส่งทั้งเล่มในหน้ารายวิชา', href: `/s/${planId}#notes`, tone: 'back' });
    }
  }
  const drafts = noteTodo.filter((x) => x.status === 'draft');
  if (drafts.length) {
    nextUp.push({
      title: `บันทึกหลังแผน ${drafts.length} ฉบับยังไม่ได้ส่ง`,
      sub: `วิชา ${[...new Set(drafts.map((d) => d.subject_code))].join(' ')} แผนที่ ${drafts.map((d) => d.plan_no).join(' ')} กดเพื่อส่งพร้อมกัน`,
      href: `/s/${drafts[0].parent_id}#notes`,
      tone: 'wait',
    });
  }
  if (mainMissing) nextUp.push({ title: 'ยังไม่ได้เลือกวิชาหลักสำหรับส่งแผน', sub: 'แตะเพื่อเลือกวิชาหลัก แล้วส่งแผนการจัดการเรียนรู้', href: mainHref, tone: 'wait' });
  for (const r of subjects) {
    for (const type of r.needPlan ? ['plan', 'manual'] : ['manual']) {
      const s = r[type];
      const name = `${type === 'manual' ? 'คู่มือรายวิชา' : 'แผนการจัดการเรียนรู้'} ${r.code}`;
      if (!s) nextUp.push({ title: `ยังไม่ได้ส่ง${name}`, sub: 'แตะเพื่อส่งเลย', href: newHref(type, r), tone: 'wait' });
      else if (s.status === 'draft') nextUp.push({ title: `${name} ยังเป็นฉบับร่าง`, sub: 'แตะเพื่อตรวจแล้วกดส่ง', href: `/s/${s.id}`, tone: 'wait' });
    }
  }
  // ลายเซ็นครู (ฟังก์ชันเสริม sigfillauto signag): มีลายเซ็นแล้วเติมงานที่ยังว่างก่อน แล้วนับงานที่ยังไม่มีลายเซ็น
  let sigNag = null;
  if (me.is_teacher && (req.ff.signag || req.ff.sigfillauto)) {
    const sigfill = require('../sigfill');
    await sigfill.autoFill(req);
    const rows = req.ff.signag || req.ff.sigconfirm ? await sigfill.blankWorks(me.id) : [];
    // งานที่ผู้ดูแลระบบส่งแทน (sigconfirm) แสดงเป็นรายการให้เปิดหน้างานแล้วยืนยันเอง ทีละงาน
    const proxy = req.ff.sigconfirm ? rows.filter((w) => w.proxy).map((w) => ({ id: w.id, label: sigfill.workLabel(w) })) : [];
    const blank = rows.length - proxy.length;
    if (req.ff.signag && !me.signature) sigNag = { kind: 'none', blank, proxy };
    else if (req.ff.signag && blank && req.ff.sigfill) sigNag = { kind: 'fill', blank, proxy };
    else if (me.signature && proxy.length) sigNag = { kind: 'confirm', blank: 0, proxy };
  }
  res.render('home', {
    title: 'หน้าหลัก',
    sigNag,
    backupProblem,
    term: t,
    subjects,
    stats: {
      sent: works.filter((s) => s.status !== 'draft').length,
      target: subjects.reduce((a, r) => a + (r.needPlan ? 2 : 1), 0) + (mainMissing ? 1 : 0),
      approved: works.filter((s) => s.status === 'approved').length,
      pending: pendingWorks.length,
      pendingAt: [...new Set(pendingWorks.map((s) => util.SHORT_ROLE[s.current_role] || (wf.stepOf(s.current_role) || {}).label))].join(' และ '),
      returned: returnedWorks.length,
      returnedName: returnedWorks.map((s) => `${s.doc_type === 'manual' ? 'คู่มือ' : 'แผน'} ${s.subject_code}`).join(' '),
      notes: notes.n || 0,
      notesTodo: notes.todo || 0,
    },
    todo,
    dueAlert,
    draftAlert,
    nextUp,
    mainHref,
    canPlan: await planLeft(me, t, req.ff),
    activity,
    alerts,
    inboxPreview: inbox.slice(0, 5),
    inboxCount: inbox.length,
    inboxNotes: inbox.filter((s) => s.doc_type === 'note').length,
    window: submitWindow(req.settings),
    daysLeft: util.daysUntil(req.settings.submit_end),
    warnings,
    // แถบเล่มใหม่ในคลังงาน (ฟังก์ชันเสริม library)
    libRecent: req.ff.library ? library.decorate(await library.recent(6), me, req.ff) : [],
  });
});

// งานของฉัน: จัดกลุ่มตามรายวิชา แต่ละวิชามีคู่มือ แผน และบันทึกหลังแผน
router.get('/my', async (req, res) => {
  const t = term(req);
  const works = await q.all(
    `SELECT ${wf.subCols('s')},
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note') AS note_total,
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' AND n.status = 'approved') AS note_done,
       (SELECT COUNT(*) FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' AND n.status IN ('draft', 'returned')) AS note_todo
     FROM submissions s
     WHERE s.teacher_id = ? AND s.doc_type IN ('manual', 'plan') AND s.academic_year = ? AND s.semester = ?
     ORDER BY s.subject_code, s.id`,
    req.me.id,
    t.year,
    t.semester
  );
  const subjects = [];
  const byCode = new Map();
  for (const w of works) {
    const key = w.subject_code || `#${w.id}`;
    if (!byCode.has(key)) {
      const row = { code: w.subject_code, name: w.subject_name, grade: w.grade_level, manual: null, plan: null };
      byCode.set(key, row);
      subjects.push(row);
    }
    byCode.get(key)[w.doc_type] = w;
  }
  const myTerms = await q.all(
    'SELECT DISTINCT academic_year AS year, semester FROM submissions WHERE teacher_id = ? ORDER BY academic_year DESC, semester DESC',
    req.me.id
  );
  res.render('my', {
    title: 'งานของฉัน',
    subjects,
    term: t,
    isCurrent: t.year === Number(req.settings.academic_year) && t.semester === Number(req.settings.semester),
    canPlan: await planLeft(req.me, t, req.ff),
    terms: withCurrent(myTerms, req.settings),
    window: submitWindow(req.settings),
  });
});

router.get('/inbox', async (req, res) => {
  const type = wf.DOC_TYPES[req.query.type] ? req.query.type : '';
  const list = await wf.inbox(req.me);
  // ส่งบันทึกหลังแผนทั้งเล่ม: ผู้ตรวจเห็นเป็นงานเดียวต่อเล่ม
  const all = (req.ff.notebook ? wf.groupBooks(list) : list).map((s) => ({ ...s, needsScore: wf.needsScore(s) }));
  const rows = type ? all.filter((s) => s.doc_type === type) : all;
  const counts = { all: all.length };
  for (const k of Object.keys(wf.DOC_TYPES)) counts[k] = all.filter((s) => s.doc_type === k).length;
  res.render('inbox', { title: 'งานรอตรวจ', rows, type, counts });
});

async function registryRows(req, scope) {
  const t = term(req);
  const type = wf.DOC_TYPES[req.query.type] ? req.query.type : 'plan';
  const where = ['s.academic_year = ?', 's.semester = ?', "s.status != 'draft'", 's.doc_type = ?'];
  const params = [t.year, t.semester, type];
  if (!scope.all) {
    where.push('s.department_id = ?');
    params.push(scope.department_id);
  } else if (util.idParam(req.query.department, { optional: true })) {
    where.push('s.department_id = ?');
    params.push(util.idParam(req.query.department));
  }
  const status = String(req.query.status || '');
  if (['pending', 'returned', 'approved'].includes(status)) {
    where.push('s.status = ?');
    params.push(status);
  } else if (status.startsWith('step:')) {
    where.push("s.status = 'pending' AND s.current_role = ?");
    params.push(status.slice(5));
  }
  const kw = String(req.query.q || '').trim();
  if (kw) {
    where.push("(u.full_name ILIKE ? ESCAPE '' OR s.subject_code ILIKE ? ESCAPE '' OR s.subject_name ILIKE ? ESCAPE '' OR s.topic ILIKE ? ESCAPE '')");
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  const rows = await q.all(
    `SELECT ${wf.subCols('s')}, u.full_name AS teacher_name, d.name AS dept_name
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
     WHERE ${where.join(' AND ')}
     ORDER BY d.sort NULLS FIRST, u.full_name, s.subject_code, to_int_lenient(s.plan_no)
     LIMIT 3000`,
    ...params
  );
  return { rows, t, type };
}

router.get('/registry', async (req, res) => {
  const scope = registryScope(req.me);
  if (!scope) return res.status(403).render('error', { title: 'ไม่มีสิทธิ์', message: 'หน้านี้สำหรับผู้ตรวจและผู้ดูแลระบบ' });
  const { rows, t, type } = await registryRows(req, scope);
  res.render('registry', {
    title: 'ทะเบียนงาน',
    rows,
    term: t,
    type,
    terms: withCurrent(await termOptions(), req.settings),
    departments: scope.all ? await q.all('SELECT * FROM departments ORDER BY sort, name') : [],
    steps: wf.activeSteps(type),
    query: req.query,
    regScope: scope,
  });
});

router.get('/registry.csv', async (req, res) => {
  const scope = registryScope(req.me);
  if (!scope) return res.status(403).end();
  const { rows, t, type } = await registryRows(req, scope);
  let head;
  let body;
  if (type === 'note') {
    head = ['ลำดับ', 'กลุ่มสาระ', 'ครูผู้สอน', 'รหัสวิชา', 'ชื่อวิชา', 'แผนที่', 'เรื่อง', 'หน่วยที่', 'ชั้น/ห้อง', 'วันที่สอน', 'นักเรียนทั้งหมด', 'ผ่านเกณฑ์', 'สถานะ', 'วันที่ส่ง'];
    body = rows.map((s, i) => [i + 1, s.dept_name, s.teacher_name, s.subject_code, s.subject_name, s.plan_no, s.topic, s.unit_no, s.class_room, util.thaiDate(s.teach_date), s.students_total ?? '', s.students_passed ?? '', wf.statusText(s), util.thaiDate(s.submitted_at)]);
  } else {
    head = ['ลำดับ', 'กลุ่มสาระ', 'ครูผู้สอน', 'รหัสวิชา', 'ชื่อวิชา', 'ระดับชั้น', 'สถานะ', 'คะแนน', 'คะแนนเต็ม', 'ระดับคุณภาพ', 'วันที่ส่ง', 'วันที่อนุมัติ'];
    body = rows.map((s, i) => {
      const pct = s.score_max ? (s.score_total / s.score_max) * 100 : null;
      return [i + 1, s.dept_name, s.teacher_name, s.subject_code, s.subject_name, s.grade_level, wf.statusText(s), s.score_total ?? '', s.score_max ?? '', pct == null ? '' : wf.scoreLevel(pct), util.thaiDate(s.submitted_at), util.thaiDate(s.completed_at)];
    });
  }
  const name = `ทะเบียน${wf.DOC_TYPES[type].label}_${t.semester}-${t.year}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', util.contentDisposition(name));
  res.send(util.toCsv([head, ...body]));
});

router.get('/stats', async (req, res) => {
  const t = term(req);
  const departments = await q.all('SELECT * FROM departments ORDER BY sort, name');
  const teachers = await q.all('SELECT id, full_name, department_id, position FROM users WHERE is_active = 1 AND is_teacher = 1 ORDER BY full_name');
  const subs = await q.all(
    "SELECT id, doc_type, teacher_id, department_id, status, current_role, score_total, score_max, teaching_methods FROM submissions WHERE status != 'draft' AND academic_year = ? AND semester = ?",
    t.year,
    t.semester
  );
  const of = (type) => subs.filter((s) => s.doc_type === type);
  const sentBy = (type) => new Set(of(type).map((s) => s.teacher_id));
  const sentManual = sentBy('manual');
  const sentPlan = sentBy('plan');
  const summary = (list) => ({
    total: list.length,
    pending: list.filter((s) => s.status === 'pending').length,
    returned: list.filter((s) => s.status === 'returned').length,
    approved: list.filter((s) => s.status === 'approved').length,
  });
  const avg = (list) => {
    const scored = list.filter((p) => p.score_max);
    return scored.length ? scored.reduce((a, p) => a + (p.score_total / p.score_max) * 100, 0) / scored.length : null;
  };
  const byDept = departments.map((d) => {
    const ts = teachers.filter((x) => x.department_id === d.id);
    const inDept = (type) => of(type).filter((s) => s.department_id === d.id);
    return {
      name: d.name,
      teachers: ts.length,
      sentManual: ts.filter((x) => sentManual.has(x.id)).length,
      sentPlan: ts.filter((x) => sentPlan.has(x.id)).length,
      manual: summary(inDept('manual')),
      plan: summary(inDept('plan')),
      notes: inDept('note').length,
      avgManual: avg(inDept('manual')),
      avgPlan: avg(inDept('plan')),
    };
  });
  const methods = {};
  for (const p of of('plan')) for (const m of util.parseJson(p.teaching_methods, [])) methods[m] = (methods[m] || 0) + 1;
  const stepLoad = wf.allSteps().map((st) => {
    const row = { label: st.label };
    for (const type of ['manual', 'plan', 'note']) row[type] = of(type).filter((s) => s.status === 'pending' && s.current_role === st.role).length;
    return row;
  });
  const canSeeNames = Boolean(registryScope(req.me));
  const deptName = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const missing = canSeeNames
    ? teachers
        .filter((x) => !sentManual.has(x.id) || !sentPlan.has(x.id))
        .map((x) => ({ ...x, dept_name: deptName[x.department_id] || 'ไม่ระบุกลุ่มสาระ', noManual: !sentManual.has(x.id), noPlan: !sentPlan.has(x.id) }))
    : [];
  res.render('stats', {
    title: 'สถิติ',
    term: t,
    terms: withCurrent(await termOptions(), req.settings),
    totals: {
      teachers: teachers.length,
      sentManual: teachers.filter((x) => sentManual.has(x.id)).length,
      sentPlan: teachers.filter((x) => sentPlan.has(x.id)).length,
      manual: summary(of('manual')),
      plan: summary(of('plan')),
      note: summary(of('note')),
    },
    byDept,
    methods: Object.entries(methods).sort((a, b) => b[1] - a[1]),
    stepLoad,
    missing,
    canSeeNames,
  });
});

// หน้าเกี่ยวกับระบบ (ฟังก์ชันเสริม aboutpage)
router.get('/about', (req, res, next) => {
  if (!req.ff.aboutpage) return next();
  res.render('about', { title: `เกี่ยวกับ ${res.locals.site.app_name}` });
});

router.get('/profile', async (req, res) => {
  // งานที่ยังใช้ลายเซ็นเดิมของฉัน (ฟังก์ชันเสริม resign) มีปุ่มเปลี่ยนทั้งหมดครั้งเดียว
  const stale = req.ff.resign && req.me.signature ? (await require('../resign').staleWorks(req.me.id)).length : 0;
  // งานที่ส่งตอนยังไม่มีลายเซ็น (ฟังก์ชันเสริม sigfill sigfillauto) แบบใส่ให้ทันทีเติมก่อนแสดง
  const sigfill = require('../sigfill');
  if (req.ff.sigfillauto) await sigfill.autoFill(req);
  // proxy = ผู้ดูแลระบบส่งแทน ครูเปิดหน้างานแล้วยืนยันเอง (sigconfirm) ไม่นับรวมในปุ่มใส่ทั้งหมด
  const blank = req.ff.sigfill || req.ff.sigfillauto || req.ff.sigconfirm
    ? (await sigfill.blankWorks(req.me.id)).map((w) => ({ id: w.id, label: sigfill.workLabel(w), proxy: Boolean(w.proxy) && req.ff.sigconfirm }))
    : [];
  res.render('profile', { title: 'ข้อมูลส่วนตัว', stale, blank });
});

// ใส่ลายเซ็นของฉันในทุกงานที่ส่งตอนยังไม่มีลายเซ็น (ฟังก์ชันเสริม sigfill) บันทึก audit_log
router.post('/profile/sigfill', async (req, res) => {
  if (!req.ff.sigfill) {
    req.flash('error', 'ฟังก์ชันใส่ลายเซ็นในงานที่ส่งแล้วปิดอยู่');
    return res.redirect('/profile');
  }
  if (!req.me.signature) {
    req.flash('error', 'กรุณาบันทึกลายเซ็นก่อน');
    return res.redirect('/profile');
  }
  const n = await require('../sigfill').fill(req.me.id, null, { skipProxy: req.ff.sigconfirm });
  if (n) await require('../features').audit(req.me, `ใส่ลายเซ็นของตัวเองในงานที่ส่งตอนยังไม่มีลายเซ็น ${n} งาน`, `user ${req.me.id}`);
  req.flash('success', n ? `ใส่ลายเซ็นของคุณใน ${n} งานเรียบร้อย เอกสารที่พิมพ์จากนี้มีลายเซ็นแล้ว` : 'ทุกงานมีลายเซ็นแล้ว');
  res.redirect(safeBack(req.body && req.body.back, '/profile'));
});

// เซ็นชื่อจากกรอบในแถบเตือนหน้าแรก (ฟังก์ชันเสริม signag) เก็บเป็นลายเซ็นในข้อมูลส่วนตัว
router.post('/profile/sign', async (req, res) => {
  const sig = String((req.body && req.body.signature) || '');
  const back = safeBack(req.body && req.body.back, '/');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 400 * 1024) {
    req.flash('error', 'ยังไม่ได้เซ็นชื่อ หรือรูปลายเซ็นไม่ถูกต้อง');
    return res.redirect(back);
  }
  await q.run('UPDATE users SET signature = ? WHERE id = ?', sig, req.me.id);
  req.me.signature = sig;
  const n = await require('../sigfill').autoFill(req);
  req.flash('success', `บันทึกลายเซ็นเรียบร้อย${n ? ` ใส่ในงานที่ส่งไปแล้ว ${n} งาน` : ''}`);
  res.redirect(back);
});

// ที่อยู่ย้อนกลับภายในเว็บนี้เท่านั้น
function safeBack(v, def) {
  const s = String(v || '');
  return /^\/(?![/\\])/.test(s) ? s : def;
}

// ใช้ลายเซ็นใหม่ในทุกงานที่ลงนามหรือส่งด้วยลายเซ็นเดิม (ฟังก์ชันเสริม resign) บันทึก audit_log
router.post('/profile/resign-all', async (req, res) => {
  if (!req.ff.resign) {
    req.flash('error', 'ฟังก์ชันใช้ลายเซ็นใหม่ปิดอยู่');
    return res.redirect('/profile');
  }
  if (!req.me.signature) {
    req.flash('error', 'กรุณาบันทึกลายเซ็นก่อน');
    return res.redirect('/profile');
  }
  const n = await require('../resign').apply(req.me.id);
  if (n) await require('../features').audit(req.me, `ใช้ลายเซ็นใหม่ในงานที่ลงนามแล้วทั้งหมด ${n} งาน`, `user ${req.me.id}`);
  req.flash('success', n ? `เปลี่ยนเป็นลายเซ็นใหม่ใน ${n} งานเรียบร้อย เอกสารที่พิมพ์จากนี้ใช้ลายเซ็นใหม่` : 'ทุกงานใช้ลายเซ็นปัจจุบันอยู่แล้ว');
  res.redirect('/profile');
});

router.post('/profile', async (req, res) => {
  const b = req.body || {};
  const position = String(b.position || '').trim().slice(0, 150);
  await q.run('UPDATE users SET position = ? WHERE id = ?', position, req.me.id);
  if (b.remove_signature === '1') await q.run('UPDATE users SET signature = NULL WHERE id = ?', req.me.id);
  else if (b.signature) {
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.signature) || b.signature.length > 400 * 1024) {
      req.flash('error', 'ไฟล์ลายเซ็นไม่ถูกต้อง หรือใหญ่เกินไป');
      return res.redirect('/profile');
    }
    await q.run('UPDATE users SET signature = ? WHERE id = ?', b.signature, req.me.id);
    req.me.signature = b.signature;
  }
  // บันทึกลายเซ็นแล้ว ใส่ในงานที่ส่งตอนยังไม่มีลายเซ็นให้ทันที (ฟังก์ชันเสริม sigfillauto)
  const filled = b.remove_signature === '1' ? 0 : await require('../sigfill').autoFill(req);
  req.flash('success', `บันทึกข้อมูลส่วนตัวเรียบร้อย${filled ? ` ใส่ลายเซ็นในงานที่ส่งไปแล้ว ${filled} งาน` : ''}`);
  res.redirect('/profile');
});

module.exports = router;
module.exports.setupWarnings = setupWarnings;
module.exports.mySubjects = mySubjects;
module.exports.subjectRows = subjectRows;
module.exports.cell = cell;
module.exports.registryScope = registryScope;
module.exports.currentTerm = currentTerm;
