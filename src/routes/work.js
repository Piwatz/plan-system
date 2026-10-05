// ส่งแผนการจัดการเรียนรู้และคู่มือรายวิชา เขียนบันทึกหลังแผน เปิดไฟล์ พิมพ์ และการลงนามของผู้ตรวจ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { q, nowStr } = require('../db');
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const { uploader, storedPath, relStored, removeStored, badFiles, ALLOWED } = require('../upload');
const features = require('../features');
const teaching = require('../teaching');
const { mergePdfs } = require('../pdf');
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

function cleanupUploads(req) {
  for (const list of Object.values(req.files || {})) {
    for (const f of list) {
      try {
        fs.unlinkSync(f.path);
      } catch {
        // ไม่มีไฟล์ให้ลบ
      }
    }
  }
}

// ฟังก์ชันตรวจไฟล์ก่อนส่ง: ไม่รับไฟล์เสียหรือนามสกุลไม่ตรงกับไฟล์จริง
function rejectBadFiles(req) {
  if (!req.ff.filecheck) return;
  const bad = badFiles(req);
  if (!bad.length) return;
  cleanupUploads(req);
  throw new UserError(`ไฟล์ ${bad.join(' ')} เปิดไม่ได้ หรือนามสกุลไม่ตรงกับไฟล์จริง กรุณาบันทึกไฟล์ใหม่แล้วแนบอีกครั้ง`);
}

// แผนและคู่มือรับเฉพาะ PDF ไฟล์เดียว (เปิดปิดได้) ถ้าครูเลือกหลายไฟล์ ระบบรวมเป็นไฟล์เดียวตามลำดับที่เรียงไว้
async function preparePdf(req, docType, code) {
  const list = (req.files && req.files.main_files) || [];
  if (!req.ff.pdfonly || !list.length) return '';
  const label = wf.DOC_TYPES[docType].label;
  const notPdf = list.filter((x) => path.extname(x.originalname).toLowerCase() !== '.pdf');
  if (notPdf.length) {
    cleanupUploads(req);
    throw new UserError(`${label}รับเฉพาะไฟล์ PDF (${notPdf.map((x) => x.originalname).join(' ')} ไม่ใช่ PDF) ถ้าเป็นไฟล์ Word ให้บันทึกเป็น PDF ก่อน แล้วแนบใหม่`);
  }
  if (list.length === 1) return '';
  if (!req.ff.pdfmerge) {
    cleanupUploads(req);
    throw new UserError(`${label}แนบได้ PDF ไฟล์เดียว ให้รวมปกและเนื้อหาเป็นไฟล์เดียวก่อน แล้วแนบใหม่`);
  }
  let merged;
  try {
    merged = await mergePdfs(list.map((x) => ({ path: x.path, name: x.originalname })));
  } catch (e) {
    cleanupUploads(req);
    throw e;
  }
  const target = path.join(path.dirname(list[0].path), crypto.randomBytes(12).toString('hex') + '.pdf');
  fs.writeFileSync(target, merged.buffer);
  cleanupUploads(req);
  const name = `${label} ${code || ''}`.trim() + '.pdf';
  req.files.main_files = [{ path: target, originalname: name, size: merged.buffer.length }];
  return ` รวม ${list.length} ไฟล์เป็นไฟล์เดียวแล้ว ${merged.pages} หน้า`;
}

function saveFiles(subId, req, field, kind) {
  const now = nowStr();
  for (const f of (req.files && req.files[field]) || []) {
    const ext = path.extname(f.originalname).toLowerCase();
    q.run(
      'INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      subId,
      kind,
      f.originalname.slice(0, 200),
      relStored(f.path),
      ALLOWED[ext] || 'application/octet-stream',
      f.size,
      now
    );
  }
}

function currentFiles(subId) {
  return q.all('SELECT * FROM files WHERE submission_id = ? AND is_current = 1 ORDER BY id', subId);
}

