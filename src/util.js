// ตัวช่วยเล็ก ๆ ที่ใช้หลายหน้า: วันที่ภาษาไทย ป้ายสถานะ CSV
const time = require('./time');

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function parts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: m[4], mi: m[5] };
}

// 2026-10-04 -> 4 ตุลาคม 2569
function thaiDate(s, short = false) {
  const p = parts(s);
  if (!p) return '';
  const months = short ? TH_MONTHS_SHORT : TH_MONTHS;
  return `${p.d} ${months[p.mo - 1]} ${p.y + 543}`;
}

function thaiDateTime(s) {
  const p = parts(s);
  if (!p) return '';
  return `${thaiDate(s, true)} ${p.h ? `${p.h}:${p.mi} น.` : ''}`.trim();
}

// เวลาที่ผ่านมาแบบอ่านง่าย เช่น 2 ชั่วโมงก่อน เมื่อวาน (นับตามเวลาไทย ไม่ขึ้นกับเขตเวลาของเครื่อง)
function ago(s, now = new Date()) {
  const p = parts(s);
  if (!p) return '';
  const t = time.parseLocal(String(s).slice(0, 16));
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `${min} นาทีก่อน`;
  const n = time.bangkokParts(now);
  const days = time.dayNumber(n.y, n.mo, n.d) - time.dayNumber(p.y, p.mo, p.d);
  if (min < 24 * 60 && days === 0) return `${Math.floor(min / 60)} ชั่วโมงก่อน`;
  if (days <= 1) return 'เมื่อวาน';
  if (days < 7) return `${days} วันก่อน`;
  return thaiDate(s, true);
}

// จำนวนวันจากวันนี้ (วันที่ไทย) ถึงวันที่กำหนด (YYYY-MM-DD) ติดลบถ้าเลยมาแล้ว
function daysUntil(dateStr, now = new Date()) {
  const p = parts(dateStr);
  if (!p) return null;
  const n = time.bangkokParts(now);
  return time.dayNumber(p.y, p.mo, p.d) - time.dayNumber(n.y, n.mo, n.d);
}

const STATUS_CLASS = {
  draft: 'badge-gray',
  pending: 'badge-amber',
  returned: 'badge-red',
  approved: 'badge-green',
};

function lines(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseJson(s, fallback) {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV ภาษาไทยเปิดใน Excel ได้ตรง ต้องมี BOM นำหน้า
function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// แยกข้อความที่วางจาก Excel (คั่นด้วย Tab) หรือ CSV
function parsePasted(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (raw.includes('\t')) out.push(raw.split('\t').map((c) => c.trim()));
    else out.push(splitCsvLine(raw));
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function fileSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// หัวข้อบอกชื่อไฟล์ตอนดาวน์โหลด รองรับชื่อภาษาไทย (RFC 6266)
function contentDisposition(name, type = 'attachment') {
  const ascii = String(name).replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const utf = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf}`;
}

function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// ชื่อย่อของผู้ตรวจแต่ละระดับ ใช้ในป้ายสถานะเล็ก ๆ
const SHORT_ROLE = {
  dept_head: 'หัวหน้ากลุ่มสาระ',
  section_head: 'หัวหน้างานส่งเสริม',
  academic_head: 'หัวหน้าวิชาการ',
  deputy_academic: 'รอง ผอ.',
  director: 'ผอ.',
};

function initials(name) {
  const s = String(name || '').replace(/^(นาย|นางสาว|นาง|ว่าที่ร้อยตรี|ดร\.)\s*/, '').trim();
  return (/^[เแโใไ]/.test(s) ? s.slice(0, 2) : s.slice(0, 1)) || 'ค';
}

// เลข id จากที่อยู่เว็บหรือฟอร์ม ต้องเป็นจำนวนเต็มในช่วง integer ของ Postgres ไม่อย่างนั้นตอบ 404 ทันที ไม่ส่งเข้าฐาน
// (SQLite ไม่เจอแถวก็เป็น 404 แต่ Postgres error 22P02 และ 22003 จะกลายเป็น 500)
// optional: ค่าว่างได้ null แทน 404 ใช้กับตัวกรองที่ไม่บังคับ
const MAX_INT = 2147483647;
function idParam(v, { optional = false } = {}) {
  const s = String(v ?? '').trim();
  if (optional && s === '') return null;
  const id = idOrNull(s);
  if (id !== null) return id;
  const err = new Error('not found');
  err.status = 404;
  throw err;
}

// แบบไม่โยน error: id ใช้ไม่ได้ได้ null ให้หน้านั้นตอบ "ไม่พบ" ด้วยข้อความของตัวเองเหมือนเดิม
function idOrNull(v) {
  const s = String(v ?? '').trim();
  return /^\d{1,10}$/.test(s) && Number(s) <= MAX_INT ? Number(s) : null;
}

// ตัวเลขที่ไม่ใช่ id เช่น ปีการศึกษา ภาคเรียน ถ้าไม่ใช่จำนวนเต็มในช่วงให้ใช้ค่าสำรอง
function intOr(v, fallback) {
  const s = String(v ?? '').trim();
  return /^-?\d{1,10}$/.test(s) && Math.abs(Number(s)) <= MAX_INT ? Number(s) : fallback;
}

module.exports = { idParam, idOrNull, intOr, ago, daysUntil, SHORT_ROLE, initials, thaiDate, thaiDateTime, STATUS_CLASS, lines, parseJson, toCsv, parsePasted, fileSize, safeUrl, contentDisposition };
