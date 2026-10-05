// สร้าง db/seed.sql (ค่าเริ่มต้นของเว็บจริง) จาก src/defaults.js และ src/features.js
// รันใหม่ทุกครั้งที่แก้ค่าเริ่มต้นหรือเพิ่มฟังก์ชันเสริม: node scripts/make-seed-sql.js
// seed.sql รันซ้ำได้ไม่ทับของเดิม (ค่าตั้งที่มีอยู่แล้ว กลุ่มสาระและแบบประเมินที่มีแล้วไม่เพิ่มซ้ำ)
const fs = require('fs');
const path = require('path');
const { DEFAULT_DEPARTMENTS, DEFAULT_STEPS, DEFAULT_RUBRICS, DEFAULT_SETTINGS } = require('../src/defaults');
const features = require('../src/features');

const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function build() {
  const settings = { ...DEFAULT_SETTINGS, ...features.defaultSettings() };
  const rows = Object.keys(settings).map((k) =>
    // ปีการศึกษาเริ่มต้น = ปีปัจจุบันตามเวลาไทย + 543 คิดตอนรัน seed ไม่ฝังตัวเลขไว้ในไฟล์
    k === 'academic_year' ? `  ('academic_year', ((extract(year from now() at time zone 'Asia/Bangkok'))::integer + 543)::text)` : `  (${lit(k)}, ${lit(settings[k])})`
  );
  const out = [];
  out.push('-- ค่าเริ่มต้นของระบบส่งแผนการสอน สร้างโดย scripts/make-seed-sql.js ห้ามแก้เอง');
  out.push('-- รันซ้ำได้ ไม่ทับค่าที่ผู้ดูแลระบบตั้งไว้แล้ว');
  out.push('');
  out.push(`-- ค่าตั้ง ${rows.length} คีย์`);
  out.push('insert into settings (key, value) values');
  out.push(rows.join(',\n'));
  out.push('on conflict (key) do nothing;');
  out.push('');
  out.push(`-- กลุ่มสาระ ${DEFAULT_DEPARTMENTS.length} กลุ่ม (เฉพาะตอนยังไม่มีกลุ่มสาระเลย)`);
  out.push('insert into departments (name, sort)');
  out.push('select v.name, v.sort from (values');
  out.push(DEFAULT_DEPARTMENTS.map((n, i) => `  (${lit(n)}, ${i + 1})`).join(',\n'));
  out.push(') as v (name, sort)');
  out.push('where not exists (select 1 from departments);');
  out.push('');
  out.push(`-- ขั้นตอนตรวจ ${DEFAULT_STEPS.length} ระดับ`);
  out.push('insert into workflow_steps (role, seq, label, scope, for_note) values');
  out.push(DEFAULT_STEPS.map((s) => `  (${lit(s.role)}, ${s.seq}, ${lit(s.label)}, ${lit(s.scope)}, ${s.for_note})`).join(',\n'));
  out.push('on conflict (role) do nothing;');
  for (const [type, items] of Object.entries(DEFAULT_RUBRICS)) {
    out.push('');
    out.push(`-- แบบประเมิน ${type} ${items.length} ข้อ (เฉพาะตอนยังไม่มีแบบประเมินของชนิดนี้)`);
    out.push('insert into rubric_items (doc_type, seq, title, max_score)');
    out.push('select v.doc_type, v.seq, v.title, 5 from (values');
    out.push(items.map((t, i) => `  (${lit(type)}, ${i + 1}, ${lit(t)})`).join(',\n'));
    out.push(') as v (doc_type, seq, title)');
    out.push(`where not exists (select 1 from rubric_items where doc_type = ${lit(type)});`);
  }
  out.push('');
  return out.join('\n');
}

if (require.main === module) {
  const file = path.resolve(__dirname, '..', 'db', 'seed.sql');
  fs.writeFileSync(file, build());
  console.log('เขียน db/seed.sql แล้ว');
}

module.exports = { build };
