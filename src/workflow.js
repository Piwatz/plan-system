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
  cover: 'เพิ่มหน้าปก (ไฟล์เดิมเก็บไว้ในประวัติ)',
  frontpages: 'เปลี่ยนปก (ไฟล์เดิมเก็บไว้ในประวัติ)',
  oldfile: 'กลับไปใช้ไฟล์รุ่นก่อน (ไฟล์ที่ใช้อยู่เก็บไว้ในประวัติ)',
  sigconfirm: 'ครูยืนยันงานที่ผู้ดูแลระบบส่งแทน และใส่ลายเซ็นของตัวเอง',
  proxynew: 'ผู้ดูแลระบบสร้างงานแทนครู',
  transfer: 'ผู้ดูแลระบบโอนงานให้ครูคนอื่น',
  docno: 'ผู้ดูแลระบบเติมเลขที่บันทึกข้อความ',
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
  'updated_at', 'completed_at', 'note_mode', 'verify_code', 'doc_name', 'doc_position', 'student_rooms',
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

// ข้อความแจ้งเตือนของระบบถึงครูเจ้าของงาน แผนและคู่มือแจ้งงานละข้อความ บันทึกหลังแผนรวมเป็นข้อความเดียวต่อเล่ม
// head = บรรทัดแรก · tail(งาน, เล่ม) = บรรทัดท้าย (เล่ม = จำนวนแผ่น หรือ 0 ถ้าเป็นแผนหรือคู่มือ) · คืน [{ user, text, link }]
function ownerMessages(subs, head, tail) {
  const out = [];
  const books = new Map();
  for (const s of subs) {
    if (s.doc_type === 'note' && s.parent_id) {
      const b = books.get(s.parent_id) || { ...s, n: 0 };
      b.n += 1;
      books.set(s.parent_id, b);
    } else {
      out.push({ user: s.teacher_id, text: `${head}
${DOC_TYPES[s.doc_type].label} ${s.subject_code || ''} ${s.subject_name || ''}
${tail(s, 0)}`, link: `/s/${s.id}` });
    }
  }
  for (const [planId, b] of books) {
    out.push({ user: b.teacher_id, text: `${head}
บันทึกหลังแผน ${b.subject_code || ''} ${b.subject_name || ''} ${b.n} แผ่น
${tail(b, b.n)}`, link: `/s/${planId}#notes` });
  }
  return out;
}

// เพิ่มข้อความแจ้งเตือนจาก ระบบ หลายแถวในคำสั่งเดียว (0 แถวก็ส่งคำสั่ง ให้จำนวนคำสั่งคงที่)
function systemNotify(rows) {
  return q.run(
    `INSERT INTO notifications (user_id, from_user_id, from_name, text, link, created_at)
     SELECT v.u, NULL, 'ระบบ', v.t, v.l, ? FROM unnest(?::int[], ?::text[], ?::text[]) AS v(u, t, l)`,
    nowStr(),
    rows.map((x) => x.user),
    rows.map((x) => x.text),
    rows.map((x) => x.link)
  );
}

// แจ้งครูในหน้าการแจ้งเตือนเมื่องานผ่านครบทุกระดับ (ฟังก์ชันเสริม donenotify) อยู่ใน transaction เดียวกับการลงนาม
// ไม่แจ้งเมื่อครูเจ้าของงานทำให้ผ่านเอง (ส่งแล้วผ่านทันที เห็นกล่องหลังกดส่งแล้ว) · ผู้ดูแลดันผ่านแทนก็แจ้ง ข้อความไม่บอกว่าใครดัน
// บันทึกหลังแผนแจ้งครั้งเดียวต่อเล่มในการลงนามแต่ละครั้ง ไม่แจ้งทีละแผ่น
async function doneNotify(subs, actor, always = false) {
  if (!features.isOn(null, 'donenotify')) return;
  const list = subs.filter((s) => s && s.status === 'approved' && !(actor && actor.id === s.teacher_id));
  // always: ไม่มีงานที่ผ่านครบก็ยังส่งคำสั่ง (เพิ่ม 0 แถว) ให้ลงนามหลายงานใช้จำนวนคำสั่งคงที่
  if (!list.length && !always) return;
  await systemNotify(
    ownerMessages(list, 'ผ่านครบทุกระดับแล้ว', (s, n) => (n ? 'พิมพ์บันทึกหลังแผนที่มีลายเซ็นครบได้แล้ว' : 'พิมพ์บันทึกข้อความและแบบประเมินที่มีลายเซ็นครบได้แล้ว'))
  );
}

