// ตรวจสอบเอกสารจาก QR Code (เปิดได้โดยไม่ต้องเข้าสู่ระบบ)
// QR บนเอกสารที่พิมพ์ชี้มาที่ /v/<รหัสสุ่ม> ซึ่งเดาไม่ได้ แสดงเฉพาะข้อมูลที่อยู่บนกระดาษอยู่แล้ว
const express = require('express');
const QRCode = require('qrcode');
const { q } = require('../db');
const wf = require('../workflow');

const router = express.Router();

// ที่อยู่เว็บที่ใช้ใน QR: ใช้ค่าที่ผู้ดูแลตั้งไว้ (public_url) เป็นหลัก ถ้าว่างใช้ https:// กับชื่อเว็บที่เปิดอยู่
// บนคลาวด์ไม่มีวง Wi-Fi ให้หาเลข IP และ req.protocol ไม่น่าเชื่อถือ (Workers ส่งต่อคำขอเป็น http ภายใน)
function baseUrl(req) {
  const set = String((req.settings && req.settings.public_url) || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(set)) return set;
  return `https://${req.get('host') || 'localhost'}`;
}

async function qrSvg(req, sub) {
  if (!req.ff || !req.ff.qr || !sub || !sub.verify_code) return '';
  const url = `${baseUrl(req)}/v/${sub.verify_code}`;
  return QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

router.get('/v/:code', async (req, res) => {
  const code = String(req.params.code || '');
  const sub =
    req.ff.qr && /^[0-9a-f]{20}$/.test(code)
      ? await q.get(
          `SELECT ${wf.subCols('s')}, u.full_name AS teacher_name, d.name AS dept_name FROM submissions s
           JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id
           WHERE s.verify_code = ? AND s.status != 'draft'`,
          code
        )
      : null;
  if (!sub) {
    return res.status(404).render('verify', { title: 'ตรวจสอบเอกสาร', sub: null, steps: [] });
  }
  res.render('verify', { title: 'ตรวจสอบเอกสาร', sub, steps: await wf.progress(sub) });
});

module.exports = router;
module.exports.qrSvg = qrSvg;
module.exports.baseUrl = baseUrl;
