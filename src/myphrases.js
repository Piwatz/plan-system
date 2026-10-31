// คำของฉันในช่องความเห็นคู่ลายเซ็น (ฟังก์ชันเสริม myphrases) แต่ละคนมีรายการของตัวเอง ใช้ได้ทุกเครื่อง
// kind ในตาราง user_phrases: mine คำที่กดจำไว้ · recent ความเห็นที่พิมพ์เองตอนลงนาม 5 คำล่าสุด · hidden ปุ่มเดิมที่ผู้ใช้กดซ่อน
const { q, nowStr } = require('./db');

const MAX_MINE = 30;
const MAX_RECENT = 5;
const MAX_LEN = 200;

// ปุ่มเดิมของแต่ละหน้า
const NOTE_SAYS = ['รับทราบ', 'ดีมาก เป็นแบบอย่างได้', 'ควรสอนซ่อมเสริมนักเรียนที่ยังไม่ผ่าน'];
const WORK_SAYS = ['เห็นควรอนุญาตให้ใช้', 'เห็นชอบ', 'ควรปรับแก้ตามข้อเสนอแนะ'];
const QUICK_SAYS = [...NOTE_SAYS, 'ควรใช้สื่อและกิจกรรมที่หลากหลายขึ้น'];
const DEFAULTS = new Set([...WORK_SAYS, ...QUICK_SAYS]);

class PhraseError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

// ขึ้นบรรทัดใหม่หรือเว้นวรรคซ้อนในปุ่มเดียวอ่านยาก ยุบเหลือเว้นวรรคเดียว
function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// ข้อมูลที่หน้าเว็บใช้ ปิดสวิตช์แล้วคืน null หน้าเว็บจะกลับเป็นปุ่มแบบเดิม
async function load(req) {
  if (!req.ff.myphrases) return null;
  const rows = await q.all('SELECT kind, text FROM user_phrases WHERE user_id = ? ORDER BY updated_at DESC, id DESC', req.me.id);
  const of = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.text);
  return { mine: of('mine').reverse(), recent: of('recent'), hidden: of('hidden'), maxLen: MAX_LEN };
}

async function add(userId, value) {
  const text = clean(value);
  if (!text) throw new PhraseError('ยังไม่ได้พิมพ์ข้อความ');
  if (text.length > MAX_LEN) throw new PhraseError(`คำที่จำไว้ยาวได้ไม่เกิน ${MAX_LEN} ตัวอักษร`);
  // เป็นปุ่มเดิมที่เคยซ่อน คืนปุ่มนั้นแทนการเก็บซ้ำ
  if (DEFAULTS.has(text)) {
    await q.run("DELETE FROM user_phrases WHERE user_id = ? AND kind = 'hidden' AND text = ?", userId, text);
    return text;
  }
  const had = await q.get("SELECT id FROM user_phrases WHERE user_id = ? AND kind = 'mine' AND text = ?", userId, text);
  if (!had) {
    const { n } = await q.get("SELECT COUNT(*) AS n FROM user_phrases WHERE user_id = ? AND kind = 'mine'", userId);
    if (Number(n) >= MAX_MINE) throw new PhraseError(`จำได้ไม่เกิน ${MAX_MINE} คำ กดกากบาทลบคำที่ไม่ใช้ก่อน`);
    await q.run("INSERT INTO user_phrases (user_id, kind, text, updated_at) VALUES (?, 'mine', ?, ?)", userId, text, nowStr());
  }
  await q.run("DELETE FROM user_phrases WHERE user_id = ? AND kind = 'recent' AND text = ?", userId, text);
  return text;
}

// ปุ่มเดิมของระบบเก็บเป็นรายการซ่อน คืนได้ · คำของผู้ใช้ลบออกจริง
async function remove(userId, value) {
  const text = clean(value);
  if (DEFAULTS.has(text)) {
    await q.run(
      "INSERT INTO user_phrases (user_id, kind, text, updated_at) VALUES (?, 'hidden', ?, ?) ON CONFLICT (user_id, kind, text) DO NOTHING",
      userId,
      text,
      nowStr()
    );
    return;
  }
  await q.run("DELETE FROM user_phrases WHERE user_id = ? AND kind IN ('mine', 'recent') AND text = ?", userId, text);
}

async function restore(userId) {
  await q.run("DELETE FROM user_phrases WHERE user_id = ? AND kind = 'hidden'", userId);
}

// จำความเห็นที่พิมพ์เองหลังลงนามหรือส่งกลับสำเร็จแล้ว ถ้าจำไม่ได้ต้องไม่ทำให้การลงนามพัง
async function remember(req, comments) {
  if (!req.ff.myphrases) return;
  try {
    const texts = [...new Set(comments.map(clean))].filter((t) => t && t.length <= MAX_LEN && !DEFAULTS.has(t)).slice(0, MAX_RECENT);
    if (!texts.length) return;
    const userId = req.me.id;
    const now = nowStr();
    await q.run(
      `INSERT INTO user_phrases (user_id, kind, text, updated_at)
       SELECT ?::int, 'recent', t, ?::text FROM unnest(?::text[]) AS t
       WHERE NOT EXISTS (SELECT 1 FROM user_phrases m WHERE m.user_id = ? AND m.kind = 'mine' AND m.text = t)
       ON CONFLICT (user_id, kind, text) DO UPDATE SET updated_at = excluded.updated_at`,
      userId,
      now,
      texts,
      userId
    );
    await q.run(
      `DELETE FROM user_phrases WHERE id IN (
         SELECT id FROM user_phrases WHERE user_id = ? AND kind = 'recent' ORDER BY updated_at DESC, id DESC OFFSET ?
       )`,
      userId,
      MAX_RECENT
    );
  } catch (err) {
    console.error(err);
  }
}

module.exports = { NOTE_SAYS, WORK_SAYS, QUICK_SAYS, MAX_MINE, MAX_RECENT, MAX_LEN, load, add, remove, restore, remember };
