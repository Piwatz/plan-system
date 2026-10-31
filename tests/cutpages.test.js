// ทดสอบตัดหน้าไฟล์ (ฟังก์ชันเสริม cutpages): ตัวอ่านเลขหน้า การตัดหน้า สิทธิ์ ประวัติ และสวิตช์
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFLib = require('pdf-lib');
const { PDFDocument, StandardFonts } = PDFLib;
const { cutPages, moveOrder, movePages, insertPages, parsePages, pageRuns } = require('../public/js/pdfmerge');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cut-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const { uploadOne, XHR } = require('./upload-client');

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
  async req(method, url, body, headers = {}) {
    const cookie = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie, ...headers } });
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

async function pdf(pages) {
  const doc = await PDFDocument.create();
  doc.setSubject(`ไฟล์ทดลอง ${Math.random()}`);
  for (let i = 0; i < pages; i++) doc.addPage([300 + i, 400]);
  return doc.save();
}
const blobOf = async (pages) => new Blob([await pdf(pages)], { type: 'application/pdf' });

// แผนหรือคู่มือที่มีไฟล์หลักไฟล์เดียว เจ้าของไม่ใช่ผู้ดูแลระบบ
const workOf = (status) =>
  db.q.get(
    `SELECT s.id, s.status, s."current_role", u.username, MIN(f.id) AS file FROM submissions s JOIN users u ON u.id = s.teacher_id JOIN files f ON f.submission_id = s.id AND f.kind = 'main' AND f.is_current = 1
     WHERE s.status = ? AND s.doc_type IN ('manual', 'plan') AND u.is_admin = 0 GROUP BY s.id, s.status, s."current_role", u.username HAVING COUNT(f.id) = 1 AND MIN(f.mime) = 'application/pdf' ORDER BY s.id DESC LIMIT 1`,
    status
  );

test('อ่านเลขหน้าที่พิมพ์: ช่วง หลายช่วง เลขไทย คำว่า ถึง เว้นวรรค ช่วงกลับด้าน และข้อความเตือน', () => {
  const seq = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  assert.deepEqual(parsePages('1-18', 24).pages, seq(1, 18));
  assert.deepEqual(parsePages('1-3, 25', 30).pages, [1, 2, 3, 25]);
  assert.deepEqual(parsePages(' 1 - 3 , 5 7 ', 30).pages, [1, 2, 3, 5, 7]);
  assert.deepEqual(parsePages('๑ ถึง ๓', 30).pages, [1, 2, 3]);
  assert.deepEqual(parsePages('3-1', 30).pages, [1, 2, 3]);
  assert.deepEqual(parsePages('2,2,1-2', 30).pages, [1, 2]);
  assert.deepEqual(parsePages('', 30), { pages: [], error: '' });
  assert.match(parsePages('1-40', 24).error, /ไฟล์นี้มี 24 หน้า ไม่มีหน้า 40/);
  assert.match(parsePages('0-3', 24).error, /เริ่มที่หน้า 1/);
  assert.match(parsePages('abc', 24).error, /พิมพ์เลขหน้าแบบ/);
  assert.deepEqual(pageRuns([25, 1, 2, 3]), [[1, 3], [25, 25]]);
});

test('ตัดหน้า: เหลือหน้าถูกต้องตามลำดับ เนื้อหาหน้าที่ลบหายจากไฟล์จริง ไฟล์เล็กลง ลบทุกหน้าไม่ได้', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 20; i++) {
    const p = doc.addPage([300 + i, 400]);
    for (let y = 20; y < 380; y += 12) p.drawText(`page ${i} line ${y} ${Math.random()}`, { x: 10, y, size: 8, font });
  }
  const src = await doc.save({ useObjectStreams: false });
  const r = await cutPages(PDFLib, src, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]);
  assert.equal(r.pages, 9);
  assert.equal(r.removed, 11);
  const out = await PDFDocument.load(r.bytes);
  assert.deepEqual(out.getPages().map((p) => p.getWidth()), [311, 312, 313, 314, 315, 316, 317, 318, 319]);
  assert.ok(r.bytes.length < src.length * 0.7, `ไฟล์ต้องเล็กลงจริง ${src.length} เป็น ${r.bytes.length}`);
  await assert.rejects(cutPages(PDFLib, await pdf(2), [1, 2]), /ลบทุกหน้าไม่ได้/);
  await assert.rejects(cutPages(PDFLib, new TextEncoder().encode('ไม่ใช่ PDF'), [1]), /เปิดไฟล์เดิมไม่ได้/);
});

