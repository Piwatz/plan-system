// ทดสอบคลังงานการจัดการเรียนรู้ (ฟังก์ชันเสริม library และ libread) ปกเล็ก โหลดทีละหน้า มุมมองเริ่มต้น แถบหน้าแรก
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lib-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const { formWithFiles, uploadOne, XHR } = require('./upload-client');
const db = require('../src/db');
const wf = require('../src/workflow');

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
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return res;
  }
  async req(method, url, body, headers = {}) {
    const res = await this.raw(method, url, body, headers);
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields, headers) {
    return this.req('POST', url, new URLSearchParams(fields), headers);
  }
}

async function as(username) {
  const c = new Client();
  const r = await c.post('/login', { username, password: seed.DEMO_PASSWORD });
  assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
  return c;
}

const subOf = (type, code, teacher) =>
  db.q.get('SELECT s.* FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type = ? AND s.subject_code = ? AND u.username = ?', type, code, teacher);
const fileOf = async (id) => (await db.q.get('SELECT id FROM files WHERE submission_id = ? AND is_current = 1 ORDER BY id LIMIT 1', id)).id;
const pdf = () => new Blob(['%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'], { type: 'application/pdf' });
const jpg = (n = 2000) => new Blob([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)])]);
const setFlag = (admin, key, on) => admin.post(`/admin/features/${key}`, { on: on ? '1' : '0' });

