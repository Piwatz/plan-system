// ทดสอบสรุปการส่งงานครู (ฟังก์ชันเสริม reportsum): การคิดผล การปรับผล สิทธิ์ และไฟล์ Word
// ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reportsum-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');
const report = require('../src/reportsum');

let base;
let server;
let y;
let m;

test.before(async () => {
  await seed.main({ target: ':memory:', keepOpen: true });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const t = await db.q.get("SELECT academic_year AS y, semester AS m FROM submissions WHERE doc_type = 'plan' AND status != 'draft' ORDER BY id LIMIT 1");
  y = t.y;
  m = t.m;
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
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  }
  async get(url) {
    const r = await this.req('GET', url);
    return { ...r, text: r.buf.toString('utf8') };
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

const loadRound = async (...a) => {
  await db.ensureRefs();
  return report.load(...a);
};
const adminName = async () => (await db.q.get('SELECT username FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1')).username;

test('คิดผล: ส่งครบก่อนกำหนดทัน ส่งหลังกำหนดเกิน ส่งไม่ครบนับยังไม่ส่ง', () => {
  const p = (need, dates) => ({ need, dates });
  assert.equal(report.realState(p(1, ['2569-11-30 10:00']), '2569-11-30'), 'ontime');
  assert.equal(report.realState(p(1, ['2569-12-01 00:01']), '2569-11-30'), 'late');
  assert.equal(report.realState(p(2, ['2569-11-01 10:00']), '2569-11-30'), 'notsent');
  assert.equal(report.realState(p(2, ['2569-11-01 10:00', '2569-12-05 10:00']), '2569-11-30'), 'late', 'ใช้วันที่ชิ้นสุดท้าย');
  assert.equal(report.realState(p(1, ['2569-12-01 10:00']), ''), 'ontime', 'ไม่ตั้งกำหนดส่ง ส่งแล้วนับทัน');
});

test('คู่มือ: ต้องส่งทุกวิชาที่สอน · สอนเฉพาะกิจกรรมไม่ต้องส่ง · ยังไม่มีรายวิชานับว่าต้องส่ง', () => {
  const teacher = { plan_quota: 1 };
  const taught = [{ subject_code: 'ว1' }, { subject_code: 'ว2' }];
  const subs = [{ subject_code: 'ว1', sent_at: '2569-11-01 09:00' }, { subject_code: 'ว1', sent_at: '2569-11-05 09:00' }];
  const one = report.piecesOf('manual', teacher, taught, 2, subs);
  assert.deepEqual(one, { need: 2, dates: ['2569-11-01 09:00'] });
  assert.equal(report.piecesOf('manual', teacher, [], 1, []), null);
  assert.deepEqual(report.piecesOf('manual', teacher, [], 0, []), { need: 1, dates: [] });
});

test('ร้อยละปัดเป็นจำนวนเต็มตามแบบฟอร์ม และไม่นับคนที่ไม่คิดผล', () => {
  const s = report.summarize([...Array(62).fill('ontime'), 'notsent', 'notsent', 'hold', 'exclude']);
  assert.equal(s.total, 64);
  assert.equal(s.pct.ontime, 97);
  assert.equal(s.pct.notsent, 3);
  assert.equal(s.skip, 2);
});

test('หมายเหตุ: ข้อความพิมพ์เองออกเมื่อเปิดสวิตช์ ยังไม่ส่งและส่งเกินกำหนดเปิดปิดแยกกัน', () => {
  const a = { note: 'ลาป่วย' };
  assert.equal(report.paperNote('ontime', a, true), 'ลาป่วย');
  assert.equal(report.paperNote('ontime', a, false), '');
  assert.equal(report.paperNote('notsent', a, false), 'ยังไม่ส่ง');
  assert.equal(report.paperNote('late', null, false), 'ส่งเกินกำหนด');
  assert.equal(report.paperNote('late', null, false, { note_late: 0, note_notsent: 1 }), '');
  assert.equal(report.paperNote('notsent', null, false, { note_late: 0, note_notsent: 1 }), 'ยังไม่ส่ง');
  assert.equal(report.paperNote('notsent', null, false, { note_late: 1, note_notsent: 0 }), '');
});

test('ถ้อยคำตามฟอร์ม 3 ไฟล์ และบรรทัดส่งเกินกำหนดขึ้นเมื่อมีคนส่งเกิน', () => {
  const none = report.summarize(['ontime', 'notsent']);
  const plan = report.paperText('plan', 2569, 1, none);
  assert.equal(plan.subject, 'รายงานการส่งแผนการจัดการเรียนรู้ประจำภาคเรียนที่ 1 ปีการศึกษา 2569');
  assert.deepEqual(plan.items.map((i) => i.label), ['ส่งตามกำหนดเวลา', 'ขาดส่งแผนจัดการเรียนรู้']);
  assert.match(plan.listTitle, /ที่ไม่ได้ส่งแผนการสอนตามกำหนดเวลา$/);
  const man = report.paperText('manual', 2569, 1, report.summarize(['ontime', 'late', 'notsent']));
  assert.equal(man.subject, 'รายงานการส่งคู่มือรายวิชาประจำภาคเรียนที่ 1 ปีการศึกษา 2569');
  assert.deepEqual(man.items.map((i) => i.label), ['ส่งตามกำหนดเวลา', 'ส่งเกินกำหนดเวลา', 'ขาดส่งคู่มือรายวิชา']);
  const note = report.paperText('note', 2569, 1, none);
  assert.equal(note.subject, 'รายงานการส่งบันทึกหลังแผนการจัดการเรียนรู้ประจำภาคเรียนที่ 1 ปีการศึกษา 2569');
  assert.equal(note.items[1].label, 'ขาดส่งบันทึกหลังแผน');
  assert.equal(note.sent, 'ส่งบันทึกหลังแผน');
  assert.equal(report.formDate('2026-07-13').replace(/\d+$/, ''), '13  กรกฎาคม พ.ศ. ');
});

test('หน้าสรุปเข้าได้เฉพาะผู้ดูแลระบบ', async () => {
  const other = await db.q.get('SELECT username FROM users WHERE is_admin = 0 AND is_active = 1 AND is_teacher = 1 ORDER BY id LIMIT 1');
  const t = await as(other.username);
  for (const url of ['/admin/report', '/admin/report/print?type=plan', '/admin/report/word?type=plan']) {
    assert.notEqual((await t.get(url)).status, 200, url);
  }
  const before = await db.q.get('SELECT COUNT(*) AS n FROM report_adjusts');
  await t.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: '1', types: 'plan', result: 'exclude', reason: 'ลอง', action: 'apply' });
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM report_adjusts')).n, before.n);
  const a = await as(await adminName());
  assert.match((await a.get('/admin')).text, /href="\/admin\/report"/);
  assert.match((await a.get(`/admin/report?year=${y}&semester=${m}`)).text, /สรุปการส่งงานครู/);
});

