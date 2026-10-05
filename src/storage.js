// ที่เก็บไฟล์งาน 2 แบบ หน้าตาเดียวกัน
//   local  = โฟลเดอร์ในเครื่อง (config.FILES_DIR) ใช้ทดสอบ โหมดทดลอง และพัฒนา
//   gdrive = Google Drive ของโรงเรียน (OAuth สิทธิ์ drive.file เห็นเฉพาะไฟล์ที่ระบบสร้าง) ใช้บนเว็บจริง
// ไฟล์ที่เก็บแล้วอ้างถึงด้วยข้อความ "gdrive:<fileId>" หรือ "local:<ตำแหน่งในโฟลเดอร์>" (คอลัมน์ files.stored_name)
// ไฟล์ใหญ่ส่งเป็นท่อน: startUpload ได้ session (เก็บในฐาน ไม่ส่งให้เบราว์เซอร์) แล้ว putChunk ทีละท่อนแบบสตรีม ไม่เก็บทั้งไฟล์ในหน่วยความจำ
// ลบไฟล์ = ย้ายไปถังขยะเสมอ (Drive กู้คืนได้ 30 วัน · ในเครื่องอยู่ในโฟลเดอร์ .trash) ไม่ลบถาวร
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { safeName } = require('./drivepath');
const { nowStr } = require('./time');

// โฟลเดอร์หลักใน Drive ทุกอย่างของระบบอยู่ใต้โฟลเดอร์นี้
const ROOT_FOLDER = 'ระบบส่งแผนการสอน';
// ท่อนละ 5 MiB (ทวีคูณของ 256 KiB ตามที่ Drive กำหนด)
const CHUNK = 5 * 1024 * 1024;
const CHUNK_UNIT = 256 * 1024;

class StorageError extends Error {}

// "bytes=0-7" เป็น { start, end } (ช่วงเดียว) ใช้ไม่ได้ได้ null
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

// ---------- แบบ local ----------
function localBackend(root = config.FILES_DIR) {
  const abs = (rel) => {
    const p = path.resolve(root, rel);
    if (!p.startsWith(path.resolve(root) + path.sep)) throw new StorageError('bad path');
    return p;
  };
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const folderOf = (folderPath) => String(folderPath || '').split('/').map((s) => safeName(s, '_'));

  return {
    kind: 'local',
    async startUpload({ name, folderPath }) {
      const id = crypto.randomBytes(12).toString('hex');
      const dir = path.join(root, '.incoming');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '.part'), '');
      const target = [...folderOf(folderPath), `${id.slice(0, 8)} ${safeName(name, 'file')}`].join('/');
      return JSON.stringify({ part: `.incoming/${id}.part`, target });
    },
    // ส่งท่อน start ถึง end (รวม end) ของไฟล์ขนาด total · ท่อนต้องต่อจากที่มีอยู่พอดี
    async putChunk(session, stream, { start, end, total }) {
      const s = JSON.parse(session);
      const part = abs(s.part);
      const have = fs.statSync(part).size;
      if (have !== start) throw new StorageError(`ท่อนไม่ต่อเนื่อง มี ${have} ได้ ${start}`);
      const want = total === 0 ? 0 : end - start + 1;
      let got = 0;
      const counter = async function* (src) {
        for await (const c of src) {
          got += c.length;
          if (got > want) throw new StorageError('ท่อนยาวเกินที่แจ้ง');
          yield c;
        }
      };
      try {
        await pipeline(stream, counter, fs.createWriteStream(part, { flags: 'a' }));
        if (got !== want) throw new StorageError(`ท่อนไม่ครบ ได้ ${got} จาก ${want}`);
      } catch (e) {
        fs.truncateSync(part, have);
        throw e;
      }
      if (start + want < total) return { done: false, received: start + want };
      const dest = abs(s.target);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(part, dest);
      return { done: true, received: total, ref: 'local:' + s.target };
    },
    // เลิกส่งกลางทาง (ไฟล์ที่ยังไม่ครบ) ลบไฟล์ชั่วคราวได้ เพราะยังไม่ใช่งานของใคร
    async abort(session) {
      try {
        fs.unlinkSync(abs(JSON.parse(session).part));
      } catch {
        // ไม่มีไฟล์แล้ว
      }
    },
    async get(ref, { range } = {}) {
      const p = abs(ref);
      const size = fs.statSync(p).size;
      const r = range ? parseRange(range, size) : null;
      if (r) return { status: 206, size, length: r.end - r.start + 1, contentRange: `bytes ${r.start}-${r.end}/${size}`, stream: fs.createReadStream(p, r) };
      return { status: 200, size, length: size, stream: fs.createReadStream(p) };
    },
    async head(ref) {
      const p = abs(ref);
      return { name: path.basename(p), size: fs.statSync(p).size };
    },
    async trash(ref) {
      const p = abs(ref);
      const dir = path.join(root, '.trash');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = nowStr().replace(/\D/g, '');
      fs.renameSync(p, path.join(dir, `${stamp}-${crypto.randomBytes(3).toString('hex')}-${path.basename(p)}`));
    },
    // ไฟล์เล็ก (สำรองข้อมูล) เขียนครั้งเดียว
    async putFile(folderPath, name, mime, body) {
      const target = [...folderOf(folderPath), safeName(name, 'file')].join('/');
      fs.mkdirSync(path.dirname(abs(target)), { recursive: true });
      fs.writeFileSync(abs(target), body);
      return 'local:' + target;
    },
    // ไฟล์ในโฟลเดอร์ ใหม่สุดก่อน
    async list(folderPath) {
      const dir = abs(folderOf(folderPath).join('/'));
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => {
          const p = path.join(dir, d.name);
          return { ref: 'local:' + rel(p), name: d.name, time: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
    },
  };
}

