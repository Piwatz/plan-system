// โอนงานระหว่างครู (ฟังก์ชันเสริม transfer) เช่น ครูสอนแทนส่งงานไว้ แล้วครูเจ้าของวิชากลับมารับช่วงต่อ
// เฉพาะผู้ดูแลระบบ ห้ามโอนงานของตัวเองหรือโอนให้ตัวเอง · โอนได้ทุกสถานะ ประวัติและลายเซ็นผู้ตรวจคงเดิม
// keepName = คงชื่อและลายเซ็นครูคนเดิมบนเอกสาร (เก็บใน doc_name doc_position) · ไม่คง = เอกสารเป็นชื่อครูผู้รับ เอาลายเซ็นครูคนเดิมออก
// ครูผู้รับใส่ลายเซ็นของตัวเองภายหลัง (sigfill) หรือเซ็นมือ ระบบไม่ใส่ลายเซ็นของผู้อื่นแทน (เอกสารราชการ)
// จำนวนคำสั่งฐานข้อมูลคงที่ไม่ว่าโอนกี่งาน · ไฟล์ใน Drive ย้ายครั้งละไม่เกิน DRIVE_BATCH ไฟล์ ที่เหลือย้ายต่อทุกชั่วโมงหรือกดปุ่มย้ายต่อ
const { q, nowStr } = require('./db');
const wf = require('./workflow');
const features = require('./features');
const storage = require('./storage');
const drivepath = require('./drivepath');

// เว็บจริงแบบฟรีติดต่อ Google ได้ราว 50 ครั้งต่อคำขอ ไฟล์ละ 2 ถึง 3 ครั้ง
const DRIVE_BATCH = 12;
const PENDING_KEY = 'transfer_drive_pending';

class TransferError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

// ครูที่รับโอนได้ เรียงตามกลุ่มสาระ และจำนวนไฟล์ใน Drive ที่รอย้าย (คำสั่งเดียว ใช้ในหน้างานซึ่งจำกัดจำนวนคำสั่ง)
async function choices() {
  const rows = await q.all(
    `SELECT u.id, u.full_name, d.name AS dept_name,
       (SELECT COALESCE(array_length(string_to_array(NULLIF(value, ''), ','), 1), 0) FROM settings WHERE key = ?) AS drive_left
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 AND u.is_teacher = 1 ORDER BY d.sort NULLS LAST, d.name NULLS LAST, u.full_name`,
    PENDING_KEY
  );
  return { teachers: rows, driveLeft: rows.length ? Number(rows[0].drive_left) || 0 : await driveLeft() };
}

// คู่มือและแผนของครูในภาคเรียน พร้อมจำนวนบันทึกหลังแผน (หน้าโอนงาน)
function worksOf(teacherId, year, sem) {
  return q.all(
    `SELECT s.id, s.doc_type, s.subject_code, s.subject_name, s.status, s."current_role", s.doc_name,
       (SELECT COUNT(*)::int FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note') AS notes
     FROM submissions s WHERE s.teacher_id = ? AND s.academic_year = ? AND s.semester = ? AND s.doc_type IN ('manual', 'plan')
     ORDER BY s.subject_code, s.doc_type, s.id`,
    teacherId,
    year,
    sem
  );
}

function label(s) {
  return `${wf.DOC_TYPES[s.doc_type].label} ${s.subject_code || ''}`.trim();
}