test('หน้าทะเบียนงานและสถานะกลุ่มสาระมีปุ่มไปสรุปการส่งงาน เห็นเฉพาะผู้ดูแลระบบ ปิดฟังก์ชันแล้วปุ่มหาย', async () => {
  const pages = ['/registry?type=manual', '/dept'];
  const a = await as(await adminName());
  const link = /href="\/admin\/report\?[^"]*year=\d+&(amp;)?semester=\d+"[^>]*>สรุปการส่งงานครู</;
  for (const url of pages) assert.match((await a.get(url)).text, link, url);
  assert.match((await a.get(pages[0])).text, /href="\/admin\/report\?type=manual&/, 'ทะเบียนคู่มือไปสรุปคู่มือ');
  const head = await db.q.get("SELECT u.username FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.is_admin = 0 AND u.is_active = 1 AND r.role = 'dept_head' ORDER BY u.id LIMIT 1");
  const h = await as(head.username);
  for (const url of pages) assert.doesNotMatch((await h.get(url)).text, /\/admin\/report/, url);
  await db.setSetting('ff_reportsum', '0');
  try {
    for (const url of pages) assert.doesNotMatch((await a.get(url)).text, /href="\/admin\/report/, url);
  } finally {
    await db.setSetting('ff_reportsum', '1');
  }
});

test('ปรับผล: ตามจริงไม่เปลี่ยน คืนค่าได้ ต้องมีเหตุผล จดประวัติ ไม่แตะงานจริง', async () => {
  const a = await as(await adminName());
  const adminId = (await db.q.get('SELECT id FROM users WHERE username = ?', await adminName())).id;
  const before = await loadRound('plan', y, m);
  const who = before.rows.find((r) => r.id !== adminId);
  const subsBefore = await db.q.all('SELECT id, status, submitted_at FROM submissions ORDER BY id');
  const form = { type: 'plan', year: y, semester: m, ids: String(who.id), types: 'plan', action: 'apply', result: 'exclude', situation: 'ครูต่างชาติ', note: 'ทดลองหมายเหตุ' };

  await a.post('/admin/report/adjust', form);
  assert.equal((await loadRound('plan', y, m)).changed, 0, 'ไม่มีเหตุผล ต้องไม่บันทึก');

  await a.post('/admin/report/adjust', { ...form, reason: 'ทดลองเหตุผล' });
  const after = await loadRound('plan', y, m);
  assert.equal(after.changed, 1);
  assert.deepEqual(after.real, before.real, 'ตามจริงต้องไม่เปลี่ยน');
  assert.equal(after.report.skip, before.report.skip + 1);
  assert.equal(after.report.total, before.report.total - 1);
  assert.deepEqual(await db.q.all('SELECT id, status, submitted_at FROM submissions ORDER BY id'), subsBefore, 'ห้ามแตะข้อมูลงานจริง');
  assert.ok(await db.q.get("SELECT id FROM audit_log WHERE action LIKE 'ปรับผลในฉบับรายงาน%' AND detail LIKE '%ทดลองเหตุผล%'"));

  // ครูที่ไม่คิดผลไม่อยู่ในตารางกระดาษฉบับรายงาน แต่ยังอยู่ในฉบับตามจริง
  const printed = await a.get(`/admin/report/print?type=plan&mode=report&year=${y}&semester=${m}`);
  const realPrint = await a.get(`/admin/report/print?type=plan&mode=real&year=${y}&semester=${m}`);
  assert.ok(!printed.text.includes(`<td>${who.full_name}</td>`));
  assert.ok(realPrint.text.includes(`<td>${who.full_name}</td>`));

  await a.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: String(who.id), types: 'plan', action: 'reset' });
  const reset = await loadRound('plan', y, m);
  assert.equal(reset.changed, 0);
  assert.deepEqual(reset.report, before.report);
});

