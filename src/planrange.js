// บันทึกหลังแผนแบบแนบไฟล์ 1 ไฟล์มีหลายแผน (ฟังก์ชันเสริม notewhole) เก็บในช่อง plan_no เดิม ไม่ต้องเพิ่มคอลัมน์
// แผนเดียว = ตัวเลข เช่น 3 · หลายแผน = ช่วง เช่น 1-9 · ทั้งเล่ม = คำว่า ทั้งเล่ม
const BOOK = 'ทั้งเล่ม';
const RANGE_RE = /^(\d{1,3})-(\d{1,3})$/;

function scopeOf(planNo) {
  const p = String(planNo || '').trim();
  if (p === BOOK) return 'book';
  if (RANGE_RE.test(p)) return 'range';
  return 'one';
}

// [แผนแรก, แผนสุดท้าย] ของช่วง ไม่ใช่ช่วงได้ null
function rangeOf(planNo) {
  const m = RANGE_RE.exec(String(planNo || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ช่วงจากฟอร์ม: เรียงให้น้อยไปมาก เลขเดียวกันเป็นแผนเดียว ไม่ครบได้ ''
function fromForm(a, b) {
  const x = Number.parseInt(String(a || '').trim(), 10);
  const y = Number.parseInt(String(b || '').trim(), 10);
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= 999;
  if (!ok(x) || !ok(y)) return '';
  if (x === y) return String(x);
  return `${Math.min(x, y)}-${Math.max(x, y)}`;
}

// เลขแผนทุกเลขที่ช่องนี้ครอบคลุม (ทั้งเล่มไม่นับ) ใช้หาแผนที่ข้ามและเลขแผนถัดไป
function numbers(planNo) {
  const p = String(planNo || '').trim();
  const r = rangeOf(p);
  if (r) return Array.from({ length: r[1] - r[0] + 1 }, (_, i) => r[0] + i);
  return /^\d{1,3}$/.test(p) ? [Number(p)] : [];
}

// ข้อความบนหน้าจอ เช่น แผนที่ 3 · แผนที่ 1 ถึง 9 · ทั้งเล่ม
function label(planNo) {
  const p = String(planNo || '').trim();
  if (p === BOOK) return BOOK;
  const r = rangeOf(p);
  if (r) return `แผนที่ ${r[0]} ถึง ${r[1]}`;
  return p ? `แผนที่ ${p}` : '';
}

// ในช่องตารางที่หัวคอลัมน์เป็น แผนที่ อยู่แล้ว เช่น 3 · 1 ถึง 9 · ทั้งเล่ม
function short(planNo) {
  const p = String(planNo || '').trim();
  const r = rangeOf(p);
  return r ? `${r[0]} ถึง ${r[1]}` : p;
}

module.exports = { BOOK, scopeOf, rangeOf, fromForm, numbers, label, short };
