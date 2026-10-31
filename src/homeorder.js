// ลำดับกล่องบนหน้าแรก (ฟังก์ชันเสริม homeorder) ผู้ดูแลระบบจัดในหน้า /admin/homeorder ใช้กับหน้าจอคอมของทุกคน
// ค่าเก็บใน settings.home_order เป็น JSON [{ k, on }] · แถบต้อนรับและคำเตือนสำคัญอยู่บนสุดเสมอ จึงไม่อยู่ในรายการนี้
// keep = ซ่อนไม่ได้ เพราะเป็นทางเห็นงานค้างของครูและผู้ตรวจ

const BOXES = [
  { k: 'lib', label: 'เล่มใหม่ในคลัง', sel: '.home-layout > .lib-fill' },
  { k: 'inbox', label: 'งานรอลงนาม', note: 'เห็นเฉพาะผู้ตรวจ', keep: true, sel: '.home-layout > .review-panel' },
  { k: 'subjects', label: 'รายวิชาของฉัน', keep: true, sel: '.home-layout .card.flush' },
  { k: 'todo', label: 'สิ่งที่ต้องทำต่อ', sel: '.home-layout > .home-todo' },
  { k: 'stats', label: 'กล่องตัวเลข', sel: '.home-layout > .grid-4' },
  { k: 'activity', label: 'ความเคลื่อนไหวล่าสุด', sel: '.home-layout .home-activity' },
  { k: 'bar', label: 'แถบส่งงานใหม่', sel: '.home-layout > .todo-bar' },
];

// อ่านค่าที่เก็บไว้หรือที่ส่งมาจากฟอร์ม ค่าเสียหรือกล่องแปลกปลอมไม่ทำให้หน้าแรกพัง กล่องที่ขาดกลับมาต่อท้าย
function parse(raw) {
  let rows = [];
  try {
    rows = JSON.parse(raw || '[]');
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) rows = [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const box = BOXES.find((b) => r && b.k === r.k);
    if (!box || seen.has(box.k)) continue;
    seen.add(box.k);
    out.push({ ...box, on: box.keep ? true : r.on !== false });
  }
  for (const box of BOXES) if (!seen.has(box.k)) out.push({ ...box, on: true });
  return out;
}

// ค่าที่เก็บลงฐานข้อมูล
function serialize(list) {
  return JSON.stringify(list.map((b) => ({ k: b.k, on: b.on })));
}

// CSS ของหน้าแรก ใช้ตัวเลือกเดียวกับ app.css จึงทับลำดับเริ่มต้นได้
function css(list) {
  return list.map((b, i) => `${b.sel}{order:${i + 1}${b.on ? '' : ';display:none'}}`).join('');
}

module.exports = { BOXES, parse, serialize, css };