test('ผู้ดูแลระบบปรับผลของตัวเองไม่ได้', async () => {
  const name = await adminName();
  const a = await as(name);
  const me = await db.q.get('SELECT id FROM users WHERE username = ?', name);
  await a.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: String(me.id), types: 'plan', action: 'apply', result: 'ontime', reason: 'ลอง' });
  assert.equal(await db.q.get('SELECT id FROM report_adjusts WHERE teacher_id = ?', me.id), undefined);
});

test('ขยายกำหนดเฉพาะคน และการปรับที่มีผลต่อข้ามภาคเรียน', async () => {
  const a = await as(await adminName());
  const adminId = (await db.q.get('SELECT id FROM users WHERE username = ?', await adminName())).id;
  await a.post('/admin/report/due', { type: 'plan', year: y, semester: m, due_date: '2000-01-01' });
  const data = await loadRound('plan', y, m);
  const lateOne = data.rows.find((r) => r.real === 'late' && r.id !== adminId);
  assert.ok(lateOne, 'กำหนดส่งปี 2000 ทุกคนที่ส่งต้องเกินกำหนด');
  await a.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: String(lateOne.id), types: 'plan', action: 'apply', result: 'extend', extend_date: '2999-01-01', reason: 'ลาป่วย' });
  const ext = (await loadRound('plan', y, m)).rows.find((r) => r.id === lateOne.id);
  assert.equal(ext.real, 'late');
  assert.equal(ext.state, 'ontime');
  await a.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: String(lateOne.id), types: 'plan', action: 'apply', result: 'hold', reason: 'ครูบรรจุใหม่', until_date: '2999-12-31' });
  const next = await loadRound('plan', y + 1, m);
  const carried = next.rows.find((r) => r.id === lateOne.id);
  assert.equal(carried.state, 'hold');
  assert.equal(carried.adjust.carried, true);
  await a.post('/admin/report/adjust', { type: 'plan', year: y + 1, semester: m, ids: String(lateOne.id), types: 'plan', action: 'reset' });
  const cleared = (await loadRound('plan', y + 1, m)).rows.find((r) => r.id === lateOne.id);
  assert.equal(cleared.adjust, null, 'คืนค่าภาคนี้ได้แม้มีการปรับจากภาคก่อน');
  await a.post('/admin/report/adjust', { type: 'plan', year: y, semester: m, ids: String(lateOne.id), types: 'plan', action: 'reset' });
  await a.post('/admin/report/due', { type: 'plan', year: y, semester: m, due_date: '' });
});

