// หน้าผู้ดูแลระบบ: รายชื่อครู กลุ่มสาระ ขั้นตอนการตรวจ แบบประเมิน รายวิชา ตั้งค่า สำรองข้อมูล
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { q, nowStr, getSettings, setSetting, raw } = require('../db');
const auth = require('../auth');
const wf = require('../workflow');
const util = require('../util');
const config = require('../config');
const features = require('../features');
const themes = require('../themes');
const convert = require('../convert');
const drive = require('../drive');

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

router.get('/', (req, res) => {
  const counts = {
    users: q.get('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').n,
    teachers: q.get('SELECT COUNT(*) AS n FROM users WHERE is_active = 1 AND is_teacher = 1').n,
    departments: q.get('SELECT COUNT(*) AS n FROM departments').n,
    subjects: q.get('SELECT COUNT(*) AS n FROM subjects').n,
    rubricManual: q.get("SELECT COUNT(*) AS n FROM rubric_items WHERE is_active = 1 AND doc_type = 'manual'").n,
    rubricPlan: q.get("SELECT COUNT(*) AS n FROM rubric_items WHERE is_active = 1 AND doc_type = 'plan'").n,
    submissions: q.get("SELECT COUNT(*) AS n FROM submissions WHERE status != 'draft'").n,
  };
  res.render('admin/index', {
    title: 'ผู้ดูแลระบบ',
    counts,
    warnings: require('./pages').setupWarnings(),
    addresses: lanAddresses(),
    port: config.PORT,
    dataDir: config.DATA_DIR,
  });
});

// ---------- ผู้ใช้ ----------

function departments() {
  return q.all('SELECT * FROM departments ORDER BY sort, name');
}

router.get('/users', (req, res) => {
  const where = ['1 = 1'];
  const params = [];
  if (Number(req.query.dept)) {
    where.push('u.department_id = ?');
    params.push(Number(req.query.dept));
  }
  if (req.query.q) {
    where.push('(u.full_name LIKE ? OR u.username LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.role) {
    where.push('EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ?)');
    params.push(String(req.query.role));
  }
  const users = q.all(
    `SELECT u.*, d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE ${where.join(' AND ')} ORDER BY u.is_active DESC, d.sort, u.full_name`,
    ...params
  );
  for (const u of users) u.roles = wf.rolesOf(u.id);
  res.render('admin/users', { title: 'รายชื่อผู้ใช้', users, departments: departments(), steps: wf.allSteps(), query: req.query });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user_form', {
    title: 'เพิ่มผู้ใช้',
    u: { is_teacher: 1, is_active: 1, roles: [] },
    departments: departments(),
    steps: wf.allSteps(),
    isNew: true,
  });
});

function userFields(b) {
  return {
    username: String(b.username || '').trim().slice(0, 50),
    full_name: String(b.full_name || '').trim().slice(0, 150),
    position: String(b.position || '').trim().slice(0, 150),
    department_id: Number(b.department_id) || null,
    is_teacher: b.is_teacher ? 1 : 0,
    is_admin: b.is_admin ? 1 : 0,
    is_active: b.is_active ? 1 : 0,
    roles: asArray(b.roles).filter((r) => wf.stepOf(r)),
  };
}

// ชื่อผู้ใช้อัตโนมัติ: ชื่อตัวโดยตัดคำนำหน้าและนามสกุลออก เช่น นายสมชาย ใจดี เป็น สมชาย ซ้ำกันต่อท้ายด้วยเลข สมชาย2
const NAME_PREFIXES = ['ว่าที่ร้อยตรีหญิง', 'ว่าที่ร้อยตรี', 'ว่าที่ ร.ต.หญิง', 'ว่าที่ ร.ต.', 'ว่าที่ร.ต.', 'นางสาว', 'น.ส.', 'นาง', 'นาย', 'ดร.', 'Mrs.', 'Mr.', 'Ms.', 'Miss'];
// สระและวรรณยุกต์ที่ขึ้นต้นคำไม่ได้ ใช้กันตัดผิดในชื่อที่บังเอิญขึ้นต้นด้วย นาย หรือ นาง เช่น นายิกา
const THAI_MARK = /^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;
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

