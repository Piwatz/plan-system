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
  const app = createApp({ assetVersion });
  http.createServer(app).listen(PORT);
  appReady = true;
}

export default {
  async fetch(request, _env, ctx) {
    startApp();
    // บอกแอปว่าผู้ใช้เข้ามาทาง https หรือ http ตามที่อยู่จริง (cookie แบบ secure ต้องรู้) เขียนทับค่าที่ผู้ใช้ส่งมาเอง
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
    const forwarded = new Request(request, { headers });
    // งานปิดการเชื่อมต่อฐานหลังส่งคำตอบ ให้ Workers รอจนเสร็จ (db.requestScope เรียก)
    return db.outerScope({ waitUntil: (p) => ctx.waitUntil(p) }, () => handleAsNodeRequest(PORT, forwarded));
  },

  async scheduled(controller, _env, ctx) {
    useEnv();
    ctx.waitUntil(jobs.runCron(controller.cron));
  },
};
