// นำเข้ารายวิชาที่ครูสอนจากโปรแกรมจัดตารางสอน (เฉพาะผู้ดูแลระบบ)
// ขั้นที่ 1 อัปโหลดไฟล์ งานล่าสุด.json  ขั้นที่ 2 ตรวจการจับคู่ชื่อครูและติ๊กวิชา  ขั้นที่ 3 กดนำเข้า
// ไม่ลบรายวิชาเดิมของครู ไม่ตั้งวิชาหลักให้ (ครูเลือกเอง) และไม่เก็บไฟล์ที่อัปโหลดไว้
const express = require('express');
const multer = require('multer');
const { q } = require('../db');
const auth = require('../auth');
const features = require('../features');
const teaching = require('../teaching');
const timetable = require('../timetable');
const { fixName } = require('../upload');

const router = express.Router();
router.use(auth.requireLogin, auth.requireAdmin);

function needOn(req, res, next) {
  if (req.ff.ttimport) return next();
  res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดฟังก์ชันนี้ไว้' });
}

const parseUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single('ttfile');
// callback แบบเก่า Express 5 ไม่จับ error ให้ ต้องห่อ try/catch แล้วส่งต่อเอง
function upload(req, res, next) {
  parseUpload(req, res, (err) => {
    try {
      if (err) err.userMessage = 'อ่านไฟล์ไม่ได้ หรือไฟล์ใหญ่เกิน 10 MB';
      next(err);
    } catch (e) {
      next(e);
    }
  });
}

function teachersList() {
  return q.all(
    `SELECT u.id, u.full_name, d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 AND u.is_teacher = 1 ORDER BY u.full_name`
  );
}

router.get('/teach-import', needOn, (req, res) => {
  res.render('admin/ttimport', { title: 'นำเข้ารายวิชาจากตารางสอน', data: null });
});

router.post('/teach-import/preview', needOn, upload, async (req, res) => {
  if (!req.file) {
    req.flash('error', 'ยังไม่ได้เลือกไฟล์');
    return res.redirect('/admin/teach-import');
  }
  const data = timetable.parse(req.file.buffer);
  // ไม่นำเข้าวิชากิจกรรมพัฒนาผู้เรียน (เปิดปิดได้)
  let activities = 0;
  if (req.ff.noactivity) {
    for (const t of data.teachers) {
      const keep = t.subjects.filter((s) => !teaching.isActivity(s.code));
      activities += t.subjects.length - keep.length;
      t.subjects = keep;
    }
    data.teachers = data.teachers.filter((t) => t.subjects.length);
  }
  const users = await teachersList();
  const rows = timetable.match(data.teachers, users);
  // คนที่ยังจับคู่ไม่ได้ขึ้นก่อน ผู้ดูแลจะได้เห็นทันที
  rows.sort((a, b) => Number(Boolean(a.userId)) - Number(Boolean(b.userId)) || a.name.localeCompare(b.name));
  res.render('admin/ttimport', {
    title: 'นำเข้ารายวิชาจากตารางสอน',
    data: { ...data, rows, activities, fileName: fixName(req.file.originalname) },
    users,
    year: data.year || Number(req.settings.academic_year),
    semester: data.semester || Number(req.settings.semester),
  });
});