function autoUsername(fullName, taken = new Set()) {
  const base = firstName(fullName);
  if (!base) return '';
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`;
    if (!taken.has(name) && !q.get('SELECT 1 AS x FROM users WHERE username = ?', name)) return name;
  }
}

// ผู้บริหาร (ผู้อำนวยการ รองผู้อำนวยการ) เป็นผู้ดูแลระบบไม่ได้ ตามข้อตกลงของโรงเรียน
const EXEC_ROLES = ['director', 'deputy_academic'];
const EXEC_ADMIN_MSG = 'ผู้อำนวยการและรองผู้อำนวยการเป็นผู้ดูแลระบบไม่ได้ ผู้ดูแลระบบควรเป็นหัวหน้างานส่งเสริมพัฒนากระบวนการเรียนรู้';

function execAdmin(f) {
  return f.is_admin && f.roles.some((r) => EXEC_ROLES.includes(r));
}

function setRoles(userId, roles) {
  q.run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const r of new Set(roles)) q.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', userId, r);
}

router.post('/users', (req, res) => {
  const b = req.body || {};
  const f = userFields(b);
  if (!f.full_name) return fail(req, res, '/admin/users/new', 'กรุณากรอกชื่อ สกุล');
  // เว้นช่องชื่อผู้ใช้ไว้ ระบบตั้งให้จากชื่อจริง
  if (!f.username) f.username = autoUsername(f.full_name);
  if (!f.username) return fail(req, res, '/admin/users/new', 'กรุณากรอกชื่อผู้ใช้');
  const minPw = auth.minPassword(f, req.ff.pin);
  if (String(b.password || '').length < minPw) return fail(req, res, '/admin/users/new', `รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย ${minPw} ตัว`);
  if (q.get('SELECT 1 AS x FROM users WHERE username = ?', f.username)) return fail(req, res, '/admin/users/new', `ชื่อผู้ใช้ ${f.username} มีอยู่แล้ว`);
  if (execAdmin(f)) return fail(req, res, '/admin/users/new', EXEC_ADMIN_MSG);
  const id = q.tx(() => {
    const r = q.run(
      `INSERT INTO users (username, password_hash, must_change_password, full_name, position, department_id, is_teacher, is_admin, is_active, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      f.username,
      auth.hashPassword(b.password),
      f.full_name,
      f.position,
      f.department_id,
      f.is_teacher,
      f.is_admin,
      f.is_active,
      nowStr()
    );
    const newId = Number(r.lastInsertRowid);
    setRoles(newId, f.roles);
    if (f.is_admin) features.audit(req.me, `ให้สิทธิ์ผู้ดูแลระบบแก่ ${f.full_name}`, `user ${newId}`);
    return newId;
  });
  done(req, res, `/admin/users/${id}`, `เพิ่ม ${f.full_name} เรียบร้อย ครั้งแรกที่เข้าระบบจะต้องตั้งรหัสผ่านใหม่`);
});

router.get('/users/:id', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  u.roles = wf.rolesOf(u.id);
  const subCount = q.get('SELECT COUNT(*) AS n FROM submissions WHERE teacher_id = ?', u.id).n;
  res.render('admin/user_form', { title: 'แก้ไขผู้ใช้', u, departments: departments(), steps: wf.allSteps(), isNew: false, subCount });
});

