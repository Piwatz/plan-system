// ทดสอบผ่านเว็บจริง: เปิดทุกหน้าในทุกบทบาท และส่งงานผ่านครบทุกระดับ (ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');

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
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, type: res.headers.get('content-type') || '' };
  }
  get(url) {
    return this.req('GET', url);
  }
  post(url, fields) {
    const body = fields instanceof FormData ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body);
  }
  async login(username) {
    const r = await this.post('/login', { username, password: seed.DEMO_PASSWORD });
    assert.equal(r.status, 302, `เข้าสู่ระบบ ${username} ไม่สำเร็จ`);
    return this;
  }
}

async function as(username) {
  return new Client().login(username);
}

function ok(r, url) {
  assert.equal(r.status, 200, `${url} ได้สถานะ ${r.status}\n${r.text.slice(0, 600)}`);
  assert.ok(!/ReferenceError|TypeError|undefined is not/.test(r.text), `${url} มีข้อผิดพลาดในหน้าเว็บ`);
}

test('หน้าเข้าสู่ระบบและการป้องกันหน้าภายใน', async () => {
  const c = new Client();
  const home = await c.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/login');
  const login = await c.get('/login');
  ok(login, '/login');
  assert.match(login.text, /โหมดทดลอง/);
  const bad = await c.post('/login', { username: 'teacher', password: 'wrong-password' });
  assert.equal(bad.status, 401);
});

test('ทุกหน้าเปิดได้ในทุกบทบาท', async () => {
  const common = ['/', '/my', '/stats', '/profile', '/password', '/notes', '/alerts', '/results', '/pa', '/pa/print?year=2569&inc=memo&inc=eval&inc=summary&inc=results&inc=notes', '/quicksign', '/send', '/teaching'];
  const reviewer = ['/inbox', '/inbox?type=manual', '/inbox?type=note', '/registry', '/registry?type=plan', '/registry?type=note&status=pending', '/registry.csv?type=manual', '/dept'];
  const admin = ['/admin', '/admin/users', '/admin/users/new', '/admin/users/2', '/admin/users-import', '/admin/departments', '/admin/workflow', '/admin/rubric?type=manual', '/admin/rubric?type=plan', '/admin/subjects', '/admin/settings', '/admin/backup', '/admin/features', '/admin/features?tab=prob', '/admin/users/11', '/teaching?u=11', '/admin/teach-import'];
  for (const [user, pages] of [
    ['admin', [...common, ...reviewer, ...admin]],
    ['director', [...common, ...reviewer]],
    ['deputy', [...common, ...reviewer]],
    ['acad', [...common, ...reviewer]],
    ['section', [...common, ...reviewer]],
    ['scihead', [...common, ...reviewer]],
    ['teacher', common],
    ['soc1', common],
  ]) {
    const c = await as(user);
    for (const url of pages) ok(await c.get(url), `${user} ${url}`);
  }
  const t = await as('teacher');
  assert.equal((await t.get('/admin')).status, 403);
  assert.equal((await t.get('/registry')).status, 403);
});

test('เปิดรายละเอียดและหน้าพิมพ์ของงานทุกชิ้นได้', async () => {
  const admin = await as('admin');
  for (const s of (await db.q.all('SELECT id, doc_type FROM submissions'))) {
    ok(await admin.get(`/s/${s.id}`), `/s/${s.id}`);
    ok(await admin.get(`/s/${s.id}/print`), `/s/${s.id}/print`);
    if (s.doc_type !== 'note') ok(await admin.get(`/s/${s.id}/print?doc=eval`), `/s/${s.id}/print?doc=eval`);
    if (s.doc_type === 'plan') ok(await admin.get(`/s/${s.id}/print-notes`), `/s/${s.id}/print-notes`);
  }
  const memo = await admin.get('/s/1/print');
  assert.match(memo.text, /บันทึกข้อความ/);
  assert.match(memo.text, /ขออนุญาตใช้คู่มือรายวิชา/);
  assert.match(memo.text, /ความเห็นของผู้อำนวยการสถานศึกษา/);
  assert.match(memo.text, /มัธยมศึกษาปีที่ 5/);
});

test('ครูต่างกลุ่มสาระเปิดงานของคนอื่นไม่ได้', async () => {
  const other = await as('math2');
  const r = await other.get('/s/1');
  assert.equal(r.status, 404);
  const file = (await db.q.get('SELECT id FROM files WHERE submission_id = 1'));
  assert.equal((await other.get(`/f/${file.id}`)).status, 404);
});

