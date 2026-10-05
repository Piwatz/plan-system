// รหัสผ่านเก็บแบบเข้ารหัสทางเดียว (bcrypt ของ pgcrypto ในฐานข้อมูล) อ่านย้อนกลับไม่ได้
// เข้ารหัสในฐานข้อมูล ไม่กิน CPU ของเซิร์ฟเวอร์ (Workers แบบฟรีให้ 10 ms ต่อคำขอ)
const { q } = require('./db');
const config = require('./config');
const { rolesOf, signatureOf } = require('./workflow');

async function hashPassword(pw) {
  return (await q.get("SELECT crypt(?, gen_salt('bf', 8)) AS h", String(pw))).h;
}

// ตรวจรหัสผ่านของผู้ใช้คนนี้ในฐานข้อมูล ไม่ดึงรหัสที่เข้ารหัสแล้วออกมานอกฐาน
async function verifyPassword(pw, userId) {
  const r = await q.get('SELECT password_hash = crypt(?, password_hash) AS ok FROM users WHERE id = ?', String(pw), userId);
  return Boolean(r && r.ok);
}

// กันการเดารหัสผ่าน: ผิดเกิน 8 ครั้งใน 10 นาที (ต่อเครื่องและชื่อผู้ใช้) ต้องรอ
// ตัวนับเก็บในตาราง login_attempts เพราะ Workers ไม่มีหน่วยความจำค้างระหว่างคำขอ และเปิดแอปใหม่แล้วยังล็อกอยู่
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;
// ล็อกรายชื่อผู้ใช้ด้วย ไม่ว่าเดาจากเครื่องไหน (สำคัญเมื่อใช้รหัสตัวเลขสั้น ๆ)
const MAX_FAILS_PER_USER = 20;

// IP ของผู้ใช้: เว็บจริงอยู่หลัง Cloudflare อ่านจาก CF-Connecting-IP (Cloudflare เขียนทับเอง คนนอกปลอมไม่ได้)
// ในเครื่องใช้ req.ip (trust proxy เฉพาะ loopback)
// บน Workers (เว็บจริงและ wrangler dev) Cloudflare ใส่ CF-Connecting-IP ให้เอง ผู้ใช้ปลอมไม่ได้ ส่วน req.ip ว่าง
function clientIp(req) {
  return (config.PRODUCTION || config.WORKERS ? req.get('cf-connecting-ip') : req.ip) || '';
}

// ไม่รู้ IP ได้ null แล้วไม่นับแบบต่อเครื่อง (ถ้าทุกคำขอ IP ว่างเหมือนกัน คนนอกจะล็อกชื่อใครก็ได้ด้วย 8 ครั้ง)
// ยังเหลือตัวนับต่อชื่อผู้ใช้ 20 ครั้ง
function throttleKey(req, username) {
  const ip = clientIp(req);
  return ip ? `${ip}|${String(username).toLowerCase()}` : null;
}

function userKey(username) {
  return `user|${String(username).toLowerCase()}`;
}

function limitOf(key) {
  return key.startsWith('user|') ? MAX_FAILS_PER_USER : MAX_FAILS;
}

// รับได้หลายกุญแจในคำสั่งเดียว กุญแจ null ข้าม · ล็อกเมื่อกุญแจใดกุญแจหนึ่งผิดครบจำนวนภายใน 10 นาที
async function isLocked(...keys) {
  keys = keys.filter(Boolean);
  if (!keys.length) return false;
  const rows = await q.all(
    `SELECT key, count FROM login_attempts WHERE key IN (${keys.map(() => '?').join(', ')}) AND first_at > ?`,
    ...keys,
    Date.now() - WINDOW_MS
  );
  return rows.some((r) => r.count >= limitOf(r.key));
}

// นับเพิ่มครั้งละ 1 ถ้าครั้งแรกเก่ากว่า 10 นาทีเริ่มนับใหม่ ทำในคำสั่งเดียว (คำขอพร้อมกันไม่นับหาย)
async function recordFail(...keys) {
  keys = keys.filter(Boolean);
  if (!keys.length) return;
  const now = Date.now();
  await q.run(
    `INSERT INTO login_attempts (key, first_at, count) VALUES ${keys.map(() => '(?, ?, 1)').join(', ')}
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.first_at > ? THEN login_attempts.count + 1 ELSE 1 END,
       first_at = CASE WHEN login_attempts.first_at > ? THEN login_attempts.first_at ELSE excluded.first_at END`,
    ...keys.flatMap((k) => [k, now]),
    now - WINDOW_MS,
    now - WINDOW_MS
  );
}

async function clearFails(...keys) {
  keys = keys.filter(Boolean);
  if (!keys.length) return;
  await q.run(`DELETE FROM login_attempts WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys);
}

// ล้างตัวนับที่หมดอายุแล้ว (เรียกจากงานรายชั่วโมง)
async function cleanupAttempts() {
  await q.run('DELETE FROM login_attempts WHERE first_at <= ?', Date.now() - WINDOW_MS);
}

// ความยาวรหัสผ่านขั้นต่ำ: ครูใช้รหัสตัวเลข 4 หลักได้ (ฟังก์ชันเสริม pin)
// ผู้ดูแลระบบ ผู้อำนวยการ และรองผู้อำนวยการต้อง 6 ตัวขึ้นไปเสมอ เพราะลงนามเอกสารราชการและคุมทั้งระบบ
const STRONG_ROLES = ['director', 'deputy_academic'];
async function minPassword(user, pinOn) {
  if (!pinOn || !user) return 6;
  const roles = user.roles || (user.id ? await rolesOf(user.id) : []);
  return user.is_admin || roles.some((r) => STRONG_ROLES.includes(r)) ? 6 : 4;
}

// ผู้ใช้ที่เข้าระบบอยู่ ไม่ดึงรหัสผ่านที่เข้ารหัสแล้ว และไม่ดึงรูปลายเซ็น (หลายร้อย KB)
// signature ได้เป็นที่อยู่ /media/signature?v=รุ่น ถ้ามีลายเซ็น (template ใช้เช็กว่ามีลายเซ็นและแสดงรูป)
// งานที่ต้องใช้รูปลายเซ็นจริงให้เรียก signatureOf() · บทบาทมาในคำสั่งเดียวกัน (ทุกคำขอเรียก)
async function loadUser(id) {
  const u = await q.get(
    `SELECT u.id, u.username, u.must_change_password, u.full_name, u.position, u.department_id, u.is_teacher, u.is_admin,
       u.is_active, u.created_at, u.last_login_at, u.plan_quota,
       CASE WHEN coalesce(u.signature, '') = '' THEN NULL ELSE '/media/signature?v=' || substr(md5(u.signature), 1, 8) END AS signature,
       d.name AS dept_name,
       ARRAY(SELECT r.role FROM user_roles r WHERE r.user_id = u.id) AS roles
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id = ? AND u.is_active = 1`,
    id
  );
  return u || null;
}

function requireLogin(req, res, next) {
  if (!req.me) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.me.must_change_password && !['/password', '/logout'].includes(req.path)) {
    return res.redirect('/password');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.me || !req.me.is_admin) return res.status(403).render('error', { title: 'ไม่มีสิทธิ์', message: 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น' });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  clientIp,
  throttleKey,
  userKey,
  minPassword,
  isLocked,
  recordFail,
  clearFails,
  cleanupAttempts,
  loadUser,
  signatureOf,
  requireLogin,
  requireAdmin,
};
