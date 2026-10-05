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
const features = require('./features');
const themes = require('./themes');
const icons = require('./icons');
const { CompiledView } = require('./view');

function secretKey() {
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

function createApp() {
  // เปลี่ยนทุกครั้งที่เปิดระบบใหม่ เบราว์เซอร์จะโหลดไฟล์ CSS/JS รุ่นล่าสุด
  const assetVersion = Date.now().toString(36);
  const app = express();
  // หน้าเว็บ compile ไว้ล่วงหน้าใน dist/views.js (npm run build) ไม่ใช้ EJS ตอนรัน
  app.set('view', CompiledView);
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  // ฟอนต์และกราฟเก็บไว้ในเครื่อง ใช้งานใน Wi-Fi โรงเรียนได้แม้อินเทอร์เน็ตล่ม
  const nm = path.join(config.ROOT, 'node_modules');
  app.use('/static', express.static(path.join(config.ROOT, 'public'), { maxAge: 0 }));
  app.use('/vendor/chart.js', express.static(path.join(nm, 'chart.js', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/kanit', express.static(path.join(nm, '@fontsource', 'kanit'), { maxAge: '30d' }));
  app.use('/vendor/sarabun', express.static(path.join(nm, '@fontsource', 'sarabun'), { maxAge: '30d' }));
  app.use('/vendor/fonts', express.static(path.join(nm, '@fontsource'), { maxAge: '30d', index: false }));
  // ตัวแสดงไฟล์ PDF ในหน้าเว็บ (PDF.js) ใช้แทนการให้เบราว์เซอร์เปิดไฟล์เอง
  for (const dir of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(nm, 'pdfjs-dist', ...dir.split('/')), { maxAge: '7d', index: false }));
  }

  // ขอบเขตฐานข้อมูลต่อคำขอ (ข้อมูลอ้างอิง และตัวต่อบน Workers)
  app.use(db.requestScope);
  // รูปโลโก้ เปิดได้โดยไม่เข้าระบบ วางก่อนส่วนที่อ่านผู้ใช้และค่าตั้ง
  app.use(require('./routes/media'));

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(
    cookieSession({
      name: 'plan_session',
      keys: [secretKey()],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
    })
  );

  // กันเว็บอื่นแอบส่งฟอร์มเข้ามาในนามผู้ใช้
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        // origin ผิดรูปแบบ
      }
      if (host !== req.get('host')) return res.status(403).send('Forbidden');
    }
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
    Object.assign(res.locals, {
      me: req.me,
      settings,
      util,
      wf,
      ff,
      icon: icons.icon,
      theme,
      themeCss: themes.cssVars(theme) + (ff.prefs && night.key !== theme.key ? themes.cssVars(night, 'html.dark') : ''),
      fontFiles: [...new Set([...themes.fontFiles(theme), ...(ff.prefs ? themes.fontFiles(night) : [])])],
      logoUrl: settings.school_logo || '/static/img/school-logo-sm.png',
      demo: config.DEMO,
      assetVersion,
      currentPath: req.path,
      flash: req.session && req.session.flash,
      badges: { inbox: 0, returned: 0, notes: 0, alerts: 0 },
      title: '',
    });
    if (req.session && req.session.flash) req.session.flash = null;
    if (req.me) {
      const b = res.locals.badges;
      const w = wf.inboxWhere(req.me, 'i');
      const n = await db.q.get(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'returned') AS returned,
           COUNT(*) FILTER (WHERE doc_type = 'note' AND status IN ('draft', 'returned')) AS notes,
           (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS alerts,
           ${w ? `(SELECT COUNT(*) FROM submissions i WHERE ${w.sql})` : '0'} AS inbox
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

  app.use(require('./routes/media').signature);
  app.use(require('./routes/auth'));
  app.use(require('./routes/verify'));
  app.use(require('./routes/pages'));
  app.use(require('./routes/extras'));
  app.use(require('./routes/teaching'));
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
