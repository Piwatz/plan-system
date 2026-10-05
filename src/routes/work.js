// ส่งแผนการจัดการเรียนรู้และคู่มือรายวิชา เขียนบันทึกหลังแผน เปิดไฟล์ พิมพ์ และการลงนามของผู้ตรวจ
const { pipeline } = require('stream/promises');
const express = require('express');
const { q, nowStr } = require('../db');
const { todayStr } = require('../time');
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const up = require('../upload');
const storage = require('../storage');
const drivepath = require('../drivepath');
const features = require('../features');
const teaching = require('../teaching');
const { qrSvg } = require('./verify');

const router = express.Router();
router.use(auth.requireLogin);

const WORK_TYPES = ['manual', 'plan'];
const SIGNATURE_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_SIGNATURE = 400 * 1024;

function validSignature(s) {
  return typeof s === 'string' && s.length < MAX_SIGNATURE && SIGNATURE_RE.test(s);
}

function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function str(v, max = 5000) {
  return String(v ?? '').trim().slice(0, max);
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

class UserError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

// ตอบกลับหลังบันทึก: ฟอร์มที่ส่งด้วย JavaScript (มีแถบความคืบหน้า) รับเป็น JSON แล้วเปลี่ยนหน้าเอง
function respond(req, res, url, type, text) {
  if (text) req.flash(type, text);
  if (req.xhr) return res.json({ ok: true, redirect: url });
  res.redirect(url);
}

// ไฟล์ที่ส่งมาแต่บันทึกงานไม่สำเร็จ ย้ายไปถังขยะ (เรียกหลัง transaction เท่านั้น)
function dropFiles(req, list) {
  return up.discard(req.me.id, list.map((f) => f.token));
}

// ฟังก์ชันตรวจไฟล์ก่อนส่ง: ไม่รับไฟล์เสียหรือนามสกุลไม่ตรงกับไฟล์จริง (อ่าน 8 ไบต์แรกจากที่เก็บไฟล์)
async function rejectBadFiles(req, list) {
  if (!req.ff.filecheck || !list.length) return;
  const bad = await up.badFiles(list);
  if (!bad.length) return;
  throw new UserError(`ไฟล์ ${bad.join(' ')} เปิดไม่ได้ หรือนามสกุลไม่ตรงกับไฟล์จริง กรุณาบันทึกไฟล์ใหม่แล้วแนบอีกครั้ง`);
}

// แผนและคู่มือรับเฉพาะ PDF ไฟล์เดียว (เปิดปิดได้) ถ้าครูเลือกหลายไฟล์ เบราว์เซอร์รวมเป็นไฟล์เดียวตามลำดับที่เรียงไว้ก่อนส่ง
// (public/js/pdfmerge.js) แล้วบอกจำนวนไฟล์และหน้าที่รวมมาในช่อง upload_merged upload_pages
function checkPdf(req, docType, list) {
  if (!req.ff.pdfonly || !list.length) return '';
  const label = wf.DOC_TYPES[docType].label;
  const notPdf = list.filter((x) => x.ext !== '.pdf');
  if (notPdf.length) {
    throw new UserError(`${label}รับเฉพาะไฟล์ PDF (${notPdf.map((x) => x.name).join(' ')} ไม่ใช่ PDF) ถ้าเป็นไฟล์ Word ให้บันทึกเป็น PDF ก่อน แล้วแนบใหม่`);
  }
  if (list.length > 1) throw new UserError(`${label}แนบได้ PDF ไฟล์เดียว ให้รวมปกและเนื้อหาเป็นไฟล์เดียวก่อน แล้วแนบใหม่`);
  const b = req.body || {};
  const merged = intOrNull(b.upload_merged);
  const pages = intOrNull(b.upload_pages);
  return req.ff.pdfmerge && merged > 1 && merged <= up.MAX_FILES && pages > 0 ? ` รวม ${merged} ไฟล์เป็นไฟล์เดียวแล้ว ${pages} หน้า` : '';
}

function currentFiles(subId) {
  return q.all('SELECT * FROM files WHERE submission_id = ? AND is_current = 1 ORDER BY id', subId);
}

// งานพร้อมชื่อครูและกลุ่มสาระ · signature = เอารูปลายเซ็นครูด้วย (เฉพาะหน้าพิมพ์)
function subSelect(signature) {
  return `SELECT ${wf.subCols('s')}${signature ? ', s.teacher_signature' : ''}, u.full_name AS teacher_name, u.position AS teacher_position,
       d.name AS dept_name, p.status AS parent_status
     FROM submissions s
     JOIN users u ON u.id = s.teacher_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN submissions p ON p.id = s.parent_id`;
}

// id ใช้ไม่ได้ (ไม่ใช่เลข หรือเกินช่วง) ถือว่าไม่พบ แต่ละหน้าตอบ "ไม่พบ" ด้วยข้อความของตัวเองเหมือนเดิม
async function loadSub(id, { signature = false } = {}) {
  const n = util.idOrNull(id);
  if (n === null) return undefined;
  return q.get(`${subSelect(signature)} WHERE s.id = ?`, n);
}

async function viewable(req, id, opts) {
  const sub = await loadSub(id, opts);
  if (!sub || !(await wf.canView(req.me, sub))) return null;
  return sub;
}

async function loadFile(id) {
  const n = util.idOrNull(id);
  if (n === null) return undefined;
  return q.get('SELECT * FROM files WHERE id = ?', n);
}

// แก้ไขได้: เจ้าของงาน หรือผู้ดูแลระบบ (แก้แทนครู) เมื่อเป็นฉบับร่างหรือถูกส่งกลับ
function editable(req, sub) {
  return Boolean(sub && (wf.isOwner(req.me, sub) || req.me.is_admin) && (sub.status === 'draft' || sub.status === 'returned'));
}

function submitWindow(settings) {
  if (settings.submit_open !== '1') return { open: false, reason: 'ขณะนี้ปิดรับการส่งแผนและคู่มือ' };
  const today = todayStr();
  if (settings.submit_start && today < settings.submit_start) return { open: false, reason: `เปิดรับส่งวันที่ ${util.thaiDate(settings.submit_start)}` };
  if (settings.submit_end && today > settings.submit_end) return { open: false, reason: `ปิดรับส่งแล้วตั้งแต่ ${util.thaiDate(settings.submit_end)}` };
  return { open: true, reason: '' };
}

function workFields(b, docType) {
  return {
    subject_code: str(b.subject_code, 30),
    subject_name: str(b.subject_name, 200),
    grade_level: str(b.grade_level, 30),
    teaching_methods:
      docType === 'plan' ? JSON.stringify(asArray(b.teaching_methods).map((x) => str(x, 100)).filter(Boolean)) : '[]',
    link_url: util.safeUrl(b.link_url).slice(0, 500),
    doc_no: str(b.doc_no, 50),
  };
}

const NOTE_COLS = [
  'plan_no',
  'topic',
  'unit_no',
  'unit_name',
  'hours',
  'class_room',
  'teach_date',
  'result_k',
  'result_p',
  'result_a',
  'problems',
  'suggestions',
  'students_total',
  'students_passed',
  'note_mode',
];

function noteFields(b, ff) {
  return {
    note_mode: ff.notefile && b.note_mode === 'file' ? 'file' : 'type',
    plan_no: str(b.plan_no, 20),
    topic: str(b.topic, 300),
    unit_no: str(b.unit_no, 20),
    unit_name: str(b.unit_name, 300),
    hours: str(b.hours, 20),
    class_room: str(b.class_room, 60),
    teach_date: /^\d{4}-\d{2}-\d{2}$/.test(b.teach_date || '') ? b.teach_date : '',
    result_k: str(b.result_k),
    result_p: str(b.result_p),
    result_a: str(b.result_a),
    problems: str(b.problems),
    suggestions: str(b.suggestions),
    students_total: intOrNull(b.students_total),
    students_passed: intOrNull(b.students_passed),
  };
}

// ตรวจความครบถ้วนก่อนส่งให้ผู้ตรวจ (ตอนบันทึกร่างไม่ต้องครบ)
async function missingForSubmit(sub, ff) {
  const miss = [];
  if (sub.doc_type === 'note') {
    if (!sub.plan_no && !sub.topic) miss.push('แผนที่ หรือ เรื่อง');
    if (sub.note_mode === 'file') {
      if ((await currentFiles(sub.id)).length === 0) miss.push('ไฟล์บันทึกหลังแผนของคุณ');
    } else if (!sub.result_k && !sub.result_p && !sub.result_a) miss.push('ผลการจัดการเรียนรู้อย่างน้อย 1 ด้าน');
    if (ff.counts && (sub.students_total == null || sub.students_passed == null)) miss.push('จำนวนนักเรียนทั้งหมดและจำนวนที่ผ่านจุดประสงค์');
    if (sub.students_total != null && sub.students_passed != null && sub.students_passed > sub.students_total) {
      miss.push('จำนวนนักเรียนที่ผ่านเกณฑ์ต้องไม่มากกว่าจำนวนทั้งหมด');
    }
  } else {
    if (!sub.subject_code) miss.push('รหัสวิชา');
    if (!sub.subject_name) miss.push('ชื่อวิชา');
    if (!sub.grade_level) miss.push('ระดับชั้น');
    const cur = await currentFiles(sub.id);
    if (ff.pdfonly) {
      if (!cur.length) miss.push('ไฟล์ PDF');
      else if (cur.some((x) => x.mime !== 'application/pdf')) miss.push('ไฟล์ PDF แทนไฟล์ Word หรือไฟล์ชนิดอื่นที่แนบไว้');
      else if (cur.length > 1) miss.push(`ไฟล์ PDF ไฟล์เดียว (ตอนนี้มี ${cur.length} ไฟล์ ให้แนบไฟล์ที่รวมแล้วแทน)`);
    } else if (cur.length === 0 && !sub.link_url) miss.push('ไฟล์หรือลิงก์อย่างน้อย 1 อย่าง');
  }
  return miss;
}

async function trySubmit(req, subId) {
  const sub = await wf.getSub(subId);
  const miss = await missingForSubmit(sub, req.ff);
  if (miss.length) throw new UserError(`บันทึกร่างไว้แล้ว แต่ยังส่งไม่ได้ ต้องกรอก ${miss.join(' และ ')}`);
  // ผู้ดูแลระบบส่งแทนครูได้แม้ปิดรับแล้ว
  if (req.me.is_admin && req.me.id !== sub.teacher_id) return wf.submitAs(subId, req.me);
  if (sub.doc_type !== 'note' && sub.status === 'draft') {
    const w = submitWindow(req.settings);
    if (!w.open) throw new UserError(`บันทึกร่างไว้แล้ว แต่ยังส่งไม่ได้ เพราะ${w.reason}`);
  }
  return wf.submit(subId, req.me);
}

function submittedMessage(sub) {
  if (sub.status === 'approved') return 'ส่งเรียบร้อย และผ่านครบทุกระดับแล้ว';
  return `ส่งเรียบร้อย ขณะนี้${wf.statusText(sub)}`;
}

// บันทึกแล้ว ถ้าครูกดส่งด้วยให้ส่งต่อ ส่งไม่ผ่านก็ยังเก็บร่างไว้ แล้วพากลับไปหน้าแก้ไข
// รายวิชาที่ใช้ในช่องรหัสวิชา: วิชาที่ครูสอนขึ้นก่อน ตามด้วยรายวิชาของโรงเรียน
async function subjectChoices(req) {
  const mine = req.ff.teachlist ? await teaching.list(req.me.id, Number(req.settings.academic_year), Number(req.settings.semester)) : [];
  const out = mine.map((x) => ({ code: x.subject_code, name: x.subject_name, grade: x.grade_level }));
  const seen = new Set(out.map((x) => x.code));
  for (const x of await q.all('SELECT * FROM subjects ORDER BY code')) if (!seen.has(x.code)) out.push(x);
  return out;
}

// จำวิชาที่ส่งงานไว้ในรายการรายวิชาที่สอน (ส่งแผน = วิชาหลัก)
async function rememberSubject(req, sub, f) {
  if (!req.ff.teachlist || !f.subject_code || teaching.skipActivity(f.subject_code)) return;
  const owner = sub.teacher_id === req.me.id ? req.me : await q.get('SELECT id, plan_quota FROM users WHERE id = ?', sub.teacher_id);
  await teaching.ensure(owner, sub.academic_year, sub.semester, { code: f.subject_code, name: f.subject_name, grade: f.grade_level }, sub.doc_type === 'plan');
}

async function finishSave(req, res, id, wantSubmit, savedMsg) {
  if (!wantSubmit) return respond(req, res, `/s/${id}`, 'success', savedMsg);
  try {
    const sub = await trySubmit(req, id);
    return respond(req, res, `/s/${id}`, 'success', submittedMessage(sub));
  } catch (e) {
    if (e instanceof UserError || e instanceof wf.WorkflowError) return respond(req, res, `/s/${id}/edit`, 'error', e.message);
    throw e;
  }
}

function findDuplicate(teacherId, year, sem, docType, code, exceptId = 0) {
  if (!code) return Promise.resolve(null);
  return q.get(
    'SELECT id FROM submissions WHERE doc_type = ? AND teacher_id = ? AND academic_year = ? AND semester = ? AND subject_code = ? AND id != ?',
    docType,
    teacherId,
    year,
    sem,
    code,
    exceptId
  );
}

// กันกดส่งสองครั้งเร็ว ๆ: งานของครูคนเดียวกันต่อคิวทีละคำขอจนจบ transaction ต้องเป็นคำสั่งแรกใน transaction
function lockTeacher(teacherId) {
  return q.get('SELECT pg_advisory_xact_lock(?) AS x', teacherId);
}

// ---------- คู่มือรายวิชา และ แผนการจัดการเรียนรู้ ----------

router.get('/works/new', async (req, res) => {
  const type = WORK_TYPES.includes(req.query.type) ? req.query.type : 'manual';
  if (!req.me.department_id) throw new UserError('บัญชีของคุณยังไม่ได้กำหนดกลุ่มสาระ กรุณาแจ้งผู้ดูแลระบบ');
  const year = Number(req.settings.academic_year);
  const sem = Number(req.settings.semester);
  if (type === 'plan' && req.ff.onemain) {
    const why = await teaching.planBlocked(req.me, year, sem);
    if (why) throw new UserError(why);
  }
  const sub = { doc_type: type, academic_year: year, semester: sem, teaching_methods: '[]' };
  // กดมาจากรายวิชาที่มีอยู่แล้ว ให้กรอกรหัสและชื่อวิชาให้เลย
  const fromId = util.idOrNull(req.query.from);
  const from = fromId ? await q.get(`SELECT ${wf.subCols()} FROM submissions WHERE id = ? AND teacher_id = ?`, fromId, req.me.id) : null;
  const subjects = await subjectChoices(req);
  if (from) Object.assign(sub, { subject_code: from.subject_code, subject_name: from.subject_name, grade_level: from.grade_level });
  else if (req.query.code) {
    const code = str(req.query.code, 30);
    const x = subjects.find((c) => c.code === code);
    Object.assign(sub, { subject_code: code, subject_name: x ? x.name : '', grade_level: x ? x.grade : '' });
  }
  res.render('work_form', {
    title: `ส่ง${wf.DOC_TYPES[type].label}`,
    sub,
    files: [],
    subjects,
    window: submitWindow(req.settings),
    isNew: true,
  });
});

router.post('/works', async (req, res) => {
  const b = req.body || {};
  const type = WORK_TYPES.includes(b.doc_type) ? b.doc_type : null;
  const year = Number(req.settings.academic_year);
  const sem = Number(req.settings.semester);
  const f = type ? workFields(b, type) : null;
  const files = await up.take(req, 'main_files');
  let id;
  let mergedMsg;
  try {
    let problem = null;
    if (!type) problem = 'ไม่รู้จักชนิดงาน';
    else if (!req.me.department_id) problem = 'บัญชีของคุณยังไม่ได้กำหนดกลุ่มสาระ กรุณาแจ้งผู้ดูแลระบบ';
    else if (teaching.skipActivity(f.subject_code)) problem = 'วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ';
    if (problem) throw new UserError(problem);
    await rejectBadFiles(req, files);
    mergedMsg = checkPdf(req, type, files);
    const now = nowStr();
    id = await q.tx(async () => {
      // ตรวจงานซ้ำและโควตาแผนหลังล็อกครู กดส่งสองครั้งพร้อมกัน คำขอที่สองต้องรอแล้วเห็นงานแรก
      await lockTeacher(req.me.id);
      if (await findDuplicate(req.me.id, year, sem, type, f.subject_code)) {
        throw new UserError(`${wf.DOC_TYPES[type].label}วิชา ${f.subject_code} ส่งไว้แล้วในภาคเรียนนี้ ให้เปิดงานเดิมแล้วกดแก้ไขแทน`);
      }
      if (type === 'plan' && req.ff.onemain) {
        const why = await teaching.planBlocked(req.me, year, sem);
        if (why) throw new UserError(why);
      }
      const r = await q.get(
        `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name,
           grade_level, teaching_methods, link_url, doc_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        type,
        req.me.id,
        req.me.department_id,
        year,
        sem,
        f.subject_code,
        f.subject_name,
        f.grade_level,
        f.teaching_methods,
        f.link_url,
        f.doc_no,
        now,
        now
      );
      await up.attach(r.id, files, 'main');
      await rememberSubject(req, { teacher_id: req.me.id, doc_type: type, academic_year: year, semester: sem }, f);
      return r.id;
    });
  } catch (e) {
    await dropFiles(req, files);
    throw e;
  }
  await finishSave(req, res, id, b.action === 'submit', `บันทึกร่างเรียบร้อย${mergedMsg} ยังไม่ได้ส่งให้ผู้ตรวจ`);
});

// ---------- บันทึกหลังแผน ----------

async function parentPlanFor(req, planId) {
  const id = util.idOrNull(planId);
  const plan = id === null ? undefined : await q.get(`SELECT ${wf.subCols()} FROM submissions WHERE id = ? AND doc_type = 'plan'`, id);
  if (!plan || plan.teacher_id !== req.me.id) throw new UserError('ไม่พบแผนการจัดการเรียนรู้ของคุณ');
  if (plan.status === 'draft') throw new UserError('ต้องส่งแผนการจัดการเรียนรู้รายวิชานี้ก่อน จึงจะเขียนบันทึกหลังแผนได้');
  return plan;
}

router.get('/notes/new', async (req, res) => {
  const plan = await parentPlanFor(req, req.query.plan);
  // ใช้หน่วยและห้องเดียวกับบันทึกฉบับล่าสุด ครูไม่ต้องพิมพ์ซ้ำ
  const last = await q.get(`SELECT ${wf.subCols()} FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY id DESC LIMIT 1`, plan.id);
  const maxNo = (await q.get("SELECT MAX(to_int_lenient(plan_no)) AS n FROM submissions WHERE parent_id = ? AND doc_type = 'note'", plan.id)).n;
  const sub = { plan_no: String((maxNo || 0) + 1), note_mode: last && req.ff.notefile ? last.note_mode : 'type' };
  if (last) Object.assign(sub, { unit_no: last.unit_no, unit_name: last.unit_name, class_room: last.class_room, hours: last.hours, students_total: last.students_total });
  res.render('note_form', { title: 'เขียนบันทึกหลังแผน', plan, sub, files: [], isNew: true, ...(await noteHelpers(req, plan.id, 0)) });
});

// ประโยคสำเร็จรูป และข้อความจากบันทึกฉบับก่อนหน้าให้คัดลอกมาแก้
async function noteHelpers(req, planId, exceptId) {
  const prev = req.ff.chips
    ? await q.get(
        "SELECT plan_no, result_k, result_p, result_a, problems, suggestions FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND id != ? AND note_mode = 'type' AND (result_k != '' OR result_p != '' OR result_a != '') ORDER BY id DESC LIMIT 1",
        planId,
        exceptId
      )
    : null;
  return { phrases: req.ff.chips ? features.phrases(req.settings) : null, prev: prev || null };
}

router.post('/notes', async (req, res) => {
  const b = req.body || {};
  const files = await up.take(req, 'attach_files');
  const f = noteFields(b, req.ff);
  let plan;
  let id;
  try {
    plan = await parentPlanFor(req, b.plan_id);
    await rejectBadFiles(req, files);
    const now = nowStr();
    id = await q.tx(async () => {
      const r = await q.get(
        `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name,
           grade_level, ${NOTE_COLS.join(', ')}, created_at, updated_at)
         VALUES ('note', ?, ?, ?, ?, ?, ?, ?, ?, ${NOTE_COLS.map(() => '?').join(', ')}, ?, ?) RETURNING id`,
        plan.id,
        req.me.id,
        plan.department_id,
        plan.academic_year,
        plan.semester,
        plan.subject_code,
        plan.subject_name,
        plan.grade_level,
        ...NOTE_COLS.map((c) => f[c]),
        now,
        now
      );
      await up.attach(r.id, files, 'attach');
      return r.id;
    });
  } catch (e) {
    await dropFiles(req, files);
    throw e;
  }
  if (b.action === 'new') {
    req.flash('success', `บันทึกร่างแผนที่ ${f.plan_no || ''} แล้ว เขียนฉบับต่อไปได้เลย`);
    return respond(req, res, `/notes/new?plan=${plan.id}`, null, null);
  }
  await finishSave(req, res, id, b.action === 'submit', 'บันทึกร่างเรียบร้อย ยังไม่ได้ส่งให้ผู้ตรวจ');
});

// ส่งบันทึกหลังแผนหลายฉบับพร้อมกัน
router.post('/notes/submit-many', async (req, res) => {
  const b = req.body || {};
  const ids = asArray(b.ids).map(util.idOrNull).filter(Boolean);
  if (!ids.length) throw new UserError('ยังไม่ได้เลือกบันทึกที่จะส่ง');
  let ok = 0;
  const problems = [];
  for (const id of ids) {
    const sub = await loadSub(id);
    if (!editable(req, sub) || sub.doc_type !== 'note') continue;
    try {
      await trySubmit(req, id);
      ok += 1;
    } catch (e) {
      if (!(e instanceof UserError || e instanceof wf.WorkflowError)) throw e;
      problems.push(`แผนที่ ${sub.plan_no || sub.topic}`);
    }
  }
  const extra = problems.length ? ` ยังส่งไม่ได้ ${problems.length} ฉบับ เพราะกรอกไม่ครบ (${problems.join(' ')})` : '';
  respond(req, res, b.back && String(b.back).startsWith('/s/') ? b.back : '/my', problems.length ? 'error' : 'success', `ส่งบันทึกหลังแผนเรียบร้อย ${ok} ฉบับ${extra}`);
});

// ---------- ดู แก้ไข ส่ง ดึงกลับ ลบ ----------

function approveLabel(sub) {
  if (sub.doc_type === 'note') return 'ลงนามรับทราบ';
  const steps = wf.activeSteps(sub.doc_type);
  const last = steps[steps.length - 1];
  return last && last.role === sub.current_role ? 'ลงนามอนุญาต' : 'ลงนามเห็นชอบ';
}

router.get('/s/:id', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const files = await q.all('SELECT * FROM files WHERE submission_id = ? ORDER BY is_current DESC, id', sub.id);
  const notes =
    sub.doc_type === 'plan'
      ? await q.all(`SELECT ${wf.subCols()} FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY to_int_lenient(plan_no), id`, sub.id)
      : [];
  const reviews = await wf.reviewsOf(sub.id, { signatures: false });
  const lastReturn = [...reviews].reverse().find((r) => r.action === 'return');
  const sibling =
    sub.doc_type === 'note'
      ? null
      : await q.get(
          'SELECT id, doc_type, status, current_role FROM submissions WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND subject_code = ? AND doc_type = ?',
          sub.teacher_id,
          sub.academic_year,
          sub.semester,
          sub.subject_code,
          sub.doc_type === 'plan' ? 'manual' : 'plan'
        );
  const parent = sub.parent_id ? await q.get('SELECT id, subject_code, subject_name, status FROM submissions WHERE id = ?', sub.parent_id) : null;
  res.render('detail', {
    title: `${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code}`,
    sub,
    files,
    notes,
    reviews,
    lastReturn,
    sibling,
    parent,
    steps: await wf.progress(sub, { reviews }),
    canReview: wf.canReview(req.me, sub),
    needsScore: wf.needsScore(sub),
    rubric: wf.rubric(sub.doc_type),
    canEdit: editable(req, sub),
    canWithdraw: await wf.canWithdraw(req.me, sub, reviews),
    canDelete: (wf.isOwner(req.me, sub) && sub.status === 'draft' && !sub.submitted_at) || req.me.is_admin,
    isOwner: wf.isOwner(req.me, sub),
    canPlan: !req.ff.onemain || !(await teaching.planBlocked(req.me, Number(req.settings.academic_year), Number(req.settings.semester))),
    approveLabel: approveLabel(sub),
  });
});

router.get('/s/:id/edit', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!editable(req, sub)) throw new UserError('แก้ไขได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
  const files = await currentFiles(sub.id);
  const lastReturn = [...(await wf.reviewsOf(sub.id, { signatures: false }))].reverse().find((r) => r.action === 'return');
  if (sub.doc_type !== 'note') {
    return res.render('work_form', {
      lastReturn,
      title: `แก้ไข${wf.DOC_TYPES[sub.doc_type].label}`,
      sub,
      files,
      subjects: await subjectChoices(req),
      window: submitWindow(req.settings),
      isNew: false,
    });
  }
  const plan = await q.get(`SELECT ${wf.subCols()} FROM submissions WHERE id = ?`, sub.parent_id);
  res.render('note_form', { title: 'แก้ไขบันทึกหลังแผน', plan, sub, files, lastReturn, isNew: false, ...(await noteHelpers(req, plan.id, sub.id)) });
});

// บันทึกการแก้ไขลงฐาน (ทั้งหมดใน transaction เดียว)
async function saveEdit(req, sub, b, now, files) {
  await q.tx(async () => {
    if (sub.doc_type === 'note') {
      const f = noteFields(b, req.ff);
      await q.run(
        `UPDATE submissions SET ${NOTE_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...NOTE_COLS.map((c) => f[c]),
        now,
        sub.id
      );
    } else {
      const f = workFields(b, sub.doc_type);
      if (teaching.skipActivity(f.subject_code) && f.subject_code !== sub.subject_code) throw new UserError('วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ');
      // ล็อกครูก่อนตรวจซ้ำ เหมือนตอนส่งงานใหม่
      await lockTeacher(sub.teacher_id);
      if (await findDuplicate(sub.teacher_id, sub.academic_year, sub.semester, sub.doc_type, f.subject_code, sub.id)) {
        throw new UserError(`${wf.DOC_TYPES[sub.doc_type].label}วิชา ${f.subject_code} มีอยู่แล้วในภาคเรียนนี้`);
      }
      await q.run(
        'UPDATE submissions SET subject_code = ?, subject_name = ?, grade_level = ?, teaching_methods = ?, link_url = ?, doc_no = ?, updated_at = ? WHERE id = ?',
        f.subject_code,
        f.subject_name,
        f.grade_level,
        f.teaching_methods,
        f.link_url,
        f.doc_no,
        now,
        sub.id
      );
      await rememberSubject(req, sub, f);
      // บันทึกหลังแผนของเล่มนี้ ใช้รหัสและชื่อวิชาตามแผน
      if (sub.doc_type === 'plan') {
        await q.run(
          "UPDATE submissions SET subject_code = ?, subject_name = ?, grade_level = ? WHERE parent_id = ? AND doc_type = 'note'",
          f.subject_code,
          f.subject_name,
          f.grade_level,
          sub.id
        );
      }
    }
    // ไฟล์ที่ติ๊กเอาออก เก็บไว้เป็นประวัติ ไม่ลบทิ้ง
    for (const fid of asArray(b.remove_files).map(util.idOrNull).filter((x) => x !== null)) {
      await q.run('UPDATE files SET is_current = 0 WHERE id = ? AND submission_id = ?', fid, sub.id);
    }
    if (sub.doc_type === 'note') await up.attach(sub.id, files, 'attach');
    else {
      // PDF ไฟล์เดียว: แนบไฟล์ใหม่แล้วไฟล์เดิมย้ายไปเป็นประวัติ
      if (req.ff.pdfonly && files.length) {
        await q.run('UPDATE files SET is_current = 0 WHERE submission_id = ? AND is_current = 1', sub.id);
      }
      await up.attach(sub.id, files, 'main');
    }
  });
}

router.post('/s/:id', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!editable(req, sub)) throw new UserError('แก้ไขได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
  const b = req.body || {};
  const files = await up.take(req, sub.doc_type === 'note' ? 'attach_files' : 'main_files');
  let mergedMsg = '';
  try {
    await rejectBadFiles(req, files);
    if (sub.doc_type !== 'note') mergedMsg = checkPdf(req, sub.doc_type, files);
    await saveEdit(req, sub, b, nowStr(), files);
  } catch (e) {
    await dropFiles(req, files);
    throw e;
  }
  await finishSave(req, res, sub.id, b.action === 'submit', `บันทึกการแก้ไขเรียบร้อย${mergedMsg} ยังไม่ได้ส่งให้ผู้ตรวจ`);
});

router.post('/s/:id/submit', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!editable(req, sub)) throw new UserError('ส่งได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
  const after = await trySubmit(req, sub.id);
  respond(req, res, `/s/${sub.id}`, 'success', submittedMessage(after));
});

