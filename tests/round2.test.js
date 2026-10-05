// ทดสอบรอบ 2: แปลงไฟล์ Word เป็น PDF ในระบบ และคัดลอกแผนกับคู่มือไปโฟลเดอร์ Google Drive
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง ไม่ต้องติดตั้ง LibreOffice จริง (สลับตัวสั่งงานเป็นตัวจำลอง)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-r2-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const convert = require('../src/convert');
const drive = require('../src/drive');

let base;
let server;

test.before(async () => {
  seed.main();
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
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
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type') || '', buf, text: buf.toString('utf8') };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields) {
    const body = fields instanceof FormData ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body);
  }
  async flash(url) {
    return (await this.get(url)).text;
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

async function realPdf(n, width) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([width, 400]);
  return Buffer.from(await doc.save());
}

function sendWork(c, url, fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [buf, name] of files) fd.append('main_files', new Blob([buf]), name);
  return c.req('POST', url, fd, { 'x-requested-with': 'XMLHttpRequest' });
}

function convertWord(c, buf, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  return c.req('POST', '/convert/word', fd, { 'x-requested-with': 'XMLHttpRequest' });
}

const setSetting = (k, v) => db.setSetting(k, v);
const wordFile = Buffer.from('PK\u0003\u0004 จำลองไฟล์ Word');

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return check();
}

test('แปลงไฟล์ Word เป็น PDF: หน้าส่งงานรับ Word เมื่อมี LibreOffice และได้ PDF กลับมาให้ดูก่อนส่ง', async () => {
  // จำลองว่าติดตั้ง LibreOffice แล้ว: สร้างไฟล์ชื่อเดียวกับโปรแกรม และสลับตัวสั่งงานเป็นตัวสร้าง PDF
  const fakeExe = path.join(tmp, 'LibreOffice', 'program', 'soffice.exe');
  fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
  fs.writeFileSync(fakeExe, 'fake');
  setSetting('soffice_path', fakeExe);
  const calls = [];
  const original = convert.runSoffice;
  convert.runSoffice = async (exe, args) => {
    calls.push({ exe, args });
    const outdir = args[args.indexOf('--outdir') + 1];
    fs.writeFileSync(path.join(outdir, 'document.pdf'), await realPdf(3, 320));
  };
  try {
    const t = await as('teacher');
    const form = (await t.get('/works/new?type=manual')).text;
    assert.match(form, /data-convert="\/convert\/word"/);
    assert.match(form, /accept="\.pdf,application\/pdf,\.doc,\.docx/);
    assert.match(form, /ลากไฟล์ PDF หรือ Word มาวางที่นี่/);

    const filesBefore = db.q.get('SELECT COUNT(*) AS n FROM files').n;
    const r = await convertWord(t, wordFile, 'คู่มือ ว31101.docx');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.type, 'application/x-lesson-file', 'ไม่บอกว่าเป็น PDF กันโปรแกรมช่วยดาวน์โหลดดักไป');
    assert.equal((await PDFDocument.load(r.buf)).getPageCount(), 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, fakeExe);
    assert.ok(calls[0].args.includes('--headless') && calls[0].args.includes('pdf'));
    assert.ok(calls[0].args.some((a) => a.startsWith('-env:UserInstallation=file:')), 'ใช้โปรไฟล์แยก ไม่ชนกับ LibreOffice ที่ผู้ใช้เปิดเอง');
    const tmpWork = path.dirname(calls[0].args[calls[0].args.length - 1]);
    assert.equal(fs.existsSync(tmpWork), false, 'ลบโฟลเดอร์ชั่วคราวแล้ว');
    assert.equal(db.q.get('SELECT COUNT(*) AS n FROM files').n, filesBefore, 'แปลงอย่างเดียว ไม่เก็บไฟล์ในระบบ');

    // ไฟล์ที่ไม่ใช่ Word แปลงไม่ได้ และไฟล์ปลอมนามสกุล Word ถูกตรวจเจอ
    let bad = await convertWord(t, await realPdf(1, 200), 'ไฟล์.pdf');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /เฉพาะไฟล์ Word/);
    bad = await convertWord(t, Buffer.from('ไม่ใช่ไฟล์ Word'), 'ปลอม.docx');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /เปิดไม่ได้/);

    // LibreOffice แปลงไม่สำเร็จ (ไม่มีไฟล์ PDF ออกมา) ครูได้ข้อความบอกวิธีแก้
    convert.runSoffice = async () => {};
    bad = await convertWord(t, wordFile, 'เสีย.docx');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /บันทึกเป็น PDF เอง/);

    // ปิดสวิตช์แล้วกลับเป็นแบบเดิม: รับเฉพาะ PDF และแปลงไม่ได้
    const admin = await as('admin');
    await admin.post('/admin/features/wordconvert', { on: '0' });
    const off = (await t.get('/works/new?type=manual')).text;
    assert.doesNotMatch(off, /data-convert=/);
    assert.match(off, /accept="\.pdf,application\/pdf"/);
    bad = await convertWord(t, wordFile, 'คู่มือ.docx');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /ปิดการแปลงไฟล์ Word/);
    await admin.post('/admin/features/wordconvert', { on: '1' });

    // ผู้ดูแลระบบใส่ที่อยู่โปรแกรมผิด ระบบไม่รับ
    await admin.post('/admin/convert', { soffice_path: path.join(tmp, 'ไม่มีโปรแกรมนี้') });
    assert.equal(db.getSettings().soffice_path, fakeExe);
    assert.match(await admin.flash('/admin/features'), /ไม่พบโปรแกรม LibreOffice ที่ที่อยู่นี้/);
    // ตั้งให้ไปเปิดโปรแกรมอื่นที่ไม่ใช่ LibreOffice ไม่ได้ แม้ไฟล์มีอยู่จริง
    await admin.post('/admin/convert', { soffice_path: process.execPath });
    assert.equal(db.getSettings().soffice_path, fakeExe);
    assert.equal(convert.findSoffice({ soffice_path: process.execPath }), convert.findSoffice({}));
    // ใส่เป็นโฟลเดอร์ที่ติดตั้งก็หาโปรแกรมเจอ
    await admin.post('/admin/convert', { soffice_path: path.join(tmp, 'LibreOffice') });
    assert.equal(convert.findSoffice(db.getSettings()), fakeExe);
  } finally {
    convert.runSoffice = original;
  }
});

