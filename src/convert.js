// แปลงไฟล์ Word เป็น PDF ด้วยโปรแกรมฟรี LibreOffice ที่ติดตั้งในเครื่องเดียวกับระบบ (Windows Mac Linux)
// แปลงทีละไฟล์ตามคิว เพราะ LibreOffice ทำหลายงานพร้อมกันไม่ได้ ใช้โฟลเดอร์ชั่วคราวแล้วลบทิ้งทุกครั้ง
// ฟอนต์ในไฟล์ Word ต้องติดตั้งไว้ในเครื่องที่เปิดระบบด้วย (เช่น TH SarabunPSK) ไม่อย่างนั้นตัวอักษรจะเพี้ยน
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const WORD_EXT = ['.doc', '.docx'];
const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_WAITING = 8;

class ConvertError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ที่ติดตั้ง LibreOffice ตามปกติของแต่ละระบบ
function candidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
    return [...new Set(roots.filter(Boolean))].map((r) => path.join(r, 'LibreOffice', 'program', 'soffice.exe'));
  }
  if (process.platform === 'darwin') {
    return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(os.homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')];
  }
  const out = ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice'];
  try {
    for (const d of fs.readdirSync('/opt')) if (/^libreoffice/i.test(d)) out.push(path.join('/opt', d, 'program', 'soffice'));
  } catch {
    // ไม่มีโฟลเดอร์ /opt
  }
  return out;
}

// ผู้ดูแลระบบใส่ที่อยู่โปรแกรมเองได้ ใส่เป็นโฟลเดอร์ที่ติดตั้งก็ได้
// รับเฉพาะไฟล์ชื่อโปรแกรม LibreOffice กันการตั้งให้ระบบไปเปิดโปรแกรมอื่นผ่านหน้าเว็บ
const SOFFICE_NAME = /^(soffice(\.exe|\.bin)?|libreoffice)$/i;
function fromCustom(p) {
  const s = String(p || '').trim().replace(/^"(.*)"$/, '$1');
  if (!s) return null;
  const tries = [s, path.join(s, 'soffice.exe'), path.join(s, 'program', 'soffice.exe'), path.join(s, 'soffice'), path.join(s, 'program', 'soffice'), path.join(s, 'Contents', 'MacOS', 'soffice')];
  return tries.find((t) => SOFFICE_NAME.test(path.basename(t)) && isFile(t)) || null;
}

// ที่อยู่โปรแกรม LibreOffice ที่ใช้แปลง (null = ยังไม่ได้ติดตั้ง)
function findSoffice(settings) {
  return fromCustom(settings && settings.soffice_path) || candidates().find(isFile) || null;
}

// ฟอนต์ตระกูล Sarabun ที่ติดตั้งในเครื่อง ใช้เตือนผู้ดูแลระบบ
function fontDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')].filter(Boolean);
  }
  if (process.platform === 'darwin') return ['/Library/Fonts', path.join(home, 'Library', 'Fonts'), '/System/Library/Fonts/Supplemental'];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}

function sarabunFonts() {
  const names = new Set();
  const walk = (dir, depth) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.isDirectory() && depth > 0) walk(path.join(dir, e.name), depth - 1);
      else if (/sarabun/i.test(e.name) && /\.(ttf|otf)$/i.test(e.name)) names.add(e.name);
    }
  };
  for (const d of fontDirs()) walk(d, process.platform === 'linux' ? 3 : 0);
  const all = [...names].sort();
  // TH SarabunPSK ไฟล์ชื่อ THSarabun.ttf THSarabun Bold.ttf หรือมีคำว่า PSK
  const psk = all.some((n) => /psk/i.test(n) || /^THSarabun( ?Bold| ?Italic| ?BoldItalic)?\.ttf$/i.test(n));
  return { all, psk };
}

// สั่ง LibreOffice ทำงาน ปิดโปรแกรมทิ้งถ้าค้างนานเกินกำหนด (แยกไว้ให้ตัวทดสอบสลับแทนได้)
function runSoffice(exe, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
          child.kill();
        }
      } else child.kill('SIGKILL');
      reject(new ConvertError('แปลงไฟล์นานเกินไป ไฟล์อาจใหญ่มากหรือตั้งรหัสผ่านไว้ ลองเปิดใน Word แล้วบันทึกเป็น PDF เอง'));
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function convertOnce(exe, inputPath, ext) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-word-'));
  const src = path.join(work, 'document' + ext);
  // โปรไฟล์ของ LibreOffice แยกจากที่ผู้ใช้เปิดใช้เอง จะได้ไม่ชนกันถ้ามีคนเปิด LibreOffice ค้างไว้ในเครื่องนี้
  const profile = pathToFileURL(path.join(os.tmpdir(), 'plan-system-libreoffice')).href;
  try {
    fs.copyFileSync(inputPath, src);
    try {
      await module.exports.runSoffice(exe, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', work, src]);
    } catch (e) {
      if (e instanceof ConvertError) throw e;
      throw new ConvertError('เปิดโปรแกรม LibreOffice ไม่ได้ ให้ผู้ดูแลระบบตรวจการติดตั้งในหน้าฟังก์ชันเสริม');
    }
    const out = path.join(work, 'document.pdf');
    const buf = isFile(out) ? fs.readFileSync(out) : null;
    if (!buf || !buf.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
      throw new ConvertError('แปลงไฟล์นี้ไม่สำเร็จ ไฟล์อาจเสียหรือตั้งรหัสผ่านไว้ ลองเปิดใน Word แล้วบันทึกเป็น PDF เอง');
    }
    return buf;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

let chain = Promise.resolve();
let waiting = 0;

// แปลงไฟล์ Word เป็น PDF คืนค่าเป็นข้อมูลไฟล์ PDF (Buffer)
function wordToPdf(inputPath, originalName, settings) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!WORD_EXT.includes(ext)) return Promise.reject(new ConvertError('แปลงได้เฉพาะไฟล์ Word นามสกุล .doc และ .docx'));
  const exe = findSoffice(settings);
  if (!exe) return Promise.reject(new ConvertError('เครื่องที่เปิดระบบยังไม่ได้ติดตั้ง LibreOffice จึงแปลงไฟล์ Word ไม่ได้ ให้บันทึกเป็น PDF จาก Word เองก่อน'));
  if (waiting >= MAX_WAITING) return Promise.reject(new ConvertError('ระบบกำลังแปลงไฟล์ของครูท่านอื่นอยู่หลายไฟล์ ลองใหม่อีกครั้งในอีกสักครู่'));
  waiting++;
  const job = chain.then(() => convertOnce(exe, inputPath, ext));
  chain = job.then(
    () => {},
    () => {}
  );
  return job.finally(() => {
    waiting--;
  });
}

module.exports = { WORD_EXT, ConvertError, fromCustom, findSoffice, sarabunFonts, runSoffice, wordToPdf };