router.post('/s/:id/withdraw', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  await wf.withdraw(sub.id, req.me);
  respond(req, res, `/s/${sub.id}`, 'success', 'ดึงงานกลับมาแก้ไขแล้ว แก้เสร็จอย่าลืมกดส่งอีกครั้ง');
});

async function deleteSubmission(id) {
  const ids = [id, ...(await q.all('SELECT id FROM submissions WHERE parent_id = ?', id)).map((r) => r.id)];
  const stored = [];
  for (const sid of ids) for (const f of await q.all('SELECT stored_name FROM files WHERE submission_id = ?', sid)) stored.push(f.stored_name);
  await q.tx(async () => {
    await q.run('DELETE FROM submissions WHERE parent_id = ?', id);
    await q.run('DELETE FROM submissions WHERE id = ?', id);
  });
  // ย้ายไฟล์ไปถังขยะหลังลบในฐานสำเร็จแล้วเท่านั้น
  await up.trashAll(stored);
}

router.post('/s/:id/delete', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  const ownDraft = wf.isOwner(req.me, sub) && sub.status === 'draft' && !sub.submitted_at;
  if (!ownDraft && !req.me.is_admin) throw new UserError('ลบได้เฉพาะฉบับร่างที่ยังไม่เคยส่ง');
  await deleteSubmission(sub.id);
  respond(req, res, sub.parent_id ? `/s/${sub.parent_id}` : '/my', 'success', 'ลบเรียบร้อย');
});

