// หน้าผู้ดูแลระบบ: รายชื่อครู กลุ่มสาระ ขั้นตอนการตรวจ แบบประเมิน รายวิชา ตั้งค่า สำรองข้อมูล
const os = require('os');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { q, nowStr, getSettings, setSetting } = db;
const auth = require('../auth');
const homeorder = require('../homeorder');
const readperm = require('../readperm');
const wf = require('../workflow');
const util = require('../util');
const config = require('../config');
const features = require('../features');
const themes = require('../themes');
const library = require('../library');
const precheck = require('../precheck');
const docno = require('../docno');

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
    // บนคลาวด์ไม่มีวง Wi-Fi (Workers เรียก os.networkInterfaces ไม่ได้) แสดงที่อยู่เว็บจริงแทน
    addresses: config.WORKERS ? [] : lanAddresses(),
    webUrl: require('./verify').baseUrl(req),
    port: config.PORT,
    dataDir: config.DATA_DIR,
    fileStore: config.FILE_STORE,
    filesDir: config.FILES_DIR,
    backupInfo: await backupInfo(req),
    accounts: req.ff.unlock ? await accountInfo() : null,
    sigMissing: req.ff.siglist ? await require('../sigfill').missingList() : null,
    front: req.ff.frontcheck ? await frontInfo() : null,
    // ช่องค้นหาฟังก์ชัน (ฟังก์ชันเสริม adminfind) รายการค้นหาโหลดแยกจาก /admin/find.json
    find: req.ff.adminfind ? { popular: require('../adminfind').POPULAR } : null,
  });
});

// รายการที่ค้นได้ของช่องค้นหาฟังก์ชัน (ฟังก์ชันเสริม adminfind) แยกจากหน้าเพื่อให้หน้าผู้ดูแลเบา
router.get('/find.json', (req, res) => {
  if (!req.ff.adminfind) return res.status(404).json({});
  res.set('Cache-Control', 'no-store');
  res.json(require('../adminfind').items(req.settings, req.ff));
});

// ---------- รายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก (ฟังก์ชันเสริม frontcheck) ----------
async function frontInfo() {
  await db.ensureRefs();
  const { bad, todo } = await precheck.frontRows();
  return { bad: bad.map((r) => ({ ...r, status_text: wf.statusText(r), type_label: wf.DOC_TYPES[r.doc_type].label })), todo: todo.length };
}

function frontOn(req, res) {
  if (req.ff.frontcheck) return true;
  res.status(404).json({ error: 'ฟังก์ชันรายชื่องานที่หน้าแรกน่าจะไม่ใช่ปกปิดอยู่' });
  return false;
}

// งานเดิมที่ยังไม่ได้ตรวจหน้าแรก เครื่องของผู้ดูแลเปิดไฟล์ทีละงานแล้วส่งผลกลับมาทีละไฟล์
router.get('/frontcheck/todo', async (req, res) => {
  if (!frontOn(req, res)) return;
  const { todo } = await precheck.frontRows(true);
  res.json({ items: todo.map((r) => ({ file: r.file, code: r.subject_code })) });
});

// ใส่ผลตรวจเฉพาะไฟล์ที่ยังไม่มีผล (ไม่ทับ ปกถูกแล้ว ที่ผู้ดูแลกดไว้ หรือผลที่ได้ตอนครูส่ง)
router.post('/frontcheck/:file', async (req, res) => {
  if (!frontOn(req, res)) return;
  const id = util.idOrNull(req.params.file);
  const v = (req.body || {}).v;
  if (id === null || !precheck.FRONT_VALUES.includes(v)) return res.status(400).json({ error: 'ผลตรวจใช้ไม่ได้' });
  await q.run("UPDATE files SET front_check = ? WHERE id = ? AND front_check IS NULL AND mime = 'application/pdf'", v, id);
  res.json({ ok: true });
});

// ---------- ไฟล์ในถังขยะ (ฟังก์ชันเสริม trashbin src/trashbin.js) ----------
function trashOn(req, res) {
  if (req.ff.trashbin) return true;
  fail(req, res, '/admin', 'ฟังก์ชันกู้ไฟล์งานจากถังขยะปิดอยู่');
  return false;
}

router.get('/trash', async (req, res) => {
  if (!trashOn(req, res)) return;
  const trashbin = require('../trashbin');
  res.render('admin/trash', { title: 'ไฟล์ในถังขยะ', trash: await trashbin.list(), keepDays: trashbin.KEEP_DAYS });
});

router.get('/trash/:key/file', async (req, res) => {
  if (!trashOn(req, res)) return;
  const it = await require('../trashbin').find(req.params.key);
  if (!it) return fail(req, res, '/admin/trash', 'ไม่พบไฟล์นี้ในถังขยะ');
  await require('./work').sendStored(req, res, { id: req.params.key, stored_name: it.at, size: it.size || 0 }, {
    'Content-Type': it.mime || 'application/octet-stream',
    'Content-Disposition': util.contentDisposition(it.name || 'file', 'attachment'),
    'Cache-Control': 'private, no-store',
  });
});

router.post('/trash/:key/restore', async (req, res) => {
  if (!trashOn(req, res)) return;
  const trashbin = require('../trashbin');
  const it = await trashbin.find(req.params.key);
  if (!it) return fail(req, res, '/admin/trash', 'ไม่พบไฟล์นี้ในถังขยะ');
  try {
    if (req.body && req.body.to === 'work') {
      const id = await trashbin.restoreWork(it, req.me);
      return done(req, res, `/s/${id}`, 'กู้กลับเป็นงานฉบับร่างแล้ว ครูเจ้าของงานตรวจแล้วกดส่งเอง ผู้ตรวจต้องตรวจใหม่');
    }
    await trashbin.restoreDrive(it, req.me);
    done(req, res, '/admin/trash', `กู้ ${it.name} คืนเข้า Google Drive แล้ว ไฟล์อยู่ในโฟลเดอร์เดิม`);
  } catch (e) {
    fail(req, res, '/admin/trash', 'กู้คืนไม่สำเร็จ ' + e.message);
  }
});

// จดประวัติหลังตรวจงานเดิมครบชุด (1 แถวต่อการกด 1 ครั้ง)
router.post('/frontcheck-done', async (req, res) => {
  if (!frontOn(req, res)) return;
  const b = req.body || {};
  await features.audit(req.me, `ตรวจหน้าแรกของงานเดิม ${Math.max(0, util.intOr(b.n, 0))} งาน พบหน้าแรกน่าจะไม่ใช่ปก ${Math.max(0, util.intOr(b.bad, 0))} งาน`, 'frontcheck');
  res.json({ ok: true });
});

