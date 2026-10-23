// ประกอบเว็บแอป: ตั้งค่าความปลอดภัย การเข้าสู่ระบบ และเส้นทางของทุกหน้า
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const wf = require('./workflow');
const util = require('./util');
const docno = require('./docno');
const features = require('./features');
const themes = require('./themes');
const icons = require('./icons');
const { CompiledView } = require('./view');
const { STATIC_MOUNTS } = require('./static');
const site = require('./site');

// กุญแจเซ็น cookie: เว็บจริงต้องตั้ง SESSION_SECRET (สุ่มยาว 32 ตัวขึ้นไป) ไม่ตั้งแล้วไม่เปิดระบบ
// ในเครื่องใช้ SESSION_SECRET ถ้าตั้งไว้ ไม่ตั้งก็สุ่มเก็บในไฟล์ secret.key ของโฟลเดอร์ข้อมูล (data-pg ไม่ใช่ data ของระบบเดิม)
function secretKey() {
  const env = process.env.SESSION_SECRET || '';
  if (config.PRODUCTION) {
    if (env.length < 32) throw new Error('APP_ENV=production ต้องตั้ง SESSION_SECRET ยาวอย่างน้อย 32 ตัวอักษร');
    return env;
  }
  if (env) return env;
  // Workers ไม่มีดิสก์ให้เก็บกุญแจ (wrangler dev ในเครื่องก็ต้องตั้ง ดู scripts/workers-dev.js)
  if (config.WORKERS) throw new Error('บน Cloudflare Workers ต้องตั้ง SESSION_SECRET');
  const f = path.join(config.DATA_DIR, 'secret.key');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const k = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(f, k);
    return k;
  }
}

