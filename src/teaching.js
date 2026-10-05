// รายวิชาที่ครูสอนในแต่ละภาค และวิชาหลักที่ต้องส่งแผน
// คู่มือรายวิชาส่งทุกวิชาที่สอน แผนการจัดการเรียนรู้ส่งเฉพาะวิชาหลัก (ปกติคนละ 1 วิชา)
const { q } = require('./db');
const features = require('./features');

// วิชากิจกรรมพัฒนาผู้เรียน (รหัสขึ้นต้นด้วย ก) ไม่ต้องส่งแผนและคู่มือ เมื่อเปิดสวิตช์ noactivity
function isActivity(code) {
  return /^ก/.test(String(code || '').trim());
}

function skipActivity(code) {
  return isActivity(code) && features.isOn(null, 'noactivity');
}

async function list(teacherId, year, sem) {
  const rows = await q.all(
    'SELECT * FROM teach_subjects WHERE teacher_id = ? AND academic_year = ? AND semester = ? ORDER BY is_main DESC, subject_code',
    teacherId,
    year,
    sem
  );
  return features.isOn(null, 'noactivity') ? rows.filter((r) => !isActivity(r.subject_code)) : rows;
}

function planQuota(user) {
  return Math.max(1, Number(user && user.plan_quota) || 1);
}

function plansOf(teacherId, year, sem) {
  return q.all(
    "SELECT id, subject_code, status FROM submissions WHERE doc_type = 'plan' AND teacher_id = ? AND academic_year = ? AND semester = ? ORDER BY id",
    teacherId,
    year,
    sem
  );
}

// ข้อความบอกว่าทำไมสร้างแผนใหม่ไม่ได้ (ส่งครบจำนวนวิชาหลักแล้ว) ว่างเปล่าแปลว่าสร้างได้
async function planBlocked(user, year, sem) {
  const plans = await plansOf(user.id, year, sem);
  const quota = planQuota(user);
  if (plans.length < quota) return '';
  const codes = plans.map((p) => p.subject_code).filter(Boolean).join(' ');
  return `ภาคเรียนนี้ส่งแผนการจัดการเรียนรู้ได้ ${quota} วิชา (วิชาหลัก) คุณมีแผนวิชา ${codes} อยู่แล้ว ถ้าต้องการเปลี่ยนวิชาหลัก ให้เปิดแผนเดิมแล้วแก้รหัสวิชา หรือแจ้งผู้ดูแลระบบ`;
}

// วิชาหลักเกินจำนวนที่กำหนด ให้ปลดวิชาหลักที่ยังไม่มีแผนออก (เก็บวิชาที่เพิ่งเลือกไว้)
async function trimMains(teacherId, year, sem, quota, keepCode) {
  const mains = await q.all(
    'SELECT * FROM teach_subjects WHERE teacher_id = ? AND academic_year = ? AND semester = ? AND is_main = 1 ORDER BY id',
    teacherId,
    year,
    sem
  );
  if (mains.length <= quota) return;
  const withPlan = new Set((await plansOf(teacherId, year, sem)).map((p) => p.subject_code));
  let extra = mains.length - quota;
  for (const m of mains) {
    if (extra <= 0) break;
    if (m.subject_code === keepCode || withPlan.has(m.subject_code)) continue;
    await q.run('UPDATE teach_subjects SET is_main = 0 WHERE id = ?', m.id);
    extra -= 1;
  }
}

// เพิ่มวิชาในรายการที่สอน (มีอยู่แล้วก็อัปเดตชื่อ) main = true ตั้งเป็นวิชาหลักด้วย
// Postgres: ในนิพจน์ต้องใส่ชื่อตารางนำหน้า แต่ชื่อคอลัมน์หน้า = ใน SET ห้ามใส่ · MAX 2 ค่าของ SQLite เป็น GREATEST
async function ensure(user, year, sem, { code, name, grade }, main = false) {
  if (!code) return;
  await q.run(
    `INSERT INTO teach_subjects (teacher_id, academic_year, semester, subject_code, subject_name, grade_level, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (teacher_id, academic_year, semester, subject_code) DO UPDATE SET
       subject_name = CASE WHEN excluded.subject_name != '' THEN excluded.subject_name ELSE teach_subjects.subject_name END,
       grade_level = CASE WHEN excluded.grade_level != '' THEN excluded.grade_level ELSE teach_subjects.grade_level END,
       is_main = GREATEST(teach_subjects.is_main, excluded.is_main)`,
    user.id,
    year,
    sem,
    code,
    name || '',
    grade || '',
    main ? 1 : 0
  );
  if (main) await trimMains(user.id, year, sem, planQuota(user), code);
}

module.exports = { isActivity, skipActivity, list, planQuota, plansOf, planBlocked, trimMains, ensure };
