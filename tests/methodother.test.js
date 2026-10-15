// ฟังก์ชันเสริม methodother: รูปแบบการจัดการเรียนรู้ อื่น ๆ (ระบุ) รวมกับช่องที่ติ๊ก
const test = require('node:test');
const assert = require('node:assert/strict');
const { methodsOf } = require('../src/routes/work');

test('ช่องอื่น ๆ รวมกับช่องที่ติ๊ก แยกด้วยจุลภาคหรือบรรทัดใหม่ ไม่ซ้ำ ไม่เกิน 5 รูปแบบ ปิดสวิตช์แล้วไม่รับ', () => {
  const b = { teaching_methods: ['Active Learning', 'สะเต็มศึกษา (STEM)'], teaching_methods_other: ' การเรียนรู้แบบโครงงาน ,Active Learning\nเกม , , ' };
  assert.deepEqual(methodsOf(b, { methodother: true }), ['Active Learning', 'สะเต็มศึกษา (STEM)', 'การเรียนรู้แบบโครงงาน', 'เกม']);
  assert.deepEqual(methodsOf(b, { methodother: false }), ['Active Learning', 'สะเต็มศึกษา (STEM)']);
  assert.deepEqual(methodsOf({ teaching_methods: 'ข้อเดียว' }, { methodother: true }), ['ข้อเดียว']);
  assert.equal(methodsOf({ teaching_methods_other: 'ก,ข,ค,ง,จ,ฉ,ช' }, { methodother: true }).length, 5);
});
