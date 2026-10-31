// สรุปการส่งงานครู (ฟังก์ชันเสริม reportsum) เฉพาะผู้ดูแลระบบ
// ตามจริง = ระบบคิดจากวันที่ส่งจริง แก้ไม่ได้ · ฉบับรายงาน = ตามจริงแล้วทับด้วยผลที่ผู้ดูแลปรับ (ตาราง report_adjusts)
// ไม่แตะตาราง submissions เลย ลบการปรับแล้วผลกลับเป็นตามจริงทันที
const { q, nowStr, setSetting } = require('./db');
const util = require('./util');
const teaching = require('./teaching');

// ถ้อยคำตามแบบฟอร์มบันทึกข้อความของโรงเรียน แยก 3 งาน
const DOCS = {
  plan: { label: 'แผนการจัดการเรียนรู้', tab: 'แผน', subject: 'แผนการจัดการเรียนรู้', missing: 'ขาดส่งแผนจัดการเรียนรู้', column: 'แผนการสอน', file: 'รายงานการส่งแผน' },
  manual: { label: 'คู่มือรายวิชา', tab: 'คู่มือ', subject: 'คู่มือรายวิชา', missing: 'ขาดส่งคู่มือรายวิชา', column: 'คู่มือรายวิชา', file: 'รายงานการส่งคู่มือ' },
  note: { label: 'บันทึกหลังแผน', tab: 'บันทึกหลังแผน', subject: 'บันทึกหลังแผนการจัดการเรียนรู้', missing: 'ขาดส่งบันทึกหลังแผน', column: 'บันทึกหลังแผน', file: 'รายงานการส่งบันทึกหลังแผน' },
};

// ผลที่เลือกได้ในฉบับรายงาน: hold กับ exclude ไม่นับรวมทั้งคู่ ต่างกันที่คำบอก
const RESULTS = {
  real: 'ตามจริง',
  hold: 'ยังไม่คิดผล',
  exclude: 'ไม่คิดผล',
  extend: 'ขยายกำหนดส่งเฉพาะคน',
  ontime: 'ส่งทันกำหนด',
  late: 'ส่งเกินกำหนด',
  notsent: 'ยังไม่ส่ง',
};
const STATE_LABEL = { ontime: 'ส่งทันกำหนด', late: 'ส่งเกินกำหนด', notsent: 'ยังไม่ส่ง', hold: 'ยังไม่คิดผล', exclude: 'ไม่คิดผล' };
const STATE_BADGE = { ontime: 'badge-green', late: 'badge-amber', notsent: 'badge-red', hold: 'badge-gray', exclude: 'badge-gray' };

const DEFAULT_SITUATIONS = [
  { name: 'ครูย้ายมาใหม่', result: 'hold' },
  { name: 'ครูบรรจุใหม่', result: 'hold' },
  { name: 'ครูต่างชาติ', result: 'exclude' },
  { name: 'ลาคลอด', result: 'extend' },
  { name: 'ลาป่วย', result: 'extend' },
  { name: 'ไปราชการ', result: 'extend' },
  { name: 'ส่งเป็นเล่มกระดาษ', result: 'ontime' },
];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function situations(settings) {
  const list = util.parseJson(settings.report_situations, null);
  return Array.isArray(list) && list.length ? list : DEFAULT_SITUATIONS;
}

async function saveSituations(names, results) {
  const list = [];
  (Array.isArray(names) ? names : [names]).forEach((n, i) => {
    const name = clip(n, 60);
    const result = (Array.isArray(results) ? results : [results])[i];
    if (name && RESULTS[result] && !list.some((x) => x.name === name)) list.push({ name, result });
  });
  await setSetting('report_situations', JSON.stringify(list));
  return list;
}

// ---------- ค่าของรอบรายงาน ----------
const blankRound = (type, year, semester) => ({ doc_type: type, academic_year: year, semester, due_date: '', doc_no: '', doc_date: '', sign_reporter: '', sign_head: '', sign_deputy: '', sign_director: '', note_on: 1, end_note: '', color_mode: 'color', note_notsent: 1, note_late: 1, red_notsent: 1, red_late: 0 });

