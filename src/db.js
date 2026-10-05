// ฐานข้อมูล Postgres (Supabase บนเว็บจริง · PGlite ในเครื่องและตอนทดสอบ)
// ตัวต่อทุกแบบหน้าตาเดียวกัน: q.get q.all q.run q.exec q.tx ทุกตัวต้อง await
// โค้ดเดิมเขียน SQL แบบ SQLite ด้วย ? ชั้นนี้แปลงเป็น $1 $2 ให้เอง และครอบ "current_role" (คำสงวนของ Postgres) ให้เอง
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config');
const { DEFAULT_STEPS } = require('./defaults');

// ---------- ตัวแปลงชนิดข้อมูล ----------
// COUNT SUM ได้ int8 และ AVG ได้ numeric ซึ่งปกติกลับมาเป็นสตริง ให้เป็น number เหมือน SQLite
// json คงเป็นสตริงดิบ (สำรองข้อมูลให้ Postgres สร้าง JSON แล้วส่งต่อเลย ไม่ parse ให้เปลือง CPU)
const PARSERS = { 20: Number, 1700: Number, 114: (x) => x, 3802: (x) => x };

// ---------- ขอบเขตต่อคำขอ ----------
// store = { scope, tx } · scope อยู่ตลอดคำขอ (ข้อมูลอ้างอิง ตัวต่อบน Workers) · tx คือ transaction ที่กำลังทำอยู่
const als = new AsyncLocalStorage();
const GLOBAL = { scope: {}, tx: null }; // นอกคำขอ เช่น ทดสอบ สคริปต์ข้อมูลทดลอง cron

function ctx() {
  return als.getStore() || GLOBAL;
}

// ---------- นับคำสั่งต่อคำขอ ----------
// บน Supabase ทุกคำสั่งคือการเดินทางไปกลับ 20 ถึง 50 ms และ Hyperdrive แบบฟรีให้ 100,000 คำสั่งต่อวัน
// scope.queries = จำนวนคำสั่งที่ส่งไปฐาน (นับ BEGIN และ COMMIT ด้วย) · scope.blobs = จำนวนรูป (data URL) ที่ดึงออกมา
const QUERY_LIMIT = 15;
/** @type {null | ((req: any, stat: { queries: number, blobs: number }) => void)} */
let watcher = null;

// ทดสอบตั้งไว้ดูตัวเลขของแต่ละคำขอ fn(req, { queries, blobs }) ถูกเรียกก่อนส่งหัวคำตอบ · ส่ง null เพื่อเลิก
function watchQueries(fn) {
  watcher = fn;
}

// จำนวนคำสั่งในขอบเขตปัจจุบัน (ทดสอบใช้คู่กับ withScope)
function queryCount() {
  return ctx().scope.queries || 0;
}

// middleware: เปิดขอบเขตใหม่ทุกคำขอ · โหมดทดลองแจ้งใน log เมื่อหน้าไหนใช้เกิน 15 คำสั่ง
function requestScope(req, res, next) {
  const scope = { queries: 0, blobs: 0 };
  if (watcher || config.DEMO) {
    let done = false;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!done) {
        done = true;
        const stat = { queries: scope.queries, blobs: scope.blobs };
        if (watcher) watcher(req, stat);
        if (config.DEMO && stat.queries > QUERY_LIMIT) console.warn(`[ฐานข้อมูล] ${req.method} ${req.originalUrl} ใช้ ${stat.queries} คำสั่ง เกิน ${QUERY_LIMIT}`);
      }
      return writeHead.apply(this, args);
    };
  }
  als.run({ scope, tx: null }, next);
}

// รันงานในขอบเขตใหม่ (cron ทดสอบ) ข้อมูลอ้างอิงไม่ปนกับงานอื่น
function withScope(fn) {
  return als.run({ scope: {}, tx: null }, fn);
}

// ---------- แปลงภาษา SQL ----------
const sqlCache = new Map();

// แปลง ? เป็น $n และครอบ current_role ด้วยเครื่องหมายคำพูด โดยข้ามข้อความใน '...' และชื่อใน "..."
function toPg(sql) {
  let out = sqlCache.get(sql);
  if (out !== undefined) return out;
  let n = 0;
  let res = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      res += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '?') {
      res += '$' + ++n;
      i++;
      continue;
    }
    // ส่วนที่ไม่ใช่ข้อความ: ครอบ current_role ทั้งแบบมีและไม่มีชื่อตารางนำหน้า
    let j = i;
    while (j < sql.length && sql[j] !== "'" && sql[j] !== '"' && sql[j] !== '?') j++;
    res += sql.slice(i, j).replace(/(^|[^\w"])current_role(?![\w"])/g, '$1"current_role"');
    i = j;
  }
  sqlCache.set(sql, res);
  return res;
}

