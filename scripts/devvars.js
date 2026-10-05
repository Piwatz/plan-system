// อ่านและเขียนไฟล์ .dev.vars (รหัสลับในเครื่อง รูปแบบ KEY=VALUE บรรทัดละค่า) ไฟล์นี้อยู่ใน .gitignore ไม่ขึ้น Git
// ใช้กับสคริปต์ตั้งค่า Google Drive · wrangler (ตอน 13) อ่านไฟล์เดียวกันนี้
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.dev.vars');

// โหลดเข้า process.env (ค่าที่ตั้งไว้แล้วไม่ทับ)
function load() {
  try {
    process.loadEnvFile(FILE);
  } catch {
    // ยังไม่มีไฟล์
  }
}

// ตั้งค่าหนึ่งค่า แทนบรรทัดเดิมถ้ามี บรรทัดอื่นคงไว้
function set(key, value) {
  const lines = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split(/\r?\n/) : [];
  const line = `${key}=${value}`;
  const i = lines.findIndex((l) => l.startsWith(key + '='));
  if (i >= 0) lines[i] = line;
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  fs.writeFileSync(FILE, lines.join('\n') + '\n');
  process.env[key] = value;
}

module.exports = { FILE, load, set };