test('ลำดับย้ายหน้า: ท้ายเล่ม หน้าแรก หลังหน้า หลายหน้า และข้อความเตือน', () => {
  assert.deepEqual(moveOrder(5, [2], 5).order, [1, 3, 4, 5, 2]);
  assert.deepEqual(moveOrder(5, [4], 0).order, [4, 1, 2, 3, 5]);
  assert.deepEqual(moveOrder(6, [2, 3], 5).order, [1, 4, 5, 2, 3, 6]);
  assert.deepEqual(moveOrder(6, [5, 2], 0).order, [2, 5, 1, 3, 4, 6]);
  assert.deepEqual(moveOrder(5, [4], 1).order, [1, 4, 2, 3, 5]);
  assert.match(moveOrder(5, [], 5).error, /ยังไม่ได้เลือก/);
  assert.match(moveOrder(2, [1, 2], 0).error, /ย้ายทุกหน้าไม่ได้/);
  assert.match(moveOrder(5, [2, 3], 3).error, /ต้องไม่ใช่หน้าที่กำลังย้าย/);
  assert.match(moveOrder(5, [2], 9).error, /ไฟล์นี้มี 5 หน้า/);
  assert.match(moveOrder(5, [2], 1).error, /เหมือนเดิม/);
  assert.match(moveOrder(5, [5], 4).error, /เหมือนเดิม/);
  assert.match(moveOrder(5, [1], 0).error, /เหมือนเดิม/);
});

test('ย้ายหน้า: ไฟล์ใหม่เรียงตามลำดับ หน้าครบ ไฟล์เสียและจำนวนหน้าไม่ตรงทำไม่ได้', async () => {
  const src = await pdf(188);
  const { order } = moveOrder(188, [2], 188);
  const r = await movePages(PDFLib, src, order);
  assert.equal(r.pages, 188);
  const widths = (await PDFDocument.load(r.bytes)).getPages().map((p) => p.getWidth());
  // pdf() ตั้งความกว้างหน้า n เป็น 300 + (n - 1)
  assert.equal(widths[0], 300);
  assert.equal(widths[1], 302, 'หน้า 3 เดิมเลื่อนขึ้นมาเป็นหน้า 2');
  assert.equal(widths[186], 487);
  assert.equal(widths[187], 301, 'หน้า 2 เดิมเป็นหน้าสุดท้าย');
  assert.deepEqual([...widths].sort((a, b) => a - b), Array.from({ length: 188 }, (_, i) => 300 + i));
  await assert.rejects(movePages(PDFLib, src, [1, 2]), /จำนวนหน้าของไฟล์เปลี่ยนไปแล้ว/);
  await assert.rejects(movePages(PDFLib, new TextEncoder().encode('ไม่ใช่ PDF'), [1]), /เปิดไฟล์เดิมไม่ได้/);
});