function loadSub(id) {
  return q.get(
    `SELECT s.*, u.full_name AS teacher_name, u.position AS teacher_position, d.name AS dept_name,
       p.status AS parent_status
     FROM submissions s
     JOIN users u ON u.id = s.teacher_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN submissions p ON p.id = s.parent_id
     WHERE s.id = ?`,
    Number(id)
  );
}

function viewable(req, id) {
  const sub = loadSub(id);
  if (!sub || !wf.canView(req.me, sub)) return null;
  return sub;
}

// แก้ไขได้: เจ้าของงาน หรือผู้ดูแลระบบ (แก้แทนครู) เมื่อเป็นฉบับร่างหรือถูกส่งกลับ
function editable(req, sub) {
  return Boolean(sub && (wf.isOwner(req.me, sub) || req.me.is_admin) && (sub.status === 'draft' || sub.status === 'returned'));
}

function submitWindow(settings) {
  if (settings.submit_open !== '1') return { open: false, reason: 'ขณะนี้ปิดรับการส่งแผนและคู่มือ' };
  const today = nowStr().slice(0, 10);
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
function missingForSubmit(sub, ff) {
  const miss = [];
  if (sub.doc_type === 'note') {
    if (!sub.plan_no && !sub.topic) miss.push('แผนที่ หรือ เรื่อง');
    if (sub.note_mode === 'file') {
      if (currentFiles(sub.id).length === 0) miss.push('ไฟล์บันทึกหลังแผนของคุณ');
    } else if (!sub.result_k && !sub.result_p && !sub.result_a) miss.push('ผลการจัดการเรียนรู้อย่างน้อย 1 ด้าน');
    if (ff.counts && (sub.students_total == null || sub.students_passed == null)) miss.push('จำนวนนักเรียนทั้งหมดและจำนวนที่ผ่านจุดประสงค์');
    if (sub.students_total != null && sub.students_passed != null && sub.students_passed > sub.students_total) {
      miss.push('จำนวนนักเรียนที่ผ่านเกณฑ์ต้องไม่มากกว่าจำนวนทั้งหมด');
    }
  } else {
    if (!sub.subject_code) miss.push('รหัสวิชา');
    if (!sub.subject_name) miss.push('ชื่อวิชา');
    if (!sub.grade_level) miss.push('ระดับชั้น');
    const cur = currentFiles(sub.id);
    if (ff.pdfonly) {
      if (!cur.length) miss.push('ไฟล์ PDF');
      else if (cur.some((x) => x.mime !== 'application/pdf')) miss.push('ไฟล์ PDF แทนไฟล์ Word หรือไฟล์ชนิดอื่นที่แนบไว้');
      else if (cur.length > 1) miss.push(`ไฟล์ PDF ไฟล์เดียว (ตอนนี้มี ${cur.length} ไฟล์ ให้แนบไฟล์ที่รวมแล้วแทน)`);
    } else if (cur.length === 0 && !sub.link_url) miss.push('ไฟล์หรือลิงก์อย่างน้อย 1 อย่าง');
  }
  return miss;
}

function trySubmit(req, subId) {
  const sub = wf.getSub(subId);
  const miss = missingForSubmit(sub, req.ff);
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
function subjectChoices(req) {
  const mine = req.ff.teachlist ? teaching.list(req.me.id, Number(req.settings.academic_year), Number(req.settings.semester)) : [];
  const out = mine.map((x) => ({ code: x.subject_code, name: x.subject_name, grade: x.grade_level }));
  const seen = new Set(out.map((x) => x.code));
  for (const x of q.all('SELECT * FROM subjects ORDER BY code')) if (!seen.has(x.code)) out.push(x);
  return out;
}

// จำวิชาที่ส่งงานไว้ในรายการรายวิชาที่สอน (ส่งแผน = วิชาหลัก)
function rememberSubject(req, sub, f) {
  if (!req.ff.teachlist || !f.subject_code || teaching.skipActivity(f.subject_code)) return;
  const owner = sub.teacher_id === req.me.id ? req.me : q.get('SELECT * FROM users WHERE id = ?', sub.teacher_id);
  teaching.ensure(owner, sub.academic_year, sub.semester, { code: f.subject_code, name: f.subject_name, grade: f.grade_level }, sub.doc_type === 'plan');
}

function finishSave(req, res, id, wantSubmit, savedMsg) {
  if (!wantSubmit) return respond(req, res, `/s/${id}`, 'success', savedMsg);
  try {
    const sub = trySubmit(req, id);
    return respond(req, res, `/s/${id}`, 'success', submittedMessage(sub));
  } catch (e) {
    if (e instanceof UserError || e instanceof wf.WorkflowError) return respond(req, res, `/s/${id}/edit`, 'error', e.message);
    throw e;
  }
}

function findDuplicate(teacherId, year, sem, docType, code, exceptId = 0) {
  if (!code) return null;
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

// ---------- คู่มือรายวิชา และ แผนการจัดการเรียนรู้ ----------

const workUpload = uploader([{ name: 'main_files', maxCount: 10 }]);

router.get('/works/new', (req, res) => {
  const type = WORK_TYPES.includes(req.query.type) ? req.query.type : 'manual';
  if (!req.me.department_id) throw new UserError('บัญชีของคุณยังไม่ได้กำหนดกลุ่มสาระ กรุณาแจ้งผู้ดูแลระบบ');
  const year = Number(req.settings.academic_year);
  const sem = Number(req.settings.semester);
  if (type === 'plan' && req.ff.onemain) {
    const why = teaching.planBlocked(req.me, year, sem);
    if (why) throw new UserError(why);
  }
  const sub = { doc_type: type, academic_year: year, semester: sem, teaching_methods: '[]' };
  // กดมาจากรายวิชาที่มีอยู่แล้ว ให้กรอกรหัสและชื่อวิชาให้เลย
  const from = req.query.from ? q.get('SELECT * FROM submissions WHERE id = ? AND teacher_id = ?', Number(req.query.from), req.me.id) : null;
  if (from) Object.assign(sub, { subject_code: from.subject_code, subject_name: from.subject_name, grade_level: from.grade_level });
  else if (req.query.code) {
    const code = str(req.query.code, 30);
    const x = subjectChoices(req).find((c) => c.code === code);
    Object.assign(sub, { subject_code: code, subject_name: x ? x.name : '', grade_level: x ? x.grade : '' });
  }
  res.render('work_form', {
    title: `ส่ง${wf.DOC_TYPES[type].label}`,
    sub,
    files: [],
    subjects: subjectChoices(req),
    window: submitWindow(req.settings),
    isNew: true,
  });
});

router.post('/works', workUpload, async (req, res) => {
  const b = req.body || {};
  const type = WORK_TYPES.includes(b.doc_type) ? b.doc_type : null;
  const year = Number(req.settings.academic_year);
  const sem = Number(req.settings.semester);
  const f = type ? workFields(b, type) : null;
  let problem = null;
  if (!type) problem = 'ไม่รู้จักชนิดงาน';
  else if (!req.me.department_id) problem = 'บัญชีของคุณยังไม่ได้กำหนดกลุ่มสาระ กรุณาแจ้งผู้ดูแลระบบ';
  else if (findDuplicate(req.me.id, year, sem, type, f.subject_code)) {
    problem = `${wf.DOC_TYPES[type].label}วิชา ${f.subject_code} ส่งไว้แล้วในภาคเรียนนี้ ให้เปิดงานเดิมแล้วกดแก้ไขแทน`;
  } else if (teaching.skipActivity(f.subject_code)) problem = 'วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ';
  else if (type === 'plan' && req.ff.onemain) problem = teaching.planBlocked(req.me, year, sem) || null;
  if (problem) {
    cleanupUploads(req);
    throw new UserError(problem);
  }
  rejectBadFiles(req);
  const mergedMsg = await preparePdf(req, type, f.subject_code);
  const now = nowStr();
  let id;
  try {
    id = q.tx(() => {
      const r = q.run(
        `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name,
           grade_level, teaching_methods, link_url, doc_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const newId = Number(r.lastInsertRowid);
      saveFiles(newId, req, 'main_files', 'main');
      rememberSubject(req, { teacher_id: req.me.id, doc_type: type, academic_year: year, semester: sem }, f);
      return newId;
    });
  } catch (e) {
    cleanupUploads(req);
    throw e;
  }
  finishSave(req, res, id, b.action === 'submit', `บันทึกร่างเรียบร้อย${mergedMsg} ยังไม่ได้ส่งให้ผู้ตรวจ`);
});

// ---------- บันทึกหลังแผน ----------

const noteUpload = uploader([{ name: 'attach_files', maxCount: 10 }]);

function parentPlanFor(req, planId) {
  const plan = q.get("SELECT * FROM submissions WHERE id = ? AND doc_type = 'plan'", Number(planId));
  if (!plan || plan.teacher_id !== req.me.id) throw new UserError('ไม่พบแผนการจัดการเรียนรู้ของคุณ');
  if (plan.status === 'draft') throw new UserError('ต้องส่งแผนการจัดการเรียนรู้รายวิชานี้ก่อน จึงจะเขียนบันทึกหลังแผนได้');
  return plan;
}

router.get('/notes/new', (req, res) => {
  const plan = parentPlanFor(req, req.query.plan);
  // ใช้หน่วยและห้องเดียวกับบันทึกฉบับล่าสุด ครูไม่ต้องพิมพ์ซ้ำ
  const last = q.get("SELECT * FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY id DESC LIMIT 1", plan.id);
  const maxNo = q.get(
    "SELECT MAX(CAST(plan_no AS INTEGER)) AS n FROM submissions WHERE parent_id = ? AND doc_type = 'note'",
    plan.id
  ).n;
  const sub = { plan_no: String((maxNo || 0) + 1), note_mode: last && req.ff.notefile ? last.note_mode : 'type' };
  if (last) Object.assign(sub, { unit_no: last.unit_no, unit_name: last.unit_name, class_room: last.class_room, hours: last.hours, students_total: last.students_total });
  res.render('note_form', { title: 'เขียนบันทึกหลังแผน', plan, sub, files: [], isNew: true, ...noteHelpers(req, plan.id, 0) });
});

// ประโยคสำเร็จรูป และข้อความจากบันทึกฉบับก่อนหน้าให้คัดลอกมาแก้
function noteHelpers(req, planId, exceptId) {
  const prev = req.ff.chips
    ? q.get(
        "SELECT plan_no, result_k, result_p, result_a, problems, suggestions FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND id != ? AND note_mode = 'type' AND (result_k != '' OR result_p != '' OR result_a != '') ORDER BY id DESC LIMIT 1",
        planId,
        exceptId
      )
    : null;
  return { phrases: req.ff.chips ? features.phrases(req.settings) : null, prev: prev || null };
}

router.post('/notes', noteUpload, (req, res) => {
  const b = req.body || {};
  let plan;
  try {
    plan = parentPlanFor(req, b.plan_id);
  } catch (e) {
    cleanupUploads(req);
    throw e;
  }
  rejectBadFiles(req);
  const f = noteFields(b, req.ff);
  const now = nowStr();
  let id;
  try {
    id = q.tx(() => {
      const r = q.run(
        `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name,
           grade_level, ${NOTE_COLS.join(', ')}, created_at, updated_at)
         VALUES ('note', ?, ?, ?, ?, ?, ?, ?, ?, ${NOTE_COLS.map(() => '?').join(', ')}, ?, ?)`,
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
      const newId = Number(r.lastInsertRowid);
      saveFiles(newId, req, 'attach_files', 'attach');
      return newId;
    });
  } catch (e) {
    cleanupUploads(req);
    throw e;
  }
  if (b.action === 'new') {
    req.flash('success', `บันทึกร่างแผนที่ ${f.plan_no || ''} แล้ว เขียนฉบับต่อไปได้เลย`);
    return respond(req, res, `/notes/new?plan=${plan.id}`, null, null);
  }
  finishSave(req, res, id, b.action === 'submit', 'บันทึกร่างเรียบร้อย ยังไม่ได้ส่งให้ผู้ตรวจ');
});

// ส่งบันทึกหลังแผนหลายฉบับพร้อมกัน
router.post('/notes/submit-many', (req, res) => {
  const b = req.body || {};
  const ids = asArray(b.ids).map(Number).filter(Boolean);
  if (!ids.length) throw new UserError('ยังไม่ได้เลือกบันทึกที่จะส่ง');
  let ok = 0;
  const problems = [];
  for (const id of ids) {
    const sub = loadSub(id);
    if (!editable(req, sub) || sub.doc_type !== 'note') continue;
    try {
      trySubmit(req, id);
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

router.get('/s/:id', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const files = q.all('SELECT * FROM files WHERE submission_id = ? ORDER BY is_current DESC, id', sub.id);
  const notes =
    sub.doc_type === 'plan'
      ? q.all("SELECT * FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY CAST(plan_no AS INTEGER), id", sub.id)
      : [];
  const reviews = wf.reviewsOf(sub.id);
  const lastReturn = [...reviews].reverse().find((r) => r.action === 'return');
  const sibling =
    sub.doc_type === 'note'
      ? null
      : q.get(
          'SELECT id, doc_type, status, current_role FROM submissions WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND subject_code = ? AND doc_type = ?',
          sub.teacher_id,
          sub.academic_year,
          sub.semester,
          sub.subject_code,
          sub.doc_type === 'plan' ? 'manual' : 'plan'
        );
  const parent = sub.parent_id ? q.get('SELECT id, subject_code, subject_name, status FROM submissions WHERE id = ?', sub.parent_id) : null;
  res.render('detail', {
    title: `${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code}`,
    sub,
    files,
    notes,
    reviews,
    lastReturn,
    sibling,
    parent,
    steps: wf.progress(sub),
    canReview: wf.canReview(req.me, sub),
    needsScore: wf.needsScore(sub),
    rubric: wf.rubric(sub.doc_type),
    canEdit: editable(req, sub),
    canWithdraw: wf.canWithdraw(req.me, sub),
    canDelete: (wf.isOwner(req.me, sub) && sub.status === 'draft' && !sub.submitted_at) || req.me.is_admin,
    isOwner: wf.isOwner(req.me, sub),
    canPlan: !req.ff.onemain || !teaching.planBlocked(req.me, Number(req.settings.academic_year), Number(req.settings.semester)),
    approveLabel: approveLabel(sub),
  });
});

router.get('/s/:id/edit', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!editable(req, sub)) throw new UserError('แก้ไขได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
  const files = currentFiles(sub.id);
  const lastReturn = [...wf.reviewsOf(sub.id)].reverse().find((r) => r.action === 'return');
  if (sub.doc_type !== 'note') {
    return res.render('work_form', {
      lastReturn,
      title: `แก้ไข${wf.DOC_TYPES[sub.doc_type].label}`,
      sub,
      files,
      subjects: subjectChoices(req),
      window: submitWindow(req.settings),
      isNew: false,
    });
  }
  const plan = q.get('SELECT * FROM submissions WHERE id = ?', sub.parent_id);
  res.render('note_form', { title: 'แก้ไขบันทึกหลังแผน', plan, sub, files, lastReturn, isNew: false, ...noteHelpers(req, plan.id, sub.id) });
});

router.post('/s/:id', (req, res, next) => {
  const sub = viewable(req, req.params.id);
  if (!editable(req, sub)) return next(new UserError('แก้ไขได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ'));
  const mw = sub.doc_type === 'note' ? noteUpload : workUpload;
  mw(req, res, async (err) => {
    if (err) return next(err);
    const b = req.body || {};
    const now = nowStr();
    let mergedMsg = '';
    try {
      rejectBadFiles(req);
      if (sub.doc_type !== 'note') mergedMsg = await preparePdf(req, sub.doc_type, str(b.subject_code, 30));
      q.tx(() => {
        if (sub.doc_type === 'note') {
          const f = noteFields(b, req.ff);
          q.run(
            `UPDATE submissions SET ${NOTE_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            ...NOTE_COLS.map((c) => f[c]),
            now,
            sub.id
          );
        } else {
          const f = workFields(b, sub.doc_type);
          if (teaching.skipActivity(f.subject_code) && f.subject_code !== sub.subject_code) throw new UserError('วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ');
          if (findDuplicate(sub.teacher_id, sub.academic_year, sub.semester, sub.doc_type, f.subject_code, sub.id)) {
            throw new UserError(`${wf.DOC_TYPES[sub.doc_type].label}วิชา ${f.subject_code} มีอยู่แล้วในภาคเรียนนี้`);
          }
          q.run(
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
          rememberSubject(req, sub, f);
          // บันทึกหลังแผนของเล่มนี้ ใช้รหัสและชื่อวิชาตามแผน
          if (sub.doc_type === 'plan') {
            q.run(
              "UPDATE submissions SET subject_code = ?, subject_name = ?, grade_level = ? WHERE parent_id = ? AND doc_type = 'note'",
              f.subject_code,
              f.subject_name,
              f.grade_level,
              sub.id
            );
          }
        }
        // ไฟล์ที่ติ๊กเอาออก เก็บไว้เป็นประวัติ ไม่ลบทิ้ง
        for (const fid of asArray(b.remove_files)) {
          q.run('UPDATE files SET is_current = 0 WHERE id = ? AND submission_id = ?', Number(fid), sub.id);
        }
        if (sub.doc_type === 'note') saveFiles(sub.id, req, 'attach_files', 'attach');
        else {
          // PDF ไฟล์เดียว: แนบไฟล์ใหม่แล้วไฟล์เดิมย้ายไปเป็นประวัติ
          if (req.ff.pdfonly && ((req.files && req.files.main_files) || []).length) {
            q.run('UPDATE files SET is_current = 0 WHERE submission_id = ? AND is_current = 1', sub.id);
          }
          saveFiles(sub.id, req, 'main_files', 'main');
        }
      });
    } catch (e) {
      cleanupUploads(req);
      return next(e);
    }
    try {
      finishSave(req, res, sub.id, b.action === 'submit', `บันทึกการแก้ไขเรียบร้อย${mergedMsg} ยังไม่ได้ส่งให้ผู้ตรวจ`);
    } catch (e) {
      next(e);
    }
  });
});

router.post('/s/:id/submit', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!editable(req, sub)) throw new UserError('ส่งได้เฉพาะงานของตนเองที่เป็นฉบับร่างหรือถูกส่งกลับ');
  const after = trySubmit(req, sub.id);
  respond(req, res, `/s/${sub.id}`, 'success', submittedMessage(after));
});

