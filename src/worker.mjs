// จุดเริ่มต้นบน Cloudflare Workers (เว็บจริง และ npx wrangler dev ในเครื่อง) · บน Node ใช้ server.js แทน ไฟล์นี้ไม่ถูกโหลด
// แอป Express ตัวเดียวกับบน Node รับคำขอผ่าน handleAsNodeRequest · ฐานข้อมูลต่อผ่าน Hyperdrive ทีละคำขอ
// ไฟล์ static (dist/assets) Cloudflare ส่งให้เองก่อนถึงไฟล์นี้ · งานตามเวลามาจาก Cron Trigger ใน wrangler.jsonc
import http from 'node:http';
import { env } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import db from './db.js';
import jobs from './jobs.js';
import { createApp } from './app.js';
import assetVersion from '../dist/assets-version.js';
import builtAt from '../dist/build-time.js';

const PORT = 3000;
let dbReady = false;
let appReady = false;

// ค่าตั้งและรหัสลับ (vars และ secret ของ Worker) ให้โค้ดเดิมอ่านจาก process.env ได้เหมือนบน Node
function useEnv() {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && process.env[k] === undefined) process.env[k] = v;
  if (!dbReady) {
    db.openWorkers(() => env.HYPERDRIVE.connectionString);
    dbReady = true;
  }
}

// สร้างแอปตอนคำขอแรก ไม่สร้างที่ระดับบนสุด (นอกคำขอ Workers ยังไม่ให้อ่านเวลา สุ่ม หรือต่อเครือข่าย)
function startApp() {
  if (appReady) return;
  useEnv();
  const app = createApp({ assetVersion, builtAt });
  http.createServer(app).listen(PORT);
  appReady = true;
}

export default {
  async fetch(request, _env, ctx) {
    startApp();
    // บอกแอปว่าผู้ใช้เข้ามาทาง https หรือ http ตามที่อยู่จริง (cookie แบบ secure ต้องรู้) เขียนทับค่าที่ผู้ใช้ส่งมาเอง
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
    const box = {};
    let forwarded;
    // ท่อนไฟล์ที่อัปโหลด (PUT /upload/...) ส่งต่อเข้า Drive ตรงจากสตรีมของ Cloudflare ไม่ผ่านสตรีมของ Node (กิน CPU เกินโควตาแบบฟรี)
    // แอปได้คำขอที่ไม่มีเนื้อ ส่วนเนื้อฝากไว้ใน box.reqBody ให้เส้นทางหยิบไปส่งต่อ (ต้องแยกก่อนสร้างคำขอใหม่ ไม่อย่างนั้นเนื้อถูกยึดไป)
    if (request.method === 'PUT' && new URL(request.url).pathname.startsWith('/upload/') && request.body) {
      box.reqBody = request.body;
      // ไม่มีเนื้อแล้วต้องไม่บอกความยาว (แอปจะรอเนื้อที่ไม่มา) ความยาวจริงตรวจด้วย FixedLengthStream ตอนส่งเข้า Drive
      headers.delete('content-length');
      forwarded = new Request(request.url, { method: 'PUT', headers });
    } else forwarded = new Request(request, { headers });
    // งานปิดการเชื่อมต่อฐานหลังส่งคำตอบ ให้ Workers รอจนเสร็จ (db.requestScope เรียก)
    // box.body = สตรีมไฟล์จาก Drive ที่เส้นทางฝากไว้ (sendStored) ส่งให้เบราว์เซอร์ตรงพร้อมหัวที่แอปตั้ง ไม่กิน CPU
    const response = await db.outerScope({ waitUntil: (p) => ctx.waitUntil(p), box }, () => handleAsNodeRequest(PORT, forwarded));
    if (!box.body) return response;
    await response.body?.cancel();
    return new Response(box.body, { status: response.status, headers: response.headers });
  },

  async scheduled(controller, _env, ctx) {
    useEnv();
    ctx.waitUntil(jobs.runCron(controller.cron));
  },
};
