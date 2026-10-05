// ทดสอบตอน 10: ส่งไฟล์เป็นท่อน รวม PDF แบบเบราว์เซอร์ เปิดไฟล์ ถังขยะ เพดานขนาด สำรองข้อมูล งานตามเวลา
// และตัวต่อ Google Drive กับ Drive จำลองในเครื่อง (ไม่ต่ออินเทอร์เน็ต) · ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-files-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const storage = require('../src/storage');
const { uploadOne, sendForm, XHR } = require('./upload-client');

const FILES = path.join(tmp, 'data-demo', 'files');
let base;
let server;

test.before(async () => {
  await seed.main({ target: ':memory:', keepOpen: true });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

class Client {
  constructor() {
    this.cookies = {};
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async raw(method, url, body, headers = {}) {
    return fetch(base + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), ...headers } });
  }
  async req(method, url, body, headers = {}) {
    const res = await this.raw(method, url, body, headers);
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields) {
    return this.req('POST', url, new URLSearchParams(fields));
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const localPath = (stored) => path.join(FILES, stored.replace(/^local:/, ''));
const trashCount = () => (fs.existsSync(path.join(FILES, '.trash')) ? fs.readdirSync(path.join(FILES, '.trash')).length : 0);

// PDF ใหญ่ราว size ไบต์ (เนื้อหาสุ่มต่อท้าย) ขึ้นต้นด้วย %PDF- ผ่านการตรวจชนิดไฟล์
function bigPdf(size) {
  const buf = crypto.randomBytes(size);
  buf.write('%PDF-1.4\n', 0, 'latin1');
  return buf;
}

async function realPdf(n, width) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([width, 400]);
  return doc.save();
}

const manual = (code) => ({ doc_type: 'manual', subject_code: code, subject_name: 'ทดสอบส่งไฟล์', grade_level: 'ม.4', action: 'draft' });

test('ส่งไฟล์ 12 MB เป็นท่อน แล้วเปิดและดาวน์โหลดได้ไบต์ตรงกัน ขอบางช่วงได้', async () => {
  const t = await as('sci2');
  const data = bigPdf(12 * 1024 * 1024 + 123);
  const r = await sendForm(t, '/works', manual('ว30121'), [[new Blob([data]), 'คู่มือใหญ่.pdf']]);
  assert.equal(r.status, 200, r.text);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  const f = await db.q.get('SELECT * FROM files WHERE submission_id = ?', id);
  assert.equal(f.original_name, 'คู่มือใหญ่.pdf');
  assert.equal(f.size, data.length);
  assert.equal(f.mime, 'application/pdf');
  assert.match(f.stored_name, /^local:/);
  // โฟลเดอร์ตาม ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน ชื่อไฟล์เป็นรหัสและชื่อวิชา
  assert.match(f.stored_name, /^local:ภาคเรียน 2-2569\/[^/]+\/[^/]+\/คู่มือรายวิชา\/\w{8} ว30121 ทดสอบส่งไฟล์\.pdf$/);
  assert.equal(sha(fs.readFileSync(localPath(f.stored_name))), sha(data));

  const dl = await t.raw('GET', `/f/${f.id}?dl=1`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-length'), String(data.length));
  assert.equal(dl.headers.get('etag'), null, 'ไม่คำนวณ ETag ของไฟล์');
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(data));

  const part = await t.raw('GET', `/f/${f.id}/raw`, undefined, { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${data.length}`);
  assert.equal(part.headers.get('content-type'), 'application/x-lesson-file');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), data.subarray(100, 200));

  const done = await db.q.get("SELECT status FROM pending_uploads WHERE drive_file_id = ?", f.stored_name);
  assert.equal(done.status, 'used');
});

test('ท่อนต้องต่อกันพอดีและขนาดตามกติกา ส่งท่อนผิดไม่เสียไฟล์', async () => {
  const t = await as('sci2');
  const start = await t.req('POST', '/upload/start', new URLSearchParams({ form: '/works', field: 'main_files', doc_type: 'manual', subject_code: 'ว30122', name: 'ก.pdf', size: String(6 * 1024 * 1024) }), XHR);
  assert.equal(start.status, 200, start.text);
  const { token, chunk } = JSON.parse(start.text);
  assert.equal(chunk, 5 * 1024 * 1024);
  const put = (from, to, total, buf) => t.req('PUT', '/upload/' + token, buf, { ...XHR, 'content-range': `bytes ${from}-${to}/${total}` });
  // ท่อนกลางทางไม่ใช่ทวีคูณของ 256 KB
  assert.equal((await put(0, 999, 6 * 1024 * 1024, Buffer.alloc(1000))).status, 400);
  // ข้ามท่อนแรก
  assert.equal((await put(5 * 1024 * 1024, 6 * 1024 * 1024 - 1, 6 * 1024 * 1024, Buffer.alloc(1024 * 1024))).status, 400);
  // ขนาดรวมไม่ตรงกับที่แจ้งตอนเริ่ม
  assert.equal((await put(0, 262143, 7 * 1024 * 1024, Buffer.alloc(262144))).status, 400);
  // ส่งถูกต้องได้ต่อ
  const ok = await put(0, 262143, 6 * 1024 * 1024, Buffer.alloc(262144));
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(JSON.parse(ok.text), { ok: true, done: false, received: 262144 });
  // ส่งท่อนเดิมซ้ำไม่ได้
  assert.equal((await put(0, 262143, 6 * 1024 * 1024, Buffer.alloc(262144))).status, 400);
});

test('รวม 3 ไฟล์ด้วยตัวรวมของเบราว์เซอร์ได้ PDF เดียวเรียงถูก ไฟล์เสียใช้ข้อความเดิม', async () => {
  const { mergePdfs } = require('../public/js/pdfmerge');
  const lib = require('pdf-lib');
  const out = await mergePdfs(lib, [
    { name: 'ปก.pdf', bytes: await realPdf(1, 200) },
    { name: 'เนื้อหา.pdf', bytes: await realPdf(2, 300) },
    { name: 'ภาคผนวก.pdf', bytes: await realPdf(1, 250) },
  ]);
  assert.equal(out.pages, 4);
  const doc = await PDFDocument.load(out.bytes);
  assert.deepEqual(
    doc.getPages().map((p) => p.getWidth()),
    [200, 300, 300, 250]
  );
  await assert.rejects(mergePdfs(lib, [{ name: 'เสีย.pdf', bytes: new TextEncoder().encode('%PDF-1.4 broken') }]), {
    userMessage: 'ไฟล์ เสีย.pdf เปิดไม่ได้ จึงรวมไม่ได้ ลองบันทึกเป็น PDF ใหม่แล้วแนบอีกครั้ง',
  });
  // หน้าเว็บโหลดตัวรวมจากระบบเองได้
  const t = await as('sci2');
  assert.equal((await t.raw('GET', '/vendor/pdf-lib/pdf-lib.min.js')).status, 200);
  assert.equal((await t.raw('GET', '/static/js/pdfmerge.js')).status, 200);

  // ส่งไฟล์ที่รวมแล้ว: ชื่อไฟล์แบบเดิม และข้อความบอกจำนวนไฟล์และหน้า
  const r = await sendForm(
    t,
    '/works',
    manual('ว30123'),
    [
      [new Blob([await realPdf(1, 200)]), 'ปก.pdf'],
      [new Blob([await realPdf(2, 300)]), 'เนื้อหา.pdf'],
      [new Blob([await realPdf(1, 250)]), 'ภาคผนวก.pdf'],
    ],
    { merge: true, headers: {} }
  );
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop());
  const f = await db.q.get('SELECT * FROM files WHERE submission_id = ?', id);
  assert.equal(f.original_name, 'คู่มือรายวิชา ว30123.pdf');
  const merged = await PDFDocument.load(fs.readFileSync(localPath(f.stored_name)));
  assert.deepEqual(
    merged.getPages().map((p) => p.getWidth()),
    [200, 300, 300, 250]
  );
  const page = await t.get(`/s/${id}`);
  assert.match(page.text, /รวม 3 ไฟล์เป็นไฟล์เดียวแล้ว 4 หน้า/);
});

test('ไฟล์ปลอมนามสกุลและไฟล์ชนิดที่ไม่รับถูกปฏิเสธ ไฟล์ที่ส่งมาย้ายไปถังขยะ', async () => {
  const t = await as('sci2');
  const before = trashCount();
  const fake = await sendForm(t, '/works', manual('ว30124'), [[new Blob(['MZ นี่คือโปรแกรม ไม่ใช่ PDF']), 'คู่มือ.pdf']]);
  assert.equal(fake.status, 400);
  assert.match(JSON.parse(fake.text).error, /คู่มือ\.pdf เปิดไม่ได้ หรือนามสกุลไม่ตรงกับไฟล์จริง/);
  assert.equal(trashCount(), before + 1);
  assert.equal(await db.q.get("SELECT 1 AS x FROM submissions WHERE subject_code = 'ว30124'"), undefined);

  const exe = await uploadOne(t, new Blob(['MZ']), 'โปรแกรม.exe', { form: '/works', field: 'main_files', doc_type: 'manual', subject_code: 'ว30124' });
  assert.equal(exe.status, 400);
  assert.equal(exe.error, 'รับเฉพาะไฟล์ PDF Word Excel PowerPoint และรูปภาพ');
});

test('token ของคนอื่นใช้ไม่ได้ และไม่ทำให้ไฟล์ของเจ้าของหาย', async () => {
  const owner = await as('sci2');
  const other = await as('teacher');
  const info = { form: '/works', field: 'main_files', doc_type: 'manual', subject_code: 'ว30125' };
  // ส่งท่อนเข้า token ของคนอื่นไม่ได้
  const start = JSON.parse((await owner.req('POST', '/upload/start', new URLSearchParams({ ...info, name: 'ก.pdf', size: '9' }), XHR)).text);
  const steal = await other.req('PUT', '/upload/' + start.token, Buffer.from('%PDF-1.4\n'), { ...XHR, 'content-range': 'bytes 0-8/9' });
  assert.equal(steal.status, 400);
  assert.equal(JSON.parse(steal.text).error, 'ไฟล์ที่แนบหมดเวลาแล้ว กรุณาแนบไฟล์ใหม่อีกครั้ง');

  const token = await uploadOne(owner, new Blob([bigPdf(2000)]), 'ของเจ้าของ.pdf', info);
  assert.equal(typeof token, 'string');
  const fields = new URLSearchParams({ ...manual('ว30126'), upload_main_files: token });
  const r = await other.req('POST', '/works', fields, XHR);
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error, 'ไฟล์ที่แนบหมดเวลาแล้ว กรุณาแนบไฟล์ใหม่อีกครั้ง');
  assert.equal(await db.q.get("SELECT 1 AS x FROM submissions WHERE subject_code = 'ว30126'"), undefined);
  // เจ้าของยังใช้ได้
  const mine = await owner.req('POST', '/works', new URLSearchParams({ ...manual('ว30125'), upload_main_files: token }), XHR);
  assert.equal(mine.status, 200, mine.text);
  // ใช้ token เดิมซ้ำกับงานอื่นไม่ได้
  const again = await owner.req('POST', '/works', new URLSearchParams({ ...manual('ว30127'), upload_main_files: token }), XHR);
  assert.equal(again.status, 400);
});

test('ไฟล์เกินเพดานถูกปฏิเสธตั้งแต่ก่อนส่ง พร้อมข้อความไทย', async () => {
  const t = await as('sci2');
  await db.q.run("UPDATE settings SET value = '1' WHERE key = 'max_upload_mb'");
  try {
    const r = await uploadOne(t, new Blob([bigPdf(1024 * 1024 + 1)]), 'ใหญ่.pdf', { form: '/works', field: 'main_files', doc_type: 'manual', subject_code: 'ว30128' });
    assert.equal(r.status, 400);
    assert.equal(r.error, 'ไฟล์ใหญ่เกิน 1 MB');
    const ok = await uploadOne(t, new Blob([bigPdf(1024 * 1024)]), 'พอดี.pdf', { form: '/works', field: 'main_files', doc_type: 'manual', subject_code: 'ว30128' });
    assert.equal(typeof ok, 'string');
  } finally {
    await db.q.run("UPDATE settings SET value = '100' WHERE key = 'max_upload_mb'");
  }
});

test('ลบงานแล้วไฟล์อยู่ในถังขยะ ไม่ลบถาวร แก้ไขแนบไฟล์ใหม่ไฟล์เดิมเก็บเป็นประวัติ', async () => {
  const t = await as('sci2');
  const r = await sendForm(t, '/works', manual('ว30129'), [[new Blob([bigPdf(3000)]), 'ฉบับแรก.pdf']]);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  const first = await db.q.get('SELECT * FROM files WHERE submission_id = ?', id);
  // แนบฉบับใหม่ ฉบับแรกยังอยู่ (ประวัติ)
  const e = await sendForm(t, `/s/${id}`, { ...manual('ว30129'), subject_name: 'แก้ชื่อวิชา' }, [[new Blob([bigPdf(4000)]), 'ฉบับแก้.pdf']]);
  assert.equal(e.status, 200, e.text);
  const files = await db.q.all('SELECT * FROM files WHERE submission_id = ? ORDER BY id', id);
  assert.deepEqual(
    files.map((f) => [f.original_name, f.is_current]),
    [
      ['ฉบับแรก.pdf', 0],
      ['ฉบับแก้.pdf', 1],
    ]
  );
  assert.ok(fs.existsSync(localPath(first.stored_name)));
  assert.match(files[1].stored_name, /ว30129 แก้ชื่อวิชา\.pdf$/, 'ไฟล์ใหม่ใช้ชื่อวิชาที่แก้ในฟอร์ม');

  const before = trashCount();
  assert.equal((await t.post(`/s/${id}/delete`, {})).status, 302);
  assert.equal(await db.q.get('SELECT 1 AS x FROM submissions WHERE id = ?', id), undefined);
  for (const f of files) assert.equal(fs.existsSync(localPath(f.stored_name)), false);
  assert.equal(trashCount(), before + 2, 'ไฟล์ทั้ง 2 ฉบับอยู่ในถังขยะ');
});

test('บันทึกหลังแผนแนบไฟล์ประกอบหลายไฟล์ เก็บในโฟลเดอร์บันทึกหลังแผน ชื่อไฟล์เดิม', async () => {
  const t = await as('teacher');
  const plan = await db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = 'ว30203'");
  const r = await sendForm(
    t,
    '/notes',
    { plan_id: String(plan.id), plan_no: '31', result_k: 'เข้าใจ', action: 'draft' },
    [
      [new Blob([bigPdf(500)]), 'ใบงาน.pdf'],
      [new Blob([Buffer.from('\x89PNG\r\n\x1a\nxxxx', 'latin1')]), 'ภาพกิจกรรม.png'],
    ],
    { field: 'attach_files' }
  );
  assert.equal(r.status, 200, r.text);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  const files = await db.q.all('SELECT * FROM files WHERE submission_id = ? ORDER BY id', id);
  assert.deepEqual(
    files.map((f) => [f.original_name, f.kind, f.mime]),
    [
      ['ใบงาน.pdf', 'attach', 'application/pdf'],
      ['ภาพกิจกรรม.png', 'attach', 'image/png'],
    ]
  );
  assert.match(files[0].stored_name, /\/บันทึกหลังแผน\/\w{8} ใบงาน\.pdf$/);
});

test('สำรองข้อมูล: ได้ JSON ครบ 13 ตาราง parse ได้ ชื่อไฟล์ภาษาไทย เฉพาะผู้ดูแลระบบ', async () => {
  const t = await as('teacher');
  assert.equal((await t.raw('GET', '/admin/backup')).status, 403);
  const admin = await as('admin');
  const r = await admin.raw('GET', '/admin/backup');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /สำรองข้อมูลระบบส่งแผน_\d{4}-\d{2}-\d{2}\.json$/);
  const j = JSON.parse(await r.text());
  assert.equal(j.format, 'plan-system-backup');
  assert.equal(j.schema_version, 1);
  assert.deepEqual(Object.keys(j.tables), require('../src/backup').TABLES);
  assert.equal(Object.keys(j.tables).length, 13);
  assert.equal(j.tables.users.length, (await db.q.get('SELECT COUNT(*) AS n FROM users')).n);
  assert.equal(j.tables.submissions.length, (await db.q.get('SELECT COUNT(*) AS n FROM submissions')).n);
  assert.equal(j.tables.audit_log.length, (await db.q.get('SELECT COUNT(*) AS n FROM audit_log')).n);
  assert.ok(j.tables.settings.some((s) => s.key === 'school_name'));
  assert.ok(j.tables.files.every((f) => typeof f.stored_name === 'string'));
  // หน้าผู้ดูแลระบบบอกว่าสำรองที่ไหน
  const page = (await admin.get('/admin')).text;
  assert.match(page, /ระบบสำรองให้เองทุกคืนตอนตีสอง/);
  assert.doesNotMatch(page, /แฟลชไดรฟ์/);
});

test('งานตามเวลา: ทิ้งไฟล์ที่ส่งค้างเกิน 1 วัน และสำรองข้อมูลเก็บ 30 ฉบับล่าสุด', async () => {
  const jobs = require('../src/jobs');
  const uid = (await db.q.get("SELECT id FROM users WHERE username = 'sci2'")).id;
  // ไฟล์ส่งครบแต่ไม่ได้ใช้ 2 วันก่อน · ไฟล์ส่งไม่ครบ · ไฟล์ใหม่ที่ยังไม่ถึงเวลา
  const store = storage.current();
  const s1 = await store.startUpload({ name: 'ค้าง.pdf', folderPath: 'ทดสอบ' });
  const done = await store.putChunk(s1, Readable.from([Buffer.from('%PDF-1.4')]), { start: 0, end: 7, total: 8 });
  const s2 = await store.startUpload({ name: 'ไม่ครบ.pdf', folderPath: 'ทดสอบ' });
  const ins = 'INSERT INTO pending_uploads (token, user_id, session_uri, name, size, status, drive_file_id, created_at) VALUES (?, ?, ?, ?, 8, ?, ?, ?)';
  await db.q.run(ins, 'old-done', uid, s1, 'ค้าง.pdf', 'done', done.ref, '2000-01-01 00:00:00');
  await db.q.run(ins, 'old-up', uid, s2, 'ไม่ครบ.pdf', 'uploading', null, '2000-01-01 00:00:00');
  await db.q.run(ins, 'new-done', uid, s2, 'ใหม่.pdf', 'done', 'local:x.pdf', db.nowStr());
  const before = trashCount();
  assert.equal(await jobs.hourly(), 2);
  assert.equal(trashCount(), before + 1, 'ไฟล์ที่ส่งครบแต่ไม่ได้ใช้ ย้ายไปถังขยะ');
  assert.equal(fs.existsSync(localPath(done.ref)), false);
  assert.equal(fs.existsSync(path.join(FILES, JSON.parse(s2).part)), false, 'ไฟล์ส่งไม่ครบลบไฟล์ชั่วคราว');
  assert.deepEqual((await db.q.all("SELECT token FROM pending_uploads WHERE token IN ('old-done', 'old-up', 'new-done')")).map((r) => r.token), ['new-done']);

  // สำรองเก่า 31 ฉบับ + คืนนี้ 1 ฉบับ เหลือ 30 ฉบับล่าสุด
  const dir = path.join(FILES, 'สำรองข้อมูล');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 31; i++) {
    const p = path.join(dir, `สำรองข้อมูลระบบส่งแผน_2569-01-${String(i).padStart(2, '0')}.json`);
    fs.writeFileSync(p, '{}');
    const when = new Date(2026, 0, i);
    fs.utimesSync(p, when, when);
  }
  const name = await jobs.nightly();
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 30);
  assert.ok(left.includes(name), 'ฉบับคืนนี้อยู่');
  assert.ok(!left.includes('สำรองข้อมูลระบบส่งแผน_2569-01-01.json') && !left.includes('สำรองข้อมูลระบบส่งแผน_2569-01-02.json'), 'ฉบับเก่าสุด 2 ฉบับย้ายไปถังขยะ');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).tables).length, 13);
});

// ---------- Google Drive จำลอง ----------
// ทำตามเอกสาร Drive API v3: token · ค้นและสร้างโฟลเดอร์ · resumable upload (308 + Range) · multipart · alt=media + Range · trashed
function fakeDrive() {
  const files = new Map();
  const sessions = new Map();
  const chunks = [];
  let n = 0;
  const FOLDER = 'application/vnd.google-apps.folder';
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = Buffer.concat(parts);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.pathname.startsWith('/session/')) {
      const s = sessions.get(u.pathname.slice(9));
      if (!s) return json(404, {});
      if (req.method === 'DELETE') {
        sessions.delete(u.pathname.slice(9));
        res.writeHead(499);
        return res.end();
      }
      chunks.push({ range: req.headers['content-range'], length: Number(req.headers['content-length']), got: body.length, chunked: Boolean(req.headers['transfer-encoding']) });
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || '');
      if (m && Number(m[1]) !== s.data.length) return json(400, {});
      s.data = Buffer.concat([s.data, body]);
      if (s.data.length < s.size) {
        res.writeHead(308, { range: `bytes=0-${s.data.length - 1}` });
        return res.end();
      }
      const id = 'f' + ++n;
      files.set(id, { name: s.meta.name, parents: s.meta.parents, mime: s.meta.mimeType, data: s.data, created: n });
      return json(200, { id });
    }
    if (req.headers.authorization !== 'Bearer tok') return json(401, {});
    if (u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'resumable') {
      const sid = 's' + ++n;
      sessions.set(sid, { meta: JSON.parse(body), size: Number(req.headers['x-upload-content-length']), data: Buffer.alloc(0) });
      res.writeHead(200, { location: `http://127.0.0.1:${srv.address().port}/session/${sid}` });
      return res.end();
    }
    if (u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'multipart') {
      const boundary = /boundary=(\S+)/.exec(req.headers['content-type'])[1];
      const text = body.toString('latin1');
      const segs = text.split('--' + boundary);
      const meta = JSON.parse(Buffer.from(segs[1].split('\r\n\r\n')[1].trim(), 'latin1').toString('utf8'));
      const data = Buffer.from(segs[2].slice(segs[2].indexOf('\r\n\r\n') + 4, -2), 'latin1');
      const id = 'f' + ++n;
      files.set(id, { name: meta.name, parents: meta.parents, mime: meta.mimeType, data, created: n });
      return json(200, { id });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const qs = u.searchParams.get('q');
      const parent = /'([^']+)' in parents/.exec(qs)[1];
      const nm = /name = '((?:[^'\\]|\\.)*)'/.exec(qs);
      let list = [...files].filter(([, f]) => !f.trashed && (f.parents || ['root'])[0] === parent);
      if (nm) list = list.filter(([, f]) => f.name === nm[1].replace(/\\(.)/g, '$1'));
      if (qs.includes(`mimeType = '${FOLDER}'`)) list = list.filter(([, f]) => f.mime === FOLDER);
      if (qs.includes(`mimeType != '${FOLDER}'`)) list = list.filter(([, f]) => f.mime !== FOLDER);
      list.sort((a, b) => b[1].created - a[1].created);
      return json(200, { files: list.map(([id, f]) => ({ id, name: f.name, createdTime: new Date(2026, 0, 1, 0, 0, f.created).toISOString() })) });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body);
      const id = 'f' + ++n;
      files.set(id, { name: meta.name, parents: meta.parents, mime: meta.mimeType, created: n });
      return json(200, { id });
    }
    const fm = /^\/drive\/v3\/files\/([\w-]+)$/.exec(u.pathname);
    const f = fm && files.get(fm[1]);
    if (!f) return json(404, {});
    if (req.method === 'PATCH') {
      f.trashed = JSON.parse(body).trashed === true;
      return json(200, { id: fm[1] });
    }
    if (u.searchParams.get('alt') === 'media') {
      const r = storage.parseRange(req.headers.range, f.data.length);
      if (r) {
        res.writeHead(206, { 'content-length': r.end - r.start + 1, 'content-range': `bytes ${r.start}-${r.end}/${f.data.length}` });
        return res.end(f.data.subarray(r.start, r.end + 1));
      }
      res.writeHead(200, { 'content-length': f.data.length });
      return res.end(f.data);
    }
    return json(200, { name: f.name, size: String(f.data ? f.data.length : 0), mimeType: f.mime });
  });
  return { srv, files, sessions, chunks };
}

