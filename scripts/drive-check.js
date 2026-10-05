// ตรวจการเชื่อมต่อ Google Drive จริง (ต้องทำ scripts/google-auth.js ก่อน)
//   node scripts/drive-check.js
// ส่งไฟล์ 30 MB เป็นท่อน ตรวจโฟลเดอร์ เปิดไฟล์ทั้งไฟล์และบางช่วง ส่งไฟล์เล็กแบบสำรองข้อมูล แล้วย้ายไฟล์ทดสอบไปถังขยะ
// ทุกอย่างอยู่ในโฟลเดอร์ ระบบส่งแผนการสอน/ตรวจการเชื่อมต่อ ไม่แตะฐานข้อมูลของระบบ (ใช้ฐานชั่วคราวในหน่วยความจำ)
const crypto = require('crypto');
const { Readable } = require('stream');
const vars = require('./devvars');

const FOLDER = 'ตรวจการเชื่อมต่อ';
const SIZE = 30 * 1024 * 1024;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

async function main() {
  vars.load();
  for (const k of ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN']) {
    if (!process.env[k]) throw new Error(`ยังไม่มี ${k} ใน .dev.vars ให้ทำ node scripts/google-auth.js ก่อน`);
  }
  const db = require('../src/db');
  await db.open(':memory:');
  const storage = require('../src/storage');
  const gd = storage.gdriveBackend(process.env);
  const step = (text) => console.log('  ✓ ' + text);
  const t0 = Date.now();
  console.log('');

  const folder = await gd.folderId(FOLDER);
  step(`ขอสิทธิ์ Google Drive ได้ และมีโฟลเดอร์ ${storage.ROOT_FOLDER}/${FOLDER} (id ${folder})`);

  const data = crypto.randomBytes(SIZE);
  data.write('%PDF-1.4\n', 0, 'latin1');
  const session = await gd.startUpload({ name: 'ทดสอบส่งไฟล์ 30 MB.pdf', mime: 'application/pdf', size: SIZE, folderPath: FOLDER });
  let r;
  let n = 0;
  const t1 = Date.now();
  for (let start = 0; start < SIZE; start += storage.CHUNK) {
    const end = Math.min(start + storage.CHUNK, SIZE) - 1;
    r = await gd.putChunk(session, Readable.from([data.subarray(start, end + 1)]), { start, end, total: SIZE });
    n += 1;
  }
  if (!r.done) throw new Error('ส่งครบทุกท่อนแล้วแต่ Drive ยังไม่ยืนยันว่าได้ไฟล์');
  const ref = r.ref.slice('gdrive:'.length);
  step(`ส่งไฟล์ 30 MB เป็น ${n} ท่อน ใช้เวลา ${((Date.now() - t1) / 1000).toFixed(1)} วินาที`);

  const head = await gd.head(ref);
  if (head.size !== SIZE) throw new Error(`ขนาดใน Drive ${head.size} ไม่ตรงกับที่ส่ง ${SIZE}`);
  step(`Drive เห็นไฟล์ ${head.name} ขนาดตรง`);

  const all = await gd.get(ref);
  if (sha(await readAll(all.stream)) !== sha(data)) throw new Error('เปิดไฟล์แล้วเนื้อหาไม่ตรงกับที่ส่ง');
  const part = await gd.get(ref, { range: 'bytes=0-7' });
  if (part.status !== 206 || (await readAll(part.stream)).toString('latin1') !== '%PDF-1.4') throw new Error('ขอ 8 ไบต์แรกไม่ได้');
  step('เปิดไฟล์ได้เนื้อหาตรงทุกไบต์ และขอบางช่วงได้ (ใช้ตรวจชนิดไฟล์)');

  const small = await gd.putFile(FOLDER, 'ทดสอบสำรองข้อมูล.json', 'application/json', Buffer.from('{"ทดสอบ":true}'));
  const list = await gd.list(FOLDER);
  if (!list.some((x) => x.ref === small)) throw new Error('ไม่พบไฟล์สำรองข้อมูลทดสอบในโฟลเดอร์');
  step(`ส่งไฟล์เล็กแบบสำรองข้อมูลได้ และเห็นในรายการโฟลเดอร์ (${list.length} ไฟล์)`);

  await gd.trash(ref);
  await gd.trash(small.slice('gdrive:'.length));
  step('ย้ายไฟล์ทดสอบไปถังขยะของ Drive แล้ว (กู้คืนได้ 30 วัน)');

  console.log('');
  console.log(`  ผ่านทุกข้อ ใช้เวลารวม ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`);
  console.log('');
  await db.close();
}

main().catch((e) => {
  console.error('');
  console.error('  ✗ ' + e.message);
  process.exit(1);
});
