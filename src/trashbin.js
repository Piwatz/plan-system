// ไฟล์ในถังขยะ (ฟังก์ชันเสริม trashbin) ผู้ดูแลระบบกู้ไฟล์งานที่ถูกลบได้ภายใน 30 วัน ก่อน Google Drive ลบถาวรเอง
// ตอนลบงาน จดไฟล์ทุกไฟล์ของงานลงตาราง trash_log พร้อมข้อมูลงาน (snapshot) เพราะแถวงานและไฟล์ในฐานหายไปพร้อมงาน
// กู้ได้ 3 แบบ: ดาวน์โหลด · กู้คืนเข้า Drive อย่างเดียว (ไฟล์กลับโฟลเดอร์เดิม) · กู้กลับเป็นงานเดิม (ฉบับร่างของครูคนเดิม ผู้ตรวจต้องตรวจใหม่)
// ไฟล์ในถังขยะที่ถูกลบก่อนมีตารางนี้ (หรือลบทางอื่น) แสดงจากถังขยะของที่เก็บไฟล์ เห็นแค่ชื่อไฟล์ ดาวน์โหลดและกู้คืนเข้า Drive ได้
const { q, nowStr } = require('./db');
const storage = require('./storage');
const time = require('./time');
const features = require('./features');

const KEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// ช่องของงานที่จดไว้ใช้กู้กลับเป็นฉบับร่าง (สถานะ คะแนน ลายเซ็น ไม่จด ต้องตรวจใหม่)
const SNAP = ['doc_type', 'parent_id', 'teacher_id', 'department_id', 'academic_year', 'semester', 'subject_code', 'subject_name', 'grade_level', 'teaching_methods', 'link_url', 'doc_no', 'plan_no', 'topic', 'unit_no', 'unit_name', 'hours', 'class_room', 'teach_date', 'result_k', 'result_p', 'result_a', 'problems', 'suggestions', 'students_total', 'students_passed', 'note_mode'];
const TYPE_LABEL = { plan: 'แผน', manual: 'คู่มือ', note: 'บันทึกหลังแผน' };

function labelOf(s) {
  return [TYPE_LABEL[s.doc_type] || s.doc_type, s.subject_code, s.subject_name, s.doc_type === 'note' && s.plan_no ? 'แผนที่ ' + s.plan_no : ''].filter(Boolean).join(' ');
}

