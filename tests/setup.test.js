// ทดสอบการติดตั้งครั้งแรก: ยังไม่มีผู้ใช้ ต้องสร้างผู้ดูแลระบบก่อน แล้วเพิ่มครูจากการวางรายชื่อ
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-setup-'));
process.env.DATA_DIR = path.join(tmp, 'data');

const db = require('../src/db');
const { createApp } = require('../src/app');

let base;
let server;
let cookie = '';

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function req(method, url, fields) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { cookie },
    body: fields ? new URLSearchParams(fields) : undefined,
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

test('ครั้งแรกพาไปหน้าตั้งค่า สร้างผู้ดูแลระบบ แล้วนำเข้ารายชื่อครูได้', async () => {
  const first = await req('GET', '/');
  assert.equal(first.location, '/setup');
  const bad = await req('POST', '/setup', { school_name: 'โรงเรียนทดสอบ', full_name: 'ผู้ดูแล', username: 'admin', password: '12345', password2: '12345' });
  assert.match(bad.text, /อย่างน้อย 6 ตัวอักษร/);
  const ok = await req('POST', '/setup', { school_name: 'โรงเรียนทดสอบ', full_name: 'ผู้ดูแล', username: 'admin', password: 'secret123', password2: 'secret123' });
  assert.equal(ok.location, '/admin');
  assert.equal((await req('GET', '/setup')).location, '/login', 'ตั้งค่าครั้งแรกซ้ำไม่ได้');

  const admin = await req('GET', '/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /ยังไม่ได้กำหนดผู้ใดเป็น/);

  const data = [
    'ชื่อผู้ใช้\tชื่อ สกุล\tตำแหน่ง\tกลุ่มสาระ\tหน้าที่',
    'T01\tนางสาวทดสอบ หนึ่ง\tครู\tวิทยาศาสตร์\t',
    'T02\tนายทดสอบ สอง\tครู\tคณิต\tหัวหน้ากลุ่มสาระ',
    'T03\tนางทดสอบ สาม\tรองผู้อำนวยการ\t\tรองผู้อำนวยการ',
    'T04\tนายทดสอบ สี่\tครู\tไม่มีกลุ่มนี้\t',
  ].join('\n');
  const imp = await req('POST', '/admin/users-import', { data, password: 'start123' });
  assert.equal(imp.status, 200);
  assert.match(imp.text, /เพิ่มใหม่ <b>3<\/b>/);
  assert.match(imp.text, /ไม่พบกลุ่มสาระ/);
  const u2 = db.q.get("SELECT * FROM users WHERE username = 'T02'");
  assert.equal(u2.must_change_password, 1);
  assert.deepEqual(db.q.all('SELECT role FROM user_roles WHERE user_id = ?', u2.id).map((r) => r.role), ['dept_head']);
  const u3 = db.q.get("SELECT * FROM users WHERE username = 'T03'");
  assert.equal(u3.is_teacher, 0, 'รองผู้อำนวยการไม่นับเป็นครูผู้สอน');

  // ครูเข้าระบบครั้งแรกต้องเปลี่ยนรหัสผ่านก่อน
  cookie = '';
  const login = await req('POST', '/login', { username: 'T01', password: 'start123' });
  assert.equal(login.location, '/password');
  assert.equal((await req('GET', '/my')).location, '/password');
  await req('POST', '/password', { password: 'mypass99', password2: 'mypass99' });
  assert.equal((await req('GET', '/my')).status, 200);
});