// ปกถูกแล้ว: ระบบเดาผิด เอางานออกจากรายการ (เปลี่ยนไฟล์ใหม่เมื่อไร ระบบตรวจไฟล์ใหม่อีกครั้ง)
router.post('/frontcheck/:file/seen', async (req, res) => {
  if (!req.ff.frontcheck) {
    req.flash('error', 'ฟังก์ชันรายชื่องานที่หน้าแรกน่าจะไม่ใช่ปกปิดอยู่');
    return res.redirect('/admin');
  }
  const id = util.idOrNull(req.params.file);
  const r = id === null ? null : await q.get(
    `SELECT s.doc_type, s.subject_code, u.full_name FROM files f JOIN submissions s ON s.id = f.submission_id JOIN users u ON u.id = s.teacher_id WHERE f.id = ?`,
    id
  );
  if (!r) {
    req.flash('error', 'ไม่พบไฟล์นี้');
    return res.redirect('/admin#frontcheck');
  }
  await q.tx(async () => {
    await q.run("UPDATE files SET front_check = 'seen' WHERE id = ?", id);
    await features.audit(req.me, `ยืนยันว่าหน้าแรกเป็นปกถูกแล้ว ${wf.DOC_TYPES[r.doc_type].label} ${r.subject_code} ของ${r.full_name}`, `file ${id}`);
  });
  req.flash('success', `เอา ${r.subject_code} ออกจากรายการแล้ว`);
  res.redirect('/admin#frontcheck');
});

// แจ้งเตือนในระบบถึงครูที่ส่งงานแล้วแต่ยังไม่มีลายเซ็น (ฟังก์ชันเสริม siglist) ผู้ดูแลระบบใส่ลายเซ็นแทนไม่ได้ ได้แค่ตามให้ครูเซ็นเอง
router.post('/sig-remind', async (req, res) => {
  if (!req.ff.siglist) {
    req.flash('error', 'ฟังก์ชันรายชื่องานที่ไม่มีลายเซ็นครูปิดอยู่');
    return res.redirect('/admin');
  }
  const rows = await require('../sigfill').missingList();
  if (!rows.length) {
    req.flash('success', 'ทุกงานมีลายเซ็นครูแล้ว');
    return res.redirect('/admin#sigmissing');
  }
  const now = nowStr();
  // ใส่ให้ทันที (sigfillauto) ครูที่มีลายเซ็นแล้วแค่เปิดหน้าแรก · ปิดอยู่ ต้องกดปุ่มในหน้าข้อมูลส่วนตัว
  const fillHow = req.ff.sigfillauto ? 'เข้าระบบแล้วเปิดหน้าแรก ระบบใส่ลายเซ็นให้เอง' : 'เปิดหน้าข้อมูลส่วนตัว แล้วกด ใส่ลายเซ็นของฉันในงานเหล่านี้';
  await q.tx(async () => {
    for (const r of rows) {
      // งานที่ผู้ดูแลส่งแทน (sigconfirm) ครูต้องเปิดหน้างานแล้วกดยืนยันเองทีละงาน
      const proxyText = req.ff.sigconfirm && r.proxy_n ? `\nงานที่ผู้ดูแลระบบส่งแทนคุณ ${r.proxy_n} งาน เปิดหน้างาน ตรวจ แล้วกด ยืนยันงานนี้และใส่ลายเซ็น` : '';
      const text = r.has_sig
        ? `เรียน คุณครู${r.full_name}\nงานที่ส่งแล้ว ${r.n} งานยังไม่มีลายเซ็นของคุณ ${r.proxy_n === r.n && req.ff.sigconfirm ? '' : fillHow}${proxyText}`
        : `เรียน คุณครู${r.full_name}\nงานที่ส่งแล้ว ${r.n} งานยังไม่มีลายเซ็นของคุณ บันทึกข้อความจึงไม่มีลายเซ็นผู้สอน กรุณาเซ็นชื่อในหน้าข้อมูลส่วนตัว เซ็นครั้งเดียว ระบบใส่ให้ทุกงาน${proxyText}`;
      await q.run(
        'INSERT INTO notifications (user_id, from_user_id, from_name, text, link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        r.id,
        req.me.id,
        `${req.me.full_name} (ผู้ดูแลระบบ)`,
        text,
        '/profile',
        now
      );
    }
  });
  await features.audit(req.me, `ส่งแจ้งเตือนครูที่งานยังไม่มีลายเซ็น ${rows.length} คน`, '');
  req.flash('success', `ส่งแจ้งเตือนในระบบแล้ว ${rows.length} คน ครูจะเห็นข้อความเมื่อเข้าระบบ`);
  res.redirect('/admin#sigmissing');
});

// กล่องบัญชีผู้ใช้ (ฟังก์ชันเสริม unlock): ชื่อที่ถูกใส่รหัสผิด · ยังไม่เคยเข้าระบบ · เข้าแล้วแต่ยังไม่เปลี่ยนรหัสที่ผู้ดูแลตั้งให้
async function accountInfo() {
  const rows = await q.all(
    `SELECT u.id, u.full_name, u.last_login_at, u.must_change_password, d.name AS dept
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 AND (u.last_login_at IS NULL OR u.must_change_password = 1)
     ORDER BY d.sort IS NULL, d.sort, u.full_name`
  );
  const group = (list) => {
    const m = new Map();
    for (const u of list) {
      const label = u.dept ? `กลุ่มสาระ${u.dept}` : 'ผู้บริหารและผู้ดูแลระบบ';
      if (!m.has(label)) m.set(label, []);
      m.get(label).push(u);
    }
    return { n: list.length, groups: [...m].map(([label, users]) => ({ label, users })) };
  };
  return {
    failed: (await auth.failedLogins()).map((f) => ({ ...f, untilText: f.locked ? nowStr(new Date(f.until)).slice(11, 16) : '' })),
    never: group(rows.filter((u) => !u.last_login_at)),
    oldPw: group(rows.filter((u) => u.last_login_at && u.must_change_password)),
  };
}

// สถานะสำรอง 3 ชนิด สำหรับกล่องสำรองข้อมูล
async function backupInfo(req) {
  const s = req.settings;
  return {
    problem: await require('../jobs').backupStatus(),
    okAt: s.backup_ok_at || '',
    monthAt: s.backup_month_at || '',
    monthN: Number(s.backup_month_n) || 0,
    termAt: s.backup_term_at || '',
    termLabel: s.backup_term_label || '',
    termN: Number(s.backup_term_n) || 0,
    term: `${s.semester}/${s.academic_year}`,
  };
}

// ---------- ผู้ใช้ ----------

// ปลดล็อกบัญชีที่ใส่รหัสผิดหลายครั้ง (ฟังก์ชันเสริม unlock) ล้างตัวนับทุกเครื่องของชื่อนี้ บันทึกใน audit_log
router.post('/users/:id/unlock', async (req, res) => {
  if (!req.ff.unlock) return fail(req, res, '/admin', 'ฟังก์ชันปลดล็อกบัญชีปิดอยู่');
  const id = util.idOrNull(req.params.id);
  const u = id === null ? undefined : await q.get('SELECT id, username, full_name FROM users WHERE id = ?', id);
  if (!u) return fail(req, res, '/admin#accounts', 'ไม่พบผู้ใช้');
  const n = await auth.unlockUser(u.username);
  await features.audit(req.me, `ปลดล็อกบัญชีของ ${u.full_name}`, `user ${id} ใส่รหัสผิด ${n} ครั้ง`);
  done(req, res, '/admin#accounts', `ปลดล็อกบัญชีของ ${u.full_name} เรียบร้อย เข้าสู่ระบบได้ทันที`);
});

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

