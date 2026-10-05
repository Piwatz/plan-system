// ไล่รายการตรวจภาคผนวก C ผ่านหน้าเว็บจริง (ตอน 13 บน wrangler dev · ใช้ซ้ำได้ในตอน 14 กับเว็บจริง)
// ทำแบบผู้ใช้จริงทุกขั้น: ผู้ดูแลตั้งค่า นำเข้าครู ครูส่งงาน (ไฟล์ส่งเป็นท่อนเข้าที่เก็บไฟล์จริง) ผู้ตรวจลงนามครบ 5 ระดับ บันทึกหลังแผน พิมพ์ QR สำรองข้อมูล
// ชื่อทุกคนเป็นชื่อสมมติ · ต่อท้ายชื่อผู้ใช้ด้วยรหัสรอบ รันซ้ำกับฐานเดิมได้
//
// node scripts/check-cloud.js --base http://localhost:8790 [--db postgres://...] [--insecure]
//   ผู้ดูแลระบบ: CHECK_ADMIN_USER และ CHECK_ADMIN_PASS หรืออ่านจาก data-dev/test-accounts.txt (บรรทัด "ผู้ดูแลระบบ: ชื่อ / รหัส")
//   --db  ต่อฐานตรงเพื่อยืนยันว่าข้อมูลเข้าฐานจริง (ในเครื่องคือ PGlite ที่พอร์ต 5433)
//   --insecure ยอมรับใบรับรองทดลองของ wrangler dev --local-protocol https
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { PDFDocument, PDFName, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');
const { uploadOne, formWithFiles, mergeLikeBrowser, XHR } = require('../tests/upload-client');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};
const BASE = String(opt('base', 'http://localhost:8790')).replace(/\/+$/, '');
const DB_URL = opt('db', '');
if (argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const RID = crypto.randomBytes(2).toString('hex');

// ---------- ผลตรวจ ----------
const results = [];
let section = '';
function check(name, ok, detail = '') {
  results.push({ section, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ผ่าน' : 'ไม่ผ่าน'}  [${section}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function part(name) {
  section = name;
  console.log(`\n== ${name} ==`);
}

// ---------- ตัวส่งคำขอ (แบบเดียวกับเบราว์เซอร์ จำ cookie ใส่ Origin) ----------
class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async req(method, url, body, headers = {}, raw = false) {
    const res = await fetch(BASE + url, { method, body, redirect: 'manual', headers: { cookie: this.header(), origin: BASE, ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const out = { status: res.status, location: res.headers.get('location'), headers: res.headers };
    if (raw) out.bytes = Buffer.from(await res.arrayBuffer());
    else out.text = await res.text();
    return out;
  }
  get(url, raw) {
    return this.req('GET', url, undefined, {}, raw);
  }
  post(url, fields, headers) {
    const body = fields instanceof FormData || fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
    return this.req('POST', url, body, headers);
  }
  // POST แล้วเปิดหน้าที่ถูกส่งต่อ (อ่านข้อความแจ้งผล)
  async postFollow(url, fields) {
    const r = await this.post(url, fields);
    if (r.status !== 302 && r.status !== 303) return r;
    return this.get(r.location.replace(BASE, ''));
  }
  async login(username, password) {
    const r = await this.post('/login', { username, password });
    return r;
  }
}

const flashOf = (html) => (/class="alert alert-\w+"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span><\/div>/.exec(html || '') || [])[1]?.trim() || '';
const noError = (r) => r.status < 400 && !/เกิดข้อผิดพลาดในระบบ/.test(r.text || '');

// ---------- ไฟล์ทดลอง ----------
async function pdf(title, pages = 1, padBytes = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`${title} page ${i + 1}`, { x: 72, y: 760, size: 20, font });
    // ไฟล์ใหญ่: ข้อมูลสุ่ม (บีบอัดไม่ได้) เป็น XObject ที่ไม่ถูกวาด ติดไปกับหน้าเวลารวม PDF
    if (padBytes && i === 0) {
      const raw = doc.context.stream(crypto.randomBytes(padBytes), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] });
      p.node.setXObject(PDFName.of('Pad'), doc.context.register(raw));
    }
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

// รูป PNG สีเดียว (โลโก้และลายเซ็นทดลอง)
function png(w = 40, h = 20, rgb = [20, 40, 160]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const SIGNATURE = 'data:image/png;base64,' + png(120, 40, [10, 10, 90]).toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function adminAccount() {
  if (process.env.CHECK_ADMIN_USER) return [process.env.CHECK_ADMIN_USER, process.env.CHECK_ADMIN_PASS || ''];
  const text = fs.readFileSync(path.join(__dirname, '..', 'data-dev', 'test-accounts.txt'), 'utf8');
  const m = /ผู้ดูแลระบบ:\s*(\S+)\s*\/\s*(\S+)/.exec(text);
  if (!m) throw new Error('ไม่พบบัญชีผู้ดูแลระบบทดลอง');
  return [m[1], m[2]];
}

async function main() {
  const db = DB_URL ? new (require('pg').Client)({ connectionString: DB_URL }) : null;
  if (db) await db.connect();
  const sql = async (text, ...values) => (db ? (await db.query(text, values)).rows : null);
  console.log(`ตรวจ ${BASE} รอบ ${RID}${db ? ' (ตรวจในฐานด้วย)' : ''}`);

  // ---------- ข้อ 1 และหน้าที่ข้อความเปลี่ยนบนคลาวด์ ----------
  part('ข้อ 1 เข้าระบบผู้ดูแล');
  const admin = new Client('admin');
  const [au, ap] = adminAccount();
  const al = await admin.login(au, ap);
  check('ผู้ดูแลเข้าระบบได้ (cookie ใช้ได้)', al.status === 302 && admin.cookies.plan_session, `status ${al.status}`);
  const home = await admin.get('/admin');
  check('หน้าผู้ดูแลระบบเปิดได้', home.status === 200);
  check('ที่อยู่สำหรับให้ครูเข้าใช้ เป็นข้อความแบบคลาวด์', /จากที่ไหนก็ได้ที่มีอินเทอร์เน็ต/.test(home.text) && !/Wi-Fi/.test(home.text));
  const anon = await new Client('anon').get('/setup');
  check('ตั้งค่าครั้งแรกแล้ว /setup ไม่เปิดให้คนอื่น', anon.status === 302 || anon.status === 404 || anon.status === 403, `status ${anon.status}`);

  // ---------- ข้อ 2 ตั้งค่าโรงเรียน โลโก้ ----------
  part('ข้อ 2 ตั้งค่าโรงเรียน');
  const sp = await admin.get('/admin/settings');
  check('หน้าตั้งค่า ข้อความ QR แบบคลาวด์', /ที่อยู่เว็บที่เปิดอยู่ตอนพิมพ์เอกสาร/.test(sp.text) && /ที่อยู่เว็บของระบบที่ได้ตอนติดตั้ง/.test(sp.text));
  const ta = (name) => {
    const m = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(sp.text);
    return m ? m[1].replace(/&#34;/g, '"').replace(/&amp;/g, '&') : '';
  };
  const theme = (/name="theme" value="(\w+)"[^>]*checked/.exec(sp.text) || [])[1] || '';
  const settings = (extra = {}) => {
    const f = new FormData();
    const base = {
      school_name: 'โรงเรียนชานุมานวิทยาคม',
      school_location: 'อำเภอชานุมาน จังหวัดอำนาจเจริญ',
      academic_year: '2569',
      semester: '2',
      submit_open: '1',
      submit_start: '',
      submit_end: '2026-12-30',
      max_upload_mb: '20',
      grade_levels: ta('grade_levels'),
      teaching_methods: ta('teaching_methods'),
      public_url: BASE,
      mobile_layout: 'simple',
      theme,
      ...extra,
    };
    for (const [k, v] of Object.entries(base)) if (v !== undefined && !(v instanceof Blob)) f.append(k, v);
    for (const [k, v] of Object.entries(extra)) if (v instanceof Blob) f.append(k, v, k + '.png');
    return f;
  };
  const logo = new Blob([png(64, 64, [200, 120, 20])], { type: 'image/png' });
  const s1 = await admin.postFollow('/admin/settings', settings({ logo, memo_logo: new Blob([png(64, 64, [0, 0, 0])], { type: 'image/png' }) }));
  check('บันทึกค่าตั้งพร้อมโลโก้และตราครุฑ (อัปโหลดรูปผ่าน multer บน Workers)', /บันทึกการตั้งค่าเรียบร้อย/.test(flashOf(s1.text)), flashOf(s1.text));
  const sp2 = await admin.get('/admin/settings');
  const logoUrl = (/\/media\/logo\?v=\w+/.exec(sp2.text) || [])[0];
  check('หน้าตั้งค่าแสดงโลโก้ใหม่', Boolean(logoUrl));
  const lg = await admin.get(logoUrl || '/media/logo', true);
  check('เปิดรูปโลโก้ได้ ไบต์ตรงกับที่ส่ง', lg.status === 200 && sha(lg.bytes) === sha(png(64, 64, [200, 120, 20])), `status ${lg.status}`);
  const lp = await new Client('anon').get('/login');
  check('หน้าเข้าสู่ระบบใช้โลโก้ใหม่', lp.text.includes('/media/logo?v='));
  const sv = await admin.get('/');
  check('ปีการศึกษาและภาคเรียนบันทึกแล้ว', /2569/.test(sv.text));
  if (db) {
    const rows = await sql("SELECT key, length(value) AS n FROM settings WHERE key IN ('school_logo','memo_logo','academic_year','semester','submit_end')");
    const m = Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
    check('ในฐาน: โลโก้ ตราครุฑ ปี ภาค วันปิดรับ', m.school_logo > 100 && m.memo_logo > 100 && m.academic_year === 4 && m.submit_end === 10);
  }
  const s2 = await admin.postFollow('/admin/settings', settings({ remove_logo: '1' }));
  const lg2 = await admin.get('/media/logo', true);
  check('ลบโลโก้ได้', /บันทึกการตั้งค่าเรียบร้อย/.test(flashOf(s2.text)) && lg2.status === 404 && !(await admin.get('/admin/settings')).text.includes('/media/logo?v='), `status ${lg2.status}`);

  // ---------- ข้อ 3 กลุ่มสาระ รายชื่อครู ขั้นตอน แบบประเมิน นำเข้ารายวิชา ----------
  part('ข้อ 3 กลุ่มสาระและรายชื่อ');
  const dname = `กลุ่มทดลองลบ ${RID}`;
  await admin.postFollow('/admin/departments', { name: dname });
  let dp = await admin.get('/admin/departments');
  const did = (new RegExp(`action="/admin/departments/(\\d+)"[\\s\\S]{0,400}?value="${dname}"`).exec(dp.text) || [])[1];
  check('เพิ่มกลุ่มสาระได้', Boolean(did));
  const del = await admin.postFollow(`/admin/departments/${did}/delete`, {});
  check('ลบกลุ่มสาระที่ไม่มีคนได้', /ลบกลุ่มสาระเรียบร้อย/.test(flashOf(del.text)) && !del.text.includes(`value="${dname}"`), flashOf(del.text));
  dp = await admin.get('/admin/departments');
  const sciId = (/action="\/admin\/departments\/(\d+)"[\s\S]{0,400}?value="วิทยาศาสตร์และเทคโนโลยี"/.exec(dp.text) || [])[1];

  const pin = String(1000 + crypto.randomInt(9000));
  const U = (k) => `${k}_${RID}`;
  const people = [
    [U('t1'), `นายสมมติ ครูทดลองหนึ่ง${RID}`, 'ครู', 'วิทยาศาสตร์และเทคโนโลยี', ''],
    [U('t2'), `นางสาวสมมติ ครูทดลองสอง${RID}`, 'ครู', 'วิทยาศาสตร์และเทคโนโลยี', ''],
    [U('h1'), `นางสมมติ หัวหน้าทดลอง${RID}`, 'ครู', 'วิทยาศาสตร์และเทคโนโลยี', 'หัวหน้ากลุ่มสาระ'],
    [U('s1'), `นายสมมติ หัวหน้างานทดลอง${RID}`, 'ครู', 'คณิตศาสตร์', 'หัวหน้างาน'],
    [U('a1'), `นายสมมติ วิชาการทดลอง${RID}`, 'ครู', 'ภาษาไทย', 'หัวหน้ากลุ่มบริหารงานวิชาการ'],
    [U('d1'), `นายสมมติ รองทดลอง${RID}`, 'รองผู้อำนวยการ', '', 'รองผู้อำนวยการ'],
    [U('p1'), `นายสมมติ ผู้อำนวยการทดลอง${RID}`, 'ผู้อำนวยการ', '', 'ผู้อำนวยการ'],
  ];
  const imp = await admin.post('/admin/users-import', { password: pin, data: ['ชื่อผู้ใช้\tชื่อ สกุล\tตำแหน่ง\tกลุ่มสาระ\tบทบาท', ...people.map((p) => p.join('\t'))].join('\n') });
  check('วางรายชื่อครูจาก Excel พร้อมบทบาทผู้ตรวจ 7 คน', /เพิ่มใหม่ <b>7<\/b> คน/.test(imp.text), (/เพิ่มใหม่[^<]*<b>\d+<\/b>[^<]*/.exec(imp.text) || [''])[0]);
  fs.appendFileSync(path.join(__dirname, '..', 'data-dev', 'test-accounts.txt'), `รอบ ${RID}: ${people.map((p) => p[0]).join(' ')} รหัสเริ่มต้น ${pin}\n`);
  const delUsed = await admin.postFollow(`/admin/departments/${sciId}/delete`, {});
  check('กลุ่มสาระที่มีคนลบไม่ได้', /ลบไม่ได้/.test(flashOf(delUsed.text)), flashOf(delUsed.text));
  const wfp = await admin.get('/admin/workflow');
  check('หน้าขั้นตอนการตรวจเปิดได้ มีผู้ตรวจตามที่นำเข้า', wfp.status === 200 && wfp.text.includes(`ผู้อำนวยการทดลอง${RID}`));
  const rb = await admin.get('/admin/rubric?type=plan');
  check('หน้าแบบประเมินเปิดได้', rb.status === 200 && (rb.text.match(/name="text_\d+"|name="item_\d+"|<textarea/g) || []).length >= 1);
  const tti = await admin.get('/admin/teach-import');
  check('หน้านำเข้ารายวิชา ข้อความแบบคลาวด์', /เช่น ผ่านแฟลชไดรฟ์หรือ Google Drive/.test(tti.text));
  const ttjson = { teachers: [{ id: 1, name: `นายสมมติ ครูทดลองสอง${RID}` }], classes: [{ id: 'c1', level: 'ม.5' }], lessons: [{ subj: 'ว32101', subjName: 'ฟิสิกส์ทดลอง 2', teachers: [1], cls: 'c1' }, { subj: 'ก32901', subjName: 'ชุมนุมทดลอง', teachers: [1], cls: 'c1' }] };
  const tf = new FormData();
  tf.append('ttfile', new Blob([JSON.stringify(ttjson)], { type: 'application/json' }), 'งานล่าสุด.json');
  const tp = await admin.post('/admin/teach-import/preview', tf);
  const t2id = (/name="map_\d+"[\s\S]*?<option value="(\d+)"[^>]*selected/.exec(tp.text) || [])[1];
  check('อ่านไฟล์ งานล่าสุด.json (ชื่อสมมติ) และจับคู่ครูได้ ไม่รวมวิชากิจกรรม', tp.status === 200 && Boolean(t2id) && tp.text.includes('ว32101') && !tp.text.includes('value="ก32901"'), `status ${tp.status}`);
  if (t2id) {
    const tif = new URLSearchParams({ year: '2569', semester: '2', n: '1', map_0: t2id, subj_0: JSON.stringify([{ code: 'ว32101', name: 'ฟิสิกส์ทดลอง 2', grade: 'ม.5' }]), pick_0: 'ว32101' });
    const ti = await admin.postFollow('/admin/teach-import', tif);
    check('นำเข้ารายวิชาที่สอนได้', /เพิ่มรายวิชาใหม่ 1 รายการ/.test(ti.text));
  }

  // ---------- ข้อ 4 ฟังก์ชันเสริม ----------
  part('ข้อ 4 ฟังก์ชันเสริม');
  const fp = await admin.get('/admin/features');
  check('หน้าฟังก์ชันเสริม ข้อความ LINE และพูดแทนพิมพ์แบบคลาวด์', /ช้ากว่าเวลาที่ตั้งไว้ไม่เกิน 5 นาที/.test(fp.text) && /ครูพิมพ์ข้อความในช่องบันทึกเองตามปกติ/.test(fp.text) && !/เครื่องที่ติดตั้งระบบ/.test(fp.text));
  await admin.post('/admin/features/voice', { on: '1' });
  const f2 = await admin.postFollow('/admin/features/voice', { on: '0' });
  check('เปิดแล้วปิดสวิตช์ได้ ประวัติขึ้น', /พูดแทนพิมพ์/.test(f2.text) && (f2.text.match(/พูดแทนพิมพ์/g) || []).length >= 3);
  if (db) {
    const n = Number((await sql("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE '%พูดแทนพิมพ์%'"))[0].n);
    check('ในฐาน: audit_log มีประวัติเปิดปิด', n >= 2, `${n} แถว`);
    const upd = await db.query('UPDATE audit_log SET action = action').then(() => 'ok', (e) => e.message);
    const dl = await db.query('DELETE FROM audit_log').then(() => 'ok', (e) => e.message);
    check('ในฐาน: แก้หรือลบ audit_log ไม่ได้', upd !== 'ok' && dl !== 'ok', `${upd.slice(0, 50)} · ${dl.slice(0, 50)}`);
  }

  // ---------- ข้อ 5 ครูเข้าระบบ ----------
  part('ข้อ 5 ครูเข้าระบบ');
  const newPin = String(1000 + ((Number(pin) + 1234) % 9000));
  // รองผู้อำนวยการและผู้อำนวยการต้องตั้งรหัส 6 ตัวขึ้นไปเสมอ (auth.minPassword)
  const pwOf = (key) => (['d1', 'p1'].includes(key) ? newPin + '99' : newPin);
  async function enter(key) {
    const c = new Client(key);
    const r = await c.login(U(key).toUpperCase(), pin);
    const forced = r.location && r.location.endsWith('/password');
    const ch = await c.postFollow('/password', { password: pwOf(key), password2: pwOf(key) });
    await c.post('/profile', { position: 'ครู', signature: SIGNATURE });
    return { c, forced, changed: /เปลี่ยนรหัสผ่านเรียบร้อย/.test(flashOf(ch.text)) };
  }
  const lpage = await new Client('anon').get('/login');
  check('หน้าเข้าสู่ระบบมีรายชื่อให้เลือก', lpage.text.includes(`นายสมมติ ครูทดลองหนึ่ง${RID}`));
  const T = await enter('t1');
  check('ชื่อผู้ใช้ตัวพิมพ์ใหญ่และรหัส 4 หลักเข้าได้ ครั้งแรกถูกบังคับเปลี่ยนรหัส', T.forced && T.changed);
  const pr = await T.c.get('/profile');
  check('เซ็นชื่อในข้อมูลส่วนตัวแล้ว', /\/media\/signature/.test(pr.text) || /บันทึกข้อมูลส่วนตัวเรียบร้อย/.test(pr.text));
  const ta1 = await T.c.postFollow('/teaching/add', { subject_code: 'ว31101', subject_name: 'ฟิสิกส์ทดลอง 1', grade_level: 'ม.4', is_main: '1' });
  const ta2 = await T.c.postFollow('/teaching/add', { subject_code: 'ว31102', subject_name: 'เคมีทดลอง 1', grade_level: 'ม.4' });
  const ta3 = await T.c.postFollow('/teaching/add', { subject_code: 'ก31901', subject_name: 'ชุมนุม', grade_level: 'ม.4' });
  check('เลือกรายวิชาที่สอนและวิชาหลัก วิชากิจกรรมไม่รับ', /เป็นวิชาหลัก/.test(flashOf(ta1.text)) && /เพิ่มวิชา ว31102/.test(flashOf(ta2.text)) && /ไม่ต้องส่งแผน/.test(flashOf(ta3.text)));

  // ---------- ข้อ 6 ส่งงาน ----------
  part('ข้อ 6 ส่งงานและไฟล์');
  const sendWork = async (c, fields, files, o) => {
    const r = await formWithFiles(c, fields.url || '/works', fields, files, o);
    if (r.error) return { error: r.error, status: r.status };
    const s = await c.req('POST', fields.url || '/works', r.fields, XHR);
    let j = {};
    try {
      j = JSON.parse(s.text);
    } catch {
      j = { error: s.text.slice(0, 120) };
    }
    return { status: s.status, ...j, id: Number((/\/s\/(\d+)/.exec(j.redirect || '') || [])[1]) || null };
  };
  const manualPdf = await pdf('Manual demo', 2);
  const t0 = Date.now();
  const man = await sendWork(T.c, { doc_type: 'manual', subject_code: 'ว31102', subject_name: 'เคมีทดลอง 1', grade_level: 'ม.4', action: 'submit' }, [[manualPdf, 'คู่มือ เคมีทดลอง.pdf']]);
  const manPage = man.id ? await T.c.get(`/s/${man.id}`) : { text: '' };
  check('ส่งคู่มือรายวิชา PDF เดียว', man.id && /รอ/.test(manPage.text), `${Date.now() - t0} ms ${man.error || ''}`);
  // แผน: 3 ไฟล์ เรียงใหม่ก่อนรวม (ไฟล์ C ก่อน A) ไฟล์หนึ่งใหญ่ราว 11 MB ให้ส่งหลายท่อน
  const pa = await pdf('Plan part A', 1);
  const pb = await pdf('Plan part B big', 2, 11 * 1024 * 1024);
  const pc = await pdf('Plan part C', 1);
  const order = [[pc, 'ค.pdf'], [pa, 'ก.pdf'], [pb, 'ข.pdf']];
  const merged = await mergeLikeBrowser(order);
  const t1 = Date.now();
  const plan = await sendWork(T.c, { doc_type: 'plan', subject_code: 'ว31101', subject_name: 'ฟิสิกส์ทดลอง 1', grade_level: 'ม.4', teaching_methods: 'การทดลอง', action: 'submit' }, order, { merge: true });
  const planMs = Date.now() - t1;
  const planPage = plan.id ? await T.c.get(`/s/${plan.id}`) : { text: '' };
  check('ส่งแผน 3 ไฟล์รวมเป็นไฟล์เดียว (เรียงใหม่ก่อนรวม) ส่งเป็นท่อนผ่าน Workers', plan.id && /รอ/.test(planPage.text) && (planPage.text.match(/data-view-file=/g) || []).length === 1, `${(merged.blob.size / 1048576).toFixed(1)} MB ${merged.pages} หน้า ${planMs} ms ${plan.error || ''}`);
  const fileId = (/data-view-file="\/f\/(\d+)"/.exec(planPage.text) || [])[1];
  const raw = fileId ? await T.c.get(`/f/${fileId}/raw`, true) : { bytes: Buffer.alloc(0) };
  check('ดาวน์โหลดไฟล์แผนกลับมา ไบต์ตรงกับที่รวมในเบราว์เซอร์ทุกไบต์', raw.status === 200 && sha(raw.bytes) === sha(Buffer.from(await merged.blob.arrayBuffer())), `${raw.bytes.length} ไบต์`);
  const rng = fileId ? await T.c.req('GET', `/f/${fileId}/raw`, undefined, { range: 'bytes=0-7' }, true) : {};
  check('ขอช่วงไฟล์ (Range) ได้ 8 ไบต์แรก', rng.status === 206 && rng.bytes.toString('latin1') === '%PDF-1.7'.slice(0, 8) || (rng.status === 206 && rng.bytes.slice(0, 5).toString() === '%PDF-'), `status ${rng.status}`);
  const wrong = await uploadOne(T.c, new Blob(['MZ fake exe']), 'โปรแกรม.exe', { form: '/works', field: 'main_files', count: '1', doc_type: 'manual' });
  check('ไฟล์ผิดชนิดถูกปฏิเสธพร้อมข้อความไทย', wrong.error && /[ก-๙]/.test(wrong.error), wrong.error);
  const broken = await sendWork(T.c, { doc_type: 'manual', subject_code: 'ว39999', subject_name: 'ไฟล์เสีย', grade_level: 'ม.4', action: 'save' }, [[new Blob(['not a pdf at all']), 'เสีย.pdf']]);
  check('ไฟล์เสีย (นามสกุลไม่ตรงไฟล์จริง) ถูกปฏิเสธ', broken.error && /[ก-๙]/.test(broken.error), broken.error);
  const huge = await uploadOne(T.c, { size: 25 * 1024 * 1024, slice: () => new Blob([]) }, 'ใหญ่.pdf', { form: '/works', field: 'main_files', count: '1', doc_type: 'manual' });
  check('ไฟล์เกินเพดาน 20 MB ถูกปฏิเสธพร้อมข้อความไทย', huge.error && /MB/.test(huge.error), huge.error);
  // กดส่งสองครั้งพร้อมกัน (คู่มือวิชาหลัก)
  const twin = await Promise.all([1, 2].map(() => sendWork(T.c, { doc_type: 'manual', subject_code: 'ว31101', subject_name: 'ฟิสิกส์ทดลอง 1', grade_level: 'ม.4', action: 'submit' }, [[manualPdf, 'คู่มือ ฟิสิกส์.pdf']])));
  const okCount = twin.filter((x) => x.id).length;
  check('กดส่งสองครั้งพร้อมกันได้งานเดียว', okCount === 1 && twin.some((x) => /ส่งไว้แล้ว/.test(x.error || '')), twin.map((x) => x.id || x.error).join(' · '));
  if (db) {
    const n = Number((await sql("SELECT COUNT(*) AS n FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE u.username = $1 AND s.subject_code = 'ว31101' AND s.doc_type = 'manual'", U('t1')))[0].n);
    check('ในฐาน: คู่มือ ว31101 มีแถวเดียว', n === 1, `${n} แถว`);
    const f = await sql("SELECT f.stored_name, f.size FROM files f WHERE f.submission_id = $1 AND f.is_current = 1", plan.id);
    check('ในฐาน: ไฟล์แผนอยู่ในที่เก็บไฟล์ของคลาวด์ (gdrive:)', f.length === 1 && /^gdrive:/.test(f[0].stored_name), f[0] && f[0].stored_name.slice(0, 12));
  }
  const man2 = twin.find((x) => x.id);

  // ---------- ข้อ 7 ตรวจ ให้คะแนน ลงนาม 5 ระดับ ----------
  part('ข้อ 7 ตรวจและลงนาม');
  const H = await enter('h1');
  const inbox = await H.c.get('/inbox');
  check('หัวหน้ากลุ่มสาระเห็นงานในกล่องงาน', inbox.text.includes('ว31101') && inbox.text.includes('ว31102'));
  const ret = await H.c.postFollow(`/s/${man.id}/return`, { comment: 'ทดลองส่งคืน แก้หน้าปก' });
  check('ส่งคืนให้ครูแก้ได้', /ส่งกลับให้ครูแก้ไขเรียบร้อย/.test(flashOf(ret.text)));
  const resub = await T.c.postFollow(`/s/${man.id}/submit`, {});
  check('ครูส่งใหม่หลังแก้ได้', /ส่ง/.test(flashOf(resub.text)) && !/ไม่/.test(flashOf(resub.text).slice(0, 4)), flashOf(resub.text));
  const scoreFields = async (c, id, values) => {
    const page = await c.get(`/s/${id}`);
    const ids = [...new Set([...page.text.matchAll(/name="score_(\d+)"/g)].map((m) => m[1]))];
    return { n: ids.length, fields: Object.fromEntries(ids.map((x, i) => [`score_${x}`, String(values(i))])) };
  };
  const ps = await scoreFields(H.c, plan.id, (i) => (i < 10 ? 5 : 4));
  const ap1 = await H.c.postFollow(`/s/${plan.id}/approve`, { ...ps.fields, comment: 'ทดลองลงนาม' });
  const pv = await admin.get(`/s/${plan.id}`);
  check('ให้คะแนน 20 ข้อ ได้ 90 ระดับดีมาก แล้วลงนามส่งต่อ', ps.n === 20 && /ส่งต่อให้/.test(flashOf(ap1.text)) && /90/.test(pv.text) && /ดีมาก/.test(pv.text), `${ps.n} ข้อ ${flashOf(ap1.text).slice(0, 60)}`);
  const ms = await scoreFields(H.c, man.id, () => 3);
  await H.c.post(`/s/${man.id}/approve`, { ...ms.fields });
  const chain = [];
  for (const key of ['s1', 'a1', 'd1', 'p1']) {
    const R = await enter(key);
    const r = await R.c.postFollow(`/s/${plan.id}/approve`, { comment: '' });
    chain.push(flashOf(r.text));
  }
  check('ไล่ลงนามครบ 5 ระดับ งานผ่านครบ', /ผ่านครบทุกระดับ/.test(chain[3] || ''), chain.map((x) => x.slice(0, 30)).join(' | '));
  if (db) {
    const rv2 = await sql("SELECT role FROM reviews WHERE submission_id = $1 AND action = 'approve' ORDER BY id", plan.id);
    const st = (await sql('SELECT status FROM submissions WHERE id = $1', plan.id))[0].status;
    check('ในฐาน: แผนสถานะ approved ลงนามครบ 5 ระดับตามลำดับ', st === 'approved' && rv2.map((r) => r.role).join(' ') === 'dept_head section_head academic_head deputy_academic director', `${st} ${rv2.map((r) => r.role).join(' ')}`);
  }
  // ผู้ตรวจลงนามงานของตัวเอง (selfsign)
  const own = await sendWork(H.c, { doc_type: 'manual', subject_code: 'ว33201', subject_name: 'ชีววิทยาทดลอง', grade_level: 'ม.6', action: 'submit' }, [[manualPdf, 'คู่มือ ชีววิทยา.pdf']]);
  const os1 = await scoreFields(H.c, own.id, () => 4);
  const oa = await H.c.postFollow(`/s/${own.id}/approve`, os1.fields);
  check('หัวหน้ากลุ่มสาระลงนามงานของตัวเองได้ (selfsign)', /ลงนามเรียบร้อย/.test(flashOf(oa.text)), flashOf(oa.text));

  // ---------- ข้อ 8 บันทึกหลังแผน ----------
  part('ข้อ 8 บันทึกหลังแผน');
  const nf = await T.c.get(`/notes/new?plan=${plan.id}`);
  check('หน้าเขียนบันทึกมีประโยคสำเร็จรูป', nf.status === 200 && /data-chip|chip/.test(nf.text));
  const n1 = await sendWork(T.c, { url: '/notes', plan_id: String(plan.id), plan_no: '', topic: 'เรื่องทดลองไม่มีเลขแผน', note_mode: 'type', result_k: 'นักเรียนอธิบายแรงได้', result_p: 'ทดลองเป็นกลุ่ม', result_a: 'ตั้งใจเรียน', action: 'save' }, []);
  const n2 = await sendWork(T.c, { url: '/notes', plan_id: String(plan.id), plan_no: 'ก', topic: 'เลขแผนเป็นตัวอักษร', note_mode: 'type', result_k: 'ทดลอง', action: 'save' }, []);
  const n3 = await sendWork(T.c, { url: '/notes', plan_id: String(plan.id), plan_no: '3', note_mode: 'file', action: 'save' }, [[await pdf('Note file'), 'บันทึกของฉัน.pdf']], { field: 'attach_files' });
  check('เลขแผนว่าง ตัวอักษร และแนบไฟล์ของตัวเอง บันทึกได้ไม่พัง', n1.id && n2.id && n3.id, [n1, n2, n3].map((x) => x.id || x.error).join(' · '));
  const nf2 = await T.c.get(`/notes/new?plan=${plan.id}`);
  check('คัดลอกจากฉบับก่อนได้ (มีข้อความฉบับก่อน)', /นักเรียนอธิบายแรงได้|ทดลอง/.test(nf2.text));
  const sm = await T.c.postFollow('/notes/submit-many', new URLSearchParams([['ids', n1.id], ['ids', n2.id], ['ids', n3.id]].map(([k, v]) => [k, String(v)])));
  check('ส่งบันทึกหลายฉบับพร้อมกัน', /ส่งบันทึกหลังแผนเรียบร้อย 3 ฉบับ/.test(flashOf(sm.text)), flashOf(sm.text));
  const qs = await H.c.get('/quicksign');
  check('หน้าลงนามแบบไล่การ์ดเปิดได้', qs.status === 200 && /เรื่องทดลองไม่มีเลขแผน|บันทึก/.test(qs.text));
  const qr1 = await H.c.post(`/quicksign/${n1.id}/approve`, {});
  const qra = await H.c.post('/quicksign/approve-rest', {});
  const roles = db ? (await sql('SELECT role FROM reviews WHERE submission_id = ANY($1) AND action = $2', [n1.id, n2.id, n3.id], 'approve')).length : 3;
  check('ลงนามไล่การ์ด และลงนามที่เหลือทั้งหมด', qr1.status === 302 && qra.status === 302 && roles === 3, `${qr1.status} ${qra.status} ลงนามในฐาน ${roles} ฉบับ`);

  // ---------- ข้อ 9 พิมพ์และ QR ----------
  part('ข้อ 9 พิมพ์และ QR');
  const memo = await admin.get(`/s/${plan.id}/print`);
  const evalp = await admin.get(`/s/${plan.id}/print?doc=eval`);
  const notesp = await admin.get(`/s/${plan.id}/print-notes`);
  check('พิมพ์บันทึกข้อความ แบบประเมิน บันทึกหลังแผนทั้งเล่ม เปิดได้ มี QR', [memo, evalp, notesp].every((r) => r.status === 200 && r.text.includes('<svg')), [memo, evalp, notesp].map((r) => r.status).join(' '));
  check('หน้าพิมพ์มีลายเซ็นผู้ลงนามจริง', /\/media\/signature|data:image\/png/.test(memo.text));
  if (db) {
    const code = (await sql('SELECT verify_code FROM submissions WHERE id = $1', plan.id))[0].verify_code;
    const want = await QRCode.toString(`${BASE}/v/${code}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    check('QR ในหน้าพิมพ์ชี้ไปที่ public_url/v/รหัส', memo.text.includes(want), `${BASE}/v/${code.slice(0, 6)}...`);
    const v = await new Client('anon').get(`/v/${code}`);
    check('สแกน /v/รหัส โดยไม่เข้าระบบ เห็นผลตรวจ', v.status === 200 && v.text.includes('ว31101'));
  }

  // ---------- ข้อ 10 เปิดไฟล์ ----------
  part('ข้อ 10 เปิดไฟล์');
  const view = await T.c.get(`/f/${fileId}/view`);
  check('ตัวแสดง PDF ในหน้าเว็บเปิดได้', view.status === 200 && /pdfview\.js/.test(view.text));
  const dl = await T.c.get(`/f/${fileId}?dl=1`, true);
  const cd = dl.headers.get('content-disposition') || '';
  check('ดาวน์โหลดได้ ชื่อไฟล์ภาษาไทยถูก', dl.status === 200 && /^attachment/.test(cd) && decodeURIComponent((/filename\*=UTF-8''(.+)$/.exec(cd) || [])[1] || '').includes('แผนการจัดการเรียนรู้ ว31101'), decodeURIComponent((/filename\*=UTF-8''(.+)$/.exec(cd) || [])[1] || ''));
  check('ไฟล์ไม่มี ETag (ไม่ให้ Workers คำนวณทั้งไฟล์)', !dl.headers.get('etag'));

  // ---------- ข้อ 11 ผู้ดูแลดำเนินการแทน ----------
  part('ข้อ 11 ดำเนินการแทน');
  const adv = await admin.postFollow(`/s/${man.id}/admin-advance`, { comment: 'ทดลองดำเนินการแทน' });
  const fin = await admin.postFollow(`/s/${man2.id}/admin-finish`, { comment: '' });
  check('ดันผ่านระดับที่ค้าง และให้ผ่านครบ', /ดำเนินการแทนแล้ว/.test(flashOf(adv.text)) && /ผ่านครบทุกระดับ/.test(flashOf(fin.text)), `${flashOf(adv.text).slice(0, 40)} | ${flashOf(fin.text).slice(0, 40)}`);
  if (db) {
    const o = await sql("SELECT COUNT(*) AS n FROM reviews WHERE submission_id = ANY($1) AND action = 'override'", [man.id, man2.id]);
    const a = await sql("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'ดำเนินการแทน%' OR action LIKE 'ให้ผ่านครบ%'");
    check('ในฐาน: reviews มี override และ audit_log บันทึกไว้', Number(o[0].n) >= 2 && Number(a[0].n) >= 2, `override ${o[0].n} · audit ${a[0].n}`);
  }

  // ---------- ข้อ 12 หน้าอื่น ๆ ----------
  part('ข้อ 12 หน้าอื่น ๆ');
  const tPages = ['/', '/my', '/notes', '/alerts', '/results', '/pa', '/pa/print', '/teaching', '/profile'];
  const hPages = ['/', '/inbox', '/dept', '/registry', '/registry?type=note', '/stats', '/quicksign'];
  const bad = [];
  for (const u of tPages) if (!noError(await T.c.get(u))) bad.push('ครู ' + u);
  for (const u of hPages) if (!noError(await H.c.get(u))) bad.push('หัวหน้า ' + u);
  for (const u of ['/registry', '/stats', '/admin/users', '/admin/subjects', '/admin/users-import']) if (!noError(await admin.get(u))) bad.push('ผู้ดูแล ' + u);
  check('ทุกหน้าเปิดได้ไม่มีข้อผิดพลาด', bad.length === 0, bad.join(' ') || `${tPages.length + hPages.length + 5} หน้า`);
  const csv = await admin.get('/registry.csv', true);
  check('ส่งออก CSV ได้', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && csv.bytes.toString('utf8').includes('ว31101'));
  const t2 = await enter('t2');
  const deptPage = await H.c.get('/dept');
  const t2uid = db ? String((await sql('SELECT id FROM users WHERE username = $1', U('t2')))[0].id) : (/name="ids" value="(\d+)"/.exec(deptPage.text) || [])[1];
  const rem = await H.c.postFollow('/dept/remind', { dept: sciId, ids: t2uid });
  const al2 = await t2.c.get('/alerts');
  check('หัวหน้ากลุ่มสาระส่งเตือน ครูเห็นการแจ้งเตือน', /เตือน/.test(flashOf(rem.text)) && /เตือน|ยังไม่ส่ง/.test(al2.text), flashOf(rem.text).slice(0, 60));
  const tHome = await T.c.get('/');
  check('ตัวเลขบนเมนูไม่ขึ้น 0', !/class="(nav-)?badge[^"]*"[^>]*>\s*0\s*</.test(tHome.text));

  // ---------- ข้อ 14 สำรองข้อมูล ----------
  part('ข้อ 14 สำรองข้อมูล');
  const bk = await admin.get('/admin/backup', true);
  let tables = [];
  try {
    const j = JSON.parse(bk.bytes.toString('utf8'));
    tables = Object.keys(j.tables || j).filter((k) => Array.isArray((j.tables || j)[k]));
  } catch {
    tables = [];
  }
  check('ได้ไฟล์ JSON ครบ 13 ตาราง', bk.status === 200 && tables.length === 13, `${tables.length} ตาราง ${(bk.bytes.length / 1024).toFixed(0)} KB`);

  // ---------- ข้อ 15 เวลาไทย ----------
  part('ข้อ 15 เวลาไทย');
  if (db) {
    const last = (await sql('SELECT submitted_at FROM submissions WHERE id = $1', plan.id))[0].submitted_at;
    const thai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(t1));
    const diff = Math.abs(Date.parse(last.replace(' ', 'T') + 'Z') - Date.parse(thai.replace(' ', 'T') + 'Z')) / 1000;
    check('เวลาที่ Workers บันทึกเป็นเวลาไทย', diff < 180, `ในฐาน ${last} · นาฬิกาไทยตอนส่ง ${thai}`);
  }

  // ---------- ข้อ 17 ออกจากระบบ และล็อกเมื่อผิดหลายครั้ง ----------
  part('ข้อ 17 ออกจากระบบและล็อก');
  const lo = await t2.c.post('/logout', {});
  const afterLo = await t2.c.get('/');
  check('ออกจากระบบแล้วต้องเข้าใหม่', lo.status === 302 && afterLo.status === 302 && /login/.test(afterLo.location || ''));
  const bad8 = new Client('guess');
  for (let i = 0; i < 8; i++) await bad8.login(U('t2'), '0000' === newPin ? '1111' : '0000');
  const locked = await bad8.login(U('t2'), newPin);
  check('ใส่รหัสผิด 8 ครั้ง ครั้งที่ 9 รหัสถูกก็ยังถูกล็อก', locked.status === 401 && /รอ 10 นาที/.test(locked.text));

  if (db) await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nสรุป: ผ่าน ${results.length - failed.length} จาก ${results.length} ข้อ`);
  for (const f of failed) console.log(`  ไม่ผ่าน [${f.section}] ${f.name} ${f.detail}`);
  fs.writeFileSync(path.join(__dirname, '..', 'data-dev', `check-cloud-${RID}.json`), JSON.stringify({ base: BASE, rid: RID, results }, null, 1));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