// แจ้งครูเมื่อถูกส่งกลับให้แก้ (ฟังก์ชันเสริม retnotify) บอกระดับที่ส่งกลับและความเห็น · ส่งกลับทั้งเล่มแจ้งครั้งเดียว
// subs = งานที่ส่งกลับ พร้อม ret_label (ระดับ) และ ret_comment (ความเห็น) · ส่งกลับงานของตัวเองไม่แจ้ง
async function returnNotify(subs, actor) {
  if (!features.isOn(null, 'retnotify')) return;
  const list = subs.filter((s) => s && !(actor && actor.id === s.teacher_id));
  if (!list.length) return;
  await systemNotify(
    ownerMessages(list, 'ส่งกลับให้แก้ไข', (s, n) =>
      n ? `${s.ret_label} ส่งกลับทั้งเล่ม กดเปิดงานเพื่อดูแผ่นที่ต้องแก้` : `${s.ret_label}: ${s.ret_comment}
กดเปิดงาน แก้ไขตามความเห็น แล้วส่งอีกครั้ง`
    )
  );
}

// เดินหน้าไปยังระดับถัดไปที่ต้องตรวจ แล้วคืนงานฉบับล่าสุด (ต้องอยู่ใน transaction ที่ล็อกแถวงานแล้ว)
async function advance(sub, startSeq, actor = null) {
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
  if (after.status === 'approved') await doneNotify([after], actor);
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
      // งานที่โอนมาแบบคงชื่อครูคนเดิม (doc_name) เอกสารยังเป็นชื่อครูคนเดิม จึงคงลายเซ็นเดิม ไม่ใส่ลายเซ็นของผู้ส่ง
      "UPDATE submissions SET teacher_signature = CASE WHEN doc_name <> '' THEN teacher_signature ELSE ?::text END, submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?",
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
    return advance(sub, startSeq, actor);
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
    return advance(sub, st.seq + 1, actor);
  });
}

// ลงนามเห็นชอบหลายงานพร้อมกันใน transaction เดียว (ลงนามที่เลือกในกล่องงาน และลงนามบันทึกที่เหลือทั้งหมด)
// กติกาเดียวกับ approve ทีละงาน ตามลำดับใน ids · ข้ามงานที่ไม่ได้รอผู้ใช้คนนี้แล้ว หรือต้องให้คะแนนก่อน
// จำนวนคำสั่งคงที่ไม่ว่าจะลงนามกี่งาน: ล็อกทุกแถว · ลายเซ็น · ผู้ตรวจ · เพิ่มประวัติ · แก้สถานะ · คืน { done, skipped }
// comments = { id: ข้อความ } ความเห็นแยกรายฉบับ (ลงนามบันทึกทั้งเล่ม) ฉบับที่ไม่มีใช้ comment
/** @param {number[]} ids @param {any} actor @param {{ comment?: string, comments?: Record<string, string> }} [opts] */
async function approveMany(ids, actor, { comment = '', comments = {} } = {}) {
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
      const own = comments[sub.id];
      logs.push({ sub: sub.id, actor, role: st.role, step_label: st.label, action: 'approve', comment: own == null ? text : String(own).trim() });
      const next = planAdvance(sub, st.seq + 1, hmap, self);
      for (const s of next.skips) logs.push({ sub: sub.id, actor: null, ...s });
      // จำสถานะใหม่ไว้ ถ้า id เดิมซ้ำในรายการ จะตัดสินจากสถานะใหม่เหมือนทำทีละงาน
      sub.status = next.role ? 'pending' : 'approved';
      sub.current_role = next.role;
      finals.set(sub.id, sub);
      done += 1;
    }
    if (logs.length) {
      await logMany(logs.map((l) => ({ ...l, signed: l.action === 'approve' })), sig, now);
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
      await doneNotify(list, actor, true);
      for (const s of list) notify(s.id);
    }
    return { done, skipped };
  });
}

