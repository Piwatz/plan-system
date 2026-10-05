// สร้างไฟล์ติดตั้ง .zip สำหรับนำไปเปิดบนเครื่องอื่น ทั้ง Windows และ Mac
// ไม่รวมข้อมูลจริง (data) ข้อมูลทดลอง (data-demo) และ node_modules (เครื่องปลายทางดาวน์โหลดเองตอนเปิดครั้งแรก)
// ไฟล์ .command ตั้งสิทธิ์ให้รันได้ใน zip เลย Mac แตกไฟล์แล้วดับเบิลคลิกได้ทันที
// ใช้: node scripts/make-install-zip.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'ไฟล์ติดตั้ง');
const OUT = path.join(OUT_DIR, 'ระบบส่งแผนการสอน.zip');
const TOP = 'ระบบส่งแผนการสอน';
const SKIP = new Set(['node_modules', 'data', 'data-demo', '.git', 'ไฟล์ติดตั้ง', 'design-mockup']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('._') || name === '.DS_Store' || name.endsWith('.zip')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function build() {
  const files = walk(ROOT).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const file of files) {
    const rel = `${TOP}/${path.relative(ROOT, file).split(path.sep).join('/')}`;
    const name = Buffer.from(rel, 'utf8');
    const data = fs.readFileSync(file);
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    // สิทธิ์ไฟล์แบบ Unix: .command และ .sh รันได้ (755) ไฟล์อื่นอ่านเขียน (644)
    const mode = /\.(command|sh)$/.test(file) ? 0o100755 : 0o100644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // ชื่อไฟล์เป็น UTF-8 (ภาษาไทย)
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // สร้างแบบ Unix เพื่อให้ Mac อ่านสิทธิ์ไฟล์
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));
  return { count: files.length, size: fs.statSync(OUT).size };
}

const r = build();
console.log(`สร้างไฟล์ติดตั้งแล้ว ${r.count} ไฟล์ ขนาด ${(r.size / 1024).toFixed(0)} KB`);
console.log(OUT);
