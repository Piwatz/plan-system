// แปลงหน้าเว็บ EJS ทุกไฟล์ใน views/ เป็นฟังก์ชัน JS ธรรมดาไว้ที่ dist/views.js (npm run build)
// เหตุผล: Cloudflare Workers ห้าม eval และ new Function ซึ่ง EJS ใช้ตอนรัน จึงใช้ EJS เฉพาะตอน build เท่านั้น
// รันเองได้: node scripts/build-views.js  (server.js และ npm test เรียกให้อัตโนมัติ)
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const ROOT = path.resolve(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const OUT = path.join(ROOT, 'dist', 'views.js');

// built-in ของ ECMAScript เท่านั้น ห้ามใช้รายการ global ของเบราว์เซอร์ (window ในโปรเจกต์นี้เป็น locals จริง)
const BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'Math', 'JSON', 'Date', 'Intl', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'Symbol', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  // ไม่ใช่ ECMAScript แต่เป็นมาตรฐาน WHATWG ที่มีทั้งบน Node และ Workers ใช้ใน views/registry.ejs
  'URLSearchParams',
]);
const PARAMS = 'locals, escapeFn, include, rethrow';

function listViews(dir = VIEWS, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listViews(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.ejs')) out.push(rel.slice(0, -4));
  }
  return out.sort();
}

// ประกอบตัวฟังก์ชันแบบเดียวกับ ejs.js compile() (ejs 6.0.1 บรรทัด 529 ถึง 581) โดยตั้ง strict จึงไม่มี with
function sourceOf(text, filename, destructuredLocals) {
  const t = new ejs.Template(text, { strict: true, localsName: 'locals', compileDebug: false, filename, destructuredLocals });
  t.generateSource();
  let pre = '  var __output = "";\n  function __append(s) { if (s !== undefined && s !== null) __output += s }\n';
  if (destructuredLocals.length) {
    pre += '  var __locals = (locals || {}),\n  ' + destructuredLocals.map((n) => `${n} = __locals.${n}`).join(',\n  ') + ';\n';
  }
  return '"use strict";\n' + pre + t.source + '  return __output;\n';
}

// หาตัวแปรอิสระด้วยการวิเคราะห์ขอบเขตตัวแปรจริง และจุดที่ template กำหนดค่าให้ตัวแปรเหล่านั้น
function analyse(src) {
  const ast = acorn.parse(`function __tpl(${PARAMS}) {\n${src}\n}`, { ecmaVersion: 2022, sourceType: 'script', ranges: true });
  const manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const free = new Set();
  const writes = new Set();
  for (const ref of manager.globalScope.through) {
    const n = ref.identifier.name;
    if (n === '__tpl' || BUILTINS.has(n)) continue;
    free.add(n);
    if (ref.isWrite()) writes.add(n);
  }
  return { free: [...free].sort(), writes: [...writes].sort() };
}

function build({ quiet = false } = {}) {
  const names = listViews();
  const parts = [];
  const writes = [];
  const allFree = new Set();
  for (const name of names) {
    const file = path.join(VIEWS, name + '.ejs');
    const text = fs.readFileSync(file, 'utf8');
    const first = analyse(sourceOf(text, file, []));
    const src = sourceOf(text, file, first.free);
    const left = analyse(src).free;
    if (left.length) throw new Error(`views/${name}.ejs ยังเหลือตัวแปรอิสระ ${left.join(' ')}`);
    if (first.writes.length) writes.push(`views/${name}.ejs กำหนดค่าให้ตัวแปรอิสระ ${first.writes.join(' ')}`);
    first.free.forEach((n) => allFree.add(n));
    parts.push(`  ${JSON.stringify(name)}: function (${PARAMS}) {\n${src}  }`);
  }
  if (writes.length) throw new Error('template กำหนดค่าให้ตัวแปรอิสระ ต้องแก้ก่อน\n' + writes.join('\n'));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const body = `// สร้างโดย scripts/build-views.js จาก views/ ห้ามแก้เอง\n'use strict';\nmodule.exports = {\n${parts.join(',\n')}\n};\n`;
  fs.writeFileSync(OUT, body);
  if (!quiet) {
    console.log(`แปลงหน้าเว็บ ${names.length} ไฟล์ไว้ที่ dist/views.js (${Math.round(body.length / 1024)} KB)`);
    console.log(`ตัวแปรจาก locals ทั้งหมด ${allFree.size} ตัว: ${[...allFree].sort().join(' ')}`);
    console.log('ไม่มีจุดที่ template กำหนดค่าให้ตัวแปรอิสระ');
  }
  return { count: names.length, free: [...allFree].sort() };
}

if (require.main === module) build();

module.exports = { build, listViews };
