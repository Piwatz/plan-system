// ลำดับกล่องบนหน้าแรก (ฟังก์ชันเสริม homeorder mobileorder) ผู้ดูแลระบบจัดในหน้า /admin/homeorder แยกคอมกับมือถือได้
// ค่าเก็บใน settings เป็น JSON [{ k, on }]: home_order ของคอม home_order_m ของมือถือ · home_order_m_mode = same ให้มือถือตามคอม
// แถบต้อนรับและคำเตือนสำคัญอยู่บนสุดเสมอ จึงไม่อยู่ในรายการนี้ · แถบแจ้งเตือนอยู่บนสุดเช่นกัน แต่เปิดปิดได้แยกคอมกับมือถือ (home_alerts_pc home_alerts_m)
// keep = ซ่อนไม่ได้ เหลือเฉพาะงานรอลงนามบนคอม เพราะเป็นงานค้างของผู้ตรวจ ส่วนกล่องอื่นผู้ดูแลระบบเลือกเอง ครูยังเข้าถึงได้จากเมนู

const BOXES = [
  { k: 'lib', label: 'เล่มใหม่ในคลัง', sel: '.home-layout > .lib-fill' },
  { k: 'inbox', label: 'งานรอลงนาม', note: 'เห็นเฉพาะผู้ตรวจ', keep: true, sel: '.home-layout > .review-panel' },
  { k: 'subjects', label: 'รายวิชาของฉัน', sel: '.home-layout .card.flush' },
  { k: 'todo', label: 'สิ่งที่ต้องทำต่อ', sel: '.home-layout > .home-todo' },
  { k: 'stats', label: 'กล่องตัวเลข', sel: '.home-layout > .grid-4' },
  { k: 'activity', label: 'ความเคลื่อนไหวล่าสุด', sel: '.home-layout .home-activity' },
  { k: 'bar', label: 'แถบส่งงานใหม่', sel: '.home-layout > .todo-bar' },
];

// มือถือมี 4 กล่อง ค่าเริ่มต้นให้ตัวเลขสรุปกับงานมาก่อน เพราะจอเล็กและครูเปิดมือถือเพื่อทำงานให้เสร็จ
const MOBILE_BOXES = [
  { k: 'stats', label: 'แถบตัวเลขสรุป', note: 'เห็นเฉพาะครู', sel: '.hm-layout > .grid-4' },
  { k: 'todo', label: 'สิ่งที่ต้องทำต่อ', sel: '.hm-layout > .m-next' },
  { k: 'lib', label: 'เล่มใหม่ในคลัง', note: 'ปกแถวเล็ก ปัดซ้ายขวาได้', sel: '.hm-layout > .lib-strip' },
  { k: 'subjects', label: 'รายวิชาของฉัน', sel: '.hm-layout > .hm-subjects' },
];

// อ่านค่าที่เก็บไว้หรือที่ส่งมาจากฟอร์ม ค่าเสียหรือกล่องแปลกปลอมไม่ทำให้หน้าแรกพัง กล่องที่ขาดกลับมาต่อท้าย
function parse(raw, boxes = BOXES) {
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
    const box = boxes.find((b) => r && b.k === r.k);
    if (!box || seen.has(box.k)) continue;
    seen.add(box.k);
    out.push({ ...box, on: box.keep ? true : r.on !== false });
  }
  for (const box of boxes) if (!seen.has(box.k)) out.push({ ...box, on: true });
  return out;
}

function parseMobile(raw) {
  return parse(raw, MOBILE_BOXES);
}

// ค่าที่เก็บลงฐานข้อมูล
function serialize(list) {
  return JSON.stringify(list.map((b) => ({ k: b.k, on: b.on })));
}

// ลำดับมือถือที่ใช้จริง โหมด same ใช้ลำดับและการซ่อนจากคอม
function mobileList(settings) {
  if (settings.home_order_m_mode !== 'same') return parseMobile(settings.home_order_m);
  return parse(settings.home_order)
    .map((b) => {
      const box = MOBILE_BOXES.find((m) => m.k === b.k);
      return box && { ...box, on: b.on };
    })
    .filter(Boolean);
}

// แถบแจ้งเตือนแสดงบนอุปกรณ์ไหน ค่าเริ่มต้นแสดงทั้งคู่ ปิดฟังก์ชันเสริมแล้วกลับมาแสดงเหมือนเดิม
function alertsShown(settings, ff) {
  const pc = !(ff.homelayout && ff.homeorder) || settings.home_alerts_pc !== '0';
  if (!ff.homelayout || !ff.mobileorder) return { pc, m: true };
  return { pc, m: settings.home_order_m_mode === 'same' ? pc : settings.home_alerts_m !== '0' };
}

// CSS ของหน้าแรก ใช้ตัวเลือกเดียวกับ app.css จึงทับลำดับเริ่มต้นได้
function css(list) {
  return list.map((b, i) => `${b.sel}{order:${i + 1}${b.on ? '' : ';display:none'}}`).join('');
}

// เมนูผู้ดูแลบนมือถือตามหลังกล่องสิ่งที่ต้องทำต่อเสมอ เหมือนเดิม (order เท่ากัน เรียงตามที่เขียนในหน้า)
function cssMobile(list) {
  const todo = list.findIndex((b) => b.k === 'todo');
  return `${css(list)}.hm-layout > .hm-admin{order:${todo + 1}}`;
}

module.exports = { BOXES, MOBILE_BOXES, parse, parseMobile, serialize, mobileList, alertsShown, css, cssMobile };