async function getRound(type, year, semester) {
  const row = await q.get('SELECT * FROM report_rounds WHERE doc_type = ? AND academic_year = ? AND semester = ?', type, year, semester);
  return row || blankRound(type, year, semester);
}

async function saveRound(type, year, semester, b) {
  const v = {
    due: isDate(b.due_date) ? b.due_date : '',
    no: clip(b.doc_no, 60),
    date: isDate(b.doc_date) ? b.doc_date : '',
    reporter: clip(b.sign_reporter, 120),
    head: clip(b.sign_head, 120),
    deputy: clip(b.sign_deputy, 120),
    director: clip(b.sign_director, 120),
    noteOn: b.note_on ? 1 : 0,
    end: clip(b.end_note, 500),
    color: b.color_mode === 'black' ? 'black' : 'color',
    noteNotsent: b.note_notsent ? 1 : 0,
    noteLate: b.note_late ? 1 : 0,
    redNotsent: b.red_notsent ? 1 : 0,
    redLate: b.red_late ? 1 : 0,
  };
  await q.run(
    `INSERT INTO report_rounds (doc_type, academic_year, semester, due_date, doc_no, doc_date, sign_reporter, sign_head, sign_deputy, sign_director, note_on, end_note, color_mode, note_notsent, note_late, red_notsent, red_late, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (doc_type, academic_year, semester) DO UPDATE SET
       due_date = excluded.due_date, doc_no = excluded.doc_no, doc_date = excluded.doc_date, sign_reporter = excluded.sign_reporter,
       sign_head = excluded.sign_head, sign_deputy = excluded.sign_deputy, sign_director = excluded.sign_director,
       note_on = excluded.note_on, end_note = excluded.end_note, color_mode = excluded.color_mode,
       note_notsent = excluded.note_notsent, note_late = excluded.note_late, red_notsent = excluded.red_notsent, red_late = excluded.red_late, updated_at = excluded.updated_at`,
    type, year, semester, v.due, v.no, v.date, v.reporter, v.head, v.deputy, v.director, v.noteOn, v.end, v.color, v.noteNotsent, v.noteLate, v.redNotsent, v.redLate, nowStr()
  );
}

// ชื่อผู้ลงนามที่ยังไม่ได้พิมพ์ ดึงจากผู้ถือบทบาทในระบบ ผู้รายงานคือผู้ที่เปิดหน้านี้
async function signers(round, me) {
  const rows = await q.all(
    "SELECT r.role, u.full_name FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.is_active = 1 AND r.role IN ('academic_head', 'deputy_academic', 'director') ORDER BY u.full_name, u.id"
  );
  const by = (role) => (rows.find((r) => r.role === role) || {}).full_name || '';
  return {
    reporter: round.sign_reporter || (me && me.full_name) || '',
    head: round.sign_head || by('academic_head'),
    deputy: round.sign_deputy || by('deputy_academic'),
    director: round.sign_director || by('director'),
  };
}

// ---------- ผลตามจริง ----------
// จำนวนชิ้นที่ต้องส่งและวันที่ส่งของแต่ละชิ้น คืน null = ไม่ต้องส่ง (สอนเฉพาะกิจกรรมพัฒนาผู้เรียน)
// คู่มือ: ทุกวิชาที่สอน · แผน: ตามจำนวนวิชาหลัก · บันทึกหลังแผน: 1 เล่มต่อแผน 1 วิชาหลัก
// ครูที่ยังไม่มีรายวิชาในระบบ นับว่าต้องส่ง 1 ชิ้น ข้อมูลที่ยังไม่นำเข้าจึงไม่ทำให้ครูหายจากรายงาน
function piecesOf(type, teacher, taught, rawCount, subs) {
  if (rawCount > 0 && !taught.length) return null;
  const earliest = (list) => list.map((s) => String(s.sent_at || '')).filter(Boolean).sort()[0] || '';
  if (type === 'manual') {
    if (!taught.length) return { need: 1, dates: subs.length ? [earliest(subs)] : [] };
    const dates = [];
    for (const t of taught) {
      const mine = subs.filter((s) => s.subject_code === t.subject_code);
      if (mine.length) dates.push(earliest(mine));
    }
    return { need: taught.length, dates };
  }
  const need = teaching.planQuota(teacher);
  if (type === 'plan') return { need, dates: subs.map((s) => String(s.sent_at || '')).sort().slice(0, need) };
  // บันทึกหลังแผน: ส่งทั้งเล่ม ใช้วันที่แผ่นสุดท้ายของเล่ม
  const books = new Map();
  for (const s of subs) {
    const at = String(s.sent_at || '');
    if (!books.has(s.parent_id) || at > books.get(s.parent_id)) books.set(s.parent_id, at);
  }
  return { need, dates: [...books.values()].sort().slice(0, need) };
}