test('เครื่องหมายสีดำ หมายเหตุยังเป็นอักษรสีแดงแยกกันได้', async () => {
  const a = await as(await adminName());
  const url = `/admin/report/print?type=plan&mode=real&year=${y}&semester=${m}`;
  const form = { type: 'plan', year: y, semester: m, tab: 'real', color_mode: 'black', note_on: '1', note_late: '1' };
  await a.post('/admin/report/round', { ...form, note_notsent: '1', red_notsent: '1' });
  const red = (await a.get(url)).text;
  assert.match(red, /class="paper rpt rp-black"/);
  assert.match(red, /memo-note rp-red">ยังไม่ส่ง/);
  await a.post('/admin/report/round', { ...form, note_notsent: '1' });
  const plain = (await a.get(url)).text;
  assert.ok(!/memo-note rp-red/.test(plain));
  assert.match(plain, /memo-note">ยังไม่ส่ง/);
  await a.post('/admin/report/round', { ...form, red_notsent: '1' });
  assert.ok(!/memo-note[^"]*">ยังไม่ส่ง/.test((await a.get(url)).text));
});

test('งดเตือนเฉพาะไม่คิดผล: ยังไม่คิดผลยังเตือน ไม่แจ้งเตือนในหน้าสถานะกลุ่มสาระ', async () => {
  const a = await as(await adminName());
  // ครูสมมติที่ยังไม่ส่งแผน
  const who = await db.q.get(
    `SELECT u.id, u.username, u.full_name, u.department_id FROM users u WHERE u.is_active = 1 AND u.is_teacher = 1 AND u.is_admin = 0 AND u.department_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.teacher_id = u.id AND s.doc_type IN ('plan', 'manual') AND s.academic_year = ? AND s.semester = ?) ORDER BY u.id LIMIT 1`,
    y, m
  );
  assert.ok(who, 'ต้องมีครูที่ยังไม่ส่ง');
  await db.q.run(
    "INSERT INTO teach_subjects (teacher_id, academic_year, semester, subject_code, subject_name, grade_level, is_main) VALUES (?, ?, ?, 'ว99999', 'วิชาสมมติ', '', 1) ON CONFLICT DO NOTHING",
    who.id, y, m
  );
  const params = (result) => {
    const u = new URLSearchParams({ type: 'plan', year: y, semester: m, ids: String(who.id), action: 'apply', result, reason: 'ทดลอง' });
    u.append('types', 'plan');
    u.append('types', 'manual');
    return u;
  };
  await a.req('POST', '/admin/report/adjust', params('hold'));
  assert.equal((await report.exemptions([who.id], y, m)).size, 0, 'ยังไม่คิดผลยังต้องส่ง');
  await a.req('POST', '/admin/report/adjust', params('exclude'));
  assert.deepEqual([...(await report.exemptions([who.id], y, m)).get(who.id)].sort(), ['manual', 'plan']);
  const dept = (await a.get(`/dept?dept=${who.department_id}`)).text;
  assert.match(dept, /ไม่ต้องส่ง/, 'หน้าสถานะกลุ่มสาระไม่นับว่าขาด');
  const home = (await (await as(who.username)).get('/')).text;
  assert.match(home, /ไม่ต้องส่ง/, 'หน้าแรกของครูบอกว่าไม่ต้องส่ง');
  assert.ok(!home.includes('กดส่งแผน') && !home.includes('กดส่งคู่มือ'), 'หน้าแรกไม่มีปุ่มเตือนให้ส่ง');

  const reset = new URLSearchParams({ type: 'plan', year: y, semester: m, ids: String(who.id), action: 'reset' });
  reset.append('types', 'plan');
  reset.append('types', 'manual');
  await a.req('POST', '/admin/report/adjust', reset);
  assert.equal((await report.exemptions([who.id], y, m)).size, 0, 'คืนค่าแล้วกลับมาเตือน');
});

test('ไฟล์ Word เป็น zip มีเลขที่ ชื่อเรื่อง และฟอนต์ตามฟอร์ม', async () => {
  const a = await as(await adminName());
  await a.post('/admin/report/round', { type: 'manual', year: y, semester: m, tab: 'real', doc_no: 'วก 123/2569', doc_date: '2026-07-13', color_mode: 'black', note_on: '1' });
  const r = await a.get(`/admin/report/word?type=manual&mode=real&year=${y}&semester=${m}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /wordprocessingml/);
  assert.equal(r.buf.slice(0, 2).toString(), 'PK');
  const xml = r.buf.toString('utf8');
  assert.ok(xml.includes('วก 123/2569'));
  assert.ok(xml.includes('รายงานการส่งคู่มือรายวิชาประจำ'));
  assert.ok(xml.includes('w:cs="TH SarabunPSK"'));
  assert.ok(xml.includes('<w:szCs w:val="40"/>'), 'หัวข้อ 20 พอยต์');

  // ตารางรายชื่อเริ่มหน้าใหม่เสมอ ทั้งไฟล์ Word และหน้าพิมพ์
  assert.match(xml, /<w:tblHeader\/><\/w:trPr><w:tc><w:tcPr><w:tcW[^>]*\/><\/w:tcPr><w:p><w:pPr><w:pageBreakBefore\/>/);
  const html = (await a.get(`/admin/report/print?type=manual&mode=real&year=${y}&semester=${m}`)).text;
  assert.match(html, /<\/div>\s*<div class="paper rpt[^"]*">\s*<table class="rp-table">/);
});