// เพิ่มประวัติหลายแถวในคำสั่งเดียว เรียงตามลำดับใน logs · แถวที่ signed ใส่รูปลายเซ็น sig
// logs = [{ sub, actor, role, step_label, action, comment, signed }]
function logMany(logs, sig, now) {
  return q.run(
    `INSERT INTO reviews (submission_id, role, step_label, user_id, user_name, user_position, action, comment, signature, created_at)
     SELECT v.submission_id, v.role, v.step_label, v.user_id, v.user_name, v.user_position, v.action, v.comment,
       CASE WHEN v.signed = 1 THEN ?::text END, ?
     FROM unnest(?::int[], ?::text[], ?::text[], ?::int[], ?::text[], ?::text[], ?::text[], ?::text[], ?::int[])
       WITH ORDINALITY AS v(submission_id, role, step_label, user_id, user_name, user_position, action, comment, signed, n)
     ORDER BY v.n`,
    sig,
    now,
    logs.map((l) => l.sub),
    logs.map((l) => l.role ?? null),
    logs.map((l) => l.step_label ?? ''),
    logs.map((l) => (l.actor ? l.actor.id : null)),
    logs.map((l) => (l.actor ? l.actor.full_name : '')),
    logs.map((l) => (l.actor ? l.actor.position || '' : '')),
    logs.map((l) => l.action),
    logs.map((l) => l.comment ?? ''),
    logs.map((l) => (l.signed ? 1 : 0))
  );
}

// ---------- บันทึกหลังแผนทั้งเล่ม (ฟังก์ชันเสริม notebook) ----------
// 1 เล่ม = บันทึกหลังแผนทุกฉบับของแผน 1 วิชา (parent_id) แต่ละฉบับยังเก็บสถานะและประวัติของตัวเอง หน้าพิมพ์จึงมีลายเซ็นทุกแผ่นเหมือนเดิม

// ความเห็นของแผ่นที่ไม่ต้องแก้ ตอนผู้ตรวจส่งกลับทั้งเล่ม (หน้าแผนใช้แยกแผ่นที่ต้องแก้จากข้อความนี้)
const BOOK_KEEP = 'ส่งกลับพร้อมทั้งเล่ม แผ่นนี้ไม่ต้องแก้';

// ส่งหลายฉบับในครั้งเดียว กติกาเดียวกับ submit ทีละฉบับ (ผู้ดูแลระบบส่งแทนครูเหมือน submitAs ไม่ใส่ลายเซ็นครู)
// ทุกฉบับต้องเป็นร่างหรือถูกส่งกลับ ไม่อย่างนั้นไม่ส่งสักฉบับ · จำนวนคำสั่งคงที่ไม่ว่าจะส่งกี่ฉบับ · คืนงานฉบับล่าสุดเรียงตาม id
async function submitMany(ids, actor) {
  await db.ensureRefs();
  const want = [...new Set(ids)];
  if (!want.length) return [];
  return q.tx(async () => {
    const rows = await q.all(`SELECT ${subCols()} FROM submissions WHERE id = ANY(?) ORDER BY id FOR UPDATE`, want);
    if (rows.length !== want.length) throw new WorkflowError('ไม่พบงานบางฉบับ');
    const asAdmin = Boolean(actor && actor.is_admin) && rows.some((s) => s.teacher_id !== actor.id);
    for (const s of rows) {
      if (asAdmin) adminCheck(actor, s);
      else if (!isOwner(actor, s)) throw new WorkflowError('ส่งได้เฉพาะงานของตนเอง');
      if (s.status !== 'draft' && s.status !== 'returned') throw new WorkflowError('มีบางฉบับส่งไปแล้ว');
    }
    const now = nowStr();
    const sent = new Set(
      (await q.all("SELECT DISTINCT submission_id FROM reviews WHERE submission_id = ANY(?) AND action IN ('submit','resubmit')", want)).map(
        (r) => r.submission_id
      )
    );
    const sig = asAdmin ? null : await signatureOf(actor);
    const hmap = await holdersByRole();
    const self = selfSign();
    const restart = db.refs().settings.resubmit_mode === 'restart';
    const logs = [];
    for (const s of rows) {
      const first = asAdmin ? !sent.has(s.id) : s.status === 'draft' && !sent.has(s.id);
      logs.push({ sub: s.id, actor, step_label: asAdmin ? 'ผู้ดูแลระบบส่งแทนครู' : 'ครูผู้สอน', action: first ? 'submit' : 'resubmit', signed: !asAdmin });
      let startSeq = 0;
      if (s.status === 'returned' && !restart) {
        const st = stepOf(s.returned_role);
        if (st) startSeq = st.seq;
      }
      const next = planAdvance(s, startSeq, hmap, self);
      for (const k of next.skips) logs.push({ sub: s.id, actor: null, ...k });
      s.status = next.role ? 'pending' : 'approved';
      s.current_role = next.role;
    }
    await logMany(logs, sig, now);
    const out = await q.all(
      `UPDATE submissions s SET status = v.status, current_role = v.cur, updated_at = ?, submitted_at = COALESCE(s.submitted_at, ?),
         teacher_signature = CASE WHEN ? = 1 OR s.doc_name <> '' THEN s.teacher_signature ELSE ?::text END,
         completed_at = CASE WHEN v.status = 'approved' THEN ? ELSE s.completed_at END
       FROM unnest(?::int[], ?::text[], ?::text[]) AS v(id, status, cur)
       WHERE s.id = v.id RETURNING ${subCols('s')}`,
      now,
      now,
      asAdmin ? 1 : 0,
      sig,
      now,
      rows.map((s) => s.id),
      rows.map((s) => s.status),
      rows.map((s) => s.current_role)
    );
    await doneNotify(out, actor);
    for (const s of rows) notify(s.id);
    return out.sort((a, b) => a.id - b.id);
  });
}

