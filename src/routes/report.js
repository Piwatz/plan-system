// สรุปการส่งงานครู (ฟังก์ชันเสริม reportsum) เฉพาะผู้ดูแลระบบ หน้าตามจริง หน้าฉบับรายงาน หน้าพิมพ์ และไฟล์ Word
const express = require('express');
const { q, getLogo } = require('../db');
const auth = require('../auth');
const util = require('../util');
const features = require('../features');
const report = require('../reportsum');
const reportdocx = require('../reportdocx');
const { term, withCurrent, termOptions } = require('./pages');

const router = express.Router();
router.use('/report', auth.requireLogin, auth.requireAdmin, (req, res, next) => {
  if (req.ff.reportsum) return next();
  res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดฟังก์ชันสรุปการส่งงานอยู่' });
});

const typeOf = (v) => (report.DOCS[v] ? v : 'plan');
const tabOf = (v) => (v === 'report' ? 'report' : 'real');
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function termOf(b) {
  return { year: util.intOr(b.year, 0), semester: util.intOr(b.semester, 0) };
}

function pageUrl(b, tab) {
  const t = termOf(b);
  return `/admin/report?type=${typeOf(b.type)}&tab=${tab || tabOf(b.tab)}&year=${t.year}&semester=${t.semester}`;
}

router.get('/report', async (req, res) => {
  const t = term(req);
  const type = typeOf(req.query.type);
  const tab = tabOf(req.query.tab);
  const data = await report.load(type, t.year, t.semester);
  res.render('admin/report', {
    title: 'สรุปการส่งงานครู',
    term: t,
    terms: withCurrent(await termOptions(), req.settings),
    type,
    tab,
    data,
    docs: report.DOCS,
    results: report.RESULTS,
    stateLabel: report.STATE_LABEL,
    stateBadge: report.STATE_BADGE,
    situations: report.situations(req.settings),
    names: await report.signers(data.round, req.me),
  });
});

// ข้อมูลร่วมของหน้าพิมพ์และไฟล์ Word
async function paperData(req) {
  const t = term(req);
  const type = typeOf(req.query.type);
  const mode = req.query.mode === 'report' ? 'report' : 'real';
  const data = await report.load(type, t.year, t.semester);
  const rows = report.paperRows(data, mode);
  const sum = report.summarize(rows.map((r) => r.state));
  return {
    t,
    type,
    mode,
    data,
    rows,
    text: report.paperText(type, t.year, t.semester, sum),
    late: rows.filter((r) => r.state !== 'ontime'),
    names: await report.signers(data.round, req.me),
    endNote: mode === 'report' && data.round.note_on ? data.round.end_note : '',
  };
}

router.get('/report/print', async (req, res) => {
  const p = await paperData(req);
  res.render('print_report', { title: report.DOCS[p.type].file, paper: 'report', ...p, formDate: report.formDate });
});

router.get('/report/word', async (req, res) => {
  const p = await paperData(req);
  const bytes = reportdocx.build({ ...p, settings: req.settings, logo: await getLogo('memo_logo') });
  const name = `${report.DOCS[p.type].file}_${p.t.semester}-${p.t.year}_${p.mode === 'report' ? 'ฉบับรายงาน' : 'ตามจริง'}.docx`;
  await features.audit(req.me, `ส่งออกไฟล์ Word ${name}`, 'reportsum');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', util.contentDisposition(name));
  res.send(Buffer.from(bytes));
});

router.post('/report/due', async (req, res) => {
  const t = termOf(req.body);
  const type = typeOf(req.body.type);
  const round = await report.getRound(type, t.year, t.semester);
  const due = report.isDate(req.body.due_date) ? req.body.due_date : '';
  await report.saveRound(type, t.year, t.semester, { ...round, due_date: due });
  await features.audit(req.me, `ตั้งกำหนดส่ง${report.DOCS[type].label} ภาคเรียนที่ ${t.semester}/${t.year} เป็น ${due || 'ไม่กำหนด'}`, 'reportsum');
  req.flash('success', 'บันทึกกำหนดส่งแล้ว ระบบคิดผลใหม่ให้แล้ว');
  res.redirect(pageUrl(req.body));
});

