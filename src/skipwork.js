// ข้ามงานนี้ไปก่อน (ฟังก์ชันเสริม skipwork) เฉพาะผู้ดูแลระบบ จำแยกตามบัญชี ใช้ได้ทุกเครื่อง
// งานยังรอที่ระดับเดิม ไม่แตะตาราง submissions ไม่แจ้งใคร แค่ไม่ถูกเรียกเป็นงานถัดไป จนกว่าจะกดเอากลับ หรือครูส่งฉบับใหม่ (workflow.js ล้างให้)
// kind ในตาราง review_skips: work งานเดี่ยว · book บันทึกหลังแผนทั้งเล่ม (submission_id เป็นแผนของเล่ม)
const { q, nowStr } = require('./db');

function allowed(req) {
  return Boolean(req.ff.skipwork && req.me.is_admin);
}

// งานที่ข้ามไว้ของผู้ใช้คนนี้ ไม่ใช่ผู้ดูแลระบบหรือปิดสวิตช์ได้ Map ว่าง ทุกหน้ากลับเป็นคิวแบบเดิม
async function load(req) {
  if (!allowed(req)) return new Map();
  const rows = await q.all('SELECT kind, submission_id, skipped_at FROM review_skips WHERE user_id = ?', req.me.id);
  return new Map(rows.map((r) => [`${r.kind}:${r.submission_id}`, r.skipped_at]));
}

function keyOf(req, s) {
  return req.ff.notebook && s.doc_type === 'note' && s.parent_id ? `book:${s.parent_id}` : `work:${s.id}`;
}

// แยกรายการจาก wf.inbox เป็นงานที่ต้องตรวจ กับงานที่ข้ามไว้ (เรียงเดิมทั้งสองกลุ่ม)
async function split(req, list) {
  const map = await load(req);
  const active = [];
  const skipped = [];
  for (const s of list) {
    const at = map.get(keyOf(req, s));
    if (at === undefined) active.push(s);
    else skipped.push({ ...s, skippedAt: at });
  }
  return { active, skipped };
}

async function isSkipped(req, kind, id) {
  return (await load(req)).has(`${kind}:${id}`);
}

async function skip(req, kind, id) {
  await q.run(
    `INSERT INTO review_skips (user_id, kind, submission_id, skipped_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, kind, submission_id) DO UPDATE SET skipped_at = EXCLUDED.skipped_at`,
    req.me.id,
    kind,
    id,
    nowStr()
  );
}

async function unskip(req, kind, id) {
  await q.run('DELETE FROM review_skips WHERE user_id = ? AND kind = ? AND submission_id = ?', req.me.id, kind, id);
}

module.exports = { allowed, split, isSkipped, skip, unskip };