// ---------- แบบ Google Drive ----------
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// base = ที่อยู่ของ Google (ทดสอบส่งที่อยู่ของ Drive จำลองในเครื่อง)
function gdriveBackend(env = process.env, { oauth = 'https://oauth2.googleapis.com', base = 'https://www.googleapis.com' } = {}) {
  const { q } = require('./db');
  const OAUTH_URL = oauth + '/token';
  const API = base + '/drive/v3/files';
  const UPLOAD_API = base + '/upload/drive/v3/files';
  let cached = null; // { token, until } จำไว้ในหน่วยความจำจนใกล้หมดอายุ

  async function accessToken() {
    if (cached && Date.now() < cached.until) return cached.token;
    if (!env.GDRIVE_CLIENT_ID || !env.GDRIVE_CLIENT_SECRET || !env.GDRIVE_REFRESH_TOKEN) {
      throw new StorageError('ยังไม่ได้ตั้งค่า GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET GDRIVE_REFRESH_TOKEN');
    }
    const r = await fetch(OAUTH_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.GDRIVE_CLIENT_ID,
        client_secret: env.GDRIVE_CLIENT_SECRET,
        refresh_token: env.GDRIVE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new StorageError(`ขอสิทธิ์ Google Drive ไม่สำเร็จ (${r.status} ${j.error || ''})`);
    cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120 * 1000 };
    return cached.token;
  }

  async function api(url, init = {}) {
    const headers = { authorization: 'Bearer ' + (await accessToken()), ...(init.headers || {}) };
    const r = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(60000) });
    if (!r.ok && r.status !== 206 && r.status !== 308) {
      const text = await r.text().catch(() => '');
      const err = new StorageError(`Google Drive ตอบ ${r.status} ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  }

  const idOf = (ref) => {
    if (!/^[\w-]+$/.test(ref)) throw new StorageError('bad id');
    return ref;
  };

  // หาโฟลเดอร์ชื่อนี้ใต้ parent (ค้นใน Drive) ไม่มีก็สร้าง
  async function findOrCreate(name, parent) {
    const qs = [`name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false', `'${parent || 'root'}' in parents`];
    const found = await (await api(`${API}?${new URLSearchParams({ q: qs.join(' and '), fields: 'files(id)', pageSize: '1' })}`)).json();
    if (found.files && found.files[0]) return found.files[0].id;
    const body = { name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) };
    const made = await (await api(`${API}?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    return made.id;
  }

  // id ของโฟลเดอร์ตามตำแหน่ง (ใต้โฟลเดอร์หลัก) สร้างเมื่อยังไม่มี จำไว้ในตาราง drive_folders
  async function folderId(folderPath) {
    const parts = [ROOT_FOLDER, ...String(folderPath || '').split('/').filter(Boolean).map((s) => safeName(s, '_'))];
    const keys = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    const known = new Map((await q.all('SELECT path, folder_id FROM drive_folders WHERE path = ANY(?)', keys)).map((r) => [r.path, r.folder_id]));
    let parent = null;
    for (let i = 0; i < keys.length; i++) {
      let id = known.get(keys[i]);
      if (!id) {
        id = await findOrCreate(parts[i], parent);
        // สองคำขอสร้างพร้อมกัน ใช้ของที่บันทึกก่อน (คำสั่งเดียว: เพิ่มได้ใช้ของใหม่ ซ้ำใช้ของเดิม)
        const row = await q.get(
          `WITH ins AS (INSERT INTO drive_folders (path, folder_id) VALUES (?, ?) ON CONFLICT (path) DO NOTHING RETURNING folder_id)
           SELECT folder_id FROM ins UNION ALL SELECT folder_id FROM drive_folders WHERE path = ? LIMIT 1`,
          keys[i],
          id,
          keys[i]
        );
        id = row ? row.folder_id : id;
      }
      parent = id;
    }
    return parent;
  }

  // โฟลเดอร์ที่จำไว้ถูกลบใน Drive: ลืมแล้วลองใหม่ครั้งเดียว
  async function withFolder(folderPath, fn) {
    try {
      return await fn(await folderId(folderPath));
    } catch (e) {
      if (e.status !== 404) throw e;
      await q.run("DELETE FROM drive_folders WHERE path = ? OR path LIKE ? || '/%'", ROOT_FOLDER, ROOT_FOLDER);
      return fn(await folderId(folderPath));
    }
  }

  return {
    kind: 'gdrive',
    folderId,
    async startUpload({ name, mime, size, folderPath }) {
      return withFolder(folderPath, async (parent) => {
        const r = await api(`${UPLOAD_API}?uploadType=resumable&fields=id`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': mime || 'application/octet-stream',
            'x-upload-content-length': String(size),
          },
          body: JSON.stringify({ name: safeName(name, 'file'), parents: [parent], mimeType: mime || 'application/octet-stream' }),
        });
        const uri = r.headers.get('location');
        if (!uri) throw new StorageError('Google Drive ไม่ส่งที่อยู่สำหรับอัปโหลด');
        return uri;
      });
    },
    // ส่งต่อท่อนจากเบราว์เซอร์เข้า Drive ทันทีแบบสตรีม · ท่อนสุดท้าย Drive ตอบ id ของไฟล์
    async putChunk(session, stream, { start, end, total }) {
      const length = total === 0 ? 0 : end - start + 1;
      const r = await fetch(session, {
        method: 'PUT',
        headers: { 'content-length': String(length), 'content-range': total === 0 ? 'bytes */0' : `bytes ${start}-${end}/${total}` },
        body: length ? Readable.toWeb(stream) : null,
        duplex: 'half',
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (r.status === 308) {
        await r.arrayBuffer().catch(() => {});
        const m = /bytes=0-(\d+)/.exec(r.headers.get('range') || '');
        const received = m ? Number(m[1]) + 1 : 0;
        if (received !== start + length) throw new StorageError(`Drive ได้รับ ${received} ไบต์ ไม่ตรงกับที่ส่ง ${start + length}`);
        return { done: false, received };
      }
      if (r.ok) {
        const j = await r.json();
        return { done: true, received: total, ref: 'gdrive:' + j.id };
      }
      throw new StorageError(`Google Drive ตอบ ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    },
    async abort(session) {
      await fetch(session, { method: 'DELETE', signal: AbortSignal.timeout(15000) }).catch(() => {});
    },
    async get(ref, { range } = {}) {
      const r = await api(`${API}/${idOf(ref)}?alt=media`, { headers: range ? { range } : {} });
      const length = Number(r.headers.get('content-length')) || 0;
      const contentRange = r.headers.get('content-range') || undefined;
      const size = contentRange ? Number(contentRange.split('/')[1]) || length : length;
      return { status: r.status === 206 ? 206 : 200, size, length, contentRange, stream: Readable.fromWeb(r.body) };
    },
    async head(ref) {
      const j = await (await api(`${API}/${idOf(ref)}?fields=name,size,mimeType`)).json();
      return { name: j.name, size: Number(j.size) || 0, mime: j.mimeType };
    },
    async trash(ref) {
      await api(`${API}/${idOf(ref)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    },
    async putFile(folderPath, name, mime, body) {
      return withFolder(folderPath, async (parent) => {
        const boundary = 'b' + crypto.randomBytes(12).toString('hex');
        const meta = JSON.stringify({ name: safeName(name, 'file'), parents: [parent], mimeType: mime });
        const data = Buffer.concat([
          Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`),
          Buffer.from(body),
          Buffer.from(`\r\n--${boundary}--`),
        ]);
        const j = await (await api(`${UPLOAD_API}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: data })).json();
        return 'gdrive:' + j.id;
      });
    },
    async list(folderPath) {
      const parent = await folderId(folderPath);
      const qs = `'${parent}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
      const j = await (await api(`${API}?${new URLSearchParams({ q: qs, orderBy: 'createdTime desc', fields: 'files(id,name,createdTime)', pageSize: '200' })}`)).json();
      return (j.files || []).map((f) => ({ ref: 'gdrive:' + f.id, name: f.name, time: Date.parse(f.createdTime) || 0 }));
    },
  };
}

