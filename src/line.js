// สรุปงานรอลงนามเข้ากลุ่ม LINE ทุกเช้า (ฟังก์ชันเสริม ต้องมี LINE Official Account ของโรงเรียน)
// ส่งเฉพาะจำนวนงานที่รอในแต่ละระดับ ไม่ส่งชื่อครูหรือเนื้อหางานออกไปนอกระบบ
const db = require('./db');
const { q, nowStr, getSettings, setSetting } = db;
const features = require('./features');
const util = require('./util');
const wf = require('./workflow');

async function summaryText(settings, { test = false } = {}) {
  await db.ensureRefs();
  const rows = await q.all(
    `SELECT s.current_role AS role, d.name AS dept, COUNT(*) AS n FROM submissions s
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.status = 'pending' GROUP BY s.current_role, d.name ORDER BY s.current_role, d.name`
  );
  const lines = [`ระบบส่งแผนการสอน ${settings.school_name}`, `สรุปงานรอลงนาม ${util.thaiDate(nowStr())}`];
  if (test) lines.push('(ข้อความทดลองจากหน้าฟังก์ชันเสริม)');
  let total = 0;
  for (const st of wf.allSteps()) {
    const mine = rows.filter((r) => r.role === st.role);
    if (!mine.length) continue;
    const n = mine.reduce((a, r) => a + r.n, 0);
    total += n;
    const detail = st.scope === 'department' ? ` (${mine.map((r) => `${r.dept || 'ไม่ระบุ'} ${r.n}`).join(' ')})` : '';
    lines.push(`${st.label} ${n} รายการ${detail}`);
  }
  lines.push(total ? `รวม ${total} รายการ` : 'ไม่มีงานค้าง');
  if (settings.public_url) lines.push(`เปิดระบบ ${settings.public_url}`);
  return lines.join('\n');
}

async function sendSummary({ test = false } = {}) {
  const s = await getSettings();
  if (!s.line_token || !s.line_to) throw new Error('ยังไม่ได้ตั้งค่า LINE');
  const text = (await summaryText(s, { test })).slice(0, 4900);
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.line_token}` },
    body: JSON.stringify({ to: s.line_to, messages: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`LINE ตอบกลับรหัส ${r.status}`);
}

// ถึงเวลาที่ตั้งไว้และวันนี้ยังไม่ได้ส่ง จึงส่ง (ส่งวันละครั้ง) · Node เรียกทุกนาที · Workers เรียกทุก 5 นาทีจาก cron (jobs.runCron)
async function tick() {
  const s = await getSettings();
  if (!features.isOn(s, 'line') || !s.line_token || !s.line_to) return;
  const now = nowStr();
  const today = now.slice(0, 10);
  if (s.line_last_sent === today || now.slice(11, 16) < (s.line_time || '07:00')) return;
  await setSetting('line_last_sent', today);
  try {
    await sendSummary();
  } catch (e) {
    console.error('ส่งสรุปเข้า LINE ไม่สำเร็จ', e.message);
  }
}

function start() {
  const timer = setInterval(() => db.withScope(tick).catch(() => {}), 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { summaryText, sendSummary, tick, start };
