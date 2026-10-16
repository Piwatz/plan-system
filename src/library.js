// คลังงานการจัดการเรียนรู้ (ฟังก์ชันเสริม library): งานที่ผ่านครบทุกระดับ จัดเป็นชั้น 1 ชั้นต่อ 1 ชนิดงาน
// ทุกมุมมอง (ชั้นวาง รายการ ตามกลุ่มสาระ) ใช้คำสั่งชุดเดียวกันนี้ ต่างกันแค่หน้าตาใน views/library.ejs
// ปกเป็นรูป JPEG เล็กใน Drive (submissions.cover_ref) เบราว์เซอร์ของครูทำให้ตอนส่งงาน ไม่มีรูปใช้ปกที่ระบบวาดจากชื่อวิชาและชื่อครู
const crypto = require('crypto');
const { q } = require('./db');
const wf = require('./workflow');
const { DRAWN } = require('./upload');

// โหลดทีละหน้า หน้าละ 24 เล่ม
const PAGE = 24;
// รูปปกเล็กใหญ่ได้ไม่เกิน 300 KB (ปกติ 20 ถึง 40 KB)
const COVER_MAX = 300 * 1024;

// คอลัมน์ที่ทุกชั้นต้องคืน (ชนิดเดียวกัน ใช้ UNION ALL ในแถบเล่มใหม่ได้)
// id = งานที่เปิด (บันทึกหลังแผนเป็นรหัสแผนของเล่ม) · kind = ชั้น · sheets = จำนวนแผ่น (บันทึกหลังแผน) · done_at = วันที่ผ่านครบ
function workSql(docType, where) {
  return {
    sql: `SELECT s.id, s.doc_type AS kind, s.academic_year, s.semester, s.subject_code, s.subject_name, s.grade_level, s.teacher_id, s.department_id,
         u.full_name AS teacher_name, d.name AS dept_name, d.sort AS dept_sort, s.cover_ref,
         (SELECT f.id FROM files f WHERE f.submission_id = s.id AND f.is_current = 1 ORDER BY (f.mime = 'application/pdf') DESC, f.id LIMIT 1) AS file_id,
         0 AS sheets, s.completed_at AS done_at
       FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
       WHERE s.doc_type = ? AND s.status = 'approved'${where.sql('s')}`,
    params: [docType, ...where.params],
  };
}

// บันทึกหลังแผน 1 เล่ม = บันทึกทุกฉบับของแผน 1 วิชา เข้าคลังเมื่อทุกฉบับที่ส่งแล้วผ่านครบ (ฉบับร่างไม่นับ)
function noteSql(where) {
  return {
    sql: `SELECT p.id, 'note' AS kind, p.academic_year, p.semester, p.subject_code, p.subject_name, p.grade_level, p.teacher_id, p.department_id,
         u.full_name AS teacher_name, d.name AS dept_name, d.sort AS dept_sort, NULL::text AS cover_ref, NULL::integer AS file_id,
         COUNT(n.id)::int AS sheets, MAX(n.completed_at) AS done_at
       FROM submissions p
       JOIN submissions n ON n.parent_id = p.id AND n.doc_type = 'note' AND n.status != 'draft'
       JOIN users u ON u.id = p.teacher_id LEFT JOIN departments d ON d.id = p.department_id
       WHERE p.doc_type = 'plan'${where.sql('p')}
       GROUP BY p.id, u.full_name, d.name, d.sort
       HAVING SUM(CASE WHEN n.status = 'approved' THEN 0 ELSE 1 END) = 0`,
    params: where.params,
  };
}

// ชั้นในคลัง เพิ่มชั้นใหม่ภายหลัง (เช่น เล่มวิจัย เล่มนวัตกรรม) = เพิ่มรายการที่นี่ พร้อมคำสั่งที่คืนคอลัมน์ชุดเดียวกัน
const SHELVES = [
  { key: 'plan', label: 'แผนการจัดการเรียนรู้', short: 'แผน', query: (w) => workSql('plan', w) },
  { key: 'manual', label: 'คู่มือรายวิชา', short: 'คู่มือ', query: (w) => workSql('manual', w) },
  { key: 'note', label: 'บันทึกหลังแผน', short: 'บันทึกหลังแผน', query: noteSql },
];
const SHELF = Object.fromEntries(SHELVES.map((s) => [s.key, s]));

// เงื่อนไขภาคเรียนและกลุ่มสาระ ใส่ต่อท้าย WHERE ของแต่ละชั้น
function filters({ term, department } = {}) {
  const parts = [];
  const params = [];
  if (term) {
    parts.push((a) => `${a}.academic_year = ? AND ${a}.semester = ?`);
    params.push(term.year, term.semester);
  }
  if (department) {
    parts.push((a) => `${a}.department_id = ?`);
    params.push(department);
  }
  return { sql: (a) => parts.map((p) => ` AND ${p(a)}`).join(''), params };
}

