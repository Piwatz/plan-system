// คัดลอกไฟล์ static ทั้งหมดไปไว้ที่ dist/assets ตามที่อยู่บนเว็บเดิม สำหรับ Workers Static Assets (npm run build)
// บน Workers ไม่มี node_modules และไม่มีดิสก์ Cloudflare ส่งไฟล์ชุดนี้ให้เบราว์เซอร์เองโดยไม่ผ่านแอป
// สร้างด้วย: dist/assets/_headers (อายุ cache เท่ากับ express.static บน Node) · dist/assets-version.js (รหัสรุ่นไฟล์ ใช้แทน Date.now())
// รันเองได้: node scripts/build-assets.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STATIC_MOUNTS } = require('../src/static');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'assets');
const VERSION_FILE = path.join(ROOT, 'dist', 'assets-version.js');
// เพดานของ Workers Static Assets แบบฟรี
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// อายุ cache แบบเดียวกับ express.static: ตัวเลข (มิลลิวินาที) หรือ '7d' '30d'
function seconds(maxAge) {
  if (typeof maxAge === 'number') return Math.floor(maxAge / 1000);
  const m = /^(\d+)d$/.exec(String(maxAge));
  if (!m) throw new Error(`อายุ cache ${maxAge} ไม่รู้จัก`);
  return Number(m[1]) * 24 * 60 * 60;
}

// ไฟล์ทั้งหมดในโฟลเดอร์ (ข้ามไฟล์ที่ขึ้นต้นด้วยจุด เหมือน express.static)
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// ไฟล์ทั้งหมดที่มีอยู่ใน dist/assets (รวมไฟล์ขึ้นต้นด้วยจุด)
function walkAll(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkAll(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function build({ quiet = false } = {}) {
  // เขียนทับไฟล์เดิมแล้วค่อยลบไฟล์ที่ไม่ใช้แล้ว (ไม่ลบทั้งโฟลเดอร์ก่อน เพราะ Windows ล็อกโฟลเดอร์ไว้ระหว่าง wrangler dev เปิดอยู่)
  const keep = new Set(['_headers']);
  const hash = crypto.createHash('sha256');
  const headers = [];
  let count = 0;
  let bytes = 0;
  let biggest = { url: '', size: 0 };
  for (const m of STATIC_MOUNTS) {
    const src = path.join(ROOT, m.dir);
    const files = walk(src).sort();
    for (const rel of files) {
      const url = `${m.url}/${rel}`;
      const from = path.join(src, rel);
      const to = path.join(OUT, ...url.split('/').filter(Boolean));
      const data = fs.readFileSync(from);
      if (data.length > MAX_FILE_BYTES) throw new Error(`${url} ใหญ่ ${data.length} ไบต์ เกินเพดานไฟล์ละ 25 MiB`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data);
      keep.add(url.slice(1));
      hash.update(url).update('\0').update(data);
      count += 1;
      bytes += data.length;
      if (data.length > biggest.size) biggest = { url, size: data.length };
    }
    headers.push(`${m.url}/*\n  Cache-Control: public, max-age=${seconds(m.maxAge)}`);
  }
  if (count + 1 > MAX_FILES) throw new Error(`ไฟล์ static ${count} ไฟล์ เกินเพดาน ${MAX_FILES} ไฟล์`);
  for (const rel of walkAll(OUT)) if (!keep.has(rel)) fs.rmSync(path.join(OUT, ...rel.split('/')));
  fs.writeFileSync(path.join(OUT, '_headers'), headers.join('\n') + '\n');
  const version = hash.digest('hex').slice(0, 10);
  fs.writeFileSync(VERSION_FILE, `// สร้างโดย scripts/build-assets.js ห้ามแก้เอง\nmodule.exports = ${JSON.stringify(version)};\n`);
  if (!quiet) {
    console.log(`คัดลอกไฟล์ static ${count.toLocaleString()} ไฟล์ ${(bytes / 1024 / 1024).toFixed(1)} MB ไว้ที่ dist/assets (เพดาน ${MAX_FILES.toLocaleString()} ไฟล์)`);
    console.log(`ไฟล์ใหญ่สุด ${biggest.url} ${(biggest.size / 1024 / 1024).toFixed(2)} MB (เพดานไฟล์ละ 25 MiB)`);
    console.log(`รหัสรุ่นไฟล์ ${version}`);
  }
  return { count, bytes, version, biggest };
}

if (require.main === module) build();

module.exports = { build };
