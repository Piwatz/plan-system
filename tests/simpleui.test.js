// ทดสอบการปรับหน้าจอให้ง่ายขึ้น 3 สวิตช์: hometodo alertstrip formshort
// เปิดแล้วเห็นแบบใหม่ ปิดแล้วต้องกลับเป็นแบบเดิมทุกจุด ใช้ข้อมูลทดลองในโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-simpleui-'));
process.env.DATA_DIR = path.join(tmp, 'data-demo');
process.env.DEMO = '1';

const seed = require('../scripts/seed-demo');
const db = require('../src/db');

let base;
let server;
let cookie = '';

test.before(async () => {
  await seed.main({ target: ':memory:', keepOpen: true });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username: 'teacher', password: seed.DEMO_PASSWORD }),
  });
  assert.equal(res.status, 302);
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
});

test.after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const page = async (url) => (await fetch(base + url, { headers: { cookie } })).text();
const formUrl = '/works/new?type=manual&code=' + encodeURIComponent('ว31101');

test('hometodo: งานที่ต้องทำอยู่เหนือกล่องอื่น มีปุ่มแก้ไขและปุ่มส่ง ปิดแล้วหาย', async () => {
  await db.setSetting('ff_hometodo', '1');
  const on = await page('/');
  const box = on.slice(on.indexOf('class="card home-todo'), on.indexOf('</section>', on.indexOf('class="card home-todo')));
  assert.match(box, /ว30207 ถูกส่งกลับให้แก้ไข/);
  assert.match(box, /btn-danger">กดแก้ไข/);
  assert.match(box, /btn-primary">กดส่งคู่มือ/);
  assert.match(box, /วิทยาศาสตร์กายภาพ/, 'งานที่ยังไม่ส่งบอกชื่อวิชา ไม่ใช่คำว่าแตะ');
  assert.ok(on.indexOf('home-todo') < on.indexOf('class="grid-4"'), 'ต้องอยู่เหนือกล่องตัวเลข');
  await db.setSetting('ff_hometodo', '0');
  assert.doesNotMatch(await page('/'), /class="card home-todo/);
  await db.setSetting('ff_hometodo', '1');
});

test('alertstrip: เหลือแถบเดียวบอกจำนวนและข้อความล่าสุด ปิดแล้วกลับเป็นกล่องเดิม', async () => {
  await db.setSetting('ff_alertstrip', '1');
  const on = await page('/');
  assert.match(on, /alert-strip/);
  assert.match(on, /มีแจ้งเตือนใหม่ \d+ เรื่อง/);
  assert.match(on, /class="as-last"/);
  assert.doesNotMatch(on, />ดูทั้งหมด</);
  await db.setSetting('ff_alertstrip', '0');
  const off = await page('/');
  assert.doesNotMatch(off, /alert-strip/);
  assert.match(off, />ดูทั้งหมด</);
  await db.setSetting('ff_alertstrip', '1');
});

test('formshort: วิชาที่เติมครบเหลือบรรทัดเดียว แต่ช่องเดิมยังอยู่ในฟอร์มเพื่อส่งค่า', async () => {
  await db.setSetting('ff_formshort', '1');
  const on = await page(formUrl);
  assert.match(on, /data-fs-summary/);
  assert.match(on, /data-fs-subj hidden/);
  for (const name of ['subject_code', 'subject_name', 'grade_level', 'link_url']) assert.match(on, new RegExp(`name="${name}"`));
  assert.match(on, /value="ว31101"/);
  assert.match(on, /ck-short/);
  assert.match(on, /data-ck-left>ก่อนส่ง เหลืออีก \d+ ข้อ/);
  assert.doesNotMatch(on, /ระบบตรวจไฟล์ให้ทันที/);
  assert.match(on, /<summary>เพิ่มลิงก์/);
  await db.setSetting('ff_formshort', '0');
  const off = await page(formUrl);
  assert.doesNotMatch(off, /data-fs-summary|ck-short|data-ck-left|<summary>เพิ่มลิงก์/);
  assert.doesNotMatch(off, /data-fs-subj hidden/);
  assert.match(off, /ก่อนส่ง ตรวจให้ครบ/);
  await db.setSetting('ff_formshort', '1');
});

test('formshort: ยังไม่รู้วิชาต้องเห็นช่องกรอกตามปกติ และแผนพับรูปแบบการสอนไว้', async () => {
  await db.setSetting('ff_formshort', '1');
  const blank = await page('/works/new?type=manual');
  assert.doesNotMatch(blank, /data-fs-summary/);
  assert.doesNotMatch(blank, /data-fs-subj hidden/);
  // ครูทดลองส่งแผนวิชาหลักไปแล้ว ปิดโควตาชั่วคราวเพื่อเปิดฟอร์มแผนได้
  await db.setSetting('ff_onemain', '0');
  const plan = await page('/works/new?type=plan');
  await db.setSetting('ff_onemain', '1');
  assert.match(plan, /<summary>รูปแบบการจัดการเรียนรู้/);
  assert.match(plan, /name="teaching_methods"/);
});

test('fontpick: เลือกฟอนต์แล้วสีเดิม ค่าแปลกปลอมกลับเป็นตามธีม ปิดสวิตช์แล้วกลับเป็นฟอนต์ของธีม', async () => {
  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'admin', password: seed.DEMO_PASSWORD }) });
  assert.equal(res.status, 302);
  const adminCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const fields = { school_name: 'โรงเรียนทดสอบ', academic_year: '2569', semester: '2', submit_open: '1', max_upload_mb: '20', grade_levels: 'ม.1', teaching_methods: 'Active Learning' };
  const save = async (web_font) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...fields, theme: 'i', web_font })) fd.set(k, v);
    await fetch(base + '/admin/settings', { method: 'POST', redirect: 'manual', body: fd, headers: { cookie: adminCookie } });
  };
  const setting = async () => (await db.getSettings()).web_font;
  const form = await (await fetch(base + '/admin/settings', { headers: { cookie: adminCookie } })).text();
  assert.match(form, /id="font"/);
  assert.match(form, /name="web_font" value="anuphan"/);
  assert.match(form, /value="system"/);
  await save('anuphan');
  assert.equal(await setting(), 'anuphan');
  let html = await page('/');
  assert.match(html, /--font:'Anuphan'/);
  assert.match(html, /anuphan\/400\.css/);
  assert.match(html, /--side:#1B3762/, 'สีต้องเป็นของธีมเดิม');
  await save('system');
  html = await page('/');
  assert.match(html, /--font:-apple-system/);
  await save('thsarabun');
  html = await page('/');
  assert.match(html, /--font:'Web TH', 'Sarabun'/);
  assert.match(html, /sarabun\/400\.css/);
  await save('hack');
  assert.equal(await setting(), '');
  assert.match(await page('/'), /--font:'Noto Sans Thai Looped'/);
  await save('anuphan');
  await db.setSetting('ff_fontpick', '0');
  html = await page('/');
  assert.match(html, /--font:'Noto Sans Thai Looped'/);
  assert.doesNotMatch(html, /anuphan\/400\.css/);
  await db.setSetting('ff_fontpick', '1');
  await db.setSetting('web_font', '');
});

