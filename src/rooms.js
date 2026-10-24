// จำนวนนักเรียนรายห้องของบันทึกหลังแผน (ฟังก์ชันเสริม noterooms)
// ฟอร์มส่งแถวละห้อง room_name room_total room_passed · แถวเดียวไม่ใส่ห้อง = กรอกยอดรวม ไม่เก็บรายห้อง
// ยอดรวมเก็บที่ students_total students_passed เสมอ (กราฟผลการสอน แฟ้ม PA ใช้ยอดรวม) รายห้องเก็บที่ student_rooms เป็น JSON
const MAX_ROOMS = 20;

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
function count(v) {
  const t = String(v ?? '').replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)).trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t);
}

// แถวจากฟอร์ม → { rooms, total, passed } แถวที่ว่างทั้งแถวตัดทิ้ง
// total = ผลบวกของห้องที่กรอกจำนวน · passed = ผลบวกเมื่อทุกห้องที่กรอกจำนวนกรอกที่ผ่านด้วย ไม่ครบ = null (ยังไม่นับในกราฟ)
function fromForm(b) {
  const names = asList(b.room_name);
  const totals = asList(b.room_total);
  const passes = asList(b.room_passed);
  const n = Math.min(Math.max(names.length, totals.length, passes.length), MAX_ROOMS);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const room = String(names[i] ?? '').trim().slice(0, 30);
    const total = count(totals[i]);
    const passed = count(passes[i]);
    if (!room && total == null && passed == null) continue;
    rows.push({ room, total, passed });
  }
  const counted = rows.filter((r) => r.total != null);
  const total = counted.length ? counted.reduce((s, r) => s + r.total, 0) : null;
  const passed = counted.length && counted.every((r) => r.passed != null) ? counted.reduce((s, r) => s + r.passed, 0) : null;
  // แถวเดียวที่ไม่ใส่ห้อง = กรอกยอดรวม ไม่ต้องเก็บรายห้อง
  const split = rows.length > 1 || (rows.length === 1 && rows[0].room);
  return { rooms: split ? JSON.stringify(rows) : '', total, passed };
}

// รายห้องที่เก็บไว้ ไม่มีหรืออ่านไม่ได้ได้ []
function parse(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : [];
  } catch {
    return [];
  }
}

// ห้องที่จำนวนผ่านมากกว่าจำนวนนักเรียน
function overflow(text) {
  return parse(text).filter((r) => r.total != null && r.passed != null && r.passed > r.total);
}

module.exports = { MAX_ROOMS, fromForm, parse, overflow };