test('ตัวต่อ Google Drive (Drive จำลอง): สร้างโฟลเดอร์ครั้งเดียว ส่งท่อนแบบสตรีม เปิดไฟล์ ถังขยะ สำรองข้อมูล', async () => {
  const fake = fakeDrive();
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${fake.srv.address().port}`;
  const env = { GDRIVE_CLIENT_ID: 'id', GDRIVE_CLIENT_SECRET: 'secret', GDRIVE_REFRESH_TOKEN: 'refresh' };
  const gd = storage.gdriveBackend(env, { oauth: at, base: at });
  // ทั้งระบบใช้ Drive จำลองแทนที่เก็บในเครื่อง
  storage._set('local', gd);
  storage._set('gdrive', gd);
  try {
    const t = await as('sci2');
    const data = bigPdf(11 * 1024 * 1024);
    const r = await sendForm(t, '/works', manual('ว30131'), [[new Blob([data]), 'คู่มือ.pdf']]);
    assert.equal(r.status, 200, r.text);
    const id = Number(JSON.parse(r.text).redirect.split('/').pop());
    const f = await db.q.get('SELECT * FROM files WHERE submission_id = ?', id);
    assert.match(f.stored_name, /^gdrive:f\d+$/);
    // ท่อน 5 MB 5 MB 1 MB ส่งต่อพร้อมความยาวท่อน (ไม่ใช่ chunked) ได้ครบทุกไบต์
    assert.deepEqual(
      fake.chunks.map((c) => [c.range, c.length === c.got, c.chunked]),
      [
        [`bytes 0-5242879/${data.length}`, true, false],
        [`bytes 5242880-10485759/${data.length}`, true, false],
        [`bytes 10485760-${data.length - 1}/${data.length}`, true, false],
      ]
    );
    // โฟลเดอร์ ระบบส่งแผนการสอน / ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน
    const stored = fake.files.get(f.stored_name.slice(7));
    const chain = [];
    let p = stored.parents[0];
    while (p && p !== 'root') {
      const folder = fake.files.get(p);
      chain.unshift(folder.name);
      p = folder.parents ? folder.parents[0] : null;
    }
    assert.equal(chain.length, 5);
    assert.deepEqual([chain[0], chain[1], chain[4]], ['ระบบส่งแผนการสอน', 'ภาคเรียน 2-2569', 'คู่มือรายวิชา']);
    assert.equal(stored.name, 'ว30131 ทดสอบส่งไฟล์.pdf');
    const folders = [...fake.files.values()].filter((x) => x.mime === 'application/vnd.google-apps.folder').length;

    // ส่งอีกงานในโฟลเดอร์เดียวกัน ไม่สร้างโฟลเดอร์ซ้ำ
    const r2 = await sendForm(t, '/works', manual('ว30132'), [[new Blob([bigPdf(1000)]), 'คู่มือ2.pdf']]);
    assert.equal(r2.status, 200, r2.text);
    assert.equal([...fake.files.values()].filter((x) => x.mime === 'application/vnd.google-apps.folder').length, folders);
    // ลืมโฟลเดอร์ที่จำไว้ในฐาน (เช่น กู้ฐานข้อมูล) ระบบค้นใน Drive เจอโฟลเดอร์เดิม ไม่สร้างใหม่
    await db.q.run('DELETE FROM drive_folders');
    const r3 = await sendForm(t, '/works', manual('ว30133'), [[new Blob([bigPdf(1000)]), 'คู่มือ3.pdf']]);
    assert.equal(r3.status, 200, r3.text);
    assert.equal([...fake.files.values()].filter((x) => x.mime === 'application/vnd.google-apps.folder').length, folders);

    // เปิดไฟล์ทั้งไฟล์และบางช่วง
    const dl = await t.raw('GET', `/f/${f.id}`);
    assert.equal(dl.status, 200);
    assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(data));
    const part = await t.raw('GET', `/f/${f.id}/raw`, undefined, { range: 'bytes=0-4' });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '%PDF-');

    // ไฟล์ปลอมตรวจจาก 8 ไบต์แรกใน Drive แล้วย้ายไปถังขยะ
    const bad = await sendForm(t, '/works', manual('ว30134'), [[new Blob(['ไม่ใช่ PDF จริง']), 'ปลอม.pdf']]);
    assert.equal(bad.status, 400);
    assert.ok([...fake.files.values()].some((x) => x.name.endsWith('ว30134 ทดสอบส่งไฟล์.pdf') && x.trashed));

    // ลบงาน ไฟล์ใน Drive อยู่ในถังขยะ
    await t.post(`/s/${id}/delete`, {});
    assert.equal(stored.trashed, true);
    assert.ok(stored.data, 'ยังกู้คืนได้ (ไม่ลบถาวร)');

    // สำรองข้อมูลเข้าโฟลเดอร์ สำรองข้อมูล ใน Drive
    const jobs = require('../src/jobs');
    const name = await jobs.nightly();
    const backup = [...fake.files.values()].find((x) => x.name === name);
    assert.ok(backup);
    assert.equal(fake.files.get(backup.parents[0]).name, 'สำรองข้อมูล');
    assert.equal(Object.keys(JSON.parse(backup.data.toString('utf8')).tables).length, 13);
  } finally {
    storage._set('local', null);
    storage._set('gdrive', null);
    fake.srv.close();
  }
});