// ---------- ส่งไฟล์เป็นท่อน ----------
// ฟอร์ม js-upload ส่งไฟล์ทีละไฟล์ก่อนบันทึกงาน: เริ่ม (ได้ token) แล้วส่งท่อนละ 5 MB ไปที่ PUT /upload/:token
// เซิร์ฟเวอร์ส่งต่อแต่ละท่อนเข้าที่เก็บไฟล์ทันที ที่อยู่ปลายทาง (Drive session) อยู่ในฐานเท่านั้น ไม่ส่งให้เบราว์เซอร์

// ข้อมูลงานสำหรับคิดโฟลเดอร์ใน Drive (ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน) จากฟอร์มที่จะแนบไฟล์
// form = ที่อยู่ของฟอร์ม: /works (งานใหม่) · /notes (บันทึกใหม่ ต้องมี plan_id) · /s/<id> (แก้ไขงานเดิม)
async function uploadTarget(req, b) {
  const form = String(b.form || '');
  const m = /^\/s\/(\d+)$/.exec(form);
  if (m) {
    const sub = await viewable(req, m[1]);
    if (!editable(req, sub)) throw new UserError('แก้ไขได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
    // แผนและคู่มือ ใช้รหัสวิชาที่พิมพ์อยู่ในฟอร์มตอนนี้
    return sub.doc_type === 'note' || !b.subject_code ? sub : { ...sub, subject_code: str(b.subject_code, 30), subject_name: str(b.subject_name, 200) };
  }
  if (form === '/notes') {
    const plan = await parentPlanFor(req, b.plan_id);
    return { ...plan, doc_type: 'note', teacher_name: req.me.full_name, dept_name: req.me.dept_name };
  }
  if (form === '/works' && WORK_TYPES.includes(b.doc_type)) {
    if (!req.me.department_id) throw new UserError('บัญชีของคุณยังไม่ได้กำหนดกลุ่มสาระ กรุณาแจ้งผู้ดูแลระบบ');
    return {
      doc_type: b.doc_type,
      academic_year: Number(req.settings.academic_year),
      semester: Number(req.settings.semester),
      subject_code: str(b.subject_code, 30),
      subject_name: str(b.subject_name, 200),
      teacher_name: req.me.full_name,
      dept_name: req.me.dept_name,
    };
  }
  throw new UserError('ส่งไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
}

router.post('/upload/start', async (req, res) => {
  const b = req.body || {};
  const field = b.field === 'attach_files' ? 'attach_files' : 'main_files';
  const target = await uploadTarget(req, b);
  let name = str(b.name, 200) || 'file';
  // ไฟล์ที่เบราว์เซอร์รวมจากหลายไฟล์ ตั้งชื่อแบบเดิมของระบบ เช่น คู่มือรายวิชา ว31101.pdf
  if (field === 'main_files' && intOrNull(b.merged) > 1) name = `${wf.DOC_TYPES[target.doc_type].label} ${target.subject_code || ''}`.trim() + '.pdf';
  const count = Math.min(up.MAX_FILES, Math.max(1, intOrNull(b.count) || 1));
  const idx = Math.min(count - 1, intOrNull(b.idx) || 0);
  // แผนและคู่มือ ชื่อใน Drive เป็นรหัสและชื่อวิชา · ไฟล์ประกอบบันทึกหลังแผนใช้ชื่อเดิมของไฟล์
  const parts = drivepath.relPath(target, { original_name: name }, idx, count).split('/');
  const storeName = field === 'attach_files' ? name : parts[parts.length - 1];
  const token = await up.start(req.me.id, { name, storeName, size: Number(b.size), folderPath: parts.slice(0, -1).join('/'), settings: req.settings });
  res.json({ token, chunk: storage.CHUNK });
});

// ท่อนของไฟล์ (Content-Range) ไม่ผ่านตัวอ่าน body ส่งต่อเข้าที่เก็บไฟล์เป็นสตรีม
router.put('/upload/:token', async (req, res) => {
  const r = await up.putChunk(req.me.id, String(req.params.token).slice(0, 100), req.get('content-range'), req.get('content-length'), req);
  res.json({ ok: true, ...r });
});

// ---------- ไฟล์ ----------

// ส่งไฟล์จากที่เก็บไฟล์ต่อเป็นสตรีม (ไม่โหลดทั้งไฟล์ ไม่คำนวณ ETag) รองรับขอบางช่วง (Range) แบบเดียวกับเดิม
async function sendStored(req, res, f, headers) {
  const range = /^bytes=\d*-\d*$/.test(req.get('range') || '') ? req.get('range') : undefined;
  let r;
  try {
    r = await storage.get(f.stored_name, { range });
  } catch (e) {
    if (e.code !== 'ENOENT' && e.status !== 404) console.error('เปิดไฟล์ไม่สำเร็จ', f.id, e.message);
    if (!res.headersSent) res.status(404).end();
    return;
  }
  res.status(r.status);
  res.set({ ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(r.length) });
  if (r.contentRange) res.set('Content-Range', r.contentRange);
  if (req.method === 'HEAD') {
    r.stream.destroy();
    return res.end();
  }
  try {
    await pipeline(r.stream, res);
  } catch {
    // ผู้ใช้ปิดหน้าไปก่อนโหลดเสร็จ
  }
}

router.get('/f/:id', async (req, res) => {
  const f = await loadFile(req.params.id);
  const sub = f && (await viewable(req, f.submission_id));
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบไฟล์', message: 'ไม่พบไฟล์ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const inline = !req.query.dl && /^(application\/pdf|image\/)/.test(f.mime);
  await sendStored(req, res, f, {
    'Content-Type': f.mime || 'application/octet-stream',
    'Content-Disposition': util.contentDisposition(f.original_name, inline ? 'inline' : 'attachment'),
    'Cache-Control': 'public, max-age=0',
  });
});

// ข้อมูลไฟล์สำหรับตัวแสดง PDF ในหน้าเว็บ ไม่บอกชื่อไฟล์และชนิดไฟล์ PDF
// เพื่อไม่ให้โปรแกรมช่วยดาวน์โหลด (เช่น Internet Download Manager) ดักไปดาวน์โหลดแทนการแสดงผล
router.get('/f/:id/raw', async (req, res) => {
  const f = await loadFile(req.params.id);
  const sub = f && (await viewable(req, f.submission_id));
  if (!sub) return res.status(404).end();
  await sendStored(req, res, f, { 'Content-Type': 'application/x-lesson-file', 'Cache-Control': 'private, no-store' });
});

// หน้าเปิดอ่านไฟล์ในเว็บ (PDF ทุกหน้า หรือรูป) ไม่ขึ้นกับการตั้งค่าเบราว์เซอร์ที่สั่งให้ดาวน์โหลด
router.get('/f/:id/view', async (req, res) => {
  const f = await loadFile(req.params.id);
  const sub = f && (await viewable(req, f.submission_id));
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบไฟล์', message: 'ไม่พบไฟล์ หรือคุณไม่มีสิทธิ์เปิดดู' });
  if (!/^(application\/pdf|image\/)/.test(f.mime)) return res.redirect(`/f/${f.id}?dl=1`);
  res.render('file_view', { title: f.original_name, file: f, sub });
});

// ---------- พิมพ์: บันทึกข้อความ แบบประเมิน บันทึกหลังแผน ----------

function gradeFull(g) {
  const m = /^ม\.?\s*(\d)/.exec(g || '');
  if (m) return `มัธยมศึกษาปีที่ ${m[1]}`;
  const p = /^ป\.?\s*(\d)/.exec(g || '');
  if (p) return `ประถมศึกษาปีที่ ${p[1]}`;
  return g || '';
}

function deptFull(name) {
  if (!name) return '';
  return /^(กลุ่มสาระ|กิจกรรม)/.test(name) ? name : `กลุ่มสาระการเรียนรู้${name}`;
}

// ข้อมูลหน้าพิมพ์ของงานหลายชิ้น ใช้ไม่เกิน 3 คำสั่งไม่ว่ากี่ชิ้น: ประวัติการตรวจ (รูปลายเซ็นเฉพาะการลงนามเห็นชอบ)
// · ผู้ตรวจที่กำลังรอ (ถ้ามีงานรอตรวจ) · ไฟล์ของบันทึกหลังแผน · subs ต้องดึงพร้อม teacher_signature (subSelect(true))
async function printDataMany(subs) {
  if (!subs.length) return [];
  const reviews = await wf.reviewsMany(subs.map((s) => s.id), { signatures: 'approve' });
  const steps = await wf.progressMany(subs, { reviews });
  const noteIds = subs.filter((s) => s.doc_type === 'note').map((s) => s.id);
  const files = new Map(noteIds.map((id) => [id, []]));
  if (noteIds.length) {
    for (const f of await q.all('SELECT * FROM files WHERE submission_id = ANY(?) AND is_current = 1 ORDER BY id', noteIds)) files.get(f.submission_id).push(f);
  }
  return subs.map((sub, i) => {
    const revs = reviews.get(sub.id) || [];
    // วันที่ส่งครั้งแรก และผู้ให้คะแนนคนล่าสุด
    const firstSubmit = revs.find((r) => r.action === 'submit' || r.action === 'resubmit');
    const scorer = [...revs].reverse().find((r) => r.action === 'approve' && r.score_total != null);
    return {
      sub,
      steps: steps[i],
      scoreDetail: util.parseJson(sub.score_detail, []),
      scorer,
      gradeFull: gradeFull(sub.grade_level),
      deptFull: deptFull(sub.dept_name),
      submitDate: firstSubmit ? firstSubmit.created_at : sub.created_at,
      files: sub.doc_type === 'note' ? files.get(sub.id) : [],
    };
  });
}

async function printData(sub) {
  return (await printDataMany([sub]))[0];
}

router.get('/s/:id/print', async (req, res) => {
  const sub = await viewable(req, req.params.id, { signature: true });
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const qr = sub.status === 'draft' ? '' : await qrSvg(req, sub);
  if (sub.doc_type === 'note') {
    return res.render('print_notes', { title: 'พิมพ์บันทึกหลังแผน', items: [{ ...(await printData(sub)), qr }] });
  }
  const view = req.query.doc === 'eval' ? 'print_eval' : 'print_memo';
  res.render(view, { title: 'พิมพ์', rubric: wf.rubric(sub.doc_type), ...(await printData(sub)), qr });
});

// พิมพ์บันทึกหลังแผนทั้งเล่ม (เฉพาะฉบับที่ส่งแล้ว)
router.get('/s/:id/print-notes', async (req, res) => {
  const plan = await viewable(req, req.params.id);
  if (!plan || plan.doc_type !== 'plan') return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบแผนนี้' });
  // บันทึกทุกฉบับของเล่มในคำสั่งเดียว (เดิมถามทีละฉบับ)
  const notes = await q.all(
    `${subSelect(true)} WHERE s.parent_id = ? AND s.doc_type = 'note' AND s.status != 'draft' ORDER BY to_int_lenient(s.plan_no), s.id`,
    plan.id
  );
  const data = await printDataMany(notes);
  const items = [];
  for (let i = 0; i < notes.length; i++) items.push({ ...data[i], qr: await qrSvg(req, notes[i]) });
  res.render('print_notes', { title: 'พิมพ์บันทึกหลังแผนทั้งเล่ม', items });
});

// ---------- ผู้ตรวจลงนาม ----------

// คะแนนรายข้อส่งมาเป็นช่อง score_<รหัสข้อ>
function collectScores(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    const m = /^score_(\d+)$/.exec(k);
    if (m) out[m[1]] = v;
  }
  return out;
}

async function applySignature(req) {
  const b = req.body || {};
  if (b.signature && validSignature(b.signature)) {
    await q.run('UPDATE users SET signature = ? WHERE id = ?', b.signature, req.me.id);
    req.me.signature = b.signature;
  }
}

router.post('/s/:id/approve', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  await applySignature(req);
  const b = req.body || {};
  const after = await wf.approve(sub.id, req.me, { comment: str(b.comment), scores: collectScores(b) });
  const next = (await wf.inbox(req.me))[0];
  const msg =
    after.status === 'approved' ? 'ลงนามเรียบร้อย งานนี้ผ่านครบทุกระดับแล้ว' : `ลงนามเรียบร้อย ส่งต่อให้${wf.stepOf(after.current_role).label}แล้ว`;
  respond(req, res, next ? `/s/${next.id}` : '/inbox', 'success', next ? `${msg} ต่อไปเป็นงานถัดไปที่รอคุณ` : msg);
});