test('homelayout: เล่มใหม่อยู่บนเรียงเต็มแถว ความเคลื่อนไหวพับไว้ ปิดแล้วกลับเป็นแบบเดิม', async () => {
  await db.setSetting('ff_homelayout', '1');
  const on = await page('/');
  assert.match(on, /home-layout/);
  assert.match(on, /lib-fill/);
  assert.ok(on.indexOf('lib-fill') < on.indexOf('class="grid-4"'), 'เล่มใหม่ต้องอยู่เหนือกล่องตัวเลข');
  assert.match(on, /<details class="card home-activity"><summary>ความเคลื่อนไหวล่าสุด/);
  await db.setSetting('ff_homelayout', '0');
  const off = await page('/');
  assert.doesNotMatch(off, /home-layout|lib-fill|home-activity/);
  assert.match(off, /<h2>ความเคลื่อนไหวล่าสุด/);
  assert.ok(off.indexOf('เล่มใหม่ในคลัง') > off.indexOf('class="grid-4"'), 'ปิดแล้วเล่มใหม่กลับไปท้ายหน้า');
  await db.setSetting('ff_homelayout', '1');
});

test('homeorder: ค่าเสียไม่ทำให้พัง กล่องที่ต้องเห็นซ่อนไม่ได้ บันทึกแล้วหน้าแรกเปลี่ยน กลับค่าเริ่มต้นได้ ครูเข้าหน้าจัดไม่ได้', async () => {
  const homeorder = require('../src/homeorder');
  assert.deepEqual(homeorder.parse('พัง').map((b) => b.k), homeorder.BOXES.map((b) => b.k));
  const parsed = homeorder.parse(JSON.stringify([{ k: 'hack', on: true }, { k: 'inbox', on: false }, { k: 'inbox', on: true }, { k: 'stats', on: false }]));
  assert.equal(parsed.length, homeorder.BOXES.length);
  assert.equal(parsed[0].k, 'inbox');
  assert.equal(parsed[0].on, true, 'งานรอลงนามบนคอมซ่อนไม่ได้');
  assert.equal(parsed.find((b) => b.k === 'stats').on, false);

  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'admin', password: seed.DEMO_PASSWORD }) });
  const adminCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const post = (fields) => fetch(base + '/admin/homeorder', { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), headers: { cookie: adminCookie } });
  const form = await (await fetch(base + '/admin/homeorder', { headers: { cookie: adminCookie } })).text();
  assert.match(form, /data-home-order/);
  assert.equal((form.match(/data-ho-row/g) || []).length, homeorder.BOXES.length + homeorder.MOBILE_BOXES.length);
  assert.equal((await post({ action: 'save', home_order: JSON.stringify([{ k: 'subjects', on: true }, { k: 'lib', on: true }, { k: 'activity', on: false }]) })).status, 302);
  const home = await page('/');
  assert.match(home, /\.home-layout \.card\.flush\{order:1\}/);
  assert.match(home, /\.home-layout > \.lib-fill\{order:2\}/);
  assert.match(home, /home-activity\{order:3;display:none\}/);
  const teacher = await fetch(base + '/admin/homeorder', { redirect: 'manual', headers: { cookie } });
  assert.notEqual(teacher.status, 200, 'ครูเข้าหน้าจัดลำดับไม่ได้');
  await post({ action: 'reset' });
  assert.equal((await db.getSettings()).home_order, '');
  await db.setSetting('ff_homeorder', '0');
  assert.doesNotMatch(await page('/'), /<style>\.home-layout/);
  await db.setSetting('ff_homeorder', '1');
});