// หน้าหนึ่งของชั้น เรียงตามกลุ่มสาระ รหัสวิชา ชื่อครู · total = จำนวนเล่มทั้งหมดตามเงื่อนไข
async function page(shelfKey, { term, department, offset = 0 } = {}) {
  const shelf = SHELF[shelfKey] || SHELVES[0];
  const { sql, params } = shelf.query(filters({ term, department }));
  const rows = await q.all(
    `SELECT x.*, (count(*) OVER ())::int AS total FROM (${sql}) x
     ORDER BY x.dept_sort NULLS FIRST, x.subject_code, x.teacher_name, x.id LIMIT ? OFFSET ?`,
    ...params,
    PAGE,
    Math.max(0, offset)
  );
  // จำนวนเล่มของแต่ละกลุ่มสาระ (หัวแถวในมุมมองตามกลุ่มสาระ ดูทั้งหมด N เล่ม)
  const byDept = {};
  if (rows.length) {
    for (const r of await q.all(`SELECT x.department_id, COUNT(*)::int AS n FROM (${sql}) x GROUP BY x.department_id`, ...params)) byDept[r.department_id || ''] = r.n;
  }
  return { shelf, rows, total: rows.length ? rows[0].total : 0, byDept };
}

// เล่มใหม่ล่าสุดทุกชั้นทุกภาคเรียน (แถบในหน้าแรก)
async function recent(n = 6) {
  const parts = SHELVES.map((s) => s.query(filters()));
  return q.all(
    `SELECT * FROM (${parts.map((p) => p.sql).join(' UNION ALL ')}) x ORDER BY x.done_at DESC NULLS LAST, x.id DESC LIMIT ?`,
    ...parts.flatMap((p) => p.params),
    n
  );
}

// เปิดอ่านได้ไหม: สวิตช์ libread เปิด = ทุกเล่ม · ปิด = งานของตัวเอง ผู้ดูแลระบบ และผู้ตรวจตามสิทธิ์เดิม (ทั้งโรงเรียน หรือกลุ่มสาระตนเอง)
function canOpen(me, row, ff) {
  if (ff.libread || me.is_admin || me.id === row.teacher_id) return true;
  return (me.roles || []).some((r) => {
    const st = wf.stepOf(r);
    return st && (st.scope === 'school' || (st.scope === 'department' && me.department_id === row.department_id));
  });
}

// ที่อยู่ตอนกดเปิดอ่าน: แผนและคู่มือเปิดไฟล์ในเว็บ · บันทึกหลังแผนเปิดหน้าพิมพ์ทั้งเล่ม
function openHref(row) {
  if (row.kind === 'note') return `/s/${row.id}/print-notes`;
  return row.file_id ? `/f/${row.file_id}/view` : `/s/${row.id}`;
}

// ที่อยู่รูปปก ?v= เปลี่ยนเมื่อรูปเปลี่ยน เบราว์เซอร์จึงจำรูปได้นาน · ไม่มีรูปได้ null (ใช้ปกที่ระบบวาด)
function coverUrl(row) {
  if (!row.cover_ref || row.cover_ref === DRAWN) return null;
  return `/library/cover/${row.id}?v=${crypto.createHash('md5').update(String(row.cover_ref)).digest('hex').slice(0, 8)}`;
}

// ปุ่มเปลี่ยนปกของผู้ดูแลระบบ (ฟังก์ชันเสริม coverswap) เฉพาะแผนและคู่มือ
// ปกตอนนี้: 'img' รูปจากไฟล์ (ปุ่มบนปก ใช้ปกระบบ) · 'drawn' ผู้ดูแลเลือกปกระบบไว้ · 'none' ยังไม่มีรูป (สองแบบหลังปุ่มบนปก ใช้รูปจากไฟล์)
function swapOf(row, me, ff) {
  if (!me.is_admin || !ff.library || !ff.coverswap || row.kind === 'note') return null;
  return row.cover_ref === DRAWN ? 'drawn' : row.cover_ref ? 'img' : 'none';
}

// ข้อมูลสำหรับหน้าเว็บ
function decorate(rows, me, ff) {
  return rows.map((r) => ({ ...r, open: canOpen(me, r, ff), href: openHref(r), cover: coverUrl(r), swap: swapOf(r, me, ff), mine: me.id === r.teacher_id, shelfLabel: (SHELF[r.kind] || {}).label || '' }));
}

// เปิดอ่านงานคนอื่นจากคลังได้ไหม (สวิตช์ libread) ใช้กับไฟล์งานและหน้าพิมพ์บันทึกหลังแผนทั้งเล่ม
// แผนและคู่มือต้องผ่านครบ · บันทึกหลังแผน (หรือแผนที่เปิดทั้งเล่ม) ต้องอยู่ในเล่มที่ผ่านครบทั้งเล่ม
async function readable(ff, sub, { book = false } = {}) {
  if (!ff.library || !ff.libread || !sub) return false;
  if (!book && (sub.doc_type === 'plan' || sub.doc_type === 'manual')) return sub.status === 'approved';
  const planId = book ? sub.id : sub.doc_type === 'note' ? sub.parent_id : null;
  if (!planId || (!book && sub.status !== 'approved')) return false;
  const r = await q.get(
    "SELECT COUNT(*)::int AS n, SUM(CASE WHEN status = 'approved' THEN 0 ELSE 1 END)::int AS bad FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND status != 'draft'",
    planId
  );
  return r.n > 0 && !r.bad;
}

module.exports = { DRAWN, PAGE, COVER_MAX, SHELVES, SHELF, page, recent, canOpen, openHref, coverUrl, decorate, readable };
