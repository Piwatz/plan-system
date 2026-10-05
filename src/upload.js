// ไฟล์งานที่ครูแนบ (แผน คู่มือ ไฟล์ประกอบบันทึกหลังแผน)
// เบราว์เซอร์ส่งไฟล์เป็นท่อนเข้าที่เก็บ (src/storage.js) ก่อน ได้ token กลับมา แล้วจึงส่งฟอร์มพร้อม token ในช่อง upload_<ชื่อช่องไฟล์>
// เซิร์ฟเวอร์ไม่แตะเนื้อไฟล์ทั้งก้อน: ตรวจชนิดไฟล์จาก 8 ไบต์แรก · ห้ามเรียกที่เก็บไฟล์ระหว่าง transaction ค้าง
const path = require('path');
const crypto = require('crypto');
const { q, nowStr } = require('./db');
const storage = require('./storage');

const ALLOWED = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// แนบได้ช่องละไม่เกิน 10 ไฟล์ (เท่าเดิม)
const MAX_FILES = 10;
const EXPIRED = 'ไฟล์ที่แนบหมดเวลาแล้ว กรุณาแนบไฟล์ใหม่อีกครั้ง';

class UploadError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

// ชื่อไฟล์ภาษาไทยบางเบราว์เซอร์ส่งมาเป็นรหัส latin1 ต้องแปลงกลับเป็น UTF-8
function fixName(name) {
  const s = String(name || 'file');
  if ([...s].some((c) => c.charCodeAt(0) > 255)) return s;
  const u = Buffer.from(s, 'latin1').toString('utf8');
  return u.includes('�') ? s : u;
}

const extOf = (name) => path.extname(String(name || '')).toLowerCase();
const maxMb = (settings) => Number(settings.max_upload_mb) || 20;

// ตรวจก่อนเริ่มส่ง: ชนิดไฟล์ (ข้อความเดิมของระบบ) และขนาดไม่เกินเพดาน
function checkNew(name, size, settings) {
  if (!ALLOWED[extOf(name)]) throw new UploadError('รับเฉพาะไฟล์ PDF Word Excel PowerPoint และรูปภาพ');
  const mb = maxMb(settings);
  if (!Number.isSafeInteger(size) || size < 0 || size > mb * 1024 * 1024) throw new UploadError(`ไฟล์ใหญ่เกิน ${mb} MB`);
  return ALLOWED[extOf(name)];
}

// เริ่มส่งไฟล์ 1 ไฟล์: สร้างที่ปลายทาง (Drive resumable session) แล้วเก็บไว้ในฐาน คืน token ให้เบราว์เซอร์
// name = ชื่อที่แสดงในระบบ · storeName = ชื่อในที่เก็บไฟล์ (เช่น รหัสและชื่อวิชา) · folderPath = โฟลเดอร์ย่อยใต้โฟลเดอร์หลัก
async function start(userId, { name, storeName, size, folderPath, settings }) {
  const mime = checkNew(name, size, settings);
  const session = await storage.current().startUpload({ name: storeName || name, mime, size, folderPath });
  const token = crypto.randomBytes(24).toString('base64url');
  await q.run(
    'INSERT INTO pending_uploads (token, user_id, session_uri, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    token,
    userId,
    session,
    name.slice(0, 200),
    mime,
    size,
    nowStr()
  );
  return token;
}

// Content-Range: "bytes 0-5242879/31457280" หรือ "bytes */0" (ไฟล์ว่าง)
function parseContentRange(h) {
  const s = String(h || '').trim();
  if (s === 'bytes */0') return { start: 0, end: -1, total: 0 };
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(s);
  if (!m) return null;
  const r = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  return r.start <= r.end && r.end < r.total ? r : null;
}

