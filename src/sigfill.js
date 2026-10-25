// งานที่ครูส่งไปตอนยังไม่มีลายเซ็น (submissions.teacher_signature ว่าง) ฟังก์ชันเสริม sigfill sigfillauto siglist
// เติมได้เฉพาะลายเซ็นของเจ้าของงานเอง จากข้อมูลส่วนตัวของผู้ใช้คนนั้น ผู้ดูแลระบบใส่ลายเซ็นแทนครูไม่ได้ (เอกสารราชการ)
// งานที่โอนมาแบบคงชื่อครูคนเดิม (doc_name) เอกสารเป็นชื่อคนอื่น ไม่เติมลายเซ็นของเจ้าของงานคนใหม่
const { q } = require('./db');
const planrange = require('./planrange');

// งานที่ผู้ดูแลระบบส่งแทนครู: การส่งครั้งล่าสุดไม่ใช่เจ้าของงาน (ฟังก์ชันเสริม sigconfirm ครูต้องเปิดหน้างานแล้วกดยืนยันเอง)
const PROXY = `COALESCE((SELECT r.user_id FROM reviews r WHERE r.submission_id = s.id AND r.action IN ('submit', 'resubmit') ORDER BY r.id DESC LIMIT 1), s.teacher_id) <> s.teacher_id`;

// งานของผู้ใช้ที่ส่งแล้ว (ไม่ใช่ร่าง) แต่ยังไม่มีลายเซ็นครู · subId = เฉพาะงานนี้
async function blankWorks(userId, subId = null) {
  return q.all(
    `SELECT s.id, s.doc_type, s.subject_code, s.subject_name, s.plan_no, s.topic, (${PROXY}) AS proxy
     FROM submissions s WHERE s.teacher_id = ? AND s.status <> 'draft' AND s.doc_name = '' AND (s.teacher_signature IS NULL OR s.teacher_signature = '')
     ${subId == null ? '' : 'AND s.id = ?'} ORDER BY s.id`,
    userId,
    ...(subId == null ? [] : [subId])
  );
}

// ใส่ลายเซ็นปัจจุบันของผู้ใช้ในงานที่ยังว่าง คืนจำนวนงานที่ใส่ · skipProxy = ข้ามงานที่ผู้ดูแลระบบส่งแทน (ให้ครูยืนยันทีละงาน)
async function fill(userId, subId = null, { skipProxy = false } = {}) {
  const rows = await q.all(
    `UPDATE submissions s SET teacher_signature = u.signature FROM users u
     WHERE u.id = s.teacher_id AND s.teacher_id = ? AND u.signature IS NOT NULL AND u.signature <> ''
       AND s.status <> 'draft' AND s.doc_name = '' AND (s.teacher_signature IS NULL OR s.teacher_signature = '')
       ${subId == null ? '' : 'AND s.id = ?'} ${skipProxy ? `AND NOT (${PROXY})` : ''}
     RETURNING s.id`,
    userId,
    ...(subId == null ? [] : [subId])
  );
  return rows.length;
}

// แบบใส่ให้ทันที (sigfillauto): เรียกหลังผู้ใช้บันทึกลายเซ็น หรือเปิดหน้าแรก จด audit_log เมื่อมีงานที่ใส่
async function autoFill(req) {
  if (!req.ff.sigfillauto || !req.me || !req.me.signature) return 0;
  const n = await fill(req.me.id, null, { skipProxy: req.ff.sigconfirm });
  if (n) await require('./features').audit(req.me, `ใส่ลายเซ็นของตัวเองในงานที่ส่งตอนยังไม่มีลายเซ็น ${n} งาน (อัตโนมัติ)`, `user ${req.me.id}`);
  return n;
}

// ครูที่มีงานส่งแล้วแต่ยังไม่มีลายเซ็น สำหรับหน้าผู้ดูแลระบบ (siglist) · has_sig = มีลายเซ็นในข้อมูลส่วนตัวแล้ว รอใส่ในงาน
async function missingList() {
  return q.all(
    `SELECT u.id, u.full_name, d.name AS dept, COUNT(s.id)::int AS n,
       (u.signature IS NOT NULL AND u.signature <> '') AS has_sig, COUNT(s.id) FILTER (WHERE ${PROXY})::int AS proxy_n
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = u.department_id
     WHERE s.status <> 'draft' AND s.doc_name = '' AND (s.teacher_signature IS NULL OR s.teacher_signature = '') AND u.is_active = 1
     GROUP BY u.id, u.full_name, d.name, u.signature
     ORDER BY d.name NULLS LAST, u.full_name`
  );
}

// ชื่องานสั้น ๆ ใช้ในรายการ
function workLabel(w) {
  const kind = { manual: 'คู่มือรายวิชา', plan: 'แผนการจัดการเรียนรู้', note: 'บันทึกหลังแผน' }[w.doc_type] || 'งาน';
  const extra = w.doc_type === 'note' && w.plan_no ? ` ${planrange.label(w.plan_no)}` : '';
  return `${kind} ${w.subject_code} ${w.subject_name}${extra}`.trim();
}

module.exports = { blankWorks, fill, autoFill, missingList, workLabel };
