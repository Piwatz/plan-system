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
  const box = on.slice(on.indexOf('class="card home-todo"'), on.indexOf('</section>', on.indexOf('class="card home-todo"')));
  assert.match(box, /ว30207 ถูกส่งกลับให้แก้ไข/);
  assert.match(box, /btn-danger">กดแก้ไข/);
  assert.match(box, /btn-primary">กดส่งคู่มือ/);
  assert.match(box, /วิทยาศาสตร์กายภาพ/, 'งานที่ยังไม่ส่งบอกชื่อวิชา ไม่ใช่คำว่าแตะ');
  assert.ok(on.indexOf('home-todo') < on.indexOf('class="grid-4"'), 'ต้องอยู่เหนือกล่องตัวเลข');
  await db.setSetting('ff_hometodo', '0');
  assert.doesNotMatch(await page('/'), /home-todo/);
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