// รับท่อน 1 ท่อนแล้วส่งต่อเข้าที่เก็บทันที (stream = คำขอ ไม่ผ่านตัวอ่าน body)
async function putChunk(userId, token, contentRange, contentLength, stream) {
  const range = parseContentRange(contentRange);
  if (!range) throw new UploadError('ส่งไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
  const length = range.total === 0 ? 0 : range.end - range.start + 1;
  const last = range.end + 1 === range.total || range.total === 0;
  if (length > storage.CHUNK || (!last && length % storage.CHUNK_UNIT) || (contentLength != null && Number(contentLength) !== length)) {
    throw new UploadError('ส่งไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
  // จองแถว (กันส่งท่อนเดียวกันซ้อนกัน) ต้องเป็นท่อนถัดไปพอดีและขนาดไฟล์ตรงกับที่แจ้งไว้
  const row = await q.get(
    "UPDATE pending_uploads SET status = 'sending' WHERE token = ? AND user_id = ? AND status = 'uploading' AND received = ? AND size = ? RETURNING session_uri",
    token,
    userId,
    range.start,
    range.total
  );
  if (!row) throw new UploadError(EXPIRED);
  let r;
  try {
    r = await storage.current().putChunk(row.session_uri, stream, range);
  } catch (e) {
    await q.run("UPDATE pending_uploads SET status = 'uploading' WHERE token = ?", token);
    if (!(e instanceof storage.StorageError)) throw e;
    console.error('ส่งท่อนไฟล์ไม่สำเร็จ', e.message);
    throw new UploadError('ส่งไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
  await q.run(
    'UPDATE pending_uploads SET status = ?, received = ?, drive_file_id = ? WHERE token = ?',
    r.done ? 'done' : 'uploading',
    r.received,
    r.ref || null,
    token
  );
  return { done: r.done, received: r.received };
}

// token จากฟอร์ม (ช่อง upload_<field>) เป็นแถวที่ส่งครบแล้วของผู้ใช้คนนี้ เรียงตามลำดับในฟอร์ม
async function take(req, field) {
  const raw = (req.body || {})['upload_' + field];
  const tokens = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((t) => String(t)).filter(Boolean);
  if (!tokens.length) return [];
  if (tokens.length > MAX_FILES || new Set(tokens).size !== tokens.length) throw new UploadError(EXPIRED);
  const rows = await q.all("SELECT token, name, mime, size, drive_file_id FROM pending_uploads WHERE token = ANY(?) AND user_id = ? AND status = 'done'", tokens, req.me.id);
  const byToken = new Map(rows.map((r) => [r.token, r]));
  if (rows.length !== tokens.length) {
    // บางไฟล์ใช้ไม่ได้ ไฟล์อื่นในชุดเดียวกันก็ทิ้ง (ครูต้องแนบใหม่ทั้งชุดอยู่แล้ว)
    await discard(req.me.id, rows.map((r) => r.token));
    throw new UploadError(EXPIRED);
  }
  return tokens.map((t) => ({ ...byToken.get(t), ext: extOf(byToken.get(t).name) }));
}

// ตรวจว่าไฟล์เป็นชนิดเดียวกับนามสกุลจริง (กันไฟล์เสียหรือเปลี่ยนนามสกุลมา) คืนรายชื่อไฟล์ที่ใช้ไม่ได้
const SIGNATURES = {
  '.pdf': ['%PDF-'],
  '.docx': ['PK'],
  '.xlsx': ['PK'],
  '.pptx': ['PK'],
  '.doc': ['\xD0\xCF\x11\xE0'],
  '.xls': ['\xD0\xCF\x11\xE0'],
  '.ppt': ['\xD0\xCF\x11\xE0'],
  '.png': ['\x89PNG'],
  '.jpg': ['\xFF\xD8\xFF'],
  '.jpeg': ['\xFF\xD8\xFF'],
};

async function badFiles(list) {
  const bad = [];
  for (const f of list) {
    const sig = SIGNATURES[f.ext];
    let head = '';
    if (Number(f.size) > 0) {
      try {
        head = (await storage.readHead(f.drive_file_id, 8)).toString('latin1');
      } catch {
        head = '';
      }
    }
    if (!Number(f.size) || (sig && !sig.some((s) => head.startsWith(s)))) bad.push(f.name);
  }
  return bad;
}

// บันทึกแถว files และปิด token ว่าใช้แล้ว (เรียกใน transaction) · token ที่ถูกใช้ไปแล้วโดยคำขออื่นทำให้ทั้งชุดล้ม
async function attach(subId, list, kind, names = {}) {
  if (!list.length) return;
  const used = await q.run(
    "UPDATE pending_uploads SET status = 'used' WHERE token = ANY(?) AND status = 'done'",
    list.map((f) => f.token)
  );
  if (used.changes !== list.length) throw new UploadError(EXPIRED);
  const now = nowStr();
  for (const f of list) {
    await q.run(
      'INSERT INTO files (submission_id, kind, original_name, stored_name, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      subId,
      kind,
      (names[f.token] || f.name).slice(0, 200),
      f.drive_file_id,
      f.mime || 'application/octet-stream',
      Number(f.size),
      now
    );
  }
}

// ทิ้งไฟล์ที่ส่งมาแต่ไม่ได้ใช้ (ตรวจไม่ผ่าน หรือ transaction ล้ม) ย้ายไปถังขยะ · เรียกหลัง transaction เท่านั้น
// ทิ้งเฉพาะที่ยังไม่ถูกใช้ (กดส่งสองครั้งพร้อมกัน คำขอแรกใช้ไฟล์ไปแล้ว ต้องไม่ทิ้งของคำขอแรก)
async function discard(userId, tokens) {
  if (!tokens.length) return;
  const rows = await q.all(
    "UPDATE pending_uploads SET status = 'trashed' WHERE token = ANY(?) AND user_id = ? AND status = 'done' RETURNING drive_file_id",
    tokens,
    userId
  );
  await trashAll(rows.map((r) => r.drive_file_id));
}

// ย้ายไฟล์ไปถังขยะ ไม่ให้งานหลักล้มเพราะที่เก็บไฟล์มีปัญหา
async function trashAll(refs) {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      await storage.trash(ref);
    } catch (e) {
      console.error('ย้ายไฟล์ไปถังขยะไม่สำเร็จ', ref, e.message);
    }
  }
}

module.exports = { ALLOWED, MAX_FILES, EXPIRED, UploadError, fixName, checkNew, start, putChunk, parseContentRange, take, badFiles, attach, discard, trashAll };