test('mobileorder: มือถือจัดแยกจากคอมได้ ใช้ลำดับเดียวกันได้ กล่องงานซ่อนไม่ได้ ปิดแล้วกลับแบบเดิม', async () => {
  const homeorder = require('../src/homeorder');
  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'admin', password: seed.DEMO_PASSWORD }) });
  const adminCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const post = (fields) => fetch(base + '/admin/homeorder', { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), headers: { cookie: adminCookie } });
  const form = await (await fetch(base + '/admin/homeorder', { headers: { cookie: adminCookie } })).text();
  assert.match(form, /data-ho-tab="m"/);
  assert.match(form, /name="home_order_m"/);

  const pc = JSON.stringify([{ k: 'lib', on: true }, { k: 'subjects', on: true }, { k: 'todo', on: false }]);
  await post({ action: 'save', home_order: pc, home_order_m: JSON.stringify([{ k: 'subjects', on: true }, { k: 'todo', on: false }, { k: 'lib', on: false }]), home_order_m_mode: 'own', home_alerts_pc: '1' });
  let home = await page('/');
  assert.match(home, /\.hm-layout > \.hm-subjects\{order:1\}/);
  assert.match(home, /\.hm-layout > \.m-next\{order:2;display:none\}/, 'กล่องงานบนมือถือปิดได้');
  assert.match(home, /<div class="d-only"><a class="alert alert-warn alert-strip"/, 'ปิดแจ้งเตือนเฉพาะมือถือ');
  assert.match(home, /\.hm-layout > \.lib-strip\{order:3;display:none\}/);
  assert.match(home, /\.home-layout > \.lib-fill\{order:1\}/, 'คอมยังใช้ลำดับของคอม');
  assert.match(home, /lib-compact/);

  await post({ action: 'save', home_order: pc, home_order_m: '[]', home_order_m_mode: 'same' });
  assert.equal((await db.getSettings()).home_order_m_mode, 'same');
  home = await page('/');
  assert.match(home, /\.hm-layout > \.lib-strip\{order:1\}/, 'โหมดเดียวกันใช้ลำดับของคอม');
  assert.match(home, /\.hm-layout > \.hm-subjects\{order:2\}/);
  assert.match(home, /\.hm-layout > \.m-next\{order:3;display:none\}/, 'โหมดเดียวกันซ่อนตามคอม');
  assert.doesNotMatch(home, /alert-strip"/, 'คอมปิดแจ้งเตือน มือถือตามคอม');

  assert.deepEqual(homeorder.parseMobile('พัง').map((b) => b.k), ['stats', 'todo', 'lib', 'subjects']);
  await post({ action: 'reset' });
  const after = await db.getSettings();
  assert.equal(after.home_order_m, '');
  assert.equal(after.home_order_m_mode, 'own');
  await db.setSetting('ff_mobileorder', '0');
  home = await page('/');
  assert.doesNotMatch(home, /class="m-only hm-layout"|lib-compact/);
  assert.doesNotMatch(await (await fetch(base + '/admin/homeorder', { headers: { cookie: adminCookie } })).text(), /data-ho-tab/);
  await db.setSetting('ff_mobileorder', '1');
});

