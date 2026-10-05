// เวลาไทยเสมอ ไม่ขึ้นกับเขตเวลาของเครื่อง (Workers และ Supabase ใช้ UTC)
// สตริงเวลาในฐานข้อมูลเป็นเวลาไทย รูปแบบ YYYY-MM-DD HH:MM:SS
// ห้ามคำนวณเวลาที่ระดับบนสุดของโมดูล (บน Workers เวลาตรงนั้นเป็น 0) ทุกฟังก์ชันคำนวณตอนเรียก
const TZ = 'Asia/Bangkok';

let fmt = null;
function formatter() {
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return fmt;
}

// ปี เดือน วัน ชั่วโมง นาที วินาที ตามเวลาไทย (ตัวเลข)
function bangkokParts(d = new Date()) {
  const o = {};
  for (const p of formatter().formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// เวลาไทยตอนนี้ (หรือของ d) เป็น YYYY-MM-DD HH:MM:SS รูปแบบเดิมที่เก็บในฐาน
function nowStr(d = new Date()) {
  const p = bangkokParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

// วันที่ไทยวันนี้ YYYY-MM-DD
function todayStr(d = new Date()) {
  return nowStr(d).slice(0, 10);
}

// สตริงในฐาน (เวลาไทย) เป็น Date · ไม่มีเวลาถือเป็นเที่ยงคืน · อ่านไม่ได้ได้ null
function parseLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(str || ''));
  if (!m) return null;
  // ประเทศไทยไม่มีเวลาออมแสง ห่างจาก UTC 7 ชั่วโมงคงที่
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 7, Number(m[5] || 0), Number(m[6] || 0)));
}

// ลำดับวัน (นับจาก 1970) ของวันที่ YYYY-MM-DD ใช้หาจำนวนวันระหว่างสองวันโดยไม่สนเวลา
function dayNumber(y, mo, d) {
  return Math.round(Date.UTC(y, mo - 1, d) / 86400000);
}

module.exports = { TZ, bangkokParts, nowStr, todayStr, parseLocal, dayNumber };
