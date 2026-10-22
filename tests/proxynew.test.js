// ทดสอบสร้างงานแทนครู (ฟังก์ชันเสริม proxynew): ผู้ดูแลระบบสร้างคู่มือหรือแผนในชื่อครู ไม่ใส่ลายเซ็นครู จดประวัติและ audit_log
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-proxynew-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const { sendForm } = require('./upload-client');

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
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const countOf = (code) => db.q.get('SELECT COUNT(*) AS n FROM submissions WHERE subject_code = ?', code).then((r) => Number(r.n));

test('ผู้ดูแลระบบสร้างคู่มือแทนครู: เป็นชื่อครู ส่งได้ ไม่มีลายเซ็นครู จดประวัติและ audit_log', async () => {
  const t = await db.q.get("SELECT id, full_name, department_id FROM users WHERE username = 'teacher'");
  const a = await as('admin');
  // ปุ่ม สร้างแทนครู ในรายวิชาที่สอนของครู
  const st = await db.getSettings();
  await db.q.run(
    "INSERT INTO teach_subjects (teacher_id, academic_year, semester, subject_code, subject_name, grade_level, is_main) VALUES (?, ?, ?, 'ว30181', 'ทดสอบแทนครู', 'ม.4', 0)",
    t.id,
    Number(st.academic_year),
    Number(st.semester)
  );
  const list = (await a.get(`/teaching?u=${t.id}`)).text;
  assert.ok(list.includes(`/works/new?type=manual&code=${encodeURIComponent("ว30181")}&for=${t.id}`), 'มีปุ่มสร้างแทนครู');
  const page = (await a.get(`/works/new?type=manual&code=${encodeURIComponent('ว30181')}&for=${t.id}`)).text;
  assert.match(page, /ส่งคู่มือรายวิชาแทนครู/);
  assert.ok(page.includes(`name="for_teacher" value="${t.id}"`));
  assert.doesNotMatch(page, /data-need-sig/, 'ไม่ขอลายเซ็นผู้ดูแลระบบ');

  const fields = { doc_type: 'manual', for_teacher: String(t.id), subject_code: 'ว30181', subject_name: 'ทดสอบแทนครู', grade_level: 'ม.4', doc_no: 'วก.9/2569', action: 'submit' };
  const r = await sendForm(a, '/works', fields, [[await pdf(3), 'คู่มือ.pdf']]);
  assert.equal(r.status, 200, r.text);
  const id = Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
  const sub = await db.q.get('SELECT teacher_id, department_id, status, teacher_signature FROM submissions WHERE id = ?', id);
  assert.equal(sub.teacher_id, t.id, 'งานเป็นชื่อครู');
  assert.equal(sub.department_id, t.department_id);
  assert.equal(sub.status, 'pending', 'ส่งแทนแล้ว');
  assert.ok(!sub.teacher_signature, 'ไม่ใส่ลายเซ็นครูแทน');
  const acts = (await db.q.all('SELECT action FROM reviews WHERE submission_id = ? ORDER BY id', id)).map((x) => x.action);
  assert.deepEqual(acts.slice(0, 2), ['proxynew', 'submit']);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'สร้างคู่มือรายวิชา ว30181 แทน%'"));
  // ครูเห็นงานในหน้าของตัวเอง
  const mine = await as('teacher');
  assert.equal((await mine.get(`/s/${id}`)).status, 200);
  // สร้างซ้ำวิชาเดิมไม่ได้
  const again = await sendForm(a, '/works', fields, [[await pdf(3), 'คู่มือ2.pdf']]);
  assert.notEqual(again.status, 200);
  assert.equal(await countOf('ว30181'), 1);
});

test('สร้างงานแทนครู: ครูทำแทนคนอื่นไม่ได้ ปิดสวิตช์แล้วผู้ดูแลก็ทำไม่ได้', async () => {
  const t = await db.q.get("SELECT id FROM users WHERE username = 'teacher'");
  const fields = { doc_type: 'manual', for_teacher: String(t.id), subject_code: 'ว30182', subject_name: 'ทดสอบ', grade_level: 'ม.4', doc_no: 'วก.8/2569', action: 'draft' };
  const other = await as('sci2');
  assert.notEqual((await sendForm(other, '/works', fields, [[await pdf(2), 'ก.pdf']])).status, 200);
  assert.notEqual((await other.get(`/works/new?type=manual&for=${t.id}`)).status, 200);
  await db.setSetting('ff_proxynew', '0');
  try {
    const a = await as('admin');
    assert.notEqual((await sendForm(a, '/works', fields, [[await pdf(2), 'ข.pdf']])).status, 200);
    assert.doesNotMatch((await a.get(`/teaching?u=${t.id}`)).text, /สร้างแทนครู/);
  } finally {
    await db.setSetting('ff_proxynew', '1');
  }
  assert.equal(await countOf('ว30182'), 0);
});
