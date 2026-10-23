// โอนงานระหว่างครู (ฟังก์ชันเสริม transfer) เฉพาะผู้ดูแลระบบ
// หน้า /admin/transfer เลือกครูต้นทางกับครูผู้รับ ติ๊กได้หลายงาน (แบบ ข) · กล่องในหน้างาน /s/<id> โอนทีละงาน (แบบ ก) ส่งมาที่ POST เดียวกัน
const express = require('express');
const { q } = require('../db');
const auth = require('../auth');
const util = require('../util');
const transfer = require('../transfer');
const { term, withCurrent, termOptions } = require('./pages');

const router = express.Router();
router.use('/transfer', auth.requireLogin, auth.requireAdmin, (req, res, next) => {
  if (req.ff.transfer) return next();
  res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดฟังก์ชันนี้ไว้' });
});

const on = (v) => v === '1' || v === 'on';

// กลับไปหน้าที่กดมา เฉพาะหน้างานหรือหน้าโอนงาน
function backTo(b) {
  const back = String(b.back || '');
  return /^\/s\/\d+$/.test(back) || /^\/admin\/transfer(\?[\w=&%-]*)?$/.test(back) ? back : '/admin/transfer';
}

function driveText(d) {
  if (!d) return '';
  let t = d.moved ? ` ย้ายไฟล์ใน Drive ${d.moved} ไฟล์` : '';
  if (d.left) t += ` ไฟล์ใน Drive รอย้ายอีก ${d.left} ไฟล์ ระบบย้ายต่อเองทุกชั่วโมง หรือกดปุ่ม ย้ายไฟล์ต่อ`;
  return t;
}

router.get('/transfer', async (req, res) => {
  const t = term(req);
  const { teachers, driveLeft } = await transfer.choices();
  const fromId = util.intOr(req.query.from, 0);
  const toId = util.intOr(req.query.to, 0);
  // ครูที่ปิดบัญชีแล้ว (ลาออก ย้ายโรงเรียน) ไม่อยู่ในรายชื่อผู้รับ แต่ยังโอนงานออกได้
  const from =
    teachers.find((x) => x.id === fromId) ||
    (fromId
      ? await q.get(
          `SELECT u.id, u.full_name, d.name AS dept_name, true AS inactive FROM users u LEFT JOIN departments d ON d.id = u.department_id
           WHERE u.id = ? AND u.is_teacher = 1`,
          fromId
        )
      : null) ||
    null;
  res.render('admin/transfer', {
    title: 'โอนงานระหว่างครู',
    term: t,
    terms: withCurrent(await termOptions(), req.settings),
    teachers,
    from,
    toId,
    works: from ? await transfer.worksOf(from.id, t.year, t.semester) : [],
    driveLeft,
  });
});

router.post('/transfer', async (req, res) => {
  const b = req.body || {};
  const ids = [].concat(b.ids || []);
  const r = await transfer.transfer(req.me, ids, b.to, {
    keepName: b.name_mode === 'keep',
    withNotes: on(b.with_notes),
    withTeach: on(b.with_teach),
    moveDrive: on(b.move_drive),
    notify: on(b.notify),
  });
  const extra = [r.notes ? `บันทึกหลังแผน ${r.notes} ฉบับ` : '', r.teach ? `รายวิชาที่สอน ${r.teach} วิชา` : ''].filter(Boolean).join(' ');
  req.flash('success', `โอนแล้ว ${r.works} งาน ให้ ${r.to.full_name}${extra ? ` พร้อม${extra}` : ''}${driveText(r.drive)}`);
  res.redirect(backTo(b));
});

// ย้ายไฟล์ที่ค้างในคิวต่อ (ย้ายไม่สำเร็จหรือเกินจำนวนต่อครั้ง)
router.post('/transfer/drive', async (req, res) => {
  const d = await transfer.runDrive();
  req.flash(d.failed && !d.moved ? 'error' : 'success', d.moved || d.failed ? `ย้ายไฟล์ใน Drive ${d.moved} ไฟล์${d.failed ? ` ไม่สำเร็จ ${d.failed} ไฟล์ ลองอีกครั้งภายหลัง` : ''}${d.left ? ` เหลือรอย้าย ${d.left} ไฟล์` : ''}` : 'ไม่มีไฟล์รอย้ายแล้ว');
  res.redirect(backTo(req.body || {}));
});

module.exports = router;