// ส่งกลับหลายฉบับในครั้งเดียว · comments = { id: ข้อความ } ทุกฉบับต้องมีข้อความ · ข้ามฉบับที่ไม่ได้รอผู้ใช้คนนี้แล้ว · คืนจำนวนที่ส่งกลับ
async function sendBackMany(ids, actor, { comments = {} } = {}) {
  await db.ensureRefs();
  const want = [...new Set(ids)];
  if (!want.length) return 0;
  return q.tx(async () => {
    const rows = await q.all(`SELECT ${subCols()} FROM submissions WHERE id = ANY(?) ORDER BY id FOR UPDATE`, want);
    const self = selfSign();
    const logs = [];
    const done = [];
    const returned = [];
    for (const s of rows) {
      if (!canReview(actor, s, self)) continue;
      const text = String(comments[s.id] ?? '').trim();
      if (!text) throw new WorkflowError('กรุณาเขียนเหตุผลหรือสิ่งที่ต้องแก้ไข');
      const st = stepOf(s.current_role);
      logs.push({ sub: s.id, actor, role: st.role, step_label: st.label, action: 'return', comment: text });
      done.push({ id: s.id, role: st.role });
      returned.push({ ...s, ret_label: st.label, ret_comment: text });
    }
    if (!done.length) return 0;
    const now = nowStr();
    await logMany(logs, null, now);
    await q.run(
      `UPDATE submissions s SET status = 'returned', returned_role = v.role, current_role = NULL, updated_at = ?
       FROM unnest(?::int[], ?::text[]) AS v(id, role) WHERE s.id = v.id`,
      now,
      done.map((d) => d.id),
      done.map((d) => d.role)
    );
    await returnNotify(returned, actor);
    return done.length;
  });
}

