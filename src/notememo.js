// บันทึกข้อความส่งบันทึกหลังสอน (ฟังก์ชันเสริม notememo) 1 ฉบับต่อเล่ม = บันทึกหลังแผนทุกแผ่นที่ส่งแล้วของแผน 1 วิชา
// ช่องความเห็นตามระดับที่ลงนามบันทึกหลังแผนจริงในระบบ (wf.activeSteps('note')) ลายเซ็นของระดับใดขึ้นเมื่อทุกแผ่นผ่านระดับนั้นแล้ว
// เลขที่บันทึกข้อความ (ฟังก์ชันเสริม notedocno) เก็บในช่อง doc_no ของทุกแผ่นในเล่ม ไม่ต้องเพิ่มคอลัมน์

// เลขของเล่ม: เลขจากแผ่นที่แก้ล่าสุดที่มีเลข
function bookNo(notes) {
  const has = notes.filter((n) => String(n.doc_no || '').trim());
  if (!has.length) return '';
  return [...has].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || b.id - a.id)[0].doc_no;
}

// วันที่ในบันทึกข้อความ: วันที่ส่งล่าสุดของเล่ม (แผ่นที่ส่งทีหลังเลื่อนวันที่ตาม)
function bookDate(notes) {
  const ds = notes.map((n) => n.submitted_at || '').filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : '';
}

// ความเห็นที่ใช้มากที่สุดของระดับนั้น (ผู้ตรวจลงนามทั้งเล่ม ความเห็นตั้งไว้ รับทราบ ทุกแผ่น)
function topComment(reviews) {
  const count = new Map();
  for (const r of reviews) {
    const c = String(r.comment || '').trim() || 'รับทราบ';
    count.set(c, (count.get(c) || 0) + 1);
  }
  let best = 'รับทราบ';
  let n = 0;
  for (const [c, k] of count) if (k > n) [best, n] = [c, k];
  return best;
}

// รวมสถานะรายแผ่นเป็นช่องลงนามของบันทึกข้อความ · stepsList = ผลของ wf.progressMany ของทุกแผ่นที่ส่งแล้ว (เรียงระดับเดียวกัน)
// ทุกแผ่นผ่านระดับนั้น (ลงนาม ดำเนินการแทน หรือข้ามเพราะครูดำรงตำแหน่งนั้นเอง) ใช้การลงนามล่าสุดของระดับนั้น
// ยังไม่ครบทุกแผ่น เว้นช่องว่างไว้ ไม่ใส่ลายเซ็น
function combineSteps(stepsList) {
  if (!stepsList.length) return [];
  return stepsList[0].map((first, i) => {
    const col = stepsList.map((steps) => steps[i]).filter(Boolean);
    const passed = col.length === stepsList.length && col.every((s) => s.state === 'done' || s.state === 'skipped');
    if (!passed) return { ...first, state: 'waiting', review: null };
    const revs = col.map((s) => s.review).filter(Boolean);
    if (!revs.length) return { ...first, state: 'skipped', review: null };
    const last = [...revs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id)[revs.length - 1];
    const approves = revs.filter((r) => r.action === 'approve');
    const review = last.action === 'approve' ? { ...last, comment: topComment(approves) } : last;
    return { ...first, state: 'done', review };
  });
}

module.exports = { bookNo, bookDate, topComment, combineSteps };