test('ย้ายหน้าไฟล์: ไม่เปลี่ยนสถานะ เก็บไฟล์เดิมและประวัติ ครูทำไม่ได้ ไฟล์เปลี่ยนแล้วไม่ทับ ปิดสวิตช์แล้วเหลือแค่ลบหน้า', async () => {
  const form = (id) => ({ form: `/s/${id}/movepages`, field: 'main_files', merged: '2' });
  const send = (c, id, fields) => c.req('POST', `/s/${id}/movepages`, new URLSearchParams(fields), XHR);
  const a = await as('admin');
  const work = await workOf('pending');
  const page = (await a.get(`/s/${work.id}`)).text;
  assert.match(page, /data-cut-mode="move"/);

  let tk = await uploadOne(a, await blobOf(3), 'merged.pdf', form(work.id));
  const r = await send(a, work.id, { moved: '2', after: '188', to: 'last', left: '188', from: String(work.file), upload_main_files: tk });
  assert.equal(r.status, 200, r.text);
  const after = await db.q.get('SELECT status, "current_role" FROM submissions WHERE id = ?', work.id);
  assert.equal(after.status, work.status);
  assert.equal(after.current_role, work.current_role);
  assert.equal((await db.q.get('SELECT is_current FROM files WHERE id = ?', work.file)).is_current, 0, 'ไฟล์เดิมเป็นรุ่นก่อน');
  const rev = await db.q.get("SELECT step_label, comment FROM reviews WHERE submission_id = ? AND action = 'movepages' ORDER BY id DESC LIMIT 1", work.id);
  assert.equal(rev.step_label, 'ผู้ดูแลระบบ');
  assert.equal(rev.comment, 'ย้ายหน้า 2 ไปเป็นหน้าสุดท้าย รวม 188 หน้า');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ย้ายหน้าไฟล์%ย้ายหน้า 2 ไปเป็นหน้าสุดท้าย%'"));
  assert.match((await a.get(`/s/${work.id}`)).text, /ผู้ดูแลระบบย้ายหน้าไฟล์ \(ไฟล์เดิมเก็บไว้ในประวัติ\)/);

  // อ้างไฟล์เก่า ไม่บันทึกทับ · ค่าปลายทางผิดรูปแบบ
  tk = await uploadOne(a, await blobOf(2), 'merged.pdf', form(work.id));
  const stale = await send(a, work.id, { moved: '1', after: '0', left: '2', from: String(work.file), upload_main_files: tk });
  assert.notEqual(stale.status, 200);
  assert.match(stale.text, /ไฟล์ของงานนี้เปลี่ยนไปแล้ว/);
  assert.notEqual((await send(a, work.id, { moved: '1', after: 'x', from: '1' })).status, 200);
  assert.notEqual((await send(a, work.id, { moved: '1;drop', after: '1', from: '1' })).status, 200);

  // ครูเจ้าของงานส่งเองไม่ได้
  const t = await as(work.username);
  assert.notEqual((await t.post('/upload/start', { ...form(work.id), name: 'merged.pdf', size: '100' })).status, 200);
  assert.notEqual((await send(t, work.id, { moved: '1', after: '2', from: '1' })).status, 200);

  // ปิดสวิตช์: เหลือปุ่มตัดหน้าแบบเดิม เส้นทางย้ายใช้ไม่ได้
  await db.setSetting('ff_movepages', '0');
  await db.setSetting('ff_insertpages', '0');
  const off = (await a.get(`/s/${work.id}`)).text;
  assert.match(off, /ตัดหน้าไฟล์แทนครู/);
  assert.doesNotMatch(off, /data-cut-mode|data-move-block/);
  await db.setSetting('ff_insertpages', '1');
  assert.notEqual((await send(a, work.id, { moved: '1', after: '2', from: '1' })).status, 200);
  assert.notEqual((await a.post('/upload/start', { ...form(work.id), name: 'merged.pdf', size: '100' })).status, 200);
  await db.setSetting('ff_movepages', '1');
});

