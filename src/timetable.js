// อ่านไฟล์งานของโปรแกรมจัดตารางสอน (งานล่าสุด.json) แล้วสรุปว่าครูแต่ละคนสอนวิชาอะไรบ้าง
// ใช้แค่ข้อมูลรายการสอน (ใครสอนวิชาไหน ชั้นไหน) ไม่ต้องรอให้จัดตารางเสร็จ และไม่แก้ไขไฟล์ต้นฉบับ

class TimetableError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

const PREFIX = /^(นางสาว|นาง|นาย|น\.ส\.|ว่าที่\s*(ร้อย|ร\.)\s*\S+|ดร\.|ครู)\s*/;

// ชื่อสำหรับจับคู่: ตัดคำนำหน้าและช่องว่างทั้งหมด
function normName(s) {
  let n = String(s || '').trim();
  for (let i = 0; i < 3 && PREFIX.test(n); i++) n = n.replace(PREFIX, '');
  return n.replace(/\s+/g, '');
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

// ระดับชั้นที่เรียนวิชานี้มากที่สุด เช่น ม.4
function topLevel(counts) {
  let best = '';
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

function parse(buf) {
  let j;
  try {
    j = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8').replace(/^﻿/, '') : buf);
  } catch {
    throw new TimetableError('อ่านไฟล์ไม่ได้ ไฟล์นี้ไม่ใช่ไฟล์งานของโปรแกรมจัดตารางสอน (ต้องเป็นไฟล์ .json)');
  }
  if (!j || !Array.isArray(j.teachers) || !Array.isArray(j.lessons)) {
    throw new TimetableError('ไฟล์นี้ไม่มีรายชื่อครูและรายการสอน ให้เลือกไฟล์ งานล่าสุด.json ในโฟลเดอร์ข้อมูลตารางสอนของภาคเรียนนั้น');
  }
  const levelOf = new Map((j.classes || []).map((c) => [String(c.id), str(c.level, 30)]));
  const names = j.subjectNames && typeof j.subjectNames === 'object' ? j.subjectNames : {};
  const byTeacher = new Map();
  for (const l of j.lessons) {
    const code = str(l && l.subj, 30);
    if (!code) continue;
    for (const tid of Array.isArray(l.teachers) ? l.teachers : []) {
      const subs = byTeacher.get(String(tid)) || new Map();
      byTeacher.set(String(tid), subs);
      const s = subs.get(code) || { code, name: '', levels: new Map() };
      s.name = s.name || str(l.subjName || names[code], 200);
      const lv = levelOf.get(String(l.cls));
      if (lv) s.levels.set(lv, (s.levels.get(lv) || 0) + 1);
      subs.set(code, s);
    }
  }
  const teachers = j.teachers
    .map((t) => ({
      ttId: String(t.id),
      name: str(t.name, 150),
      subjects: [...(byTeacher.get(String(t.id)) || new Map()).values()]
        .map((s) => ({ code: s.code, name: s.name, grade: topLevel(s.levels) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .filter((t) => t.name && t.subjects.length);
  if (!teachers.length) throw new TimetableError('ไฟล์นี้ยังไม่มีรายการสอนของครูเลย');
  return {
    school: str(j.school, 200),
    year: Number(j.year) || null,
    semester: Number(j.term) || null,
    teachers,
    subjectCount: new Set(teachers.flatMap((t) => t.subjects.map((s) => s.code))).size,
  };
}

// จับคู่ครูในตารางสอนกับบัญชีในระบบด้วยชื่อ (ไม่สนคำนำหน้าและช่องว่าง) ถ้าชื่อซ้ำกันหลายคนจะไม่จับคู่ให้
function match(teachers, users) {
  const byName = new Map();
  for (const u of users) {
    const k = normName(u.full_name);
    byName.set(k, byName.has(k) ? null : u);
  }
  return teachers.map((t) => {
    const u = byName.get(normName(t.name));
    return { ...t, userId: u ? u.id : null };
  });
}

module.exports = { parse, match, normName, TimetableError };
