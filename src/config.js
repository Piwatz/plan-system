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

module.exports = {
  ROOT,
  DATA_DIR,
  // ฐานข้อมูล PGlite ในเครื่อง (ใช้เมื่อไม่ได้ตั้ง DATABASE_URL)
  PG_DIR: path.join(DATA_DIR, 'pg'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  PORT: Number(process.env.PORT || arg('port', 3000)),
  DEMO: Boolean(process.env.DEMO || arg('demo', false)),
};