test('ตัดหน้าไฟล์: ผู้ดูแลทำได้ทุกขั้น ไม่เปลี่ยนสถานะ เก็บไฟล์เดิมและประวัติ ครูและงานตัวเองทำไม่ได้ ไฟล์เปลี่ยนแล้วไม่ทับ ปิดสวิตช์แล้วไม่มี', async () => {
  const form = (id) => ({ form: `/s/${id}/cutpages`, field: 'main_files', merged: '2' });
  const send = (c, id, fields) => c.req('POST', `/s/${id}/cutpages`, new URLSearchParams(fields), XHR);
  const a = await as('admin');

  // งานที่ผ่านครบแล้ว
  const done = await workOf('approved');
  const page = (await a.get(`/s/${done.id}`)).text;
  assert.match(page, /data-cut-open="cut-dlg"/);
  assert.match(page, /ตัด ย้าย หรือแทรกหน้าแทนครู/);
  assert.match(page, new RegExp(`data-from="${done.file}"`));

  let tk = await uploadOne(a, await blobOf(3), 'merged.pdf', form(done.id));
  let r = await send(a, done.id, { removed: '1-18,25', left: '3', from: String(done.file), upload_main_files: tk });
  assert.equal(r.status, 200, r.text);
  const after = await db.q.get('SELECT status, "current_role" FROM submissions WHERE id = ?', done.id);
  assert.equal(after.status, done.status, 'สถานะเดิม');
  assert.equal(after.current_role, done.current_role, 'ขั้นการตรวจเดิม');
  const cur = await db.q.all("SELECT id FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1", done.id);
  assert.equal(cur.length, 1);
  assert.notEqual(Number(cur[0].id), Number(done.file));
  assert.equal((await db.q.get('SELECT is_current FROM files WHERE id = ?', done.file)).is_current, 0, 'ไฟล์เดิมเป็นรุ่นก่อน ไม่ถูกลบ');
  const rev = await db.q.get("SELECT step_label, comment FROM reviews WHERE submission_id = ? AND action = 'cutpages' ORDER BY id DESC LIMIT 1", done.id);
  assert.equal(rev.step_label, 'ผู้ดูแลระบบ');
  assert.equal(rev.comment, 'ลบหน้า 1 ถึง 18, 25 เหลือ 3 หน้า');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ตัดหน้าไฟล์%ลบหน้า 1 ถึง 18, 25 เหลือ 3 หน้า'"));
  assert.match((await a.get(`/s/${done.id}`)).text, /ผู้ดูแลระบบตัดหน้าไฟล์ \(ไฟล์เดิมเก็บไว้ในประวัติ\)/);

  // อ้างไฟล์เก่า (ไฟล์เปลี่ยนไปแล้ว) ไม่บันทึกทับ
  tk = await uploadOne(a, await blobOf(2), 'merged.pdf', form(done.id));
  r = await send(a, done.id, { removed: '1', left: '2', from: String(done.file), upload_main_files: tk });
  assert.notEqual(r.status, 200);
  assert.match(r.text, /ไฟล์ของงานนี้เปลี่ยนไปแล้ว/);
  assert.equal(Number((await db.q.get("SELECT id FROM files WHERE submission_id = ? AND kind = 'main' AND is_current = 1", done.id)).id), Number(cur[0].id));

  // เลขหน้ารูปแบบผิด
  tk = await uploadOne(a, await blobOf(2), 'merged.pdf', form(done.id));
  assert.notEqual((await send(a, done.id, { removed: '1;drop', from: String(cur[0].id), upload_main_files: tk })).status, 200);

  // งานที่รอตรวจ
  const wait = await workOf('pending');
  tk = await uploadOne(a, await blobOf(2), 'merged.pdf', form(wait.id));
  r = await send(a, wait.id, { removed: '3', left: '2', from: String(wait.file), upload_main_files: tk });
  assert.equal(r.status, 200, r.text);
  assert.equal((await db.q.get('SELECT status FROM submissions WHERE id = ?', wait.id)).status, 'pending');

  // ครูเจ้าของงานไม่มีปุ่มและส่งเองไม่ได้
  const t = await as(wait.username);
  assert.doesNotMatch((await t.get(`/s/${wait.id}`)).text, /data-cut-open/);
  assert.notEqual((await t.post('/upload/start', { ...form(wait.id), name: 'merged.pdf', size: '100' })).status, 200);
  assert.notEqual((await send(t, wait.id, { removed: '1', from: '1' })).status, 200);

  // งานของผู้ดูแลระบบเองทำไม่ได้
  const me = await db.q.get("SELECT id FROM users WHERE username = 'admin'");
  await db.q.run('UPDATE submissions SET teacher_id = ? WHERE id = ?', me.id, wait.id);
  assert.doesNotMatch((await a.get(`/s/${wait.id}`)).text, /data-cut-open/);
  assert.notEqual((await send(a, wait.id, { removed: '1', from: '1' })).status, 200);

  // ปิดสวิตช์แล้วไม่มีปุ่มและเส้นทางใช้ไม่ได้
  await db.setSetting('ff_cutpages', '0');
  assert.doesNotMatch((await a.get(`/s/${done.id}`)).text, /data-cut-open/);
  assert.notEqual((await send(a, done.id, { removed: '1', from: String(cur[0].id) })).status, 200);
  assert.notEqual((await a.post('/upload/start', { ...form(done.id), name: 'merged.pdf', size: '100' })).status, 200);
  await db.setSetting('ff_cutpages', '1');
});

