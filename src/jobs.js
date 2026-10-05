// งานตามเวลา: ทุกชั่วโมงทิ้งไฟล์ที่ส่งค้างไว้เกิน 1 วัน และล้างตัวนับรหัสผ่านผิดที่หมดอายุ · ทุกคืนตีสองสำรองข้อมูลเข้าที่เก็บไฟล์ เก็บ 30 ฉบับล่าสุด
// บน Node เรียก tick ทุกนาที (start) · บน Workers เรียก runCron จาก Cron Trigger (src/worker.mjs)
const db = require('./db');
const { q, nowStr, getSettings, setSetting } = db;
const storage = require('./storage');
const backup = require('./backup');

const BACKUP_FOLDER = 'สำรองข้อมูล';
const KEEP_BACKUPS = 30;
const DAY = 24 * 60 * 60 * 1000;

// ไฟล์ที่เริ่มส่งแล้วไม่ได้ผูกกับงานภายใน 1 วัน (ปิดหน้าไปกลางทาง บันทึกไม่สำเร็จ) ย้ายไปถังขยะ
async function cleanupPending() {
  const cutoff = nowStr(new Date(Date.now() - DAY));
  const rows = await q.all(
    "UPDATE pending_uploads SET status = 'trashed' WHERE created_at < ? AND status IN ('uploading', 'sending', 'done') RETURNING session_uri, drive_file_id",
    cutoff
  );
  for (const r of rows) {
    try {
      if (r.drive_file_id) await storage.trash(r.drive_file_id);
      else await storage.current().abort(r.session_uri);
    } catch (e) {
      console.error('ทิ้งไฟล์ที่ส่งค้างไม่สำเร็จ', e.message);
    }
  }
  // แถวที่ใช้แล้วหรือทิ้งแล้ว ไม่ต้องเก็บต่อ
  await q.run("DELETE FROM pending_uploads WHERE created_at < ? AND status IN ('used', 'trashed')", cutoff);
  return rows.length;
}

// สำรองข้อมูลเข้าโฟลเดอร์ สำรองข้อมูล แล้วย้ายฉบับที่เก่ากว่า 30 ฉบับล่าสุดไปถังขยะ
async function nightlyBackup() {
  const store = storage.current();
  const { name, text } = await backup.build();
  await store.putFile(BACKUP_FOLDER, name, 'application/json', Buffer.from(text, 'utf8'));
  const list = await store.list(BACKUP_FOLDER);
  for (const old of list.slice(KEEP_BACKUPS)) await storage.trash(old.ref);
  return name;
}

async function hourly() {
  return db.withScope(async () => {
    // ตัวนับรหัสผ่านผิดที่หมดอายุแล้ว
    await require('./auth').cleanupAttempts();
    return cleanupPending();
  });
}

async function nightly() {
  return db.withScope(nightlyBackup);
}

let lastHour = '';

// Node: เรียกทุกนาที ล้างไฟล์ค้างชั่วโมงละครั้ง สำรองข้อมูลวันละครั้งหลังตีสอง (จำวันที่สำรองล่าสุดไว้ในค่าตั้ง)
async function tick() {
  const now = nowStr();
  if (now.slice(0, 13) !== lastHour) {
    lastHour = now.slice(0, 13);
    await hourly().catch((e) => console.error('ล้างไฟล์ที่ส่งค้างไม่สำเร็จ', e.message));
  }
  await db.withScope(async () => {
    const s = await getSettings();
    const today = now.slice(0, 10);
    if (s.backup_last_date === today || now.slice(11, 16) < '02:00') return;
    await setSetting('backup_last_date', today);
    try {
      await nightlyBackup();
    } catch (e) {
      console.error('สำรองข้อมูลอัตโนมัติไม่สำเร็จ', e.message);
    }
  });
}

function start() {
  const timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
  timer.unref();
  return timer;
}

// Workers: Cron Trigger ใน wrangler.jsonc (เวลา UTC) · ทุก 5 นาทีดูเวลาส่ง LINE (ส่งช้ากว่าเวลาที่ตั้งได้ไม่เกิน 5 นาที)
// ทุกชั่วโมงล้างไฟล์ค้าง · 19:00 UTC = ตีสองเวลาไทย สำรองข้อมูล
const CRONS = {
  '*/5 * * * *': () =>
    db.withScope(async () => {
      await db.ensureRefs();
      await require('./line').tick();
    }),
  '0 * * * *': hourly,
  '0 19 * * *': nightly,
};

async function runCron(cron) {
  const job = CRONS[cron];
  if (!job) throw new Error(`ไม่รู้จักงานตามเวลา ${cron}`);
  try {
    await job();
  } catch (e) {
    console.error(`งานตามเวลา ${cron} ไม่สำเร็จ`, e.message);
    throw e;
  }
}

module.exports = { BACKUP_FOLDER, KEEP_BACKUPS, CRONS, cleanupPending, nightlyBackup, hourly, nightly, tick, start, runCron };
