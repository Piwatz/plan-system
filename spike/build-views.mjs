// ตอน 1 ข้อ 3: compile template ล่วงหน้าเป็น JS ธรรมดา (ต้นแบบของ scripts/build-views.js ในตอน 3)
// รันบน Node ตอน build เท่านั้น ห้าม import ejs ในโค้ดที่รันบน Workers
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(HERE, '..', 'views');
const NAMES = ['error', 'partials/top', 'partials/bottom'];

// built-in ของ ECMAScript เท่านั้น ห้ามใช้รายการ global ของเบราว์เซอร์ (window ในโปรเจกต์นี้เป็น locals จริง)
const BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'Math', 'JSON', 'Date', 'Intl', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'Symbol', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
]);
const PARAMS = 'locals, escapeFn, include, rethrow';
const BASE = { strict: true, localsName: 'locals', compileDebug: false, rmWhitespace: false };

function sourceOf(text, filename, destructuredLocals) {
  const t = new ejs.Template(text, { ...BASE, filename, destructuredLocals });
  t.generateSource();
  // ประกอบแบบเดียวกับ ejs.js compile() (strict จึงไม่มี with)
  let pre = '  var __output = "";\n  function __append(s) { if (s !== undefined && s !== null) __output += s }\n';
  if (destructuredLocals.length) {
    pre += '  var __locals = (locals || {}),\n  ' + destructuredLocals.map((n) => `${n} = __locals.${n}`).join(',\n  ') + ';\n';
  }
  return '"use strict";\n' + pre + t.source + '  return __output;\n';
}

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
  return { free: [...free].sort(), writes: [...writes] };
}

const out = [];
const report = [];
for (const name of NAMES) {
  const file = path.join(VIEWS, name + '.ejs');
  const text = fs.readFileSync(file, 'utf8');
  const first = analyse(sourceOf(text, file, []));
  const src = sourceOf(text, file, first.free);
  const check = analyse(src);
  if (check.free.length) throw new Error(`${name}: ยังเหลือตัวแปรอิสระ ${check.free.join(' ')}`);
  if (first.writes.length) report.push(`${name}: กำหนดค่าให้ตัวแปรอิสระ ${first.writes.join(' ')}`);
  out.push(`  ${JSON.stringify(name)}: function (${PARAMS}) {\n${src}  }`);
  console.log(`${name}: ตัวแปรจาก locals ${first.free.length} ตัว (${first.free.join(' ')})`);
}
fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'dist', 'views.mjs'), `// สร้างโดย build-views.mjs ห้ามแก้เอง\nexport const views = {\n${out.join(',\n')}\n};\n`);
console.log(report.length ? report.join('\n') : 'ไม่มีจุดกำหนดค่าให้ตัวแปรอิสระ');