router.post('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const f = userFields(req.body || {});
  const back = `/admin/users/${id}`;
  if (!f.username || !f.full_name) return fail(req, res, back, 'กรุณากรอกชื่อผู้ใช้และชื่อ สกุล');
  if (q.get('SELECT 1 AS x FROM users WHERE username = ? AND id != ?', f.username, id)) return fail(req, res, back, `ชื่อผู้ใช้ ${f.username} มีอยู่แล้ว`);
  if (id === req.me.id && (!f.is_admin || !f.is_active)) return fail(req, res, back, 'ไม่สามารถถอดสิทธิ์ผู้ดูแลหรือปิดบัญชีของตัวเองได้');
  if (execAdmin(f)) return fail(req, res, back, EXEC_ADMIN_MSG);
  q.tx(() => {
    if (f.is_admin !== u.is_admin) {
      features.audit(req.me, `${f.is_admin ? 'ให้' : 'ถอด'}สิทธิ์ผู้ดูแลระบบ${f.is_admin ? 'แก่' : 'ของ'} ${f.full_name}`, `user ${id}`);
    }
    q.run(
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
    setRoles(id, f.roles);
    // งานที่ยังไม่อนุมัติ ย้ายไปอยู่กลุ่มสาระใหม่ตามครู
    if (f.department_id !== u.department_id) {
      q.run("UPDATE submissions SET department_id = ? WHERE teacher_id = ? AND status != 'approved'", f.department_id, id);
    }
  });
  done(req, res, back, 'บันทึกข้อมูลผู้ใช้เรียบร้อย');
});

// จำนวนวิชาที่ครูส่งแผนได้ต่อภาค (ฟังก์ชันแผน 1 วิชาหลัก)
router.post('/users/:id/plan-quota', (req, res) => {
  const id = Number(req.params.id);
  const u = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const n = Math.min(10, Math.max(1, parseInt((req.body || {}).plan_quota, 10) || 1));
  q.tx(() => {
    q.run('UPDATE users SET plan_quota = ? WHERE id = ?', n, id);
    features.audit(req.me, `ตั้งจำนวนแผนต่อภาคของ ${u.full_name} เป็น ${n} วิชา`, `user ${id}`);
  });
  done(req, res, `/admin/users/${id}`, `ตั้งให้ ${u.full_name} ส่งแผนได้ ${n} วิชาต่อภาคแล้ว`);
});

