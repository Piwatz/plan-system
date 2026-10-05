// สำรองข้อมูลทุกตารางเป็นไฟล์ JSON ไฟล์เดียว (ปุ่มในหน้าผู้ดูแลระบบ และสำรองอัตโนมัติทุกคืนเข้าที่เก็บไฟล์)
// ให้ Postgres สร้าง JSON ของแต่ละตารางเอง แล้วต่อเป็นสตริงส่งออก ไม่ parse ใน JS (ประหยัดเวลาประมวลผลของเซิร์ฟเวอร์)
// ไฟล์งานที่ครูส่งไม่อยู่ในไฟล์นี้ (อยู่ใน Google Drive) ตาราง files เก็บที่อยู่ของไฟล์ไว้
const { q, nowStr } = require('./db');

// 13 ตารางข้อมูล (ไม่รวมตารางชั่วคราว: ตัวกันเดารหัส ไฟล์ที่กำลังส่ง โฟลเดอร์ Drive ที่จำไว้)
const TABLES = [
  'settings',
  'departments',
  'users',
  'user_roles',
  'workflow_steps',
  'rubric_items',
  'subjects',
  'submissions',
  'files',
  'reviews',
  'notifications',
  'audit_log',
  'teach_subjects',
];

// ทุกตารางในคำสั่งเดียว แต่ละคอลัมน์เป็นข้อความ JSON ของทั้งตาราง เรียงตามคอลัมน์แรก
const SQL = `SELECT (SELECT version FROM schema_version LIMIT 1) AS schema_version, ${TABLES.map(
  (t) => `(SELECT coalesce(json_agg(x), '[]')::text FROM (SELECT * FROM ${t} ORDER BY 1) x) AS ${t}`
).join(', ')}`;

// คืน { name, text } ชื่อไฟล์ เช่น สำรองข้อมูลระบบส่งแผน_2569-11-01.json (วันที่ตามที่เก็บในระบบ)
async function build() {
  const r = await q.get(SQL);
  const now = nowStr();
  const parts = TABLES.map((t) => `${JSON.stringify(t)}:${r[t]}`);
  const text = `{"format":"plan-system-backup","version":1,"schema_version":${Number(r.schema_version) || 0},"created_at":${JSON.stringify(now)},"tables":{${parts.join(',')}}}`;
  return { name: `สำรองข้อมูลระบบส่งแผน_${now.slice(0, 10)}.json`, text };
}

module.exports = { TABLES, build };
