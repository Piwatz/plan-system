// ฟังก์ชันเสริม namefix: จัดรูปแบบชื่อ สกุล ให้อัตโนมัติ และเตือนชื่อที่ไม่มีคำนำหน้า ใช้ฐานชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-namefix-'));
process.env.DATA_DIR = path.join(tmp, 'data');

const db = require('../src/db');
const util = require('../src/util');
const { createApp } = require('../src/app');
let server;
let base;
let cookie = '';

async function req(method, url, fields) {
  const res = await fetch(base + url, { method, body: fields && new URLSearchParams(fields), redirect: 'manual', headers: { cookie } });
  for (const c of res.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
  return { status: res.status, text: await res.text() };
}

test.before(async () => {
  await db.open(':memory:');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fixName ตัดวรรคหลังคำนำหน้าและวรรคซ้ำ hasTitle รู้จักคำนำหน้าและยศ', () => {
  assert.equal(util.fixName('  นาย สมมติ   ใจดี '), 'นายสมมติ ใจดี');
  assert.equal(util.fixName('นางสาว  ตัวอย่าง ใจดี'), 'นางสาวตัวอย่าง ใจดี');
  assert.equal(util.fixName('นาง ทดลอง รักเรียน'), 'นางทดลอง รักเรียน');
  assert.equal(util.fixName('นางนวล ใจดี'), 'นางนวล ใจดี', 'ชื่อที่ขึ้นต้นด้วยคำว่านางแต่ไม่มีวรรค ไม่แตะ');
  assert.equal(util.fixName('ว่าที่ร้อยตรี สมมติ ใจดี'), 'ว่าที่ร้อยตรี สมมติ ใจดี', 'ยศไม่แตะ');
  assert.equal(util.hasTitle('นายสมมติ ใจดี'), true);
  assert.equal(util.hasTitle('ดร.สมมติ ใจดี'), true);
  assert.equal(util.hasTitle('สมมติ ใจดี'), false);
});

test('ตั้งค่าครั้งแรก เพิ่มผู้ใช้ และนำเข้ารายชื่อ เก็บชื่อแบบจัดรูปแบบแล้ว และเตือนชื่อไม่มีคำนำหน้า', async () => {
  const setup = await req('GET', '/setup');
  assert.match(setup.text, /ใส่คำนำหน้าติดกับชื่อ เว้นวรรคเฉพาะระหว่างชื่อกับนามสกุล เช่น นายสมมติ ใจดี/);
  await req('POST', '/setup', { school_name: 'โรงเรียนทดลอง', full_name: 'นาย  ผู้ดูแล   ทดลอง', username: 'wadmin', password: 'abcdef12', password2: 'abcdef12' });
  assert.equal((await db.q.get("SELECT full_name FROM users WHERE username = 'wadmin'")).full_name, 'นายผู้ดูแล ทดลอง');

  await req('POST', '/admin/users', { full_name: 'นางสาว ครู  ทดลอง', username: 'tnew', password: '1234', is_teacher: '1', is_active: '1' });
  assert.equal((await db.q.get("SELECT full_name FROM users WHERE username = 'tnew'")).full_name, 'นางสาวครู ทดลอง');

  const imp = await req('POST', '/admin/users-import', { password: '1234', auto_username: '1', data: 'นาย สมมติ  หนึ่ง\tครู\nสมมติ สอง\tครู' });
  assert.ok(await db.q.get("SELECT 1 AS x FROM users WHERE full_name = 'นายสมมติ หนึ่ง'"));
  assert.match(imp.text, /ชื่อต่อไปนี้ยังไม่มีคำนำหน้า กรุณาตรวจสอบ: <b>สมมติ สอง<\/b>/);
  assert.doesNotMatch(imp.text, /ยังไม่มีคำนำหน้า[^<]*<b>[^<]*นายสมมติ หนึ่ง/);

  // ปิดสวิตช์แล้วเก็บตามที่พิมพ์
  await req('POST', '/admin/features/namefix', { on: '0' });
  await req('POST', '/admin/users', { full_name: 'นาย ปิด  สวิตช์', username: 'toff', password: '1234', is_teacher: '1', is_active: '1' });
  assert.equal((await db.q.get("SELECT full_name FROM users WHERE username = 'toff'")).full_name, 'นาย ปิด  สวิตช์');
  assert.doesNotMatch((await req('GET', '/admin/users/new')).text, /ใส่คำนำหน้าติดกับชื่อ/);
});
