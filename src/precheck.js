// จุดที่ครูต้องระวังก่อนส่งแผนและคู่มือ (ฟังก์ชันเสริม precheck precheckforce dupfile)
// ข้อที่ระบบรู้แน่นอน ตรวจทั้งในเบราว์เซอร์ (ตอนเลือกไฟล์) และที่นี่ (ตอนกดส่ง) · ข้อที่เดาได้ตรวจในเบราว์เซอร์เท่านั้น (public/js/app.js)
const { q } = require('./db');
const storage = require('./storage');
const wf = require('./workflow');

// จำนวนหน้าที่น้อยกว่านี้ขึ้นข้อส้ม (ตั้งในหน้าตั้งค่าโรงเรียน 0 = ไม่เตือน) เว็บจริงที่ยังไม่มีคีย์ใช้ค่าเริ่มต้น 5
function minPages(settings) {
  const n = parseInt(settings && settings.min_pages, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

// ไฟล์ปัจจุบันของงานอื่นของครูคนเดียวกันในภาคเรียนเดียวกัน (แผนและคู่มือ) ใช้เทียบหาไฟล์ซ้ำ
async function otherFiles(sub) {
  const rows = await q.all(
    `SELECT f.id, f.size, f.stored_name, s.doc_type, s.subject_code FROM files f JOIN submissions s ON s.id = f.submission_id
     WHERE s.teacher_id = ? AND s.academic_year = ? AND s.semester = ? AND s.id <> ? AND s.doc_type IN ('manual', 'plan')
       AND f.kind = 'main' AND f.is_current = 1 AND f.size > 0 ORDER BY f.id`,
    sub.teacher_id,
    sub.academic_year,
    sub.semester,
    sub.id || 0
  );
  return rows.map((r) => ({ ...r, label: `${wf.DOC_TYPES[r.doc_type].label} ${r.subject_code}`.trim() }));
}

async function readAll(stored) {
  const r = await storage.get(stored);
  const parts = [];
  for await (const c of r.stream) parts.push(c);
  return Buffer.concat(parts);
}

// เหมือนกันทุกไบต์ · อ่านไฟล์เมื่อขนาดเท่ากันเท่านั้น (ไฟล์คนละไฟล์แทบไม่เคยขนาดเท่ากันพอดี) อ่านไม่ได้ถือว่าไม่ซ้ำ
async function sameBytes(a, b) {
  if (Number(a.size) !== Number(b.size)) return false;
  try {
    return (await readAll(a.stored_name)).equals(await readAll(b.stored_name));
  } catch {
    return false;
  }
}

// ไฟล์ของงานนี้ซ้ำกับงานอื่นของครูคนเดียวกัน คืนชื่องานนั้น เช่น "คู่มือรายวิชา ว30204" หรือ null
async function duplicateOf(sub) {
  const mine = await q.all("SELECT id, size, stored_name FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1 AND size > 0", sub.id);
  if (!mine.length) return null;
  const others = await otherFiles(sub);
  for (const f of mine) {
    for (const o of others) if (await sameBytes(f, o)) return o.label;
  }
  return null;
}

// รายการที่หน้าเว็บใช้เทียบไฟล์ที่เพิ่งเลือก (ขนาดเท่ากันจึงโหลดไฟล์นั้นมาเทียบทุกไบต์) ไม่ส่งที่อยู่ไฟล์ในที่เก็บ
async function dupList(sub) {
  return (await otherFiles(sub)).map((r) => ({ id: r.id, size: Number(r.size), label: r.label }));
}

module.exports = { minPages, otherFiles, sameBytes, duplicateOf, dupList };
