// ใช้ลายเซ็นปัจจุบันแทนลายเซ็นเดิมในงานที่ลงนามหรือส่งไปแล้ว (ฟังก์ชันเสริม resign)
// เปลี่ยนเฉพาะลายเซ็นของเจ้าของเอง: แถวประวัติที่ผู้ใช้คนนี้ลงนาม (reviews.signature) และลายเซ็นตอนส่งงานของตัวเอง (submissions.teacher_signature)
// แถวที่ผู้ดูแลระบบดำเนินการแทนไม่มีลายเซ็น จึงไม่ถูกเติม
const { q } = require('./db');

// subId = เฉพาะงานนี้ · null = ทุกงาน · คืนรายการรหัสงานที่ยังใช้ลายเซ็นเดิม
async function staleWorks(userId, subId = null) {
  const one = subId == null ? '' : ' AND x.submission_id = ?';
  const rows = await q.all(
    `SELECT DISTINCT x.submission_id AS id FROM (
       SELECT r.submission_id, r.signature FROM reviews r WHERE r.user_id = ? AND r.signature IS NOT NULL
       UNION ALL
       SELECT s.id, s.teacher_signature FROM submissions s WHERE s.teacher_id = ? AND s.teacher_signature IS NOT NULL
     ) x JOIN users u ON u.id = ? AND u.signature IS NOT NULL AND u.signature <> '' AND x.signature <> u.signature
     WHERE true${one}
     ORDER BY 1`,
    userId,
    userId,
    userId,
    ...(subId == null ? [] : [subId])
  );
  return rows.map((r) => r.id);
}

// เปลี่ยนเป็นลายเซ็นปัจจุบัน คืนจำนวนงานที่เปลี่ยน
async function apply(userId, subId = null) {
  return q.tx(async () => {
    const ids = await staleWorks(userId, subId);
    if (!ids.length) return 0;
    await q.run(
      `UPDATE reviews r SET signature = u.signature FROM users u
       WHERE u.id = r.user_id AND r.user_id = ? AND r.signature IS NOT NULL AND r.signature <> u.signature AND r.submission_id = ANY(?)`,
      userId,
      ids
    );
    await q.run(
      `UPDATE submissions s SET teacher_signature = u.signature FROM users u
       WHERE u.id = s.teacher_id AND s.teacher_id = ? AND s.teacher_signature IS NOT NULL AND s.teacher_signature <> u.signature AND s.id = ANY(?)`,
      userId,
      ids
    );
    return ids.length;
  });
}

// ลายเซ็นเดิมของผู้ใช้ในงานนี้ (แสดงรูปเล็กข้างปุ่ม) ล่าสุดก่อน
async function oldSignature(userId, subId) {
  const r = await q.get(
    `SELECT x.signature FROM (
       SELECT r.signature, r.created_at FROM reviews r WHERE r.user_id = ? AND r.submission_id = ? AND r.signature IS NOT NULL
       UNION ALL
       SELECT s.teacher_signature, '' FROM submissions s WHERE s.teacher_id = ? AND s.id = ? AND s.teacher_signature IS NOT NULL
     ) x JOIN users u ON u.id = ? AND x.signature <> u.signature ORDER BY x.created_at DESC LIMIT 1`,
    userId,
    subId,
    userId,
    subId,
    userId
  );
  return r ? r.signature : null;
}

module.exports = { staleWorks, apply, oldSignature };
