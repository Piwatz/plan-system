// กฎการส่งต่องานผ่านผู้ตรวจทีละระดับ
// ครูส่ง -> ระดับ 1 -> ระดับ 2 -> ... -> ระดับสุดท้ายอนุมัติ
// ส่งกลับแก้ไขได้ทุกระดับ เมื่อครูส่งใหม่จะกลับไปที่ระดับที่ส่งคืน (หรือเริ่มใหม่ ตามที่ตั้งค่า)
const db = require('./db');
const { q, nowStr } = db;
const features = require('./features');

const ACTION_LABELS = {
  submit: 'ส่งงาน',
  resubmit: 'ส่งงานอีกครั้งหลังแก้ไข',
  approve: 'ลงนามเห็นชอบ',
  return: 'ส่งกลับให้แก้ไข',
  skip: 'ข้ามระดับนี้',
  withdraw: 'ดึงกลับมาแก้ไข',
  override: 'ผู้ดูแลระบบดำเนินการแทน',
};

// ชนิดงาน: คู่มือรายวิชาและแผน ส่งทีละรายวิชาต่อภาคเรียน บันทึกหลังแผนผูกกับแผนแต่ละเล่ม
const DOC_TYPES = {
  plan: { label: 'แผนการจัดการเรียนรู้', scored: true },
  manual: { label: 'คู่มือรายวิชา', scored: true },
  note: { label: 'บันทึกหลังแผน', scored: false },
};

const STATUS_LABELS = {
  draft: 'ฉบับร่าง',
  pending: 'รอตรวจ',
  returned: 'ส่งกลับแก้ไข',
  approved: 'อนุมัติแล้ว',
};

// ---------- คอลัมน์ที่ดึงเป็นรายการ ----------
// รูปลายเซ็นแถวละหลายสิบถึงหลายร้อย KB คำสั่งที่ดึงหลายแถวต้องระบุคอลัมน์ ไม่ใช้ SELECT *
// ดึงรูปลายเซ็นเฉพาะหน้าพิมพ์ · เพิ่มคอลัมน์ใหม่ในตาราง submissions หรือ reviews ต้องเพิ่มที่นี่ด้วย
const SUB_COLUMNS = [
  'id', 'doc_type', 'parent_id', 'teacher_id', 'department_id', 'academic_year', 'semester', 'subject_code', 'subject_name',
  'grade_level', 'teaching_methods', 'link_url', 'doc_no', 'plan_no', 'topic', 'unit_no', 'unit_name', 'hours', 'class_room',
  'teach_date', 'result_k', 'result_p', 'result_a', 'problems', 'suggestions', 'students_total', 'students_passed', 'status',
  'current_role', 'returned_role', 'score_total', 'score_max', 'score_detail', 'score_role', 'created_at', 'submitted_at',
  'updated_at', 'completed_at', 'note_mode', 'verify_code',
];
const REVIEW_COLUMNS = [
  'id', 'submission_id', 'role', 'step_label', 'user_id', 'user_name', 'user_position', 'action', 'comment',
  'score_total', 'score_max', 'score_detail', 'created_at',
];

// คอลัมน์ของงานทุกคอลัมน์ ยกเว้นรูปลายเซ็นครู (teacher_signature) เช่น subCols('s') ได้ s.id, s.doc_type, ...
function subCols(alias = '') {
  return SUB_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');
}

// คอลัมน์ของประวัติการตรวจ · signatures: false = ไม่เอารูปลายเซ็น · 'approve' = เฉพาะแถวลงนามเห็นชอบ (หน้าพิมพ์ใช้แค่นี้) · true = ทุกแถว
/** @param {string} [alias] @param {boolean | 'approve'} [signatures] */
function reviewCols(alias = '', signatures = false) {
  const p = alias ? `${alias}.` : '';
  const cols = REVIEW_COLUMNS.map((c) => p + c);
  if (signatures === 'approve') cols.push(`CASE WHEN ${p}action = 'approve' THEN ${p}signature END AS signature`);
  else if (signatures) cols.push(`${p}signature`);
  return cols.join(', ');
}

