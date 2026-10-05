// ตรวจสอบเอกสารจาก QR Code (เปิดได้โดยไม่ต้องเข้าสู่ระบบ)
// QR บนเอกสารที่พิมพ์ชี้มาที่ /v/<รหัสสุ่ม> ซึ่งเดาไม่ได้ แสดงเฉพาะข้อมูลที่อยู่บนกระดาษอยู่แล้ว
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const { q } = require('../db');
const wf = require('../workflow');
const config = require('../config');

const router = express.Router();

// ที่อยู่เว็บที่ใช้ใน QR: ใช้ค่าที่ผู้ดูแลตั้งไว้ ถ้าไม่มีใช้ที่อยู่ที่เปิดอยู่
// ถ้าเปิดจากเครื่องที่ติดตั้งระบบ (localhost) จะเปลี่ยนเป็นเลข IP ในวง Wi-Fi ให้โทรศัพท์สแกนเปิดได้
function baseUrl(req) {
  const set = String((req.settings && req.settings.public_url) || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(set)) return set;
  const host = req.get('host') || `localhost:${config.PORT}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${config.PORT}`;
    }
  }
  return `${req.protocol}://${host}`;
}

async function qrSvg(req, sub) {
  if (!req.ff || !req.ff.qr || !sub || !sub.verify_code) return '';
  const url = `${baseUrl(req)}/v/${sub.verify_code}`;
  return QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

router.get('/v/:code', (req, res) => {
  const code = String(req.params.code || '');
  const sub =
    req.ff.qr && /^[0-9a-f]{20}$/.test(code)
      ? q.get(
          `SELECT s.*, u.full_name AS teacher_name, d.name AS dept_name FROM submissions s
           JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
           WHERE s.verify_code = ? AND s.status != 'draft'`,
          code
        )
      : null;
  if (!sub) {
    return res.status(404).render('verify', { title: 'ตรวจสอบเอกสาร', sub: null, steps: [] });
  }
  res.render('verify', { title: 'ตรวจสอบเอกสาร', sub, steps: wf.progress(sub) });
});

module.exports = router;
module.exports.qrSvg = qrSvg;
module.exports.baseUrl = baseUrl;