router.post('/users/:id/reset', (req, res) => {
  const id = Number(req.params.id);
  const pw = String((req.body || {}).password || '');
  const must = (req.body || {}).must_change === '1' ? 1 : 0;
  const u = q.get('SELECT id, full_name, is_admin FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin/users', 'ไม่พบผู้ใช้');
  const minPw = auth.minPassword(u, req.ff.pin);
  if (pw.length < minPw) return fail(req, res, `/admin/users/${id}`, `รหัสผ่านของ ${u.full_name} ต้องยาวอย่างน้อย ${minPw} ตัว`);
  q.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', auth.hashPassword(pw), must, id);
  features.audit(req.me, `ตั้งรหัสผ่านใหม่ให้ ${u.full_name}`, `user ${id}`);
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

router.get('/users-import', (req, res) => {
  res.render('admin/users_import', { title: 'นำเข้ารายชื่อครู', result: null, departments: departments(), steps: wf.allSteps() });
});

router.post('/users-import', (req, res) => {
  const b = req.body || {};
  const pw = String(b.password || '');
  const minPw = req.ff.pin ? 4 : 6;
  if (pw.length < minPw) return fail(req, res, '/admin/users-import', `รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย ${minPw} ตัว`);
  const rows = util.parsePasted(b.data);
  const depts = departments();
  const result = { added: 0, updated: 0, errors: [] };
  const hash = auth.hashPassword(pw);
  // ติ๊กสร้างชื่อผู้ใช้อัตโนมัติ: ตารางไม่มีช่องชื่อผู้ใช้ เริ่มที่ชื่อ สกุล
  const auto = b.auto_username === '1';
  const taken = new Set();
  result.auto = auto;
  result.names = [];
  q.tx(() => {
    rows.forEach((cells, i) => {
      if (auto) cells = ['', ...cells];
      let [username, fullName, position = '', deptName = '', roleText = ''] = cells;
      fullName = String(fullName || '').trim();
      if (i === 0 && (auto ? /^ชื่อ/.test(fullName) : /ชื่อผู้ใช้|รหัส|username/i.test(username || ''))) return;
      if (auto && fullName) {
        // นำเข้าซ้ำ: ชื่อ สกุลตรงกับคนที่มีอยู่ ใช้บัญชีเดิม ไม่สร้างซ้ำ
        const same = q.get('SELECT username FROM users WHERE full_name = ?', fullName);
        username = same ? same.username : autoUsername(fullName, taken);
        taken.add(username);
      }
      if (!username || !fullName) {
        result.errors.push(`แถว ${i + 1} ไม่มีชื่อผู้ใช้หรือชื่อ สกุล`);
        return;
      }
      const dept = findDepartment(deptName, depts);
      if (deptName && dept === undefined) {
        result.errors.push(`แถว ${i + 1} ${fullName} ไม่พบกลุ่มสาระ "${deptName}"`);
        return;
      }
      const roles = parseRoles(roleText);
      const isAdmin = roles.includes('admin') ? 1 : 0;
      const stepRoles = roles.filter((r) => r !== 'admin');
      if (execAdmin({ is_admin: isAdmin, roles: stepRoles })) {
        result.errors.push(`แถว ${i + 1} ${fullName} ${EXEC_ADMIN_MSG}`);
        return;
      }
      const teaches = stepRoles.some((r) => ['director', 'deputy_academic'].includes(r)) ? 0 : 1;
      const existing = q.get('SELECT * FROM users WHERE username = ?', username);
      if (existing && existing.is_admin && roleText.trim() && execAdmin({ is_admin: 1, roles: stepRoles })) {
        result.errors.push(`แถว ${i + 1} ${fullName} ${EXEC_ADMIN_MSG}`);
        return;
      }
      if (existing) {
        q.run(
          'UPDATE users SET full_name = ?, position = ?, department_id = COALESCE(?, department_id) WHERE id = ?',
          fullName.slice(0, 150),
          position.slice(0, 150),
          dept ? dept.id : null,
          existing.id
        );
        if (roleText.trim()) setRoles(existing.id, stepRoles);
        result.updated += 1;
      } else {
        const r = q.run(
          `INSERT INTO users (username, password_hash, must_change_password, full_name, position, department_id, is_teacher, is_admin, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          username.slice(0, 50),
          hash,
          fullName.slice(0, 150),
          position.slice(0, 150),
          dept ? dept.id : null,
          teaches,
          isAdmin,
          nowStr()
        );
        setRoles(Number(r.lastInsertRowid), stepRoles);
        result.added += 1;
        result.names.push({ username, fullName });
      }
    });
  });
  res.render('admin/users_import', { title: 'นำเข้ารายชื่อครู', result, departments: depts, steps: wf.allSteps() });
});

// ---------- กลุ่มสาระ ----------

router.get('/departments', (req, res) => {
  const rows = q.all(
    `SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = 1) AS users,
       (SELECT COUNT(*) FROM submissions s WHERE s.department_id = d.id) AS subs,
       (SELECT GROUP_CONCAT(u.full_name, ', ') FROM users u JOIN user_roles r ON r.user_id = u.id
          WHERE u.department_id = d.id AND r.role = 'dept_head' AND u.is_active = 1) AS heads
     FROM departments d ORDER BY d.sort, d.name`
  );
  res.render('admin/departments', { title: 'กลุ่มสาระการเรียนรู้', rows });
});

router.post('/departments', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return fail(req, res, '/admin/departments', 'กรุณากรอกชื่อกลุ่มสาระ');
  if (q.get('SELECT 1 AS x FROM departments WHERE name = ?', name)) return fail(req, res, '/admin/departments', 'มีกลุ่มสาระนี้อยู่แล้ว');
  const sort = q.get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM departments').n;
  q.run('INSERT INTO departments (name, sort) VALUES (?, ?)', name, sort);
  done(req, res, '/admin/departments', `เพิ่มกลุ่มสาระ ${name} เรียบร้อย`);
});

router.post('/departments/:id', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return fail(req, res, '/admin/departments', 'กรุณากรอกชื่อกลุ่มสาระ');
  if (q.get('SELECT 1 AS x FROM departments WHERE name = ? AND id != ?', name, Number(req.params.id))) return fail(req, res, '/admin/departments', 'มีกลุ่มสาระชื่อนี้อยู่แล้ว');
  q.run('UPDATE departments SET name = ?, sort = ? WHERE id = ?', name, Number(b.sort) || 0, Number(req.params.id));
  done(req, res, '/admin/departments', 'บันทึกเรียบร้อย');
});

router.post('/departments/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = q.get('SELECT (SELECT COUNT(*) FROM users WHERE department_id = ?) + (SELECT COUNT(*) FROM submissions WHERE department_id = ?) AS n', id, id).n;
  if (used) return fail(req, res, '/admin/departments', 'ลบไม่ได้ เพราะมีครูหรืองานที่ส่งอยู่ในกลุ่มสาระนี้');
  q.run('DELETE FROM departments WHERE id = ?', id);
  done(req, res, '/admin/departments', 'ลบกลุ่มสาระเรียบร้อย');
});

// ---------- ขั้นตอนการตรวจ ----------

router.get('/workflow', (req, res) => {
  const steps = wf.allSteps().map((st) => ({
    ...st,
    people: q.all(
      `SELECT u.full_name, d.name AS dept_name FROM users u JOIN user_roles r ON r.user_id = u.id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE r.role = ? AND u.is_active = 1 ORDER BY d.sort, u.full_name`,
      st.role
    ),
  }));
  res.render('admin/workflow', { title: 'ขั้นตอนการตรวจ', steps });
});

router.post('/workflow', (req, res) => {
  const b = req.body || {};
  const forManual = asArray(b.for_manual);
  const forPlan = asArray(b.for_plan);
  const forNote = asArray(b.for_note);
  if (!forManual.length || !forPlan.length || !forNote.length) {
    return fail(req, res, '/admin/workflow', 'งานแต่ละชนิดต้องมีผู้ตรวจอย่างน้อย 1 ระดับ');
  }
  q.tx(() => {
    for (const st of wf.allSteps()) {
      const label = String((b.label || {})[st.role] || st.label).trim().slice(0, 100) || st.label;
      q.run(
        'UPDATE workflow_steps SET label = ?, for_manual = ?, for_plan = ?, for_note = ? WHERE role = ?',
        label,
        forManual.includes(st.role) ? 1 : 0,
        forPlan.includes(st.role) ? 1 : 0,
        forNote.includes(st.role) ? 1 : 0,
        st.role
      );
    }
    setSetting('score_role', wf.stepOf(b.score_role) ? b.score_role : '');
    setSetting('resubmit_mode', b.resubmit_mode === 'restart' ? 'restart' : 'resume');
  });
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

router.post('/rubric', (req, res) => {
  const b = req.body || {};
  const type = rubricType(b.type);
  const back = `/admin/rubric?type=${type}`;
  const titles = util.lines(b.items).map((t) => t.replace(/^\d+[.)]\s*/, '').slice(0, 300));
  const max = [3, 4, 5, 10].includes(Number(b.max_score)) ? Number(b.max_score) : 5;
  if (!titles.length) return fail(req, res, back, 'ต้องมีรายการประเมินอย่างน้อย 1 ข้อ');
  q.tx(() => {
    q.run('UPDATE rubric_items SET is_active = 0 WHERE doc_type = ?', type);
    titles.forEach((t, i) => q.run('INSERT INTO rubric_items (doc_type, seq, title, max_score) VALUES (?, ?, ?, ?)', type, i + 1, t, max));
  });
  done(req, res, back, `บันทึกแบบประเมิน${wf.DOC_TYPES[type].label} ${titles.length} ข้อ เรียบร้อย มีผลกับการให้คะแนนครั้งต่อไป`);
});

// ---------- รายวิชา ----------

router.get('/subjects', (req, res) => {
  const rows = q.all('SELECT s.*, d.name AS dept_name FROM subjects s LEFT JOIN departments d ON d.id = s.department_id ORDER BY s.code');
  res.render('admin/subjects', { title: 'รายวิชา', rows, result: null });
});

router.post('/subjects', (req, res) => {
  const rows = util.parsePasted((req.body || {}).data);
  const depts = departments();
  const result = { saved: 0, errors: [] };
  q.tx(() => {
    rows.forEach((cells, i) => {
      const [code, name, deptName = '', grade = ''] = cells;
      if (i === 0 && /รหัส|code/i.test(code || '')) return;
      if (!code || !name) {
        result.errors.push(`แถว ${i + 1} ไม่มีรหัสวิชาหรือชื่อวิชา`);
        return;
      }
      const dept = findDepartment(deptName, depts);
      q.run(
        'INSERT INTO subjects (code, name, department_id, grade) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, department_id = excluded.department_id, grade = excluded.grade',
        code.slice(0, 30),
        name.slice(0, 200),
        dept ? dept.id : null,
        grade.slice(0, 30)
      );
      result.saved += 1;
    });
  });
  const list = q.all('SELECT s.*, d.name AS dept_name FROM subjects s LEFT JOIN departments d ON d.id = s.department_id ORDER BY s.code');
  res.render('admin/subjects', { title: 'รายวิชา', rows: list, result });
});

router.post('/subjects/clear', (req, res) => {
  q.run('DELETE FROM subjects');
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

router.post('/settings', (req, res, next) => {
  logoUpload(req, res, (err) => {
    if (err) return fail(req, res, '/admin/settings', 'ไฟล์โลโก้ต้องเป็นรูป PNG หรือ JPG ขนาดไม่เกิน 1 MB');
    const b = req.body || {};
    try {
      const year = Number(b.academic_year);
      if (!(year >= 2500 && year <= 2700)) return fail(req, res, '/admin/settings', 'ปีการศึกษาต้องเป็นปี พ.ศ. เช่น 2569');
      const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
      setSetting('school_name', String(b.school_name || '').trim().slice(0, 200) || 'โรงเรียนของเรา');
      setSetting('school_location', String(b.school_location || '').trim().slice(0, 200));
      setSetting('academic_year', year);
      setSetting('semester', ['1', '2', '3'].includes(b.semester) ? b.semester : '1');
      setSetting('submit_open', b.submit_open ? '1' : '0');
      setSetting('submit_start', date(b.submit_start));
      setSetting('submit_end', date(b.submit_end));
      setSetting('max_upload_mb', Math.min(100, Math.max(1, Number(b.max_upload_mb) || 20)));
      setSetting('grade_levels', util.lines(b.grade_levels).join('\n'));
      setSetting('teaching_methods', util.lines(b.teaching_methods).join('\n'));
      const url = String(b.public_url || '').trim().replace(/\/+$/, '');
      setSetting('public_url', /^https?:\/\/[^\s]+$/i.test(url) ? url.slice(0, 200) : '');
      const layout = b.mobile_layout === 'classic' ? 'classic' : 'simple';
      if (layout !== (req.settings.mobile_layout || 'simple')) {
        setSetting('mobile_layout', layout);
        features.audit(req.me, `เปลี่ยนการจัดวางบนมือถือเป็น${layout === 'simple' ? 'แบบเรียบง่าย' : 'แบบเต็ม'}`, 'mobile_layout');
      }
      const theme = themes.themeKey(b.theme);
      if (theme !== req.settings.theme) {
        setSetting('theme', theme);
        features.audit(req.me, `เปลี่ยนธีมเป็น ${theme.toUpperCase()} ${themes.THEMES[theme].name}`, 'theme');
      }
      for (const [field, key, remove] of [['logo', 'school_logo', b.remove_logo], ['memo_logo', 'memo_logo', b.remove_memo_logo]]) {
        const file = req.files && req.files[field] && req.files[field][0];
        if (remove) setSetting(key, '');
        else if (file) {
          if (!/^image\/(png|jpeg)$/.test(file.mimetype)) return fail(req, res, '/admin/settings', 'ไฟล์รูปต้องเป็น PNG หรือ JPG');
          setSetting(key, `data:${file.mimetype};base64,${file.buffer.toString('base64')}`);
        }
      }
      done(req, res, '/admin/settings', 'บันทึกการตั้งค่าเรียบร้อย');
    } catch (e) {
      next(e);
    }
  });
});

// ---------- ฟังก์ชันเสริม ----------

router.get('/features', (req, res) => {
  const tab = features.PHRASE_GROUPS.some((g) => g.key === req.query.tab) ? req.query.tab : 'k';
  res.render('admin/features', {
    title: 'ฟังก์ชันเสริม',
    list: features.FEATURES.map((f) => ({ ...f, on: features.isOn(req.settings, f.key) })),
    log: features.auditLog(30),
    groups: features.PHRASE_GROUPS,
    tab,
    phrases: String(req.settings[`phrases_${tab}`] || '')
      .split(/\r?\n/)
      .filter((x) => x.trim()),
    lineReady: Boolean(req.settings.line_token && req.settings.line_to),
    ready: Object.fromEntries(Object.entries(NEEDS).map(([k, [ok]]) => [k, Boolean(ok(req.settings))])),
    convertInfo: { exe: convert.findSoffice(req.settings), custom: req.settings.soffice_path || '', fonts: convert.sarabunFonts() },
    driveInfo: {
      dir: req.settings.drive_dir || '',
      exists: Boolean(req.settings.drive_dir && fs.existsSync(req.settings.drive_dir)),
      stats: drive.stats(),
      when: drive.WHEN,
      // หาโฟลเดอร์ Google Drive เฉพาะตอนกดปุ่ม เพราะต้องไล่ดูทุกไดรฟ์ในเครื่อง
      found: req.query.finddrive ? drive.detectFolders() : null,
    },
  });
});

// ฟังก์ชันที่ต้องตั้งค่าก่อนจึงจะเปิดได้
const NEEDS = {
  line: [(s) => s.line_token && s.line_to, 'ต้องกรอกข้อมูล LINE Official Account ด้านล่างก่อน จึงจะเปิดได้'],
  soffice: [(s) => convert.findSoffice(s), 'ยังไม่พบโปรแกรม LibreOffice ในเครื่องที่เปิดระบบ ติดตั้งตามวิธีในกล่อง ตัวแปลง Word เป็น PDF ก่อน จึงจะเปิดได้'],
  drive: [(s) => s.drive_dir, 'ต้องตั้งโฟลเดอร์ในกล่อง คัดลอกไป Google Drive ก่อน จึงจะเปิดได้'],
};

router.post('/features/:key', (req, res) => {
  const f = features.BY_KEY[req.params.key];
  if (!f) return fail(req, res, '/admin/features', 'ไม่พบฟังก์ชันนี้');
  const on = (req.body || {}).on === '1';
  const need = f.needs && NEEDS[f.needs];
  if (on && need && !need[0](req.settings)) return fail(req, res, '/admin/features', need[1]);
  const changed = features.setFlag(f.key, on, req.me);
  // เพิ่งเปิดคัดลอกไป Drive: คัดลอกงานที่ส่งไว้แล้วทั้งหมดต่อเบื้องหลัง
  if (changed && on && f.key === 'drivecopy') drive.syncAll().catch(() => {});
  done(req, res, '/admin/features', `${on ? 'เปิด' : 'ปิด'} ${f.title} เรียบร้อย${changed && on && f.key === 'drivecopy' ? ' ระบบกำลังคัดลอกงานที่ส่งไว้แล้วไป Google Drive เบื้องหลัง' : ''}`);
});

router.post('/phrases', (req, res) => {
  const b = req.body || {};
  const g = features.PHRASE_GROUPS.find((x) => x.key === b.group);
  if (!g) return fail(req, res, '/admin/features', 'ไม่พบหมวดประโยค');
  const items = util.lines(b.items).map((t) => t.slice(0, 200)).slice(0, 40);
  setSetting(`phrases_${g.key}`, items.join('\n'));
  features.audit(req.me, `แก้ประโยคสำเร็จรูป หมวด${g.label}`, `${items.length} ประโยค`);
  done(req, res, `/admin/features?tab=${g.key}#phrases`, `บันทึกประโยคสำเร็จรูป หมวด${g.label} ${items.length} ประโยค เรียบร้อย`);
});

router.post('/line', (req, res) => {
  const b = req.body || {};
  const time = /^\d{2}:\d{2}$/.test(b.line_time || '') ? b.line_time : '07:00';
  if (b.clear === '1') {
    setSetting('line_token', '');
    setSetting('line_to', '');
    features.setFlag('line', false, req.me);
  } else {
    if (String(b.line_token || '').trim()) setSetting('line_token', String(b.line_token).trim().slice(0, 500));
    setSetting('line_to', String(b.line_to || '').trim().slice(0, 100));
  }
  setSetting('line_time', time);
  features.audit(req.me, b.clear === '1' ? 'ลบการเชื่อมต่อ LINE' : 'ตั้งค่าการเชื่อมต่อ LINE', `เวลาส่ง ${time}`);
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

// ---------- ตัวแปลง Word และ Google Drive ----------

router.post('/convert', (req, res) => {
  const b = req.body || {};
  const p = b.clear === '1' ? '' : String(b.soffice_path || '').trim().slice(0, 500);
  if (p && !convert.fromCustom(p)) return fail(req, res, '/admin/features#convert', 'ไม่พบโปรแกรม LibreOffice ที่ที่อยู่นี้ ตรวจที่อยู่อีกครั้ง หรือเว้นว่างให้ระบบหาเอง');
  setSetting('soffice_path', p);
  features.audit(req.me, 'ตั้งที่อยู่โปรแกรม LibreOffice', p || 'ให้ระบบหาเอง');
  done(req, res, '/admin/features#convert', p ? 'บันทึกที่อยู่โปรแกรม LibreOffice เรียบร้อย' : 'ให้ระบบหาโปรแกรม LibreOffice เองเรียบร้อย');
});

router.post('/drive', (req, res) => {
  const b = req.body || {};
  if (b.clear === '1') {
    setSetting('drive_dir', '');
    features.setFlag('drivecopy', false, req.me);
    features.audit(req.me, 'ลบการตั้งค่าคัดลอกไป Google Drive', 'สำเนาที่คัดลอกไว้แล้วยังอยู่ใน Drive');
    return done(req, res, '/admin/features#drive', 'เลิกคัดลอกไป Google Drive แล้ว สำเนาที่คัดลอกไว้แล้วยังอยู่ใน Drive');
  }
  let dir;
  try {
    dir = drive.prepareFolder(b.drive_dir);
  } catch (e) {
    return fail(req, res, '/admin/features#drive', e.userMessage || 'ใช้โฟลเดอร์นี้ไม่ได้');
  }
  const when = drive.WHEN[b.drive_when] ? b.drive_when : 'submit';
  setSetting('drive_dir', dir);
  setSetting('drive_when', when);
  features.audit(req.me, 'ตั้งค่าคัดลอกไป Google Drive', `${dir} คัดลอก${drive.WHEN[when]}`);
  done(req, res, '/admin/features#drive', `บันทึกโฟลเดอร์ Google Drive เรียบร้อย${req.ff.drivecopy ? '' : ' กดเปิดสวิตช์ คัดลอกแผนและคู่มือไป Google Drive เพื่อเริ่มใช้'}`);
});

router.post('/drive/sync', async (req, res) => {
  if (!req.ff.drivecopy || !req.settings.drive_dir) return fail(req, res, '/admin/features#drive', 'ตั้งโฟลเดอร์และเปิดสวิตช์ คัดลอกแผนและคู่มือไป Google Drive ก่อน');
  let r;
  try {
    r = await drive.syncAll();
  } catch (e) {
    return fail(req, res, '/admin/features#drive', e.userMessage || 'คัดลอกไม่สำเร็จ');
  }
  if (r.failed) return fail(req, res, '/admin/features#drive', `ตรวจ ${r.total} งาน คัดลอกไม่สำเร็จ ${r.failed} งาน เพราะ${r.error}`);
  done(req, res, '/admin/features#drive', `ตรวจ ${r.total} งาน คัดลอกใหม่ ${r.copied} งาน ที่เหลือมีสำเนาล่าสุดใน Drive อยู่แล้ว`);
});

// ---------- สำรองข้อมูล ----------

router.get('/backup', (req, res, next) => {
  const stamp = nowStr().replace(/[: ]/g, '-');
  const tmp = path.join(os.tmpdir(), `plan-backup-${process.pid}-${Date.now()}.db`);
  try {
    raw().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } catch (e) {
    return next(e);
  }
  res.download(tmp, `สำรองฐานข้อมูลระบบส่งแผน_${stamp}.db`, () => {
    fs.unlink(tmp, () => {});
  });
});

module.exports = router;
module.exports.getSettings = getSettings;