// ลบงาน (และบันทึกหลังแผนที่อยู่ใต้งาน) แล้วย้ายไฟล์ไปถังขยะ · เปิด trashbin จดไฟล์ไว้ใน transaction เดียวกับการลบ
async function deleteWork(id, actor, { log = true } = {}) {
  const subs = await q.all(
    `SELECT s.*, u.full_name AS teacher_name FROM submissions s JOIN users u ON u.id = s.teacher_id WHERE s.id = ? OR s.parent_id = ? ORDER BY s.id`,
    id,
    id
  );
  const ids = subs.map((s) => s.id);
  const files = ids.length ? await q.all('SELECT * FROM files WHERE submission_id = ANY(?) ORDER BY id', ids) : [];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const now = nowStr();
  const logged = new Map();
  await q.tx(async () => {
    if (log) {
      for (const f of files) {
        const s = byId.get(f.submission_id);
        const snap = {};
        for (const k of SNAP) snap[k] = s[k];
        const r = await q.get(
          `INSERT INTO trash_log (ref, name, mime, size, kind, was_current, submission_id, teacher_id, label, snapshot, deleted_at, deleted_by, deleted_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          f.stored_name,
          f.original_name,
          f.mime || '',
          f.size || 0,
          f.kind,
          f.is_current ? 1 : 0,
          s.id,
          s.teacher_id,
          `${labelOf(s)} ของ${s.teacher_name}`,
          JSON.stringify(snap),
          now,
          actor ? actor.id : null,
          actor ? actor.full_name : ''
        );
        logged.set(f.stored_name, r.id);
      }
    }
    await q.run('DELETE FROM submissions WHERE parent_id = ?', id);
    await q.run('DELETE FROM submissions WHERE id = ?', id);
  });
  // ย้ายไฟล์ไปถังขยะหลังลบในฐานสำเร็จแล้วเท่านั้น · ในเครื่องไฟล์ย้ายไปที่ใหม่ จดที่อยู่ไว้ให้กู้ได้
  for (const f of files) {
    try {
      const to = await storage.trash(f.stored_name);
      const lid = logged.get(f.stored_name);
      if (lid && to && to !== f.stored_name) await q.run('UPDATE trash_log SET trash_ref = ? WHERE id = ?', to, lid);
    } catch (e) {
      console.error('ย้ายไฟล์ไปถังขยะไม่สำเร็จ', f.stored_name, e.message);
    }
  }
  return subs.length;
}

function daysLeft(ms, now = Date.now()) {
  return Math.max(0, KEEP_DAYS - Math.floor((now - ms) / DAY));
}

// รายการสำหรับหน้าไฟล์ในถังขยะ: ที่จดไว้ 30 วันล่าสุด + ไฟล์ในถังขยะของที่เก็บไฟล์ที่ไม่ได้จด (ไม่รวมไฟล์สำรองข้อมูล รูปปก)
async function list() {
  const since = nowStr(new Date(Date.now() - KEEP_DAYS * DAY));
  const rows = await q.all('SELECT * FROM trash_log WHERE deleted_at >= ? ORDER BY id DESC', since);
  const now = Date.now();
  const items = rows.map((r) => {
    const ms = time.parseLocal(String(r.deleted_at).slice(0, 16));
    return { ...r, key: String(r.id), logged: true, ms, left: daysLeft(ms, now) };
  });
  let loose = [];
  let looseError = '';
  try {
    const known = new Set(rows.flatMap((r) => [r.ref, r.trash_ref].filter(Boolean)));
    const all = await storage.current().listTrash();
    loose = all
      .filter((f) => !known.has(f.ref) && !/json$/i.test(f.mime || '') && !/^image\//.test(f.mime || '') && !/\.json$/i.test(f.name) && daysLeft(f.time, now) > 0)
      .map((f) => ({ key: 'x' + f.ref, ref: f.ref, deleted_at: nowStr(new Date(f.time)), name: f.name, size: f.size, mime: f.mime, logged: false, ms: f.time, left: daysLeft(f.time, now) }));
  } catch (e) {
    looseError = 'อ่านถังขยะของ Google Drive ไม่สำเร็จ ' + e.message;
  }
  return { items, loose, looseError };
}

// หาไฟล์จาก key ในหน้า (เลขแถวที่จด หรือ x + ที่อยู่ในถังขยะ ซึ่งต้องยังอยู่ในถังขยะจริง กันส่งที่อยู่ไฟล์อื่นมาเอง)
async function find(key) {
  const k = String(key || '');
  if (/^\d+$/.test(k)) {
    const r = await q.get('SELECT * FROM trash_log WHERE id = ?', Number(k));
    return r ? { ...r, logged: true, at: r.trash_ref || r.ref } : null;
  }
  if (!k.startsWith('x')) return null;
  const ref = k.slice(1);
  const hit = (await storage.current().listTrash()).find((f) => f.ref === ref);
  return hit ? { ref, at: ref, name: hit.name, size: hit.size, mime: hit.mime, logged: false } : null;
}

async function audit(actor, text, detail) {
  await features.audit(actor, text, detail || 'trashbin');
}

// กู้คืนเข้า Drive อย่างเดียว (ไฟล์กลับที่เดิม) ไม่สร้างงาน
async function restoreDrive(item, actor) {
  if (item.restored_at) throw new Error('ไฟล์นี้กู้คืนไปแล้ว');
  if (!item.logged && !item.ref.startsWith('gdrive:')) throw new Error('ไฟล์นี้ไม่รู้ที่เดิม ดาวน์โหลดไปใช้แทน');
  await storage.untrash(item.ref, item.at !== item.ref ? item.at : undefined);
  if (item.logged) await q.run("UPDATE trash_log SET restored_at = ?, restored_by_name = ?, restored_kind = 'drive' WHERE id = ?", nowStr(), actor.full_name, item.id);
  await audit(actor, `กู้ไฟล์จากถังขยะเข้า Drive ${item.name}${item.label ? ' (' + item.label + ')' : ''}`);
}

// กู้กลับเป็นงานเดิม: ไฟล์กลับที่เดิม แล้วสร้างฉบับร่างของครูคนเดิมจากข้อมูลที่จดไว้ ครูตรวจแล้วกดส่งเอง
async function restoreWork(item, actor) {
  if (!item.logged) throw new Error('ไฟล์นี้ระบบไม่ได้จดว่าเป็นงานของใคร กู้คืนเข้า Drive หรือดาวน์โหลดแทน');
  if (item.restored_at) throw new Error('ไฟล์นี้กู้คืนไปแล้ว');
  let snap = {};
  try {
    snap = JSON.parse(item.snapshot || '{}');
  } catch {}
  if (!snap.doc_type || !(await q.get('SELECT 1 AS x FROM users WHERE id = ?', snap.teacher_id))) throw new Error('ไม่พบครูเจ้าของงานนี้ในระบบแล้ว');
  if (snap.parent_id && !(await q.get('SELECT 1 AS x FROM submissions WHERE id = ?', snap.parent_id))) throw new Error('แผนที่บันทึกนี้อยู่ด้วยถูกลบไปแล้ว กู้แผนนั้นก่อน');
  if (snap.department_id && !(await q.get('SELECT 1 AS x FROM departments WHERE id = ?', snap.department_id))) snap.department_id = null;
  await storage.untrash(item.ref, item.at !== item.ref ? item.at : undefined);
  const now = nowStr();
  const cols = SNAP.filter((k) => snap[k] !== undefined);
  let subId = 0;
  await q.tx(async () => {
    const r = await q.get(
      `INSERT INTO submissions (${cols.join(', ')}, status, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, 'draft', ?, ?) RETURNING id`,
      ...cols.map((k) => snap[k]),
      now,
      now
    );
    subId = r.id;
    await q.run('INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', subId, item.kind || 'main', item.name, item.ref, item.mime || '', item.size || 0, now);
    await q.run("UPDATE trash_log SET restored_at = ?, restored_by_name = ?, restored_kind = 'work', restored_sub = ? WHERE id = ?", now, actor.full_name, subId, item.id);
  });
  await audit(actor, `กู้งานจากถังขยะเป็นฉบับร่าง ${item.label} ไฟล์ ${item.name}`, `submission ${subId}`);
  return subId;
}

module.exports = { KEEP_DAYS, SNAP, deleteWork, list, find, restoreDrive, restoreWork, daysLeft };
