// รายวิชาที่สอนในภาคนี้: ครูเลือกวิชาที่สอนทุกวิชา (ส่งคู่มือทุกวิชา) และวิชาหลักที่ต้องส่งแผน
// ผู้ดูแลระบบแก้แทนครูได้ ทุกครั้งบันทึกในประวัติ
const express = require('express');
const { q } = require('../db');
const auth = require('../auth');
const features = require('../features');
const teaching = require('../teaching');
const { currentTerm, cell } = require('./pages');

const router = express.Router();
router.use(auth.requireLogin);

class UserError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

function needOn(req, res, next) {
  if (req.ff.teachlist) return next();
  res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดฟังก์ชันนี้ไว้' });
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

// ครูที่กำลังแก้รายการ: ตัวเอง หรือครูที่ผู้ดูแลระบบเลือก
function target(req) {
  const id = Number((req.body && req.body.u) || req.query.u) || req.me.id;
  if (id === req.me.id) return req.me;
  if (!req.me.is_admin) throw new UserError('แก้ได้เฉพาะรายวิชาของตัวเอง');
  const u = q.get('SELECT * FROM users WHERE id = ? AND is_active = 1', id);
  if (!u) throw new UserError('ไม่พบครูคนนี้');
  return u;
}

function done(req, res, u, text, action) {
  if (u.id !== req.me.id) features.audit(req.me, `${action} แทน ${u.full_name}`, `user ${u.id}`);
  req.flash('success', text);
  res.redirect(u.id === req.me.id ? '/teaching' : `/teaching?u=${u.id}`);
}

function worksOf(u, t) {
  return q.all(
    "SELECT * FROM submissions WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND doc_type IN ('manual', 'plan')",
    u.id,
    t.year,
    t.semester
  );
}

function rowOf(req, u, t) {
  const r = q.get('SELECT * FROM teach_subjects WHERE id = ? AND teacher_id = ? AND academic_year = ? AND semester = ?', Number(req.params.id), u.id, t.year, t.semester);
  if (!r) throw new UserError('ไม่พบรายวิชานี้');
  return r;
}

// วิชาหลักที่มีแผนแล้ว เปลี่ยนไม่ได้ ถ้าครบจำนวนแล้วตั้งวิชาหลักเพิ่มไม่ได้
function checkMainRoom(u, t, code) {
  const withPlan = new Set(teaching.plansOf(u.id, t.year, t.semester).map((p) => p.subject_code));
  const locked = q
    .all('SELECT subject_code FROM teach_subjects WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND is_main = 1', u.id, t.year, t.semester)
    .filter((m) => m.subject_code !== code && withPlan.has(m.subject_code));
  const quota = teaching.planQuota(u);
  if (locked.length >= quota) {
    throw new UserError(`วิชาหลักครบ ${quota} วิชาแล้ว และส่งแผนวิชา ${locked.map((m) => m.subject_code).join(' ')} ไปแล้ว ถ้าต้องการเปลี่ยนวิชาหลักให้แจ้งผู้ดูแลระบบ`);
  }
}

router.get('/teaching', needOn, (req, res) => {
  const u = target(req);
  const t = currentTerm(req.settings);
  const works = worksOf(u, t);
  const rows = teaching.list(u.id, t.year, t.semester).map((r) => {
    const manual = works.find((w) => w.doc_type === 'manual' && w.subject_code === r.subject_code) || null;
    const plan = works.find((w) => w.doc_type === 'plan' && w.subject_code === r.subject_code) || null;
    return { ...r, manual, plan, manualCell: cell(manual), planCell: cell(plan), needPlan: !req.ff.onemain || Boolean(r.is_main || plan) };
  });
  res.render('teaching', {
    title: 'รายวิชาที่สอน',
    who: u,
    forOther: u.id !== req.me.id,
    rows,
    term: t,
    quota: teaching.planQuota(u),
    // วิชาหลักที่ส่งแผนแล้วครบจำนวน เปลี่ยนวิชาหลักเองไม่ได้
    canSetMain: rows.filter((r) => r.is_main && r.plan).length < teaching.planQuota(u),
    subjects: q.all('SELECT * FROM subjects ORDER BY code'),
  });
});

router.post('/teaching/add', needOn, (req, res) => {
  const u = target(req);
  const t = currentTerm(req.settings);
  const b = req.body || {};
  const code = str(b.subject_code, 30);
  const name = str(b.subject_name, 200);
  const grade = str(b.grade_level, 30);
  if (!code || !name) throw new UserError('กรุณากรอกรหัสวิชาและชื่อวิชา');
  if (teaching.skipActivity(code)) throw new UserError('วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ จึงไม่ต้องเพิ่มในรายวิชาที่สอน');
  const main = Boolean(req.ff.onemain && b.is_main);
  if (main) checkMainRoom(u, t, code);
  q.tx(() => teaching.ensure(u, t.year, t.semester, { code, name, grade }, main));
  done(req, res, u, `เพิ่มวิชา ${code} ${name} แล้ว${main ? ' เป็นวิชาหลัก' : ''}`, `เพิ่มรายวิชาที่สอน ${code}`);
});

router.post('/teaching/:id/main', needOn, (req, res) => {
  const u = target(req);
  const t = currentTerm(req.settings);
  const r = rowOf(req, u, t);
  checkMainRoom(u, t, r.subject_code);
  q.tx(() => {
    q.run('UPDATE teach_subjects SET is_main = 1 WHERE id = ?', r.id);
    teaching.trimMains(u.id, t.year, t.semester, teaching.planQuota(u), r.subject_code);
  });
  done(req, res, u, `ตั้ง ${r.subject_code} เป็นวิชาหลักแล้ว ส่งแผนการจัดการเรียนรู้วิชานี้`, `ตั้งวิชาหลัก ${r.subject_code}`);
});

router.post('/teaching/:id/unmain', needOn, (req, res) => {
  const u = target(req);
  const t = currentTerm(req.settings);
  const r = rowOf(req, u, t);
  if (worksOf(u, t).some((w) => w.doc_type === 'plan' && w.subject_code === r.subject_code)) {
    throw new UserError('วิชานี้มีแผนการจัดการเรียนรู้แล้ว ยกเลิกวิชาหลักไม่ได้');
  }
  q.run('UPDATE teach_subjects SET is_main = 0 WHERE id = ?', r.id);
  done(req, res, u, `ยกเลิกวิชาหลัก ${r.subject_code} แล้ว`, `ยกเลิกวิชาหลัก ${r.subject_code}`);
});

router.post('/teaching/:id/delete', needOn, (req, res) => {
  const u = target(req);
  const t = currentTerm(req.settings);
  const r = rowOf(req, u, t);
  if (worksOf(u, t).some((w) => w.subject_code === r.subject_code)) {
    throw new UserError(`วิชา ${r.subject_code} มีงานในระบบแล้ว เอาออกไม่ได้`);
  }
  q.run('DELETE FROM teach_subjects WHERE id = ?', r.id);
  done(req, res, u, `เอาวิชา ${r.subject_code} ออกจากรายการแล้ว`, `เอารายวิชาที่สอน ${r.subject_code} ออก`);
});

module.exports = router;