// ---------- อ่านจากข้อมูลอ้างอิงของคำขอ (sync เพราะ template เรียก) ต้อง await db.ensureRefs() ที่ทางเข้าก่อน ----------

function allSteps() {
  return db.refs().steps;
}

function activeSteps(docType) {
  const col = { manual: 'for_manual', plan: 'for_plan', note: 'for_note' }[docType] || 'for_plan';
  return allSteps().filter((s) => s[col]);
}

function stepOf(role) {
  return role ? allSteps().find((s) => s.role === role) : undefined;
}

async function rolesOf(userId) {
  return (await q.all('SELECT role FROM user_roles WHERE user_id = ?', userId)).map((r) => r.role);
}

// ผู้ถือบทบาททุกระดับในคำสั่งเดียว: Map บทบาท -> ผู้ใช้ที่ยังใช้งาน เรียงตามชื่อ (ไม่ดึงรหัสผ่านและลายเซ็น)
async function holdersByRole() {
  const map = new Map();
  const rows = await q.all(
    `SELECT r.role, u.id, u.full_name, u.position, u.department_id FROM users u JOIN user_roles r ON r.user_id = u.id
     WHERE u.is_active = 1 ORDER BY u.full_name, u.id`
  );
  for (const { role, ...u } of rows) {
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(u);
  }
  return map;
}

// รายชื่อคนที่ถือบทบาทของระดับนี้ (ระดับกลุ่มสาระ ดูเฉพาะกลุ่มสาระเดียวกับผู้ส่ง)
function holdersOf(map, step, sub) {
  const rows = map.get(step.role) || [];
  return step.scope === 'department' ? rows.filter((u) => u.department_id === sub.department_id) : rows;
}

async function holders(step, sub) {
  return holdersOf(await holdersByRole(), step, sub);
}

// ผู้ตรวจลงนามงานของตัวเองได้ไหม (สวิตช์ในหน้าฟังก์ชันเสริม) ถ้าปิด ระบบข้ามระดับนั้นไปเหมือนเดิม
function selfSign() {
  return features.isOn(null, 'selfsign');
}

// งานชิ้นเดียวครบทุกคอลัมน์ (รวมรูปลายเซ็นครู)
function getSub(id) {
  return q.get('SELECT * FROM submissions WHERE id = ?', id);
}

// รูปลายเซ็นจริง (data URL) ของผู้ใช้ ใช้ตอนส่งงานและลงนาม
// req.me.signature เป็นแค่ที่อยู่รูป (/media/signature) จึงอ่านจากฐานเสมอ เว้นแต่เพิ่งเซ็นในคำขอนี้ (เป็น data URL อยู่แล้ว)
async function signatureOf(user) {
  if (!user) return null;
  if (typeof user.signature === 'string' && user.signature.startsWith('data:')) return user.signature;
  const r = await q.get('SELECT signature FROM users WHERE id = ?', user.id);
  return (r && r.signature) || null;
}

// อ่านงานพร้อมล็อกแถวจนจบ transaction: ผู้ตรวจ 2 คนกดลงนามขั้นเดียวกันพร้อมกัน คนที่สองต้องรอแล้วเห็นสถานะใหม่
// ต้องเป็นคำสั่งแรกใน transaction ของ submit approve sendBack withdraw submitAs overrideStep
function lockSub(id) {
  return q.get('SELECT * FROM submissions WHERE id = ? FOR UPDATE', id);
}