test('แทรกไฟล์ PDF: ไว้กลางเล่ม หน้าแรก ท้ายเล่ม หลายหน้า ปลายทางเกินและไฟล์เสียทำไม่ได้', async () => {
  const main = await pdf(5);
  const extraDoc = await PDFDocument.create();
  extraDoc.addPage([900, 400]);
  const extra = await extraDoc.save();
  const widths = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());
  let r = await insertPages(PDFLib, main, extra, 2);
  assert.equal(r.pages, 6);
  assert.equal(r.added, 1);
  assert.deepEqual(await widths(r.bytes), [300, 301, 900, 302, 303, 304]);
  assert.deepEqual(await widths((await insertPages(PDFLib, main, extra, 0)).bytes), [900, 300, 301, 302, 303, 304]);
  assert.deepEqual(await widths((await insertPages(PDFLib, main, extra, 5)).bytes), [300, 301, 302, 303, 304, 900]);
  r = await insertPages(PDFLib, main, await pdf(2), 1);
  assert.equal(r.added, 2);
  assert.deepEqual(await widths(r.bytes), [300, 300, 301, 301, 302, 303, 304]);
  await assert.rejects(insertPages(PDFLib, main, extra, 6), /ไฟล์นี้มี 5 หน้า/);
  await assert.rejects(insertPages(PDFLib, main, new TextEncoder().encode('ไม่ใช่ PDF'), 1), /เปิดไฟล์ที่จะแทรกไม่ได้/);
  await assert.rejects(insertPages(PDFLib, new TextEncoder().encode('ไม่ใช่ PDF'), extra, 1), /เปิดไฟล์เดิมไม่ได้/);
});

test('แทรกไฟล์ผ่านเส้นทาง: ไม่เปลี่ยนสถานะ เก็บไฟล์เดิมและประวัติ ครูทำไม่ได้ ปิดสวิตช์แล้วไม่มีแท็บ', async () => {
  const form = (id) => ({ form: `/s/${id}/insertpages`, field: 'main_files', merged: '2' });
  const send = (c, id, fields) => c.req('POST', `/s/${id}/insertpages`, new URLSearchParams(fields), XHR);
  const a = await as('admin');
  const work = await workOf('approved');
  assert.match((await a.get(`/s/${work.id}`)).text, /data-cut-mode="insert"/);
  const tk = await uploadOne(a, await blobOf(3), 'merged.pdf', form(work.id));
  const r = await send(a, work.id, { after: '150', to: 'after', added: '1', name: 'หน้าเพิ่ม.pdf', left: '189', from: String(work.file), upload_main_files: tk });
  assert.equal(r.status, 200, r.text);
  assert.equal((await db.q.get('SELECT status FROM submissions WHERE id = ?', work.id)).status, work.status);
  assert.equal((await db.q.get('SELECT is_current FROM files WHERE id = ?', work.file)).is_current, 0, 'ไฟล์เดิมเป็นรุ่นก่อน');
  const rev = await db.q.get("SELECT comment FROM reviews WHERE submission_id = ? AND action = 'insertpages' ORDER BY id DESC LIMIT 1", work.id);
  assert.equal(rev.comment, 'แทรกไฟล์ หน้าเพิ่ม.pdf 1 หน้า ไว้หลังหน้า 150 รวม 189 หน้า');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'แทรกไฟล์ใน%แทรกไฟล์ หน้าเพิ่ม.pdf%'"));
  assert.notEqual((await send(a, work.id, { after: 'x', added: '1', from: '1' })).status, 200);
  assert.notEqual((await send(a, work.id, { after: '1', added: '0', from: '1' })).status, 200);
  const t = await as(work.username);
  assert.notEqual((await t.post('/upload/start', { ...form(work.id), name: 'merged.pdf', size: '100' })).status, 200);
  assert.notEqual((await send(t, work.id, { after: '1', added: '1', from: '1' })).status, 200);
  await db.setSetting('ff_insertpages', '0');
  assert.doesNotMatch((await a.get(`/s/${work.id}`)).text, /data-cut-mode="insert"/);
  assert.notEqual((await send(a, work.id, { after: '1', added: '1', from: '1' })).status, 200);
  await db.setSetting('ff_insertpages', '1');
});