// ---------- ตัวเลือกที่เก็บ ----------
/** @type {any} */
let local = null;
/** @type {any} */
let gdrive = null;

function backendFor(kind) {
  if (kind === 'gdrive') return (gdrive = gdrive || gdriveBackend());
  return (local = local || localBackend());
}

// ที่เก็บสำหรับไฟล์ใหม่ (ตามค่าตั้ง FILE_STORE)
function current() {
  return backendFor(config.FILE_STORE);
}

// แยก "gdrive:<id>" เป็นที่เก็บกับตำแหน่ง · ข้อมูลเก่าที่ไม่มีคำนำหน้าถือเป็นไฟล์ในเครื่อง
function resolve(stored) {
  const s = String(stored || '');
  const i = s.indexOf(':');
  const kind = i > 0 ? s.slice(0, i) : 'local';
  if (kind !== 'local' && kind !== 'gdrive') throw new StorageError('unknown store');
  return { backend: backendFor(kind), ref: i > 0 ? s.slice(i + 1) : s };
}

// อ่าน n ไบต์แรกของไฟล์ (ตรวจชนิดไฟล์) ใช้ header Range ไม่ดึงทั้งไฟล์
async function readHead(stored, n) {
  const { backend, ref } = resolve(stored);
  const r = await backend.get(ref, { range: `bytes=0-${n - 1}` });
  const parts = [];
  let got = 0;
  for await (const c of r.stream) {
    parts.push(c);
    got += c.length;
    if (got >= n) break;
  }
  r.stream.destroy();
  return Buffer.concat(parts).subarray(0, n);
}

const api = {
  get: (stored, opts) => resolve(stored).backend.get(resolve(stored).ref, opts),
  head: (stored) => resolve(stored).backend.head(resolve(stored).ref),
  trash: (stored) => resolve(stored).backend.trash(resolve(stored).ref),
};

// ทดสอบใช้สลับที่เก็บ (เช่น local ในโฟลเดอร์ชั่วคราว) · ส่ง null คืนค่าเดิม
function _set(kind, backend) {
  if (kind === 'gdrive') gdrive = backend;
  else local = backend;
}

module.exports = { ROOT_FOLDER, CHUNK, CHUNK_UNIT, StorageError, current, resolve, readHead, parseRange, localBackend, gdriveBackend, backendFor, _set, ...api };
