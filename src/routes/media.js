// รูปโลโก้โรงเรียนและตราครุฑ เก็บในฐานข้อมูลเป็น data URL ส่งเป็นไฟล์รูปแยก
// ค่าตั้งให้ที่อยู่ /media/logo?v=รุ่น (md5 8 ตัว) แทนรูปเต็ม ไม่ต้องอ่านรูปหลาย MB ทุกคำขอ และเบราว์เซอร์เก็บรูปไว้ได้นาน
// เปิดได้โดยไม่เข้าระบบ (หน้าเข้าสู่ระบบและหน้าตรวจ QR ใช้ด้วย)
const express = require('express');
const db = require('../db');

const router = express.Router();

function sendDataUrl(res, dataUrl, cache) {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return res.status(404).type('text/plain').send('ไม่พบรูป');
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', cache);
  res.send(Buffer.from(m[2], 'base64'));
}

function send(key) {
  return async (req, res, next) => {
    try {
      sendDataUrl(res, await db.getLogo(key), 'public, max-age=31536000, immutable');
    } catch (e) {
      next(e);
    }
  };
}

router.get('/media/logo', send('school_logo'));
router.get('/media/memo-logo', send('memo_logo'));

// รูปลายเซ็นของผู้ใช้ที่เข้าระบบอยู่ (เฉพาะของตัวเอง) วางหลังส่วนที่อ่านผู้ใช้ใน app.js
// auth.loadUser ให้ me.signature เป็นที่อยู่นี้ template จึงแสดงรูปได้โดยไม่ต้องโหลดรูปเต็มทุกหน้า
const signature = express.Router();
signature.get('/media/signature', async (req, res, next) => {
  try {
    if (!req.me) return res.status(404).type('text/plain').send('ไม่พบรูป');
    const r = await db.q.get('SELECT signature FROM users WHERE id = ?', req.me.id);
    sendDataUrl(res, r && r.signature, 'private, max-age=31536000, immutable');
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.signature = signature;
