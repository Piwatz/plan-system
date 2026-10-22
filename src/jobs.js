// งานตามเวลา: ทุกชั่วโมงทิ้งไฟล์ที่ส่งค้างไว้เกิน 1 วัน และล้างตัวนับรหัสผ่านผิดที่หมดอายุ · ทุกคืนตีสองสำรองข้อมูลเข้าที่เก็บไฟล์ เก็บ 30 ฉบับล่าสุด
// ฟังก์ชันเสริม backupkeep: ฉบับแรกของทุกเดือนเก็บถาวรอีกชุด + ปุ่มเก็บฉบับปิดภาค · backupalert: แจ้งผู้ดูแลในหน้าแรกเมื่อสำรองไม่สำเร็จ
// บน Node เรียก tick ทุกนาที (start) · บน Workers เรียก runCron จาก Cron Trigger (src/worker.mjs)
const db = require('./db');
const { q, nowStr, getSettings, setSetting } = db;
const storage = require('./storage');
const backup = require('./backup');
const features = require('./features');

const BACKUP_FOLDER = 'สำรองข้อมูล';
const MONTHLY_FOLDER = 'สำรองรายเดือน';
const TERM_FOLDER = 'สำรองปิดภาคเรียน';
const KEEP_BACKUPS = 30;
const DAY = 24 * 60 * 60 * 1000;
// ไม่ได้สำรองสำเร็จนานกว่านี้ ถือว่างานตามเวลาหยุดทำงาน (2 วัน เผื่องานตามเวลาช้า 1 ชั่วโมง)
const STALE_MS = 2 * DAY + 60 * 60 * 1000;

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
// เปิด backupkeep: ฉบับแรกที่สำเร็จของเดือน (ปกติวันที่ 1) เก็บอีกชุดในโฟลเดอร์ สำรองรายเดือน ไม่หมุนทิ้ง
// จำเวลาที่สำเร็จหรือไม่สำเร็จไว้ในค่าตั้ง ให้หน้าแรกของผู้ดูแลแจ้งเตือน
async function nightlyBackup() {
  try {
    const store = storage.current();
    const { name, text } = await backup.build();
    const body = Buffer.from(text, 'utf8');
    await store.putFile(BACKUP_FOLDER, name, 'application/json', body);
    const list = await store.list(BACKUP_FOLDER);
    for (const old of list.slice(KEEP_BACKUPS)) await storage.trash(old.ref);
    const s = await getSettings();
    const now = nowStr();
    if (features.isOn(s, 'backupkeep') && s.backup_month !== now.slice(0, 7)) {
      await store.putFile(MONTHLY_FOLDER, name, 'application/json', body);
      await setSetting('backup_month', now.slice(0, 7));
      await setSetting('backup_month_at', now);
      await setSetting('backup_month_n', (Number(s.backup_month_n) || 0) + 1);
    }
    await setSetting('backup_ok_at', now);
    // สำเร็จแล้ว ล้างบันทึกคืนที่ไม่สำเร็จ แถบเตือนหายเอง
    if (s.backup_fail_at) await setSetting('backup_fail_at', '');
    return name;
  } catch (e) {
    await setSetting('backup_fail_at', nowStr()).catch(() => {});
    await setSetting('backup_fail_msg', String((e && e.message) || e).slice(0, 200)).catch(() => {});
    throw e;
  }
}

// ปุ่ม เก็บสำรองฉบับปิดภาค ในหน้าผู้ดูแลระบบ เก็บถาวรในโฟลเดอร์ สำรองปิดภาคเรียน (กดซ้ำได้ ได้อีกฉบับ)
async function termBackup(actor) {
  const s = await getSettings();
  const label = `${s.semester}-${s.academic_year}`;
  const { text } = await backup.build();
  const now = nowStr();
  const name = `สำรองปิดภาค_${label}_${now.slice(0, 10)}_${now.slice(11, 16).replace(':', '')}.json`;
  await storage.current().putFile(TERM_FOLDER, name, 'application/json', Buffer.from(text, 'utf8'));
  await setSetting('backup_term_at', now);
  await setSetting('backup_term_label', `${s.semester}/${s.academic_year}`);
  await setSetting('backup_term_n', (Number(s.backup_term_n) || 0) + 1);
  await features.audit(actor, `เก็บสำรองข้อมูลฉบับปิดภาค ${s.semester}/${s.academic_year}`, `${TERM_FOLDER}/${name}`);
  return name;
}

const toMs = (str) => Date.parse(String(str).replace(' ', 'T') + '+07:00');

