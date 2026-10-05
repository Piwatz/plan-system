// ขอสิทธิ์ให้ระบบเก็บไฟล์ใน Google Drive ของโรงเรียน (ทำครั้งเดียว บนเครื่องของผู้ดูแลระบบ)
//   node scripts/google-auth.js
// 1) ถาม Client ID และ Client secret (จาก Google Cloud Console ชนิด Desktop app) ถ้ายังไม่มีใน .dev.vars
// 2) เปิดเบราว์เซอร์ให้เข้าสู่ระบบด้วยบัญชี Google ที่จะเป็นเจ้าของไฟล์ แล้วกดอนุญาต
// 3) เก็บ GDRIVE_REFRESH_TOKEN ลง .dev.vars ในเครื่องนี้ (ไม่ขึ้น Git ห้ามส่งให้ใคร)
// สิทธิ์ที่ขอ: drive.file อย่างเดียว ระบบเห็นเฉพาะไฟล์และโฟลเดอร์ที่ระบบสร้างเอง ไม่เห็นไฟล์อื่นใน Drive
const http = require('http');
const crypto = require('crypto');
const readline = require('readline/promises');
const { spawn } = require('child_process');
const vars = require('./devvars');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function ask(rl, label) {
  for (;;) {
    const v = (await rl.question(label)).trim();
    if (v) return v;
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // เปิดเองจากที่อยู่ที่แสดง
  }
}

async function main() {
  vars.load();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('  ตั้งค่า Google Drive สำหรับระบบส่งแผนการสอน');
  console.log('');
  if (!process.env.GDRIVE_CLIENT_ID || !process.env.GDRIVE_CLIENT_SECRET) {
    console.log('  คัดลอกค่าจากหน้า Google Cloud Console (Clients) มาวางทีละช่อง');
    vars.set('GDRIVE_CLIENT_ID', await ask(rl, '  Client ID: '));
    vars.set('GDRIVE_CLIENT_SECRET', await ask(rl, '  Client secret: '));
    console.log('  บันทึกลงไฟล์ .dev.vars แล้ว');
  }
  rl.close();

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') {
        res.writeHead(404);
        return res.end();
      }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;font-size:20px">${
          ok ? 'อนุญาตเรียบร้อย ปิดหน้านี้แล้วกลับไปดูหน้าต่างคำสั่ง' : 'ไม่ได้รับอนุญาต ลองใหม่อีกครั้ง'
        }</body>`
      );
      srv.close();
      if (ok) resolve(u.searchParams.get('code'));
      else reject(new Error(u.searchParams.get('error') || 'ไม่ได้รับอนุญาต'));
    });
    srv.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${srv.address().port}`;
      process.env.__REDIRECT = redirect;
      const url =
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: process.env.GDRIVE_CLIENT_ID,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
      console.log('');
      console.log('  กำลังเปิดเบราว์เซอร์ ให้เข้าสู่ระบบด้วยบัญชี Google ที่จะเก็บไฟล์งาน แล้วกดอนุญาต');
      console.log('  ถ้าเบราว์เซอร์ไม่เปิดเอง ให้คัดลอกที่อยู่นี้ไปเปิด:');
      console.log('  ' + url);
      openBrowser(url);
    });
    setTimeout(() => reject(new Error('รอนานเกิน 10 นาที')), 10 * 60 * 1000).unref();
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: process.env.GDRIVE_CLIENT_ID,
      client_secret: process.env.GDRIVE_CLIENT_SECRET,
      redirect_uri: process.env.__REDIRECT,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error(`Google ไม่ส่งรหัสกลับมา (${r.status} ${j.error || ''} ${j.error_description || ''})`);
  if (j.scope && !j.scope.split(' ').includes(SCOPE)) throw new Error('ไม่ได้ติ๊กอนุญาตให้เข้าถึง Google Drive ลองใหม่แล้วติ๊กช่องนั้นด้วย');
  vars.set('GDRIVE_REFRESH_TOKEN', j.refresh_token);
  console.log('');
  console.log('  ✓ เรียบร้อย เก็บรหัสไว้ในไฟล์ .dev.vars ของเครื่องนี้แล้ว (ห้ามส่งไฟล์นี้ให้ใคร)');
  console.log('  ขั้นต่อไป: node scripts/drive-check.js เพื่อทดลองส่งไฟล์เข้า Drive จริง');
  console.log('');
}

main().catch((e) => {
  console.error('');
  console.error('  ✗ ' + e.message);
  process.exit(1);
});