function userFields(b, ff = {}) {
  const name = String(b.full_name || '').trim();
  return {
    username: String(b.username || '').trim().slice(0, 50),
    full_name: (ff.namefix ? util.fixName(name) : name).slice(0, 150),
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

// ชื่อผู้ใช้ที่ลองตามลำดับ สมชาย สมชาย2 สมชาย3 ไปเรื่อย ๆ
function* usernameCandidates(fullName) {
  const base = firstName(fullName);
  if (!base) return;
  for (let n = 1; ; n++) yield n === 1 ? base : `${base}${n}`;
}

async function autoUsername(fullName, taken = new Set()) {
  for (const name of usernameCandidates(fullName)) if (!taken.has(name) && !(await usernameTaken(name))) return name;
  return '';
}

// ผู้บริหาร (ผู้อำนวยการ รองผู้อำนวยการ) เป็นผู้ดูแลระบบไม่ได้ ตามข้อตกลงของโรงเรียน
const EXEC_ROLES = ['director', 'deputy_academic'];
const EXEC_ADMIN_MSG = 'ผู้อำนวยการและรองผู้อำนวยการเป็นผู้ดูแลระบบไม่ได้ ผู้ดูแลระบบควรเป็นหัวหน้างานส่งเสริมพัฒนากระบวนการเรียนรู้';

function execAdmin(f) {
  return f.is_admin && f.roles.some((r) => EXEC_ROLES.includes(r));
}

async function setRoles(userId, roles) {
  await q.run('DELETE FROM user_roles WHERE user_id = ?', userId);
  const list = [...new Set(roles)];
  if (list.length) await q.run('INSERT INTO user_roles (user_id, role) SELECT ?, r FROM unnest(?::text[]) WITH ORDINALITY AS x(r, n) ORDER BY n', userId, list);
}

router.post('/users', async (req, res) => {
  const b = req.body || {};
  const f = userFields(b, req.ff);
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
  const f = userFields(req.body || {}, req.ff);
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

// เขียนผลการนำเข้ารายชื่อลงฐานรวดเดียว ไม่ว่ากี่คน: เพิ่มคนใหม่ · แก้คนเดิม · ลบแล้วใส่บทบาทใหม่ (ไม่เกิน 4 คำสั่ง)
async function saveImported(users, hash) {
  const fresh = users.filter((u) => u.fresh);
  if (fresh.length) {
    const added = await q.all(
      `INSERT INTO users (username, password_hash, must_change_password, full_name, position, department_id, is_teacher, is_admin, created_at)
       SELECT v.username, ?, 1, v.full_name, v.position, v.dept, v.is_teacher, v.is_admin, ?
       FROM unnest(?::text[], ?::text[], ?::text[], ?::int[], ?::int[], ?::int[]) WITH ORDINALITY AS v(username, full_name, position, dept, is_teacher, is_admin, n)
       ORDER BY v.n
       RETURNING id, username`,
      hash,
      nowStr(),
      fresh.map((u) => u.username),
      fresh.map((u) => u.full_name),
      fresh.map((u) => u.position),
      fresh.map((u) => u.dept),
      fresh.map((u) => u.is_teacher),
      fresh.map((u) => u.is_admin)
    );
    const ids = new Map(added.map((r) => [r.username, r.id]));
    for (const u of fresh) u.id = ids.get(u.username);
  }
  const changed = users.filter((u) => u.changed && !u.fresh);
  if (changed.length) {
    await q.run(
      `UPDATE users u SET full_name = v.full_name, position = v.position, department_id = COALESCE(v.dept, u.department_id)
       FROM unnest(?::int[], ?::text[], ?::text[], ?::int[]) AS v(id, full_name, position, dept)
       WHERE u.id = v.id`,
      changed.map((u) => u.id),
      changed.map((u) => u.full_name),
      changed.map((u) => u.position),
      changed.map((u) => (u.dept === undefined ? null : u.dept))
    );
  }
  const withRoles = users.filter((u) => u.roles);
  if (withRoles.length) {
    const old = withRoles.filter((u) => !u.fresh).map((u) => u.id);
    if (old.length) await q.run('DELETE FROM user_roles WHERE user_id = ANY(?)', old);
    const pairs = withRoles.flatMap((u) => [...new Set(u.roles)].map((r) => [u.id, r]));
    if (pairs.length) {
      await q.run(
        'INSERT INTO user_roles (user_id, role) SELECT x.user_id, x.role FROM unnest(?::int[], ?::text[]) WITH ORDINALITY AS x(user_id, role, n) ORDER BY x.n',
        pairs.map((p) => p[0]),
        pairs.map((p) => p[1])
      );
    }
  }
}

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
    // อ่านผู้ใช้ทุกคนครั้งเดียว แล้วไล่ทีละแถวในหน่วยความจำ (แถวหลังเห็นผลของแถวก่อนเหมือนเขียนฐานทีละแถว) ค่อยเขียนฐานรวดเดียวตอนท้าย
    // ชื่อผู้ใช้ไม่สนตัวพิมพ์เล็กใหญ่แบบ lower() ของฐาน (เฉพาะ A ถึง Z)
    const low = (x) => String(x).replace(/[A-Z]/g, (c) => c.toLowerCase());
    const users = await q.all('SELECT id, username, full_name, is_admin FROM users ORDER BY id');
    const findUser = (name) => users.find((u) => low(u.username) === low(name));
    for (let i = 0; i < rows.length; i++) {
      let cells = rows[i];
      if (auto) cells = ['', ...cells];
      let [username, fullName, position = '', deptName = '', roleText = ''] = cells;
      fullName = String(fullName || '').trim();
      if (req.ff.namefix) fullName = util.fixName(fullName);
      if (i === 0 && (auto ? /^ชื่อ/.test(fullName) : /ชื่อผู้ใช้|รหัส|username/i.test(username || ''))) continue;
      if (auto && fullName) {
        // นำเข้าซ้ำ: ชื่อ สกุลตรงกับคนที่มีอยู่ ใช้บัญชีเดิม ไม่สร้างซ้ำ
        const same = users.find((u) => u.full_name === fullName);
        username = '';
        if (same) username = same.username;
        else for (const name of usernameCandidates(fullName)) if (!taken.has(name) && !findUser(name)) { username = name; break; }
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
      const existing = findUser(username);
      if (existing && existing.is_admin && roleText.trim() && execAdmin({ is_admin: 1, roles: stepRoles })) {
        result.errors.push(`แถว ${i + 1} ${fullName} ${EXEC_ADMIN_MSG}`);
        continue;
      }
      if (existing) {
        // กลุ่มสาระว่าง ใช้ของเดิม (COALESCE)
        existing.full_name = fullName.slice(0, 150);
        existing.position = position.slice(0, 150);
        if (dept) existing.dept = dept.id;
        if (roleText.trim()) existing.roles = stepRoles;
        existing.changed = true;
        result.updated += 1;
      } else {
        users.push({
          id: null,
          username: username.slice(0, 50),
          full_name: fullName.slice(0, 150),
          position: position.slice(0, 150),
          dept: dept ? dept.id : null,
          is_teacher: teaches,
          is_admin: isAdmin,
          roles: stepRoles,
          fresh: true,
        });
        result.added += 1;
        result.names.push({ username, fullName });
      }
    }
    await saveImported(users, hash);
    // เตือนชื่อที่ยังไม่มีคำนำหน้า (ไม่บล็อก บางคนอาจใช้ยศหรือคำนำหน้าแบบอื่น)
    result.noTitle = req.ff.namefix ? users.filter((u) => (u.fresh || u.changed) && !util.hasTitle(u.full_name)).map((u) => u.full_name) : [];
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
  // ผู้ถือบทบาททุกระดับในคำสั่งเดียว แล้วแยกตามบทบาทโดยคงลำดับ
  const people = new Map();
  for (const { role, ...p } of await q.all(
    `SELECT r.role, u.full_name, d.name AS dept_name FROM users u JOIN user_roles r ON r.user_id = u.id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 ORDER BY d.sort NULLS FIRST, u.full_name, u.id`
  )) {
    if (!people.has(role)) people.set(role, []);
    people.get(role).push(p);
  }
  const steps = wf.allSteps().map((st) => ({ ...st, people: people.get(st.role) || [] }));
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

// แผนและคู่มือที่มีเลขที่บันทึกข้อความ สำหรับปรับเลขย้อนหลัง (docno.reformat)
function docNoRows() {
  return q.all("SELECT id, doc_no, academic_year, submitted_at FROM submissions WHERE doc_type IN ('plan', 'manual') AND COALESCE(doc_no, '') != '' ORDER BY id");
}

router.get('/settings', async (req, res) => {
  const site = require('../site');
  // ปุ่มปรับเลขย้อนหลัง: บอกจำนวนและตัวอย่างก่อนกด
  const docnoFix = req.ff.docnoreq ? docno.reformat(req.settings, await docNoRows()) : [];
  res.render('admin/settings', { title: 'ตั้งค่าโรงเรียน', themeList: themes.list(), webFonts: themes.webFontChoices(req.settings.theme), fxLevels: themes.FX_LEVELS, fxDefault: themes.FX_DEFAULT, themeOf: (k) => themes.resolve(k), siteFields: site.FIELDS, siteIcons: site.ICONS, docnoFix });
});

// ---------- สิทธิ์อ่านงานในคลัง (ฟังก์ชันเสริม readperm) ----------
router.get('/readperm', async (req, res) => {
  if (!req.ff.library || !req.ff.readperm) return fail(req, res, '/admin', 'ปิดฟังก์ชันสิทธิ์อ่านงานอยู่');
  const cfg = readperm.config(req.settings, req.ff);
  const users = await q.all('SELECT id, full_name FROM users WHERE is_active = 1 AND is_teacher = 1 ORDER BY full_name');
  const nameOf = new Map(users.map((u) => [u.id, u.full_name]));
  res.render('admin/readperm', {
    title: 'สิทธิ์อ่านงานในคลัง',
    cfg,
    levels: readperm.LEVELS,
    label: readperm.LABEL,
    users,
    people: cfg.people.filter((p) => nameOf.has(p.id)).map((p) => ({ ...p, name: nameOf.get(p.id) })),
    tempActive: readperm.stillOn(cfg.tempUntil),
  });
});

router.post('/readperm', async (req, res) => {
  if (!req.ff.library || !req.ff.readperm) return fail(req, res, '/admin', 'ปิดฟังก์ชันสิทธิ์อ่านงานอยู่');
  const b = req.body || {};
  if (b.action === 'reset') {
    for (const [k, v] of [['read_teacher', 'cover'], ['read_depthead', 'dept'], ['read_unapproved', '0'], ['read_temp_on', '0'], ['read_temp_until', ''], ['read_people', '[]']]) await setSetting(k, v);
    await features.audit(req.me, 'กลับสิทธิ์อ่านงานเป็นค่าเริ่มต้น', 'read_perm');
    return done(req, res, '/admin/readperm', 'กลับเป็นค่าเริ่มต้นแล้ว');
  }
  const tempOn = Boolean(b.read_temp_on);
  const until = readperm.inDate(b.read_temp_until) ? b.read_temp_until : '';
  if (tempOn && !until) return fail(req, res, '/admin/readperm', 'เปิดชั่วคราวต้องเลือกวันสิ้นสุดก่อน');
  const teacher = readperm.LEVELS.includes(b.read_teacher) ? b.read_teacher : 'cover';
  const depthead = b.read_depthead === 'all' ? 'all' : 'dept';
  const ids = asArray(b.person_id);
  const levels = asArray(b.person_level);
  const untils = asArray(b.person_until);
  const seen = new Set();
  const people = [];
  ids.forEach((raw, i) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || seen.has(id)) return;
    seen.add(id);
    people.push({ id, level: levels[i] === 'dept' ? 'dept' : 'all', until: readperm.inDate(untils[i]) ? untils[i] : '' });
  });
  await setSetting('read_teacher', teacher);
  await setSetting('read_depthead', depthead);
  await setSetting('read_unapproved', b.read_unapproved ? '1' : '0');
  await setSetting('read_temp_on', tempOn ? '1' : '0');
  await setSetting('read_temp_until', until);
  await setSetting('read_people', JSON.stringify(people));
  await features.audit(
    req.me,
    `ตั้งสิทธิ์อ่านงาน ครูทั่วไป${readperm.LABEL[teacher]} หัวหน้ากลุ่มสาระ${readperm.LABEL[depthead]} เล่มที่ยังไม่ผ่านครบ${b.read_unapproved ? 'เปิด' : 'ปิด'} ชั่วคราว${tempOn ? 'ถึง ' + until : 'ปิด'} รายคน ${people.length} คน`,
    'read_perm'
  );
  done(req, res, '/admin/readperm', 'บันทึกสิทธิ์อ่านงานแล้ว มีผลทันที');
});

// ---------- ลำดับหน้าแรก (ฟังก์ชันเสริม homeorder) ----------
router.get('/homeorder', (req, res) => {
  if (!req.ff.homelayout || !req.ff.homeorder) return fail(req, res, '/admin', 'ปิดฟังก์ชันจัดลำดับหน้าแรกอยู่');
  res.render('admin/homeorder', {
    title: 'ลำดับหน้าแรก',
    boxes: homeorder.parse(req.settings.home_order),
    mobileBoxes: homeorder.parseMobile(req.settings.home_order_m).filter((b) => b.k !== 'stats' || req.ff.statslim),
    mMode: req.settings.home_order_m_mode === 'same' ? 'same' : 'own',
    alertsPc: req.settings.home_alerts_pc !== '0',
    alertsM: req.settings.home_alerts_m !== '0',
  });
});

router.post('/homeorder', async (req, res) => {
  if (!req.ff.homelayout || !req.ff.homeorder) return fail(req, res, '/admin', 'ปิดฟังก์ชันจัดลำดับหน้าแรกอยู่');
  if (req.body.action === 'reset') {
    await setSetting('home_order', '');
    await setSetting('home_order_m', '');
    await setSetting('home_order_m_mode', 'own');
    await setSetting('home_alerts_pc', '1');
    await setSetting('home_alerts_m', '1');
    await features.audit(req.me, 'กลับลำดับหน้าแรกเป็นค่าเริ่มต้น', 'home_order');
    return done(req, res, '/admin/homeorder', 'กลับเป็นลำดับเริ่มต้นแล้ว');
  }
  const list = homeorder.parse(req.body.home_order);
  await setSetting('home_order', homeorder.serialize(list));
  await setSetting('home_alerts_pc', req.body.home_alerts_pc ? '1' : '0');
  if (req.ff.mobileorder) {
    await setSetting('home_order_m', homeorder.serialize(homeorder.parseMobile(req.body.home_order_m)));
    await setSetting('home_order_m_mode', req.body.home_order_m_mode === 'same' ? 'same' : 'own');
    await setSetting('home_alerts_m', req.body.home_alerts_m ? '1' : '0');
  }
  await features.audit(req.me, `จัดลำดับหน้าแรกเป็น ${list.filter((b) => b.on).map((b) => b.label).join(' ')}`, 'home_order');
  done(req, res, '/admin/homeorder', 'บันทึกลำดับหน้าแรกแล้ว ครูทุกคนเห็นทันที');
});

// ---------- ทะเบียนเลขที่บันทึกข้อความ (ฟังก์ชันเสริม docnoreg) ----------
// เลขซ้ำคิดจากทั้งปีการศึกษา แล้วจึงกรองตามภาคเรียน ประเภท กลุ่มสาระ คำค้น

function docnoRegOn(req, res) {
  if (req.ff.docnoreg) return true;
  fail(req, res, '/admin', 'ฟังก์ชันทะเบียนเลขที่บันทึกข้อความปิดอยู่');
  return false;
}

async function docnoRegister(req) {
  const docnoreg = require('../docnoreg');
  const qy = req.query || {};
  const years = (await q.all('SELECT DISTINCT academic_year AS y FROM submissions ORDER BY academic_year DESC')).map((r) => Number(r.y));
  const cur = Number(req.settings.academic_year);
  if (cur && !years.includes(cur)) years.unshift(cur);
  const year = years.includes(Number(qy.year)) ? Number(qy.year) : cur || years[0];
  const rows = await q.all(
    `SELECT s.id, s.doc_type, s.parent_id, s.teacher_id, s.academic_year, s.semester, s.subject_code, s.subject_name, s.doc_no,
            s.status, s.current_role, s.submitted_at, s.updated_at, u.full_name AS teacher_name, d.id AS dept_id, d.name AS dept_name, d.sort AS dept_sort
     FROM submissions s JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.academic_year = ? AND s.status != 'draft'`,
    year
  );
  const reg = docnoreg.build(rows, { notes: req.ff.notedocno });
  const f = {
    view: qy.view === 'teacher' ? 'teacher' : 'num',
    year,
    semester: ['1', '2'].includes(String(qy.semester)) ? Number(qy.semester) : 0,
    type: docnoreg.SUBJECT[qy.type] ? qy.type : '',
    department: util.idOrNull(qy.department) || 0,
    q: String(qy.q || '').trim().slice(0, 60),
  };
  const kw = f.q.toLowerCase();
  const keep = (e) =>
    (!f.semester || Number(e.semester) === f.semester) &&
    (!f.type || e.type === f.type) &&
    (!f.department || e.dept_id === f.department) &&
    (!kw || [e.doc_no, e.teacher_name, ...e.subjects.flatMap((s) => [s.code, s.name])].some((v) => String(v || '').toLowerCase().includes(kw)));
  const numbered = reg.numbered.filter(keep);
  const missing = reg.missing.filter(keep);
  return { f, years, numbered, missing, depts: f.view === 'teacher' ? docnoreg.byDept([...numbered, ...missing]) : [], docnoreg };
}

router.get('/docnoreg', async (req, res) => {
  if (!docnoRegOn(req, res)) return;
  const r = await docnoRegister(req);
  res.render('admin/docnoreg', {
    title: 'ทะเบียนเลขที่บันทึกข้อความ',
    ...r,
    departments: await q.all('SELECT id, name FROM departments ORDER BY sort, name'),
  });
});

// ส่งออก: .xlsx (หัวตารางตัวหนา คอลัมน์พอดี) หรือ .csv · เรียงตามมุมมองที่เปิดอยู่ งานที่ไม่มีเลขต่อท้าย
router.get(/^\/docnoreg\.(xlsx|csv)$/, async (req, res) => {
  if (!docnoRegOn(req, res)) return;
  const ext = req.params[0];
  const { f, numbered, missing, depts, docnoreg } = await docnoRegister(req);
  const list = f.view === 'teacher' ? depts.flatMap((d) => d.teachers.flatMap((t) => [...t.manual, ...t.plan, ...t.note])) : [...numbered, ...missing];
  const head = ['ลำดับ', 'เลขที่', 'ลงวันที่', 'จาก', 'กลุ่มสาระ', 'เรื่อง', 'รายวิชา', 'ภาคเรียน', 'สถานะ', 'หมายเหตุ'];
  const rows = list.map((e, i) => [
    i + 1,
    e.doc_no,
    util.thaiDate(e.submitted_at),
    e.teacher_name,
    e.dept_name,
    e.title,
    docnoreg.subjectText(e) + (e.type === 'note' ? ` (${e.sheets} แผ่น)` : ''),
    `${e.semester}/${e.academic_year}`,
    wf.statusText(e.status),
    !e.doc_no ? 'ยังไม่มีเลข' : e.dup ? 'เลขซ้ำ' : '',
  ]);
  const term = f.semester ? `ภาค${f.semester}-${f.year}` : String(f.year);
  res.set('Content-Disposition', util.contentDisposition(`ทะเบียนเลขที่บันทึกข้อความ_${term}.${ext}`));
  if (ext === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    return res.send(util.toCsv([head, ...rows]));
  }
  const xlsx = require('../xlsx');
  const title = `ทะเบียนเลขที่บันทึกข้อความ ${f.semester ? `ภาคเรียนที่ ${f.semester}/${f.year}` : `ปีการศึกษา ${f.year}`} (ส่งออกเมื่อ ${util.thaiDate(nowStr())})`;
  const bytes = xlsx.build({ sheet: 'ทะเบียนเลข', title, head, rows, widths: [7, 16, 16, 24, 24, 30, 40, 10, 22, 14], marked: (r) => r[9] !== '' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(bytes));
});

// เติมเลขให้งานที่ส่งแล้วแต่ไม่มีเลข จากหน้าทะเบียน: งาน (แผน คู่มือ) หรือบันทึกหลังแผนทั้งเล่ม
// ผู้ดูแลระบบเติมแทนครู ไม่เปลี่ยนสถานะงาน บันทึกในประวัติของงานและประวัติการใช้งาน · งานของตัวเองกรอกในหน้างาน
router.post('/docnoreg/no', async (req, res) => {
  if (!docnoRegOn(req, res)) return;
  const b = req.body || {};
  const back = /^\/admin\/docnoreg(\?\S*)?$/.test(String(b.back || '')) ? String(b.back) : '/admin/docnoreg';
  const num = docno.cleanNum(b.doc_no_num);
  if (!num) return fail(req, res, back, 'กรุณาพิมพ์เลขที่บันทึกข้อความเป็นตัวเลข');
  const id = util.idOrNull(b.id);
  if (!id) return fail(req, res, back, 'ไม่พบงานนี้');
  if (b.kind === 'book') {
    const notes = await q.all("SELECT id, doc_no, submitted_at, updated_at, academic_year, subject_code, teacher_id FROM submissions WHERE parent_id = ? AND doc_type = 'note'", id);
    if (!notes.length) return fail(req, res, back, 'ไม่พบบันทึกหลังแผนของเล่มนี้');
    if (notes[0].teacher_id === req.me.id) return fail(req, res, back, 'งานของตัวเองให้กรอกเลขในหน้างาน');
    const no = docno.format(req.settings, num, docno.yearOf(req.settings, { academic_year: notes[0].academic_year, submitted_at: require('../notememo').bookDate(notes) || null }));
    await q.run("UPDATE submissions SET doc_no = ? WHERE parent_id = ? AND doc_type = 'note'", no, id);
    await features.audit(req.me, 'เติมเลขบันทึกข้อความส่งบันทึกหลังสอนแทนครู จากหน้าทะเบียนเลข', `แผน ${id} ${notes[0].subject_code} เป็น ${no}`);
    return done(req, res, back, `บันทึกเลขที่ ${no} ให้บันทึกหลังแผนทั้งเล่มแล้ว`);
  }
  const sub = await q.get(
    "SELECT s.id, s.doc_type, s.doc_no, s.academic_year, s.submitted_at, s.subject_code, s.teacher_id, s.status, u.full_name AS teacher_name FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.id = ? AND s.doc_type IN ('plan', 'manual')",
    id
  );
  if (!sub || sub.status === 'draft') return fail(req, res, back, 'ไม่พบงานนี้');
  if (sub.teacher_id === req.me.id) return fail(req, res, back, 'งานของตัวเองให้กรอกเลขในหน้างาน');
  const no = docno.format(req.settings, num, docno.yearOf(req.settings, sub));
  await q.run('UPDATE submissions SET doc_no = ? WHERE id = ?', no, sub.id);
  await wf.log(sub.id, req.me, { step_label: 'ผู้ดูแลระบบ', action: 'docno', comment: `${sub.doc_no ? sub.doc_no + ' เป็น ' : ''}${no}` });
  await features.audit(req.me, `เติมเลขที่บันทึกข้อความใน${wf.DOC_TYPES[sub.doc_type].label} ${sub.subject_code} ของ ${sub.teacher_name} จากหน้าทะเบียนเลข`, `submission ${sub.id} เป็น ${no}`);
  done(req, res, back, `บันทึกเลขที่ ${no} แล้ว`);
});

// ปรับเลขที่บันทึกข้อความทุกงานให้เป็นรูปแบบปัจจุบัน (คำนำหน้าและปีที่ตั้งไว้) เฉพาะเลขรูปแบบ คำนำหน้า+ตัวเลข/ปี 4 หลัก คำสั่งเดียว
router.post('/docno/reformat', async (req, res) => {
  if (!req.ff.docnoreq) return fail(req, res, '/admin/settings', 'ฟังก์ชันบังคับกรอกเลขที่บันทึกข้อความปิดอยู่');
  const list = docno.reformat(req.settings, await docNoRows());
  if (!list.length) return done(req, res, '/admin/settings', 'เลขทุกงานเป็นรูปแบบปัจจุบันอยู่แล้ว');
  await q.run(
    'UPDATE submissions s SET doc_no = v.no FROM unnest(?::int[], ?::text[]) AS v(id, no) WHERE s.id = v.id',
    list.map((x) => x.id),
    list.map((x) => x.to)
  );
  await features.audit(req.me, `ปรับเลขที่บันทึกข้อความย้อนหลัง ${list.length} งาน เป็นรูปแบบ ${docno.format(req.settings, '214', docno.yearMode(req.settings) === 'calendar' ? 'ปี พ.ศ. ที่ส่ง' : 'ปีการศึกษา')}`, list.slice(0, 40).map((x) => `${x.from} เป็น ${x.to}`).join(', '));
  done(req, res, '/admin/settings', `ปรับเลขที่บันทึกข้อความแล้ว ${list.length} งาน`);
});

// บันทึกค่าตั้ง คืนข้อความผิดพลาดถ้ามี (ไม่มีคือสำเร็จ)
// รูปโลโก้เขียนเฉพาะเมื่อแนบไฟล์ใหม่หรือติ๊กลบ ค่า /media/logo?v= ในหน้าเว็บไม่ถูกเขียนกลับทับรูปจริง
async function saveSettings(req) {
  const b = req.body || {};
  const year = Number(b.academic_year);
  if (!(year >= 2500 && year <= 2700)) return 'ปีการศึกษาต้องเป็นปี พ.ศ. เช่น 2569';
  if (b.docno_prefix !== undefined && !docno.PREFIX_RE.test(String(b.docno_prefix).trim())) return 'คำนำหน้าเลขที่บันทึกข้อความต้องมีตัวหนังสือ ไม่มีตัวเลขและเครื่องหมายทับ เช่น วก.';
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  await setSetting('school_name', String(b.school_name || '').trim().slice(0, 200) || 'โรงเรียนของเรา');
  await setSetting('school_location', String(b.school_location || '').trim().slice(0, 200));
  await setSetting('academic_year', year);
  await setSetting('semester', ['1', '2', '3'].includes(b.semester) ? b.semester : '1');
  await setSetting('submit_open', b.submit_open ? '1' : '0');
  await setSetting('submit_start', date(b.submit_start));
  await setSetting('submit_end', date(b.submit_end));
  await setSetting('max_upload_mb', Math.min(100, Math.max(1, Number(b.max_upload_mb) || 20)));
  if (b.docno_prefix !== undefined) {
    await setSetting('docno_prefix', String(b.docno_prefix).trim());
    await setSetting('docno_year', b.docno_year === 'calendar' ? 'calendar' : 'academic');
  }
  if (b.min_pages !== undefined) await setSetting('min_pages', Math.min(500, Math.max(0, parseInt(b.min_pages, 10) || 0)));
  await setSetting('grade_levels', util.lines(b.grade_levels).join('\n'));
  await setSetting('teaching_methods', util.lines(b.teaching_methods).join('\n'));
  const url = String(b.public_url || '').trim().replace(/\/+$/, '');
  await setSetting('public_url', /^https?:\/\/[^\s]+$/i.test(url) ? url.slice(0, 200) : '');
  const layout = b.mobile_layout === 'classic' ? 'classic' : 'simple';
  if (layout !== (req.settings.mobile_layout || 'simple')) {
    await setSetting('mobile_layout', layout);
    await features.audit(req.me, `เปลี่ยนการจัดวางบนมือถือเป็น${layout === 'simple' ? 'แบบเรียบง่าย' : 'แบบเต็ม'}`, 'mobile_layout');
  }
  // ชื่อระบบ ข้อมูลท้ายเว็บ และไอคอนแอป (src/site.js)
  const site = require('../site');
  // ฟอร์มที่ไม่มีช่องเหล่านี้ (เช่น ฟอร์มเก่า) ไม่แตะค่าเดิม
  if ('site_app_name' in b) {
    const oldIcon = site.of(req.settings).icon;
    for (const [k, v] of site.fromForm(b)) await setSetting(k, v);
    const newIcon = site.iconKey(b.site_icon);
    if (newIcon !== oldIcon) await features.audit(req.me, `เปลี่ยนไอคอนแอปเป็นแบบ ${newIcon} ${site.ICONS[newIcon]}`, 'site_icon');
  }
  // สีสัน 4 ระดับ (colorful) ฟอร์มที่ไม่มีช่องนี้ไม่แตะค่าเดิม
  const fx = themes.FX_LEVELS.find((x) => x.key === b.color_level);
  if (fx && fx.key !== (req.settings.color_level || themes.FX_DEFAULT)) {
    await setSetting('color_level', fx.key);
    await features.audit(req.me, `เปลี่ยนสีสันของหน้าเว็บเป็น${fx.name}`, 'color_level');
  }
  if (req.ff.fontpick && b.web_font !== undefined) {
    const font = themes.webFontKey(b.web_font);
    if (font !== (req.settings.web_font || '')) {
      await setSetting('web_font', font);
      await features.audit(req.me, `เปลี่ยนฟอนต์หน้าเว็บเป็น ${font ? themes.WEB_FONTS.find((x) => x.key === font).name : 'ตามธีมสี'}`, 'web_font');
    }
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
    // บนคลาวด์ใช้ข้อความตอนปิดแบบคลาวด์ (cloudOffNote) ถ้ามี
    list: features.FEATURES.map((f) => ({ ...f, offNote: (config.WORKERS && f.cloudOffNote) || f.offNote, on: features.isOn(req.settings, f.key) })),
    log: await features.auditLog(30),
    groups: features.PHRASE_GROUPS,
    tab,
    phrases: String(req.settings[`phrases_${tab}`] || '')
      .split(/\r?\n/)
      .filter((x) => x.trim()),
    lineReady: Boolean(req.settings.line_token && req.settings.line_to),
    noteSignOpts: features.NOTE_SIGN,
    noteSign: features.noteSign(req.settings),
    libViews: features.LIBRARY_VIEWS,
    libView: features.libraryView(req.settings),
    coverStyles: features.COVER_STYLES,
    teachStyles: features.TEACH_STYLES,
    showModes: library.SHOW_MODES,
    showRule: library.showRule(req.settings),
    showTeachers: req.ff.libshow
      ? await q.all('SELECT u.id, u.full_name, d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.is_teacher = 1 AND u.is_active = 1 ORDER BY d.sort NULLS LAST, u.full_name')
      : [],
    // ข้อมูลสมมติของภาพตัวอย่างปก
    coverSample: { open: true, subject_code: 'ว30203', subject_name: 'ฟิสิกส์เพิ่มเติม 3', teacher_name: 'นายสมมติ ใจดี', gradeText: 'ชั้นมัธยมศึกษาปีที่ 5', termText: 'ภาคเรียนที่ 2 ปีการศึกษา 2569' },
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
  // เปิดปิดจากผลค้นหาในหน้าผู้ดูแลระบบ (ฟังก์ชันเสริม adminfind) กลับไปที่ผลค้นหาเดิม
  const back = /^\/admin\?find=[^#\s]*$/.test(String((req.body || {}).back || '')) ? req.body.back : '/admin/features';
  done(req, res, back, `${on ? 'เปิด' : 'ปิด'} ${f.title} เรียบร้อย`);
});

// เลือกการจัดหน้าลงนามบันทึกหลังแผน (ฟังก์ชันเสริม notesign) มีผลตอนพิมพ์ทุกครั้ง งานเดิมไม่ต้องลงนามใหม่
router.post('/notesign', async (req, res) => {
  if (!req.ff.notesign) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันจัดหน้าลงนามบันทึกหลังแผนก่อน');
  const b = req.body || {};
  const cur = features.noteSign(req.settings) || { web: '', pdf: '' };
  const changed = [];
  await q.tx(async () => {
    for (const kind of ['web', 'pdf']) {
      const opt = features.NOTE_SIGN[kind].find((o) => o.key === b[kind]);
      if (!opt || opt.key === cur[kind]) continue;
      await setSetting(`note_sign_${kind}`, opt.key);
      changed.push(`${kind === 'web' ? 'แผ่นที่พิมพ์ในเว็บ' : 'แผ่น PDF ของครู'} ${opt.label}`);
    }
    if (changed.length) await features.audit(req.me, `เปลี่ยนการจัดหน้าลงนามบันทึกหลังแผน ${changed.join(' และ ')}`, 'note_sign');
  });
  done(req, res, '/admin/features#notesign', changed.length ? 'บันทึกการจัดหน้าลงนามเรียบร้อย' : 'ไม่มีอะไรเปลี่ยน');
});

// มุมมองเริ่มต้นของหน้าคลังงาน (ฟังก์ชันเสริม library) ค่าว่าง = ตามขนาดจอ · เครื่องที่ผู้ใช้เคยสลับเองยังใช้แบบที่เลือกไว้
router.post('/libview', async (req, res) => {
  if (!req.ff.library) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันคลังงานการจัดการเรียนรู้ก่อน');
  const want = String((req.body || {}).view || '');
  const opt = features.LIBRARY_VIEWS.find((v) => v.key === want);
  if (want && !opt) return fail(req, res, '/admin/features#libview', 'ไม่พบมุมมองที่เลือก');
  if (want === features.libraryView(req.settings)) return done(req, res, '/admin/features#libview', 'ไม่มีอะไรเปลี่ยน');
  await q.tx(async () => {
    await setSetting('library_view', want);
    await features.audit(req.me, `ตั้งมุมมองเริ่มต้นของคลังงาน ${opt ? opt.label : 'ตามขนาดจอ'}`, 'library_view');
  });
  done(req, res, '/admin/features#libview', 'บันทึกมุมมองเริ่มต้นของคลังงานเรียบร้อย');
});

// งานที่แสดงในคลังงาน (ฟังก์ชันเสริม libshow) ค่าหลัก + ยกเว้นรายครู t_<รหัสครู> = auto|show|hide · รายเล่มทำในหน้าคลัง
router.post('/libshow', async (req, res) => {
  if (!req.ff.libshow) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันเลือกงานที่แสดงในคลังงานก่อน');
  const b = req.body || {};
  const mode = library.SHOW_MODES.find((m) => m.key === b.mode);
  if (!mode) return fail(req, res, '/admin/features#libshow', 'ไม่พบค่าหลักที่เลือก');
  const cur = library.showRule(req.settings);
  const ids = new Set((await q.all('SELECT id FROM users WHERE is_teacher = 1')).map((u) => String(u.id)));
  const teachers = { ...cur.teachers };
  for (const [k, v] of Object.entries(b)) {
    const id = k.startsWith('t_') ? k.slice(2) : '';
    if (!ids.has(id)) continue;
    if (v === 'show' || v === 'hide') teachers[id] = v;
    else if (v === 'auto') delete teachers[id];
  }
  const changed = mode.key !== cur.mode || JSON.stringify(teachers) !== JSON.stringify(cur.teachers);
  if (!changed) return done(req, res, '/admin/features#libshow', 'ไม่มีอะไรเปลี่ยน');
  const count = (want) => Object.values(teachers).filter((v) => v === want).length;
  await q.tx(async () => {
    await setSetting('lib_show', mode.key);
    await setSetting('lib_show_teachers', JSON.stringify(teachers));
    await features.audit(req.me, `ตั้งงานที่แสดงในคลังงาน ${mode.label} ยกเว้นแสดงทุกงาน ${count('show')} คน ซ่อน ${count('hide')} คน`, 'lib_show');
  });
  done(req, res, '/admin/features#libshow', 'บันทึกงานที่แสดงในคลังงานเรียบร้อย');
});

// แบบปกที่ระบบวาด (ฟังก์ชันเสริม coverstyle) มีผลกับคลังงานทันที ไม่แก้ไฟล์ของใคร
router.post('/coverstyle', async (req, res) => {
  if (!req.ff.coverstyle) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันปกที่ระบบวาดแบบใหม่ก่อน');
  const opt = features.COVER_STYLES.find((o) => o.key === String((req.body || {}).style || ''));
  if (!opt) return fail(req, res, '/admin/features#coverstyle', 'ไม่พบแบบปกที่เลือก');
  if (opt.key === features.coverStyle(req.settings)) return done(req, res, '/admin/features#coverstyle', 'ไม่มีอะไรเปลี่ยน');
  await q.tx(async () => {
    await setSetting('cover_style', opt.key);
    await features.audit(req.me, `ตั้งแบบปกที่ระบบวาด ${opt.label}`, 'cover_style');
  });
  done(req, res, '/admin/features#coverstyle', 'บันทึกแบบปกที่ระบบวาดเรียบร้อย');
});

// แบบหน้ารายวิชาที่สอนบนมือถือ (ฟังก์ชันเสริม teachcards) มีผลกับทุกคนทันที
router.post('/teachstyle', async (req, res) => {
  if (!req.ff.teachcards) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันรายวิชาที่สอนเป็นกล่องบนมือถือก่อน');
  const opt = features.TEACH_STYLES.find((o) => o.key === String((req.body || {}).teach_style || ''));
  if (!opt) return fail(req, res, '/admin/features#teachcards', 'ไม่พบแบบที่เลือก');
  if (opt.key === features.teachStyle(req.settings)) return done(req, res, '/admin/features#teachcards', 'ไม่มีอะไรเปลี่ยน');
  await q.tx(async () => {
    await setSetting('teach_style', opt.key);
    await features.audit(req.me, `ตั้งแบบหน้ารายวิชาที่สอนบนมือถือ ${opt.label}`, 'teach_style');
  });
  done(req, res, '/admin/features#teachcards', 'บันทึกแบบหน้ารายวิชาที่สอนเรียบร้อย');
});

// ดูตัวอย่างการจัดหน้าลงนามแบบหนึ่งจากเล่มจริง ไม่เปลี่ยนค่าที่ทุกคนใช้ ?web=bar หรือ ?pdf=summary · book = รหัสแผน (เล่ม)
// เล่มให้เลือก: เล่มที่มีบันทึกส่งแล้ว เรียงเล่มที่ลงนามครบมากสุดก่อน (เห็นลายเซ็นครบ) · ดูแบบแผ่น PDF เลือกเฉพาะเล่มที่มีแผ่นแนบไฟล์
router.get('/notesign/preview', async (req, res) => {
  if (!req.ff.notesign) return fail(req, res, '/admin/features', 'เปิดฟังก์ชันจัดหน้าลงนามบันทึกหลังแผนก่อน');
  const kind = req.query.pdf ? 'pdf' : 'web';
  const opt = features.NOTE_SIGN[kind].find((o) => o.key === req.query[kind]);
  if (!opt) return fail(req, res, '/admin/features#notesign', 'ไม่พบแบบที่เลือก');
  const books = await q.all(
    `SELECT p.id, p.subject_code, p.subject_name, u.full_name AS teacher_name, COUNT(*) AS sheets,
       SUM(CASE WHEN n.status = 'approved' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN n.note_mode = 'file' THEN 1 ELSE 0 END) AS files
     FROM submissions n JOIN submissions p ON p.id = n.parent_id JOIN users u ON u.id = p.teacher_id
     WHERE n.doc_type = 'note' AND n.status != 'draft'
     GROUP BY p.id, p.subject_code, p.subject_name, u.full_name
     HAVING ?::text = 'web' OR SUM(CASE WHEN n.note_mode = 'file' THEN 1 ELSE 0 END) > 0
     ORDER BY done DESC, sheets DESC, p.id DESC LIMIT 40`,
    kind
  );
  const book = books.find((b) => String(b.id) === String(req.query.book)) || books[0];
  const { printDataMany, subSelect } = require('./work');
  const notes = book
    ? await q.all(`${subSelect(true)} WHERE s.parent_id = ? AND s.doc_type = 'note' AND s.status != 'draft' ORDER BY to_int_lenient(s.plan_no), s.id`, book.id)
    : [];
  const data = await printDataMany(notes, { sign: { [kind]: opt.key } });
  const items = [];
  for (let i = 0; i < notes.length; i++) items.push({ ...data[i], qr: await require('./verify').qrSvg(req, notes[i]) });
  res.render('print_notes', {
    title: `ตัวอย่าง ${opt.label}`,
    items,
    preview: { kind, key: opt.key, label: opt.label, books, book: book ? book.id : null },
  });
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

// ข้อมูลทุกตารางเป็นไฟล์ JSON ไฟล์เดียว (Postgres สร้าง JSON เอง) ไฟล์งานอยู่ในที่เก็บไฟล์ ไม่อยู่ในไฟล์นี้
router.get('/backup', async (req, res) => {
  const { name, text } = await require('../backup').build();
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', util.contentDisposition(name));
  res.set('Cache-Control', 'no-store');
  res.send(text);
});

// เก็บสำรองฉบับปิดภาค ไว้ถาวรในโฟลเดอร์ สำรองปิดภาคเรียน (ฟังก์ชันเสริม backupkeep) บันทึกใน audit_log
router.post('/backup/term', async (req, res) => {
  if (!req.ff.backupkeep) return fail(req, res, '/admin', 'ฟังก์ชันสำรองข้อมูลแบบเก็บถาวรปิดอยู่');
  try {
    const name = await require('../jobs').termBackup(req.me);
    done(req, res, '/admin', `เก็บสำรองฉบับปิดภาคเรียบร้อย ไฟล์ ${name}`);
  } catch (e) {
    fail(req, res, '/admin', `เก็บสำรองไม่สำเร็จ ${e.message}`);
  }
});

module.exports = router;
module.exports.getSettings = getSettings;