// ids = งานคู่มือหรือแผน · opts: keepName withNotes withTeach moveDrive notify
async function transfer(actor, ids, toId, opts = {}) {
  const { keepName = false, withNotes = true, withTeach = true, moveDrive = true, notify = true } = opts;
  const want = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!want.length) throw new TransferError('เลือกงานที่จะโอนก่อน');
  const out = await q.tx(async () => {
    // ครูผู้รับ พร้อมล็อกครูคนนี้ก่อนตรวจงานซ้ำ เหมือนตอนส่งงานใหม่
    const to = await q.get(
      `SELECT u.id, u.full_name, pg_advisory_xact_lock(u.id) IS NULL AS locked
       FROM users u WHERE u.id = ? AND u.is_active = 1 AND u.is_teacher = 1`,
      Number(toId) || 0
    );
    if (!to) throw new TransferError('เลือกครูผู้รับก่อน');
    if (to.id === actor.id) throw new TransferError('ผู้ดูแลระบบโอนงานให้ตัวเองไม่ได้ ให้ผู้ดูแลระบบคนอื่นทำ');
    // งานที่เลือก พร้อมบันทึกหลังแผนของแต่ละแผน และดูว่าครูผู้รับมีงานชนิดและวิชาเดียวกันในภาคนั้นแล้วหรือยัง
    const subs = await q.all(
      `SELECT s.id, s.doc_type, s.teacher_id, s.subject_code, u.full_name AS teacher_name,
         ARRAY(SELECT n.id FROM submissions n WHERE n.parent_id = s.id AND n.doc_type = 'note' ORDER BY n.id) AS note_ids,
         (s.subject_code <> '' AND EXISTS (SELECT 1 FROM submissions d WHERE d.teacher_id = ? AND d.doc_type = s.doc_type
           AND d.academic_year = s.academic_year AND d.semester = s.semester AND d.subject_code = s.subject_code)) AS dup
       FROM submissions s JOIN users u ON u.id = s.teacher_id
       WHERE s.id = ANY(?) AND s.doc_type IN ('manual', 'plan') ORDER BY s.id FOR UPDATE OF s`,
      to.id,
      want
    );
    if (subs.length !== want.length) throw new TransferError('ไม่พบงานบางงาน อาจถูกลบไปแล้ว เปิดหน้าใหม่แล้วลองอีกครั้ง');
    for (const s of subs) {
      if (s.teacher_id === actor.id) throw new TransferError(`${label(s)} เป็นงานของคุณเอง ให้ผู้ดูแลระบบคนอื่นโอน`);
      if (s.teacher_id === to.id) throw new TransferError(`${label(s)} เป็นงานของ ${to.full_name} อยู่แล้ว`);
      if (s.dup) throw new TransferError(`${to.full_name} มี${label(s)} ในภาคเรียนเดียวกันอยู่แล้ว โอนซ้ำไม่ได้ ลบหรือโอนงานเดิมของครูออกก่อน`);
    }
    const notes = withNotes ? subs.flatMap((s) => (s.note_ids || []).map((id) => ({ id: Number(id), parent_id: s.id }))) : [];
    const all = [...want, ...notes.map((n) => n.id)];

    // รายวิชาที่สอน: ย้ายแถวของครูคนเดิมไปให้ครูผู้รับ ถ้าผู้รับมีวิชานั้นแล้ว รวมกัน (วิชาหลักของใครก็ยังเป็นวิชาหลัก) คำสั่งเดียว
    let teach = 0;
    if (withTeach) {
      const moved = await q.get(
        `WITH v AS (SELECT DISTINCT teacher_id AS t, academic_year AS y, semester AS m, subject_code AS c FROM submissions WHERE id = ANY(?) AND subject_code <> ''),
           o AS (SELECT o.id, o.academic_year, o.semester, o.subject_code, o.is_main FROM teach_subjects o
             JOIN v ON o.teacher_id = v.t AND o.academic_year = v.y AND o.semester = v.m AND o.subject_code = v.c),
           mine AS (SELECT r.id AS rid, o.id AS oid, o.is_main FROM teach_subjects r
             JOIN o ON r.teacher_id = ? AND r.academic_year = o.academic_year AND r.semester = o.semester AND r.subject_code = o.subject_code),
           keep AS (UPDATE teach_subjects r SET is_main = GREATEST(r.is_main, mine.is_main) FROM mine WHERE r.id = mine.rid RETURNING r.id),
           del AS (DELETE FROM teach_subjects x USING mine WHERE x.id = mine.oid RETURNING x.id),
           upd AS (UPDATE teach_subjects x SET teacher_id = ? FROM o WHERE x.id = o.id AND o.id NOT IN (SELECT oid FROM mine) RETURNING x.id)
         SELECT (SELECT COUNT(*) FROM del)::int + (SELECT COUNT(*) FROM upd)::int AS n, (SELECT COUNT(*) FROM keep)::int AS kept`,
        want,
        to.id,
        to.id
      );
      teach = moved ? moved.n : 0;
    }

    // กลุ่มสาระของงานคงเดิม (วิชาเป็นของกลุ่มสาระ และหัวหน้ากลุ่มสาระที่ลงนามไว้แล้วพิมพ์ชื่อกลุ่มสาระนั้น) แม้ครูผู้รับอยู่กลุ่มสาระอื่น
    // ชื่อบนเอกสาร: คงชื่อ = ชื่อครูคนแรกสุดที่เขียนเอกสาร (โอนต่อหลายทอดยังเป็นชื่อเดิม) ถ้าโอนกลับไปหาครูคนนั้นก็กลับเป็นปกติ
    const now = nowStr();
    await q.run(
      `UPDATE submissions s SET teacher_id = ?, updated_at = ?,
         doc_name = CASE WHEN ? = 1 AND COALESCE(NULLIF(s.doc_name, ''), u.full_name) <> ? THEN COALESCE(NULLIF(s.doc_name, ''), u.full_name) ELSE '' END,
         doc_position = CASE WHEN ? = 1 AND COALESCE(NULLIF(s.doc_name, ''), u.full_name) <> ? THEN CASE WHEN s.doc_name <> '' THEN s.doc_position ELSE u.position END ELSE '' END,
         teacher_signature = CASE WHEN ? = 1 THEN s.teacher_signature ELSE NULL END
       FROM users u WHERE u.id = s.teacher_id AND s.id = ANY(?)`,
      to.id,
      now,
      keepName ? 1 : 0,
      to.full_name,
      keepName ? 1 : 0,
      to.full_name,
      keepName ? 1 : 0,
      all
    );

    // ประวัติของทุกงานที่โอน และแจ้งครูผู้รับ (คำสั่งเดียว)
    const from = new Map(subs.map((s) => [s.id, s.teacher_name]));
    const parentOf = new Map(notes.map((n) => [n.id, n.parent_id]));
    const noteCount = new Map();
    for (const n of notes) noteCount.set(n.parent_id, (noteCount.get(n.parent_id) || 0) + 1);
    const how = keepName ? ' คงชื่อครูคนเดิมบนเอกสาร' : '';
    const comments = all.map((id) => {
      const parent = parentOf.get(id);
      const extra = !parent && noteCount.get(id) ? ` พร้อมบันทึกหลังแผน ${noteCount.get(id)} ฉบับ` : '';
      return `โอนงานจาก ${from.get(parent || id)} ให้ ${to.full_name}${extra}${how}`;
    });
    const list = subs.map(label).join(' ');
    const alert = `ผู้ดูแลระบบโอนงานให้คุณ ${subs.length} งาน ${list}${notes.length ? ` พร้อมบันทึกหลังแผน ${notes.length} ฉบับ` : ''}`;
    await q.run(
      `WITH r AS (
         INSERT INTO reviews (submission_id, role, step_label, user_id, user_name, user_position, action, comment, created_at)
         SELECT v.id, NULL, 'ผู้ดูแลระบบ', ?, ?, ?, 'transfer', v.c, ? FROM unnest(?::int[], ?::text[]) AS v(id, c) RETURNING id)
       INSERT INTO notifications (user_id, from_user_id, from_name, text, link, created_at)
       SELECT ?, NULL, 'ระบบ', ?, ?, ? WHERE ? = 1 AND EXISTS (SELECT 1 FROM r)`,
      actor.id,
      actor.full_name,
      actor.position || '',
      now,
      all,
      comments,
      to.id,
      alert,
      subs.length === 1 ? `/s/${subs[0].id}` : '/my',
      now,
      notify ? 1 : 0
    );
    const names = [...new Set(subs.map((s) => s.teacher_name))].join(' ');
    await features.audit(
      actor,
      `โอนงาน ${subs.length} งาน จาก ${names} ให้ ${to.full_name}${notes.length ? ` บันทึกหลังแผน ${notes.length} ฉบับ` : ''}`,
      `${list} submission ${all.join(' ')}${how}${withTeach ? ` รายวิชาที่สอน ${teach}` : ''}`
    );
    return { to, works: subs.length, notes: notes.length, teach, ids: all };
  });
  out.drive = moveDrive ? await queueDrive(out.ids) : null;
  return out;
}