router.post('/s/:id/return', async (req, res) => {
  const sub = await viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  await wf.sendBack(sub.id, req.me, { comment: str((req.body || {}).comment) });
  respond(req, res, '/inbox', 'success', 'ส่งกลับให้ครูแก้ไขเรียบร้อย');
});

// ---------- ผู้ดูแลระบบดำเนินการแทน (ไม่ส่งข้อความแจ้งใคร แต่บันทึกในประวัติ) ----------

function adminOnly(req) {
  if (!req.me.is_admin) throw new UserError('เฉพาะผู้ดูแลระบบ');
}

router.post('/s/:id/admin-advance', async (req, res) => {
  adminOnly(req);
  const sub = await loadSub(req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  const st = wf.stepOf(sub.current_role);
  const after = await wf.overrideStep(sub.id, req.me, { comment: str((req.body || {}).comment) });
  await features.audit(req.me, `ดำเนินการแทน${st ? st.label : ''} ${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code} ของ ${sub.teacher_name}`, `submission ${sub.id}`);
  respond(req, res, `/s/${sub.id}`, 'success', after.status === 'approved' ? 'ดำเนินการแทนแล้ว งานนี้ผ่านครบทุกระดับ' : `ดำเนินการแทนแล้ว ขณะนี้${wf.statusText(after)}`);
});

router.post('/s/:id/admin-finish', async (req, res) => {
  adminOnly(req);
  const sub = await loadSub(req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  const miss = sub.status === 'pending' ? [] : await missingForSubmit(sub, req.ff);
  if (miss.length) throw new UserError(`ยังให้ผ่านไม่ได้ งานนี้ยังขาด ${miss.join(' และ ')} กดแก้ไขเพื่อเติมให้ครบก่อน`);
  await wf.overrideAll(sub.id, req.me, { comment: str((req.body || {}).comment) });
  await features.audit(req.me, `ให้ผ่านครบทุกระดับแทน ${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code} ของ ${sub.teacher_name}`, `submission ${sub.id}`);
  respond(req, res, `/s/${sub.id}`, 'success', 'ดำเนินการแทนแล้ว งานนี้ผ่านครบทุกระดับ ช่องลายเซ็นในเอกสารเว้นไว้ให้เซ็นด้วยมือ');
});

router.post('/inbox/approve-many', async (req, res) => {
  const b = req.body || {};
  await applySignature(req);
  if (!req.me.signature) throw new UserError('กรุณาบันทึกลายเซ็นในหน้าข้อมูลส่วนตัวก่อน');
  const ids = asArray(b.ids).map(util.idOrNull).filter(Boolean);
  if (!ids.length) throw new UserError('ยังไม่ได้เลือกรายการ');
  // ลงนามทุกงานที่เลือกใน transaction เดียว ข้ามงานที่ต้องให้คะแนนก่อน หรือไม่ได้รอคุณแล้ว
  const { done, skipped } = await wf.approveMany(ids, req.me, { comment: str(b.comment) });
  const extra = skipped ? ` ข้าม ${skipped} รายการที่ต้องให้คะแนนก่อน หรือไม่ได้รอคุณแล้ว` : '';
  respond(req, res, '/inbox', 'success', `ลงนามเรียบร้อย ${done} รายการ${extra}`);
});

module.exports = router;
module.exports.submitWindow = submitWindow;
module.exports.gradeFull = gradeFull;
module.exports.deptFull = deptFull;
module.exports.printData = printData;
module.exports.printDataMany = printDataMany;
module.exports.subjectChoices = subjectChoices;