test('หัวหน้าคลังงานแบบกะทัดรัด (libslim): เปิดมีคำสั้นและปุ่มเครื่องมือของผู้ดูแล ปิดกลับแบบเดิม ครูไม่เห็นเครื่องมือ', async () => {
  const admin = await as('admin');
  const on = (await admin.get('/library?shelf=plan')).text;
  assert.match(on, /class="lib-head slim"/);
  assert.match(on, /lib-s-short">แผน</);
  assert.match(on, /lib-s-short">คู่มือ</);
  assert.match(on, /lib-s-short">บันทึกหลังแผน</);
  assert.match(on, /data-short="\d\/\d{4}"/);
  const teacher = (await db.q.get('SELECT username FROM users WHERE is_admin = 0 AND is_teacher = 1 AND is_active = 1 ORDER BY id LIMIT 1')).username;
  assert.match(on, /href="\/admin\/readperm"/, 'ผู้ดูแลไปหน้าสิทธิ์อ่านงานจากคลังงานได้');
  assert.match((await admin.get('/admin/features')).text, /href="\/admin\/readperm"/);
  const tp = (await (await as(teacher)).get('/library?shelf=plan')).text;
  assert.ok(!tp.includes('data-lib-tools aria-expanded'));
  assert.ok(!tp.includes('/admin/readperm'), 'ครูไม่เห็นลิงก์สิทธิ์อ่านงาน');
  await setFlag(admin, 'libslim', false);
  try {
    const off = (await admin.get('/library?shelf=plan')).text;
    assert.match(off, /class="lib-head"/);
    assert.ok(!off.includes('data-long'));
  } finally {
    await setFlag(admin, 'libslim', true);
  }
});

// ส่งคู่มือใหม่พร้อมรูปปกเล็ก แบบเดียวกับหน้าเว็บ (ช่อง upload_cover_thumb)
async function sendWithCover(client, code, cover, coverName = 'cover.jpg') {
  const fields = { doc_type: 'manual', subject_code: code, subject_name: 'ทดสอบคลัง', grade_level: 'ม.4', action: 'draft' };
  const r = await formWithFiles(client, '/works', fields, [[pdf(), 'คู่มือ.pdf']]);
  const token = await uploadOne(client, cover, coverName, { form: '/works', field: 'cover_thumb', doc_type: 'manual', subject_code: code });
  if (typeof token === 'string') r.fields.append('upload_cover_thumb', token);
  return { res: await client.req('POST', '/works', r.fields, XHR), token };
}

// ให้งานผ่านครบทุกระดับ (ข้ามขั้นตอนตรวจ ทดสอบเฉพาะคลัง)
const finish = (id) => db.q.run("UPDATE submissions SET status = 'approved', \"current_role\" = NULL, completed_at = '2569-10-16 10:00:00' WHERE id = ?", id);

test('ค่าเริ่มต้น: เปิดคลังงาน ปิดอ่านงานของคนอื่น มีเมนูทุกคน', async () => {
  const features = require('../src/features');
  assert.equal(features.BY_KEY.library.on, true);
  assert.equal(features.BY_KEY.libread.on, false);
  const t = await as('teacher');
  const home = (await t.get('/')).text;
  assert.match(home, /href="\/library"/);
  assert.match(home, /คลังงานการจัดการเรียนรู้/);
  const page = await t.get('/library?shelf=manual');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-lib-view="shelf"/);
  assert.match(page.text, /data-lib-view="list"/);
});

test('คลังแสดงเฉพาะงานที่ผ่านครบ เปิดอ่านได้เฉพาะงานตัวเอง ผู้ตรวจเปิดตามสิทธิ์เดิม', async () => {
  const mine = await subOf('manual', 'ว30203', 'teacher');
  const other = await subOf('manual', 'ท21101', 'thai2');
  const pending = await subOf('manual', 'ว30207', 'teacher');
  assert.equal(mine.status, 'approved');
  assert.equal(other.status, 'approved');
  const t = await as('teacher');
  const page = (await t.get('/library?shelf=manual')).text;
  assert.match(page, /ว30203/);
  assert.match(page, /ท21101/);
  assert.doesNotMatch(page, /ว30207/, 'งานที่ยังไม่ผ่านครบไม่อยู่ในคลัง');
  assert.match(page, /ทั้งหมด <b>2<\/b> เล่ม/);
  assert.match(page, new RegExp(`href="/f/${await fileOf(mine.id)}/view"`), 'งานตัวเองเปิดอ่านได้');
  assert.doesNotMatch(page, new RegExp(`href="/f/${await fileOf(other.id)}/view"`), 'งานคนอื่นไม่มีลิงก์เปิดอ่าน');
  assert.match(page, /เปิดอ่านได้เฉพาะเจ้าของ/);
  // เปิดไฟล์ตรง ๆ ก็ไม่ได้
  assert.equal((await t.get(`/f/${await fileOf(other.id)}/view`)).status, 404);
  // หัวหน้ากลุ่มสาระภาษาไทยเปิดงานในกลุ่มตัวเองได้ งานกลุ่มอื่นไม่ได้
  const head = await as('thaihead');
  const hp = (await head.get('/library?shelf=manual')).text;
  assert.match(hp, new RegExp(`href="/f/${await fileOf(other.id)}/view"`));
  assert.doesNotMatch(hp, new RegExp(`href="/f/${await fileOf(mine.id)}/view"`));
  // ผู้ตรวจระดับโรงเรียนเปิดได้ทุกเล่ม
  const dir = (await (await as('director')).get('/library?shelf=manual')).text;
  assert.doesNotMatch(dir, /เปิดอ่านได้เฉพาะเจ้าของ/);
  // ตัวกรองกลุ่มสาระและภาคเรียน
  const thai = await db.q.get("SELECT id FROM departments WHERE name LIKE 'ภาษาไทย%'");
  const f = (await t.get(`/library?shelf=manual&department=${thai.id}`)).text;
  assert.match(f, /ท21101/);
  assert.doesNotMatch(f, /ว30203/);
  assert.match((await t.get('/library?shelf=manual&year=2568&semester=1')).text, /ยังไม่มีคู่มือรายวิชาที่ผ่านครบในภาคเรียนนี้/);
});

test('เปิดสวิตช์อ่านงานของคนอื่นได้: ทุกคนเปิดอ่านงานในคลังได้ แต่งานที่ยังไม่ผ่านยังเปิดไม่ได้', async () => {
  const admin = await as('admin');
  const other = await subOf('manual', 'ท21101', 'thai2');
  const pending = await subOf('manual', 'อ21101', 'eng2');
  const t = await as('teacher');
  await setFlag(admin, 'libread', true);
  try {
    const page = (await t.get('/library?shelf=manual')).text;
    assert.doesNotMatch(page, /เปิดอ่านได้เฉพาะเจ้าของ/);
    assert.equal((await t.get(`/f/${await fileOf(other.id)}/view`)).status, 200);
    assert.equal((await t.raw('GET', `/f/${await fileOf(other.id)}/raw`)).status, 200);
    assert.equal((await t.get(`/f/${await fileOf(pending.id)}/view`)).status, 404, 'งานที่ยังไม่ผ่านครบเปิดไม่ได้');
    assert.equal((await t.get(`/s/${other.id}`)).status, 404, 'หน้ารายละเอียดและคะแนนยังเปิดไม่ได้');
  } finally {
    await setFlag(admin, 'libread', false);
  }
  assert.equal((await t.get(`/f/${await fileOf(other.id)}/view`)).status, 404);
});

test('ชั้นบันทึกหลังแผน: 1 เล่มต่อวิชา เข้าคลังเมื่อทุกฉบับที่ส่งแล้วผ่านครบ', async () => {
  const plan = await subOf('plan', 'ว21101', 'sci2');
  const t = await as('teacher');
  const before = (await t.get('/library?shelf=note')).text;
  assert.doesNotMatch(before, /ว21101/, 'มีฉบับที่ยังรอตรวจ ยังไม่เข้าคลัง');
  await db.q.run("UPDATE submissions SET status = 'approved', completed_at = '2569-10-16 11:00:00' WHERE parent_id = ? AND doc_type = 'note' AND status != 'draft'", plan.id);
  const page = (await t.get('/library?shelf=note')).text;
  assert.match(page, /ว21101/);
  assert.match(page, /1 แผ่น/);
  assert.match(page, /lib-cover drawn/, 'บันทึกหลังแผนใช้ปกที่ระบบวาด');
  // ครูเจ้าของเปิดทั้งเล่มได้ ครูคนอื่นเปิดได้เมื่อเปิดสวิตช์อ่านงานของคนอื่น
  const owner = await as('sci2');
  assert.match((await owner.get('/library?shelf=note')).text, new RegExp(`href="/s/${plan.id}/print-notes"`));
  assert.equal((await t.get(`/s/${plan.id}/print-notes`)).status, 404);
  const admin = await as('admin');
  await setFlag(admin, 'libread', true);
  try {
    assert.equal((await t.get(`/s/${plan.id}/print-notes`)).status, 200);
  } finally {
    await setFlag(admin, 'libread', false);
  }
});

test('โหลดทีละ 24 เล่ม ปุ่มโหลดเพิ่มได้เฉพาะเล่มชุดถัดไป', async () => {
  const u = await db.q.get("SELECT id, department_id FROM users WHERE username = 'math2'");
  for (let i = 0; i < 30; i++) {
    await db.q.run(
      `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name, status, created_at, updated_at, completed_at)
       VALUES ('plan', ?, ?, 2568, 2, ?, 'วิชาทดลองคลัง', 'approved', '2568-10-01 00:00:00', '2568-10-01 00:00:00', '2568-10-01 00:00:00')`,
      u.id,
      u.department_id,
      `ค9${String(i).padStart(4, '0')}`
    );
  }
  const t = await as('teacher');
  const page = (await t.get('/library?shelf=plan&year=2568&semester=2')).text;
  assert.equal((page.match(/<article class="lib-book">/g) || []).length, 24);
  assert.match(page, /ทั้งหมด <b>30<\/b> เล่ม/);
  assert.match(page, /โหลดเพิ่มอีก 6 เล่ม/);
  const href = /href="([^"]+)" data-lib-more/.exec(page)[1].replace(/&amp;/g, '&');
  const part = await t.get(href + '&part=1');
  assert.equal(part.status, 200);
  assert.equal((part.text.match(/<article class="lib-book">/g) || []).length, 6);
  assert.doesNotMatch(part.text, /<html/, 'ส่งกลับเฉพาะเล่มชุดถัดไป');
  assert.equal(part.headers.get('x-lib-next'), '');
  assert.match(part.text, /ค90029/);
});

