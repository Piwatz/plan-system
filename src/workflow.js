// กฎการส่งต่องานผ่านผู้ตรวจทีละระดับ
// ครูส่ง -> ระดับ 1 -> ระดับ 2 -> ... -> ระดับสุดท้ายอนุมัติ
// ส่งกลับแก้ไขได้ทุกระดับ เมื่อครูส่งใหม่จะกลับไปที่ระดับที่ส่งคืน (หรือเริ่มใหม่ ตามที่ตั้งค่า)
const { q, nowStr, getSettings } = require('./db');
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

function allSteps() {
  return q.all('SELECT * FROM workflow_steps ORDER BY seq');
}

function activeSteps(docType) {
  const col = { manual: 'for_manual', plan: 'for_plan', note: 'for_note' }[docType] || 'for_plan';
  return allSteps().filter((s) => s[col]);
}

function stepOf(role) {
  return role ? q.get('SELECT * FROM workflow_steps WHERE role = ?', role) : undefined;
}

function rolesOf(userId) {
  return q.all('SELECT role FROM user_roles WHERE user_id = ?', userId).map((r) => r.role);
}

// รายชื่อคนที่ถือบทบาทของระดับนี้ (ระดับกลุ่มสาระ ดูเฉพาะกลุ่มสาระเดียวกับผู้ส่ง)
function holders(step, sub) {
  const rows = q.all(
    `SELECT u.* FROM users u JOIN user_roles r ON r.user_id = u.id
     WHERE r.role = ? AND u.is_active = 1 ORDER BY u.full_name`,
    step.role
  );
  return step.scope === 'department' ? rows.filter((u) => u.department_id === sub.department_id) : rows;
}

// ผู้ตรวจลงนามงานของตัวเองได้ไหม (สวิตช์ในหน้าฟังก์ชันเสริม) ถ้าปิด ระบบข้ามระดับนั้นไปเหมือนเดิม
function selfSign() {
  return features.isOn(null, 'selfsign');
}

function getSub(id) {
  return q.get('SELECT * FROM submissions WHERE id = ?', id);
}

