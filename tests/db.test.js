// ตอน 4: ชั้นฐานข้อมูล Postgres บน PGlite
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../src/db');

const { q } = db;

test.before(async () => {
  await db.open(':memory:');
});
test.after(async () => {
  await db.close();
});

async function newUser(name) {
  return q.get("INSERT INTO users (username, password_hash, full_name, created_at) VALUES (?, 'x', ?, '2569-10-05 08:00:00') RETURNING id", name, 'ครูสมมติ ' + name);
}

test('แปลง ? เป็น $n โดยข้าม ? ในข้อความ และครอบ current_role', async () => {
  assert.equal(db.toPg("SELECT ? AS a, 'ใช่ไหม?' AS b, \"x?\" AS c, ? AS d"), "SELECT $1 AS a, 'ใช่ไหม?' AS b, \"x?\" AS c, $2 AS d");
  assert.equal(db.toPg("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
  assert.equal(db.toPg('SELECT s.current_role, current_role FROM submissions s WHERE current_role = ?'), 'SELECT s."current_role", "current_role" FROM submissions s WHERE "current_role" = $1');
  assert.equal(db.toPg("SELECT 'current_role', \"current_role\""), "SELECT 'current_role', \"current_role\"");
  const r = await q.get("SELECT ?::text AS a, 'ใช่ไหม?' AS b, ?::integer AS c", 'ก', 7);
  assert.deepEqual({ ...r }, { a: 'ก', b: 'ใช่ไหม?', c: 7 });
});

test('COUNT SUM AVG ได้ number · get ไม่พบได้ undefined · run คืน changes', async () => {
  const r = await q.get('SELECT COUNT(*) AS n, SUM(seq) AS s, AVG(seq) AS a FROM workflow_steps');
  assert.equal(r.n, 5);
  assert.equal(r.s, 15);
  assert.equal(r.a, 3);
  assert.equal(await q.get('SELECT * FROM users WHERE id = ?', 999999), undefined);
  const u = await newUser('count1');
  assert.equal(typeof u.id, 'number');
  assert.deepEqual(await q.run('UPDATE users SET position = ? WHERE id = ?', 'ครู', u.id), { changes: 1 });
  // undefined เป็น null และ true false เป็น 1 0
  await q.run('UPDATE users SET last_login_at = ?, is_admin = ? WHERE id = ?', undefined, true, u.id);
  const back = await q.get('SELECT last_login_at, is_admin FROM users WHERE id = ?', u.id);
  assert.equal(back.last_login_at, null);
  assert.equal(back.is_admin, 1);
});

test('transaction ผิดกลางทางแล้วย้อนกลับครบ · ซ้อนกันใช้ชั้นนอก', async () => {
  const before = (await q.get('SELECT COUNT(*) AS n FROM departments')).n;
  await assert.rejects(
    q.tx(async () => {
      await q.run('INSERT INTO departments (name, sort) VALUES (?, 99)', 'กลุ่มทดลอง ก');
      await q.tx(async () => {
        await q.run('INSERT INTO departments (name, sort) VALUES (?, 99)', 'กลุ่มทดลอง ข');
      });
      throw new Error('พังกลางทาง');
    }),
    /พังกลางทาง/
  );
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM departments')).n, before);
  const id = await q.tx(async () => (await q.get('INSERT INTO departments (name, sort) VALUES (?, 99) RETURNING id', 'กลุ่มทดลอง ค')).id);
  assert.ok(await q.get('SELECT 1 AS x FROM departments WHERE id = ?', id));
});

test('คำสั่งจากที่อื่นรอ transaction เสร็จก่อน ไม่หลุดเข้าไปปน (PGlite มี session เดียว)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = q.tx(async () => {
    await q.run('INSERT INTO departments (name, sort) VALUES (?, 98)', 'กลุ่มรอ');
    await gate;
    throw new Error('ย้อนกลับ');
  });
  // คำสั่งนอก transaction ถูกส่งระหว่างที่ transaction ยังค้าง ต้องไม่เห็นแถวที่ยังไม่ commit และต้องไม่ถูกย้อนกลับไปด้วย
  const outside = db.withScope(() => q.get("SELECT COUNT(*) AS n FROM departments WHERE name = 'กลุ่มรอ'"));
  setTimeout(release, 50);
  await assert.rejects(t, /ย้อนกลับ/);
  assert.equal((await outside).n, 0);
});