test('มุมมองตามกลุ่มสาระ: กลุ่มละ 1 แถว หัวแถวมีลิงก์ ดูทั้งหมด N เล่ม = กรองกลุ่มสาระนั้น', async () => {
  const features = require('../src/features');
  assert.ok(features.LIBRARY_VIEWS.some((v) => v.key === 'group'));
  const t = await as('teacher');
  const page = (await t.get('/library?shelf=manual')).text;
  assert.match(page, /data-lib-view="group"/);
  assert.match(page, /'shelf','list','group'/, 'สคริปต์เลือกมุมมองรู้จักแบบใหม่');
  const s = (await db.q.get("SELECT value FROM settings WHERE key = 'academic_year'")).value;
  const sem = (await db.q.get("SELECT value FROM settings WHERE key = 'semester'")).value;
  const counts = await db.q.all(
    "SELECT department_id, COUNT(*)::int AS n FROM submissions WHERE doc_type = 'manual' AND status = 'approved' AND academic_year = ? AND semester = ? GROUP BY department_id",
    s,
    sem
  );
  assert.ok(counts.length >= 2, 'ข้อมูลทดลองมีหลายกลุ่มสาระ');
  const heads = [...page.matchAll(/<section class="lib-grp" data-dept="(\d*)">/g)].map((m) => m[1]);
  assert.equal(heads.length, counts.length, 'กลุ่มสาระละ 1 แถว');
  assert.equal(new Set(heads).size, heads.length, 'ไม่มีกลุ่มซ้ำ');
  for (const c of counts) {
    if (!c.department_id) continue;
    const m = new RegExp(String.raw`href="/library\?shelf=manual&amp;year=${s}&amp;semester=${sem}&amp;department=${c.department_id}">ดูทั้งหมด (\d+) เล่ม`).exec(page);
    assert.ok(m, `มีลิงก์ดูทั้งหมดของกลุ่ม ${c.department_id}`);
    assert.equal(Number(m[1]), c.n);
  }
  // กรองกลุ่มเดียวแล้ว: ไม่มีลิงก์ดูทั้งหมดซ้ำ แถวขึ้นบรรทัดใหม่ (data-one)
  const one = (await t.get(`/library?shelf=manual&department=${counts.find((c) => c.department_id).department_id}`)).text;
  assert.match(one, /data-lib data-default="[^"]*" data-view="shelf" data-one>/);
  assert.doesNotMatch(one, /ดูทั้งหมด \d+ เล่ม/);
  assert.equal((one.match(/<section class="lib-grp"/g) || []).length, 1);
  assert.doesNotMatch(page, /data-one/);
});

test('มุมมองตามกลุ่มสาระ: โหลดเพิ่มกลุ่มเดิมนับจำนวนทั้งกลุ่ม ผู้ดูแลตั้งเป็นแบบเริ่มต้นได้', async () => {
  const t = await as('teacher');
  const page = (await t.get('/library?shelf=plan&year=2568&semester=2')).text;
  const dept = (await db.q.get("SELECT department_id FROM users WHERE username = 'math2'")).department_id;
  assert.match(page, new RegExp(`department=${dept}">ดูทั้งหมด 30 เล่ม`), 'นับทั้งกลุ่ม ไม่ใช่เฉพาะหน้านี้');
  const href = /href="([^"]+)" data-lib-more/.exec(page)[1].replace(/&amp;/g, '&');
  const part = (await t.get(href + '&part=1')).text;
  assert.match(part, new RegExp(`<section class="lib-grp" data-dept="${dept}">`), 'ชุดถัดไปบอกกลุ่มสาระ หน้าเว็บต่อแถวเดิมได้');
  assert.match(part, /data-lib-row/);
  const admin = await as('admin');
  assert.match((await admin.get('/admin/features')).text, /name="view" value="group"/);
  await admin.post('/admin/libview', { view: 'group' });
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'ตั้งมุมมองเริ่มต้นของคลังงาน ตามกลุ่มสาระ'"));
  assert.match((await t.get('/library?shelf=manual')).text, /data-default="group"/);
  await admin.post('/admin/libview', { view: '' });
});

