// คลังงานการจัดการเรียนรู้ (ฟังก์ชันเสริม library): งานที่ผ่านครบทุกระดับ จัดเป็นชั้น 1 ชั้นต่อ 1 ชนิดงาน
// ทุกมุมมอง (ชั้นวาง รายการ ตามกลุ่มสาระ) ใช้คำสั่งชุดเดียวกันนี้ ต่างกันแค่หน้าตาใน views/library.ejs
// ปกเป็นรูป JPEG เล็กใน Drive (submissions.cover_ref) เบราว์เซอร์ของครูทำให้ตอนส่งงาน ไม่มีรูปใช้ปกที่ระบบวาดจากชื่อวิชาและชื่อครู
const crypto = require('crypto');
const { q } = require('./db');
const wf = require('./workflow');
const { DRAWN } = require('./upload');
const readperm = require('./readperm');

// โหลดทีละหน้า หน้าละ 24 เล่ม
const PAGE = 24;
// รูปปกเล็กใหญ่ได้ไม่เกิน 300 KB (ปกติ 20 ถึง 40 KB)
const COVER_MAX = 300 * 1024;

// คอลัมน์ที่ทุกชั้นต้องคืน (ชนิดเดียวกัน ใช้ UNION ALL ในแถบเล่มใหม่ได้)
// id = งานที่เปิด (บันทึกหลังแผนเป็นรหัสแผนของเล่ม) · kind = ชั้น · sheets = จำนวนแผ่น (บันทึกหลังแผน) · done_at = วันที่ผ่านครบ (ยังไม่ผ่านใช้วันที่ส่ง)
// pdf_id = PDF หลักไฟล์แรก (ไฟล์ที่ต่อปก) · pdf_front = ผลตรวจหน้าแรก drawn คือต่อปกที่ระบบวาดไว้แล้ว (ฟังก์ชันเสริม libcoverpdf)
// st = approved ผ่านครบ · pending รอลงนาม · returned ส่งกลับแก้ไข (งานร่างไม่มาถึงที่นี่) ใครเห็นเล่มไหนตัดสินใน visibleSql (ฟังก์ชันเสริม libshow)
function workSql(docType, where) {
  return {
    sql: `SELECT s.id, s.doc_type AS kind, s.academic_year, s.semester, s.subject_code, s.subject_name, s.grade_level, s.teacher_id, s.department_id,
         u.full_name AS teacher_name, d.name AS dept_name, d.sort AS dept_sort, s.cover_ref,
         (SELECT f.id FROM files f WHERE f.submission_id = s.id AND f.is_current = 1 ORDER BY (f.mime = 'application/pdf') DESC, f.id LIMIT 1) AS file_id,
         pf.id AS pdf_id, pf.front_check AS pdf_front,
         0 AS sheets, 0 AS sheets_done, COALESCE(s.completed_at, s.submitted_at) AS done_at, s.status AS st, s.current_role
       FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
         LEFT JOIN files pf ON pf.id = (SELECT MIN(x.id) FROM files x WHERE x.submission_id = s.id AND x.kind = 'main' AND x.is_current = 1 AND x.mime = 'application/pdf')
       WHERE s.doc_type = ? AND s.status != 'draft'${where.sql('s')}`,
    params: [docType, ...where.params],
  };
}