test('helloslim: มีข้อความวันกำหนดส่งแบบสั้น ปิดแล้วไม่มี', async () => {
  await db.setSetting('ff_helloslim', '1');
  // ตัวทดสอบก่อนหน้าบันทึกหน้าตั้งค่าโดยไม่มีวันปิดรับ จึงกำหนดให้ชัด
  await db.setSetting('submit_open', '1');
  await db.setSetting('submit_end', '2099-12-30');
  const on = await page('/');
  assert.match(on, /hello-slim/);
  assert.match(on, /class="pill-short"/);
  await db.setSetting('ff_helloslim', '0');
  const off = await page('/');
  assert.doesNotMatch(off, /class="hello[^"]*hello-slim|class="pill-short"/);
  await db.setSetting('ff_helloslim', '1');
});

test('todoshort: แสดง 3 งานแรก ที่เหลือกดเปิดดู ปิดแล้วกลับแบบเดิม', async () => {
  await db.setSetting('ff_todoshort', '1');
  const on = await page('/');
  assert.match(on, /card home-todo todo-short/);
  assert.match(on, /card m-next todo-short/);
  assert.match(on, /<summary>ดูอีก \d+ งาน/);
  await db.setSetting('ff_todoshort', '0');
  const off = await page('/');
  assert.doesNotMatch(off, /todo-short|<summary>ดูอีก/);
  await db.setSetting('ff_todoshort', '1');
});

test('statslim: แถบตัวเลขแถวเดียวเฉพาะมือถือ คอมคงกล่องใหญ่ ปิดกล่องบนมือถือได้ ปิดสวิตช์แล้วหายจากมือถือ', async () => {
  await db.setSetting('ff_statslim', '1');
  const on = await page('/');
  assert.equal((on.match(/grid-4 stats-slim/g) || []).length, 1, 'มือถือ 1 ชุด');
  assert.equal((on.match(/class="grid-4"/g) || []).length, 1, 'คอมยังเป็นกล่องใหญ่');
  assert.match(on, /\.hm-layout > \.grid-4\{order:1\}/);
  await db.setSetting('home_order_m', JSON.stringify([{ k: 'stats', on: false }]));
  assert.match(await page('/'), /\.hm-layout > \.grid-4\{order:1;display:none\}/);
  await db.setSetting('home_order_m', '');
  await db.setSetting('ff_statslim', '0');
  const off = await page('/');
  assert.doesNotMatch(off, /grid-4 stats-slim/);
  assert.equal((off.match(/class="grid-4"/g) || []).length, 1);
  await db.setSetting('ff_statslim', '1');
});