test('ปกเล็กตอนครูส่งงาน: เก็บที่ช่องอ้างอิง เห็นในคลังเมื่อผ่านครบ เบราว์เซอร์จำรูปได้นาน', async () => {
  const t = await as('teacher');
  const { res } = await sendWithCover(t, 'ว31101', jpg());
  assert.equal(res.status, 200, res.text);
  const sub = await subOf('manual', 'ว31101', 'teacher');
  assert.ok(sub.cover_ref, 'มีรูปปก');
  assert.equal((await db.q.get('SELECT COUNT(*)::int AS n FROM files WHERE submission_id = ?', sub.id)).n, 1, 'รูปปกไม่ปนกับไฟล์งาน');
  // ยังไม่ผ่านครบ ยังไม่เห็นในคลังและเปิดรูปไม่ได้
  assert.equal((await t.raw('GET', `/library/cover/${sub.id}`)).status, 404);
  await finish(sub.id);
  const page = (await t.get('/library?shelf=manual')).text;
  const src = new RegExp(`src="(/library/cover/${sub.id}\\?v=[0-9a-f]{8})" alt="" loading="lazy"`).exec(page);
  assert.ok(src, 'รูปปกโหลดเมื่อเลื่อนถึง');
  const other = await as('eng2');
  const img = await other.raw('GET', src[1]);
  assert.equal(img.status, 200, 'ทุกคนเห็นปก');
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /max-age=31536000/);
});

test('ปกเล็กใช้ไม่ได้ (ไม่ใช่ JPEG หรือใหญ่เกิน) ระบบไม่รับรูป แต่ส่งงานได้ตามปกติ', async () => {
  const t = await as('teacher');
  const fake = await sendWithCover(t, 'ว22201', new Blob(['%PDF-1.4 ไม่ใช่รูป']), 'cover.jpg');
  assert.equal(fake.res.status, 200, fake.res.text);
  const sub = await subOf('manual', 'ว22201', 'teacher');
  assert.ok(sub, 'ส่งงานได้');
  assert.equal(sub.cover_ref, null);
  const big = await uploadOne(t, jpg(400 * 1024), 'cover.jpg', { form: '/works', field: 'cover_thumb', doc_type: 'manual', subject_code: 'ว22202' });
  assert.equal(big.status, 400, 'รูปปกใหญ่เกิน 300 KB ไม่รับตั้งแต่เริ่มส่ง');
});