// ส่งครบหรือยัง ถ้าครบ ดูวันที่ชิ้นสุดท้ายเทียบกำหนดส่ง · ส่งไม่ครบนับเป็นยังไม่ส่ง
function realState(p, due) {
  if (p.dates.length < p.need) return 'notsent';
  const last = [...p.dates].sort().pop() || '';
  return due && last.slice(0, 10) > due ? 'late' : 'ontime';
}

// คำนวณครูทุกคนของรอบนี้ คืนรายการเรียงตามกลุ่มสาระแล้วตามชื่อ
async function realRows(type, year, semester, due) {
  const teachers = await q.all(
    `SELECT u.id, u.full_name, u.position, u.plan_quota, COALESCE(d.name, 'ไม่ระบุกลุ่มสาระ') AS dept_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1 AND u.is_teacher = 1 ORDER BY d.sort NULLS LAST, d.name, u.full_name, u.id`
  );
  const ids = teachers.map((t) => t.id);
  const taught = await teaching.listMany(ids, year, semester);
  const raw = await q.all('SELECT teacher_id, COUNT(*) AS n FROM teach_subjects WHERE academic_year = ? AND semester = ? GROUP BY teacher_id', year, semester);
  const rawCount = new Map(raw.map((r) => [r.teacher_id, Number(r.n)]));
  const subs = await q.all(
    `SELECT teacher_id, subject_code, parent_id, COALESCE(submitted_at, updated_at) AS sent_at FROM submissions
     WHERE doc_type = ? AND status != 'draft' AND academic_year = ? AND semester = ?`,
    type, year, semester
  );
  const out = [];
  let noNeed = 0;
  for (const t of teachers) {
    const list = taught.get(t.id) || [];
    const mine = subs.filter((s) => s.teacher_id === t.id);
    const p = piecesOf(type, t, list, rawCount.get(t.id) || 0, mine);
    if (!p) {
      noNeed++;
      continue;
    }
    const lastAt = [...p.dates].sort().pop() || '';
    out.push({ id: t.id, full_name: t.full_name, position: t.position || 'ครู', dept_name: t.dept_name, need: p.need, sent: Math.min(p.dates.length, p.need), lastAt, pieces: p, real: realState(p, due) });
  }
  return { rows: out, noNeed };
}

// ---------- ผลในรายงาน ----------
// การปรับของภาคนี้มาก่อน ถ้าไม่มี ใช้การปรับจากภาคก่อนที่ตั้งให้มีผลถึงวันที่ยังไม่พ้น
async function adjustsFor(type, year, semester, due) {
  const rows = await q.all(
    `SELECT * FROM report_adjusts WHERE doc_type = ? AND (
       (academic_year = ? AND semester = ?) OR
       (until_date != '' AND (academic_year * 10 + semester) < ?)
     ) ORDER BY academic_year, semester`,
    type, year, semester, year * 10 + semester
  );
  const at = due || nowStr().slice(0, 10);
  const map = new Map();
  for (const r of rows) {
    const exact = r.academic_year === year && r.semester === semester;
    if (exact) map.set(r.teacher_id, { ...r, carried: false });
    else if (r.until_date >= at) map.set(r.teacher_id, { ...r, carried: true });
  }
  return map;
}

