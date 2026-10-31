// สิทธิ์อ่านงานคนอื่นในคลัง (ฟังก์ชันเสริม readperm) ผู้ดูแลระบบตั้งในหน้า /admin/readperm
// ระดับ cover = เห็นแค่ปก · dept = อ่านในกลุ่มสาระตัวเอง · all = อ่านทุกเล่ม ใครเข้าได้หลายทางใช้ระดับสูงสุด
// ค่าใน settings: read_teacher read_depthead read_unapproved read_temp_on read_temp_until read_people
// หน้านี้เพิ่มสิทธิ์อ่านอย่างเดียว เจ้าของงาน ผู้ดูแลระบบ และผู้ตรวจ ยังเปิดงานตามสิทธิ์เดิมใน wf.canView
const db = require('./db');
const util = require('./util');

const LEVELS = ['cover', 'dept', 'all'];
const LABEL = { cover: 'เห็นแค่ปก', dept: 'กลุ่มสาระตัวเอง', all: 'ทุกเล่ม' };
const rank = (l) => LEVELS.indexOf(l);
const higher = (a, b) => (rank(b) > rank(a) ? b : a);

const inDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
// ยังไม่ถึงวันสิ้นสุด วันสุดท้ายยังใช้ได้ทั้งวัน
const stillOn = (until) => inDate(until) && util.daysUntil(until) >= 0;

function parsePeople(raw) {
  let rows = [];
  try {
    rows = JSON.parse(raw || '[]');
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((p) => p && Number.isInteger(p.id) && LEVELS.includes(p.level))
    .map((p) => ({ id: p.id, level: p.level, until: inDate(p.until) ? p.until : '' }));
}

// ค่าที่ตั้งไว้ ยังไม่เคยตั้งใช้ค่าเดิมของระบบ (ถ้าเคยเปิดสวิตช์ libread ครูยังอ่านทุกเล่มได้เหมือนเดิม)
function config(settings, ff) {
  return {
    teacher: LEVELS.includes(settings.read_teacher) ? settings.read_teacher : ff.libread ? 'all' : 'cover',
    depthead: settings.read_depthead === 'all' ? 'all' : 'dept',
    unapproved: settings.read_unapproved === '1',
    tempOn: settings.read_temp_on === '1',
    tempUntil: inDate(settings.read_temp_until) ? settings.read_temp_until : '',
    people: parsePeople(settings.read_people),
  };
}

// ระดับของผู้ใช้คนนี้ตอนนี้ · ปิดฟังก์ชันเสริมกลับไปใช้สวิตช์ libread แบบเดิม
function access(me, ff, settings = db.refs().settings) {
  if (!ff.readperm) return { level: ff.libread ? 'all' : 'cover', unapproved: false };
  const c = config(settings, ff);
  let level = c.teacher;
  if ((me.roles || []).includes('dept_head')) level = higher(level, c.depthead);
  if (c.tempOn && stillOn(c.tempUntil)) level = 'all';
  for (const p of c.people) if (p.id === me.id && (!p.until || stillOn(p.until))) level = higher(level, p.level);
  return { level, unapproved: c.unapproved };
}

// ระดับนี้ครอบคลุมงานของกลุ่มสาระนี้ไหม
function reaches(me, a, departmentId) {
  return a.level === 'all' || (a.level === 'dept' && Boolean(me.department_id) && me.department_id === departmentId);
}

// สถานะนี้อ่านได้ไหม ผ่านครบอ่านได้เสมอ รอลงนามอ่านได้เมื่อเปิดสวิตช์ งานร่างและงานที่ถูกส่งกลับไม่เปิดให้คนอื่นอ่าน
function statusOk(a, status) {
  return status === 'approved' || (a.unapproved && status === 'pending');
}

module.exports = { LEVELS, LABEL, inDate, stillOn, parsePeople, config, access, reaches, statusOk };
