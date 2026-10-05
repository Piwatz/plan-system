// คัดลอกไฟล์แผนและคู่มือไปเก็บในโฟลเดอร์ Google Drive ของโรงเรียน แยกโฟลเดอร์ ภาคเรียน/กลุ่มสาระ/ชื่อครู/ชนิดงาน
// ใช้โปรแกรม Google Drive for desktop (ฟรีจาก Google) ที่เข้าสู่ระบบด้วยบัญชีโรงเรียนในเครื่องเดียวกับระบบ
// ระบบแค่คัดลอกไฟล์ลงโฟลเดอร์ในเครื่อง โปรแกรมของ Google อัปโหลดขึ้น Drive ให้เอง ระบบจึงไม่ต้องเก็บรหัสผ่านบัญชี Google
// ไฟล์จริงยังเก็บในระบบเหมือนเดิม สำเนาใน Drive มีไว้สำรองและเปิดดูง่าย
const fs = require('fs');
const os = require('os');
const path = require('path');
const { q, nowStr, getSettings, setSetting } = require('./db');
const features = require('./features');
const wf = require('./workflow');
const { storedPath } = require('./upload');

const WHEN = { submit: 'ทุกครั้งที่ครูส่งงาน (สำเนาเป็นฉบับล่าสุดเสมอ)', approved: 'เมื่อผ่านครบทุกระดับแล้วเท่านั้น' };

// ชื่อไฟล์และโฟลเดอร์ห้ามมีตัวอักษรที่ Windows และ Mac ไม่รับ
function safeName(s, fallback) {
  const t = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (t || fallback).slice(0, 80).trim();
}

function subFor(id) {
  return q.get(
    `SELECT s.*, u.full_name AS teacher_name, d.name AS dept_name FROM submissions s
     JOIN users u ON u.id = s.teacher_id LEFT JOIN departments d ON d.id = s.department_id WHERE s.id = ?`,
    id
  );
}

// ตำแหน่งไฟล์ในโฟลเดอร์ Drive เช่น ภาคเรียน 2-2569/วิทยาศาสตร์และเทคโนโลยี/นายสมชาย ใจดี/แผนการจัดการเรียนรู้/ว31101 ฟิสิกส์ 1.pdf
function relPath(sub, file, idx, count) {
  const label = wf.DOC_TYPES[sub.doc_type].label;
  const ext = path.extname(file.original_name || '').toLowerCase() || '.pdf';
  const base = safeName(`${sub.subject_code || ''} ${sub.subject_name || ''}`, label) + (count > 1 ? ` (${idx + 1})` : '');
  return [`ภาคเรียน ${sub.semester}-${sub.academic_year}`, safeName(sub.dept_name, 'ไม่ระบุกลุ่มสาระ'), safeName(sub.teacher_name, 'ไม่ระบุชื่อ'), label, base + ext].join('/');
}

function ready(s) {
  return Boolean(s.drive_dir) && features.isOn(s, 'drivecopy');
}

// งานนี้ควรมีสำเนาใน Drive หรือยัง ตามที่ผู้ดูแลระบบเลือกไว้
function wanted(sub, s) {
  if (!sub || sub.doc_type === 'note') return false;
  if (s.drive_when === 'approved') return sub.status === 'approved';
  return sub.status === 'pending' || sub.status === 'approved';
}

function abs(root, rel) {
  return path.join(root, ...rel.split('/'));
}

async function removeQuiet(p) {
  try {
    await fs.promises.unlink(p);
  } catch {
    // ไม่มีไฟล์ให้ลบ
  }
}

function friendly(e) {
  if (e && e.userMessage) return e.userMessage;
  const code = e && e.code;
  if (code === 'ENOSPC') return 'พื้นที่ในเครื่องหรือใน Google Drive เต็ม';
  if (code === 'EACCES' || code === 'EPERM') return 'ไม่มีสิทธิ์เขียนไฟล์ลงโฟลเดอร์ Google Drive';
  if (code === 'ENOENT') return 'ไม่พบโฟลเดอร์ Google Drive หรือไฟล์ต้นฉบับ';
  return 'คัดลอกไม่สำเร็จ';
}