// งานที่ครูไม่ต้องส่ง (ผลในรายงานเป็น ไม่คิดผล) ใช้งดเตือน คืน Map id ครู -> Set ชนิดงาน
// ยังไม่คิดผลไม่อยู่ในนี้ เพราะครูยังต้องส่งและยังเตือนตามปกติ
async function exemptions(ids, year, semester) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await q.all(
    `SELECT teacher_id, doc_type, academic_year, semester, result, until_date FROM report_adjusts WHERE teacher_id = ANY(?) AND (
       (academic_year = ? AND semester = ?) OR (until_date != '' AND (academic_year * 10 + semester) < ?)
     ) ORDER BY academic_year, semester`,
    ids, year, semester, year * 10 + semester
  );
  const today = nowStr().slice(0, 10);
  const latest = new Map();
  for (const r of rows) {
    const exact = r.academic_year === year && r.semester === semester;
    if (exact || r.until_date >= today) latest.set(`${r.teacher_id}:${r.doc_type}`, r);
  }
  for (const r of latest.values()) {
    if (r.result !== 'exclude') continue;
    if (!map.has(r.teacher_id)) map.set(r.teacher_id, new Set());
    map.get(r.teacher_id).add(r.doc_type);
  }
  return map;
}

function applyAdjust(row, a) {
  if (!a || a.result === 'real') return row.real;
  if (a.result === 'extend') return realState(row.pieces, isDate(a.extend_date) ? a.extend_date : '');
  return a.result;
}

const COUNTED = ['ontime', 'late', 'notsent'];

function summarize(states) {
  const n = { ontime: 0, late: 0, notsent: 0, skip: 0 };
  for (const s of states) {
    if (COUNTED.includes(s)) n[s]++;
    else n.skip++;
  }
  const total = n.ontime + n.late + n.notsent;
  const pct = (x) => (total ? Math.round((x / total) * 100) : 0);
  return { ...n, total, pct: { ontime: pct(n.ontime), late: pct(n.late), notsent: pct(n.notsent) } };
}

// หมายเหตุบนกระดาษ: ฉบับรายงานที่เปิดสวิตช์ใช้ข้อความที่พิมพ์เอง · ยังไม่ส่งและส่งเกินกำหนดเปิดปิดแยกกันได้ (round)
function paperNote(state, adjust, noteOn, round = {}) {
  const typed = noteOn && adjust && adjust.note ? adjust.note : '';
  if (typed) return typed;
  if (state === 'notsent' && round.note_notsent !== 0) return 'ยังไม่ส่ง';
  if (state === 'late' && round.note_late !== 0) return 'ส่งเกินกำหนด';
  return '';
}

// ข้อมูลครบทุกอย่างของ 1 รอบ
async function load(type, year, semester) {
  const round = await getRound(type, year, semester);
  const due = round.due_date;
  const { rows, noNeed } = await realRows(type, year, semester, due);
  const adjusts = await adjustsFor(type, year, semester, due);
  const list = rows.map((r) => {
    const a = adjusts.get(r.id);
    const active = a && a.result !== 'real' ? a : null;
    return { ...r, adjust: active, state: applyAdjust(r, active) };
  });
  return {
    round,
    rows: list,
    noNeed,
    real: summarize(list.map((r) => r.real)),
    report: summarize(list.map((r) => r.state)),
    changed: list.filter((r) => r.adjust).length,
  };
}

// แถวสำหรับกระดาษ: mode real = ตามจริง · report = ฉบับรายงาน ครูที่ไม่คิดผลไม่อยู่ในตาราง
function paperRows(data, mode) {
  const report = mode === 'report';
  const noteOn = report && Boolean(data.round.note_on);
  const out = [];
  for (const r of data.rows) {
    const state = report ? r.state : r.real;
    if (!COUNTED.includes(state)) continue;
    out.push({ no: out.length + 1, id: r.id, full_name: r.full_name, position: r.position, state, note: paperNote(state, report ? r.adjust : null, noteOn, data.round), noteRed: Boolean(state === 'notsent' ? data.round.red_notsent : state === 'late' && data.round.red_late) });
  }
  return out;
}