test('ผู้ดูแลระบบสร้างปกงานเดิม: รายการงานที่ยังไม่มีปก ส่งรูปทีละเล่ม จดประวัติ', async () => {
  const t = await as('teacher');
  assert.equal((await t.get('/library/covers/todo')).status, 403);
  const admin = await as('admin');
  const page = (await admin.get('/library?shelf=manual')).text;
  assert.match(page, /สร้างปกงานเดิม \d+ เล่ม/);
  assert.match(page, /data-covers data-confirm=/);
  const todo = JSON.parse((await admin.get('/library/covers/todo')).text).items;
  const other = await subOf('manual', 'ท21101', 'thai2');
  const it = todo.find((x) => x.id === other.id);
  assert.ok(it && it.file, 'งานเดิมที่ยังไม่มีปกอยู่ในรายการพร้อมไฟล์ PDF');
  const url = `/library/cover/${other.id}`;
  const token = await uploadOne(admin, jpg(), 'cover.jpg', { form: url, field: 'cover_thumb' });
  assert.equal(typeof token, 'string');
  // ครูส่งรูปแทนผู้ดูแลไม่ได้
  assert.equal((await uploadOne(t, jpg(), 'cover.jpg', { form: url, field: 'cover_thumb' })).status, 400);
  const r = await admin.post(url, { upload_cover_thumb: token }, XHR);
  assert.equal(r.status, 200, r.text);
  assert.ok((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', other.id)).cover_ref);
  assert.ok(!JSON.parse((await admin.get('/library/covers/todo')).text).items.some((x) => x.id === other.id));
  await admin.post('/library/covers/done', { n: '1' }, XHR);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'สร้างปกงานเดิมในคลังงาน 1 เล่ม'"));
});

test('ตั้งมุมมองเริ่มต้นของคลังในหน้าฟังก์ชันเสริม บันทึกประวัติ เฉพาะผู้ดูแลระบบ', async () => {
  const admin = await as('admin');
  const fp = (await admin.get('/admin/features')).text;
  assert.match(fp, /id="libview"/);
  assert.match(fp, /action="\/admin\/libview" data-confirm=/);
  await admin.post('/admin/libview', { view: 'list' });
  assert.equal((await db.q.get("SELECT value FROM settings WHERE key = 'library_view'")).value, 'list');
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'ตั้งมุมมองเริ่มต้นของคลังงาน รายการ'"));
  const t = await as('teacher');
  assert.match((await t.get('/library?shelf=manual')).text, /data-default="list"/);
  await admin.post('/admin/libview', { view: 'bogus' });
  assert.equal((await db.q.get("SELECT value FROM settings WHERE key = 'library_view'")).value, 'list', 'ค่าที่ไม่รู้จักไม่บันทึก');
  const no = await t.post('/admin/libview', { view: 'shelf' });
  assert.notEqual(no.status, 200);
  assert.equal((await db.q.get("SELECT value FROM settings WHERE key = 'library_view'")).value, 'list');
  await admin.post('/admin/libview', { view: '' });
  assert.match((await t.get('/library?shelf=manual')).text, /data-default=""/);
});

test('ปกที่ระบบวาดแบบใหม่: ค่าเริ่มต้นแบบ ง สีตามชนิดงาน มีตรา ระดับชั้น ภาคเรียน ผู้ดูแลเลือกแบบได้ ปิดแล้วกลับเป็นแบบเดิม', async () => {
  const library = require('../src/library');
  assert.equal(library.gradeText('ม.5'), 'ชั้นมัธยมศึกษาปีที่ 5');
  assert.equal(library.gradeText('ป 3'), 'ชั้นประถมศึกษาปีที่ 3');
  assert.equal(library.gradeText('ม.4/1'), 'ชั้น ม.4/1');
  assert.equal(library.gradeText(''), '');
  assert.equal(library.termText({ academic_year: '2569', semester: 2 }), 'ภาคเรียนที่ 2 ปีการศึกษา 2569');
  const t = await as('teacher');
  const page = (await t.get('/library?shelf=note')).text;
  assert.match(page, /lib-cover drawn cv cv-d k-note/);
  assert.match(page, /class="cv-logo"><img src="[^"]*school-logo/);
  assert.match(page, /ภาคเรียนที่ \d ปีการศึกษา \d{4}/);
  const admin = await as('admin');
  const fp = (await admin.get('/admin/features')).text;
  assert.match(fp, /id="coverstyle"/);
  assert.match(fp, /action="\/admin\/coverstyle" data-confirm=/);
  assert.equal((fp.match(/name="style" value="[a-d]"/g) || []).length, 4);
  assert.match(fp, /name="style" value="d" checked/);
  await admin.post('/admin/coverstyle', { style: 'c' });
  assert.match((await t.get('/library?shelf=note')).text, /cv cv-c k-note/);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ตั้งแบบปกที่ระบบวาด แบบ ค%'"));
  await admin.post('/admin/coverstyle', { style: 'z' });
  assert.equal((await db.q.get("SELECT value FROM settings WHERE key = 'cover_style'")).value, 'c', 'ค่าที่ไม่รู้จักไม่บันทึก');
  assert.notEqual((await t.post('/admin/coverstyle', { style: 'a' })).status, 200);
  assert.equal((await db.q.get("SELECT value FROM settings WHERE key = 'cover_style'")).value, 'c');
  await setFlag(admin, 'coverstyle', false);
  try {
    const old = (await t.get('/library?shelf=note')).text;
    assert.match(old, /class="lib-cover drawn">/);
    assert.doesNotMatch(old, /cv-logo/);
  } finally {
    await setFlag(admin, 'coverstyle', true);
    await admin.post('/admin/coverstyle', { style: 'd' });
  }
});

test('เลือกงานที่แสดงในคลัง 3 ชั้น: ค่าหลัก รายครู รายเล่ม ผู้ดูแลเห็นเล่มที่ซ่อนอยู่ ปิดฟังก์ชันกลับเป็นแบบเดิม (libshow)', async () => {
  const pend = await db.q.get(
    "SELECT s.id, s.subject_code, s.teacher_id, s.academic_year, s.semester, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type = 'manual' AND s.status = 'pending' ORDER BY s.id LIMIT 1"
  );
  assert.ok(pend, 'ข้อมูลทดลองมีคู่มือที่รอลงนาม');
  const other = await db.q.get("SELECT username FROM users WHERE is_teacher = 1 AND is_admin = 0 AND id != ? AND username != 'admin' ORDER BY id LIMIT 1", pend.teacher_id);
  const url = `/library?shelf=manual&year=${pend.academic_year}&semester=${pend.semester}`;
  const card = new RegExp(`value="manual:${pend.id}"|${pend.subject_code}`);
  const t = await as(other.username);
  const admin = await as('admin');
  const setting = async (k) => ((await db.q.get('SELECT value FROM settings WHERE key = ?', k)) || {}).value;
  try {
    assert.doesNotMatch((await t.get(url)).text, card, 'ค่าเริ่มต้น เฉพาะงานที่ผ่านครบ');
    const fp = (await admin.get('/admin/features')).text;
    assert.match(fp, /id="libshow"/);
    assert.match(fp, /action="\/admin\/libshow" data-confirm=/);
    assert.match(fp, new RegExp(`name="t_${pend.teacher_id}" value="auto" checked`));
    // ชั้น 1 ค่าหลัก ส่งแล้วทุกงาน
    await admin.post('/admin/libshow', { mode: 'sent' });
    let page = (await t.get(url)).text;
    assert.match(page, card);
    assert.match(page, /badge badge-amber">รอลงนาม \d จาก \d/);
    assert.doesNotMatch(page, /lib-show-/, 'ครูไม่เห็นปุ่มซ่อนเล่ม');
    assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action LIKE 'ตั้งงานที่แสดงในคลังงาน งานที่ส่งแล้วทุกงาน%'"));
    // ชั้น 2 รายครู ซ่อนครูคนนี้ แม้ค่าหลักแสดงทุกงาน
    await admin.post('/admin/libshow', { mode: 'sent', [`t_${pend.teacher_id}`]: 'hide' });
    assert.doesNotMatch((await t.get(url)).text, card);
    // ค่าหลักกลับเป็นผ่านครบ แต่ครูคนนี้แสดงทุกงาน
    await admin.post('/admin/libshow', { mode: 'approved', [`t_${pend.teacher_id}`]: 'show' });
    assert.match((await t.get(url)).text, card);
    assert.equal(await setting('lib_show_teachers'), JSON.stringify({ [pend.teacher_id]: 'show' }));
    // ชั้น 3 รายเล่ม ซ่อนเล่มนี้ ผู้ดูแลเปิด เห็นเล่มที่ซ่อนอยู่ แล้วกดแสดงกลับ ข้อยกเว้นถูกลบทิ้ง
    const back = `${url}&hidden=1`;
    assert.match((await admin.get(url)).text, new RegExp(`form="lib-show-hide" name="key" value="manual:${pend.id}"`));
    await admin.post('/library/show', { key: `manual:${pend.id}`, want: 'hide', back });
    assert.doesNotMatch((await t.get(url)).text, card);
    assert.doesNotMatch((await admin.get(url)).text, new RegExp(`value="manual:${pend.id}"`));
    const seeAll = (await admin.get(back)).text;
    assert.match(seeAll, /lib-book is-hidden/);
    assert.match(seeAll, /ซ่อนอยู่ ซ่อนเล่มนี้ไว้/);
    assert.match(seeAll, new RegExp(`form="lib-show-show" name="key" value="manual:${pend.id}"`));
    await admin.post('/library/show', { key: `manual:${pend.id}`, want: 'show', back });
    assert.equal(await setting('lib_show_books'), '{}', 'กลับเป็นตามรายครูแล้ว ไม่ต้องจำข้อยกเว้น');
    assert.match((await t.get(url)).text, card);
    // ครูกดซ่อนเล่มไม่ได้ ค่าที่ไม่รู้จักไม่บันทึก
    await t.post('/library/show', { key: `manual:${pend.id}`, want: 'hide' });
    assert.equal(await setting('lib_show_books'), '{}');
    assert.notEqual((await t.post('/admin/libshow', { mode: 'sent' })).status, 200);
    await admin.post('/admin/libshow', { mode: 'bogus' });
    assert.equal(await setting('lib_show'), 'approved');
    // ปิดฟังก์ชัน กลับเป็นเฉพาะงานที่ผ่านครบ ไม่สนรายครู
    await setFlag(admin, 'libshow', false);
    assert.doesNotMatch((await t.get(url)).text, card);
    await setFlag(admin, 'libshow', true);
  } finally {
    await db.q.run("DELETE FROM settings WHERE key IN ('lib_show', 'lib_show_teachers', 'lib_show_books')");
    await setFlag(admin, 'libshow', true);
  }
});

test('หน้าแรกมีแถบเล่มใหม่ในคลัง และปิดคลังแล้วไม่มีเมนู หน้า แถบ และรูปปกตอนส่งงาน', async () => {
  const t = await as('teacher');
  const home = (await t.get('/')).text;
  assert.match(home, /เล่มใหม่ในคลัง/);
  // เลื่อนดูได้ (libslide): บนคอมและมือถืออย่างละไม่เกิน 20 เล่ม
  assert.ok((home.match(/class="lib-mini"/g) || []).length <= 40);
  assert.match((await t.get('/works/new?type=manual')).text, /data-thumb/);
  const admin = await as('admin');
  await setFlag(admin, 'library', false);
  try {
    assert.equal((await t.get('/library')).status, 404);
    const off = (await t.get('/')).text;
    assert.doesNotMatch(off, /href="\/library"/);
    assert.doesNotMatch(off, /เล่มใหม่ในคลัง/);
    assert.doesNotMatch((await t.get('/works/new?type=manual')).text, /data-thumb/);
    const sub = await subOf('manual', 'ว30203', 'teacher');
    assert.equal((await t.raw('GET', `/library/cover/${sub.id}`)).status, 404);
  } finally {
    await setFlag(admin, 'library', true);
  }
});

test('คำสั่งของคลัง: ทุกชั้นคืนคอลัมน์ชุดเดียวกัน เล่มใหม่ล่าสุดรวมทุกชั้น', async () => {
  const library = require('../src/library');
  await db.ensureRefs();
  const rows = await library.recent(6);
  assert.ok(rows.length > 0 && rows.length <= 6);
  for (let i = 1; i < rows.length; i++) assert.ok(String(rows[i - 1].done_at || '') >= String(rows[i].done_at || ''), 'เรียงใหม่ก่อน');
  assert.deepEqual(library.SHELVES.map((s) => s.key), ['plan', 'manual', 'note']);
  assert.equal(wf.DOC_TYPES.plan.label, library.SHELF.plan.label);
});

test('ผู้ดูแลระบบเปลี่ยนเล่มเป็นปกที่ระบบวาด ทีละเล่มหรือหลายเล่ม แล้วกลับไปใช้รูปจากไฟล์ได้ (coverswap)', async () => {
  const admin = await as('admin');
  const t = await as('teacher');
  // 2 เล่มแรกในชั้นคู่มือของภาคปัจจุบัน (อยู่ในหน้าแรกของคลังแน่นอน)
  const library = require('../src/library');
  await db.ensureRefs();
  const cur = await db.q.all("SELECT key, value FROM settings WHERE key IN ('academic_year', 'semester')");
  const term = Object.fromEntries(cur.map((r) => [r.key === 'academic_year' ? 'year' : 'semester', Number(r.value)]));
  const subs = (await library.page('manual', { term })).rows.slice(0, 2).map((r) => ({ ...r, academic_year: term.year, semester: term.semester }));
  assert.equal(subs.length, 2);
  const [a, b] = subs;
  // ใส่รูปปกจากไฟล์ให้เล่ม a ก่อน (แบบปุ่ม สร้างปกงานเดิม)
  const put = async (id) => {
    const url = `/library/cover/${id}`;
    const token = await uploadOne(admin, jpg(), 'cover.jpg', { form: url, field: 'cover_thumb' });
    assert.equal((await admin.post(url, { upload_cover_thumb: token }, XHR)).status, 200);
  };
  await put(a.id);
  const qs = `shelf=manual&year=${a.academic_year}&semester=${a.semester}`;
  const page = (await admin.get(`/library?${qs}`)).text;
  assert.match(page, /data-swapbar/);
  assert.match(page, /data-swap="one"/);
  assert.match(page, new RegExp(`form="lib-drawn1" name="ids" value="${a.id}" data-confirm=`));
  assert.match(page, /id="lib-drawn" method="post" action="\/library\/covers\/drawn"/);
  assert.match(page, /data-swap-go="drawn" data-confirm=/);
  assert.match(page, new RegExp(`/library/cover/${a.id}\\?v=`));
  // ครูไม่เห็นปุ่ม และเปลี่ยนเองไม่ได้
  const tp = (await t.get(`/library?${qs}`)).text;
  assert.doesNotMatch(tp, /data-swapbar|lib-swap|lib-ck/);
  await t.post('/library/covers/drawn', { ids: String(a.id) });
  const keep = (await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', a.id)).cover_ref;
  assert.ok(keep && keep !== 'drawn');
  // ทีละเล่ม: ปกระบบวาด รูปปกเดิมเปิดไม่ได้แล้ว ไม่อยู่ในรายการสร้างปกงานเดิม
  const back = `/library?${qs}`;
  const r = await admin.post('/library/covers/drawn', { ids: String(a.id), back });
  assert.equal(r.status, 302);
  assert.equal(r.location, back);
  assert.equal((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', a.id)).cover_ref, 'drawn');
  assert.equal((await admin.raw('GET', `/library/cover/${a.id}`)).status, 404);
  assert.ok(!JSON.parse((await admin.get('/library/covers/todo')).text).items.some((x) => x.id === a.id));
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'เปลี่ยนปกในคลังงานเป็นปกที่ระบบวาด 1 เล่ม' AND detail = ?", a.subject_code));
  const after = (await admin.get(`/library?${qs}`)).text;
  assert.doesNotMatch(after, new RegExp(`/library/cover/${a.id}\\?v=`));
  assert.match(after, new RegExp(`data-cover-file="${a.id}" data-file="\\d+"`));
  // หลายเล่มพร้อมกัน: a เป็นปกระบบอยู่แล้วไม่นับซ้ำ งานที่ไม่ใช่แผนหรือคู่มือไม่เปลี่ยน
  const note = await db.q.get("SELECT id, cover_ref FROM submissions WHERE doc_type = 'note' LIMIT 1");
  await admin.req('POST', '/library/covers/drawn', new URLSearchParams([['ids', String(a.id)], ['ids', String(b.id)], ...(note ? [['ids', String(note.id)]] : []), ['back', 'https://evil.example/']]));
  assert.equal((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', b.id)).cover_ref, 'drawn');
  if (note) assert.equal((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', note.id)).cover_ref, note.cover_ref);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'เปลี่ยนปกในคลังงานเป็นปกที่ระบบวาด 1 เล่ม' AND detail = ?", b.subject_code));
  // กลับไปใช้รูปจากไฟล์: เครื่องผู้ดูแลส่งรูปใหม่เข้ามา แล้วจดประวัติ
  await put(a.id);
  const ref = (await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', a.id)).cover_ref;
  assert.ok(ref && ref !== 'drawn');
  await admin.post('/library/covers/done', { n: '1', what: 'file', codes: a.subject_code }, XHR);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action = 'เปลี่ยนปกในคลังงานกลับเป็นรูปจากไฟล์ 1 เล่ม' AND detail = ?", a.subject_code));
  assert.equal((await admin.raw('GET', `/library/cover/${a.id}`)).status, 200);
  // ปิดสวิตช์: ไม่มีปุ่ม เปลี่ยนไม่ได้ เล่มที่เปลี่ยนไว้ยังเป็นปกระบบ
  await setFlag(admin, 'coverswap', false);
  try {
    assert.doesNotMatch((await admin.get(`/library?${qs}`)).text, /data-swapbar|lib-swap/);
    await admin.post('/library/covers/drawn', { ids: String(a.id) });
    assert.notEqual((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', a.id)).cover_ref, 'drawn');
    assert.equal((await db.q.get('SELECT cover_ref FROM submissions WHERE id = ?', b.id)).cover_ref, 'drawn');
  } finally {
    await setFlag(admin, 'coverswap', true);
  }
});

test('หน้าส่งแผนและคู่มือมีหมายเหตุ ต้องมีหน้าปกและเนื้อหา หน้าแรกจะเป็นปกในคลังงาน', async () => {
  // หน้าแก้ไขงานฉบับร่างหรือถูกส่งกลับ ใช้ฟอร์มเดียวกับหน้าส่งงานใหม่
  for (const type of ['plan', 'manual']) {
    const s = await db.q.get("SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.doc_type = ? AND s.status IN ('draft', 'returned') ORDER BY s.id LIMIT 1", type);
    assert.ok(s, `มี${type}ฉบับร่างในข้อมูลทดลอง`);
    const html = (await (await as(s.username)).get(`/s/${s.id}/edit`)).text;
    assert.match(html, /ไฟล์ต้องมี<b>หน้าปกและเนื้อหา<\/b>/, type);
    assert.match(html, /หน้าแรกจะเป็นปกในคลังงาน/, type);
    assert.match(html, /ภาพนี้จะเป็นปกในคลังงาน/, type);
    assert.doesNotMatch(html, /ใช้ปกระบบ|ใช้ปกที่ระบบวาด/, 'ครูไม่มีตัวเลือกใช้ปกที่ระบบวาด');
  }
});

test('แถบคลังงานแบบงานเด่น: ค่าเริ่มต้นแบบเดิม ติ๊กแล้วขึ้นตามลำดับ เล่มที่ซ่อนหลุดเอง ปิดสวิตช์กลับแบบเดิม (libfeature)', async () => {
  const library = require('../src/library');
  const admin = await as('admin');
  const t = await as('teacher');
  assert.deepEqual(library.parseFeatured('["plan:1","plan:1","x:2",3,"note:5"]'), ['plan:1', 'note:5']);
  assert.deepEqual(library.parseFeatured('เสีย'), []);
  assert.equal(library.deptShort('กลุ่มสาระการเรียนรู้สุขศึกษาและพลศึกษา'), 'สุขศึกษา');
  assert.equal(library.deptShort('วิทยาศาสตร์และเทคโนโลยี'), 'วิทยาศาสตร์');

  let home = (await t.get('/')).text;
  assert.match(home, /เล่มใหม่ในคลัง/);
  assert.doesNotMatch(home, /class="lib-sbs"/);

  // ครูเข้าหน้าตั้งค่าไม่ได้ ผู้ดูแลเข้าได้ ปุ่มบันทึกมีป๊อปยืนยัน
  assert.notEqual((await t.get('/admin/libfeature')).status, 200);
  const page = await admin.get('/admin/libfeature');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-lib-pick[^>]*data-confirm=/);
  const keys = [...page.text.matchAll(/class="lf-item" data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, 'ข้อมูลทดลองต้องมีอย่างน้อย 2 เล่ม');
  const picks = [keys[1], keys[0]];
  try {
    // ติ๊กเล่มที่ 2 ก่อนเล่มที่ 1 ลำดับต้องตามที่ติ๊ก ไม่ใช่ตามวันที่ รหัสเสียถูกทิ้ง
    assert.equal((await admin.post('/admin/libfeature', { lib_strip_mode: 'featured', lib_featured: JSON.stringify([...picks, 'plan:abc']) })).status, 302);
    home = (await t.get('/')).text;
    assert.doesNotMatch(home, /เล่มใหม่ในคลัง/);
    assert.match(home, /คลังงานการจัดการเรียนรู้<\/h2>/);
    assert.equal((home.match(/class="lib-sb"/g) || []).length, 6, 'ปุ่มเมนู 3 ชั้น ทั้งคอมและมือถือ');
    assert.equal((home.match(/class="lib-mini"/g) || []).length, 4, 'งานเด่น 2 เล่ม ทั้งคอมและมือถือ');
    const rows = await library.books(library.showRule({}), picks);
    assert.deepEqual(rows.map((r) => r.bkey), picks);
    assert.ok((await admin.get('/admin/libfeature')).text.includes(JSON.stringify(picks).replace(/"/g, '&#34;')));

    // เล่มที่ถูกซ่อนหลุดจากแถบเอง
    await db.setSetting('lib_show_books', JSON.stringify({ [picks[0]]: 'hide' }));
    assert.equal(((await t.get('/')).text.match(/class="lib-mini"/g) || []).length, 2);
    await db.setSetting('lib_show_books', '{}');

    // ยังไม่ได้ติ๊กเลย เหลือปุ่มเมนู ไม่มีปก
    await admin.post('/admin/libfeature', { lib_strip_mode: 'featured', lib_featured: '[]' });
    home = (await t.get('/')).text;
    assert.match(home, /class="lib-sbs"/);
    assert.doesNotMatch(home, /class="lib-mini"/);

    // ปิดสวิตช์ กลับเป็นเล่มใหม่ในคลัง และเข้าหน้าตั้งค่าไม่ได้
    await setFlag(admin, 'libfeature', false);
    home = (await t.get('/')).text;
    assert.match(home, /เล่มใหม่ในคลัง/);
    assert.equal((await admin.get('/admin/libfeature')).status, 302);
  } finally {
    await setFlag(admin, 'libfeature', true);
    await db.setSetting('lib_show_books', '{}');
    await admin.post('/admin/libfeature', { lib_strip_mode: 'recent', lib_featured: '[]' });
  }
});

test('เลื่อนดูปกในหน้าแรก: เปิดมีลูกศรและกล่องดูทั้งหมด ปิดกลับเป็นแถวเดิม (libslide)', async () => {
  const admin = await as('admin');
  const t = await as('teacher');
  const on = (await t.get('/')).text;
  assert.match(on, /lib-slide/);
  assert.match(on, /data-lib-arrow="1"/);
  assert.match(on, /lib-end/);
  await setFlag(admin, 'libslide', false);
  try {
    const off = (await t.get('/')).text;
    assert.doesNotMatch(off, /lib-slide|data-lib-arrow|lib-end/);
    assert.match(off, /เล่มใหม่ในคลัง/);
  } finally {
    await setFlag(admin, 'libslide', true);
  }
});
