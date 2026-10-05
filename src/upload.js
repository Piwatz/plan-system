// รับไฟล์ที่ครูอัปโหลด เก็บใน data/uploads/ปี-เดือน/ โดยตั้งชื่อใหม่แบบสุ่ม กันชื่อซ้ำและกันคนเดาชื่อไฟล์
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const { getSettings } = require('./db');

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

// ชื่อไฟล์ภาษาไทยบางเบราว์เซอร์ส่งมาเป็นรหัส latin1 ต้องแปลงกลับเป็น UTF-8
function fixName(name) {
  const s = String(name || 'file');
  if ([...s].some((c) => c.charCodeAt(0) > 255)) return s;
  const u = Buffer.from(s, 'latin1').toString('utf8');
  return u.includes('�') ? s : u;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const d = new Date();
    const sub = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(config.UPLOAD_DIR, sub);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    file.originalname = fixName(file.originalname);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(fixName(file.originalname)).toLowerCase();
  if (!ALLOWED[ext]) {
    const err = new Error('รับเฉพาะไฟล์ PDF Word Excel PowerPoint และรูปภาพ');
    err.code = 'BAD_TYPE';
    return cb(err);
  }
  cb(null, true);
}

function uploader(fields) {
  return (req, res, next) => {
    const mb = Number(getSettings().max_upload_mb) || 20;
    multer({ storage, fileFilter, limits: { fileSize: mb * 1024 * 1024, files: 20 } }).fields(fields)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') err.message = `ไฟล์ใหญ่เกิน ${mb} MB`;
      err.userMessage = err.message;
      next(err);
    });
  };
}

// path ของไฟล์ที่เก็บไว้ (ป้องกันการขอไฟล์นอกโฟลเดอร์ uploads)
function storedPath(stored) {
  const p = path.resolve(config.UPLOAD_DIR, stored);
  if (!p.startsWith(path.resolve(config.UPLOAD_DIR) + path.sep)) throw new Error('bad path');
  return p;
}

function relStored(absPath) {
  return path.relative(config.UPLOAD_DIR, absPath).split(path.sep).join('/');
}

function removeStored(stored) {
  try {
    fs.unlinkSync(storedPath(stored));
  } catch {
    // ไฟล์อาจถูกลบไปแล้ว ไม่เป็นไร
  }
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

function badFiles(req) {
  const bad = [];
  for (const list of Object.values(req.files || {})) {
    for (const f of list) {
      const sig = SIGNATURES[path.extname(f.originalname).toLowerCase()];
      let head = '';
      try {
        const fd = fs.openSync(f.path, 'r');
        const buf = Buffer.alloc(8);
        const n = fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        head = buf.subarray(0, n).toString('latin1');
      } catch {
        head = '';
      }
      if (!f.size || (sig && !sig.some((s) => head.startsWith(s)))) bad.push(f.originalname);
    }
  }
  return bad;
}

module.exports = { uploader, storedPath, relStored, removeStored, badFiles, fixName, ALLOWED };
