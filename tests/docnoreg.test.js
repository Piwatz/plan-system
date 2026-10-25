// ทดสอบทะเบียนเลขที่บันทึกข้อความ (ฟังก์ชันเสริม docnoreg): จัดรายการ เลขซ้ำ คู่มือใช้เลขเดียวกัน เล่มบันทึกหลังแผน
// ไฟล์ .xlsx ที่สร้างเอง หน้าเว็บ 2 มุมมอง ส่งออก เติมเลขแทนครู สิทธิ์ · ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-docnoreg-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const docnoreg = require('../src/docnoreg');
const xlsx = require('../src/xlsx');

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
  async req(method, url, body) {
    const cookie = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie } });
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
    return this.req('POST', url, new URLSearchParams(fields));
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

// แถวงานสมมติสำหรับทดสอบตัวจัดรายการ
let nid = 0;
const row = (o) => ({ id: ++nid, parent_id: null, teacher_id: 1, teacher_name: 'ครูทดลอง หนึ่ง', dept_id: 1, dept_name: 'วิทยาศาสตร์', dept_sort: 1, academic_year: 2569, semester: 1, subject_code: 'ว1', subject_name: 'วิชา', status: 'approved', current_role: null, submitted_at: '2026-10-03 09:00:00', updated_at: '2026-10-03 09:00:00', doc_no: '', ...o });

test('จัดรายการ: เรียงตามเลข คู่มือครูคนเดียวกันเลขเดียวกันรวมเป็นฉบับเดียว เลขซ้ำต่างงานติดป้าย เล่มบันทึกหลังแผนนับครั้งเดียว', () => {
  const rows = [
    row({ doc_type: 'plan', doc_no: 'วก.20/2569' }),
    row({ doc_type: 'manual', doc_no: 'วก.3/2569', subject_code: 'ว31101' }),
    row({ doc_type: 'manual', doc_no: 'วก.3/2569', subject_code: 'ว31221', status: 'pending', current_role: 'dept_head' }),
    row({ doc_type: 'manual', doc_no: 'วก.20/2569', teacher_id: 2, teacher_name: 'ครูทดลอง สอง' }),
    row({ doc_type: 'plan', doc_no: '' }),
    row({ doc_type: 'note', parent_id: 900, doc_no: 'วก.100/2569' }),
    row({ doc_type: 'note', parent_id: 900, doc_no: 'วก.100/2569' }),
    row({ doc_type: 'note', parent_id: 901, doc_no: '' }),
    row({ doc_type: 'plan', doc_no: 'เลขอิสระ' }),
  ];
  const r = docnoreg.build(rows);
  assert.deepEqual(r.numbered.map((e) => e.doc_no), ['วก.3/2569', 'วก.20/2569', 'วก.20/2569', 'วก.100/2569', 'เลขอิสระ']);
  const shared = r.numbered[0];
  assert.equal(shared.subjects.length, 2, 'คู่มือ 2 วิชาเลขเดียวกันเป็นฉบับเดียว');
  assert.equal(shared.dup, false);
  assert.equal(shared.status.status, 'pending', 'สถานะรวมเป็นงานที่ยังรอ');
  assert.equal(r.numbered[1].dup && r.numbered[2].dup, true, 'วก.20 ใช้ 2 งานต่างครู ติดป้ายซ้ำ');
  assert.equal(r.dupCount, 2);
  const book = r.numbered[3];
  assert.equal(book.type, 'note');
  assert.equal(book.sheets, 2);
  assert.equal(book.href, '/s/900#notes');
  assert.equal(r.missing.length, 1, 'เล่มที่ไม่มีเลขไม่นับเมื่อปิดเลขบันทึกหลังแผน');
  assert.equal(docnoreg.build(rows, { notes: true }).missing.length, 2);
  const depts = docnoreg.byDept([...r.numbered, ...r.missing]);
  assert.equal(depts[0].total, 2);
  assert.equal(depts[0].complete, 1, 'ครูหนึ่งมีแผนไม่มีเลข ครูสองมีเลขครบ');
});

