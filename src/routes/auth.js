// เข้าสู่ระบบ ออกจากระบบ ตั้งค่าครั้งแรก เปลี่ยนรหัสผ่าน
const express = require('express');
const { q, nowStr, setSetting } = require('../db');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

function hasUsers() {
  return Boolean(q.get('SELECT 1 AS x FROM users LIMIT 1'));
}

// ครั้งแรกที่เปิดระบบ ยังไม่มีผู้ใช้ ให้สร้างบัญชีผู้ดูแลระบบก่อน
router.use((req, res, next) => {
  if (!hasUsers() && !['/setup'].includes(req.path) && req.method === 'GET') return res.redirect('/setup');
  next();
});

router.get('/setup', (req, res) => {
  if (hasUsers()) return res.redirect('/login');
  res.render('setup', { title: 'ตั้งค่าครั้งแรก', error: null, form: {} });
});

router.post('/setup', (req, res) => {
  if (hasUsers()) return res.redirect('/login');
  const b = req.body || {};
  const form = { school_name: (b.school_name || '').trim(), username: (b.username || '').trim(), full_name: (b.full_name || '').trim() };
  let error = null;
  if (!form.school_name || !form.username || !form.full_name) error = 'กรุณากรอกข้อมูลให้ครบ';
  else if (String(b.password || '').length < 6) error = 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร';
  else if (b.password !== b.password2) error = 'รหัสผ่านสองช่องไม่ตรงกัน';
  if (error) return res.render('setup', { title: 'ตั้งค่าครั้งแรก', error, form });
  setSetting('school_name', form.school_name);
  const r = q.run(
    'INSERT INTO users (username, password_hash, full_name, position, is_teacher, is_admin, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
    form.username,
    auth.hashPassword(b.password),
    form.full_name,
    'ผู้ดูแลระบบ',
    nowStr()
  );
  req.session.uid = Number(r.lastInsertRowid);
  req.flash('success', 'ตั้งค่าเรียบร้อย ขั้นต่อไปให้เพิ่มรายชื่อครูและกำหนดผู้ตรวจแต่ละระดับ');
  res.redirect('/admin');
});

function demoPassword() {
  return config.DEMO ? require('../../scripts/seed-demo').DEMO_PASSWORD : '';
}

function demoAccounts() {
  if (!config.DEMO) return [];
  return q.all(
    `SELECT u.username, u.full_name, u.position, d.name AS dept_name,
       (SELECT GROUP_CONCAT(w.label, ' และ ') FROM user_roles r JOIN workflow_steps w ON w.role = r.role WHERE r.user_id = u.id) AS role_labels,
       u.is_admin
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 ORDER BY u.is_admin DESC, (SELECT MIN(w.seq) FROM user_roles r JOIN workflow_steps w ON w.role = r.role WHERE r.user_id = u.id) IS NULL, (SELECT MIN(w.seq) FROM user_roles r JOIN workflow_steps w ON w.role = r.role WHERE r.user_id = u.id), u.id
     LIMIT 12`
  );
}

// รายชื่อให้เลือกแทนการพิมพ์ชื่อผู้ใช้ (ฟังก์ชันเสริม namepick) จัดกลุ่มตามกลุ่มสาระ
function pickList(req) {
  if (!req.ff.namepick) return [];
  const groups = new Map();
  for (const u of q.all(
    `SELECT u.username, u.full_name, d.name AS dept FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 ORDER BY d.sort IS NULL, d.sort, u.full_name`
  )) {
    const label = u.dept ? `กลุ่มสาระ${u.dept}` : 'ผู้บริหารและผู้ดูแลระบบ';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(u);
  }
  return [...groups].map(([label, users]) => ({ label, users }));
}

function loginPage(req, extra) {
  return { title: 'เข้าสู่ระบบ', error: null, username: '', demoAccounts: demoAccounts(), demoPassword: demoPassword(), pickList: pickList(req), ...extra };
}

router.get('/login', (req, res) => {
  if (req.me) return res.redirect('/');
  res.render('login', loginPage(req));
});

router.post('/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const key = auth.throttleKey(req, username);
  const ukey = auth.userKey(username);
  const fail = (error) => res.status(401).render('login', loginPage(req, { error, username }));
  if (!username) return fail('กรุณาเลือกชื่อ หรือพิมพ์ชื่อผู้ใช้');
  if (auth.isLocked(key) || auth.isLocked(ukey)) return fail('ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่ หรือติดต่อผู้ดูแลระบบ');
  const u = q.get('SELECT * FROM users WHERE username = ? AND is_active = 1', username);
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    auth.recordFail(key);
    auth.recordFail(ukey);
    return fail(req.ff.namepick ? 'รหัสผ่านไม่ถูกต้อง' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  auth.clearFails(key);
  auth.clearFails(ukey);
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowStr(), u.id);
  const back = req.session.returnTo;
  req.session.uid = u.id;
  req.session.returnTo = null;
  res.redirect(u.must_change_password ? '/password' : back && back.startsWith('/') && !back.startsWith('//') ? back : '/');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/password', auth.requireLogin, (req, res) => {
  res.render('password', { title: 'เปลี่ยนรหัสผ่าน', error: null, minPw: auth.minPassword(req.me, req.ff.pin) });
});

router.post('/password', auth.requireLogin, (req, res) => {
  const b = req.body || {};
  const u = q.get('SELECT * FROM users WHERE id = ?', req.me.id);
  let error = null;
  if (!u.must_change_password && !auth.verifyPassword(b.current || '', u.password_hash)) error = 'รหัสผ่านเดิมไม่ถูกต้อง';
  const minPw = auth.minPassword(req.me, req.ff.pin);
  if (error) {
    // ตรวจรหัสเดิมไม่ผ่าน
  } else if (String(b.password || '').length < minPw) error = `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${minPw} ตัว`;
  else if (b.password !== b.password2) error = 'รหัสผ่านใหม่สองช่องไม่ตรงกัน';
  else if (auth.verifyPassword(b.password, u.password_hash)) error = 'กรุณาตั้งรหัสผ่านใหม่ที่ไม่ซ้ำกับรหัสเดิม';
  if (error) return res.render('password', { title: 'เปลี่ยนรหัสผ่าน', error, minPw });
  q.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(b.password), u.id);
  req.flash('success', 'เปลี่ยนรหัสผ่านเรียบร้อย');
  res.redirect('/');
});

module.exports = router;