router.post('/s/:id/withdraw', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  wf.withdraw(sub.id, req.me);
  respond(req, res, `/s/${sub.id}`, 'success', 'ดึงงานกลับมาแก้ไขแล้ว แก้เสร็จอย่าลืมกดส่งอีกครั้ง');
});

function deleteSubmission(id) {
  const ids = [id, ...q.all('SELECT id FROM submissions WHERE parent_id = ?', id).map((r) => r.id)];
  const stored = [];
  for (const sid of ids) for (const f of q.all('SELECT stored_name FROM files WHERE submission_id = ?', sid)) stored.push(f.stored_name);
  q.tx(() => {
    q.run('DELETE FROM submissions WHERE parent_id = ?', id);
    q.run('DELETE FROM submissions WHERE id = ?', id);
  });
  stored.forEach(removeStored);
}

router.post('/s/:id/delete', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  const ownDraft = wf.isOwner(req.me, sub) && sub.status === 'draft' && !sub.submitted_at;
  if (!ownDraft && !req.me.is_admin) throw new UserError('ลบได้เฉพาะฉบับร่างที่ยังไม่เคยส่ง');
  deleteSubmission(sub.id);
  respond(req, res, sub.parent_id ? `/s/${sub.parent_id}` : '/my', 'success', 'ลบเรียบร้อย');
});

