// ยิงทดสอบ 10 ข้อไปที่ wrangler dev แล้วเทียบกับผลบน Node
import crypto from 'node:crypto';
import ejs from 'ejs';
import QRCode from 'qrcode';
import { locals } from './locals.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ใบรับรองทดลองของ wrangler dev
const BASE = 'https://127.0.0.1:8787';
const get = (p, o) => fetch(BASE + p, o);
const results = [];
function rec(no, name, pass, detail) {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'ผ่าน' : 'ไม่ผ่าน'} ข้อ ${no} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
async function step(no, name, fn) {
  try {
    await fn();
  } catch (e) {
    rec(no, name, false, String(e.stack || e));
  }
}

await step(1, 'Express 5 ผ่าน handleAsNodeRequest', async () => {
  const r = await get('/');
  const j = await r.json();
  rec(1, 'Express 5 ผ่าน handleAsNodeRequest', r.status === 200 && j.ok === true, j);
});
await step(2, 'import src/config.js', async () => {
  const j = await (await get('/config')).json();
  rec(2, 'import src/config.js', !!j.ROOT, j);
});
await step(3, 'EJS compile ล่วงหน้า', async () => {
  const out = [];
  let all = true;
  for (const k of ['guest', 'me']) {
    const a = await ejs.renderFile('../views/error.ejs', locals(k));
    const b = await (await get('/error-page?kind=' + k)).text();
    all = all && a === b;
    out.push(`${k}: Node ${a.length} ตัวอักษร Workers ${b.length} ตัวอักษร ${a === b ? 'ตรงทุกไบต์' : 'ต่าง'}`);
  }
  rec(3, 'EJS compile ล่วงหน้า', all, out.join(' · '));
});
await step(4, 'cookie-session secure', async () => {
  const r1 = await get('/cookie');
  const c = r1.headers.get('set-cookie') || '';
  const j1 = await r1.json();
  const cookie = c.split(/,(?=\s*spike)/).map((s) => s.split(';')[0].trim()).join('; ');
  const j2 = await (await get('/cookie', { headers: { cookie } })).json();
  rec(4, 'cookie-session secure', r1.status === 200 && /secure/i.test(c) && j2.n === 2, { status: r1.status, first: j1, second: j2, secureFlag: /secure/i.test(c) });
});
await step(5, 'IP ผู้ใช้', async () => {
  const j = await (await get('/ip')).json();
  rec(5, 'IP ผู้ใช้', !!j.cf, j);
});
await step(6, 'AsyncLocalStorage', async () => {
  const r = await get('/als', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=%E0%B8%97%E0%B8%94%E0%B8%A5%E0%B8%AD%E0%B8%87' });
  const j = await r.json();
  rec(6, 'AsyncLocalStorage', j.store && j.store.inner === '/als' && j.body === 'ทดลอง', j);
});
await step(7, 'ส่งต่อข้อมูลดิบ 5 MB', async () => {
  const buf = crypto.randomBytes(5 * 1024 * 1024);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const r = await get('/chunk', { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
  const j = await r.json();
  rec(7, 'ส่งต่อข้อมูลดิบ 5 MB', j.size === buf.length && j.sha256 === sha, { sent: buf.length, got: j.size, sameHash: j.sha256 === sha, chunked: j.chunked, error: j.error && j.error.slice(0, 300) });
});
await step(8, 'pg ผ่าน Hyperdrive ในเครื่อง', async () => {
  const one = await (await get('/db?tag=single')).json();
  const t = Date.now();
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => Promise.race([
    get('/db?tag=p' + i).then((r) => r.json()),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 15000)),
  ])));
  const ok = one.one === 1 && many.every((m, i) => m.one === 1 && m.tag === 'p' + (i + 1));
  rec(8, 'pg ผ่าน Hyperdrive ในเครื่อง', ok, { single: one, parallel: many, ms: Date.now() - t });
});
await step(9, 'qrcode', async () => {
  const u = 'https://example.test/v/abc123';
  const a = await QRCode.toString(u, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  const b = await (await get('/qr?u=' + encodeURIComponent(u))).text();
  rec(9, 'qrcode', a === b, `Node ${a.length} Workers ${b.length} ${a === b ? 'ตรงทุกไบต์' : 'ต่าง ' + b.slice(0, 200)}`);
});
await step(10, 'Static Assets', async () => {
  const before = (await (await get('/hits')).json()).expressHits;
  const r = await get('/hello.txt');
  const t = await r.text();
  const after = (await (await get('/hits')).json()).expressHits;
  rec(10, 'Static Assets', r.status === 200 && t.includes('ตอน 1') && after === before + 1, { status: r.status, text: t.trim(), expressHitsBetween: after - before - 1 });
});

const pass = results.filter((r) => r.pass).length;
console.log(`\nสรุป ผ่าน ${pass} จาก ${results.length} ข้อ`);