test('ส่งคู่มือพร้อมไฟล์ แล้วผ่านครบ 5 ระดับทางหน้าเว็บ', async () => {
  const t = await as('sci2');
  const fd = new FormData();
  fd.set('doc_type', 'manual');
  fd.set('subject_code', 'ว30101');
  fd.set('subject_name', 'ฟิสิกส์พื้นฐาน');
  fd.set('grade_level', 'ม.4');
  fd.set('action', 'submit');
  fd.set('main_files', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'คู่มือ ทดสอบ.pdf');
  const r = await t.req('POST', '/works', fd, { 'x-requested-with': 'XMLHttpRequest' });
  assert.equal(r.status, 200, r.text);
  const json = JSON.parse(r.text);
  const id = Number(json.redirect.split('/').pop());
  let sub = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
  assert.equal(sub.status, 'pending');
  assert.equal(sub.current_role, 'dept_head');
  const f = (await db.q.get('SELECT * FROM files WHERE submission_id = ?', id));
  assert.equal(f.original_name, 'คู่มือ ทดสอบ.pdf', 'ชื่อไฟล์ภาษาไทยต้องไม่เพี้ยน');
  const dl = await t.get(`/f/${f.id}`);
  assert.equal(dl.status, 200);

  const head = await as('scihead');
  const page = await head.get(`/s/${id}`);
  assert.match(page.text, /แบบประเมินคู่มือรายวิชา/);
  const scores = {};
  for (const it of (await db.q.all("SELECT id FROM rubric_items WHERE doc_type = 'manual' AND is_active = 1"))) scores[`score_${it.id}`] = '4';
  assert.equal((await head.post(`/s/${id}/approve`, { comment: 'ดี' })).status, 302);
  assert.equal((await db.q.get('SELECT current_role FROM submissions WHERE id = ?', id)).current_role, 'dept_head', 'ไม่ให้คะแนนต้องไม่ผ่าน');
  await head.post(`/s/${id}/approve`, { ...scores, comment: 'ดี' });
  sub = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
  assert.equal(sub.score_total, 80);
  assert.equal(sub.current_role, 'section_head');

  for (const u of ['section', 'acad', 'deputy']) await (await as(u)).post(`/s/${id}/approve`, { comment: 'เห็นชอบ' });
  const dir = await as('director');
  await dir.post('/inbox/approve-many', { ids: String(id), comment: 'อนุญาต' });
  sub = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
  assert.equal(sub.status, 'approved');

  const evalPage = await t.get(`/s/${id}/print?doc=eval`);
  assert.match(evalPage.text, /ได้ระดับคุณภาพ <b>ดี<\/b>/);
});

test('ส่งกลับแก้ไขต้องมีเหตุผล และครูแก้แล้วส่งใหม่ได้', async () => {
  const head = await as('scihead');
  const id = (await db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = 'ว21101'")).id;
  await head.post(`/s/${id}/return`, { comment: '' });
  assert.equal((await db.q.get('SELECT status FROM submissions WHERE id = ?', id)).status, 'pending');
  await head.post(`/s/${id}/return`, { comment: 'เพิ่มแผนที่ 5' });
  assert.equal((await db.q.get('SELECT status FROM submissions WHERE id = ?', id)).status, 'returned');
  const t = await as('sci2');
  ok(await t.get(`/s/${id}/edit`), 'edit');
  const fd = new FormData();
  fd.set('subject_code', 'ว21101');
  fd.set('subject_name', 'วิทยาศาสตร์ 1');
  fd.set('grade_level', 'ม.1');
  fd.set('action', 'submit');
  const r = await t.req('POST', `/s/${id}`, fd);
  assert.equal(r.status, 302);
  const s = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
  assert.equal(s.status, 'pending');
  assert.equal(s.current_role, 'dept_head');
});

test('ครูเขียนบันทึกหลังแผนเป็นร่างหลายฉบับ แล้วส่งพร้อมกัน', async () => {
  const t = await as('teacher');
  const planId = (await db.q.get("SELECT id FROM submissions WHERE doc_type = 'plan' AND subject_code = 'ว30203'")).id;
  ok(await t.get(`/notes/new?plan=${planId}`), 'note form');
  const ids = [];
  for (const no of ['6', '7']) {
    const fd = new FormData();
    fd.set('plan_id', String(planId));
    fd.set('plan_no', no);
    fd.set('topic', `เรื่องทดสอบ ${no}`);
    fd.set('result_k', 'นักเรียนเข้าใจ');
    fd.set('action', 'draft');
    const r = await t.req('POST', '/notes', fd);
    assert.equal(r.status, 302);
    ids.push(Number(r.location.split('/').pop()));
  }
  const r = await t.post('/notes/submit-many', new URLSearchParams([...ids.map((i) => ['ids', String(i)]), ['back', `/s/${planId}`]]));
  assert.equal(r.status, 302);
  for (const id of ids) {
    const s = (await db.q.get('SELECT * FROM submissions WHERE id = ?', id));
    assert.equal(s.status, 'pending');
    assert.equal(s.current_role, 'dept_head');
  }
});

test('ส่งออก CSV ภาษาไทยเปิดใน Excel ได้', async () => {
  const admin = await as('admin');
  const r = await fetch(`${base}/registry.csv?type=manual&year=2569&semester=2`, { headers: { cookie: admin.header() } });
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(buf.toString('utf8'), /ครูผู้สอน/);
});