function log(subId, actor, fields) {
  return q.run(
    `INSERT INTO reviews (submission_id, role, step_label, user_id, user_name, user_position, action, comment,
       score_total, score_max, score_detail, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    subId,
    fields.role ?? null,
    fields.step_label ?? '',
    actor ? actor.id : null,
    actor ? actor.full_name : '',
    actor ? actor.position || '' : '',
    fields.action,
    fields.comment ?? '',
    fields.score_total ?? null,
    fields.score_max ?? null,
    fields.score_detail ?? null,
    fields.signature ?? null,
    nowStr()
  );
}

// งานอื่นที่ต้องทำต่อเมื่องานเปลี่ยนสถานะ เช่น คัดลอกไฟล์ไป Google Drive
// เรียกหลังบันทึกลงฐานข้อมูลเสร็จแล้ว และไม่ทำให้การส่งหรือการลงนามล้มเหลว
const listeners = [];
function onAdvance(fn) {
  if (!listeners.includes(fn)) listeners.push(fn);
}
function notify(id) {
  for (const fn of listeners) {
    setImmediate(() => {
      try {
        fn(id);
      } catch (e) {
        console.error(e);
      }
    });
  }
}

// คิดว่างานจะไปรอที่ระดับไหน เริ่มจากลำดับ startSeq (ไม่เขียนฐาน)
// ระดับที่ผู้ตรวจทุกคนคือผู้ส่งเอง จะถูกข้าม (เว้นแต่เปิดให้ลงนามงานของตัวเอง)
// ระดับที่ยังไม่มีผู้ตรวจจะรอไว้จนกว่าผู้ดูแลระบบกำหนดคน
// คืน { skips: รายการบันทึกข้ามระดับ, role: ระดับที่ต้องรอ หรือ null = ผ่านครบ }
function planAdvance(sub, startSeq, hmap, self = selfSign()) {
  const skips = [];
  for (const st of activeSteps(sub.doc_type).filter((s) => s.seq >= startSeq)) {
    const h = holdersOf(hmap, st, sub);
    if (!self && h.length > 0 && h.every((u) => u.id === sub.teacher_id)) {
      skips.push({ role: st.role, step_label: st.label, action: 'skip', comment: 'ผู้ส่งเป็นผู้ตรวจในระดับนี้เอง ระบบจึงส่งต่อไปยังระดับถัดไป' });
      continue;
    }
    return { skips, role: st.role };
  }
  return { skips, role: null };
}

// เดินหน้าไปยังระดับถัดไปที่ต้องตรวจ แล้วคืนงานฉบับล่าสุด (ต้องอยู่ใน transaction ที่ล็อกแถวงานแล้ว)
async function advance(sub, startSeq) {
  const now = nowStr();
  const next = planAdvance(sub, startSeq, await holdersByRole());
  for (const s of next.skips) await log(sub.id, null, s);
  const after = next.role
    ? await q.get("UPDATE submissions SET status = 'pending', current_role = ?, updated_at = ? WHERE id = ? RETURNING *", next.role, now, sub.id)
    : await q.get(
        "UPDATE submissions SET status = 'approved', current_role = NULL, completed_at = ?, updated_at = ? WHERE id = ? RETURNING *",
        now,
        now,
        sub.id
      );
  notify(sub.id);
  return after;
}

function isOwner(user, sub) {
  return user && sub && user.id === sub.teacher_id;
}

function canReview(user, sub, self = selfSign()) {
  if (!user || !sub || sub.status !== 'pending' || !sub.current_role) return false;
  if (user.id === sub.teacher_id && !self) return false;
  if (!(user.roles || []).includes(sub.current_role)) return false;
  const st = stepOf(sub.current_role);
  if (!st) return false;
  if (st.scope === 'department' && user.department_id !== sub.department_id) return false;
  return true;
}

// ใครเปิดดูงานนี้ได้บ้าง
async function canView(user, sub) {
  if (!user || !sub) return false;
  if (user.is_admin || isOwner(user, sub)) return true;
  for (const role of user.roles || []) {
    const st = stepOf(role);
    if (!st) continue;
    if (st.scope === 'school') return true;
    if (st.scope === 'department' && user.department_id === sub.department_id) return true;
  }
  return Boolean(await q.get('SELECT 1 AS x FROM reviews WHERE submission_id = ? AND user_id = ? LIMIT 1', sub.id, user.id));
}

function rubric(docType) {
  return db.refs().rubrics.filter((r) => r.doc_type === docType && r.is_active);
}

function scoreStep() {
  const role = db.refs().settings.score_role;
  return role ? stepOf(role) : undefined;
}

// ต้องให้คะแนนในระดับนี้ไหม
// ถ้าระดับที่ให้คะแนนถูกข้ามหรือปิดไว้ ระดับถัดไปจะเป็นผู้ให้คะแนนแทน
function needsScore(sub) {
  if (!sub || !DOC_TYPES[sub.doc_type] || !DOC_TYPES[sub.doc_type].scored || sub.status !== 'pending') return false;
  const ss = scoreStep();
  if (!ss || rubric(sub.doc_type).length === 0) return false;
  const cur = stepOf(sub.current_role);
  if (!cur || cur.seq < ss.seq) return false;
  return sub.score_total == null || sub.score_role === sub.current_role;
}

// เกณฑ์การแปลความหมายตามแบบประเมินของโรงเรียน (คิดจากร้อยละของคะแนนเต็ม)
function scoreLevel(percent) {
  if (percent == null || Number.isNaN(percent)) return '';
  if (percent >= 90) return 'ดีมาก';
  if (percent >= 70) return 'ดี';
  if (percent >= 50) return 'ปานกลาง';
  if (percent >= 30) return 'พอใช้';
  return 'ปรับปรุง';
}

class WorkflowError extends Error {}

async function submit(subId, actor) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    if (!isOwner(actor, sub)) throw new WorkflowError('ส่งได้เฉพาะงานของตนเอง');
    if (sub.status !== 'draft' && sub.status !== 'returned') throw new WorkflowError('งานนี้ส่งไปแล้ว');
    const now = nowStr();
    const first = sub.status === 'draft' && !(await q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') LIMIT 1", sub.id));
    const sig = await signatureOf(actor);
    await q.run(
      'UPDATE submissions SET teacher_signature = ?, submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?',
      sig,
      now,
      now,
      sub.id
    );
    await log(sub.id, actor, { action: first ? 'submit' : 'resubmit', step_label: 'ครูผู้สอน', signature: sig });
    let startSeq = 0;
    if (sub.status === 'returned' && db.refs().settings.resubmit_mode !== 'restart') {
      const st = stepOf(sub.returned_role);
      if (st) startSeq = st.seq;
    }
    return advance(sub, startSeq);
  });
}

async function approve(subId, actor, { comment = '', scores = null, signature = null } = {}) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    if (!canReview(actor, sub)) throw new WorkflowError('คุณไม่ใช่ผู้ตรวจของงานนี้ในขณะนี้');
    const sig = signature || (await signatureOf(actor));
    if (!sig) throw new WorkflowError('กรุณาเซ็นชื่อก่อนลงนาม');
    const st = stepOf(sub.current_role);
    const fields = { role: st.role, step_label: st.label, action: 'approve', comment: String(comment).trim(), signature: sig };
    if (needsScore(sub)) {
      const items = rubric(sub.doc_type);
      const detail = items.map((it) => {
        const v = Number(scores ? scores[it.id] : NaN);
        if (!Number.isInteger(v) || v < 1 || v > it.max_score) {
          throw new WorkflowError('กรุณาให้คะแนนให้ครบทุกข้อ');
        }
        return { id: it.id, title: it.title, score: v, max: it.max_score };
      });
      const total = detail.reduce((a, d) => a + d.score, 0);
      const max = detail.reduce((a, d) => a + d.max, 0);
      Object.assign(fields, { score_total: total, score_max: max, score_detail: JSON.stringify(detail) });
      await q.run(
        'UPDATE submissions SET score_total = ?, score_max = ?, score_detail = ?, score_role = ? WHERE id = ?',
        total,
        max,
        fields.score_detail,
        st.role,
        sub.id
      );
    }
    await log(sub.id, actor, fields);
    return advance(sub, st.seq + 1);
  });
}

// ลงนามเห็นชอบหลายงานพร้อมกันใน transaction เดียว (ลงนามที่เลือกในกล่องงาน และลงนามบันทึกที่เหลือทั้งหมด)
// กติกาเดียวกับ approve ทีละงาน ตามลำดับใน ids · ข้ามงานที่ไม่ได้รอผู้ใช้คนนี้แล้ว หรือต้องให้คะแนนก่อน
// จำนวนคำสั่งคงที่ไม่ว่าจะลงนามกี่งาน: ล็อกทุกแถว · ลายเซ็น · ผู้ตรวจ · เพิ่มประวัติ · แก้สถานะ · คืน { done, skipped }
async function approveMany(ids, actor, { comment = '' } = {}) {
  await db.ensureRefs();
  if (!ids.length) return { done: 0, skipped: 0 };
  return q.tx(async () => {
    // ล็อกเรียงตาม id เสมอ สองคนลงนามชุดที่ทับกันพร้อมกันจะไม่ติดรอกันเอง
    const rows = await q.all(`SELECT ${subCols()} FROM submissions WHERE id = ANY(?) ORDER BY id FOR UPDATE`, ids);
    const subs = new Map(rows.map((s) => [s.id, s]));
    const self = selfSign();
    const now = nowStr();
    const text = String(comment).trim();
    /** @type {Map<string, any[]> | null} */
    let hmap = null;
    /** @type {string | null} */
    let sig = null;
    const logs = [];
    const finals = new Map();
    let done = 0;
    let skipped = 0;
    for (const id of ids) {
      const sub = subs.get(id);
      if (!sub || !canReview(actor, sub, self) || needsScore(sub)) {
        skipped += 1;
        continue;
      }
      if (!sig) sig = await signatureOf(actor);
      if (!sig) throw new WorkflowError('กรุณาเซ็นชื่อก่อนลงนาม');
      if (!hmap) hmap = await holdersByRole();
      const st = stepOf(sub.current_role);
      logs.push({ sub: sub.id, actor, role: st.role, step_label: st.label, action: 'approve', comment: text });
      const next = planAdvance(sub, st.seq + 1, hmap, self);
      for (const s of next.skips) logs.push({ sub: sub.id, actor: null, ...s });
      // จำสถานะใหม่ไว้ ถ้า id เดิมซ้ำในรายการ จะตัดสินจากสถานะใหม่เหมือนทำทีละงาน
      sub.status = next.role ? 'pending' : 'approved';
      sub.current_role = next.role;
      finals.set(sub.id, sub);
      done += 1;
    }
    if (logs.length) {
      await q.run(
        `INSERT INTO reviews (submission_id, role, step_label, user_id, user_name, user_position, action, comment, signature, created_at)
         SELECT v.submission_id, v.role, v.step_label, v.user_id, v.user_name, v.user_position, v.action, v.comment,
           CASE WHEN v.signed = 1 THEN ?::text END, ?
         FROM unnest(?::int[], ?::text[], ?::text[], ?::int[], ?::text[], ?::text[], ?::text[], ?::text[], ?::int[])
           WITH ORDINALITY AS v(submission_id, role, step_label, user_id, user_name, user_position, action, comment, signed, n)
         ORDER BY v.n`,
        sig,
        now,
        logs.map((l) => l.sub),
        logs.map((l) => l.role),
        logs.map((l) => l.step_label),
        logs.map((l) => (l.actor ? l.actor.id : null)),
        logs.map((l) => (l.actor ? l.actor.full_name : '')),
        logs.map((l) => (l.actor ? l.actor.position || '' : '')),
        logs.map((l) => l.action),
        logs.map((l) => l.comment),
        logs.map((l) => (l.action === 'approve' ? 1 : 0))
      );
      const list = [...finals.values()];
      await q.run(
        `UPDATE submissions s SET status = v.status, current_role = v.cur, updated_at = ?,
           completed_at = CASE WHEN v.status = 'approved' THEN ? ELSE s.completed_at END
         FROM unnest(?::int[], ?::text[], ?::text[]) AS v(id, status, cur)
         WHERE s.id = v.id`,
        now,
        now,
        list.map((s) => s.id),
        list.map((s) => s.status),
        list.map((s) => s.current_role)
      );
      for (const s of list) notify(s.id);
    }
    return { done, skipped };
  });
}

async function sendBack(subId, actor, { comment = '' } = {}) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    if (!canReview(actor, sub)) throw new WorkflowError('คุณไม่ใช่ผู้ตรวจของงานนี้ในขณะนี้');
    const text = String(comment).trim();
    if (!text) throw new WorkflowError('กรุณาเขียนเหตุผลหรือสิ่งที่ต้องแก้ไข');
    const st = stepOf(sub.current_role);
    await log(sub.id, actor, { role: st.role, step_label: st.label, action: 'return', comment: text });
    await q.run(
      "UPDATE submissions SET status = 'returned', returned_role = ?, current_role = NULL, updated_at = ? WHERE id = ?",
      st.role,
      nowStr(),
      sub.id
    );
    return getSub(sub.id);
  });
}

// ครูดึงงานกลับมาแก้ได้ ถ้ายังไม่มีผู้ตรวจคนไหนลงนามหลังการส่งครั้งล่าสุด
// revs = ประวัติของงานนี้ที่ดึงไว้แล้ว เรียงตามลำดับ (หน้ารายละเอียด) ไม่ต้องถามฐานซ้ำ
/** @param {any} user @param {any} sub @param {any[] | null} [revs] */
async function canWithdraw(user, sub, revs = null) {
  if (!isOwner(user, sub) || sub.status !== 'pending') return false;
  if (revs) {
    const sent = revs.filter((r) => r.action === 'submit' || r.action === 'resubmit');
    const last = sent[sent.length - 1];
    return Boolean(last) && !revs.some((r) => r.id > last.id && (r.action === 'approve' || r.action === 'override'));
  }
  const lastSubmit = await q.get(
    "SELECT id, action FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') ORDER BY id DESC LIMIT 1",
    sub.id
  );
  if (!lastSubmit) return false;
  return !(await q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND id > ? AND action IN ('approve', 'override') LIMIT 1", sub.id, lastSubmit.id));
}

async function withdraw(subId, actor) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    if (!(await canWithdraw(actor, sub))) throw new WorkflowError('ดึงกลับไม่ได้ เพราะมีผู้ตรวจลงนามแล้ว');
    const lastSubmit = await q.get(
      "SELECT action FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') ORDER BY id DESC LIMIT 1",
      sub.id
    );
    await log(sub.id, actor, { action: 'withdraw', step_label: 'ครูผู้สอน' });
    const status = lastSubmit.action === 'resubmit' ? 'returned' : 'draft';
    await q.run('UPDATE submissions SET status = ?, current_role = NULL, updated_at = ? WHERE id = ?', status, nowStr(), sub.id);
    return getSub(sub.id);
  });
}

// ---------- ผู้ดูแลระบบดำเนินการแทน ----------
// ใช้แก้ปัญหางานค้าง: ส่งแทนครู หรือดันงานผ่านระดับที่ผู้ตรวจไม่ลงนาม
// ไม่ใส่ลายเซ็นของคนอื่นแทน ช่องลายเซ็นในเอกสารจะเว้นไว้ให้เซ็นด้วยมือ และบันทึกในประวัติทุกครั้ง

function adminCheck(actor, sub) {
  if (!actor || !actor.is_admin) throw new WorkflowError('เฉพาะผู้ดูแลระบบ');
  if (!sub) throw new WorkflowError('ไม่พบงานนี้');
  if (actor.id === sub.teacher_id) throw new WorkflowError('ผู้ดูแลระบบดำเนินการแทนในงานของตัวเองไม่ได้ ต้องให้ผู้ตรวจลงนามตามปกติ');
}

async function submitAs(subId, actor) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    adminCheck(actor, sub);
    if (sub.status !== 'draft' && sub.status !== 'returned') throw new WorkflowError('งานนี้ส่งไปแล้ว');
    const now = nowStr();
    const first = !(await q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') LIMIT 1", sub.id));
    await q.run('UPDATE submissions SET submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?', now, now, sub.id);
    await log(sub.id, actor, { action: first ? 'submit' : 'resubmit', step_label: 'ผู้ดูแลระบบส่งแทนครู' });
    let startSeq = 0;
    if (sub.status === 'returned' && db.refs().settings.resubmit_mode !== 'restart') {
      const st = stepOf(sub.returned_role);
      if (st) startSeq = st.seq;
    }
    return advance(sub, startSeq);
  });
}

async function overrideStep(subId, actor, { comment = '' } = {}) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    adminCheck(actor, sub);
    if (sub.status !== 'pending' || !sub.current_role) throw new WorkflowError('งานนี้ไม่ได้รอผู้ตรวจอยู่');
    const st = stepOf(sub.current_role);
    await log(sub.id, actor, { role: st.role, step_label: st.label, action: 'override', comment: String(comment).trim() });
    return advance(sub, st.seq + 1);
  });
}

async function overrideAll(subId, actor, opts = {}) {
  let sub = await getSub(subId);
  if (sub && (sub.status === 'draft' || sub.status === 'returned')) sub = await submitAs(subId, actor);
  for (let i = 0; i < 10 && sub.status === 'pending'; i++) sub = await overrideStep(subId, actor, opts);
  return sub;
}

// ประวัติการตรวจของงานชิ้นเดียว เรียงตามลำดับ (ค่าเริ่มต้นครบทุกคอลัมน์รวมรูปลายเซ็น หน้าเว็บส่ง signatures: false)
/** @param {number} subId @param {{ signatures?: boolean | 'approve' }} [opts] */
function reviewsOf(subId, { signatures = true } = {}) {
  return q.all(`SELECT ${signatures === true ? '*' : reviewCols('', signatures)} FROM reviews WHERE submission_id = ? ORDER BY id`, subId);
}

// ประวัติการตรวจของงานหลายชิ้นในคำสั่งเดียว: Map id งาน -> รายการเรียงตามลำดับ · signatures ดู reviewCols
/** @param {number[]} ids @param {{ signatures?: boolean | 'approve' }} [opts] @returns {Promise<Map<number, any[]>>} */
async function reviewsMany(ids, { signatures = false } = {}) {
  const map = new Map();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;
  for (const r of await q.all(`SELECT ${reviewCols('', signatures)} FROM reviews WHERE submission_id = ANY(?) ORDER BY id`, ids)) {
    map.get(r.submission_id).push(r);
  }
  return map;
}

// แถบความคืบหน้าของงานหนึ่งชิ้น จากประวัติที่ดึงไว้แล้ว (hmap ใช้เฉพาะงานที่รอผู้ตรวจอยู่)
function stepsOf(sub, revs, hmap, self) {
  const cur = stepOf(sub.current_role);
  const out = [];
  for (const st of activeSteps(sub.doc_type)) {
    const last = [...revs].reverse().find((r) => r.role === st.role && ['approve', 'override', 'skip', 'return'].includes(r.action));
    const lastApprove = [...revs].reverse().find((r) => r.role === st.role && ['approve', 'override'].includes(r.action));
    let state = 'waiting';
    if (sub.status === 'draft') state = 'waiting';
    else if (sub.status === 'pending' && cur && st.role === cur.role) state = 'current';
    else if (sub.status === 'pending' && cur && st.seq > cur.seq) state = 'waiting';
    else if (sub.status === 'returned' && st.role === sub.returned_role) state = 'returned';
    else if (last && (last.action === 'approve' || last.action === 'override')) state = 'done';
    else if (last && last.action === 'skip') state = 'skipped';
    const people = state === 'current' ? holdersOf(hmap, st, sub).filter((u) => self || u.id !== sub.teacher_id) : [];
    out.push({ ...st, state, review: lastApprove || null, people });
  }
  return out;
}

// สถานะของแต่ละระดับ ใช้วาดแถบความคืบหน้าและใบพิมพ์ ของงานหลายชิ้นในคำสั่งไม่เกิน 2 คำสั่ง
// reviews = Map ประวัติที่ดึงไว้แล้ว (ไม่ต้องดึงซ้ำ) · signatures ดู reviewCols (หน้าพิมพ์ใช้ 'approve')
/** @param {any[]} subs @param {{ reviews?: Map<number, any[]> | null, signatures?: boolean | 'approve' }} [opts] */
async function progressMany(subs, { reviews = null, signatures = false } = {}) {
  await db.ensureRefs();
  const self = selfSign();
  const revs = reviews || (await reviewsMany(subs.map((s) => s.id), { signatures }));
  const waiting = subs.some((s) => s.status === 'pending' && stepOf(s.current_role));
  const hmap = waiting ? await holdersByRole() : new Map();
  return subs.map((s) => stepsOf(s, revs.get(s.id) || [], hmap, self));
}

// แถบความคืบหน้าของงานชิ้นเดียว · reviews = ประวัติของงานนี้ที่ดึงไว้แล้ว (ถ้ามี)
/** @param {any} sub @param {{ reviews?: any[] | null, signatures?: boolean | 'approve' }} [opts] */
async function progress(sub, { reviews = null, signatures = false } = {}) {
  return (await progressMany([sub], { reviews: reviews && new Map([[sub.id, reviews]]), signatures }))[0];
}

function statusText(sub) {
  if (sub.status === 'pending') {
    const st = stepOf(sub.current_role);
    return st ? `รอ${st.label}` : STATUS_LABELS.pending;
  }
  if (sub.status === 'approved' && sub.doc_type === 'note') return 'ลงนามครบแล้ว';
  return STATUS_LABELS[sub.status] || sub.status;
}

// เงื่อนไข SQL ของงานที่รอผู้ใช้คนนี้ตรวจ ตรงกับ canReview ทุกข้อ (ตัวเลขบนเมนูนับในฐานได้โดยไม่ต้องดึงรายการ)
// คืน { sql, params } หรือ null ถ้าผู้ใช้ไม่มีบทบาทผู้ตรวจ · ต้อง await db.ensureRefs() ก่อน
function inboxWhere(user, alias = 's') {
  const parts = [];
  const params = [];
  for (const role of user.roles || []) {
    const st = stepOf(role);
    if (!st) continue;
    if (st.scope === 'department') {
      parts.push(`(${alias}.current_role = ? AND ${alias}.department_id IS NOT DISTINCT FROM ?)`);
      params.push(role, user.department_id ?? null);
    } else {
      parts.push(`${alias}.current_role = ?`);
      params.push(role);
    }
  }
  if (!parts.length) return null;
  let sql = `${alias}.status = 'pending' AND (${parts.join(' OR ')})`;
  if (!selfSign()) {
    sql += ` AND ${alias}.teacher_id <> ?`;
    params.push(user.id);
  }
  return { sql, params };
}

// งานที่รอผู้ใช้คนนี้ตรวจ (ไม่ดึงรูปลายเซ็น)
async function inbox(user) {
  if (!user.roles || user.roles.length === 0) return [];
  await db.ensureRefs();
  const w = inboxWhere(user);
  if (!w) return [];
  const rows = await q.all(
    `SELECT ${subCols('s')}, u.full_name AS teacher_name, d.name AS dept_name, p.subject_code AS parent_code, p.subject_name AS parent_name
     FROM submissions s
     JOIN users u ON u.id = s.teacher_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN submissions p ON p.id = s.parent_id
     WHERE ${w.sql}
     ORDER BY s.updated_at, s.id`,
    ...w.params
  );
  const self = selfSign();
  return rows.filter((s) => canReview(user, s, self));
}

module.exports = {
  onAdvance,
  DOC_TYPES,
  ACTION_LABELS,
  STATUS_LABELS,
  WorkflowError,
  allSteps,
  activeSteps,
  stepOf,
  rolesOf,
  signatureOf,
  holders,
  holdersByRole,
  subCols,
  reviewCols,
  getSub,
  canReview,
  canView,
  isOwner,
  rubric,
  needsScore,
  scoreLevel,
  submit,
  approve,
  approveMany,
  sendBack,
  canWithdraw,
  withdraw,
  submitAs,
  overrideStep,
  overrideAll,
  reviewsOf,
  reviewsMany,
  progress,
  progressMany,
  selfSign,
  statusText,
  inboxWhere,
  inbox,
};