function log(subId, actor, fields) {
  q.run(
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

// เดินหน้าไปยังระดับถัดไปที่ต้องตรวจ เริ่มจากลำดับ startSeq
// ระดับที่ผู้ตรวจทุกคนคือผู้ส่งเอง จะถูกข้าม (เว้นแต่เปิดให้ลงนามงานของตัวเอง)
// ระดับที่ยังไม่มีผู้ตรวจจะรอไว้จนกว่าผู้ดูแลระบบกำหนดคน
function advance(subId, startSeq) {
  const sub = getSub(subId);
  const now = nowStr();
  const self = selfSign();
  for (const st of activeSteps(sub.doc_type).filter((s) => s.seq >= startSeq)) {
    const h = holders(st, sub);
    if (!self && h.length > 0 && h.every((u) => u.id === sub.teacher_id)) {
      log(sub.id, null, {
        role: st.role,
        step_label: st.label,
        action: 'skip',
        comment: 'ผู้ส่งเป็นผู้ตรวจในระดับนี้เอง ระบบจึงส่งต่อไปยังระดับถัดไป',
      });
      continue;
    }
    q.run("UPDATE submissions SET status = 'pending', current_role = ?, updated_at = ? WHERE id = ?", st.role, now, sub.id);
    notify(sub.id);
    return getSub(sub.id);
  }
  q.run(
    "UPDATE submissions SET status = 'approved', current_role = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
    now,
    now,
    sub.id
  );
  notify(sub.id);
  return getSub(sub.id);
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
function canView(user, sub) {
  if (!user || !sub) return false;
  if (user.is_admin || isOwner(user, sub)) return true;
  for (const role of user.roles || []) {
    const st = stepOf(role);
    if (!st) continue;
    if (st.scope === 'school') return true;
    if (st.scope === 'department' && user.department_id === sub.department_id) return true;
  }
  return Boolean(q.get('SELECT 1 AS x FROM reviews WHERE submission_id = ? AND user_id = ? LIMIT 1', sub.id, user.id));
}

function rubric(docType) {
  return q.all('SELECT * FROM rubric_items WHERE doc_type = ? AND is_active = 1 ORDER BY seq, id', docType);
}

function scoreStep() {
  const role = getSettings().score_role;
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

function submit(subId, actor) {
  return q.tx(() => {
    const sub = getSub(subId);
    if (!isOwner(actor, sub)) throw new WorkflowError('ส่งได้เฉพาะงานของตนเอง');
    if (sub.status !== 'draft' && sub.status !== 'returned') throw new WorkflowError('งานนี้ส่งไปแล้ว');
    const now = nowStr();
    const first = sub.status === 'draft' && !q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') LIMIT 1", sub.id);
    q.run(
      'UPDATE submissions SET teacher_signature = ?, submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?',
      actor.signature || null,
      now,
      now,
      sub.id
    );
    log(sub.id, actor, { action: first ? 'submit' : 'resubmit', step_label: 'ครูผู้สอน', signature: actor.signature || null });
    let startSeq = 0;
    if (sub.status === 'returned' && getSettings().resubmit_mode !== 'restart') {
      const st = stepOf(sub.returned_role);
      if (st) startSeq = st.seq;
    }
    return advance(sub.id, startSeq);
  });
}

function approve(subId, actor, { comment = '', scores = null, signature = null } = {}) {
  return q.tx(() => {
    const sub = getSub(subId);
    if (!canReview(actor, sub)) throw new WorkflowError('คุณไม่ใช่ผู้ตรวจของงานนี้ในขณะนี้');
    const sig = signature || actor.signature;
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
      q.run(
        'UPDATE submissions SET score_total = ?, score_max = ?, score_detail = ?, score_role = ? WHERE id = ?',
        total,
        max,
        fields.score_detail,
        st.role,
        sub.id
      );
    }
    log(sub.id, actor, fields);
    return advance(sub.id, st.seq + 1);
  });
}

function sendBack(subId, actor, { comment = '' } = {}) {
  return q.tx(() => {
    const sub = getSub(subId);
    if (!canReview(actor, sub)) throw new WorkflowError('คุณไม่ใช่ผู้ตรวจของงานนี้ในขณะนี้');
    const text = String(comment).trim();
    if (!text) throw new WorkflowError('กรุณาเขียนเหตุผลหรือสิ่งที่ต้องแก้ไข');
    const st = stepOf(sub.current_role);
    log(sub.id, actor, { role: st.role, step_label: st.label, action: 'return', comment: text });
    q.run(
      "UPDATE submissions SET status = 'returned', returned_role = ?, current_role = NULL, updated_at = ? WHERE id = ?",
      st.role,
      nowStr(),
      sub.id
    );
    return getSub(sub.id);
  });
}

// ครูดึงงานกลับมาแก้ได้ ถ้ายังไม่มีผู้ตรวจคนไหนลงนามหลังการส่งครั้งล่าสุด
function canWithdraw(user, sub) {
  if (!isOwner(user, sub) || sub.status !== 'pending') return false;
  const lastSubmit = q.get(
    "SELECT id, action FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') ORDER BY id DESC LIMIT 1",
    sub.id
  );
  if (!lastSubmit) return false;
  return !q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND id > ? AND action IN ('approve', 'override') LIMIT 1", sub.id, lastSubmit.id);
}

function withdraw(subId, actor) {
  return q.tx(() => {
    const sub = getSub(subId);
    if (!canWithdraw(actor, sub)) throw new WorkflowError('ดึงกลับไม่ได้ เพราะมีผู้ตรวจลงนามแล้ว');
    const lastSubmit = q.get(
      "SELECT action FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') ORDER BY id DESC LIMIT 1",
      sub.id
    );
    log(sub.id, actor, { action: 'withdraw', step_label: 'ครูผู้สอน' });
    const status = lastSubmit.action === 'resubmit' ? 'returned' : 'draft';
    q.run('UPDATE submissions SET status = ?, current_role = NULL, updated_at = ? WHERE id = ?', status, nowStr(), sub.id);
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

function submitAs(subId, actor) {
  return q.tx(() => {
    const sub = getSub(subId);
    adminCheck(actor, sub);
    if (sub.status !== 'draft' && sub.status !== 'returned') throw new WorkflowError('งานนี้ส่งไปแล้ว');
    const now = nowStr();
    const first = !q.get("SELECT 1 AS x FROM reviews WHERE submission_id = ? AND action IN ('submit','resubmit') LIMIT 1", sub.id);
    q.run('UPDATE submissions SET submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?', now, now, sub.id);
    log(sub.id, actor, { action: first ? 'submit' : 'resubmit', step_label: 'ผู้ดูแลระบบส่งแทนครู' });
    let startSeq = 0;
    if (sub.status === 'returned' && getSettings().resubmit_mode !== 'restart') {
      const st = stepOf(sub.returned_role);
      if (st) startSeq = st.seq;
    }
    return advance(sub.id, startSeq);
  });
}

function overrideStep(subId, actor, { comment = '' } = {}) {
  return q.tx(() => {
    const sub = getSub(subId);
    adminCheck(actor, sub);
    if (sub.status !== 'pending' || !sub.current_role) throw new WorkflowError('งานนี้ไม่ได้รอผู้ตรวจอยู่');
    const st = stepOf(sub.current_role);
    log(sub.id, actor, { role: st.role, step_label: st.label, action: 'override', comment: String(comment).trim() });
    return advance(sub.id, st.seq + 1);
  });
}

function overrideAll(subId, actor, opts = {}) {
  let sub = getSub(subId);
  if (sub && (sub.status === 'draft' || sub.status === 'returned')) sub = submitAs(subId, actor);
  for (let i = 0; i < 10 && sub.status === 'pending'; i++) sub = overrideStep(subId, actor, opts);
  return sub;
}

function reviewsOf(subId) {
  return q.all('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id', subId);
}

// สถานะของแต่ละระดับ ใช้วาดแถบความคืบหน้าและใบพิมพ์
function progress(sub) {
  const self = selfSign();
  const revs = reviewsOf(sub.id);
  const cur = stepOf(sub.current_role);
  return activeSteps(sub.doc_type).map((st) => {
    const last = [...revs].reverse().find((r) => r.role === st.role && ['approve', 'override', 'skip', 'return'].includes(r.action));
    const lastApprove = [...revs].reverse().find((r) => r.role === st.role && ['approve', 'override'].includes(r.action));
    let state = 'waiting';
    if (sub.status === 'draft') state = 'waiting';
    else if (sub.status === 'pending' && cur && st.role === cur.role) state = 'current';
    else if (sub.status === 'pending' && cur && st.seq > cur.seq) state = 'waiting';
    else if (sub.status === 'returned' && st.role === sub.returned_role) state = 'returned';
    else if (last && (last.action === 'approve' || last.action === 'override')) state = 'done';
    else if (last && last.action === 'skip') state = 'skipped';
    const people = state === 'current' ? holders(st, sub).filter((u) => self || u.id !== sub.teacher_id) : [];
    return { ...st, state, review: lastApprove || null, people };
  });
}

function statusText(sub) {
  if (sub.status === 'pending') {
    const st = stepOf(sub.current_role);
    return st ? `รอ${st.label}` : STATUS_LABELS.pending;
  }
  if (sub.status === 'approved' && sub.doc_type === 'note') return 'ลงนามครบแล้ว';
  return STATUS_LABELS[sub.status] || sub.status;
}

// จำนวนงานที่รอผู้ใช้คนนี้ตรวจ
function inbox(user) {
  if (!user.roles || user.roles.length === 0) return [];
  const marks = user.roles.map(() => '?').join(',');
  const rows = q.all(
    `SELECT s.*, u.full_name AS teacher_name, d.name AS dept_name, p.subject_code AS parent_code, p.subject_name AS parent_name
     FROM submissions s
     JOIN users u ON u.id = s.teacher_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN submissions p ON p.id = s.parent_id
     WHERE s.status = 'pending' AND s.current_role IN (${marks})
     ORDER BY s.updated_at`,
    ...user.roles
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
  holders,
  getSub,
  canReview,
  canView,
  isOwner,
  rubric,
  needsScore,
  scoreLevel,
  submit,
  approve,
  sendBack,
  canWithdraw,
  withdraw,
  submitAs,
  overrideStep,
  overrideAll,
  reviewsOf,
  progress,
  selfSign,
  statusText,
  inbox,
};
