// ลองระบบแบบ Cloudflare Workers ในเครื่อง (npm run dev:workers) ไม่ต้องมีบัญชี Cloudflare
//   1. build หน้าเว็บและไฟล์ static (dist/)
//   2. เปิด PGlite เป็นเซิร์ฟเวอร์ Postgres ที่พอร์ต 5433 ข้อมูลใน data-dev/pg (แทน Supabase) แล้วสร้างตาราง
//   3. เปิด wrangler dev ที่ http://localhost:8790 (Hyperdrive ในเครื่องชี้ไปที่พอร์ต 5433 ตาม wrangler.jsonc)
// ตัวเลือก: --fresh ล้างฐานใน data-dev/pg ก่อน (เริ่มจากหน้าตั้งค่าครั้งแรก)
//           --https เปิดแบบเว็บจริง (APP_ENV=production ผ่าน https ใบรับรองทดลอง ต้องกรอก SETUP_TOKEN ใน data-dev/setup-token.txt)
// ไฟล์งานส่งเข้า Google Drive จริงตามรหัสใน .dev.vars แต่อยู่ในโฟลเดอร์แยก "ทดลอง ระบบส่งแผนการสอน" ไม่ปนกับโฟลเดอร์จริง
// รหัสลับของการลองในเครื่อง (SESSION_SECRET SETUP_TOKEN) สุ่มเก็บใน data-dev/ ซึ่งไม่ขึ้น Git
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEV = path.join(ROOT, 'data-dev');
const PG_DIR = path.join(DEV, 'pg');
const PG_PORT = 5433;
const PORT = 8790; // 8787 ค่าเริ่มต้นของ wrangler อาจถูกตัวทดลองตอน 1 (spike/) ใช้อยู่
const TRIAL_FOLDER = 'ทดลอง ระบบส่งแผนการสอน';
const args = process.argv.slice(2);
const https = args.includes('--https');

function secretFile(name, bytes) {
  const f = path.join(DEV, name);
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const v = crypto.randomBytes(bytes).toString('hex');
    fs.writeFileSync(f, v);
    return v;
  }
}

function waitPort(port, ms = 30000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.end();
        resolve(undefined);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > until) reject(new Error(`รอพอร์ต ${port} นานเกินไป`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function main() {
  fs.mkdirSync(DEV, { recursive: true });
  if (args.includes('--fresh')) fs.rmSync(PG_DIR, { recursive: true, force: true });

  require('./build-views').build({ quiet: true });
  const assets = require('./build-assets').build({ quiet: true });
  console.log(`build แล้ว: หน้าเว็บ และไฟล์ static ${assets.count} ไฟล์ (รุ่น ${assets.version})`);

  const children = [];
  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // PGlite รับได้ทีละ session จริง ตั้ง max-connections=10 ให้หลายคำขอพร้อมกันไม่ถูกตัด (ตอน 1 ข้อ 8)
  fs.mkdirSync(PG_DIR, { recursive: true });
  const pgServer = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/@electric-sql/pglite-socket/dist/scripts/server.js'), `--db=${PG_DIR}`, `--port=${PG_PORT}`, '--max-connections=10', '--extensions=pgcrypto'],
    { stdio: 'inherit' }
  );
  children.push(pgServer);
  await waitPort(PG_PORT);

  // สร้างตาราง (ในเครื่องเท่านั้น เว็บจริงรัน db/schema.sql ใน Supabase เอง)
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/postgres`;
  const db = require('../src/db');
  await db.open();
  await db.close();
  console.log(`ฐานข้อมูล PGlite พร้อม (พอร์ต ${PG_PORT} ข้อมูลใน data-dev/pg)`);

  const vars = {
    APP_ENV: https ? 'production' : 'development',
    SESSION_SECRET: secretFile('session-secret.txt', 32),
    GDRIVE_ROOT_FOLDER: TRIAL_FOLDER,
  };
  if (https) vars.SETUP_TOKEN = secretFile('setup-token.txt', 12);
  const envFile = path.join(DEV, 'workers.env');
  fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  const envFiles = [];
  if (fs.existsSync(path.join(ROOT, '.dev.vars'))) envFiles.push('--env-file', '.dev.vars');
  envFiles.push('--env-file', path.relative(ROOT, envFile));
  const wrangler = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', String(PORT), ...envFiles, ...(https ? ['--local-protocol', 'https'] : []), '--test-scheduled'],
    { cwd: ROOT, stdio: 'inherit' }
  );
  children.push(wrangler);
  wrangler.on('exit', (code) => {
    pgServer.kill();
    process.exit(code || 0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