// undefined เป็น null · true false เป็น 1 0 (คอลัมน์ธงเป็น integer)
function params(list) {
  return list.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));
}

// ---------- ตัวต่อ ----------
/** @type {any} */
let backend = null;

function mutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const job = chain.then(fn);
    chain = job.then(
      () => {},
      () => {}
    );
    return job;
  };
}

// PGlite มี session เดียว: ระหว่าง transaction หนึ่งทำงาน คำสั่งจากคำขออื่นต้องรอ (ไม่อย่างนั้นจะหลุดเข้าไปอยู่ใน transaction เดียวกัน)
async function openPglite(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pg = await PGlite.create(dataDir || undefined, { extensions: { pgcrypto }, parsers: PARSERS });
  const lock = mutex();
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows || 0 });
  return {
    kind: 'pglite',
    query: (c, text, values) => (c.tx ? pg.query(text, values).then(norm) : lock(() => pg.query(text, values).then(norm))),
    exec: (c, sql) => (c.tx ? pg.exec(sql) : lock(() => pg.exec(sql))),
    tx: (c, fn) =>
      lock(async () => {
        await pg.exec('BEGIN');
        try {
          const r = await als.run({ scope: c.scope, tx: pg }, fn);
          await pg.exec('COMMIT');
          return r;
        } catch (e) {
          await pg.exec('ROLLBACK');
          throw e;
        }
      }),
    close: () => pg.close(),
  };
}

