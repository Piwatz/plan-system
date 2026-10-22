// ทดสอบไฟล์ในถังขยะ (ฟังก์ชันเสริม trashbin): ลบงานแล้วจดไว้ ดาวน์โหลด กู้กลับเป็นงานเดิม กู้คืนเข้าที่เก็บไฟล์ ไฟล์ที่ไม่ได้จด
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-trash-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const { uploadOne, sendForm, XHR } = require('./upload-client');

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
  doc.setSubject(`ไฟล์ทดลอง ${Math.random()}`); // ไฟล์ไม่ซ้ำกัน (ฟังก์ชันเสริม dupfile ไม่ให้ส่งไฟล์เดียวกันสองงาน)
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const config = require('../src/config');

// ครูส่งคู่มือเป็นฉบับร่าง แล้วลบเอง คืนเลขงานและที่เก็บไฟล์
async function draftAndDelete(t, code) {
  const fields = { doc_type: 'manual', subject_code: code, subject_name: 'ทดสอบถังขยะ', grade_level: 'ม.4', doc_no: 'วก.9/2569', action: 'draft' };
  const r = await sendForm(t, '/works', fields, [[await pdf(2), 'คู่มือถังขยะ.pdf']]);
  const id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  const f = await db.q.get("SELECT stored_name FROM files WHERE submission_id = ? AND kind = 'main'", id);
  const d = await t.post(`/s/${id}/delete`, {});
  assert.equal(d.status, 302);
  assert.equal(await db.q.get('SELECT id FROM submissions WHERE id = ?', id), undefined, 'งานถูกลบ');
  return { id, stored: f.stored_name };
}
const localPath = (ref) => path.join(config.FILES_DIR, ref.replace(/^local:/, ''));

test('ลบงานแล้วจดไว้ ผู้ดูแลดาวน์โหลดและกู้กลับเป็นงานฉบับร่างของครูคนเดิมได้ครั้งเดียว ครูเปิดหน้าถังขยะไม่ได้', async () => {
  const t = await as('sci2');
  const { id, stored } = await draftAndDelete(t, 'ว30181');
  assert.ok(!fs.existsSync(localPath(stored)), 'ไฟล์ย้ายออกจากที่เดิม');
  const log = await db.q.get('SELECT * FROM trash_log WHERE submission_id = ?', id);
  assert.ok(log, 'จดไว้ในถังขยะ');
  assert.match(log.label, /^คู่มือ ว30181 ทดสอบถังขยะ ของ/);
  assert.equal(log.deleted_by_name, (await db.q.get("SELECT full_name FROM users WHERE username = 'sci2'")).full_name);
  assert.ok(log.trash_ref && fs.existsSync(localPath(log.trash_ref)), 'ไฟล์อยู่ในถังขยะ');

  assert.notEqual((await t.get('/admin/trash')).status, 200, 'ครูเปิดหน้าถังขยะไม่ได้');
  const a = await as('admin');
  const page = (await a.get('/admin/trash')).text;
  assert.match(page, /คู่มือถังขยะ\.pdf/);
  assert.match(page, /กู้กลับเป็นงานเดิม \(ฉบับร่าง\)/);
  assert.match(page, /อีก 30 วัน/);
  assert.match((await a.get('/admin')).text, /href="\/admin\/trash"/);
  const file = await fetch(`${base}/admin/trash/${log.id}/file`, { headers: { cookie: Object.entries(a.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const r = await a.post(`/admin/trash/${log.id}/restore`, { to: 'work' });
  const newId = Number(/\/s\/(\d+)/.exec(r.location)[1]);
  const sub = await db.q.get('SELECT s.status, s.subject_code, s.doc_no, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.id = ?', newId);
  assert.deepEqual({ ...sub }, { status: 'draft', subject_code: 'ว30181', doc_no: 'วก.9/2569', username: 'sci2' });
  assert.ok(fs.existsSync(localPath(stored)), 'ไฟล์กลับที่เดิม');
  assert.equal((await db.q.get('SELECT stored_name FROM files WHERE submission_id = ?', newId)).stored_name, stored);
  assert.match((await t.get(`/s/${newId}`)).text, /ว30181/, 'ครูเปิดงานที่กู้ได้');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'กู้งานจากถังขยะเป็นฉบับร่าง%'"));
  // กู้ซ้ำไม่ได้ และย้ายไปหัวข้อ กู้คืนแล้ว
  await a.post(`/admin/trash/${log.id}/restore`, { to: 'work' });
  assert.equal((await db.q.get("SELECT count(*)::int AS n FROM submissions WHERE subject_code = 'ว30181'")).n, 1);
  assert.match((await a.get('/admin/trash')).text, /กู้กลับเป็นงานฉบับร่าง โดย/);
});

test('กู้คืนเข้าที่เก็บไฟล์อย่างเดียว ไม่สร้างงาน · ไฟล์ในถังขยะที่ไม่ได้จด เห็นชื่อและดาวน์โหลดได้ · ปิดสวิตช์ไม่จดและไม่มีหน้า', async () => {
  const t = await as('sci2');
  const a = await as('admin');
  const { stored } = await draftAndDelete(t, 'ว30182');
  const log = await db.q.get("SELECT id FROM trash_log WHERE label LIKE '%ว30182%'");
  await a.post(`/admin/trash/${log.id}/restore`, { to: 'drive' });
  assert.ok(fs.existsSync(localPath(stored)), 'ไฟล์กลับที่เดิม');
  assert.equal((await db.q.get("SELECT count(*)::int AS n FROM submissions WHERE subject_code = 'ว30182'")).n, 0, 'ไม่สร้างงาน');

  // ไฟล์ที่อยู่ในถังขยะโดยไม่ได้จด (ลบก่อนเปิดใช้)
  const dir = path.join(config.FILES_DIR, '.trash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '20261001000000-abc123-แผนเก่า.pdf'), '%PDF-1.4 old');
  const page = (await a.get('/admin/trash')).text;
  assert.match(page, /แผนเก่า\.pdf/);
  const key = /href="\/admin\/trash\/(x[^"]+)\/file"/.exec(page)[1];
  const file = await fetch(`${base}/admin/trash/${key}/file`, { headers: { cookie: Object.entries(a.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF-1.4 old');
  // ที่อยู่ที่ไม่ได้อยู่ในถังขยะ ดาวน์โหลดไม่ได้
  assert.notEqual((await a.get(`/admin/trash/${encodeURIComponent('x' + stored)}/file`)).status, 200);

  await a.post('/admin/features/trashbin', { on: '0' });
  const n = (await db.q.get('SELECT count(*)::int AS n FROM trash_log')).n;
  await draftAndDelete(t, 'ว30183');
  assert.equal((await db.q.get('SELECT count(*)::int AS n FROM trash_log')).n, n, 'ปิดสวิตช์ไม่จด');
  assert.equal((await a.get('/admin/trash')).status, 302);
  assert.doesNotMatch((await a.get('/admin')).text, /href="\/admin\/trash"/);
  await a.post('/admin/features/trashbin', { on: '1' });
});