router.post('/teach-import', needOn, async (req, res) => {
  const b = req.body || {};
  const year = parseInt(b.year, 10);
  const sem = parseInt(b.semester, 10);
  if (!(year > 2500 && year < 2700) || ![1, 2, 3].includes(sem)) throw new timetable.TimetableError('ปีการศึกษาหรือภาคเรียนไม่ถูกต้อง');
  const n = Math.min(500, parseInt(b.n, 10) || 0);
  const active = new Map((await teachersList()).map((u) => [u.id, u]));
  let people = 0;
  let added = 0;
  let had = 0;
  // อ่านแบบฟอร์มก่อน แล้วถามและเขียนฐานรวดเดียว (เดิมราว 4 คำสั่งต่อวิชา) จำนวนคำสั่งคงที่ไม่ว่ากี่คนกี่วิชา
  const picks = [];
  for (let i = 0; i < n; i++) {
    const u = active.get(Number(b[`map_${i}`]));
    if (!u) continue;
    let subjects;
    try {
      subjects = JSON.parse(b[`subj_${i}`] || '[]');
    } catch {
      subjects = [];
    }
    const picked = new Set([].concat(b[`pick_${i}`] || []).map(String));
    for (const s of Array.isArray(subjects) ? subjects : []) {
      const code = String(s.code || '').trim().slice(0, 30);
      if (!code || !picked.has(code) || teaching.skipActivity(code)) continue;
      picks.push({ teacher_id: u.id, code, s });
    }
  }
  await q.tx(async () => {
    const touched = new Set();
    const ids = [...new Set(picks.map((p) => p.teacher_id))];
    const deptOf = new Map();
    const exists = new Set();
    if (ids.length) {
      for (const r of await q.all('SELECT id, department_id FROM users WHERE id = ANY(?)', ids)) deptOf.set(r.id, r.department_id);
      for (const r of await q.all('SELECT teacher_id, subject_code FROM teach_subjects WHERE teacher_id = ANY(?) AND academic_year = ? AND semester = ?', ids, year, sem)) {
        exists.add(`${r.teacher_id}\t${r.subject_code}`);
      }
    }
    // ครูกับวิชาเดียวกันซ้ำในไฟล์ รวมเป็นแถวเดียว ชื่อและชั้นใช้ค่าล่าสุดที่ไม่ว่าง เหมือนเพิ่มทีละรายการ
    const rows = new Map();
    const schoolSubjects = [];
    for (const { teacher_id: tid, code, s } of picks) {
      const key = `${tid}\t${code}`;
      const name = String(s.name || '').slice(0, 200);
      const grade = String(s.grade || '').slice(0, 30);
      const row = rows.get(key);
      if (row) {
        if (name) row.name = name;
        if (grade) row.grade = grade;
      } else rows.set(key, { teacher_id: tid, code, name, grade });
      // รายวิชาของโรงเรียน ช่วยให้พิมพ์รหัสแล้วชื่อขึ้นเอง
      schoolSubjects.push({ code, name: String(s.name || code).slice(0, 200), dept: deptOf.get(tid) ?? null, grade });
      if (exists.has(key)) had += 1;
      else added += 1;
      exists.add(key);
      touched.add(tid);
    }
    await teaching.ensureMany([...rows.values()], year, sem);
    if (schoolSubjects.length) {
      await q.run(
        `INSERT INTO subjects (code, name, department_id, grade)
         SELECT v.code, v.name, v.dept, v.grade FROM unnest(?::text[], ?::text[], ?::int[], ?::text[]) WITH ORDINALITY AS v(code, name, dept, grade, n)
         ORDER BY v.n
         ON CONFLICT DO NOTHING`,
        schoolSubjects.map((x) => x.code),
        schoolSubjects.map((x) => x.name),
        schoolSubjects.map((x) => x.dept),
        schoolSubjects.map((x) => x.grade)
      );
    }
    people = touched.size;
    await features.audit(req.me, `นำเข้ารายวิชาที่สอนจากตารางสอน ภาคเรียน ${sem}/${year}`, `ครู ${people} คน เพิ่มใหม่ ${added} วิชา มีอยู่แล้ว ${had} วิชา`);
  });
  req.flash('success', `นำเข้าเรียบร้อย ครู ${people} คน เพิ่มรายวิชาใหม่ ${added} รายการ${had ? ` (มีอยู่แล้ว ${had} รายการ ไม่ซ้ำ)` : ''} ครูเห็นในหน้ารายวิชาที่สอนแล้ว`);
  res.redirect('/admin/teach-import');
});

module.exports = router;