// อ่านไฟล์ zip แบบไม่บีบอัดกลับ ตรวจ CRC ทุกไฟล์
function unzip(buf) {
  const out = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lnameLen = buf.readUInt16LE(off + 26);
    const data = buf.subarray(off + 30 + lnameLen, off + 30 + lnameLen + size);
    assert.equal(xlsx.crc32(data), crc, `CRC ของ ${name}`);
    out[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

test('ไฟล์ .xlsx: zip ถูกต้อง มีครบทุกส่วน ข้อความไทยและอักขระพิเศษไม่พัง แถวที่เลือกพื้นแดง', () => {
  assert.equal(xlsx.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(xlsx.colName(0), 'A');
  assert.equal(xlsx.colName(27), 'AB');
  const bytes = xlsx.build({ sheet: 'ทะเบียน/เลข', title: 'หัวเรื่อง <ทดลอง>', head: ['ก', 'ข'], rows: [[1, 'วก.1/2569 & "x"'], [2, 'ซ้ำ']], widths: [8, 20], marked: (r) => r[1] === 'ซ้ำ' });
  const files = unzip(Buffer.from(bytes));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /หัวเรื่อง &lt;ทดลอง&gt;/);
  assert.match(sheet, /วก\.1\/2569 &amp; &quot;x&quot;/);
  assert.match(sheet, /<c r="B4" s="4" t="inlineStr"><is><t xml:space="preserve">ซ้ำ<\/t>/);
  assert.match(sheet, /<c r="A3" s="3"><v>1<\/v><\/c>/);
  assert.match(files['xl/workbook.xml'], /sheet name="ทะเบียน เลข"/, 'ชื่อแผ่นงานห้ามมีทับ');
});

test('หน้าทะเบียน: ผู้ดูแลเห็น 2 มุมมอง เลขซ้ำ งานที่ไม่มีเลข ส่งออก xlsx csv เติมเลขแทนครู ครูเข้าไม่ได้ ปิดสวิตช์แล้วเข้าไม่ได้', async () => {
  const subs = await db.q.all("SELECT id, doc_type, teacher_id, academic_year FROM submissions WHERE status != 'draft' AND doc_type IN ('plan', 'manual') ORDER BY id");
  assert.ok(subs.length >= 3, 'ข้อมูลทดลองต้องมีงานที่ส่งแล้วอย่างน้อย 3 งาน');
  const year = subs[0].academic_year;
  const sameYear = subs.filter((s) => s.academic_year === year);
  await db.q.run("UPDATE submissions SET doc_no = '' WHERE status != 'draft' AND academic_year = ?", year);
  await db.q.run("UPDATE submissions SET doc_no = 'วก.501/" + year + "' WHERE id = ?", sameYear[0].id);
  // งานต่างครูหรือต่างชนิดใช้เลขเดียวกัน = ซ้ำ
  const other = sameYear.find((s) => s.teacher_id !== sameYear[0].teacher_id || s.doc_type !== sameYear[0].doc_type);
  await db.q.run("UPDATE submissions SET doc_no = 'วก.501/" + year + "' WHERE id = ?", other.id);
  const target = sameYear.find((s) => s.id !== sameYear[0].id && s.id !== other.id);

  const admin = await as('admin');
  const page = await admin.get(`/admin/docnoreg?year=${year}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /เรียงตามเลข/);
  assert.match(page.text, /วก\.501\//);
  assert.match(page.text, /badge badge-red">ซ้ำ/);
  assert.match(page.text, /id="missing"/);
  assert.match(page.text, new RegExp(`name="id" value="${target.id}"`));

  const byTeacher = await admin.get(`/admin/docnoreg?year=${year}&view=teacher`);
  assert.equal(byTeacher.status, 200);
  assert.match(byTeacher.text, /มีเลขครบ/);
  assert.match(byTeacher.text, /ไม่มีเลข/);

  const x = await admin.get(`/admin/docnoreg.xlsx?year=${year}`);
  assert.equal(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  const sheet = unzip(x.buf)['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /เลขซ้ำ/);
  assert.match(sheet, /ยังไม่มีเลข/);
  const csv = await admin.get(`/admin/docnoreg.csv?year=${year}&view=teacher`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^﻿ลำดับ,เลขที่/);

  const filled = await admin.post('/admin/docnoreg/no', { kind: 'work', id: String(target.id), doc_no_num: '๕๐๒', back: `/admin/docnoreg?year=${year}` });
  assert.equal(filled.status, 302);
  assert.equal(filled.location, `/admin/docnoreg?year=${year}`);
  const after = await db.q.get('SELECT doc_no, status FROM submissions WHERE id = ?', target.id);
  assert.match(after.doc_no, /^วก\.502\/\d{4}$/, 'เลขไทยแปลงเป็นอารบิก เติมคำนำหน้าและปี');
  assert.ok(await db.q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND action = 'docno'", target.id), 'บันทึกในประวัติของงาน');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE '%จากหน้าทะเบียนเลข%'"), 'บันทึกในประวัติการใช้งาน');
  const bad = await admin.post('/admin/docnoreg/no', { kind: 'work', id: String(target.id), doc_no_num: 'abc', back: 'https://evil.example/' });
  assert.equal(bad.location, '/admin/docnoreg', 'ที่อยู่กลับต้องเป็นหน้าทะเบียนเท่านั้น');

  const teacher = await as('section');
  assert.equal((await teacher.get('/admin/docnoreg')).status, 403);
  assert.equal((await teacher.get('/admin/docnoreg.xlsx')).status, 403);

  await admin.post('/admin/features/docnoreg', { on: '0' });
  const off = await admin.get('/admin/docnoreg');
  assert.equal(off.status, 302, 'ปิดสวิตช์แล้วกลับไปหน้าผู้ดูแล');
  await admin.post('/admin/features/docnoreg', { on: '1' });
});
