// หน้าผู้ดูแลระบบ: รายชื่อครู กลุ่มสาระ ขั้นตอนการตรวจ แบบประเมิน รายวิชา ตั้งค่า สำรองข้อมูล
const os = require('os');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { q, nowStr, getSettings, setSetting } = db;
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const config = require('../config');
const features = require('../features');
const themes = require('../themes');

const router = express.Router();
router.use(auth.requireLogin, auth.requireAdmin);

function done(req, res, url, text) {
  req.flash('success', text);
  res.redirect(url);
}

function fail(req, res, url, text) {
  req.flash('error', text);
  res.redirect(url);
}

function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

router.get('/', async (req, res) => {
  const counts = await q.get(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users,
       (SELECT COUNT(*) FROM users WHERE is_active = 1 AND is_teacher = 1) AS teachers,
       (SELECT COUNT(*) FROM departments) AS departments,
       (SELECT COUNT(*) FROM subjects) AS subjects,
       (SELECT COUNT(*) FROM rubric_items WHERE is_active = 1 AND doc_type = 'manual') AS "rubricManual",
       (SELECT COUNT(*) FROM rubric_items WHERE is_active = 1 AND doc_type = 'plan') AS "rubricPlan",
       (SELECT COUNT(*) FROM submissions WHERE status != 'draft') AS submissions`
  );
  res.render('admin/index', {
    title: 'ผู้ดูแลระบบ',
    counts,
    warnings: await require('./pages').setupWarnings(),
    addresses: lanAddresses(),
    port: config.PORT,
    dataDir: config.DATA_DIR,
  });
});

// ---------- ผู้ใช้ ----------

function departments() {
  return q.all('SELECT * FROM departments ORDER BY sort, name');
}

router.get('/users', async (req, res) => {
  const where = ['1 = 1'];
  const params = [];
  const dept = util.idParam(req.query.dept, { optional: true });
  if (dept) {
    where.push('u.department_id = ?');
    params.push(dept);
  }
  if (req.query.q) {
    where.push("(u.full_name ILIKE ? ESCAPE '' OR u.username ILIKE ? ESCAPE '')");
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.role) {
    where.push('EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ?)');
    params.push(String(req.query.role));
  }
  // ไม่ดึงรหัสผ่านและรูปลายเซ็น (ลายเซ็นแถวละหลายร้อย KB)
  const users = await q.all(
    `SELECT u.id, u.username, u.full_name, u.position, u.department_id, u.is_teacher, u.is_admin, u.is_active,
       u.must_change_password, u.last_login_at, d.name AS dept_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE ${where.join(' AND ')} ORDER BY u.is_active DESC, d.sort NULLS FIRST, u.full_name`,
    ...params
  );
  // บทบาทของทุกคนในคำสั่งเดียว แทนการถามทีละคน
  const roles = new Map();
  for (const r of await q.all('SELECT user_id, role FROM user_roles ORDER BY user_id')) {
    if (!roles.has(r.user_id)) roles.set(r.user_id, []);
    roles.get(r.user_id).push(r.role);
  }
  for (const u of users) u.roles = roles.get(u.id) || [];
  res.render('admin/users', { title: 'รายชื่อผู้ใช้', users, departments: await departments(), steps: wf.allSteps(), query: req.query });
});

router.get('/users/new', async (req, res) => {
  res.render('admin/user_form', {
    title: 'เพิ่มผู้ใช้',
    u: { is_teacher: 1, is_active: 1, roles: [] },
    departments: await departments(),
    steps: wf.allSteps(),
    isNew: true,
  });
});

function userFields(b) {
  return {
    username: String(b.username || '').trim().slice(0, 50),
    full_name: String(b.full_name || '').trim().slice(0, 150),
    position: String(b.position || '').trim().slice(0, 150),
    department_id: util.idOrNull(b.department_id) || null,
    is_teacher: b.is_teacher ? 1 : 0,
    is_admin: b.is_admin ? 1 : 0,
    is_active: b.is_active ? 1 : 0,
    roles: asArray(b.roles).filter((r) => wf.stepOf(r)),
  };
}

// ชื่อผู้ใช้อัตโนมัติ: ชื่อตัวโดยตัดคำนำหน้าและนามสกุลออก เช่น นายสมชาย ใจดี เป็น สมชาย ซ้ำกันต่อท้ายด้วยเลข สมชาย2
const NAME_PREFIXES = ['ว่าที่ร้อยตรีหญิง', 'ว่าที่ร้อยตรี', 'ว่าที่ ร.ต.หญิง', 'ว่าที่ ร.ต.', 'ว่าที่ร.ต.', 'นางสาว', 'น.ส.', 'นาง', 'นาย', 'ดร.', 'Mrs.', 'Mr.', 'Ms.', 'Miss'];
// สระและวรรณยุกต์ที่ขึ้นต้นคำไม่ได้ ใช้กันตัดผิดในชื่อที่บังเอิญขึ้นต้นด้วย นาย หรือ นาง เช่น นายิกา
const THAI_MARK = /^[ัิ-ฺ็-๎]/;
function firstName(fullName) {
  let s = String(fullName || '').trim();
  for (let again = true; again; ) {
    again = false;
    for (const p of NAME_PREFIXES) {
      const rest = s.slice(p.length).trim();
      if (s.startsWith(p) && rest && !THAI_MARK.test(rest)) {
        s = rest;
        again = true;
        break;
      }
    }
  }
  return (s.split(/\s+/)[0] || '').slice(0, 50);
}

// ชื่อผู้ใช้ไม่สนตัวพิมพ์เล็กใหญ่ (unique บน lower(username) เหมือน COLLATE NOCASE ของระบบเดิม)
function usernameTaken(name, exceptId = 0) {
  return q.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?) AND id != ?', name, exceptId);
}

async function autoUsername(fullName, taken = new Set()) {
  const base = firstName(fullName);
  if (!base) return '';
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`;
    if (!taken.has(name) && !(await usernameTaken(name))) return name;
  }
}

// ผู้บริหาร (ผู้อำนวยการ รองผู้อำนวยการ) เป็นผู้ดูแลระบบไม่ได้ ตามข้อตกลงของโรงเรียน
const EXEC_ROLES = ['director', 'deputy_academic'];
const EXEC_ADMIN_MSG = 'ผู้อำนวยการและรองผู้อำนวยการเป็นผู้ดูแลระบบไม่ได้ ผู้ดูแลระบบควรเป็นหัวหน้างานส่งเสริมพัฒนากระบวนการเรียนรู้';

function execAdmin(f) {
  return f.is_admin && f.roles.some((r) => EXEC_ROLES.includes(r));
}

async function setRoles(userId, roles) {
  await q.run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const r of new Set(roles)) await q.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', userId, r);
}