// ---------- ย้ายไฟล์ใน Google Drive ไปโฟลเดอร์ของครูเจ้าของงาน ----------
// คิวเก็บเป็นรหัสไฟล์คั่นด้วยจุลภาคในตาราง settings

// เพิ่มไฟล์ปัจจุบันของงานเหล่านี้ (เฉพาะที่อยู่ใน Drive) เข้าคิว (คำสั่งเดียว) แล้วย้ายทันทีหนึ่งรอบ
async function queueDrive(subIds) {
  await q.run(
    `WITH ids AS (
       SELECT x::int AS id FROM unnest(string_to_array(NULLIF((SELECT value FROM settings WHERE key = ?), ''), ',')) AS x
       UNION SELECT id FROM files WHERE submission_id = ANY(?) AND is_current = 1 AND stored_name LIKE 'gdrive:%')
     INSERT INTO settings (key, value) SELECT ?, COALESCE(string_agg(id::text, ',' ORDER BY id), '') FROM ids
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    PENDING_KEY,
    subIds,
    PENDING_KEY
  );
  return runDrive();
}

// ย้ายไฟล์ในคิวไม่เกิน DRIVE_BATCH ไฟล์ คืน { moved, failed, left } · ไฟล์ที่ย้ายไม่สำเร็จยังอยู่ในคิว
async function runDrive() {
  const rows = await q.all(
    `WITH p AS (SELECT string_to_array(NULLIF(value, ''), ',')::int[] AS ids FROM settings WHERE key = ?)
     SELECT p.ids, f.id, f.stored_name, f.original_name, s.doc_type, s.academic_year, s.semester, s.subject_code, s.subject_name,
       u.full_name AS teacher_name, d.name AS dept_name
     FROM p LEFT JOIN (files f JOIN submissions s ON s.id = f.submission_id JOIN users u ON u.id = s.teacher_id
       LEFT JOIN departments d ON d.id = s.department_id) ON f.id = ANY(p.ids[1:${DRIVE_BATCH}])`,
    PENDING_KEY
  );
  const ids = ((rows[0] && rows[0].ids) || []).map(Number);
  if (!ids.length) return { moved: 0, failed: 0, left: 0 };
  const failed = [];
  let moved = 0;
  for (const r of rows) {
    if (r.id == null) continue;
    const folder = drivepath.relPath(r, r, 0, 1).split('/').slice(0, -1).join('/');
    try {
      await storage.move(r.stored_name, folder);
      moved++;
    } catch (e) {
      console.error('ย้ายไฟล์ใน Drive ไม่สำเร็จ', r.id, e.message);
      failed.push(r.id);
    }
  }
  // ไฟล์ที่ถูกลบไปแล้ว (ไม่พบแถว) หลุดจากคิวไปเอง · ที่ไม่สำเร็จไปต่อท้ายคิว ไม่ขวางไฟล์อื่น
  const rest = [...ids.slice(DRIVE_BATCH), ...failed];
  await q.run('UPDATE settings SET value = ? WHERE key = ?', rest.join(','), PENDING_KEY);
  return { moved, failed: failed.length, left: rest.length };
}

// จำนวนไฟล์ที่รอย้าย (แสดงปุ่มย้ายต่อ)
async function driveLeft() {
  const r = await q.get("SELECT COALESCE(array_length(string_to_array(NULLIF(value, ''), ','), 1), 0) AS n FROM settings WHERE key = ?", PENDING_KEY);
  return r ? Number(r.n) : 0;
}

module.exports = { DRIVE_BATCH, TransferError, choices, worksOf, transfer, queueDrive, runDrive, driveLeft };
