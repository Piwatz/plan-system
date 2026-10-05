// รหัสผ่านเก็บแบบเข้ารหัสทางเดียว (scrypt) อ่านย้อนกลับไม่ได้
const crypto = require('crypto');
const { q } = require('./db');
const { rolesOf } = require('./workflow');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

// กันการเดารหัสผ่าน: ผิดเกิน 8 ครั้งใน 10 นาที ต้องรอ
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

function isLocked(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return a.count >= (key.startsWith('user|') ? MAX_FAILS_PER_USER : MAX_FAILS);
}

function recordFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count += 1;
}

function clearFails(key) {
  attempts.delete(key);
}

// ความยาวรหัสผ่านขั้นต่ำ: ครูใช้รหัสตัวเลข 4 หลักได้ (ฟังก์ชันเสริม pin)
// ผู้ดูแลระบบ ผู้อำนวยการ และรองผู้อำนวยการต้อง 6 ตัวขึ้นไปเสมอ เพราะลงนามเอกสารราชการและคุมทั้งระบบ
const STRONG_ROLES = ['director', 'deputy_academic'];
function minPassword(user, pinOn) {
  if (!pinOn || !user) return 6;
  const roles = user.roles || (user.id ? q.all('SELECT role FROM user_roles WHERE user_id = ?', user.id).map((r) => r.role) : []);
  return user.is_admin || roles.some((r) => STRONG_ROLES.includes(r)) ? 6 : 4;
}

function loadUser(id) {
  const u = q.get(
    `SELECT u.*, d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id = ? AND u.is_active = 1`,
    id
  );
  if (!u) return null;
  u.roles = rolesOf(u.id);
  return u;
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
  requireLogin,
  requireAdmin,
};
