// เลขที่บันทึกข้อความ (ฟังก์ชันเสริม docnoreq): ครูพิมพ์เฉพาะเลขที่ขอจากห้องวิชาการ ระบบเติมคำนำหน้าและ /ปี ให้
// คำนำหน้า (ค่าเริ่มต้น วก.) และปีหลังทับ (ปีการศึกษาของงาน หรือ ปี พ.ศ. ของวันที่ส่ง) ผู้ดูแลระบบตั้งได้ในหน้าตั้งค่าโรงเรียน
const { todayStr } = require('./time');

const DEFAULT_PREFIX = 'วก.';
// คำนำหน้าไม่มีตัวเลขและทับ ระบบจึงแยกเลขกลับได้เสมอ
const PREFIX_RE = /^[^0-9๐-๙/]{1,20}$/;
// เลขรูปแบบ คำนำหน้า+ตัวเลข/ปี 4 หลัก (คำนำหน้าใดก็ได้ ใช้กับเลขที่ตั้งไว้ก่อนเปลี่ยนคำนำหน้า)
const NO_RE = /^\s*([^0-9/]{0,20}?)\s*([0-9]+)\s*\/\s*([0-9]{4})\s*$/;

function prefix(settings) {
  const p = String((settings && settings.docno_prefix) || '').trim();
  return PREFIX_RE.test(p) ? p : DEFAULT_PREFIX;
}
function yearMode(settings) {
  return settings && settings.docno_year === 'calendar' ? 'calendar' : 'academic';
}
// ปีหลังทับของงาน: ปีการศึกษาของงาน หรือ ปี พ.ศ. ของวันที่ส่ง (ยังไม่เคยส่ง = วันนี้)
function yearOf(settings, sub) {
  if (yearMode(settings) === 'academic') return String(sub.academic_year);
  return String(Number(String(sub.submitted_at || todayStr()).slice(0, 4)) + 543);
}
// ตัวเลขในเลขเดิม เช่น วก.214/2569 ได้ 214 · ไม่ตรงรูปแบบได้ ''
function numOf(docNo) {
  const m = NO_RE.exec(String(docNo || ''));
  return m ? m[2] : '';
}
// ช่องตัวเลขจากฟอร์ม: เลขไทยเป็นอารบิก ตัดตัวอื่นและเลข 0 นำหน้า ไม่เกิน 6 หลัก
function cleanNum(v) {
  return String(v || '')
    .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/[^0-9]/g, '')
    .replace(/^0+(?=\d)/, '')
    .slice(0, 6);
}
// แยกเลขเป็นตัวเลขกับปี เช่น วก.214/2569 ได้ { num: 214, year: 2569 } · ไม่ตรงรูปแบบได้ null
function parse(docNo) {
  const m = NO_RE.exec(String(docNo || ''));
  return m ? { num: Number(m[2]), year: Number(m[3]) } : null;
}
function format(settings, num, year) {
  return num ? `${prefix(settings)}${num}/${year}` : '';
}

// ปรับเลขทุกงานให้เป็นรูปแบบปัจจุบัน: เฉพาะแผนและคู่มือที่เลขตรงรูปแบบ คำนำหน้า+ตัวเลข/ปี 4 หลัก คืนรายการที่จะเปลี่ยน
// โหมดปี พ.ศ. ตามวันที่ส่ง งานที่ยังไม่เคยส่งคงปีเดิม
function reformat(settings, rows) {
  const out = [];
  for (const r of rows) {
    const m = NO_RE.exec(String(r.doc_no || ''));
    if (!m) continue;
    const year = yearMode(settings) === 'calendar' && !r.submitted_at ? m[3] : yearOf(settings, r);
    const no = format(settings, String(Number(m[2])), year);
    if (no !== r.doc_no) out.push({ id: r.id, from: r.doc_no, to: no });
  }
  return out;
}

module.exports = { DEFAULT_PREFIX, PREFIX_RE, prefix, yearMode, yearOf, numOf, parse, cleanNum, format, reformat };