// ถ้อยคำบนกระดาษ ใช้ร่วมกันทั้งหน้าพิมพ์และไฟล์ Word เนื้อความตรงกันเสมอ
function paperText(type, year, semester, sum) {
  const d = DOCS[type];
  const term = `ภาคเรียนที่ ${semester} ปีการศึกษา ${year}`;
  const items = [{ label: 'ส่งตามกำหนดเวลา', n: sum.ontime, pct: sum.pct.ontime }];
  if (sum.late) items.push({ label: 'ส่งเกินกำหนดเวลา', n: sum.late, pct: sum.pct.late });
  items.push({ label: d.missing, n: sum.notsent, pct: sum.pct.notsent });
  return {
    subject: `รายงานการส่ง${d.subject}ประจำ${term}`,
    p1: `ด้วย งานส่งเสริมและพัฒนากระบวนการเรียนรู้ กลุ่มบริหารงานวิชาการได้กำหนดส่ง${d.subject}เพื่อใช้ในการจัดการเรียนรู้  ประจำ${term}`,
    p2: `บัดนี้การดำเนินการดังกล่าวได้เสร็จสิ้นเป็นที่เรียบร้อยแล้ว ผลปรากฏว่า มีข้าราชการครูและบุคลากรทางการศึกษาที่ปฏิบัติหน้าที่สอน จำนวน  ${sum.total}  คน`,
    items,
    sent: `ส่ง${d.column}`,
    unsent: `ยังไม่ส่ง${d.column}`,
    listTitle: `รายชื่อข้าราชการครูและบุคลากรทางการศึกษา  ที่ไม่ได้ส่ง${d.column}ตามกำหนดเวลา`,
    listCount: `จำนวน  ${sum.late + sum.notsent}  คน  ดังรายชื่อต่อไปนี้`,
  };
}

// วันที่แบบแบบฟอร์ม เช่น 13  กรกฎาคม พ.ศ. 2569
function formDate(s) {
  if (!isDate(s)) return '';
  const [d, m, y] = util.thaiDate(s).split(' ');
  return `${d}  ${m} พ.ศ. ${y}`;
}

// ---------- บันทึกการปรับ ----------
async function saveAdjust(me, ids, types, year, semester, f) {
  const now = nowStr();
  const values = {
    result: f.result,
    situation: clip(f.situation, 60),
    reason: clip(f.reason, 300),
    note: clip(f.note, 120),
    extend: f.result === 'extend' && isDate(f.extend_date) ? f.extend_date : '',
    until: isDate(f.until_date) ? f.until_date : '',
  };
  for (const type of types) {
    for (const id of ids) {
      await q.run(
        `INSERT INTO report_adjusts (teacher_id, doc_type, academic_year, semester, result, situation, reason, note, extend_date, until_date, updated_by_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (teacher_id, doc_type, academic_year, semester) DO UPDATE SET
           result = excluded.result, situation = excluded.situation, reason = excluded.reason, note = excluded.note,
           extend_date = excluded.extend_date, until_date = excluded.until_date, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`,
        id, type, year, semester, values.result, values.situation, values.reason, values.note, values.extend, values.until, me.full_name, now
      );
    }
  }
}

// คืนค่าตามจริง: ลบการปรับของภาคนี้ ถ้ายังมีการปรับจากภาคก่อนที่มีผลอยู่ จดว่าภาคนี้ใช้ตามจริง
async function resetAdjust(me, ids, types, year, semester) {
  for (const type of types) {
    const round = await getRound(type, year, semester);
    for (const id of ids) {
      await q.run('DELETE FROM report_adjusts WHERE teacher_id = ? AND doc_type = ? AND academic_year = ? AND semester = ?', id, type, year, semester);
    }
    const carried = await adjustsFor(type, year, semester, round.due_date);
    const still = ids.filter((id) => carried.has(id));
    if (still.length) await saveAdjust(me, still, [type], year, semester, { result: 'real', situation: '', reason: 'คืนค่าตามจริง', note: '' });
  }
}

module.exports = { DOCS, RESULTS, STATE_LABEL, STATE_BADGE, DEFAULT_SITUATIONS, COUNTED, isDate, situations, saveSituations, getRound, saveRound, signers, load, summarize, paperRows, paperText, paperNote, formDate, saveAdjust, resetAdjust, piecesOf, realState, exemptions };
