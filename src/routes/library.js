// คลังงานการจัดการเรียนรู้ (ฟังก์ชันเสริม library) หน้าชั้นวาง รูปปก และปุ่มผู้ดูแลระบบ สร้างปกงานเดิม
const express = require('express');
const { q } = require('../db');
const auth = require('../auth');
const util = require('../util');
const up = require('../upload');
const library = require('../library');
const features = require('../features');

const router = express.Router();
router.use('/library', auth.requireLogin);

function closed(res) {
  return res.status(404).render('error', { title: 'ปิดใช้งานอยู่', message: 'ผู้ดูแลระบบปิดคลังงานการจัดการเรียนรู้ไว้' });
}

// ภาคเรียนที่มีงานผ่านครบ และภาคปัจจุบันเสมอ
async function termList(settings) {
  const cur = { year: Number(settings.academic_year), semester: Number(settings.semester) };
  const list = await q.all("SELECT DISTINCT academic_year AS year, semester FROM submissions WHERE status = 'approved' ORDER BY academic_year DESC, semester DESC");
  if (!list.some((t) => t.year === cur.year && t.semester === cur.semester)) list.unshift(cur);
  return { cur, list };
}

router.get('/library', async (req, res) => {
  if (!req.ff.library) return closed(res);
  const { cur, list } = await termList(req.settings);
  const term = { year: util.intOr(req.query.year, 0) || cur.year, semester: util.intOr(req.query.semester, 0) || cur.semester };
  const department = util.idOrNull(req.query.department) || null;
  const shelfKey = library.SHELF[req.query.shelf] ? req.query.shelf : library.SHELVES[0].key;
  const offset = Math.max(0, util.intOr(req.query.offset, 0));
  const { shelf, rows, total, byDept } = await library.page(shelfKey, { term, department, offset });
  const books = library.decorate(rows, req.me, req.ff);
  const query = { shelf: shelf.key, year: term.year, semester: term.semester, ...(department ? { department } : {}) };
  // หัวแถวกลุ่มสาระ: ลิงก์ ดูทั้งหมด = กรองกลุ่มสาระนั้น (ภาคและชั้นเดิม)
  const groups = { byDept, base: new URLSearchParams({ shelf: shelf.key, year: term.year, semester: term.semester }).toString(), one: !!department };
  const more = offset + rows.length < total ? `/library?${new URLSearchParams({ ...query, offset: String(offset + rows.length) })}` : '';
  // โหลดเพิ่ม: หน้าเว็บขอเฉพาะเล่มชุดถัดไปมาต่อท้าย
  if (req.query.part === '1') {
    res.set({ 'X-Lib-Next': more, 'X-Lib-Left': String(Math.max(0, total - offset - rows.length)), 'Cache-Control': 'private, no-store' });
    return res.render('partials/lib_books', { books, groups });
  }
  // งานเดิมที่ยังไม่มีรูปปก (ผู้ดูแลระบบกดสร้างได้)
  const noCover = req.me.is_admin
    ? (await q.get("SELECT COUNT(*)::int AS n FROM submissions s WHERE s.doc_type IN ('plan', 'manual') AND s.status = 'approved' AND s.cover_ref IS NULL AND EXISTS (SELECT 1 FROM files f WHERE f.submission_id = s.id AND f.is_current = 1 AND f.mime = 'application/pdf')")).n
    : 0;
  res.render('library', {
    title: 'คลังงานการจัดการเรียนรู้',
    shelves: library.SHELVES,
    shelf,
    books,
    groups,
    total,
    offset,
    more,
    query,
    term,
    terms: list,
    department,
    departments: await q.all('SELECT id, name FROM departments ORDER BY sort, name'),
    views: features.LIBRARY_VIEWS,
    defaultView: features.libraryView(req.settings),
    noCover,
  });
});

// รูปปกเล็ก ทุกคนที่เข้าระบบเห็นได้ (เห็นปกแต่อาจเปิดอ่านไม่ได้) ที่อยู่มี ?v= ตามรูป เบราว์เซอร์จึงจำไว้ได้ 1 ปี
router.get('/library/cover/:id', async (req, res) => {
  if (!req.ff.library) return res.status(404).end();
  const id = util.idOrNull(req.params.id);
  const s = id && (await q.get("SELECT cover_ref FROM submissions WHERE id = ? AND doc_type IN ('plan', 'manual') AND status = 'approved'", id));
  if (!s || !s.cover_ref) return res.status(404).end();
  await require('./work').sendStored(req, res, { id, stored_name: s.cover_ref, size: 0 }, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
});

// ---------- ผู้ดูแลระบบ สร้างปกงานเดิม ----------
// เบราว์เซอร์ของผู้ดูแลเปิด PDF ทีละเล่ม ทำรูปปกเล็ก แล้วส่งเข้ามาทีละรูป (เซิร์ฟเวอร์ไม่แปลง PDF เอง)
function adminOnly(req, res) {
  if (req.me.is_admin && req.ff.library) return true;
  res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ' });
  return false;
}

router.get('/library/covers/todo', async (req, res) => {
  if (!adminOnly(req, res)) return;
  const rows = await q.all(
    `SELECT s.id, (SELECT f.id FROM files f WHERE f.submission_id = s.id AND f.is_current = 1 AND f.mime = 'application/pdf' ORDER BY f.id LIMIT 1) AS file
     FROM submissions s WHERE s.doc_type IN ('plan', 'manual') AND s.status = 'approved' AND s.cover_ref IS NULL ORDER BY s.id LIMIT 1000`
  );
  res.json({ items: rows.filter((r) => r.file) });
});

router.post('/library/cover/:id', async (req, res) => {
  if (!adminOnly(req, res)) return;
  const id = util.idOrNull(req.params.id);
  const sub = id && (await q.get("SELECT id FROM submissions WHERE id = ? AND doc_type IN ('plan', 'manual')", id));
  const cover = sub ? await up.takeCover(req, library.COVER_MAX) : null;
  if (!cover) return res.status(400).json({ error: 'รูปปกใช้ไม่ได้' });
  const old = await q.tx(() => up.useCover(sub.id, cover));
  if (old) await up.trashAll([old]);
  res.json({ ok: true });
});

// จดประวัติหลังสร้างปกครบชุด (1 แถวต่อการกด 1 ครั้ง)
router.post('/library/covers/done', async (req, res) => {
  if (!adminOnly(req, res)) return;
  const n = Math.max(0, util.intOr((req.body || {}).n, 0));
  await features.audit(req.me, `สร้างปกงานเดิมในคลังงาน ${n} เล่ม`, 'library_cover');
  res.json({ ok: true });
});

module.exports = router;
