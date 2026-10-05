// ฐานข้อมูล SQLite ไฟล์เดียว (data/app.db) ใช้ตัวที่มากับ Node.js ไม่ต้องติดตั้งเพิ่ม
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db = null;
const cache = new Map();

function open(file = config.DB_FILE) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(require('path').dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  seedDefaults();
  return db;
}

function close() {
  if (db) db.close();
  db = null;
  cache.clear();
}

function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

const q = {
  get: (sql, ...p) => stmt(sql).get(...p),
  all: (sql, ...p) => stmt(sql).all(...p),
  run: (sql, ...p) => stmt(sql).run(...p),
  exec: (sql) => db.exec(sql),
  // รันหลายคำสั่งให้สำเร็จพร้อมกัน ถ้าพังกลางทางจะย้อนกลับทั้งหมด
  tx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      full_name TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT '',
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      is_teacher INTEGER NOT NULL DEFAULT 1,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      signature TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      role TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'school',
      for_manual INTEGER NOT NULL DEFAULT 1,
      for_plan INTEGER NOT NULL DEFAULT 1,
      for_note INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS rubric_items (
      id INTEGER PRIMARY KEY,
      doc_type TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      max_score INTEGER NOT NULL DEFAULT 5,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS subjects (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      grade TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      doc_type TEXT NOT NULL,
      parent_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      academic_year INTEGER NOT NULL,
      semester INTEGER NOT NULL,
      subject_code TEXT NOT NULL DEFAULT '',
      subject_name TEXT NOT NULL DEFAULT '',
      grade_level TEXT NOT NULL DEFAULT '',
      teaching_methods TEXT NOT NULL DEFAULT '[]',
      link_url TEXT NOT NULL DEFAULT '',
      doc_no TEXT NOT NULL DEFAULT '',
      plan_no TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      unit_no TEXT NOT NULL DEFAULT '',
      unit_name TEXT NOT NULL DEFAULT '',
      hours TEXT NOT NULL DEFAULT '',
      class_room TEXT NOT NULL DEFAULT '',
      teach_date TEXT NOT NULL DEFAULT '',
      result_k TEXT NOT NULL DEFAULT '',
      result_p TEXT NOT NULL DEFAULT '',
      result_a TEXT NOT NULL DEFAULT '',
      problems TEXT NOT NULL DEFAULT '',
      suggestions TEXT NOT NULL DEFAULT '',
      students_total INTEGER,
      students_passed INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      current_role TEXT,
      returned_role TEXT,
      score_total REAL,
      score_max REAL,
      score_detail TEXT,
      score_role TEXT,
      teacher_signature TEXT,
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sub_teacher ON submissions(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status, current_role);
    CREATE INDEX IF NOT EXISTS idx_sub_term ON submissions(academic_year, semester);
    CREATE INDEX IF NOT EXISTS idx_sub_parent ON submissions(parent_id);
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 1,
      uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_sub ON files(submission_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      role TEXT,
      step_label TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_position TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      score_total REAL,
      score_max REAL,
      score_detail TEXT,
      signature TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_sub ON reviews(submission_id);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      from_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      link TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
    -- ประวัติการเปิดปิดฟังก์ชันและการตั้งค่าสำคัญ เพิ่มได้อย่างเดียว แก้ไขหรือลบไม่ได้
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      user_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
  // คอลัมน์ที่เพิ่มภายหลัง ฐานข้อมูลเดิมจะได้คอลัมน์ใหม่โดยข้อมูลไม่หาย
  addColumn('submissions', 'note_mode', "TEXT NOT NULL DEFAULT 'type'");
  addColumn('submissions', 'verify_code', 'TEXT');
  // จำนวนวิชาที่ครูส่งแผนได้ต่อภาค (ปกติ 1 วิชาหลัก ผู้ดูแลเพิ่มให้บางคนได้)
  addColumn('users', 'plan_quota', 'INTEGER NOT NULL DEFAULT 1');
  // รายวิชาที่ครูสอนในแต่ละภาค ใช้เช็กว่าส่งคู่มือครบทุกวิชา และวิชาหลักที่ต้องส่งแผน
  db.exec(`
    CREATE TABLE IF NOT EXISTS teach_subjects (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academic_year INTEGER NOT NULL,
      semester INTEGER NOT NULL,
      subject_code TEXT NOT NULL,
      subject_name TEXT NOT NULL DEFAULT '',
      grade_level TEXT NOT NULL DEFAULT '',
      is_main INTEGER NOT NULL DEFAULT 0,
      UNIQUE (teacher_id, academic_year, semester, subject_code)
    );
  `);
  // รหัสสุ่มสำหรับ QR Code ตรวจสอบเอกสาร เดาไม่ได้ และไม่เรียงตามลำดับงาน
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_verify ON submissions(verify_code);
    UPDATE submissions SET verify_code = lower(hex(randomblob(10))) WHERE verify_code IS NULL;
    CREATE TRIGGER IF NOT EXISTS submissions_verify_code AFTER INSERT ON submissions WHEN NEW.verify_code IS NULL
      BEGIN UPDATE submissions SET verify_code = lower(hex(randomblob(10))) WHERE id = NEW.id; END;
  `);
}

function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const DEFAULT_DEPARTMENTS = [
  'ภาษาไทย',
  'คณิตศาสตร์',
  'วิทยาศาสตร์และเทคโนโลยี',
  'สังคมศึกษา ศาสนาและวัฒนธรรม',
  'สุขศึกษาและพลศึกษา',
  'ศิลปะ',
  'การงานอาชีพ',
  'ภาษาต่างประเทศ',
];

// ลำดับและชื่อตำแหน่งผู้ลงความเห็น ตามบันทึกข้อความของโรงเรียน
// ผู้ดูแลระบบเปลี่ยนชื่อ หรือเปิดปิดบางระดับแยกตามชนิดงานได้ในหน้า "ขั้นตอนการตรวจ"
// บันทึกหลังแผนใช้ 3 ระดับ: หัวหน้ากลุ่มสาระ รองผู้อำนวยการ ผู้อำนวยการ
const DEFAULT_STEPS = [
  { role: 'dept_head', seq: 1, label: 'หัวหน้ากลุ่มสาระการเรียนรู้', scope: 'department', for_note: 1 },
  { role: 'section_head', seq: 2, label: 'หัวหน้างานส่งเสริมพัฒนากระบวนการเรียนรู้', scope: 'school', for_note: 0 },
  { role: 'academic_head', seq: 3, label: 'หัวหน้ากลุ่มบริหารงานวิชาการ', scope: 'school', for_note: 0 },
  { role: 'deputy_academic', seq: 4, label: 'รองผู้อำนวยการกลุ่มบริหารงานวิชาการ', scope: 'school', for_note: 1 },
  { role: 'director', seq: 5, label: 'ผู้อำนวยการสถานศึกษา', scope: 'school', for_note: 1 },
];

// แบบประเมิน 20 ข้อ ตามแบบฟอร์มของโรงเรียน (ข้อละ 5 ถึง 1 คะแนน รวมเต็ม 100)
const DEFAULT_RUBRICS = {
  plan: [
    'แผนการจัดการเรียนรู้สอดคล้องสัมพันธ์กับหน่วยการเรียนรู้',
    'แผนการจัดการเรียนรู้มีองค์ประกอบสำคัญครบถ้วน และเชื่อมโยงสัมพันธ์กัน',
    'ความสอดคล้องของสาระสำคัญกับมาตรฐานการเรียนรู้หรือตัวชี้วัดหรือผลการเรียนรู้',
    'ตัวชี้วัดหรือผลการเรียนรู้ครอบคลุมสาระการเรียนรู้ที่พัฒนาผู้เรียนให้เกิด K P A',
    'จุดประสงค์การเรียนรู้พัฒนาผู้เรียนครอบคลุมด้าน K P A',
    'การบูรณาการตามหลักสูตรของสถานศึกษา',
    'สาระการเรียนรู้เหมาะสมกับเวลา และตัวชี้วัดหรือผลการเรียนรู้',
    'กิจกรรมการเรียนรู้มีลำดับขั้นตอนเหมาะสมและเน้นผู้เรียนเป็นสำคัญ',
    'กิจกรรมการเรียนรู้มีความหลากหลายและสามารถปฏิบัติได้จริง',
    'กิจกรรมการเรียนรู้สามารถพัฒนาผู้เรียนครอบคลุมด้าน K P A',
    'กิจกรรมการเรียนรู้ส่งเสริม พัฒนา ทักษะกระบวนการคิดของนักเรียน',
    'กิจกรรมการเรียนรู้สอดแทรกคุณธรรม จริยธรรมและคุณลักษณะอันพึงประสงค์',
    'กิจกรรมการเรียนรู้ส่งเสริม พัฒนา สมรรถนะสำคัญของผู้เรียน',
    'กิจกรรมการเรียนรู้ส่งเสริมให้นักเรียนได้ปฏิบัติจริงและสรุปสร้างองค์ความรู้ได้ด้วยตนเอง',
    'วัสดุอุปกรณ์ สื่อ และแหล่งเรียนรู้มีความหลากหลาย เหมาะสม',
    'สื่อการเรียนรู้สอดคล้อง เหมาะสมกับสาระการเรียนรู้และกิจกรรมการเรียนรู้',
    'นักเรียนได้มีส่วนร่วมในการใช้สื่อและแหล่งเรียนรู้ได้อย่างทั่วถึง',
    'การทำชิ้นงาน/ภาระงาน มีความเหมาะสม และส่งเสริมให้นักเรียนได้ใช้กระบวนการคิด',
    'การวัดและประเมินผลสอดคล้องกับจุดประสงค์/ตัวชี้วัด/ผลการเรียนรู้ ชัดเจนและเหมาะสม',
    'ส่งแผนการจัดการเรียนรู้ตรงตามเวลาที่กำหนด',
  ],
  manual: [
    'มีการวิเคราะห์หลักสูตรสถานศึกษา เพื่อจัดทำโครงสร้างรายวิชา',
    'มีการวิเคราะห์หลักสูตรสถานศึกษา เพื่อจัดทำคำอธิบายรายวิชา',
    'มีการจัดทำคำอธิบายรายวิชา',
    'ตัวชี้วัดหรือผลการเรียนรู้ครอบคลุมสาระการเรียนรู้และตรงตามหลักสูตรสถานศึกษา',
    'ออกแบบหน่วยการเรียนรู้ครบทุกมาตรฐานการเรียนรู้ ตัวชี้วัด/ผลการเรียนรู้ตามหลักสูตรฯ',
    'บูรณาการจุดเน้นของสถานศึกษาในรายวิชา (สวนพฤกษศาสตร์ โรงเรียนสุจริต โรงเรียนวิถีพุทธ สถานศึกษาพอเพียง)',
    'สาระการเรียนรู้เหมาะสมกับเวลา และตัวชี้วัดหรือผลการเรียนรู้',
    'สื่อการเรียนรู้เหมาะสมกับเวลา และตัวชี้วัดหรือผลการเรียนรู้',
    'ชิ้นงาน/ภาระงาน มีความเหมาะสม',
    'กิจกรรมการเรียนรู้สามารถพัฒนาผู้เรียนครอบคลุมด้าน K P A',
    'การวัดและประเมินผลสอดคล้องกับจุดประสงค์/ตัวชี้วัด/ผลการเรียนรู้ ชัดเจนและเหมาะสม',
    'วัสดุอุปกรณ์ สื่อ และแหล่งเรียนรู้มีความหลากหลาย เหมาะสม',
    'กิจกรรมการเรียนรู้ส่งเสริม พัฒนา สมรรถนะสำคัญของผู้เรียน',
    'กิจกรรมการเรียนรู้ส่งเสริมให้นักเรียนได้ปฏิบัติจริงและสรุปสร้างองค์ความรู้ได้ด้วยตนเอง',
    'มีกิจกรรมการเรียนรู้ที่ผู้เรียนมีส่วนร่วมในการใช้สื่อและแหล่งเรียนรู้ได้อย่างทั่วถึง',
    'การวัดและประเมินผลสอดคล้องกับจุดประสงค์/ตัวชี้วัด/ผลการเรียนรู้ ชัดเจนและเหมาะสม',
    'นักเรียนได้มีส่วนร่วมในการใช้สื่อและแหล่งเรียนรู้ได้อย่างทั่วถึง',
    'มีเกณฑ์การจบและเกณฑ์การวัดผลการเรียนในรายวิชาอย่างชัดเจน',
    'กำหนดน้ำหนักคะแนนเหมาะสมกับภาระงาน/ชิ้นงานแต่ละหน่วยการเรียนรู้',
    'ส่งคู่มือรายวิชาตรงตามเวลาที่กำหนด',
  ],
};

const DEFAULT_SETTINGS = {
  school_name: 'โรงเรียนของเรา',
  school_location: '',
  school_logo: '',
  memo_logo: '',
  theme: 'i',
  mobile_layout: 'simple',
  public_url: '',
  line_token: '',
  line_to: '',
  line_time: '07:00',
  line_last_sent: '',
  academic_year: String(new Date().getFullYear() + 543),
  semester: '1',
  submit_open: '1',
  submit_start: '',
  submit_end: '',
  resubmit_mode: 'resume',
  score_role: 'dept_head',
  max_upload_mb: '100',
  grade_levels: 'ม.1\nม.2\nม.3\nม.4\nม.5\nม.6',
  teaching_methods: [
    'Active Learning',
    'สะเต็มศึกษา (STEM)',
    'การอ่าน คิดวิเคราะห์ แบบ PISA',
    'หลักปรัชญาของเศรษฐกิจพอเพียง',
    'ค่านิยมหลักของคนไทย 12 ประการ',
    'การจัดการเรียนรู้ฐานสมรรถนะ',
    'ต้านทุจริตศึกษา',
    'บูรณาการหน้าที่พลเมือง',
  ].join('\n'),
};

function seedDefaults() {
  const now = nowStr();
  const defaults = { ...DEFAULT_SETTINGS, ...require('./features').defaultSettings() };
  for (const [k, v] of Object.entries(defaults)) {
    q.run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', k, v);
  }
  if (!q.get('SELECT 1 AS x FROM departments LIMIT 1')) {
    DEFAULT_DEPARTMENTS.forEach((n, i) => q.run('INSERT INTO departments(name, sort) VALUES (?, ?)', n, i + 1));
  }
  for (const s of DEFAULT_STEPS) {
    q.run(
      'INSERT OR IGNORE INTO workflow_steps(role, seq, label, scope, for_note) VALUES (?, ?, ?, ?, ?)',
      s.role,
      s.seq,
      s.label,
      s.scope,
      s.for_note
    );
  }
  for (const [type, items] of Object.entries(DEFAULT_RUBRICS)) {
    if (q.get('SELECT 1 AS x FROM rubric_items WHERE doc_type = ? LIMIT 1', type)) continue;
    items.forEach((t, i) => q.run('INSERT INTO rubric_items(doc_type, seq, title, max_score) VALUES (?, ?, ?, 5)', type, i + 1, t));
  }
  return now;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// เวลาท้องถิ่นของเครื่อง เก็บเป็น YYYY-MM-DD HH:MM:SS
function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getSettings() {
  const out = {};
  for (const r of q.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}

module.exports = { open, close, q, nowStr, getSettings, setSetting, DEFAULT_STEPS, raw: () => db };
