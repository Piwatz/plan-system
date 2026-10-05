// คิดชื่อโฟลเดอร์และชื่อไฟล์สำหรับเก็บแผนและคู่มือใน Google Drive ของโรงเรียน แยกโฟลเดอร์ ภาคเรียน/กลุ่มสาระ/ชื่อครู/ชนิดงาน
// ย้ายมาจาก src/drive.js เดิม (ตัดออกในตอน 2 ของแผนย้ายขึ้นคลาวด์) ไม่แก้ตรรกะ จะใช้ต่อในตอน 10
const path = require('path');
const wf = require('./workflow');

// ชื่อไฟล์และโฟลเดอร์ห้ามมีตัวอักษรที่ Windows และ Mac ไม่รับ
function safeName(s, fallback) {
  const t = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (t || fallback).slice(0, 80).trim();
}

// ตำแหน่งไฟล์ในโฟลเดอร์ Drive เช่น ภาคเรียน 2-2569/วิทยาศาสตร์และเทคโนโลยี/นายสมชาย ใจดี/แผนการจัดการเรียนรู้/ว31101 ฟิสิกส์ 1.pdf
// sub ต้องมี teacher_name และ dept_name (JOIN users และ departments)
function relPath(sub, file, idx, count) {
  const label = wf.DOC_TYPES[sub.doc_type].label;
  const ext = path.extname(file.original_name || '').toLowerCase() || '.pdf';
  const base = safeName(`${sub.subject_code || ''} ${sub.subject_name || ''}`, label) + (count > 1 ? ` (${idx + 1})` : '');
  return [`ภาคเรียน ${sub.semester}-${sub.academic_year}`, safeName(sub.dept_name, 'ไม่ระบุกลุ่มสาระ'), safeName(sub.teacher_name, 'ไม่ระบุชื่อ'), label, base + ext].join('/');
}

module.exports = { safeName, relPath };
