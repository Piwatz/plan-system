// วัดเวลา CPU บน Node แทน Workers (วัดบน wrangler dev ไม่ได้) เทียบกับเพดาน 10 ms ของแบบฟรี
import ejs from 'ejs';
import QRCode from 'qrcode';
import { render } from './render.mjs';
import { locals } from './locals.mjs';

// งานทั้งหมดเป็นแบบ sync บนเธรดเดียว เวลาจริงจึงใกล้เคียงเวลา CPU (process.cpuUsage บน Windows ละเอียดแค่ราว 15 ms)
function cpuMs(fn) {
  const a = performance.now();
  const r = fn();
  return [performance.now() - a, r];
}
async function cpuMsAsync(fn) {
  const a = performance.now();
  await fn();
  return performance.now() - a;
}
const median = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];

// หน้า 100 แถว: เปลือกหน้าเต็ม (top + bottom แบบเข้าระบบแล้ว) + ตาราง 100 แถวแบบทะเบียนงาน
const rowsTpl = ejs.compile(
  '<table><% for (const r of rows) { %><tr><td><%= r.no %></td><td><%= r.teacher %></td><td><%= r.subject %></td><td><%= r.status %></td><td><%- icon("ok", 18) %></td></tr><% } %></table>',
  { strict: true, localsName: 'locals', destructuredLocals: ['rows', 'icon'], compileDebug: false }
);
const rows = Array.from({ length: 100 }, (_, i) => ({ no: i + 1, teacher: 'ครูสมมติ คนที่ ' + (i + 1), subject: 'ว' + (31101 + i) + ' ฟิสิกส์พื้นฐาน', status: 'รอหัวหน้ากลุ่มสาระ' }));
const page = () => render('error', locals('me')) + rowsTpl({ rows, icon: locals('me').icon });

const qr20 = () => Promise.all(Array.from({ length: 20 }, (_, i) => QRCode.toString('https://example.test/v/' + i.toString(36).padStart(10, 'x'), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })));
const big = Array.from({ length: 18000 }, (_, i) => ({ id: i, full_name: 'ครูสมมติ ' + i, note: 'ข้อความบันทึกหลังแผน'.repeat(3), score: i % 100 }));
const json = () => JSON.stringify(big);

// อุ่นเครื่องก่อน (ครั้งแรกบน Workers จะช้ากว่านี้ เพราะไม่มี JIT ที่อุ่นแล้ว)
const firstPage = cpuMs(page)[0];
const firstQr = await cpuMsAsync(qr20);
const firstJson = cpuMs(json)[0];
const runs = { page: [], qr: [], json: [] };
for (let i = 0; i < 15; i++) {
  runs.page.push(cpuMs(page)[0]);
  runs.qr.push(await cpuMsAsync(qr20));
  runs.json.push(cpuMs(json)[0]);
}
const size = (json().length / 1024 / 1024).toFixed(2);
console.log(`render หน้า 100 แถว: ครั้งแรก ${firstPage.toFixed(1)} ms · ค่ากลาง ${median(runs.page).toFixed(1)} ms · HTML ${(page().length / 1024).toFixed(0)} KB`);
console.log(`สร้าง QR 20 ตัว: ครั้งแรก ${firstQr.toFixed(1)} ms · ค่ากลาง ${median(runs.qr).toFixed(1)} ms`);
console.log(`JSON.stringify ${size} MB: ครั้งแรก ${firstJson.toFixed(1)} ms · ค่ากลาง ${median(runs.json).toFixed(1)} ms`);
