// สร้างข้อมูลทดลองไว้ลองใช้ทุกบทบาท (ชื่อครูและผู้บริหารเป็นชื่อสมมติทั้งหมด ห้ามใช้ชื่อจริง)
// ใช้: npm run demo  (ข้อมูลอยู่ในโฟลเดอร์ data-demo ฐานข้อมูล PGlite ที่ data-demo/pg แยกจากข้อมูลจริง)
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const DEMO_PASSWORD = 'demo1234';
module.exports = { DEMO_PASSWORD };

function makeSignaturePng(seed) {
  const W = 360;
  const H = 120;
  const px = Buffer.alloc(W * H * 4);
  const dot = (cx, cy, r) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          const i = (y * W + x) * 4;
          px[i] = 13;
          px[i + 1] = 27;
          px[i + 2] = 90;
          px[i + 3] = 255;
        }
      }
    }
  };
  let prev = null;
  for (let t = 0; t <= 1; t += 0.0015) {
    const x = 30 + t * 290;
    const y = 62 + 26 * Math.sin(t * (9 + seed) + seed) * Math.cos(t * (3 + seed / 2)) - 10 * Math.sin(t * 40 + seed);
    if (prev) for (let k = 0; k <= 1; k += 0.25) dot(prev.x + (x - prev.x) * k, prev.y + (y - prev.y) * k, 2.4);
    prev = { x, y };
  }
  for (let x = 60; x < 300; x += 1) dot(x, 100 - (x - 60) * 0.04, 1.4);
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function makePdf(title) {
  const text = String(title).replace(/[()\\]/g, '');
  const stream = `BT /F1 22 Tf 72 760 Td (${text}) Tj ET\nBT /F1 13 Tf 72 730 Td (Demo file for testing the lesson plan system) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// target: ':memory:' สำหรับชุดทดสอบ (ไม่ใส่ = PGlite ที่ data-demo/pg เสมอ ไม่ใช้ DATABASE_URL กันข้อมูลทดลองหลุดเข้าฐานจริง)
// keepOpen: ชุดทดสอบใช้ฐานเดิมต่อ ไม่ปิด
async function main({ target, keepOpen = false } = {}) {
  process.env.DATA_DIR = process.env.DATA_DIR || 'data-demo';
  const config = require('../src/config');
  // ลบเฉพาะโฟลเดอร์ข้อมูลทดลอง ไม่แตะข้อมูลจริงเด็ดขาด
  if (path.basename(config.DATA_DIR) !== 'data-demo') throw new Error('ข้อมูลทดลองต้องอยู่ในโฟลเดอร์ data-demo เท่านั้น');
  fs.rmSync(config.DATA_DIR, { recursive: true, force: true });

  const db = require('../src/db');
  const auth = require('../src/auth');
  const wf = require('../src/workflow');
  await db.open(target || config.PG_DIR);
  await db.ensureRefs();
  const { q, nowStr, setSetting } = db;

  await setSetting('school_name', 'โรงเรียนชานุมานวิทยาคม');
  await setSetting('school_location', 'อำเภอชานุมาน จังหวัดอำนาจเจริญ');
  await setSetting('academic_year', '2569');
  await setSetting('semester', '2');
  await setSetting('submit_open', '1');
  await setSetting('submit_end', '2026-12-30');

  const dept = async (prefix) => (await q.get('SELECT id FROM departments WHERE name ILIKE ?', `${prefix}%`)).id;
  const SCI = await dept('วิทยาศาสตร์');
  const MATH = await dept('คณิตศาสตร์');
  const THAI = await dept('ภาษาไทย');
  const ENG = await dept('ภาษาต่างประเทศ');
  const SOC = await dept('สังคมศึกษา');

  const hash = await auth.hashPassword(DEMO_PASSWORD);
  let seed = 1;
  const people = {};
  async function person(key, fullName, position, deptId, roles = [], { teacher = 1, admin = 0 } = {}) {
    const r = await q.get(
      `INSERT INTO users (username, password_hash, full_name, position, department_id, is_teacher, is_admin, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      key,
      hash,
      fullName,
      position,
      deptId,
      teacher,
      admin,
      admin ? null : makeSignaturePng(seed++),
      nowStr()
    );
    const id = r.id;
    for (const role of roles) await q.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', id, role);
    people[key] = await auth.loadUser(id);
    return people[key];
  }

  await person('admin', 'ผู้ดูแลระบบ ทดลอง', 'ผู้ดูแลระบบ', null, [], { teacher: 0, admin: 1 });
  await person('director', 'นายมงคล นำพา', 'ผู้อำนวยการโรงเรียน', null, ['director'], { teacher: 0 });
  await person('deputy', 'นางสาวรัตนา บริหารดี', 'รองผู้อำนวยการ', null, ['deputy_academic'], { teacher: 0 });
  await person('acad', 'นางมาลี วิชาการ', 'ครู วิทยฐานะครูชำนาญการพิเศษ', MATH, ['academic_head']);
  await person('section', 'นายวีระ ส่งเสริม', 'ครู', SCI, ['section_head']);
  await person('scihead', 'นางวันดี ศรีวิทย์', 'ครู วิทยฐานะครูชำนาญการ', SCI, ['dept_head']);
  await person('mathhead', 'นางสาวนภา เลขดี', 'ครู วิทยฐานะครูชำนาญการ', MATH, ['dept_head']);
  await person('thaihead', 'นางสุดา ภาษาดี', 'ครู วิทยฐานะครูชำนาญการ', THAI, ['dept_head']);
  await person('enghead', 'นางสาวจันทร์เพ็ญ อังกฤษดี', 'ครู', ENG, ['dept_head']);
  await person('sochead', 'นายประสิทธิ์ ธรรมดี', 'ครู', SOC, ['dept_head']);
  await person('teacher', 'นายสมชาย ใจดี', 'ครูผู้ช่วย', SCI);
  await person('sci2', 'นางสาวพิมพ์ใจ รักเรียน', 'ครู', SCI);
  await person('math2', 'นายกิตติ คิดเร็ว', 'ครู', MATH);
  await person('thai2', 'นางสาวอรุณี กลอนงาม', 'ครู', THAI);
  await person('eng2', 'นายธนา พูดเก่ง', 'ครู', ENG);
  await person('soc1', 'นางสาวกานดา ประวัติดี', 'ครู', SOC);

  const subjects = [
    ['ว30203', 'ฟิสิกส์เพิ่มเติม 3', SCI, 'ม.5'],
    ['ว30207', 'ฟิสิกส์ 1', SCI, 'ม.4'],
    ['ว22201', 'โครงงานวิทยาศาสตร์ 1', SCI, 'ม.2'],
    ['ว21101', 'วิทยาศาสตร์ 1', SCI, 'ม.1'],
    ['ว31101', 'วิทยาศาสตร์กายภาพ', SCI, 'ม.4'],
    ['ค21101', 'คณิตศาสตร์ 1', MATH, 'ม.1'],
    ['ท21101', 'ภาษาไทย 1', THAI, 'ม.1'],
    ['อ21101', 'ภาษาอังกฤษ 1', ENG, 'ม.1'],
    ['ส21101', 'สังคมศึกษา 1', SOC, 'ม.1'],
  ];
  for (const [code, name, d, g] of subjects) await q.run('INSERT INTO subjects (code, name, department_id, grade) VALUES (?, ?, ?, ?)', code, name, d, g);
  const subjectOf = Object.fromEntries(subjects.map((s) => [s[0], s]));

  // ไฟล์ตัวอย่างอยู่ในที่เก็บแบบ local (<โฟลเดอร์ข้อมูล>/files/demo) อ้างถึงด้วย local:demo/...
  const uploadDir = path.join(config.FILES_DIR, 'demo');
  fs.mkdirSync(uploadDir, { recursive: true });
  async function work(who, type, code, extra = {}) {
    const u = people[who];
    const [, name, , grade] = subjectOf[code];
    const now = nowStr();
    const r = await q.get(
      `INSERT INTO submissions (doc_type, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level,
         teaching_methods, created_at, updated_at)
       VALUES (?, ?, ?, 2569, 2, ?, ?, ?, ?, ?, ?) RETURNING id`,
      type,
      u.id,
      u.department_id,
      code,
      name,
      grade,
      type === 'plan' ? JSON.stringify(extra.methods || ['Active Learning']) : '[]',
      now,
      now
    );
    const id = r.id;
    const fileName = `${type === 'plan' ? 'แผนการจัดการเรียนรู้' : 'คู่มือรายวิชา'}_${code}.pdf`;
    const stored = `local:demo/${id}.pdf`;
    fs.writeFileSync(path.join(uploadDir, `${id}.pdf`), makePdf(`${type === 'plan' ? 'Lesson plan' : 'Course manual'} ${code}`));
    await q.run(
      "INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, 'main', ?, ?, 'application/pdf', 900, ?)",
      id,
      fileName,
      stored,
      now
    );
    return id;
  }

  const notesText = [
    {
      topic: 'ลักษณะการเคลื่อนที่แบบฮาร์มอนิกอย่างง่าย',
      k: 'นักเรียนร้อยละ 85 อธิบายลักษณะการเคลื่อนที่แบบฮาร์มอนิกอย่างง่ายได้ถูกต้อง',
      p: 'นักเรียนทำการทดลองวัดคาบของลูกตุ้มเป็นกลุ่ม บันทึกและวิเคราะห์ข้อมูลได้',
      a: 'นักเรียนมีความมุ่งมั่นในการทำงาน ส่งงานตรงเวลา',
      problems: 'นักเรียนบางกลุ่มจับเวลาคลาดเคลื่อน แก้ไขโดยให้จับเวลา 10 รอบแล้วหาค่าเฉลี่ย',
      sugg: 'ควรเพิ่มเวลาฝึกโจทย์คำนวณ',
    },
    {
      topic: 'คาบและความถี่ของการสั่น',
      k: 'นักเรียนคำนวณคาบและความถี่จากโจทย์ได้ถูกต้องเป็นส่วนใหญ่',
      p: 'นักเรียนใช้กราฟวิเคราะห์ความสัมพันธ์ระหว่างความยาวเชือกกับคาบได้',
      a: 'นักเรียนให้ความร่วมมือในการทำงานกลุ่มดี',
      problems: 'นักเรียนบางคนยังสับสนหน่วย แก้ไขโดยทำตารางสรุปหน่วย',
      sugg: '',
    },
    {
      topic: 'การสั่นพ้อง',
      k: 'นักเรียนอธิบายการเกิดการสั่นพ้องและยกตัวอย่างในชีวิตประจำวันได้',
      p: 'นักเรียนสาธิตการสั่นพ้องด้วยลูกตุ้มคู่ได้',
      a: 'นักเรียนกล้าแสดงความคิดเห็น',
      problems: 'อุปกรณ์มีจำนวนจำกัด',
      sugg: 'จัดหาอุปกรณ์เพิ่ม',
    },
    { topic: 'คลื่นกล', k: 'นักเรียนจำแนกคลื่นตามขวางและคลื่นตามยาวได้', p: '', a: '', problems: '', sugg: '' },
    { topic: 'ส่วนประกอบของคลื่น', k: 'นักเรียนระบุส่วนประกอบของคลื่นได้', p: 'วาดภาพคลื่นได้', a: 'ตั้งใจเรียน', problems: '', sugg: '' },
    ...[
      ['การสะท้อนของคลื่น', 'นักเรียนอธิบายกฎการสะท้อนและวาดรังสีสะท้อนได้'],
      ['การหักเหของคลื่น', 'นักเรียนอธิบายการเปลี่ยนความเร็วคลื่นเมื่อผ่านตัวกลางต่างกันได้'],
      ['การแทรกสอด', 'นักเรียนส่วนใหญ่อธิบายแนวบัพและแนวปฏิบัพได้'],
      ['การเลี้ยวเบน', 'นักเรียนบางส่วนยังสับสนระหว่างการเลี้ยวเบนกับการหักเห'],
      ['คลื่นนิ่ง', 'นักเรียนหาความยาวคลื่นจากระยะระหว่างบัพได้'],
      ['การเกิดเสียง', 'นักเรียนอธิบายการเกิดเสียงจากการสั่นของแหล่งกำเนิดได้'],
      ['ระดับเสียง', 'นักเรียนคำนวณระดับเสียงเป็นเดซิเบลได้'],
    ].map(([topic, k]) => ({ topic, k, p: 'นักเรียนทำกิจกรรมกลุ่มและนำเสนอผลได้', a: 'นักเรียนทำงานร่วมกับผู้อื่นได้ดี', problems: 'เวลาไม่เพียงพอ แก้โดยมอบหมายงานต่อที่บ้าน', sugg: 'ควรเพิ่มแบบฝึกหัดเสริม' })),
  ];
  const PASSED = [34, 35, 32, 23, 30, 34, 32, 31, 26, 33, 35, 33];
  async function note(planId, i) {
    const plan = await q.get('SELECT * FROM submissions WHERE id = ?', planId);
    const n = notesText[i];
    const r = await q.get(
      `INSERT INTO submissions (doc_type, parent_id, teacher_id, department_id, academic_year, semester, subject_code, subject_name, grade_level,
         plan_no, topic, unit_no, unit_name, hours, class_room, teach_date, result_k, result_p, result_a, problems, suggestions,
         students_total, students_passed, created_at, updated_at)
       VALUES ('note', ?, ?, ?, 2569, 2, ?, ?, ?, ?, ?, '1', 'การเคลื่อนที่แบบฮาร์มอนิกอย่างง่าย', '2', 'ม.5/1', ?, ?, ?, ?, ?, ?, 38, ?, ?, ?) RETURNING id`,
      planId,
      plan.teacher_id,
      plan.department_id,
      plan.subject_code,
      plan.subject_name,
      plan.grade_level,
      String(i + 1),
      n.topic,
      `2026-11-${String(4 + i * 3).padStart(2, '0')}`,
      n.k,
      n.p,
      n.a,
      n.problems,
      n.sugg,
      PASSED[i] ?? 30,
      nowStr(),
      nowStr()
    );
    return r.id;
  }

  const P = people;
  const scores = (type, pattern) => Object.fromEntries(wf.rubric(type).map((it, i) => [it.id, String(pattern[i % pattern.length])]));
  const up = (id, who, extra = {}) => wf.approve(id, P[who], extra);

  // ครูสมชาย: คู่มือผ่านครบ แผนรอรองผู้อำนวยการ บันทึกหลังแผนหลายสถานะ คู่มืออีกวิชาถูกส่งกลับ
  const m1 = await work('teacher', 'manual', 'ว30203');
  await wf.submit(m1, P.teacher);
  await up(m1, 'scihead', { scores: scores('manual', [5, 5, 4, 5]), comment: 'คู่มือครบถ้วน เหมาะสม' });
  await up(m1, 'section', { comment: 'เห็นชอบ' });
  await up(m1, 'acad', { comment: 'เห็นควรอนุญาต' });
  await up(m1, 'deputy', { comment: 'เห็นควรอนุญาต' });
  await up(m1, 'director', { comment: 'อนุญาต' });

  const p1 = await work('teacher', 'plan', 'ว30203', { methods: ['Active Learning', 'สะเต็มศึกษา (STEM)'] });
  await wf.submit(p1, P.teacher);
  await up(p1, 'scihead', { scores: scores('plan', [5, 4, 4, 5, 3]), comment: 'กิจกรรมหลากหลาย ควรเพิ่มการวัดผลด้านคุณลักษณะ' });
  await up(p1, 'section', { comment: 'เห็นชอบ' });
  await up(p1, 'acad', { comment: 'เห็นชอบ' });

  const n1 = await note(p1, 0);
  await wf.submit(n1, P.teacher);
  await up(n1, 'scihead', { comment: 'รับทราบ กิจกรรมการทดลองดีมาก' });
  await up(n1, 'deputy', { comment: 'รับทราบ' });
  await up(n1, 'director', { comment: 'รับทราบ' });
  const n2 = await note(p1, 1);
  await wf.submit(n2, P.teacher);
  await up(n2, 'scihead', { comment: 'รับทราบ' });
  const n3 = await note(p1, 2);
  await wf.submit(n3, P.teacher);
  await note(p1, 3);
  const n5 = await note(p1, 4);
  await wf.submit(n5, P.teacher);
  await wf.sendBack(n5, P.scihead, { comment: 'ด้านทักษะและคุณลักษณะยังเขียนน้อยเกินไป ขอให้ระบุผลที่สังเกตได้' });
  for (let i = 5; i < notesText.length; i++) {
    const id = await note(p1, i);
    await wf.submit(id, P.teacher);
    if (i < 7) {
      await up(id, 'scihead', { comment: 'รับทราบ' });
      await up(id, 'deputy', { comment: 'รับทราบ' });
      await up(id, 'director', { comment: 'รับทราบ' });
    }
  }

  const m2 = await work('teacher', 'manual', 'ว30207');
  await wf.submit(m2, P.teacher);
  await up(m2, 'scihead', { scores: scores('manual', [4, 3, 4]) });
  await up(m2, 'section', {});
  await wf.sendBack(m2, P.acad, { comment: 'ตารางกำหนดน้ำหนักคะแนนรวมไม่ครบ 100 กรุณาตรวจสอบหน้า 12' });

  // หัวหน้างาน (ระดับ 2) ส่งงานของตัวเอง แล้วลงนามในช่องหัวหน้างานเอง
  const m3 = await work('section', 'manual', 'ว22201');
  await wf.submit(m3, P.section);
  await up(m3, 'scihead', { scores: scores('manual', [5, 4]) });
  await up(m3, 'section', { comment: 'เห็นชอบ' });

  // หัวหน้ากลุ่มสาระส่งงานของตัวเอง รอให้คะแนนและลงนามงานของตัวเอง
  const m4 = await work('scihead', 'manual', 'ว31101');
  await wf.submit(m4, P.scihead);

  // ครูกานดา: แผนวิชาหลักยังเป็นฉบับร่าง (ผู้ดูแลระบบลองส่งแทนได้)
  await work('soc1', 'plan', 'ส21101');

  // งานรอหัวหน้ากลุ่มสาระวิทยาศาสตร์ให้คะแนน
  const m5 = await work('sci2', 'manual', 'ว21101');
  await wf.submit(m5, P.sci2);
  const p5 = await work('sci2', 'plan', 'ว21101', { methods: ['Active Learning'] });
  await wf.submit(p5, P.sci2);
  const fn = await note(p5, 0);
  await q.run("UPDATE submissions SET note_mode = 'file', topic = 'สารและสมบัติของสาร', result_k = '', result_p = '', result_a = '', problems = '', suggestions = '' WHERE id = ?", fn);
  fs.writeFileSync(path.join(uploadDir, 'note-' + fn + '.pdf'), makePdf('Post-lesson note'));
  await q.run("INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, 'attach', ?, ?, 'application/pdf', 900, ?)", fn, 'บันทึกหลังแผน_แผนที่1.pdf', 'local:demo/note-' + fn + '.pdf', nowStr());
  await wf.submit(fn, P.sci2);
  await q.run(
    "INSERT INTO notifications (user_id, from_user_id, from_name, text, link, created_at) VALUES (?, ?, ?, ?, '/my', ?)",
    P.sci2.id,
    P.scihead.id,
    `${P.scihead.full_name} (หัวหน้ากลุ่มสาระการเรียนรู้วิทยาศาสตร์และเทคโนโลยี)`,
    `เรียน คุณครู${P.sci2.full_name}\nกรุณาส่งบันทึกหลังแผนวิชา ว21101 ให้ครบทุกแผนที่สอนแล้ว\nกำหนดส่งวันที่ 30 ธันวาคม 2569`,
    nowStr()
  );

  // งานรอหัวหน้างาน (ลองลงนามทีละหลายรายการ)
  for (const type of ['manual', 'plan']) {
    const id = await work('math2', type, 'ค21101');
    await wf.submit(id, P.math2);
    await up(id, 'mathhead', { scores: scores(type, [4, 5, 4]) });
  }
  const m7 = await work('thai2', 'manual', 'ท21101');
  await wf.submit(m7, P.thai2);
  await up(m7, 'thaihead', { scores: scores('manual', [5]) });
  for (const who of ['section', 'acad', 'deputy', 'director']) await up(m7, who, {});
  const p7 = await work('thai2', 'plan', 'ท21101', { methods: ['การอ่าน คิดวิเคราะห์ แบบ PISA'] });
  await wf.submit(p7, P.thai2);
  await up(p7, 'thaihead', { scores: scores('plan', [5, 4]) });
  for (const who of ['section', 'acad', 'deputy']) await up(p7, who, {});

  const m8 = await work('eng2', 'manual', 'อ21101');
  await wf.submit(m8, P.eng2);
  await up(m8, 'enghead', { scores: scores('manual', [3, 4]) });
  await up(m8, 'section', {});

  // รายวิชาที่สอน: ทุกวิชาที่มีงาน (วิชาที่ส่งแผนคือวิชาหลัก) และวิชาที่ยังไม่ได้ส่งคู่มือ
  const teaching = require('../src/teaching');
  for (const s of await q.all("SELECT * FROM submissions WHERE doc_type IN ('manual', 'plan') ORDER BY doc_type DESC, id")) {
    const u = await q.get('SELECT * FROM users WHERE id = ?', s.teacher_id);
    await teaching.ensure(u, s.academic_year, s.semester, { code: s.subject_code, name: s.subject_name, grade: s.grade_level }, s.doc_type === 'plan');
  }
  for (const [who, code] of [['teacher', 'ว31101'], ['sci2', 'ว22201'], ['scihead', 'ว30203'], ['soc1', 'ส21101']]) {
    const [, name, , grade] = subjectOf[code];
    await teaching.ensure(P[who], 2569, 2, { code, name, grade });
  }

  console.log(`สร้างข้อมูลทดลองเรียบร้อย ผู้ใช้ ${Object.keys(people).length} คน งาน ${(await q.get('SELECT COUNT(*) AS n FROM submissions')).n} รายการ`);
  console.log(`โฟลเดอร์ข้อมูลทดลอง: ${config.DATA_DIR}`);
  if (!keepOpen) await db.close();
}

module.exports.main = main;
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