router.post('/users', async (req, res) => {
  const b = req.body || {};
  const f = userFields(b);
  if (!f.full_name) return fail(req, res, '/admin/users/new', 'กรุณากรอกชื่อ สกุล');
  // เว้นช่องชื่อผู้ใช้ไว้ ระบบตั้งให้จากชื่อจริง
  if (!f.username) f.username = await autoUsername(f.full_name);
  if (!f.username) return fail(req, res, '/admin/users/new', 'กรุณากรอกชื่อผู้ใช้');
  const minPw = await auth.minPassword(f, req.ff.pin);
  if (String(b.password || '').length < minPw) return fail(req, res, '/admin/users/new', `รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย ${minPw} ตัว`);
  if (await usernameTaken(f.username)) return fail(req, res, '/admin/users/new', `ชื่อผู้ใช้ ${f.username} มีอยู่แล้ว`);
  if (execAdmin(f)) return fail(req, res, '/admin/users/new', EXEC_ADMIN_MSG);
  const hash = await auth.hashPassword(b.password);
  const id = await q.tx(async () => {
    const r = await q.get(
      `INSERT INTO users (username, password_hash, must_change_password, full_name, position, department_id, is_teacher, is_admin, is_active, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      f.username,
      hash,
      f.full_name,
      f.position,
      f.department_id,
      f.is_teacher,
      f.is_admin,
      f.is_active,
      nowStr()
    );
    await setRoles(r.id, f.roles);
    if (f.is_admin) await features.audit(req.me, `ให้สิทธิ์ผู้ดูแลระบบแก่ ${f.full_name}`, `user ${r.id}`);
    return r.id;
  });
  done(req, res, `/admin/users/${id}`, `เพิ่ม ${f.full_name} เรียบร้อย ครั้งแรกที่เข้าระบบจะต้องตั้งรหัสผ่านใหม่`);
});

// ผู้ใช้หนึ่งคน ไม่ดึงรหัสผ่าน
function loadUser(id) {
  return q.get(
    `SELECT id, username, must_change_password, full_name, position, department_id, is_teacher, is_admin, is_active,
       created_at, last_login_at, plan_quota
     FROM users WHERE id = ?`,
    id
  );
}

router.get('/users/:id', async (req, res) => {
  const id = util.idOrNull(req.params.id);
  const u = id === null ? undefined : await loadUser(id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  u.roles = await wf.rolesOf(u.id);
  const subCount = (await q.get('SELECT COUNT(*) AS n FROM submissions WHERE teacher_id = ?', u.id)).n;
  res.render('admin/user_form', { title: 'แก้ไขผู้ใช้', u, departments: await departments(), steps: wf.allSteps(), isNew: false, subCount });
});

router.post('/users/:id', async (req, res) => {
  const id = util.idOrNull(req.params.id);
  const u = id === null ? undefined : await loadUser(id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const f = userFields(req.body || {});
  const back = `/admin/users/${id}`;
  if (!f.username || !f.full_name) return fail(req, res, back, 'กรุณากรอกชื่อผู้ใช้และชื่อ สกุล');
  if (await usernameTaken(f.username, id)) return fail(req, res, back, `ชื่อผู้ใช้ ${f.username} มีอยู่แล้ว`);
  if (id === req.me.id && (!f.is_admin || !f.is_active)) return fail(req, res, back, 'ไม่สามารถถอดสิทธิ์ผู้ดูแลหรือปิดบัญชีของตัวเองได้');
  if (execAdmin(f)) return fail(req, res, back, EXEC_ADMIN_MSG);
  await q.tx(async () => {
    if (f.is_admin !== u.is_admin) {
      await features.audit(req.me, `${f.is_admin ? 'ให้' : 'ถอด'}สิทธิ์ผู้ดูแลระบบ${f.is_admin ? 'แก่' : 'ของ'} ${f.full_name}`, `user ${id}`);
    }
    await q.run(
      'UPDATE users SET username = ?, full_name = ?, position = ?, department_id = ?, is_teacher = ?, is_admin = ?, is_active = ? WHERE id = ?',
      f.username,
      f.full_name,
      f.position,
      f.department_id,
      f.is_teacher,
      f.is_admin,
      f.is_active,
      id
    );
    await setRoles(id, f.roles);
    // งานที่ยังไม่อนุมัติ ย้ายไปอยู่กลุ่มสาระใหม่ตามครู
    if (f.department_id !== u.department_id) {
      await q.run("UPDATE submissions SET department_id = ? WHERE teacher_id = ? AND status != 'approved'", f.department_id, id);
    }
  });
  done(req, res, back, 'บันทึกข้อมูลผู้ใช้เรียบร้อย');
});

// จำนวนวิชาที่ครูส่งแผนได้ต่อภาค (ฟังก์ชันแผน 1 วิชาหลัก)
router.post('/users/:id/plan-quota', async (req, res) => {
  const id = util.idOrNull(req.params.id);
  const u = id === null ? undefined : await q.get('SELECT id, full_name FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const n = Math.min(10, Math.max(1, parseInt((req.body || {}).plan_quota, 10) || 1));
  await q.tx(async () => {
    await q.run('UPDATE users SET plan_quota = ? WHERE id = ?', n, id);
    await features.audit(req.me, `ตั้งจำนวนแผนต่อภาคของ ${u.full_name} เป็น ${n} วิชา`, `user ${id}`);
  });
  done(req, res, `/admin/users/${id}`, `ตั้งให้ ${u.full_name} ส่งแผนได้ ${n} วิชาต่อภาคแล้ว`);
});

router.post('/users/:id/reset', async (req, res) => {
  const id = util.idOrNull(req.params.id);
  const pw = String((req.body || {}).password || '');
  const must = (req.body || {}).must_change === '1' ? 1 : 0;
  const u = id === null ? undefined : await q.get('SELECT id, full_name, is_admin FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const minPw = await auth.minPassword(u, req.ff.pin);
  if (pw.length < minPw) return fail(req, res, `/admin/users/${id}`, `รหัสผ่านของ ${u.full_name} ต้องยาวอย่างน้อย ${minPw} ตัว`);
  await q.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', await auth.hashPassword(pw), must, id);
  await features.audit(req.me, `ตั้งรหัสผ่านใหม่ให้ ${u.full_name}`, `user ${id}`);
  done(req, res, `/admin/users/${id}`, must ? 'ตั้งรหัสผ่านใหม่เรียบร้อย ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าระบบครั้งถัดไป' : 'ตั้งรหัสผ่านใหม่เรียบร้อย ผู้ใช้ใช้รหัสนี้ต่อได้เลย');
});

// แปลงคำที่พิมพ์ในช่องบทบาท เป็นรหัสบทบาทในระบบ
function parseRoles(text) {
  const out = [];
  for (const part of String(text || '').split(/[,;/|]+|\s+และ\s+/)) {
    const t = part.trim();
    if (!t) continue;
    if (wf.stepOf(t)) out.push(t);
    else if (/รอง/.test(t)) out.push('deputy_academic');
    else if (/^ผอ|ผู้อำนวยการ/.test(t)) out.push('director');
    else if (/วิชาการ/.test(t)) out.push('academic_head');
    else if (/กลุ่มสาระ|หมวด/.test(t)) out.push('dept_head');
    else if (/หัวหน้างาน/.test(t)) out.push('section_head');
    else if (/ผู้ดูแล|admin/i.test(t)) out.push('admin');
  }
  return out;
}

function findDepartment(name, depts) {
  const n = String(name || '').trim();
  if (!n) return null;
  const exact = depts.find((d) => d.name === n);
  if (exact) return exact;
  const partial = depts.filter((d) => d.name.includes(n) || n.includes(d.name));
  return partial.length === 1 ? partial[0] : undefined;
}

router.get('/users-import', async (req, res) => {
  res.render('admin/users_import', { title: 'นำเข้ารายชื่อครู', result: null, departments: await departments(), steps: wf.allSteps() });
});

router.post('/users-import', async (req, res) => {
  const b = req.body || {};
  const pw = String(b.password || '');
  const minPw = req.ff.pin ? 4 : 6;
  if (pw.length < minPw) return fail(req, res, '/admin/users-import', `รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย ${minPw} ตัว`);
  const rows = util.parsePasted(b.data);
  const depts = await departments();
  const result = { added: 0, updated: 0, errors: [] };
  const hash = await auth.hashPassword(pw);
  // ติ๊กสร้างชื่อผู้ใช้อัตโนมัติ: ตารางไม่มีช่องชื่อผู้ใช้ เริ่มที่ชื่อ สกุล
  const auto = b.auto_username === '1';
  const taken = new Set();
  result.auto = auto;
  result.names = [];
  await q.tx(async () => {
    for (let i = 0; i < rows.length; i++) {
      let cells = rows[i];
      if (auto) cells = ['', ...cells];
      let [username, fullName, position = '', deptName = '', roleText = ''] = cells;
      fullName = String(fullName || '').trim();
      if (i === 0 && (auto ? /^ชื่อ/.test(fullName) : /ชื่อผู้ใช้|รหัส|username/i.test(username || ''))) continue;
      if (auto && fullName) {
        // นำเข้าซ้ำ: ชื่อ สกุลตรงกับคนที่มีอยู่ ใช้บัญชีเดิม ไม่สร้างซ้ำ
        const same = await q.get('SELECT username FROM users WHERE full_name = ?', fullName);
        username = same ? same.username : await autoUsername(fullName, taken);
        taken.add(username);
      }
      if (!username || !fullName) {
        result.errors.push(`แถว ${i + 1} ไม่มีชื่อผู้ใช้หรือชื่อ สกุล`);
        continue;
      }
      const dept = findDepartment(deptName, depts);
      if (deptName && dept === undefined) {
        result.errors.push(`แถว ${i + 1} ${fullName} ไม่พบกลุ่มสาระ "${deptName}"`);
        continue;
      }
      const roles = parseRoles(roleText);
      const isAdmin = roles.includes('admin') ? 1 : 0;
      const stepRoles = roles.filter((r) => r !== 'admin');
      if (execAdmin({ is_admin: isAdmin, roles: stepRoles })) {
        result.errors.push(`แถว ${i + 1} ${fullName} ${EXEC_ADMIN_MSG}`);
        continue;
      }
      const teaches = stepRoles.some((r) => ['director', 'deputy_academic'].includes(r)) ? 0 : 1;
      const existing = await q.get('SELECT id, is_admin FROM users WHERE lower(username) = lower(?)', username);
      if (existing && existing.is_admin && roleText.trim() && execAdmin({ is_admin: 1, roles: stepRoles })) {
        result.errors.push(`แถว ${i + 1} ${fullName} ${EXEC_ADMIN_MSG}`);
        continue;
      }
      if (existing) {
        await q.run(
          'UPDATE users SET full_name = ?, position = ?, department_id = COALESCE(?, department_id) WHERE id = ?',
          fullName.slice(0, 150),
          position.slice(0, 150),
          dept ? dept.id : null,
          existing.id
        );
        if (roleText.trim()) await setRoles(existing.id, stepRoles);
        result.updated += 1;
      } else {
        const r = await q.get(
          `INSERT INTO users (username, password_hash, must_change_password, full_name, position, department_id, is_teacher, is_admin, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?) RETURNING id`,
          username.slice(0, 50),
          hash,
          fullName.slice(0, 150),
          position.slice(0, 150),
          dept ? dept.id : null,
          teaches,
          isAdmin,
          nowStr()
        );
        await setRoles(r.id, stepRoles);
        result.added += 1;
        result.names.push({ username, fullName });
      }
    }
  });
  res.render('admin/users_import', { title: 'นำเข้ารายชื่อครู', result, departments: depts, steps: wf.allSteps() });
});

// ---------- กลุ่มสาระ ----------

router.get('/departments', async (req, res) => {
  const rows = await q.all(
    `SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = 1) AS users,
       (SELECT COUNT(*) FROM submissions s WHERE s.department_id = d.id) AS subs,
       (SELECT string_agg(u.full_name, ', ' ORDER BY u.id) FROM users u JOIN user_roles r ON r.user_id = u.id
          WHERE u.department_id = d.id AND r.role = 'dept_head' AND u.is_active = 1) AS heads
     FROM departments d ORDER BY d.sort, d.name`
  );
  res.render('admin/departments', { title: 'กลุ่มสาระการเรียนรู้', rows });
});

router.post('/departments', async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return fail(req, res, '/admin/departments', 'กรุณากรอกชื่อกลุ่มสาระ');
  if (await q.get('SELECT 1 AS x FROM departments WHERE name = ?', name)) return fail(req, res, '/admin/departments', 'มีกลุ่มสาระนี้อยู่แล้ว');
  await q.run('INSERT INTO departments (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM departments))', name);
  done(req, res, '/admin/departments', `เพิ่มกลุ่มสาระ ${name} เรียบร้อย`);
});

router.post('/departments/:id', async (req, res) => {
  const b = req.body || {};
  const id = util.idParam(req.params.id);
  const name = String(b.name || '').trim();
  if (!name) return fail(req, res, '/admin/departments', 'กรุณากรอกชื่อกลุ่มสาระ');
  if (await q.get('SELECT 1 AS x FROM departments WHERE name = ? AND id != ?', name, id)) return fail(req, res, '/admin/departments', 'มีกลุ่มสาระชื่อนี้อยู่แล้ว');
  await q.run('UPDATE departments SET name = ?, sort = ? WHERE id = ?', name, util.intOr(b.sort, 0), id);
  done(req, res, '/admin/departments', 'บันทึกเรียบร้อย');
});

router.post('/departments/:id/delete', async (req, res) => {
  const id = util.idParam(req.params.id);
  const used = (await q.get('SELECT (SELECT COUNT(*) FROM users WHERE department_id = ?) + (SELECT COUNT(*) FROM submissions WHERE department_id = ?) AS n', id, id)).n;
  if (used) return fail(req, res, '/admin/departments', 'ลบไม่ได้ เพราะมีครูหรืองานที่ส่งอยู่ในกลุ่มสาระนี้');
  await q.run('DELETE FROM departments WHERE id = ?', id);
  done(req, res, '/admin/departments', 'ลบกลุ่มสาระเรียบร้อย');
});

// ---------- ขั้นตอนการตรวจ ----------

router.get('/workflow', async (req, res) => {
  const steps = [];
  for (const st of wf.allSteps()) {
    steps.push({
      ...st,
      people: await q.all(
        `SELECT u.full_name, d.name AS dept_name FROM users u JOIN user_roles r ON r.user_id = u.id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE r.role = ? AND u.is_active = 1 ORDER BY d.sort NULLS FIRST, u.full_name`,
        st.role
      ),
    });
  }
  res.render('admin/workflow', { title: 'ขั้นตอนการตรวจ', steps });
});

router.post('/workflow', async (req, res) => {
  const b = req.body || {};
  const forManual = asArray(b.for_manual);
  const forPlan = asArray(b.for_plan);
  const forNote = asArray(b.for_note);
  if (!forManual.length || !forPlan.length || !forNote.length) {
    return fail(req, res, '/admin/workflow', 'งานแต่ละชนิดต้องมีผู้ตรวจอย่างน้อย 1 ระดับ');
  }
  const scoreRole = wf.stepOf(b.score_role) ? b.score_role : '';
  await q.tx(async () => {
    for (const st of wf.allSteps()) {
      const label = String((b.label || {})[st.role] || st.label).trim().slice(0, 100) || st.label;
      await q.run(
        'UPDATE workflow_steps SET label = ?, for_manual = ?, for_plan = ?, for_note = ? WHERE role = ?',
        label,
        forManual.includes(st.role) ? 1 : 0,
        forPlan.includes(st.role) ? 1 : 0,
        forNote.includes(st.role) ? 1 : 0,
        st.role
      );
    }
    await setSetting('score_role', scoreRole);
    await setSetting('resubmit_mode', b.resubmit_mode === 'restart' ? 'restart' : 'resume');
  });
  // ขั้นตอนเปลี่ยน ข้อมูลอ้างอิงที่โหลดไว้ต้องโหลดใหม่
  db.clearRefs();
  done(req, res, '/admin/workflow', 'บันทึกขั้นตอนการตรวจเรียบร้อย');
});

// ---------- แบบประเมิน ----------

function rubricType(v) {
  return v === 'manual' ? 'manual' : 'plan';
}

router.get('/rubric', (req, res) => {
  const type = rubricType(req.query.type);
  const items = wf.rubric(type);
  res.render('admin/rubric', { title: 'แบบประเมิน', type, items, maxScore: items[0] ? items[0].max_score : 5 });
});

router.post('/rubric', async (req, res) => {
  const b = req.body || {};
  const type = rubricType(b.type);
  const back = `/admin/rubric?type=${type}`;
  const titles = util.lines(b.items).map((t) => t.replace(/^\d+[.)]\s*/, '').slice(0, 300));
  const max = [3, 4, 5, 10].includes(Number(b.max_score)) ? Number(b.max_score) : 5;
  if (!titles.length) return fail(req, res, back, 'ต้องมีรายการประเมินอย่างน้อย 1 ข้อ');
  await q.tx(async () => {
    await q.run('UPDATE rubric_items SET is_active = 0 WHERE doc_type = ?', type);
    for (let i = 0; i < titles.length; i++) {
      await q.run('INSERT INTO rubric_items (doc_type, seq, title, max_score) VALUES (?, ?, ?, ?)', type, i + 1, titles[i], max);
    }
  });
  // แบบประเมินเปลี่ยน ข้อมูลอ้างอิงที่โหลดไว้ต้องโหลดใหม่
  db.clearRefs();
  done(req, res, back, `บันทึกแบบประเมิน${wf.DOC_TYPES[type].label} ${titles.length} ข้อ เรียบร้อย มีผลกับการให้คะแนนครั้งต่อไป`);
});

// ---------- รายวิชา ----------

function subjectList() {
  return q.all('SELECT s.*, d.name AS dept_name FROM subjects s LEFT JOIN departments d ON d.id = s.department_id ORDER BY s.code');
}

router.get('/subjects', async (req, res) => {
  res.render('admin/subjects', { title: 'รายวิชา', rows: await subjectList(), result: null });
});

router.post('/subjects', async (req, res) => {
  const rows = util.parsePasted((req.body || {}).data);
  const depts = await departments();
  const result = { saved: 0, errors: [] };
  await q.tx(async () => {
    for (let i = 0; i < rows.length; i++) {
      const [code, name, deptName = '', grade = ''] = rows[i];
      if (i === 0 && /รหัส|code/i.test(code || '')) continue;
      if (!code || !name) {
        result.errors.push(`แถว ${i + 1} ไม่มีรหัสวิชาหรือชื่อวิชา`);
        continue;
      }
      const dept = findDepartment(deptName, depts);
      await q.run(
        'INSERT INTO subjects (code, name, department_id, grade) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, department_id = excluded.department_id, grade = excluded.grade',
        code.slice(0, 30),
        name.slice(0, 200),
        dept ? dept.id : null,
        grade.slice(0, 30)
      );
      result.saved += 1;
    }
  });
  res.render('admin/subjects', { title: 'รายวิชา', rows: await subjectList(), result });
});

router.post('/subjects/clear', async (req, res) => {
  await q.run('DELETE FROM subjects');
  done(req, res, '/admin/subjects', 'ล้างรายการรายวิชาเรียบร้อย');
});

// ---------- ตั้งค่า ----------

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }).fields([
  { name: 'logo', maxCount: 1 },
  { name: 'memo_logo', maxCount: 1 },
]);

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'ตั้งค่าโรงเรียน', themeList: themes.list(), themeOf: (k) => themes.resolve(k) });
});

// บันทึกค่าตั้ง คืนข้อความผิดพลาดถ้ามี (ไม่มีคือสำเร็จ)
// รูปโลโก้เขียนเฉพาะเมื่อแนบไฟล์ใหม่หรือติ๊กลบ ค่า /media/logo?v= ในหน้าเว็บไม่ถูกเขียนกลับทับรูปจริง
async function saveSettings(req) {
  const b = req.body || {};
  const year = Number(b.academic_year);
  if (!(year >= 2500 && year <= 2700)) return 'ปีการศึกษาต้องเป็นปี พ.ศ. เช่น 2569';
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  await setSetting('school_name', String(b.school_name || '').trim().slice(0, 200) || 'โรงเรียนของเรา');
  await setSetting('school_location', String(b.school_location || '').trim().slice(0, 200));
  await setSetting('academic_year', year);
  await setSetting('semester', ['1', '2', '3'].includes(b.semester) ? b.semester : '1');
  await setSetting('submit_open', b.submit_open ? '1' : '0');
  await setSetting('submit_start', date(b.submit_start));
  await setSetting('submit_end', date(b.submit_end));
  await setSetting('max_upload_mb', Math.min(100, Math.max(1, Number(b.max_upload_mb) || 20)));
  await setSetting('grade_levels', util.lines(b.grade_levels).join('\n'));
  await setSetting('teaching_methods', util.lines(b.teaching_methods).join('\n'));
  const url = String(b.public_url || '').trim().replace(/\/+$/, '');
  await setSetting('public_url', /^https?:\/\/[^\s]+$/i.test(url) ? url.slice(0, 200) : '');
  const layout = b.mobile_layout === 'classic' ? 'classic' : 'simple';
  if (layout !== (req.settings.mobile_layout || 'simple')) {
    await setSetting('mobile_layout', layout);
    await features.audit(req.me, `เปลี่ยนการจัดวางบนมือถือเป็น${layout === 'simple' ? 'แบบเรียบง่าย' : 'แบบเต็ม'}`, 'mobile_layout');
  }
  const theme = themes.themeKey(b.theme);
  if (theme !== req.settings.theme) {
    await setSetting('theme', theme);
    await features.audit(req.me, `เปลี่ยนธีมเป็น ${theme.toUpperCase()} ${themes.THEMES[theme].name}`, 'theme');
  }
  for (const [field, key, remove] of [['logo', 'school_logo', b.remove_logo], ['memo_logo', 'memo_logo', b.remove_memo_logo]]) {
    const file = req.files && req.files[field] && req.files[field][0];
    if (remove) await setSetting(key, '');
    else if (file) {
      if (!/^image\/(png|jpeg)$/.test(file.mimetype)) return 'ไฟล์รูปต้องเป็น PNG หรือ JPG';
      await setSetting(key, `data:${file.mimetype};base64,${file.buffer.toString('base64')}`);
    }
  }
  return '';
}

router.post('/settings', (req, res, next) => {
  // callback แบบเก่า Express 5 ไม่จับ error ให้ ทุกทางต้องจบที่ next(e)
  logoUpload(req, res, async (err) => {
    try {
      if (err) return fail(req, res, '/admin/settings', 'ไฟล์โลโก้ต้องเป็นรูป PNG หรือ JPG ขนาดไม่เกิน 1 MB');
      const problem = await saveSettings(req);
      if (problem) return fail(req, res, '/admin/settings', problem);
      done(req, res, '/admin/settings', 'บันทึกการตั้งค่าเรียบร้อย');
    } catch (e) {
      next(e);
    }
  });
});

// ---------- ฟังก์ชันเสริม ----------

router.get('/features', async (req, res) => {
  const tab = features.PHRASE_GROUPS.some((g) => g.key === req.query.tab) ? req.query.tab : 'k';
  res.render('admin/features', {
    title: 'ฟังก์ชันเสริม',
    list: features.FEATURES.map((f) => ({ ...f, on: features.isOn(req.settings, f.key) })),
    log: await features.auditLog(30),
    groups: features.PHRASE_GROUPS,
    tab,
    phrases: String(req.settings[`phrases_${tab}`] || '')
      .split(/\r?\n/)
      .filter((x) => x.trim()),
    lineReady: Boolean(req.settings.line_token && req.settings.line_to),
    ready: Object.fromEntries(Object.entries(NEEDS).map(([k, [ok]]) => [k, Boolean(ok(req.settings))])),
  });
});

// ฟังก์ชันที่ต้องตั้งค่าก่อนจึงจะเปิดได้
const NEEDS = {
  line: [(s) => s.line_token && s.line_to, 'ต้องกรอกข้อมูล LINE Official Account ด้านล่างก่อน จึงจะเปิดได้'],
};

router.post('/features/:key', async (req, res) => {
  const f = features.BY_KEY[req.params.key];
  if (!f) return fail(req, res, '/admin/features', 'ไม่พบฟังก์ชันนี้');
  const on = (req.body || {}).on === '1';
  const need = f.needs && NEEDS[f.needs];
  if (on && need && !need[0](req.settings)) return fail(req, res, '/admin/features', need[1]);
  await features.setFlag(f.key, on, req.me);
  done(req, res, '/admin/features', `${on ? 'เปิด' : 'ปิด'} ${f.title} เรียบร้อย`);
});

router.post('/phrases', async (req, res) => {
  const b = req.body || {};
  const g = features.PHRASE_GROUPS.find((x) => x.key === b.group);
  if (!g) return fail(req, res, '/admin/features', 'ไม่พบหมวดประโยค');
  const items = util.lines(b.items).map((t) => t.slice(0, 200)).slice(0, 40);
  await setSetting(`phrases_${g.key}`, items.join('\n'));
  await features.audit(req.me, `แก้ประโยคสำเร็จรูป หมวด${g.label}`, `${items.length} ประโยค`);
  done(req, res, `/admin/features?tab=${g.key}#phrases`, `บันทึกประโยคสำเร็จรูป หมวด${g.label} ${items.length} ประโยค เรียบร้อย`);
});

router.post('/line', async (req, res) => {
  const b = req.body || {};
  const time = /^\d{2}:\d{2}$/.test(b.line_time || '') ? b.line_time : '07:00';
  if (b.clear === '1') {
    await setSetting('line_token', '');
    await setSetting('line_to', '');
    await features.setFlag('line', false, req.me);
  } else {
    if (String(b.line_token || '').trim()) await setSetting('line_token', String(b.line_token).trim().slice(0, 500));
    await setSetting('line_to', String(b.line_to || '').trim().slice(0, 100));
  }
  await setSetting('line_time', time);
  await features.audit(req.me, b.clear === '1' ? 'ลบการเชื่อมต่อ LINE' : 'ตั้งค่าการเชื่อมต่อ LINE', `เวลาส่ง ${time}`);
  done(req, res, '/admin/features#line', 'บันทึกการตั้งค่า LINE เรียบร้อย');
});

router.post('/line/test', async (req, res) => {
  try {
    await require('../line').sendSummary({ test: true });
    done(req, res, '/admin/features#line', 'ส่งข้อความทดลองเข้า LINE แล้ว ลองเปิดดูในกลุ่ม');
  } catch (e) {
    fail(req, res, '/admin/features#line', `ส่งไม่สำเร็จ ${e.message}`);
  }
});

// ---------- สำรองข้อมูล ----------

// ฐานข้อมูลเป็น Postgres แล้ว VACUUM INTO ของ SQLite ใช้ไม่ได้ ตอน 10 ทำสำรองแบบใหม่ (JSON ทุกตาราง)
router.get('/backup', (req, res) => {
  res.render('error', { title: 'สำรองข้อมูล', message: 'ระบบสำรองข้อมูลกำลังปรับปรุง ยังใช้ไม่ได้ชั่วคราว' });
});

module.exports = router;
module.exports.getSettings = getSettings;