// options.assetVersion = รหัสรุ่นไฟล์ static ที่ build สร้าง (Workers ส่งมาจาก dist/assets-version.js)
function createApp(options = {}) {
  const production = config.PRODUCTION;
  const keys = [secretKey()];
  // บน Node เปลี่ยนทุกครั้งที่เปิดระบบใหม่ เบราว์เซอร์จะโหลดไฟล์ CSS/JS รุ่นล่าสุด
  // บน Workers ใช้รหัสจากตอน build (Date.now() ตอนเริ่มบน Workers ได้ 0 และไม่ได้เปลี่ยนตามรุ่นไฟล์)
  const assetVersion = options.assetVersion || Date.now().toString(36);
  // รุ่นของระบบ (วันที่ build) แสดงท้ายเว็บและหน้าเกี่ยวกับระบบ
  // บน Workers ใช้เวลา build (dist/build-time.js) เพราะ assetVersion เป็นค่าแฮช เดิมแปลงแฮชเป็นวันที่ได้ปี 8959
  const builtAt = options.assetVersion ? Number(options.builtAt) || 0 : parseInt(assetVersion, 36);
  const assetDate = builtAt > 1.6e12 && builtAt < Date.now() + 864e5 ? util.thaiDate(db.nowStr(new Date(builtAt)), true) : '';
  const app = express();
  // หน้าเว็บ compile ไว้ล่วงหน้าใน dist/views.js (npm run build) ไม่ใช้ EJS ตอนรัน
  app.set('view', CompiledView);
  // เว็บจริงอยู่หลัง Cloudflare ตัวรับคำขอเติม x-forwarded-proto เอง (cookie แบบ secure ต้องรู้ว่าเป็น https)
  // IP ของผู้ใช้บนเว็บจริงอ่านจาก CF-Connecting-IP (auth.clientIp) ไม่ใช้ req.ip
  app.set('trust proxy', production ? true : 'loopback');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    });
    // เว็บจริงบังคับ https ตลอด 1 ปี
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // ฟอนต์และกราฟเก็บไว้ในเครื่อง ใช้งานใน Wi-Fi โรงเรียนได้แม้อินเทอร์เน็ตล่ม
  // บน Workers ไฟล์ชุดนี้คัดลอกไว้ที่ dist/assets ตอน build (scripts/build-assets.js) Cloudflare ส่งให้เองโดยไม่ผ่านแอป
  if (!config.WORKERS) {
    for (const m of STATIC_MOUNTS) app.use(m.url, express.static(path.join(config.ROOT, m.dir), { maxAge: m.maxAge, index: m.index }));
  }

  // ขอบเขตฐานข้อมูลต่อคำขอ (ข้อมูลอ้างอิง และตัวต่อบน Workers)
  app.use(db.requestScope);
  // รูปโลโก้ เปิดได้โดยไม่เข้าระบบ วางก่อนส่วนที่อ่านผู้ใช้และค่าตั้ง
  app.use(require('./routes/media'));

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(
    cookieSession({
      name: 'plan_session',
      keys,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: production,
    })
  );

  // กันเว็บอื่นแอบส่งฟอร์ม (และท่อนไฟล์ PUT) เข้ามาในนามผู้ใช้
  // ดู Origin ก่อน · เว็บจริงถ้าไม่มี Origin ให้ดู Referer แทน ถ้าไม่มีทั้งคู่ปฏิเสธ (ในเครื่องปล่อยผ่านเหมือนเดิม)
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return ''; // ผิดรูปแบบ
    }
  };
  app.use((req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return next();
    const origin = req.get('origin');
    const from = origin && origin !== 'null' ? origin : production ? req.get('referer') : '';
    if (from ? hostOf(from) !== req.get('host') : production) return res.status(403).send('Forbidden');
    next();
  });

  // ทุกคำขอ (รวมหน้าเข้าสู่ระบบและหน้าสแกน QR) ใช้ไม่เกิน 3 คำสั่ง: ผู้ใช้พร้อมบทบาท · ข้อมูลอ้างอิง (ค่าตั้ง ขั้นตอน แบบประเมิน)
  // · ตัวเลขบนเมนู 4 ตัว (งานรอตรวจนับในฐานด้วยเงื่อนไขเดียวกับ wf.inbox ไม่ดึงรายการ)
  app.use(async (req, res, next) => {
    req.me = req.session.uid ? await auth.loadUser(req.session.uid) : null;
    if (req.session.uid && !req.me) req.session = null;
    req.flash = (type, text) => {
      if (req.session) req.session.flash = { type, text };
    };
    const settings = await db.getSettings();
    req.settings = settings;
    const ff = features.flags(settings);
    req.ff = ff;
    // โหมดกลางคืนและตัวอักษรใหญ่ จำไว้ในเครื่องของผู้ใช้แต่ละเครื่อง (ไม่เก็บในฐานข้อมูล)
    const theme = themes.resolve(settings.theme);
    const night = themes.resolve(settings.theme, { dark: true });
    // หน้าเว็บไม่ได้รับรหัสลับ LINE ได้แค่รู้ว่าตั้งไว้แล้วหรือยัง (โค้ดฝั่งเซิร์ฟเวอร์ยังอ่านจาก req.settings)
    const { line_token: lineToken, ...pubSettings } = settings;
    pubSettings.line_token_set = Boolean(lineToken);
    Object.assign(res.locals, {
      me: req.me,
      settings: pubSettings,
      util,
      docno,
      wf,
      ff,
      icon: icons.icon,
      theme,
      // สีสัน 4 ระดับ (colorful) เป็น class ของ <body>
      fxLevel: themes.fxLevel(settings, ff),
      fxClass: themes.fxClass(themes.fxLevel(settings, ff)),
      themeCss: themes.cssVars(theme) + (ff.prefs && night.key !== theme.key ? themes.cssVars(night, 'html.dark') : ''),
      fontFiles: [...new Set([...themes.fontFiles(theme), ...(ff.prefs ? themes.fontFiles(night) : [])])],
      logoUrl: settings.school_logo || '/static/img/school-logo-sm.png',
      coverStyle: features.coverStyle(settings),
      teachStyle: features.teachStyle(settings),
      // ชื่อระบบ ข้อมูลท้ายเว็บ และไอคอนแอป (src/site.js)
      site: site.of(settings),
      demo: config.DEMO,
      // รันบน Cloudflare Workers: ข้อความที่พูดถึง Wi-Fi และเครื่องที่ติดตั้งระบบเปลี่ยนเป็นแบบคลาวด์
      cloud: config.WORKERS,
      assetVersion,
      assetDate,
      siteYear: Number(db.nowStr().slice(0, 4)) + 543,
      currentPath: req.path,
      flash: req.session && req.session.flash,
      badges: { inbox: 0, returned: 0, notes: 0, alerts: 0 },
      title: '',
    });
    if (req.session && req.session.flash) req.session.flash = null;
    if (req.me) {
      const b = res.locals.badges;
      const w = wf.inboxWhere(req.me, 'i');
      // ส่งบันทึกหลังแผนทั้งเล่ม: นับบันทึกเป็นเล่ม (แผนเดียวกันและรอระดับเดียวกัน) ตรงกับ wf.groupBooks
      const inboxCount = ff.notebook
        ? "COUNT(DISTINCT CASE WHEN i.doc_type = 'note' AND i.parent_id IS NOT NULL THEN 'b' || i.parent_id || '|' || i.current_role ELSE 's' || i.id END)"
        : 'COUNT(*)';
      const n = await db.q.get(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'returned') AS returned,
           COUNT(*) FILTER (WHERE doc_type = 'note' AND status IN ('draft', 'returned')) AS notes,
           (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS alerts,
           ${w ? `(SELECT ${inboxCount} FROM submissions i WHERE ${w.sql})` : '0'} AS inbox
         FROM submissions WHERE teacher_id = ?`,
        req.me.id,
        ...(w ? w.params : []),
        req.me.id
      );
      b.inbox = n.inbox;
      b.returned = n.returned;
      b.notes = n.notes;
      b.alerts = n.alerts;
    }
    next();
  });

  // ไฟล์ติดตั้งแอปบนหน้าจอโฮม (ฟังก์ชันเสริม appicon) เปิดได้โดยไม่ต้องเข้าสู่ระบบ
  app.get('/manifest.webmanifest', (req, res) => {
    if (!req.ff.appicon) return res.status(404).end();
    res.type('application/manifest+json').send(JSON.stringify(site.manifest(req.settings, themes.resolve(req.settings.theme).side)));
  });
  app.use(require('./routes/media').signature);
  app.use(require('./routes/auth'));
  app.use(require('./routes/verify'));
  app.use(require('./routes/pages'));
  app.use(require('./routes/extras'));
  app.use(require('./routes/teaching'));
  app.use(require('./routes/library'));
  app.use(require('./routes/work'));
  app.use('/admin', require('./routes/ttimport'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'ไม่พบหน้านี้', message: 'ไม่พบหน้าที่ต้องการ หรือคุณไม่มีสิทธิ์เปิดดู' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // id ผิดรูปแบบหรือเกินช่วง (util.idParam) ตอบเหมือนไม่พบหน้า
    if (err.status === 404) {
      return res.status(404).render('error', { title: 'ไม่พบหน้านี้', message: 'ไม่พบหน้าที่ต้องการ หรือคุณไม่มีสิทธิ์เปิดดู' });
    }
    const known = err instanceof wf.WorkflowError || err.userMessage;
    if (!known) console.error(err);
    const message = known ? err.userMessage || err.message : 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง';
    if (req.xhr) return res.status(400).json({ error: message });
    if (known && req.method === 'POST') {
      req.flash('error', message);
      return res.redirect(req.get('referer') || '/');
    }
    res.status(known ? 400 : 500).render('error', { title: 'เกิดข้อผิดพลาด', message });
  });

  return app;
}

module.exports = { createApp };