// บันทึกหลังแผน 1 เล่ม = บันทึกทุกฉบับของแผน 1 วิชา ผ่านครบเมื่อทุกฉบับที่ส่งแล้วผ่านครบ (ฉบับร่างไม่นับ) · มีฉบับถูกส่งกลับ = returned
function noteSql(where) {
  return {
    sql: `SELECT p.id, 'note' AS kind, p.academic_year, p.semester, p.subject_code, p.subject_name, p.grade_level, p.teacher_id, p.department_id,
         u.full_name AS teacher_name, d.name AS dept_name, d.sort AS dept_sort, NULL::text AS cover_ref, NULL::integer AS file_id, NULL::integer AS pdf_id, NULL::text AS pdf_front,
         COUNT(n.id)::int AS sheets, SUM(CASE WHEN n.status = 'approved' THEN 1 ELSE 0 END)::int AS sheets_done,
         COALESCE(MAX(n.completed_at), MAX(n.submitted_at)) AS done_at,
         CASE WHEN SUM(CASE WHEN n.status = 'approved' THEN 0 ELSE 1 END) = 0 THEN 'approved'
              WHEN SUM(CASE WHEN n.status = 'returned' THEN 1 ELSE 0 END) > 0 THEN 'returned' ELSE 'pending' END AS st,
         NULL::text AS current_role
       FROM submissions p
       JOIN submissions n ON n.parent_id = p.id AND n.doc_type = 'note' AND n.status != 'draft'
       JOIN users u ON u.id = p.teacher_id LEFT JOIN departments d ON d.id = p.department_id
       WHERE p.doc_type = 'plan'${where.sql('p')}
       GROUP BY p.id, u.full_name, d.name, d.sort`,
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

// เงื่อนไขภาคเรียน กลุ่มสาระ และเล่มเดียว (id) ใส่ต่อท้าย WHERE ของแต่ละชั้น
function filters({ term, department, id } = {}) {
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
  if (id) {
    parts.push((a) => `${a}.id = ?`);
    params.push(id);
  }
  return { sql: (a) => parts.map((p) => ` AND ${p(a)}`).join(''), params };
}

// ---------- งานที่แสดงในคลัง (ฟังก์ชันเสริม libshow) 3 ชั้น ชั้นที่ละเอียดกว่าชนะ ----------
// 1 ค่าหลัก lib_show: approved เฉพาะผ่านครบ (แบบเดิม) · sent ส่งแล้วทุกงานที่ยังไม่ถูกส่งกลับ
// 2 รายครู lib_show_teachers {รหัสครู: show|hide} show = ทุกงานที่ส่งแล้วที่ยังไม่ถูกส่งกลับ
// 3 รายเล่ม lib_show_books {ชั้น:รหัส: show|hide} เช่น plan:12 note:12 (เล่มบันทึกหลังแผนใช้รหัสแผน)
// ปิดฟังก์ชัน = เฉพาะผ่านครบ ไม่สนรายครูและรายเล่ม
const SHOW_MODES = [
  { key: 'approved', label: 'เฉพาะงานที่ผ่านครบ', desc: 'แบบเดิม ผู้ตรวจลงนามครบทุกระดับแล้วจึงขึ้นคลัง' },
  { key: 'sent', label: 'งานที่ส่งแล้วทุกงาน แม้ยังลงนามไม่ครบ', desc: 'มีป้ายบอกว่ารอลงนามถึงไหน งานที่ถูกส่งกลับแก้ไม่แสดง' },
];

function jsonMap(v) {
  try {
    const o = JSON.parse(v || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function showRule(settings) {
  const features = require('./features');
  if (!features.isOn(settings, 'libshow')) return { mode: 'approved', teachers: {}, books: {} };
  const keep = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v === 'show' || v === 'hide'));
  return { mode: settings.lib_show === 'sent' ? 'sent' : 'approved', teachers: keep(jsonMap(settings.lib_show_teachers)), books: keep(jsonMap(settings.lib_show_books)) };
}

// ห่อคำสั่งของชั้น: base = เห็นตามค่าหลักและรายครู · shown = หลังยกเว้นรายเล่ม · all = ผู้ดูแลขอดูเล่มที่ซ่อนอยู่ด้วย
function visibleSql({ sql, params }, rule, all = false) {
  const ids = (want) => Object.keys(rule.teachers).filter((k) => rule.teachers[k] === want).map(Number).filter(Number.isInteger);
  const keys = (want) => Object.keys(rule.books).filter((k) => rule.books[k] === want);
  return {
    sql: `SELECT z.* FROM (
        SELECT y.*, CASE WHEN y.bkey = ANY(?::text[]) THEN true WHEN y.bkey = ANY(?::text[]) THEN false ELSE y.base END AS shown
        FROM (SELECT x.*, x.kind || ':' || x.id AS bkey,
                CASE WHEN x.teacher_id = ANY(?::int[]) THEN x.st IN ('approved', 'pending')
                     WHEN x.teacher_id = ANY(?::int[]) THEN false
                     ELSE x.st = 'approved' OR (?::boolean AND x.st = 'pending') END AS base
              FROM (${sql}) x) y) z
      WHERE z.shown OR ?::boolean`,
    params: [keys('show'), keys('hide'), ids('show'), ids('hide'), rule.mode === 'sent', ...params, Boolean(all)],
  };
}

// สถานะของเล่มเดียว (ปุ่มซ่อนหรือแสดงเล่มนี้) null = ไม่มีเล่มนี้
async function bookState(kind, id, rule) {
  const shelf = SHELF[kind];
  if (!shelf || !id) return null;
  const v = visibleSql(shelf.query(filters({ id })), rule, true);
  return q.get(`SELECT v.bkey, v.base, v.shown, v.subject_code, v.teacher_name FROM (${v.sql}) v`, ...v.params);
}

// หน้าหนึ่งของชั้น เรียงตามกลุ่มสาระ รหัสวิชา ชื่อครู · total = จำนวนเล่มทั้งหมดตามเงื่อนไข
// rule = showRule(settings) · all = ผู้ดูแลระบบเห็นเล่มที่ซ่อนอยู่ด้วย (shown = false)
async function page(shelfKey, { term, department, offset = 0, rule = showRule({}), all = false } = {}) {
  const shelf = SHELF[shelfKey] || SHELVES[0];
  const { sql, params } = visibleSql(shelf.query(filters({ term, department })), rule, all);
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

// เล่มใหม่ล่าสุดทุกชั้นทุกภาคเรียน (แถบในหน้าแรก) เฉพาะเล่มที่แสดงในคลัง
async function recent(n = 6, rule = showRule({})) {
  const parts = SHELVES.map((s) => visibleSql(s.query(filters()), rule));
  return q.all(
    `SELECT * FROM (${parts.map((p) => p.sql).join(' UNION ALL ')}) x ORDER BY x.done_at DESC NULLS LAST, x.id DESC LIMIT ?`,
    ...parts.flatMap((p) => p.params),
    n
  );
}

// เปิดอ่านได้ไหม: งานของตัวเอง ผู้ดูแลระบบ และผู้ตรวจตามสิทธิ์เดิม (ทั้งโรงเรียน หรือกลุ่มสาระตนเอง) · คนอื่นตามหน้าสิทธิ์อ่านงาน (readperm) ถ้าปิดใช้สวิตช์ libread
// งานที่ยังไม่ผ่านครบ สวิตช์ libread ไม่ทำให้คนอื่นเปิดได้ (ใช้สิทธิ์ผู้ตรวจเดิม)
function canOpen(me, row, ff) {
  if (me.is_admin || me.id === row.teacher_id) return true;
  const a = readperm.access(me, ff);
  if (readperm.reaches(me, a, row.department_id) && (!row.st || readperm.statusOk(a, row.st))) return true;
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

// ต่อปกที่ระบบวาดลงในไฟล์ทีละหลายเล่ม (ฟังก์ชันเสริม libcoverpdf) อยู่ในโหมดเลือกหลายเล่มของ coverswap ใช้กติกาเดียวกับปุ่มเปลี่ยนปกในหน้างาน (coverpdf)
// ok ต่อได้ · done ต่อปกระบบไว้แล้ว · nopdf ไม่มีไฟล์ PDF · own งานของตัวเองที่ผ่านครบแล้ว (ผู้ดูแลระบบดำเนินการแทนในงานของตัวเองไม่ได้)
function pdfCoverOf(row, me, ff) {
  if (!swapOf(row, me, ff) || !ff.coverpdf || !ff.libcoverpdf) return null;
  if (!row.pdf_id) return 'nopdf';
  if (me.id === row.teacher_id && row.st === 'approved') return 'own';
  return row.pdf_front === 'drawn' ? 'done' : 'ok';
}

// ระดับชั้นบนปกที่ระบบวาด ม.5 เป็น ชั้นมัธยมศึกษาปีที่ 5 · ป.3 เป็น ชั้นประถมศึกษาปีที่ 3 · แบบอื่น (เช่น ม.4/1) ใส่ ชั้น นำหน้าตามที่กรอก
function gradeText(g) {
  const v = String(g || '').trim();
  if (!v) return '';
  const m = v.match(/^(ม|ป)\.?\s*([1-6])$/);
  if (m) return `ชั้น${m[1] === 'ม' ? 'มัธยม' : 'ประถม'}ศึกษาปีที่ ${m[2]}`;
  return v.startsWith('ชั้น') ? v : `ชั้น ${v}`;
}

// ป้ายสถานะบนเล่ม: รอลงนาม 3 จาก 5 (แผนและคู่มือ ระดับที่รออยู่) · บันทึกหลังแผน ผ่านแล้ว 2 จาก 5 แผ่น · ส่งกลับแก้ไข · ผ่านครบได้ค่าว่าง
function waitText(r) {
  if (!r.st || r.st === 'approved') return '';
  if (r.st === 'returned') return 'ส่งกลับแก้ไข';
  if (r.kind === 'note') return `ผ่านแล้ว ${r.sheets_done || 0} จาก ${r.sheets} แผ่น`;
  const steps = wf.activeSteps(r.kind);
  const i = steps.findIndex((x) => x.role === r.current_role);
  return i >= 0 ? `รอลงนาม ${i + 1} จาก ${steps.length}` : 'รอลงนาม';
}

// เหตุผลที่เล่มซ่อนอยู่ (ผู้ดูแลระบบเห็นตอนเปิด เห็นเล่มที่ซ่อนอยู่)
function hiddenWhy(r, rule) {
  if (r.shown === undefined || r.shown) return '';
  if (rule.books[r.bkey] === 'hide') return 'ซ่อนเล่มนี้ไว้';
  if (rule.teachers[r.teacher_id] === 'hide') return 'ครูคนนี้ถูกซ่อน';
  return r.st === 'returned' ? 'ส่งกลับแก้ไขอยู่' : `ยัง${waitText(r) || 'ไม่ผ่านครบ'}`;
}

function termText(r) {
  if (!r.academic_year) return '';
  return `${r.semester ? `ภาคเรียนที่ ${r.semester} ` : ''}ปีการศึกษา ${r.academic_year}`;
}

// ข้อมูลสำหรับหน้าเว็บ
// rule ใส่เมื่อผู้ดูแลระบบจัดการการแสดงได้ (ปุ่มซ่อนหรือแสดงเล่มนี้ ฟังก์ชันเสริม libshow)
function decorate(rows, me, ff, rule = null) {
  const admin = Boolean(rule && me.is_admin && ff.libshow);
  return rows.map((r) => ({ ...r, gradeText: gradeText(r.grade_level), termText: termText(r), waitText: waitText(r), hiddenWhy: admin ? hiddenWhy(r, rule) : '', showBtn: admin ? (r.shown === false ? 'show' : 'hide') : '', open: canOpen(me, r, ff), href: openHref(r), cover: coverUrl(r), swap: swapOf(r, me, ff), pdfCover: pdfCoverOf(r, me, ff), mine: me.id === r.teacher_id, shelfLabel: (SHELF[r.kind] || {}).label || '' }));
}

// เปิดอ่านงานคนอื่นจากคลังได้ไหม (readperm หรือสวิตช์ libread) ใช้กับไฟล์งานและหน้าพิมพ์บันทึกหลังแผนทั้งเล่ม
// แผนและคู่มือต้องผ่านครบ · บันทึกหลังแผน (หรือแผนที่เปิดทั้งเล่ม) ต้องอยู่ในเล่มที่ผ่านครบทั้งเล่ม
async function readable(ff, sub, { book = false } = {}, me = null) {
  if (!ff.library || !sub || !me) return false;
  const a = readperm.access(me, ff);
  if (!readperm.reaches(me, a, sub.department_id)) return false;
  if (!book && (sub.doc_type === 'plan' || sub.doc_type === 'manual')) return readperm.statusOk(a, sub.status);
  const planId = book ? sub.id : sub.doc_type === 'note' ? sub.parent_id : null;
  if (!planId || (!book && !readperm.statusOk(a, sub.status))) return false;
  const r = await q.get(
    "SELECT COUNT(*)::int AS n, SUM(CASE WHEN status = 'approved' THEN 0 ELSE 1 END)::int AS bad, SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END)::int AS ret FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND status != 'draft'",
    planId
  );
  return r.n > 0 && !(a.unapproved ? r.ret : r.bad);
}

module.exports = { DRAWN, PAGE, COVER_MAX, SHELVES, SHELF, page, recent, canOpen, openHref, coverUrl, gradeText, termText, waitText, SHOW_MODES, showRule, visibleSql, bookState, decorate, readable };