test('audit_log แก้ ลบ ล้างตารางไม่ได้', async () => {
  await q.run("INSERT INTO audit_log (at, user_name, action) VALUES ('2569-10-05 08:00:00', 'ระบบ', 'ทดลอง')");
  await assert.rejects(q.run("UPDATE audit_log SET action = 'แก้'"), /append-only/);
  await assert.rejects(q.run('DELETE FROM audit_log'), /append-only/);
  await assert.rejects(q.exec('TRUNCATE audit_log'), /append-only/);
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM audit_log')).n, 1);
});

test('verify_code สร้างเองเป็นตัวอักษร 0 ถึง 9 a ถึง f 20 ตัว · current_role อ่านเขียนได้', async () => {
  const u = await newUser('verify1');
  const s = await q.get(
    "INSERT INTO submissions (doc_type, teacher_id, academic_year, semester, status, current_role, created_at, updated_at) VALUES ('plan', ?, 2569, 2, 'pending', 'dept_head', 'x', 'x') RETURNING id, verify_code, current_role",
    u.id
  );
  assert.match(s.verify_code, /^[0-9a-f]{20}$/);
  assert.equal(s.current_role, 'dept_head');
  await q.run('UPDATE submissions SET current_role = ? WHERE id = ?', 'director', s.id);
  const r = await q.get('SELECT s.current_role FROM submissions s WHERE s.id = ? AND current_role = ?', s.id, 'director');
  assert.equal(r.current_role, 'director');
  const s2 = await q.get("INSERT INTO submissions (doc_type, teacher_id, academic_year, semester, created_at, updated_at) VALUES ('plan', ?, 2569, 2, 'x', 'x') RETURNING verify_code", u.id);
  assert.notEqual(s2.verify_code, s.verify_code);
});

test('ชื่อผู้ใช้ต่างแค่ตัวพิมพ์ใส่ซ้ำไม่ได้ และค้นแบบไม่สนตัวพิมพ์ได้', async () => {
  await newUser('Somchai');
  await assert.rejects(newUser('somCHAI'), (e) => e.code === '23505');
  assert.ok(await q.get('SELECT id FROM users WHERE lower(username) = lower(?)', 'SOMCHAI'));
});

test('to_int_lenient อ่านเลขแผนที่ครูพิมพ์โดยไม่ error', async () => {
  const r = await q.get("SELECT to_int_lenient('') AS a, to_int_lenient('12ก') AS b, to_int_lenient('  7') AS c, to_int_lenient('ก') AS d, to_int_lenient('12345678901234567890') AS e");
  assert.deepEqual({ ...r }, { a: 0, b: 12, c: 7, d: 0, e: 123456789 });
});

test('ค่าตั้ง: ค่าเริ่มต้นครบ โลโก้เป็นที่อยู่ /media · setSetting ล้างข้อมูลอ้างอิง', async () => {
  const s = await db.getSettings();
  assert.equal(Object.keys(s).length, 49);
  assert.equal(s.school_logo, '');
  assert.equal(s.ff_pdfonly, '1');
  assert.match(s.academic_year, /^25\d\d$/);
  await db.setSetting('school_logo', 'data:image/png;base64,' + Buffer.from('รูปทดลอง').toString('base64'));
  assert.match((await db.getSettings()).school_logo, /^\/media\/logo\?v=[0-9a-f]{8}$/);
  assert.equal(db.refs().steps.length, 5);
  assert.equal(db.refs().rubrics.length, 40);
  await db.withScope(async () => assert.throws(() => db.refs(), /ensureRefs/));
});

test('/media/logo ส่งรูปได้โดยไม่เข้าระบบ · ไม่มีรูปได้ 404', async () => {
  const app = express();
  app.use(db.requestScope);
  app.use(require('../src/routes/media'));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(base + '/media/logo?v=abc');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control'), /max-age=31536000/);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'รูปทดลอง');
    assert.equal((await fetch(base + '/media/memo-logo')).status, 404);
  } finally {
    server.close();
  }
});
