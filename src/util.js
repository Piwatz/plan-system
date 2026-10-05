// ตัวช่วยเล็ก ๆ ที่ใช้หลายหน้า: วันที่ภาษาไทย ป้ายสถานะ CSV
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

// เวลาที่ผ่านมาแบบอ่านง่าย เช่น 2 ชั่วโมงก่อน เมื่อวาน
function ago(s, now = new Date()) {
  const p = parts(s);
  if (!p) return '';
  const t = new Date(p.y, p.mo - 1, p.d, Number(p.h || 0), Number(p.mi || 0));
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `${min} นาทีก่อน`;
  if (min < 24 * 60 && t.getDate() === now.getDate()) return `${Math.floor(min / 60)} ชั่วโมงก่อน`;
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(p.y, p.mo - 1, p.d)) / 86400000);
  if (days <= 1) return 'เมื่อวาน';
  if (days < 7) return `${days} วันก่อน`;
  return thaiDate(s, true);
}

// จำนวนวันจากวันนี้ถึงวันที่กำหนด (YYYY-MM-DD) ติดลบถ้าเลยมาแล้ว
function daysUntil(dateStr, now = new Date()) {
  const p = parts(dateStr);
  if (!p) return null;
  return Math.round((new Date(p.y, p.mo - 1, p.d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
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

module.exports = { ago, daysUntil, SHORT_ROLE, initials, thaiDate, thaiDateTime, STATUS_CLASS, lines, parseJson, toCsv, parsePasted, fileSize, safeUrl, contentDisposition };