// Node.js ต่อ Postgres จริง (DATABASE_URL) · transaction ยืม client ของตัวเองแล้วคืนใน finally เสมอ
function openPool(connectionString) {
  const pg = require('pg');
  const types = { getTypeParser: (oid, format) => PARSERS[oid] || pg.types.getTypeParser(oid, format) };
  const pool = new pg.Pool({ connectionString, types, max: 5 });
  return {
    kind: 'pool',
    query: (c, text, values) => (c.tx || pool).query(text, values),
    exec: (c, sql) => (c.tx || pool).query(sql),
    async tx(c, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await als.run({ scope: c.scope, tx: client }, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function need() {
  if (!backend) throw new Error('ยังไม่ได้เปิดฐานข้อมูล (ต้อง await db.open() ก่อน)');
  return backend;
}

// นับรูปเฉพาะตอนมีคนดู (ทดสอบ) ไม่เปลือง CPU บนเว็บจริง
function countBlobs(scope, rows) {
  for (const row of rows) {
    for (const v of Object.values(row)) if (typeof v === 'string' && v.startsWith('data:')) scope.blobs += 1;
  }
}

async function query(sql, values) {
  const c = ctx();
  c.scope.queries = (c.scope.queries || 0) + 1;
  const r = await need().query(c, toPg(sql), params(values));
  if (watcher && c.scope.blobs !== undefined) countBlobs(c.scope, r.rows);
  return r;
}

const q = {
  // แถวแรก หรือ undefined ถ้าไม่พบ
  get: async (sql, ...p) => (await query(sql, p)).rows[0],
  all: async (sql, ...p) => (await query(sql, p)).rows,
  // เพิ่มแถวแล้วต้องการ id ให้ใช้ q.get('INSERT ... RETURNING id') แทน (ไม่มี lastInsertRowid แล้ว)
  run: async (sql, ...p) => ({ changes: (await query(sql, p)).rowCount }),
  exec: async (sql) => {
    await need().exec(ctx(), sql);
  },
  // รันหลายคำสั่งให้สำเร็จพร้อมกัน ถ้าพังกลางทางย้อนกลับทั้งหมด · ทุก q.* ข้างในเข้า transaction เอง · เรียกซ้อนใช้ชั้นนอก
  // ห้ามใช้ Promise.all หลายคำสั่งข้างใน
  tx(fn) {
    const c = ctx();
    if (c.tx) return Promise.resolve().then(fn);
    c.scope.queries = (c.scope.queries || 0) + 2; // BEGIN และ COMMIT
    return need().tx(c, fn);
  },
};

// เปิดฐานข้อมูล: ':memory:' = PGlite ในหน่วยความจำ (ทดสอบ) · มี DATABASE_URL = Postgres จริง · ไม่มี = PGlite ในโฟลเดอร์ config.PG_DIR
async function open(target) {
  if (backend) return backend;
  if (target === ':memory:') backend = await openPglite(null);
  else if (!target && process.env.DATABASE_URL) backend = openPool(process.env.DATABASE_URL);
  else backend = await openPglite(target || config.PG_DIR);
  await migrate();
  return backend;
}

async function close() {
  const b = backend;
  backend = null;
  GLOBAL.scope = {};
  if (b) await b.close();
}

// โครงตารางและค่าเริ่มต้น ใช้ในเครื่องและตอนทดสอบเท่านั้น เว็บจริงรัน db/schema.sql และ db/seed.sql เองใน Supabase
async function migrate() {
  const dir = path.join(config.ROOT, 'db');
  await q.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  await q.exec(fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8'));
}

// ---------- ข้อมูลอ้างอิงต่อคำขอ ----------
// ค่าตั้ง ขั้นตอนตรวจ แบบประเมิน โหลดครั้งเดียวต่อคำขอ ฟังก์ชันที่ template เรียก (wf.stepOf ฯลฯ) จึงคงเป็นแบบ sync ได้
// รูปโลโก้ไม่อยู่ในค่าตั้ง (ใหญ่หลาย MB) ได้เป็นที่อยู่ /media/logo?v=รุ่น แทน
const SETTINGS_SQL = `SELECT key, CASE
    WHEN key = 'school_logo' THEN CASE WHEN coalesce(value, '') = '' THEN '' ELSE '/media/logo?v=' || substr(md5(value), 1, 8) END
    WHEN key = 'memo_logo' THEN CASE WHEN coalesce(value, '') = '' THEN '' ELSE '/media/memo-logo?v=' || substr(md5(value), 1, 8) END
    ELSE value END AS value
  FROM settings`;

// ทั้ง 3 อย่างในคำสั่งเดียว (ทุกคำขอใช้) Postgres รวมเป็น JSON แล้ว parse ครั้งเดียว ข้อมูลเล็ก ไม่กิน CPU
const REFS_SQL = `SELECT
    (SELECT coalesce(json_agg(json_build_array(s.key, s.value)), '[]') FROM (${SETTINGS_SQL}) s) AS settings,
    (SELECT coalesce(json_agg(w ORDER BY w.seq), '[]') FROM workflow_steps w) AS steps,
    (SELECT coalesce(json_agg(r ORDER BY r.doc_type, r.seq, r.id), '[]') FROM rubric_items r) AS rubrics`;

async function ensureRefs() {
  const scope = ctx().scope;
  if (scope.refs) return scope.refs;
  const r = await q.get(REFS_SQL);
  const settings = {};
  for (const [key, value] of JSON.parse(r.settings)) settings[key] = value;
  scope.refs = { settings, steps: JSON.parse(r.steps), rubrics: JSON.parse(r.rubrics) };
  return scope.refs;
}

// อ่านข้อมูลอ้างอิงแบบ sync (ต้อง await ensureRefs() ที่ทางเข้าก่อน) ไม่มีให้โยน error ชัด ๆ ไม่คืนค่าว่างเงียบ ๆ
function refs() {
  const r = ctx().scope.refs;
  if (!r) throw new Error('ยังไม่ได้โหลดข้อมูลอ้างอิงของคำขอนี้ (ต้อง await db.ensureRefs() ที่ทางเข้าก่อน)');
  return r;
}

// เขียนค่าตั้ง ขั้นตอนตรวจ หรือแบบประเมินแล้วต้องล้าง ให้โหลดใหม่ครั้งถัดไป
function clearRefs() {
  ctx().scope.refs = null;
  if (ctx() !== GLOBAL) GLOBAL.scope.refs = null;
}

async function getSettings() {
  return { ...(await ensureRefs()).settings };
}

async function setSetting(key, value) {
  await q.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
  clearRefs();
}

// รูปโลโก้ตัวจริง (data URL) สำหรับเส้นทาง /media
async function getLogo(key) {
  const r = await q.get('SELECT value FROM settings WHERE key = ?', key);
  return (r && r.value) || '';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// เวลาท้องถิ่นของเครื่อง เก็บเป็น YYYY-MM-DD HH:MM:SS (ตอน 11 เปลี่ยนเป็นเวลาไทยเสมอ)
function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  open,
  close,
  migrate,
  q,
  toPg,
  requestScope,
  withScope,
  watchQueries,
  queryCount,
  QUERY_LIMIT,
  ensureRefs,
  refs,
  clearRefs,
  getSettings,
  setSetting,
  getLogo,
  nowStr,
  DEFAULT_STEPS,
  kind: () => backend && backend.kind,
};