test('ไม่มี LibreOffice: หน้าส่งงานรับเฉพาะ PDF และเปิดสวิตช์แปลง Word ไม่ได้', async (t) => {
  setSetting('soffice_path', '');
  if (convert.findSoffice({})) return t.skip('เครื่องนี้ติดตั้ง LibreOffice ไว้จริง');
  const teacher = await as('teacher');
  const form = (await teacher.get('/works/new?type=manual')).text;
  assert.doesNotMatch(form, /data-convert=/);
  const r = await convertWord(teacher, wordFile, 'คู่มือ.docx');
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /ยังไม่ได้ติดตั้ง LibreOffice/);
  const admin = await as('admin');
  const page = (await admin.get('/admin/features')).text;
  assert.match(page, /ยังไม่พบ LibreOffice ในเครื่องนี้/);
  assert.match(page, /เปิดอยู่ แต่ยังไม่พบ LibreOffice/);
  await admin.post('/admin/features/wordconvert', { on: '0' });
  await admin.post('/admin/features/wordconvert', { on: '1' });
  assert.equal(db.getSettings().ff_wordconvert, '0', 'เปิดไม่ได้จนกว่าจะติดตั้ง');
  db.setSetting('ff_wordconvert', '1');
});

test('คัดลอกไป Google Drive: ตั้งโฟลเดอร์ ส่งงานแล้วมีสำเนาแยกโฟลเดอร์ เปลี่ยนไฟล์แล้วสำเนาเปลี่ยนตาม', async () => {
  const admin = await as('admin');
  const myDrive = path.join(tmp, 'G', 'My Drive');
  fs.mkdirSync(myDrive, { recursive: true });
  const root = path.join(myDrive, 'ระบบส่งแผน');

  // ยังไม่ตั้งโฟลเดอร์ เปิดสวิตช์ไม่ได้
  await admin.post('/admin/features/drivecopy', { on: '1' });
  assert.equal(db.getSettings().ff_drivecopy, '0');
  // ที่อยู่ไม่เต็ม หรือไม่มีอยู่ในเครื่อง ไม่รับ
  await admin.post('/admin/drive', { drive_dir: 'My Drive', drive_when: 'submit' });
  assert.equal(db.getSettings().drive_dir, '');
  await admin.post('/admin/drive', { drive_dir: path.join(tmp, 'ไม่มี', 'ระบบส่งแผน'), drive_when: 'submit' });
  assert.equal(db.getSettings().drive_dir, '');

  await admin.post('/admin/drive', { drive_dir: root, drive_when: 'submit' });
  assert.equal(db.getSettings().drive_dir, root);
  assert.ok(fs.statSync(root).isDirectory(), 'สร้างโฟลเดอร์สุดท้ายให้');
  assert.deepEqual(fs.readdirSync(root), [], 'ไฟล์ทดสอบการเขียนถูกลบแล้ว');
  await admin.post('/admin/features/drivecopy', { on: '1' });
  assert.equal(db.getSettings().ff_drivecopy, '1');
  assert.ok(db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'ตั้งค่าคัดลอกไป Google Drive'"));

  // เปิดแล้วคัดลอกงานที่ส่งไว้ก่อนหน้าให้เอง (ข้อมูลทดลองมีงานที่ส่งแล้ว)
  await drive.syncAll();
  const before = drive.stats().works;
  assert.ok(before > 0, 'งานที่ส่งไว้แล้วถูกคัดลอก');
  assert.equal(db.q.get("SELECT COUNT(*) AS n FROM drive_copies c JOIN submissions s ON s.id = c.submission_id WHERE s.status NOT IN ('pending', 'approved') OR s.doc_type = 'note'").n, 0, 'ไม่คัดลอกฉบับร่างและบันทึกหลังแผน');

  // ครูส่งคู่มือใหม่ ระบบคัดลอกเบื้องหลังไปที่ ภาคเรียน/กลุ่มสาระ/ชื่อครู/คู่มือรายวิชา/
  const t = await as('teacher');
  const fields = { doc_type: 'manual', subject_code: 'ว31101', subject_name: 'วิทยาศาสตร์กายภาพ', grade_level: 'ม.4', action: 'submit' };
  const r = await sendWork(t, '/works', fields, [[await realPdf(2, 300), 'คู่มือ.pdf']]);
  assert.equal(r.status, 200, r.text);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  const sub = db.q.get('SELECT s.*, d.name AS dept FROM submissions s JOIN departments d ON d.id = s.department_id WHERE s.id = ?', id);
  assert.equal(sub.status, 'pending');
  const folder = path.join(root, `ภาคเรียน ${sub.semester}-${sub.academic_year}`, sub.dept, 'นายสมชาย ใจดี', 'คู่มือรายวิชา');
  const target = path.join(folder, 'ว31101 วิทยาศาสตร์กายภาพ.pdf');
  assert.ok(await waitFor(() => fs.existsSync(target)), 'มีสำเนาใน Drive');
  const stored = db.q.get('SELECT stored_name FROM files WHERE submission_id = ? AND is_current = 1', id).stored_name;
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(tmp, 'data-demo', 'uploads', stored)));

  // ผู้ตรวจส่งกลับ ครูแนบไฟล์ใหม่และเปลี่ยนชื่อวิชา ส่งอีกครั้ง สำเนาเก่าหายไป เหลือฉบับล่าสุด
  const head = await as('scihead');
  await head.post(`/s/${id}/return`, { comment: 'แก้หน้า 3' });
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', id).status, 'returned');
  const r2 = await sendWork(t, `/s/${id}`, { ...fields, subject_name: 'วิทยาศาสตร์กายภาพ 1' }, [[await realPdf(5, 250), 'ฉบับแก้.pdf']]);
  assert.equal(r2.status, 200, r2.text);
  const target2 = path.join(folder, 'ว31101 วิทยาศาสตร์กายภาพ 1.pdf');
  assert.ok(await waitFor(() => fs.existsSync(target2) && !fs.existsSync(target)), 'เปลี่ยนเป็นไฟล์ใหม่');
  assert.equal((await PDFDocument.load(fs.readFileSync(target2))).getPageCount(), 5);
  assert.deepEqual(fs.readdirSync(folder).filter((n) => n.startsWith('ว31101')), ['ว31101 วิทยาศาสตร์กายภาพ 1.pdf'], 'ไม่มีสำเนาฉบับเก่าค้าง');

  // สำเนาหายไปจาก Drive กดคัดลอกทั้งหมดแล้วกลับมา งานที่มีสำเนาแล้วข้ามไป
  fs.unlinkSync(target2);
  const s = await admin.post('/admin/drive/sync', {});
  assert.equal(s.status, 302);
  assert.ok(fs.existsSync(target2));
  assert.match(await admin.flash('/admin/features'), /คัดลอกใหม่ 1 งาน/);

  // ผู้ดูแลระบบลบงาน สำเนาใน Drive ถูกลบด้วย
  await admin.post(`/s/${id}/delete`, {});
  assert.ok(await waitFor(() => !fs.existsSync(target2)), 'ลบสำเนาแล้ว');
  assert.equal(db.q.get('SELECT COUNT(*) AS n FROM drive_copies WHERE submission_id = ?', id).n, 0);
});

