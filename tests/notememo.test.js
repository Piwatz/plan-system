// ทดสอบบันทึกข้อความส่งบันทึกหลังสอน (ฟังก์ชันเสริม notememo) และเลขที่บันทึกข้อความของเล่ม (notedocno)
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-nmemo-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const notememo = require('../src/notememo');

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
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie } });
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

const planOf = async (code) => (await db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = ?", code)).id;
const notesNo = async (planId) => (await db.q.all("SELECT doc_no FROM submissions WHERE parent_id = ? AND doc_type = 'note'", planId)).map((r) => r.doc_no || '');
const boxCount = (html) => (html.match(/<div class="box (l|r|full)">/g) || []).length;

test('รวมสถานะรายแผ่น: ลายเซ็นขึ้นเมื่อทุกแผ่นผ่านระดับนั้น ความเห็นที่ใช้มากที่สุด', () => {
  const st = (state, review = null) => ({ role: 'dept_head', label: 'หัวหน้า', state, review });
  const rv = (id, at, comment) => ({ id, action: 'approve', created_at: at, comment, signature: 'sig' + id });
  const half = notememo.combineSteps([[st('done', rv(1, '2026-11-01', 'รับทราบ'))], [st('current')]]);
  assert.equal(half[0].review, null, 'ยังไม่ครบทุกแผ่น ไม่ใส่ลายเซ็น');
  const all = notememo.combineSteps([
    [st('done', rv(1, '2026-11-01', 'รับทราบ'))],
    [st('done', rv(2, '2026-11-03', 'ดีมาก'))],
    [st('done', rv(3, '2026-11-02', 'รับทราบ'))],
  ]);
  assert.equal(all[0].review.signature, 'sig2', 'ใช้การลงนามล่าสุด');
  assert.equal(all[0].review.comment, 'รับทราบ', 'ความเห็นที่ใช้มากที่สุด');
  assert.equal(notememo.combineSteps([[st('skipped')], [st('skipped')]])[0].state, 'skipped');
  assert.equal(notememo.bookNo([{ id: 1, doc_no: '', updated_at: '2' }, { id: 2, doc_no: 'วก.5/2569', updated_at: '1' }]), 'วก.5/2569');
  assert.equal(notememo.bookDate([{ submitted_at: '2026-11-02' }, { submitted_at: null }, { submitted_at: '2026-11-05' }]), '2026-11-05');
});

test('พิมพ์บันทึกข้อความส่งบันทึกหลังสอน: ช่องความเห็นตามระดับที่ลงนามบันทึกหลังแผน ปุ่มในการ์ดพิมพ์ ปิดสวิตช์แล้วพิมพ์ไม่ได้', async () => {
  const t = await as('teacher');
  const planId = await planOf('ว30203');
  const r = await t.get(`/s/${planId}/print-notememo`);
  assert.equal(r.status, 200);
  assert.match(r.text, /ขอส่งบันทึกหลังสอน  ภาคเรียนที่ 2 ปีการศึกษา 2569/);
  assert.match(r.text, /บัดนี้ข้าพเจ้าได้จัดการเรียนการสอนเป็นไปด้วยความเรียบร้อยแล้ว/);
  assert.doesNotMatch(r.text, /หน่วยกิต/);
  assert.equal(boxCount(r.text), 3, 'บันทึกหลังแผนลงนาม 3 ระดับ');
  assert.match(r.text, /ความเห็นของหัวหน้ากลุ่มสาระการเรียนรู้/);
  assert.match(r.text, /<div class="box full">\s*<div class="t">ความเห็นของผู้อำนวยการ/);
  assert.doesNotMatch(r.text, /ความเห็นของหัวหน้ากลุ่มบริหารงานวิชาการ/);
  assert.match((await t.get(`/s/${planId}`)).text, new RegExp(`href="/s/${planId}/print-notememo"`));

  // ผู้ดูแลระบบเพิ่มระดับ กระดาษเปลี่ยนตาม
  const admin = await as('admin');
  await db.q.run("UPDATE workflow_steps SET for_note = 1 WHERE role = 'academic_head'");
  db.clearRefs();
  const four = (await t.get(`/s/${planId}/print-notememo`)).text;
  await db.q.run("UPDATE workflow_steps SET for_note = 0 WHERE role = 'academic_head'");
  db.clearRefs();
  assert.equal(boxCount(four), 4);
  assert.match(four, /ความเห็นของหัวหน้ากลุ่มบริหารงานวิชาการ/);
  assert.doesNotMatch(four, /class="box full"/, '4 ช่องเรียง 2 แถว 2 คอลัมน์');

  // ครูคนอื่นเปิดเล่มนี้ไม่ได้
  const other = await as('math2');
  const no = await other.get(`/s/${planId}/print-notememo`);
  assert.notEqual(no.status, 200);

  await admin.post('/admin/features/notememo', { on: '0' });
  const off = await t.get(`/s/${planId}/print-notememo`);
  assert.notEqual(off.status, 200);
  assert.doesNotMatch((await t.get(`/s/${planId}`)).text, /print-notememo/);
  await admin.post('/admin/features/notememo', { on: '1' });
});

test('เลขที่บันทึกข้อความของเล่ม: ปิดอยู่กรอกไม่ได้ เปิดแล้วกรอกครั้งเดียวขึ้นทุกแผ่น แผ่นที่ส่งทีหลังได้เลขเดิม', async () => {
  const t = await as('teacher');
  const admin = await as('admin');
  const planId = await planOf('ว30203');

  await t.post(`/s/${planId}/notememo-no`, { doc_no_num: '125' });
  assert.ok((await notesNo(planId)).every((n) => n === ''), 'สวิตช์เลขปิดอยู่ ต้องไม่บันทึก');

  await admin.post('/admin/features/notedocno', { on: '1' });
  const other = await as('math2');
  await other.post(`/s/${planId}/notememo-no`, { doc_no_num: '9' });
  assert.ok((await notesNo(planId)).every((n) => n === ''), 'ครูคนอื่นกรอกเลขเล่มนี้ไม่ได้');

  const ok = await t.post(`/s/${planId}/notememo-no`, { doc_no_num: '๑๒๕' });
  assert.equal(ok.status, 302);
  assert.ok((await notesNo(planId)).every((n) => n === 'วก.125/2569'), 'เลขไทยแปลงเป็นอารบิก ขึ้นทุกแผ่น');
  assert.match((await t.get(`/s/${planId}/print-notememo`)).text, /<span class="mv1">วก.125\/2569<\/span>/);
  assert.match((await t.get(`/s/${planId}`)).text, /1 ฉบับต่อเล่ม ที่ วก.125\/2569/);

  // แผ่นใหม่ที่เขียนหลังกรอกเลข ได้เลขเดิมตอนส่งทั้งเล่ม
  const one = await db.q.get("SELECT id FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY id LIMIT 1", planId);
  await db.q.run("UPDATE submissions SET doc_no = '' WHERE id = ?", one.id);
  await db.q.run("UPDATE submissions SET doc_no = '' WHERE parent_id = ? AND doc_type = 'note' AND status = 'draft'", planId);
  await t.post(`/s/${planId}/submit-book`, {});
  const drafts = await db.q.all("SELECT doc_no FROM submissions WHERE parent_id = ? AND doc_type = 'note' AND status != 'draft'", planId);
  assert.ok(drafts.every((n) => n.doc_no === 'วก.125/2569'));

  // ผู้ดูแลระบบแก้แทนครูได้ บันทึกประวัติ
  await admin.post(`/s/${planId}/notememo-no`, { doc_no_num: '126' });
  assert.ok((await notesNo(planId)).every((n) => n === 'วก.126/2569'));
  const log = await db.q.get("SELECT * FROM audit_log WHERE action LIKE 'แก้เลขบันทึกข้อความส่งบันทึกหลังสอน%' ORDER BY id DESC LIMIT 1");
  assert.ok(log && log.detail.includes('วก.126/2569'));

  // ลบเลขได้ (ช่องว่าง)
  await t.post(`/s/${planId}/notememo-no`, { doc_no_num: '' });
  assert.ok((await notesNo(planId)).every((n) => n === ''));
  await admin.post('/admin/features/notedocno', { on: '0' });
});

test('แนบไฟล์ 1 ไฟล์ แผนเดียว หลายแผน ทั้งเล่ม (notewhole) เก็บในช่องแผนที่ เลขแผนถัดไปนับต่อจากช่วง ปิดสวิตช์แล้วเป็นแผนเดียว', async () => {
  const planrange = require('../src/planrange');
  assert.equal(planrange.fromForm('9', '1'), '1-9');
  assert.equal(planrange.fromForm('4', '4'), '4');
  assert.equal(planrange.fromForm('', '4'), '');
  assert.deepEqual(planrange.numbers('3-5'), [3, 4, 5]);
  assert.equal(planrange.label('1-9'), 'แผนที่ 1 ถึง 9');
  assert.equal(planrange.label('ทั้งเล่ม'), 'ทั้งเล่ม');

  const t = await as('teacher');
  const planId = await planOf('ว30203');
  const newest = () => db.q.get("SELECT * FROM submissions WHERE parent_id = ? AND doc_type = 'note' ORDER BY id DESC LIMIT 1", planId);
  const base = { plan_id: String(planId), note_mode: 'file', plan_no: '7', unit_no: '2', hours: '2', teach_date: '2026-11-20', action: 'draft' };

  await t.post('/notes', { ...base, plan_scope: 'range', plan_from: '20', plan_to: '13' });
  let n = await newest();
  assert.equal(n.plan_no, '13-20');
  assert.equal(n.unit_no, '');
  assert.equal(n.teach_date, '');
  const form = (await t.get(`/notes/new?plan=${planId}`)).text;
  assert.match(form, /id="plan_no" name="plan_no" value="21"/, 'เลขแผนถัดไปต่อจากช่วง');
  assert.match(form, /name="plan_scope" value="range"/);

  await t.post('/notes', { ...base, plan_scope: 'book' });
  n = await newest();
  assert.equal(n.plan_no, 'ทั้งเล่ม');
  assert.match((await t.get(`/s/${n.id}/edit`)).text, /name="plan_scope" value="book" checked/);

  // พิมพ์ในระบบเป็นแผนเดียวเสมอ
  await t.post('/notes', { ...base, note_mode: 'type', plan_scope: 'book', result_k: 'x' });
  assert.equal((await newest()).plan_no, '7');

  const admin = await as('admin');
  await admin.post('/admin/features/notewhole', { on: '0' });
  await t.post('/notes', { ...base, plan_scope: 'range', plan_from: '1', plan_to: '3' });
  assert.equal((await newest()).plan_no, '7');
  assert.doesNotMatch((await t.get(`/notes/new?plan=${planId}`)).text, /name="plan_scope"/);
  await admin.post('/admin/features/notewhole', { on: '1' });
});
