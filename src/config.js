// อ่านค่าตั้งต้นจากบรรทัดคำสั่ง เช่น  node server.js --data data-demo --port 3001 --demo
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ROOT = path.resolve(__dirname, '..');
// ระบบรุ่นคลาวด์ในเครื่องเก็บที่ data-pg ไม่แตะโฟลเดอร์ data ของระบบเดิม
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || arg('data', 'data-pg'));
const DEMO = process.env.DEMO === '1' || arg('demo', false) === true;

module.exports = {
  ROOT,
  DATA_DIR,
  // ฐานข้อมูล PGlite ในเครื่อง (ใช้เมื่อไม่ได้ตั้ง DATABASE_URL)
  PG_DIR: path.join(DATA_DIR, 'pg'),
  // ไฟล์งานในเครื่อง (ที่เก็บแบบ local): ค่าเริ่มต้น data-files · ระบุโฟลเดอร์ข้อมูลเอง (โหมดทดลอง ทดสอบ) ใช้ <โฟลเดอร์ข้อมูล>/files
  FILES_DIR: path.resolve(ROOT, process.env.FILES_DIR || (process.env.DATA_DIR || arg('data', false) ? path.join(DATA_DIR, 'files') : 'data-files')),
  PORT: Number(process.env.PORT || arg('port', 3000)),
  // เปิดเฉพาะ DEMO=1 หรือ --demo (เดิม DEMO=0 ก็ถือว่าเปิด)
  DEMO,
  // ที่เก็บไฟล์งาน: gdrive = Google Drive ของโรงเรียน (ต้องตั้ง GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET GDRIVE_REFRESH_TOKEN)
  // โหมดทดลองใช้ในเครื่องเสมอ กันไฟล์ทดลองหลุดเข้า Drive จริง
  FILE_STORE: !DEMO && process.env.FILE_STORE === 'gdrive' ? 'gdrive' : 'local',
};
