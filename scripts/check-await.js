// ตัวจับลืม await: ฐานข้อมูลเป็นแบบรอคำตอบแล้ว ทุกการเรียกที่คืน Promise ต้องมี await หรือ return นำหน้า
// ใช้: node scripts/check-await.js [ไฟล์ ...]  (ไม่ใส่ไฟล์ = ตรวจ src scripts tests ทั้งหมด) · เจอแล้วออกด้วยรหัส 1
// จับแบบหลายบรรทัดด้วย เช่น q\n  .all(
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// โมดูลที่มีฟังก์ชัน async และชื่อที่ไฟล์อื่นใช้เรียก
const MODULES = {
  'src/db.js': ['db'],
  'src/workflow.js': ['wf'],
  'src/auth.js': ['auth'],
  'src/features.js': ['features'],
  'src/teaching.js': ['teaching'],
  'src/line.js': ['line'],
};
// ฟังก์ชันใน db.js ที่ไม่ได้ประกาศแบบ async function แต่คืน Promise
const EXTRA = { 'src/db.js': ['open', 'close', 'migrate', 'ensureRefs', 'getSettings', 'setSetting', 'getLogo', 'withScope'] };

function asyncNames(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const names = new Set(EXTRA[rel] || []);
  for (const m of text.matchAll(/async function (\w+)/g)) names.add(m[1]);
  // ฟังก์ชันที่คืน q.* ตรง ๆ (เช่น getSub) ก็คืน Promise
  for (const m of text.matchAll(/function (\w+)\([^)]*\)\s*\{\s*return q\s*\.\s*(get|all|run|tx|exec)\(/g)) names.add(m[1]);
  return names;
}

const ASYNC = Object.fromEntries(Object.keys(MODULES).map((rel) => [rel, asyncNames(rel)]));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternsFor(rel, text) {
  const pats = [{ re: /(?<![\w.])(?:db\s*\.\s*)?q\s*\.\s*(get|all|run|tx|exec)\s*\(/g, label: (m) => 'q.' + m[1] }];
  for (const [mod, aliases] of Object.entries(MODULES)) {
    const names = [...ASYNC[mod]];
    if (!names.length) continue;
    const alt = names.map(escape).join('|');
    if (mod === rel) {
      // ในไฟล์ของตัวเอง เรียกชื่อตรง ๆ
      pats.push({ re: new RegExp(`(?<![\\w.])(${alt})\\s*\\(`, 'g'), label: (m) => m[1], own: true });
    }
    for (const a of aliases) pats.push({ re: new RegExp(`\\b${escape(a)}\\s*\\.\\s*(${alt})\\s*\\(`, 'g'), label: (m) => `${a}.${m[1]}` });
    // ชื่อที่ดึงออกมาด้วย const { ... } = require('./โมดูล')
    const base = path.basename(mod, '.js');
    const imp = new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*(?:require\\([^)]*/${escape(base)}'\\)|${aliases.map(escape).join('|')})\\s*;`, 'g');
    for (const m of text.matchAll(imp)) {
      const got = m[1]
        .split(',')
        .map((x) => x.split(':').pop().trim())
        .filter((x) => ASYNC[mod].has(x));
      if (got.length) pats.push({ re: new RegExp(`(?<![\\w.])(${got.map(escape).join('|')})\\s*\\(`, 'g'), label: (mm) => mm[1] });
    }
  }
  return pats;
}

function okBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 40), idx).replace(/\s+$/, '');
  // ส่ง Promise ให้ตัวที่รอเอง: assert.rejects( · Promise.all([ · Promise.allSettled([ (ทั้งตัวแรกและตัวถัดไปในรายการ)
  if (/\brejects\($/.test(before) || /Promise\.(all|allSettled|race)\(\[[^\]]*$/.test(text.slice(Math.max(0, idx - 300), idx))) return true;
  return /(\bawait|\breturn|=>|\bfunction\s+\w+|\basync\s+function\s+\w+|\bfunction)$/.test(before) || /(?:^|[,{]\s*)\w+\s*:\s*(async\s*)?$/.test(before);
}

function check(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const p of patternsFor(rel, text)) {
    for (const m of text.matchAll(p.re)) {
      const idx = m.index;
      // ข้ามการประกาศฟังก์ชัน และชื่อในคอมเมนต์บรรทัดเดียว
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', idx) === -1 ? text.length : text.indexOf('\n', idx));
      if (/^\s*\/\//.test(line) || line.slice(0, idx - lineStart).includes('//')) continue;
      // ตั้งใจเก็บ Promise ไว้รอทีหลัง ให้เขียนคอมเมนต์ "ตั้งใจไม่ await" ท้ายบรรทัด
      if (line.includes('ตั้งใจไม่ await')) continue;
      if (/function\s*$/.test(text.slice(lineStart, idx))) continue;
      if (okBefore(text, idx)) continue;
      out.push(`${rel}:${text.slice(0, idx).split('\n').length}  ${p.label(m)}( ไม่มี await หรือ return นำหน้า`);
    }
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(ROOT, f)) : ['src', 'scripts', 'tests'].flatMap((d) => walk(path.join(ROOT, d)));
const problems = files.filter((f) => !f.endsWith('check-await.js')).flatMap(check);
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\nพบ ${problems.length} จุดที่อาจลืม await`);
  process.exit(1);
}
console.log(`ตรวจ ${files.length} ไฟล์ ไม่พบจุดลืม await`);
