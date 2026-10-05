// ตอน 1 ทดลองนำร่อง: Express 5 ตัวจริงบน Cloudflare Workers
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { handleAsNodeRequest } from 'cloudflare:node';
import express from 'express';
import cookieSession from 'cookie-session';
import pg from 'pg';
import QRCode from 'qrcode';
import config from '../src/config.js';
import { render } from './render.mjs';
import { locals } from './locals.mjs';

const PORT = 3000;
const als = new AsyncLocalStorage();
const TOP_LEVEL_NOW = Date.now(); // ดูว่าระดับบนสุดได้ 0 จริงไหม
let ready = false;
let expressHits = 0;

// สร้างแอปตอนคำขอแรก ไม่สร้างที่ระดับบนสุด
function start() {
  const app = express();
  app.set('trust proxy', true); // เฉพาะบน Workers
  app.use((req, res, next) => {
    expressHits++;
    als.run({ ...(als.getStore() || {}), inner: req.path }, next);
  });
  app.use(cookieSession({ name: 'spike', keys: ['spike-not-secret'], secure: true, httpOnly: true, sameSite: 'lax' }));

  app.get('/', (req, res) => res.json({ ok: true, topLevelNow: TOP_LEVEL_NOW, nowAtRequest: Date.now() }));
  app.get('/config', (req, res) => res.json({ ROOT: config.ROOT, DATA_DIR: config.DATA_DIR, DB_FILE: config.DB_FILE, PORT: config.PORT }));
  app.get('/error-page', (req, res) => res.type('html').send(render('error', locals(req.query.kind))));
  app.get('/cookie', (req, res) => {
    req.session.n = (req.session.n || 0) + 1;
    res.json({ n: req.session.n, protocol: req.protocol, secure: req.secure });
  });
  app.get('/ip', (req, res) => res.json({ cf: req.get('cf-connecting-ip') || null, ip: req.ip || null }));
  app.post('/als', express.urlencoded({ extended: false }), async (req, res) => {
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
    res.json({ body: req.body.x, store: als.getStore() || null });
  });
  // รับข้อมูลดิบแล้วส่งต่อทันที ไม่ผ่านตัวอ่าน body
  app.put('/chunk', async (req, res, next) => {
    try {
      const r = await fetch(req.app.get('sink'), { method: 'PUT', body: Readable.toWeb(req), duplex: 'half', headers: { 'content-type': 'application/octet-stream' } });
      res.status(r.status).type('json').send(await r.text());
    } catch (e) {
      next(e);
    }
  });
  app.get('/db', async (req, res, next) => {
    const client = new pg.Client({ connectionString: req.app.get('pg') });
    try {
      await client.connect();
      const r = await client.query('select 1 as one, $1::text as tag', [req.query.tag || '']);
      res.json(r.rows[0]);
    } catch (e) {
      next(e);
    } finally {
      client.end().catch(() => {});
    }
  });
  app.get('/qr', async (req, res) => {
    res.type('image/svg+xml').send(await QRCode.toString(String(req.query.u || ''), { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }));
  });
  app.get('/hits', (req, res) => res.json({ expressHits }));
  app.use((err, req, res, next) => res.status(500).json({ error: String((err && err.stack) || err) }));

  http.createServer(app).listen(PORT);
  return app;
}

let app;
export default {
  async fetch(request, env, ctx) {
    if (!ready) {
      app = start();
      ready = true;
    }
    app.set('sink', env.SINK_URL);
    app.set('pg', env.HYPERDRIVE.connectionString);
    // เติม x-forwarded-proto ตามโปรโตคอลจริง ให้ cookie แบบ secure ทำงาน
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
    const req2 = new Request(request, { headers });
    return als.run({ outer: 'fetch', hasCtx: typeof ctx.waitUntil === 'function' }, () => handleAsNodeRequest(PORT, req2));
  },
};