function checkRoot(root) {
  if (!root || !fs.existsSync(root)) {
    const err = new Error('ไม่พบโฟลเดอร์ Google Drive ที่ตั้งไว้ โปรแกรม Google Drive อาจยังไม่เปิด หรือออกจากระบบไปแล้ว');
    err.userMessage = err.message;
    throw err;
  }
}

// คัดลอกงานเดียวให้ตรงกับไฟล์ล่าสุด: คัดลอกเฉพาะที่ยังไม่มีหรือเปลี่ยนไป ลบสำเนาเก่าที่ไม่ใช้แล้ว
async function syncOne(id, s = getSettings()) {
  const sub = subFor(id);
  if (!ready(s) || !wanted(sub, s)) return 'skip';
  const root = s.drive_dir;
  checkRoot(root);
  const files = q.all("SELECT * FROM files WHERE submission_id = ? AND is_current = 1 AND kind = 'main' ORDER BY id", id);
  const want = files.map((f, i) => ({ f, rel: relPath(sub, f, i, files.length) }));
  const had = q.all('SELECT * FROM drive_copies WHERE submission_id = ?', id);
  for (const h of had) {
    if (want.some((w) => w.f.id === h.file_id && w.rel === h.rel_path)) continue;
    if (!want.some((w) => w.rel === h.rel_path)) await removeQuiet(abs(root, h.rel_path));
    q.run('DELETE FROM drive_copies WHERE submission_id = ? AND file_id = ?', id, h.file_id);
  }
  let copied = 0;
  for (const w of want) {
    const target = abs(root, w.rel);
    const rec = had.find((h) => h.file_id === w.f.id && h.rel_path === w.rel);
    if (rec && fs.existsSync(target)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(storedPath(w.f.stored_name), target);
    q.run('INSERT OR REPLACE INTO drive_copies (submission_id, file_id, rel_path, copied_at) VALUES (?, ?, ?, ?)', id, w.f.id, w.rel, nowStr());
    copied++;
  }
  return copied ? 'copied' : 'same';
}

// คิวคัดลอกทีละงาน ไม่ให้เขียนไฟล์เดียวกันพร้อมกัน
let chain = Promise.resolve();
function enqueue(fn) {
  const job = chain.then(fn);
  chain = job.then(
    () => {},
    () => {}
  );
  return job;
}

function noteResult(err) {
  if (err) setSetting('drive_last_error', `${nowStr()} ${friendly(err)}`);
  else {
    setSetting('drive_last_ok', nowStr());
    setSetting('drive_last_error', '');
  }
}

// เรียกหลังงานเปลี่ยนสถานะ (ส่ง ลงนาม ผ่านครบ) ทำเบื้องหลัง ไม่ทำให้ครูหรือผู้ตรวจต้องรอ และไม่ทำให้การส่งงานล้มเหลว
function queueSync(id) {
  const s = getSettings();
  if (!ready(s)) return Promise.resolve('skip');
  return enqueue(() => syncOne(id, s)).then(
    (r) => {
      if (r === 'copied') noteResult(null);
      return r;
    },
    (e) => {
      noteResult(e);
      return 'error';
    }
  );
}

// คัดลอกทุกงานที่ส่งแล้วทุกภาคเรียน ใช้ตอนเพิ่งเปิดใช้ หรือหลังโฟลเดอร์ Drive ใช้ไม่ได้ไปช่วงหนึ่ง
function syncAll() {
  return enqueue(async () => {
    const s = getSettings();
    const ids = q.all("SELECT id FROM submissions WHERE doc_type IN ('plan', 'manual') AND status IN ('pending', 'approved') ORDER BY id").map((r) => r.id);
    const out = { total: 0, copied: 0, failed: 0, error: '' };
    checkRoot(s.drive_dir);
    for (const id of ids) {
      try {
        const r = await syncOne(id, s);
        if (r !== 'skip') out.total++;
        if (r === 'copied') out.copied++;
      } catch (e) {
        out.total++;
        out.failed++;
        out.error = friendly(e);
      }
    }
    noteResult(out.failed ? { userMessage: out.error } : null);
    return out;
  });
}

// ลบสำเนาใน Drive ของงานที่ถูกลบออกจากระบบ
function forget(ids) {
  const rows = ids.length ? q.all(`SELECT * FROM drive_copies WHERE submission_id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  if (!rows.length) return Promise.resolve();
  q.run(`DELETE FROM drive_copies WHERE submission_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const root = getSettings().drive_dir;
  if (!root || !fs.existsSync(root)) return Promise.resolve();
  return enqueue(async () => {
    for (const r of rows) await removeQuiet(abs(root, r.rel_path));
  });
}

// ตรวจและเตรียมโฟลเดอร์ที่ผู้ดูแลระบบเลือก: ต้องมีอยู่จริง (หรือสร้างในโฟลเดอร์ที่มีอยู่ได้) และเขียนไฟล์ได้
function prepareFolder(dir) {
  const d = String(dir || '')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  const fail = (m) => {
    const e = new Error(m);
    e.userMessage = m;
    throw e;
  };
  if (!d) fail('กรุณาใส่ที่อยู่โฟลเดอร์');
  if (!path.isAbsolute(d)) fail('ที่อยู่โฟลเดอร์ต้องเป็นแบบเต็ม เช่น G:\\My Drive\\ระบบส่งแผน');
  const full = path.resolve(d);
  if (!fs.existsSync(full)) {
    if (!fs.existsSync(path.dirname(full))) fail('ไม่พบโฟลเดอร์นี้ในเครื่อง ตรวจว่าเปิดโปรแกรม Google Drive และเข้าสู่ระบบแล้ว');
    fs.mkdirSync(full);
  }
  if (!fs.statSync(full).isDirectory()) fail('ที่อยู่นี้เป็นไฟล์ ไม่ใช่โฟลเดอร์');
  const probe = path.join(full, `.plan-system-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch {
    fail('เขียนไฟล์ลงโฟลเดอร์นี้ไม่ได้ ตรวจสิทธิ์ของโฟลเดอร์ หรือเลือกโฟลเดอร์อื่น');
  }
  return full;
}

// หาโฟลเดอร์ของ Google Drive for desktop ในเครื่องนี้ ให้ผู้ดูแลระบบกดเลือกได้เลย
function detectFolders() {
  const names = ['My Drive', 'ไดรฟ์ของฉัน', 'Shared drives', 'ไดรฟ์ที่แชร์'];
  const roots = [];
  if (process.platform === 'win32') {
    for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') roots.push(`${L}:\\`);
  } else if (process.platform === 'darwin') {
    const cs = path.join(os.homedir(), 'Library', 'CloudStorage');
    try {
      for (const d of fs.readdirSync(cs)) if (d.startsWith('GoogleDrive')) roots.push(path.join(cs, d));
    } catch {
      // ยังไม่ได้ติดตั้ง Google Drive
    }
    roots.push('/Volumes/GoogleDrive');
  }
  const out = [];
  for (const r of roots) {
    for (const n of names) {
      const p = path.join(r, n);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      if (/Shared drives|ไดรฟ์ที่แชร์/.test(n)) {
        // ไดรฟ์ที่แชร์ต้องเลือกไดรฟ์ข้างใน
        try {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(p, e.name));
        } catch {
          // เปิดไม่ได้
        }
      } else out.push(p);
    }
  }
  return out;
}

function stats() {
  return q.get('SELECT COUNT(*) AS files, COUNT(DISTINCT submission_id) AS works FROM drive_copies');
}

module.exports = { WHEN, safeName, relPath, syncOne, queueSync, syncAll, forget, prepareFolder, detectFolders, stats };
