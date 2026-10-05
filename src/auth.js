// รหัสผ่านเก็บแบบเข้ารหัสทางเดียว (bcrypt ของ pgcrypto ในฐานข้อมูล) อ่านย้อนกลับไม่ได้
// เข้ารหัสในฐานข้อมูล ไม่กิน CPU ของเซิร์ฟเวอร์ (Workers แบบฟรีให้ 10 ms ต่อคำขอ)
const { q } = require('./db');
const { rolesOf, signatureOf } = require('./workflow');

async function hashPassword(pw) {
  return (await q.get("SELECT crypt(?, gen_salt('bf', 8)) AS h", String(pw))).h;
}

// ตรวจรหัสผ่านของผู้ใช้คนนี้ในฐานข้อมูล ไม่ดึงรหัสที่เข้ารหัสแล้วออกมานอกฐาน
async function verifyPassword(pw, userId) {
  const r = await q.get('SELECT password_hash = crypt(?, password_hash) AS ok FROM users WHERE id = ?', String(pw), userId);
  return Boolean(r && r.ok);
}

// กันการเดารหัสผ่าน: ผิดเกิน 8 ครั้งใน 10 นาที ต้องรอ (ตอน 12 ย้ายไปเก็บในฐานข้อมูล)
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;

function throttleKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

// ล็อกรายชื่อผู้ใช้ด้วย ไม่ว่าเดาจากเครื่องไหน (สำคัญเมื่อใช้รหัสตัวเลขสั้น ๆ)
const MAX_FAILS_PER_USER = 20;

function userKey(username) {
  return `user|${String(username).toLowerCase()}`;
}

// async ไว้ก่อน ตอน 12 ย้ายตัวนับลงฐานข้อมูลโดยไม่ต้องแก้ที่เรียก
async function isLocked(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return a.count >= (key.startsWith('user|') ? MAX_FAILS_PER_USER : MAX_FAILS);
}

async function recordFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count += 1;
}

async function clearFails(key) {
  attempts.delete(key);
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
  throttleKey,
  userKey,
  minPassword,
  isLocked,
  recordFail,
  clearFails,
  loadUser,
  signatureOf,
  requireLogin,
  requireAdmin,
};
