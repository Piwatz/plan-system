// ทะเบียนเลขที่บันทึกข้อความ (ฟังก์ชันเสริม docnoreg): รวมเลขที่ครูกรอกในแผน คู่มือ และบันทึกหลังแผนทั้งเล่ม
// 1 รายการ = บันทึกข้อความ 1 ฉบับ: แผน 1 งาน · คู่มือของครูคนเดียวกันในภาคเดียวกันที่ใช้เลขเดียวกัน (docnoshare) รวมเป็น 1 รายการ
// · บันทึกหลังแผน 1 เล่ม (ทุกแผ่นของแผน 1 วิชา) · เลขซ้ำแจ้งให้เห็นอย่างเดียว ไม่ห้ามครูกรอก
const docno = require('./docno');
const notememo = require('./notememo');

const SUBJECT = {
  manual: 'ขออนุญาตใช้คู่มือรายวิชา',
  plan: 'ขออนุญาตใช้แผนการจัดการเรียนรู้',
  note: 'ขอส่งบันทึกหลังสอน',
};

const keyOf = (no) => String(no || '').replace(/\s+/g, '');

// สถานะรวมของหลายงาน: มีส่งกลับ = ส่งกลับ · มีรอตรวจ = รอตรวจ (ระดับของงานแรกที่รอ) · ทั้งหมดผ่าน = ผ่าน
function mergeStatus(list) {
  const back = list.find((s) => s.status === 'returned');
  if (back) return back;
  const wait = list.find((s) => s.status === 'pending');
  return wait || list[0];
}

/**
 * rows = งานที่ไม่ใช่ฉบับร่าง (แผน คู่มือ บันทึกหลังแผน) พร้อม teacher_name dept_name dept_sort
 * opts.notes = นับบันทึกหลังแผนที่ยังไม่มีเลขด้วยไหม (เปิด notedocno)
 * คืน { numbered: รายการที่มีเลข เรียงตามเลข, missing: รายการที่ยังไม่มีเลข, dupCount }
 */
function build(rows, { notes = false } = {}) {
  const entries = [];
  const books = new Map();
  const shared = new Map();
  for (const r of rows) {
    if (r.doc_type === 'note') {
      if (!r.parent_id) continue;
      if (!books.has(r.parent_id)) books.set(r.parent_id, []);
      books.get(r.parent_id).push(r);
    } else if (r.doc_type === 'manual' && keyOf(r.doc_no)) {
      const k = [r.teacher_id, r.academic_year, r.semester, keyOf(r.doc_no)].join('|');
      if (!shared.has(k)) shared.set(k, []);
      shared.get(k).push(r);
    } else if (r.doc_type === 'manual' || r.doc_type === 'plan') {
      entries.push(entry(r.doc_type, [r], r.doc_no));
    }
  }
  for (const list of shared.values()) entries.push(entry('manual', list, list[0].doc_no));
  for (const [planId, list] of books) {
    const no = notememo.bookNo(list);
    if (!no && !notes) continue;
    const e = entry('note', list, no);
    e.href = `/s/${planId}#notes`;
    e.planId = planId;
    e.sheets = list.length;
    e.submitted_at = notememo.bookDate(list);
    entries.push(e);
  }

  const numbered = entries.filter((e) => e.doc_no);
  const missing = entries.filter((e) => !e.doc_no);
  const count = new Map();
  for (const e of numbered) count.set(keyOf(e.doc_no), (count.get(keyOf(e.doc_no)) || 0) + 1);
  for (const e of numbered) e.dup = count.get(keyOf(e.doc_no)) > 1;
  numbered.sort(byNumber);
  missing.sort(byTeacher);
  return { numbered, missing, dupCount: numbered.filter((e) => e.dup).length };
}

function entry(type, list, no) {
  const first = list[0];
  const st = mergeStatus(list);
  return {
    type,
    title: SUBJECT[type],
    doc_no: String(no || '').trim(),
    ids: list.map((s) => s.id),
    href: `/s/${first.id}`,
    subjects: type === 'note' ? [{ id: first.parent_id, code: first.subject_code, name: first.subject_name }] : list.map((s) => ({ id: s.id, code: s.subject_code, name: s.subject_name })),
    teacher_id: first.teacher_id,
    teacher_name: first.teacher_name,
    dept_id: first.dept_id ?? null,
    dept_name: first.dept_name || '',
    dept_sort: first.dept_sort ?? null,
    academic_year: first.academic_year,
    semester: first.semester,
    submitted_at: list.map((s) => s.submitted_at || '').filter(Boolean).sort()[0] || '',
    status: { status: st.status, current_role: st.current_role, doc_type: type },
  };
}

// เรียงตามปี แล้วตามตัวเลข เลขที่ไม่ตรงรูปแบบไว้ท้าย
function byNumber(a, b) {
  const pa = docno.parse(a.doc_no);
  const pb = docno.parse(b.doc_no);
  if (pa && pb) return pa.year - pb.year || pa.num - pb.num || a.doc_no.localeCompare(b.doc_no) || String(a.submitted_at).localeCompare(String(b.submitted_at));
  if (pa || pb) return pa ? -1 : 1;
  return a.doc_no.localeCompare(b.doc_no, 'th');
}

function byTeacher(a, b) {
  const sa = a.dept_sort ?? -1;
  const sb = b.dept_sort ?? -1;
  return sa - sb || a.dept_name.localeCompare(b.dept_name, 'th') || a.teacher_name.localeCompare(b.teacher_name, 'th') || a.type.localeCompare(b.type) || String(a.subjects[0].code).localeCompare(String(b.subjects[0].code));
}

// มุมมองแยกตามกลุ่มสาระและครู: [{ dept, teachers: [{ name, manual: [], plan: [], note: [] }], total, complete }]
function byDept(list) {
  const depts = [];
  const seen = new Map();
  for (const e of [...list].sort(byTeacher)) {
    let d = seen.get(e.dept_name);
    if (!d) {
      d = { dept: e.dept_name, teachers: [], index: new Map() };
      seen.set(e.dept_name, d);
      depts.push(d);
    }
    let t = d.index.get(e.teacher_id);
    if (!t) {
      t = { id: e.teacher_id, name: e.teacher_name, manual: [], plan: [], note: [] };
      d.index.set(e.teacher_id, t);
      d.teachers.push(t);
    }
    t[e.type].push(e);
  }
  for (const d of depts) {
    delete d.index;
    for (const t of d.teachers) for (const k of ['manual', 'plan', 'note']) t[k].sort(byNumber);
    d.total = d.teachers.length;
    d.complete = d.teachers.filter((t) => [...t.manual, ...t.plan, ...t.note].every((e) => e.doc_no)).length;
  }
  return depts;
}

function subjectText(e) {
  return e.subjects.map((s) => `${s.code} ${s.name}`.trim()).join(', ');
}

module.exports = { SUBJECT, build, byDept, byNumber, subjectText };