// รวมบันทึกหลังแผนในรายการงานรอตรวจเป็นเล่ม (แผนเดียวกันและรอระดับเดียวกัน) แถวแรกของเล่มเป็นตัวแทน ลำดับตามฉบับที่รอนานที่สุด
// แถวเล่มมี book = { planId, ids, count, planNos }
function groupBooks(rows) {
  const out = [];
  const books = new Map();
  for (const s of rows) {
    if (s.doc_type !== 'note' || !s.parent_id) {
      out.push(s);
      continue;
    }
    const key = `${s.parent_id}|${s.current_role}`;
    let row = books.get(key);
    if (!row) {
      row = { ...s, book: { planId: s.parent_id, ids: [], count: 0, planNos: [] } };
      books.set(key, row);
      out.push(row);
    }
    row.book.ids.push(s.id);
    row.book.count += 1;
    row.book.planNos.push(s.plan_no);
  }
  for (const r of books.values()) r.book.planNos.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return out;
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
    await returnNotify([{ ...sub, ret_label: st.label, ret_comment: text }], actor);
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

// การส่งครั้งล่าสุดของแต่ละงาน (Map id → submit/resubmit) หรือ null ถ้ามีงานใดที่ผู้ตรวจลงนามแล้วหลังส่งครั้งล่าสุด (ดึงกลับไม่ได้)
async function lastSends(ids) {
  const revs = await q.all(
    "SELECT id, submission_id, action FROM reviews WHERE submission_id = ANY(?) AND action IN ('submit', 'resubmit', 'approve', 'override') ORDER BY id",
    ids
  );
  const last = new Map();
  const signed = new Set();
  for (const r of revs) {
    if (r.action === 'submit' || r.action === 'resubmit') {
      last.set(r.submission_id, r.action);
      signed.delete(r.submission_id);
    } else signed.add(r.submission_id);
  }
  return signed.size || ids.some((id) => !last.has(id)) ? null : last;
}

// ดึงกลับทั้งเล่มได้ไหม (ทุกแผ่นที่รอตรวจยังไม่มีผู้ตรวจลงนาม) ใช้แสดงปุ่มในหน้าแผน
async function canWithdrawMany(ids) {
  return ids.length > 0 && Boolean(await lastSends(ids));
}

// ดึงบันทึกหลังแผนกลับทั้งเล่ม (ฟังก์ชันเสริม notebook) ได้เมื่อทุกแผ่นที่ขอยังรอตรวจ และยังไม่มีผู้ตรวจลงนามหลังส่งครั้งล่าสุด
// แผ่นใดลงนามไปแล้ว ไม่ดึงกลับสักแผ่น · จำนวนคำสั่งคงที่ไม่ว่ากี่แผ่น · คืนจำนวนแผ่นที่ดึงกลับ
async function withdrawMany(ids, actor) {
  await db.ensureRefs();
  const want = [...new Set(ids)];
  if (!want.length) return 0;
  return q.tx(async () => {
    const rows = await q.all(`SELECT ${subCols()} FROM submissions WHERE id = ANY(?) ORDER BY id FOR UPDATE`, want);
    if (rows.length !== want.length) throw new WorkflowError('ไม่พบงานบางฉบับ');
    for (const s of rows) {
      if (!isOwner(actor, s)) throw new WorkflowError('ดึงกลับได้เฉพาะงานของตนเอง');
      if (s.status !== 'pending') throw new WorkflowError('มีบางแผ่นไม่ได้รอตรวจแล้ว');
    }
    const last = await lastSends(want);
    if (!last) throw new WorkflowError('ดึงกลับทั้งเล่มไม่ได้ เพราะมีผู้ตรวจลงนามบางแผ่นแล้ว');
    await logMany(
      rows.map((s) => ({ sub: s.id, actor, step_label: 'ครูผู้สอน', action: 'withdraw' })),
      null,
      nowStr()
    );
    await q.run(
      `UPDATE submissions s SET status = v.status, current_role = NULL, updated_at = ?
       FROM unnest(?::int[], ?::text[]) AS v(id, status) WHERE s.id = v.id`,
      nowStr(),
      rows.map((s) => s.id),
      rows.map((s) => (last.get(s.id) === 'resubmit' ? 'returned' : 'draft'))
    );
    return rows.length;
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
    return advance(sub, startSeq, actor);
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
    return advance(sub, st.seq + 1, actor);
  });
}

// ผู้ดูแลระบบส่งกลับให้ครูแก้แทนผู้ตรวจขั้นที่ค้างอยู่ (ฟังก์ชันเสริม adminreturn) ครูส่งใหม่แล้วกลับมารอที่ขั้นนี้ ลายเซ็นเดิมยังอยู่
async function adminReturn(subId, actor, { comment = '' } = {}) {
  await db.ensureRefs();
  return q.tx(async () => {
    const sub = await lockSub(subId);
    adminCheck(actor, sub);
    if (sub.status !== 'pending' || !sub.current_role) throw new WorkflowError('งานนี้ไม่ได้รอผู้ตรวจอยู่');
    const text = String(comment).trim();
    if (!text) throw new WorkflowError('กรุณาเขียนสิ่งที่ครูต้องแก้ไข');
    const st = stepOf(sub.current_role);
    await log(sub.id, actor, { role: st.role, step_label: `ผู้ดูแลระบบส่งกลับแทน${st.label}`, action: 'return', comment: text });
    await q.run("UPDATE submissions SET status = 'returned', returned_role = ?, current_role = NULL, updated_at = ? WHERE id = ?", st.role, nowStr(), sub.id);
    await returnNotify([{ ...sub, ret_label: st.label, ret_comment: text }], actor);
    return getSub(sub.id);
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
  systemNotify,
  withdrawMany,
  canWithdrawMany,
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
  submitMany,
  sendBackMany,
  adminReturn,
  log,
  groupBooks,
  BOOK_KEEP,
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
