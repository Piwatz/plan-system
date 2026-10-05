// จุดเริ่มต้นของโปรแกรม: npm start  หรือดับเบิลคลิกไฟล์ .bat
const os = require('os');
const config = require('./src/config');
// แปลงหน้าเว็บเป็น dist/views.js ทุกครั้งที่เปิดระบบ (ไฟล์ .bat และ npm start ไม่ต้องสั่ง build เอง)
require('./scripts/build-views').build({ quiet: true });
const { createApp } = require('./src/app');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// โหมดทดลองใช้ PGlite ใน data-demo/pg เสมอ (ไม่ใช้ DATABASE_URL กันข้อมูลทดลองปนฐานจริง)
// ปกติใช้ DATABASE_URL ถ้ามี ไม่มีก็ใช้ PGlite ใน data-pg/pg
async function start() {
  const db = require('./src/db');
  await db.open(config.DEMO ? config.PG_DIR : undefined);
  const app = createApp();
  // ส่งสรุปเข้า LINE ทุกเช้า (ทำงานเฉพาะเมื่อผู้ดูแลระบบเปิดฟังก์ชันนี้และตั้งค่า LINE แล้ว)
  if (!config.DEMO) require('./src/line').start();
  const server = app.listen(config.PORT, () => {
    console.log('');
    console.log('  ระบบส่งแผนการสอนออนไลน์ เปิดแล้ว' + (config.DEMO ? ' (โหมดทดลอง ข้อมูลสมมติ)' : ''));
    console.log(`  เครื่องนี้:            http://localhost:${config.PORT}`);
    for (const ip of lanAddresses()) console.log(`  เครื่องอื่นในโรงเรียน: http://${ip}:${config.PORT}`);
    console.log(`  ข้อมูลเก็บที่:         ${config.DATA_DIR}`);
    console.log('  ปิดหน้าต่างนี้ = ปิดระบบ');
    console.log('');
    // เปิดเบราว์เซอร์ให้เอง เมื่อสั่งเปิดผ่านไฟล์ .bat (มี --open)
    if (process.argv.includes('--open')) openBrowser(`http://localhost:${config.PORT}`);
  });
  // ไฟล์ใหญ่ (สูงสุด 100 MB) ผ่าน Wi-Fi ช้าอาจใช้เวลาเกิน 5 นาที ให้รอได้ถึง 30 นาทีก่อนตัดการเชื่อมต่อ
  server.requestTimeout = 30 * 60 * 1000;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`พอร์ต ${config.PORT} ถูกใช้อยู่ อาจเปิดระบบไว้แล้วในอีกหน้าต่างหนึ่ง`);
      process.exit(1);
    }
    throw err;
  });
}

function openBrowser(url) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // เปิดเบราว์เซอร์ไม่ได้ ผู้ใช้เปิดเองตามที่อยู่ที่แสดง
  }
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