// ---------- ไฟล์ ----------

router.get('/f/:id', (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
  const sub = f && viewable(req, f.submission_id);
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบไฟล์', message: 'ไม่พบไฟล์ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const inline = !req.query.dl && /^(application\/pdf|image\/)/.test(f.mime);
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('Content-Disposition', util.contentDisposition(f.original_name, inline ? 'inline' : 'attachment'));
  res.sendFile(storedPath(f.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ข้อมูลไฟล์สำหรับตัวแสดง PDF ในหน้าเว็บ ไม่บอกชื่อไฟล์และชนิดไฟล์ PDF
// เพื่อไม่ให้โปรแกรมช่วยดาวน์โหลด (เช่น Internet Download Manager) ดักไปดาวน์โหลดแทนการแสดงผล
router.get('/f/:id/raw', (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
  const sub = f && viewable(req, f.submission_id);
  if (!sub) return res.status(404).end();
  res.set('Content-Type', 'application/x-lesson-file');
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(storedPath(f.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// หน้าเปิดอ่านไฟล์ในเว็บ (PDF ทุกหน้า หรือรูป) ไม่ขึ้นกับการตั้งค่าเบราว์เซอร์ที่สั่งให้ดาวน์โหลด
router.get('/f/:id/view', (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
  const sub = f && viewable(req, f.submission_id);
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

function scorer(sub) {
  return q.get(
    "SELECT * FROM reviews WHERE submission_id = ? AND action = 'approve' AND score_total IS NOT NULL ORDER BY id DESC LIMIT 1",
    sub.id
  );
}

function printData(sub) {
  const firstSubmit = q.get(
    "SELECT created_at FROM reviews WHERE submission_id = ? AND action IN ('submit', 'resubmit') ORDER BY id LIMIT 1",
    sub.id
  );
  return {
    sub,
    steps: wf.progress(sub),
    scoreDetail: util.parseJson(sub.score_detail, []),
    scorer: scorer(sub),
    gradeFull: gradeFull(sub.grade_level),
    deptFull: deptFull(sub.dept_name),
    submitDate: firstSubmit ? firstSubmit.created_at : sub.created_at,
    files: sub.doc_type === 'note' ? currentFiles(sub.id) : [],
  };
}

router.get('/s/:id/print', async (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์เปิดดู' });
  const qr = sub.status === 'draft' ? '' : await qrSvg(req, sub);
  if (sub.doc_type === 'note') {
    return res.render('print_notes', { title: 'พิมพ์บันทึกหลังแผน', items: [{ ...printData(sub), qr }] });
  }
  const view = req.query.doc === 'eval' ? 'print_eval' : 'print_memo';
  res.render(view, { title: 'พิมพ์', rubric: wf.rubric(sub.doc_type), ...printData(sub), qr });
});

// พิมพ์บันทึกหลังแผนทั้งเล่ม (เฉพาะฉบับที่ส่งแล้ว)
router.get('/s/:id/print-notes', async (req, res) => {
  const plan = viewable(req, req.params.id);
  if (!plan || plan.doc_type !== 'plan') return res.status(404).render('error', { title: 'ไม่พบงานนี้', message: 'ไม่พบแผนนี้' });
  const ids = q
    .all(
      "SELECT id FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND status != 'draft' ORDER BY CAST(plan_no AS INTEGER), id",
      plan.id
    )
    .map((r) => r.id);
  const items = [];
  for (const id of ids) {
    const s = loadSub(id);
    items.push({ ...printData(s), qr: await qrSvg(req, s) });
  }
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

function applySignature(req) {
  const b = req.body || {};
  if (b.signature && validSignature(b.signature)) {
    q.run('UPDATE users SET signature = ? WHERE id = ?', b.signature, req.me.id);
    req.me.signature = b.signature;
  }
}

router.post('/s/:id/approve', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  applySignature(req);
  const b = req.body || {};
  const after = wf.approve(sub.id, req.me, { comment: str(b.comment), scores: collectScores(b) });
  const next = wf.inbox(req.me)[0];
  const msg =
    after.status === 'approved' ? 'ลงนามเรียบร้อย งานนี้ผ่านครบทุกระดับแล้ว' : `ลงนามเรียบร้อย ส่งต่อให้${wf.stepOf(after.current_role).label}แล้ว`;
  respond(req, res, next ? `/s/${next.id}` : '/inbox', 'success', next ? `${msg} ต่อไปเป็นงานถัดไปที่รอคุณ` : msg);
});

router.post('/s/:id/return', (req, res) => {
  const sub = viewable(req, req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  wf.sendBack(sub.id, req.me, { comment: str((req.body || {}).comment) });
  respond(req, res, '/inbox', 'success', 'ส่งกลับให้ครูแก้ไขเรียบร้อย');
});

// ---------- ผู้ดูแลระบบดำเนินการแทน (ไม่ส่งข้อความแจ้งใคร แต่บันทึกในประวัติ) ----------

function adminOnly(req) {
  if (!req.me.is_admin) throw new UserError('เฉพาะผู้ดูแลระบบ');
}

router.post('/s/:id/admin-advance', (req, res) => {
  adminOnly(req);
  const sub = loadSub(req.params.id);
  const st = sub && wf.stepOf(sub.current_role);
  const after = wf.overrideStep(Number(req.params.id), req.me, { comment: str((req.body || {}).comment) });
  features.audit(req.me, `ดำเนินการแทน${st ? st.label : ''} ${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code} ของ ${sub.teacher_name}`, `submission ${sub.id}`);
  respond(req, res, `/s/${sub.id}`, 'success', after.status === 'approved' ? 'ดำเนินการแทนแล้ว งานนี้ผ่านครบทุกระดับ' : `ดำเนินการแทนแล้ว ขณะนี้${wf.statusText(after)}`);
});

router.post('/s/:id/admin-finish', (req, res) => {
  adminOnly(req);
  const sub = loadSub(req.params.id);
  if (!sub) throw new UserError('ไม่พบงานนี้');
  const miss = sub.status === 'pending' ? [] : missingForSubmit(sub, req.ff);
  if (miss.length) throw new UserError(`ยังให้ผ่านไม่ได้ งานนี้ยังขาด ${miss.join(' และ ')} กดแก้ไขเพื่อเติมให้ครบก่อน`);
  wf.overrideAll(sub.id, req.me, { comment: str((req.body || {}).comment) });
  features.audit(req.me, `ให้ผ่านครบทุกระดับแทน ${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code} ของ ${sub.teacher_name}`, `submission ${sub.id}`);
  respond(req, res, `/s/${sub.id}`, 'success', 'ดำเนินการแทนแล้ว งานนี้ผ่านครบทุกระดับ ช่องลายเซ็นในเอกสารเว้นไว้ให้เซ็นด้วยมือ');
});

router.post('/inbox/approve-many', (req, res) => {
  const b = req.body || {};
  applySignature(req);
  if (!req.me.signature) throw new UserError('กรุณาบันทึกลายเซ็นในหน้าข้อมูลส่วนตัวก่อน');
  const ids = asArray(b.ids).map(Number).filter(Boolean);
  if (!ids.length) throw new UserError('ยังไม่ได้เลือกรายการ');
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    const sub = wf.getSub(id);
    if (!wf.canReview(req.me, sub) || wf.needsScore(sub)) {
      skipped += 1;
      continue;
    }
    wf.approve(id, req.me, { comment: str(b.comment) });
    done += 1;
  }
  const extra = skipped ? ` ข้าม ${skipped} รายการที่ต้องให้คะแนนก่อน หรือไม่ได้รอคุณแล้ว` : '';
  respond(req, res, '/inbox', 'success', `ลงนามเรียบร้อย ${done} รายการ${extra}`);
});

module.exports = router;
module.exports.submitWindow = submitWindow;
module.exports.gradeFull = gradeFull;
module.exports.deptFull = deptFull;
module.exports.printData = printData;
module.exports.subjectChoices = subjectChoices;