// สถานะสำรองสำหรับแจ้งผู้ดูแล: null = ปกติ · { kind: 'fail', at, msg } · { kind: 'stale', at, days }
// ยังไม่เคยสำรองสำเร็จเลย (เพิ่งเปิดใช้) เริ่มนับจากครั้งแรกที่ผู้ดูแลเปิดหน้าแรก
async function backupStatus(now = new Date()) {
  const s = await getSettings();
  if (s.backup_fail_at) return { kind: 'fail', at: s.backup_fail_at, msg: s.backup_fail_msg || '' };
  let since = s.backup_ok_at;
  if (!since) {
    since = s.backup_watch_from;
    if (!since) {
      await setSetting('backup_watch_from', nowStr(now));
      return null;
    }
  }
  const age = now.getTime() - toMs(since);
  if (age > STALE_MS) return { kind: 'stale', at: s.backup_ok_at || '', days: Math.floor(age / DAY) };
  return null;
}

// แจ้งผู้ตรวจวันละครั้งตอนเช้า (ฟังก์ชันเสริม waitnotify) ว่ามีงานรอลงนามกี่งาน บันทึกหลังแผนนับเป็นเล่ม
// ข้อความเก่าที่ยังไม่ได้อ่านถูกแทนด้วยข้อความใหม่ ไม่กองซ้อน · คำสั่งคงที่ไม่ว่าผู้ตรวจกี่คน · คืนจำนวนผู้ตรวจที่ได้แจ้ง
const WAIT_LINK = '/inbox';
async function waitDigest() {
  await db.ensureRefs();
  if (!features.isOn(null, 'waitnotify')) return 0;
  const wf = require('./workflow');
  const users = await q.all(
    `SELECT u.id, u.department_id, array_agg(r.role) AS roles FROM users u JOIN user_roles r ON r.user_id = u.id
     WHERE u.is_active = 1 GROUP BY u.id, u.department_id`
  );
  if (!users.length) return 0;
  const subs = await q.all(
    "SELECT id, doc_type, parent_id, teacher_id, department_id, status, current_role, plan_no, updated_at FROM submissions WHERE status = 'pending'"
  );
  const out = [];
  for (const u of users) {
    const mine = subs.filter((s) => wf.canReview(u, s));
    const n = wf.groupBooks(mine).length;
    if (n) out.push({ user: u.id, text: `มีงานรอคุณลงนาม ${n} งาน\nกดเปิด เพื่อดูรายการงานรอตรวจ`, link: WAIT_LINK });
  }
  await q.run(
    "DELETE FROM notifications WHERE from_name = 'ระบบ' AND link = ? AND read_at IS NULL AND user_id = ANY(?)",
    WAIT_LINK,
    out.map((x) => x.user)
  );
  await wf.systemNotify(out);
  return out.length;
}

// Workers: ไม่ใช้นาฬิกาปลุกเพิ่ม (โควตา Cron ของแบบฟรีนับรวมทั้งบัญชี) อาศัยรอบทุกชั่วโมง ส่งเฉพาะรอบ 7 โมงเช้าเวลาไทย
async function morning(now = nowStr()) {
  if (now.slice(11, 13) !== '07') return 0;
  return db.withScope(waitDigest);
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
    // แจ้งผู้ตรวจวันละครั้งหลัง 7 โมงเช้า
    if (s.wait_last_date !== today && now.slice(11, 16) >= '07:00') {
      await setSetting('wait_last_date', today);
      await waitDigest().catch((e) => console.error('แจ้งงานรอลงนามไม่สำเร็จ', e.message));
    }
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
// ทุกชั่วโมงล้างไฟล์ค้าง (รอบ 7 โมงเช้าเวลาไทยแจ้งผู้ตรวจด้วย) · 19:00 UTC = ตีสองเวลาไทย สำรองข้อมูล
const CRONS = {
  '*/5 * * * *': () =>
    db.withScope(async () => {
      await db.ensureRefs();
      await require('./line').tick();
    }),
  '0 * * * *': async () => {
    await hourly();
    await morning().catch((e) => console.error('แจ้งงานรอลงนามไม่สำเร็จ', e.message));
  },
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

module.exports = { BACKUP_FOLDER, MONTHLY_FOLDER, TERM_FOLDER, KEEP_BACKUPS, STALE_MS, CRONS, cleanupPending, nightlyBackup, termBackup, backupStatus, waitDigest, morning, hourly, nightly, tick, start, runCron };