router.post('/report/round', async (req, res) => {
  const t = termOf(req.body);
  const type = typeOf(req.body.type);
  const round = await report.getRound(type, t.year, t.semester);
  await report.saveRound(type, t.year, t.semester, { ...req.body, due_date: round.due_date });
  await features.audit(req.me, `แก้ค่าบันทึกข้อความรายงานการส่ง${report.DOCS[type].label} ภาคเรียนที่ ${t.semester}/${t.year}`, `เลขที่ ${String(req.body.doc_no || '').slice(0, 60)}`);
  req.flash('success', 'บันทึกแล้ว');
  res.redirect(pageUrl(req.body));
});

router.post('/report/adjust', async (req, res) => {
  const b = req.body;
  const back = pageUrl(b, 'report');
  const t = termOf(b);
  const fail = (text) => {
    req.flash('error', text);
    res.redirect(back);
  };
  const types = list(b.types).filter((x) => report.DOCS[x]);
  const asked = [...new Set(list(b.ids).map((x) => util.intOr(x, 0)).filter(Boolean))];
  if (!asked.length) return fail('ยังไม่ได้ติ๊กชื่อครู');
  if (!types.length) return fail('ยังไม่ได้เลือกว่าใช้กับงานไหน');
  const found = await q.all('SELECT id, full_name FROM users WHERE id = ANY(?) AND is_active = 1 AND is_teacher = 1', asked);
  const people = found.filter((u) => u.id !== req.me.id);
  // ผู้ดูแลระบบปรับผลของตัวเองไม่ได้ เหมือนกติกาการดำเนินการแทน
  if (!people.length) return fail(found.length ? 'ปรับผลของตัวเองไม่ได้ ให้ผู้ดูแลระบบคนอื่นปรับให้' : 'ไม่พบครูที่เลือก');
  const ids = people.map((u) => u.id);
  const who = people.map((u) => u.full_name).join(' ').slice(0, 300);
  const docs = types.map((x) => report.DOCS[x].tab).join(' ');
  if (b.action === 'reset') {
    await report.resetAdjust(req.me, ids, types, t.year, t.semester);
    await features.audit(req.me, `คืนค่าตามจริง ${docs} ภาคเรียนที่ ${t.semester}/${t.year} ${people.length} คน`, who);
    req.flash('success', `คืนค่าตามจริงแล้ว ${people.length} คน`);
    return res.redirect(back);
  }
  if (!report.RESULTS[b.result] || b.result === 'real') return fail('ยังไม่ได้เลือกผลในรายงาน');
  if (!String(b.reason || '').trim()) return fail('ต้องกรอกเหตุผลทุกครั้งที่ปรับผล');
  if (b.result === 'extend' && !report.isDate(b.extend_date)) return fail('ขยายกำหนดส่งต้องเลือกวันที่ใหม่ก่อน');
  await report.saveAdjust(req.me, ids, types, t.year, t.semester, b);
  await features.audit(req.me, `ปรับผลในฉบับรายงาน ${docs} ภาคเรียนที่ ${t.semester}/${t.year} เป็น ${report.RESULTS[b.result]} ${people.length} คน`, `${who} เหตุผล ${String(b.reason).trim().slice(0, 200)}`);
  const skipped = found.length - people.length;
  req.flash('success', `ปรับผลแล้ว ${people.length} คน${skipped ? ' ไม่รวมผลของตัวเอง' : ''}`);
  res.redirect(back);
});

router.post('/report/situations', async (req, res) => {
  const saved = await report.saveSituations(req.body.names, req.body.results);
  await features.audit(req.me, `แก้รายการสถานการณ์ของสรุปการส่งงาน เหลือ ${saved.length} รายการ`, saved.map((s) => s.name).join(' ').slice(0, 300));
  req.flash('success', 'บันทึกรายการสถานการณ์แล้ว');
  res.redirect(pageUrl(req.body, 'report'));
});

module.exports = router;
