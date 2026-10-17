// ทดสอบงานที่ไม่มีลายเซ็นครู: เซ็นก่อนส่ง · ใส่ลายเซ็นในงานที่ส่งแล้ว (กดเอง และใส่ให้ทันที) · แถบเตือน · รายชื่อผู้ดูแลระบบ · หน้าพิมพ์
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-sigfill-'));
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

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const subOf = (id) => db.q.get('SELECT id, status, teacher_signature FROM submissions WHERE id = ?', id);
const fields = (code) => ({ doc_type: 'manual', subject_code: code, subject_name: 'ทดสอบลายเซ็น', grade_level: 'ม.4', action: 'draft' });

async function newDraft(t, code) {
  const r = await sendForm(t, '/works', fields(code), [[await pdf(2), 'คู่มือ.pdf']]);
  return Number(/\/s\/(\d+)/.exec(JSON.parse(r.text).redirect)[1]);
}

test('ต้องมีลายเซ็นก่อนส่ง: ไม่มีลายเซ็นส่งไม่ได้ เซ็นในกรอบแล้วส่งได้ ลายเซ็นติดงานและจำไว้', async () => {
  const me = await db.q.get("SELECT id FROM users WHERE username = 'sci2'");
  await db.q.run('UPDATE users SET signature = NULL WHERE id = ?', me.id);
  const t = await as('sci2');
  const id = await newDraft(t, 'ว30181');
  const page = (await t.get(`/s/${id}`)).text;
  assert.match(page, /data-need-sig/);
  assert.match(page, /id="sig-need" class="modal sig-need" data-require/);
  await t.post(`/s/${id}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(id)).status, 'draft', 'ไม่มีลายเซ็นต้องส่งไม่ได้');
  await t.post(`/s/${id}/submit`, { cover_check: '1', cover_ok: '1', signature: SIG, sig_choice: '1', remember_signature: '1' });
  const s = await subOf(id);
  assert.equal(s.status, 'pending');
  assert.equal(s.teacher_signature, SIG);
  assert.equal((await db.q.get('SELECT signature FROM users WHERE id = ?', me.id)).signature, SIG, 'จำลายเซ็นไว้ในข้อมูลส่วนตัว');
  // ปิดสวิตช์ ส่งได้แม้ไม่มีลายเซ็น (แบบเดิม)
  await db.setSetting('ff_sigrequire', '0');
  await db.q.run('UPDATE users SET signature = NULL WHERE id = ?', me.id);
  const id2 = await newDraft(t, 'ว30182');
  assert.doesNotMatch((await t.get(`/s/${id2}`)).text, /data-require/);
  await t.post(`/s/${id2}/submit`, { cover_check: '1', cover_ok: '1' });
  assert.equal((await subOf(id2)).status, 'pending');
  assert.equal((await subOf(id2)).teacher_signature, null);
  await db.setSetting('ff_sigrequire', '1');
});

test('งานที่ส่งตอนยังไม่มีลายเซ็น: แถบเตือน รายชื่อผู้ดูแล แจ้งเตือน หน้าพิมพ์ แล้วเซ็นครั้งเดียวใส่ให้ทันที', async () => {
  const me = await db.q.get("SELECT id, full_name FROM users WHERE username = 'sci2'");
  await db.q.run('UPDATE users SET signature = NULL WHERE id = ?', me.id);
  const t = await as('sci2');
  const blank = await db.q.get("SELECT id FROM submissions WHERE teacher_id = ? AND status <> 'draft' AND teacher_signature IS NULL ORDER BY id LIMIT 1", me.id);
  assert.ok(blank, 'มีงานที่ส่งตอนยังไม่มีลายเซ็นจากข้อก่อน');
  const home = (await t.get('/')).text;
  assert.match(home, /คุณยังไม่มีลายเซ็น/);
  assert.match(home, /data-sig-open/);
  assert.match((await t.get('/profile')).text, /งานที่ส่งไปตอนยังไม่มีลายเซ็น/);
  const print = (await t.get(`/s/${blank.id}/print`)).text;
  assert.match(print, /class="paper memo" data-nosig/);
  assert.match(print, /class="tsig-dots">ลงชื่อ/);
  assert.match(print, /data-nosig-warn hidden/);

  const admin = await as('admin');
  const adm = (await admin.get('/admin')).text;
  assert.match(adm, /id="sigmissing"/);
  assert.match(adm, new RegExp(me.full_name));
  const before = (await db.q.get('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ?', me.id)).n;
  await admin.post('/admin/sig-remind', {});
  assert.equal((await db.q.get('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ?', me.id)).n, before + 1);
  // ผู้ดูแลระบบใส่ลายเซ็นแทนครูไม่ได้
  await admin.post(`/s/${blank.id}/sigfill`, {});
  assert.equal((await subOf(blank.id)).teacher_signature, null);

  // เซ็นจากแถบเตือนหน้าแรก ใส่ให้ทุกงานทันที (sigfillauto)
  const r = await t.post('/profile/sign', { signature: SIG, back: '/' });
  assert.equal(r.location, '/');
  assert.equal((await subOf(blank.id)).teacher_signature, SIG);
  assert.doesNotMatch((await t.get(`/s/${blank.id}/print`)).text, /class="tsig-dots"/);
  assert.ok(await db.q.get("SELECT 1 FROM audit_log WHERE action LIKE 'ใส่ลายเซ็นของตัวเอง%'"));
});

test('ปิดใส่ให้ทันที ครูกดปุ่มใส่ลายเซ็นเอง ทั้งหมดหรือทีละงาน · ปิดทุกสวิตช์กลับเป็นแบบเดิม', async () => {
  const me = await db.q.get("SELECT id FROM users WHERE username = 'sci2'");
  await db.setSetting('ff_sigfillauto', '0');
  const ids = (await db.q.all("SELECT id FROM submissions WHERE teacher_id = ? AND status <> 'draft' ORDER BY id LIMIT 2", me.id)).map((r) => r.id);
  await db.q.run('UPDATE submissions SET teacher_signature = NULL WHERE id = ANY(?)', ids);
  const t = await as('sci2');
  assert.match((await t.get('/')).text, /งานที่ส่งไปตอนยังไม่มีลายเซ็น/, 'ไม่ใส่เองเมื่อปิดใส่ให้ทันที');
  assert.equal((await subOf(ids[0])).teacher_signature, null);
  assert.match((await t.get(`/s/${ids[0]}`)).text, /ใส่ลายเซ็นของฉันในงานนี้/);
  await t.post(`/s/${ids[0]}/sigfill`, {});
  assert.equal((await subOf(ids[0])).teacher_signature, SIG);
  assert.equal((await subOf(ids[1])).teacher_signature, null, 'ทีละงาน งานอื่นไม่เปลี่ยน');
  await t.post('/profile/sigfill', {});
  assert.equal((await subOf(ids[1])).teacher_signature, SIG);

  for (const k of ['sigfill', 'sigfillauto', 'sigrequire', 'signag', 'siglist', 'sigprint']) await db.setSetting(`ff_${k}`, '0');
  await db.q.run('UPDATE submissions SET teacher_signature = NULL WHERE id = ?', ids[0]);
  await db.q.run('UPDATE users SET signature = NULL WHERE id = ?', me.id);
  assert.doesNotMatch((await t.get('/')).text, /คุณยังไม่มีลายเซ็น|id="sig-need"/);
  assert.doesNotMatch((await t.get(`/s/${ids[0]}/print`)).text, /class="tsig-dots"|class="paper memo" data-nosig/);
  assert.doesNotMatch((await (await as('admin')).get('/admin')).text, /id="sigmissing"/);
  for (const k of ['sigfill', 'sigfillauto', 'sigrequire', 'signag', 'siglist', 'sigprint']) await db.setSetting(`ff_${k}`, '1');
});

test('งานที่ผู้ดูแลส่งแทน: ไม่ใส่ลายเซ็นให้เอง ครูยืนยันเองในหน้างาน งานที่ครูส่งเองยังใส่ให้ทันทีเหมือนเดิม · ปิดสวิตช์กลับเป็นใส่ให้ทุกงาน', async () => {
  const me = await db.q.get("SELECT id FROM users WHERE username = 'sci2'");
  await db.q.run('UPDATE users SET signature = ? WHERE id = ?', SIG, me.id);
  const t = await as('sci2');
  const admin = await as('admin');
  const byAdmin = await newDraft(t, 'ว30191');
  await admin.post(`/s/${byAdmin}/submit`, {});
  assert.equal((await subOf(byAdmin)).status, 'pending', 'ผู้ดูแลส่งแทนได้');
  assert.equal((await subOf(byAdmin)).teacher_signature, null, 'ส่งแทนไม่ใส่ลายเซ็นครู');
  // งานที่ครูส่งเองแต่ลายเซ็นหาย ยังใส่ให้ทันทีเมื่อเปิดหน้าแรก
  const own = (await db.q.get("SELECT id FROM submissions WHERE teacher_id = ? AND status <> 'draft' AND id <> ? ORDER BY id LIMIT 1", me.id, byAdmin)).id;
  await db.q.run('UPDATE submissions SET teacher_signature = NULL WHERE id = ?', own);

  const home = (await t.get('/')).text;
  assert.equal((await subOf(own)).teacher_signature, SIG, 'งานที่ครูส่งเองใส่ให้ทันที');
  assert.equal((await subOf(byAdmin)).teacher_signature, null, 'งานที่ผู้ดูแลส่งแทนไม่ใส่ให้เอง');
  assert.match(home, /ผู้ดูแลระบบส่งงานแทนคุณ 1 งาน รอคุณยืนยัน/);
  assert.match(home, new RegExp(`href="/s/${byAdmin}#sigconfirm"`));
  await t.post('/profile/sigfill', {});
  assert.equal((await subOf(byAdmin)).teacher_signature, null, 'ปุ่มใส่ทั้งหมดไม่รวมงานที่ส่งแทน');
  assert.match((await t.get(`/s/${byAdmin}`)).text, /ยืนยันงานนี้และใส่ลายเซ็น/);
  await t.post(`/s/${byAdmin}/sigfill`, {});
  assert.equal((await subOf(byAdmin)).teacher_signature, SIG);
  assert.ok(await db.q.get("SELECT 1 FROM reviews WHERE submission_id = ? AND action = 'sigconfirm' AND user_id = ?", byAdmin, me.id), 'ประวัติบันทึกว่าครูยืนยัน');
  assert.match((await t.get(`/s/${byAdmin}`)).text, /ครูยืนยันงานที่ผู้ดูแลระบบส่งแทน/);

  // ปิดสวิตช์: งานที่ส่งแทนได้ลายเซ็นเองเหมือนงานอื่น (แบบ ก)
  await db.setSetting('ff_sigconfirm', '0');
  await db.q.run('UPDATE submissions SET teacher_signature = NULL WHERE id = ?', byAdmin);
  await t.get('/');
  assert.equal((await subOf(byAdmin)).teacher_signature, SIG);
  await db.setSetting('ff_sigconfirm', '1');
});