test('คัดลอกไป Google Drive แบบรอผ่านครบทุกระดับ และกรณีโฟลเดอร์ Drive หายไป', async () => {
  const admin = await as('admin');
  const root = db.getSettings().drive_dir;
  await admin.post('/admin/drive', { drive_dir: root, drive_when: 'approved' });
  assert.equal(db.getSettings().drive_when, 'approved');

  const t = await as('sci2');
  const fields = { doc_type: 'manual', subject_code: 'ว22201', subject_name: 'โครงงาน/วิทยาศาสตร์: 1', grade_level: 'ม.2', action: 'submit' };
  const r = await sendWork(t, '/works', fields, [[await realPdf(1, 300), 'คู่มือ.pdf']]);
  assert.equal(r.status, 200, r.text);
  const id = Number(JSON.parse(r.text).redirect.split('/').pop());
  await drive.syncAll();
  assert.equal(db.q.get('SELECT COUNT(*) AS n FROM drive_copies WHERE submission_id = ?', id).n, 0, 'ยังไม่ผ่านครบ ยังไม่คัดลอก');

  await admin.post(`/s/${id}/admin-finish`, {});
  assert.equal(db.q.get('SELECT status FROM submissions WHERE id = ?', id).status, 'approved');
  assert.ok(await waitFor(() => db.q.get('SELECT COUNT(*) AS n FROM drive_copies WHERE submission_id = ?', id).n === 1), 'ผ่านครบแล้วคัดลอก');
  const rel = db.q.get('SELECT rel_path FROM drive_copies WHERE submission_id = ?', id).rel_path;
  assert.match(rel, /\/ว22201 โครงงาน วิทยาศาสตร์ 1\.pdf$/, 'ตัวอักษรที่ใช้ในชื่อไฟล์ไม่ได้ถูกแทนด้วยช่องว่าง');

  // โปรแกรม Google Drive ปิดอยู่ (โฟลเดอร์หาย) การลงนามยังทำได้ตามปกติ และหน้าผู้ดูแลแจ้งเตือน
  const moved = root + '-ปิดอยู่';
  fs.renameSync(root, moved);
  try {
    const s = await admin.post('/admin/drive/sync', {});
    assert.equal(s.status, 302);
    const page = await admin.flash('/admin/features');
    assert.match(page, /ไม่พบโฟลเดอร์ Google Drive ที่ตั้งไว้/);
    assert.match(page, /ไม่พบโฟลเดอร์ .*โปรแกรม Google Drive อาจยังไม่เปิด/);
  } finally {
    fs.renameSync(moved, root);
  }

  // เลิกคัดลอก: ปิดสวิตช์ สำเนาเดิมยังอยู่
  await admin.post('/admin/drive', { clear: '1' });
  assert.equal(db.getSettings().drive_dir, '');
  assert.equal(db.getSettings().ff_drivecopy, '0');
  assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))));
});

test('ชื่อไฟล์และโฟลเดอร์ใน Drive ใช้ได้ทั้ง Windows และ Mac', () => {
  assert.equal(drive.safeName('ว30101 ฟิสิกส์ 1/2: <พื้นฐาน>?', 'x'), 'ว30101 ฟิสิกส์ 1 2 พื้นฐาน');
  assert.equal(drive.safeName('ชื่อ...', 'x'), 'ชื่อ');
  assert.equal(drive.safeName('   ', 'ไม่ระบุ'), 'ไม่ระบุ');
});
