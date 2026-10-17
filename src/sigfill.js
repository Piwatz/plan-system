// งานที่ครูส่งไปตอนยังไม่มีลายเซ็น (submissions.teacher_signature ว่าง) ฟังก์ชันเสริม sigfill sigfillauto siglist
// เติมได้เฉพาะลายเซ็นของเจ้าของงานเอง จากข้อมูลส่วนตัวของผู้ใช้คนนั้น ผู้ดูแลระบบใส่ลายเซ็นแทนครูไม่ได้ (เอกสารราชการ)
const { q } = require('./db');

// งานของผู้ใช้ที่ส่งแล้ว (ไม่ใช่ร่าง) แต่ยังไม่มีลายเซ็นครู · subId = เฉพาะงานนี้
async function blankWorks(userId, subId = null) {
  return q.all(
    `SELECT s.id, s.doc_type, s.subject_code, s.subject_name, s.plan_no, s.topic
     FROM submissions s WHERE s.teacher_id = ? AND s.status <> 'draft' AND (s.teacher_signature IS NULL OR s.teacher_signature = '')
     ${subId == null ? '' : 'AND s.id = ?'} ORDER BY s.id`,
    userId,
    ...(subId == null ? [] : [subId])
  );
}

// ใส่ลายเซ็นปัจจุบันของผู้ใช้ในงานที่ยังว่าง คืนจำนวนงานที่ใส่
async function fill(userId, subId = null) {
  const rows = await q.all(
    `UPDATE submissions s SET teacher_signature = u.signature FROM users u
     WHERE u.id = s.teacher_id AND s.teacher_id = ? AND u.signature IS NOT NULL AND u.signature <> ''
       AND s.status <> 'draft' AND (s.teacher_signature IS NULL OR s.teacher_signature = '')
       ${subId == null ? '' : 'AND s.id = ?'}
     RETURNING s.id`,
    userId,
    ...(subId == null ? [] : [subId])
  );
  return rows.length;
}

// แบบใส่ให้ทันที (sigfillauto): เรียกหลังผู้ใช้บันทึกลายเซ็น หรือเปิดหน้าแรก จด audit_log เมื่อมีงานที่ใส่
async function autoFill(req) {
  if (!req.ff.sigfillauto || !req.me || !req.me.signature) return 0;
  const n = await fill(req.me.id);
  if (n) await require('./features').audit(req.me, `ใส่ลายเซ็นของตัวเองในงานที่ส่งตอนยังไม่มีลายเซ็น ${n} งาน (อัตโนมัติ)`, `user ${req.me.id}`);
  return n;
}

// ครูที่มีงานส่งแล้วแต่ยังไม่มีลายเซ็น สำหรับหน้าผู้ดูแลระบบ (siglist) · has_sig = มีลายเซ็นในข้อมูลส่วนตัวแล้ว รอใส่ในงาน
async function missingList() {
  return q.all(
    `SELECT u.id, u.full_name, d.name AS dept, COUNT(s.id)::int AS n,
       (u.signature IS NOT NULL AND u.signature <> '') AS has_sig
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = u.department_id
     WHERE s.status <> 'draft' AND (s.teacher_signature IS NULL OR s.teacher_signature = '') AND u.is_active = 1
     GROUP BY u.id, u.full_name, d.name, u.signature
     ORDER BY d.name NULLS LAST, u.full_name`
  );
}

// ชื่องานสั้น ๆ ใช้ในรายการ
function workLabel(w) {
  const kind = { manual: 'คู่มือรายวิชา', plan: 'แผนการจัดการเรียนรู้', note: 'บันทึกหลังแผน' }[w.doc_type] || 'งาน';
  const extra = w.doc_type === 'note' && w.plan_no ? ` แผนที่ ${w.plan_no}` : '';
  return `${kind} ${w.subject_code} ${w.subject_name}${extra}`.trim();
}

module.exports = { blankWorks, fill, autoFill, missingList, workLabel };
