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

// เว็บจริงบนอินเทอร์เน็ต (APP_ENV=production) เปิดการป้องกันเพิ่ม: บังคับ SESSION_SECRET และ SETUP_TOKEN · cookie แบบ secure
// · ปิดโหมดทดลองเสมอ · ฟอร์มต้องมี Origin หรือ Referer · อ่านค่าทุกครั้งที่ใช้ (ทดสอบสลับค่าได้)
function isProduction() {
  return process.env.APP_ENV === 'production';
}

// โหมดทดลองเปิดเฉพาะ DEMO=1 หรือ --demo และต้องไม่ใช่เว็บจริง (โหมดทดลองกดเข้าได้ทุกบทบาทรวมผู้ดูแลระบบ)
function isDemo() {
  return !isProduction() && (process.env.DEMO === '1' || arg('demo', false) === true);
}

// รันบน Cloudflare Workers (เว็บจริงและ wrangler dev) ไม่ใช่คอมเครื่องเดียว: ไม่มีดิสก์ ไม่มีวง Wi-Fi ข้อความบนจอบางจุดต่างกัน
function isWorkers() {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

module.exports = {
  ROOT,
  get WORKERS() {
    return isWorkers();
  },
  DATA_DIR,
  // ฐานข้อมูล PGlite ในเครื่อง (ใช้เมื่อไม่ได้ตั้ง DATABASE_URL)
  PG_DIR: path.join(DATA_DIR, 'pg'),
  // ไฟล์งานในเครื่อง (ที่เก็บแบบ local): ค่าเริ่มต้น data-files · ระบุโฟลเดอร์ข้อมูลเอง (โหมดทดลอง ทดสอบ) ใช้ <โฟลเดอร์ข้อมูล>/files
  FILES_DIR: path.resolve(ROOT, process.env.FILES_DIR || (process.env.DATA_DIR || arg('data', false) ? path.join(DATA_DIR, 'files') : 'data-files')),
  PORT: Number(process.env.PORT || arg('port', 3000)),
  get PRODUCTION() {
    return isProduction();
  },
  // เปิดเฉพาะ DEMO=1 หรือ --demo (เดิม DEMO=0 ก็ถือว่าเปิด) · เว็บจริงเปิดไม่ได้
  get DEMO() {
    return isDemo();
  },
  // ที่เก็บไฟล์งาน: gdrive = Google Drive ของโรงเรียน (ต้องตั้ง GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET GDRIVE_REFRESH_TOKEN)
  // โหมดทดลองใช้ในเครื่องเสมอ กันไฟล์ทดลองหลุดเข้า Drive จริง
  get FILE_STORE() {
    return !isDemo() && process.env.FILE_STORE === 'gdrive' ? 'gdrive' : 'local';
  },
};