test('deptall: ผู้ดูแลเห็นทุกกลุ่มแยกหัวกลุ่ม ส่งเตือนข้ามกลุ่มได้ หัวหน้ากลุ่มเห็นแค่กลุ่มตัวเอง ปิดแล้วกลับแบบเดิม', async () => {
  const signIn = async (username) => {
    const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password: seed.DEMO_PASSWORD }) });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const admin = await signIn('admin');
  const get = async (c, u) => (await fetch(base + u, { headers: { cookie: c } })).text();
  await db.setSetting('ff_deptall', '1');
  const one = await get(admin, '/dept');
  assert.match(one, /<option value="all" >ทุกกลุ่มสาระ/);
  const all = await get(admin, '/dept?dept=all');
  assert.match(all, /สถานะทุกกลุ่มสาระ/);
  assert.match(all, /<option value="all" selected>/);
  assert.ok((all.match(/class="dept-group"/g) || []).length >= 2, 'แยกหัวกลุ่มอย่างน้อย 2 กลุ่ม');
  assert.match(all, /ส่งครบ \d+ จาก \d+ คน/);
  assert.match(all, /name="dept" value="all"/);

  const teacherRow = await db.q.get("SELECT id FROM users WHERE username = 'teacher'");
  const before = (await db.q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', teacherRow.id)).n;
  const sent = await fetch(base + '/dept/remind', { method: 'POST', redirect: 'manual', headers: { cookie: admin }, body: new URLSearchParams([['dept', 'all'], ['ids', String(teacherRow.id)]]) });
  assert.equal(sent.status, 302);
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', teacherRow.id)).n, before + 1, 'ส่งเตือนจากหน้าทุกกลุ่มได้');

  const head = await signIn('mathhead');
  const headAll = await get(head, '/dept?dept=all');
  assert.doesNotMatch(headAll, /สถานะทุกกลุ่มสาระ|value="all"/, 'หัวหน้ากลุ่มสาระเห็นแค่กลุ่มตัวเอง');
  const refused = await fetch(base + '/dept/remind', { method: 'POST', redirect: 'manual', headers: { cookie: head }, body: new URLSearchParams([['dept', 'all'], ['ids', String(teacherRow.id)]]) });
  assert.equal((await db.q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', teacherRow.id)).n, before + 1, 'หัวหน้ากลุ่มอื่นส่งเตือนข้ามกลุ่มไม่ได้');
  assert.ok(refused.status < 500);

  await db.setSetting('ff_deptall', '0');
  const off = await get(admin, '/dept?dept=all');
  assert.doesNotMatch(off, /สถานะทุกกลุ่มสาระ|class="dept-group"|value="all"/);
  await db.setSetting('ff_deptall', '1');
});

test('readperm: คุมสิทธิ์อ่านรายตำแหน่ง เล่มที่ยังไม่ผ่านครบ เปิดชั่วคราว รายคน และปิดกลับแบบเดิม', async () => {
  const signIn = async (username) => {
    const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password: seed.DEMO_PASSWORD }) });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const admin = await signIn('admin');
  const me = await db.q.get("SELECT id, department_id FROM users WHERE username = 'teacher'");
  const fileOf = async (where, ...params) => {
    const f = await db.q.get(`SELECT f.id FROM files f JOIN submissions s ON s.id = f.submission_id WHERE f.is_current = 1 AND s.doc_type IN ('plan', 'manual') AND s.teacher_id != ? AND ${where} ORDER BY f.id LIMIT 1`, me.id, ...params);
    assert.ok(f, 'ข้อมูลทดลองต้องมีไฟล์นี้ ' + where);
    return f.id;
  };
  const otherApproved = await fileOf("s.status = 'approved' AND s.department_id != ?", me.department_id);
  const otherPending = await fileOf("s.status = 'pending' AND s.department_id != ?", me.department_id);
  // ข้อมูลทดลองไม่มีเล่มผ่านครบในกลุ่มสาระเดียวกัน จึงตั้งให้เล่มหนึ่งผ่านครบชั่วคราวในฐานข้อมูลของตัวทดสอบ
  const same = await db.q.get("SELECT s.id FROM submissions s JOIN files f ON f.submission_id = s.id AND f.is_current = 1 WHERE s.doc_type IN ('plan', 'manual') AND s.status = 'pending' AND s.teacher_id != ? AND s.department_id = ? ORDER BY s.id LIMIT 1", me.id, me.department_id);
  assert.ok(same);
  await db.q.run("UPDATE submissions SET status = 'approved' WHERE id = ?", same.id);
  const sameApproved = await fileOf("s.status = 'approved' AND s.department_id = ?", me.department_id);
  const status = async (id) => (await fetch(`${base}/f/${id}/view`, { redirect: 'manual', headers: { cookie } })).status;
  const save = (fields) => fetch(base + '/admin/readperm', { method: 'POST', redirect: 'manual', headers: { cookie: admin }, body: new URLSearchParams({ action: 'save', read_depthead: 'dept', ...fields }) });

  const page2 = await (await fetch(base + '/admin/readperm', { headers: { cookie: admin } })).text();
  assert.match(page2, /data-readperm/);
  assert.equal((await fetch(base + '/admin/readperm', { redirect: 'manual', headers: { cookie } })).status === 200, false, 'ครูเข้าหน้านี้ไม่ได้');

  // ค่าเริ่มต้น ครูเห็นแค่ปก
  assert.equal(await status(otherApproved), 404);
  assert.equal(await status(sameApproved), 404);
  // กลุ่มสาระตัวเอง
  await save({ read_teacher: 'dept' });
  assert.notEqual(await status(sameApproved), 404);
  assert.equal(await status(otherApproved), 404);
  // ทุกเล่ม เล่มที่ยังไม่ผ่านครบยังอ่านไม่ได้จนกว่าจะเปิดสวิตช์
  await save({ read_teacher: 'all' });
  assert.notEqual(await status(otherApproved), 404);
  assert.equal(await status(otherPending), 404);
  await save({ read_teacher: 'all', read_unapproved: '1' });
  assert.notEqual(await status(otherPending), 404);
  // ระดับเห็นแค่ปก เปิดสวิตช์ก็ไม่เพิ่มสิทธิ์
  await save({ read_teacher: 'cover', read_unapproved: '1' });
  assert.equal(await status(otherPending), 404);
  // เปิดชั่วคราว ต้องมีวันสิ้นสุด เลยวันแล้วกลับเป็นค่าหลัก
  await save({ read_teacher: 'cover', read_temp_on: '1' });
  assert.equal((await db.getSettings()).read_temp_on, '0', 'ไม่มีวันสิ้นสุดไม่บันทึก');
  await save({ read_teacher: 'cover', read_temp_on: '1', read_temp_until: '2099-12-31' });
  assert.notEqual(await status(otherApproved), 404);
  await save({ read_teacher: 'cover', read_temp_on: '1', read_temp_until: '2000-01-01' });
  assert.equal(await status(otherApproved), 404);
  // รายคน และวันสิ้นสุด
  await save({ read_teacher: 'cover', person_id: String(me.id), person_level: 'all', person_until: '2099-12-31' });
  assert.notEqual(await status(otherApproved), 404);
  await save({ read_teacher: 'cover', person_id: String(me.id), person_level: 'all', person_until: '2000-01-01' });
  assert.equal(await status(otherApproved), 404);
  // ปิดฟังก์ชันเสริม ค่าที่ตั้งไว้ไม่มีผล
  await save({ read_teacher: 'all' });
  await db.setSetting('ff_readperm', '0');
  assert.equal(await status(otherApproved), 404);
  await db.setSetting('ff_readperm', '1');
  // กลับเป็นค่าเริ่มต้น
  await fetch(base + '/admin/readperm', { method: 'POST', redirect: 'manual', headers: { cookie: admin }, body: new URLSearchParams({ action: 'reset' }) });
  assert.equal(await status(otherApproved), 404);
  assert.ok(await db.q.get("SELECT 1 AS x FROM audit_log WHERE action ILIKE 'ตั้งสิทธิ์อ่านงาน%'"));
  await db.q.run("UPDATE submissions SET status = 'pending' WHERE id = ?", same.id);
});
