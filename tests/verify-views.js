// โหลดก่อนชุดทดสอบทุกไฟล์ (node --test --require): ทุกครั้งที่ render หน้าเว็บด้วย template ที่ compile แล้ว
// ให้ render ซ้ำด้วย EJS ปกติในการเรียกเดียวกัน แล้วต้องได้ HTML ตรงกันทุกไบต์ ไม่ตรงถือว่าทดสอบไม่ผ่าน
const fs = require('fs');
const os = require('os');
const path = require('path');
const ejs = require('ejs');
const { setVerifier } = require('../src/view');

const VIEWS = path.resolve(__dirname, '..', 'views');
const LOG = process.env.VIEW_VERIFY_LOG || path.join(os.tmpdir(), 'plan-view-verify.log');
const seen = new Map();
const bad = [];

setVerifier((name, options, html) => {
  try {
    check(name, options, html);
  } catch (e) {
    // บางชุดทดสอบไม่ได้ตรวจรหัสตอบกลับ จึงจดไว้ด้วย ตรวจซ้ำได้จากไฟล์ log
    bad.push(e.message.split('\n')[0]);
    throw e;
  }
});

function check(name, options, html) {
  let expected;
  let error = null;
  ejs.renderFile(path.join(VIEWS, name + '.ejs'), options, (err, out) => {
    error = err;
    expected = out;
  });
  if (error) throw new Error(`views/${name}.ejs: EJS ปกติ error แต่แบบ compile แล้วไม่ error: ${error.message.split('\n')[0]}`);
  if (expected !== html) {
    let i = 0;
    while (i < html.length && html[i] === expected[i]) i++;
    throw new Error(`views/${name}.ejs: HTML ไม่ตรงกับ EJS ปกติ ตำแหน่ง ${i}\nEJS:     ${JSON.stringify(expected.slice(i, i + 80))}\ncompile: ${JSON.stringify(html.slice(i, i + 80))}`);
  }
  seen.set(name, (seen.get(name) || 0) + 1);
}

process.on('exit', () => {
  if (!seen.size && !bad.length) return;
  const lines = [...[...seen].map(([n, c]) => `${n}\t${c}`), ...bad.map((m) => `ไม่ตรง\t${m}`)].join('\n');
  try {
    fs.appendFileSync(LOG, lines + '\n');
  } catch {
    // ไม่สำคัญต่อผลทดสอบ
  }
});
