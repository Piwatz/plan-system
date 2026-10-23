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

// ---------- รายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก (ฟังก์ชันเสริม frontcheck) ----------
// เซิร์ฟเวอร์บนคลาวด์ไม่เปิด PDF เอง เบราว์เซอร์ตรวจหน้าแรก (ตอนครูกดส่ง เปลี่ยนปก หรือผู้ดูแลกดตรวจงานเดิม) แล้วส่งผลมาเก็บใน files.front_check
// ok · blank หน้าแรกเกือบว่าง · nocode หน้าแรกมีตัวหนังสือแต่ไม่มีรหัสวิชา · seen ผู้ดูแลกด ปกถูกแล้ว · ว่าง = ยังไม่ได้ตรวจ
// drawn = หน้าแรกเป็นปกที่ระบบวาด เซิร์ฟเวอร์ใส่เองตอนต่อปก (ไม่รับจากเบราว์เซอร์) คลังงานใช้ข้ามเล่มที่ต่อแล้ว (ฟังก์ชันเสริม libcoverpdf)
const FRONT_VALUES = ['ok', 'blank', 'nocode', 'blank nocode'];
const FRONT_BAD = ['blank', 'nocode', 'blank nocode'];
// ไฟล์หน้าแรกของงาน = PDF หลักไฟล์แรกที่ใช้อยู่ (แบบเดียวกับรูปปกในคลังงาน)
const FRONT_FILE = `(SELECT MIN(x.id) FROM files x WHERE x.submission_id = s.id AND x.kind = 'main' AND x.is_current = 1 AND x.mime = 'application/pdf')`;

// ใส่ผลตรวจให้ไฟล์ที่เพิ่งแนบ (เรียกหลัง up.attach ใน transaction) เฉพาะเมื่อไฟล์ใหม่ล่าสุดเป็นไฟล์หน้าแรกของงาน
async function setFront(ff, subId, v) {
  if (!ff.frontcheck || !FRONT_VALUES.includes(v)) return;
  await frontValue(subId, v);
}
// ต่อปกที่ระบบวาดเป็นหน้าแรก จดไว้เสมอแม้ปิด frontcheck
function markDrawn(subId) {
  return frontValue(subId, 'drawn');
}
function frontValue(subId, v) {
  return q.run(
    `UPDATE files SET front_check = ? WHERE id = (SELECT MAX(id) FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1)
       AND id = (SELECT MIN(id) FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1 AND mime = 'application/pdf')`,
    v,
    subId,
    subId
  );
}

// แผนและคู่มือที่ส่งแล้ว ซึ่งหน้าแรกน่าจะไม่ใช่ปก (bad) และที่ยังไม่ได้ตรวจ (todo ใช้กับปุ่มตรวจหน้าแรกของงานเดิม)
async function frontRows(onlyTodo = false) {
  const rows = await q.all(
    `SELECT s.id, s.doc_type, s.subject_code, s.subject_name, s.status, s."current_role", s.teacher_id, u.full_name AS teacher_name, f.id AS file, f.front_check
     FROM submissions s JOIN users u ON u.id = s.teacher_id JOIN files f ON f.id = ${FRONT_FILE}
     WHERE s.doc_type IN ('manual', 'plan') AND s.status != 'draft'
       AND (f.front_check IS NULL${onlyTodo ? '' : ` OR f.front_check IN (${FRONT_BAD.map(() => '?').join(', ')})`})
     ORDER BY s.id DESC LIMIT 2000`,
    ...(onlyTodo ? [] : FRONT_BAD)
  );
  return { bad: rows.filter((r) => r.front_check), todo: rows.filter((r) => !r.front_check) };
}

module.exports = { minPages, otherFiles, sameBytes, duplicateOf, dupList, FRONT_VALUES, setFront, markDrawn, frontRows };
