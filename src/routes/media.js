// รูปโลโก้โรงเรียนและตราครุฑ เก็บในฐานข้อมูลเป็น data URL ส่งเป็นไฟล์รูปแยก
// ค่าตั้งให้ที่อยู่ /media/logo?v=รุ่น (md5 8 ตัว) แทนรูปเต็ม ไม่ต้องอ่านรูปหลาย MB ทุกคำขอ และเบราว์เซอร์เก็บรูปไว้ได้นาน
// เปิดได้โดยไม่เข้าระบบ (หน้าเข้าสู่ระบบและหน้าตรวจ QR ใช้ด้วย)
const express = require('express');
const db = require('../db');

const router = express.Router();

function send(key) {
  return async (req, res, next) => {
    try {
      const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(await db.getLogo(key));
      if (!m) return res.status(404).type('text/plain').send('ไม่พบรูป');
      res.set('Content-Type', m[1]);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(Buffer.from(m[2], 'base64'));
    } catch (e) {
      next(e);
    }
  };
}

router.get('/media/logo', send('school_logo'));
router.get('/media/memo-logo', send('memo_logo'));

module.exports = router;
