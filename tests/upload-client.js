// ตัวช่วยทดสอบ: ส่งไฟล์แบบเดียวกับหน้าเว็บ (public/js/app.js) เริ่มส่ง ได้ token แล้วส่งท่อนละ 5 MB แล้วจึงส่งฟอร์มพร้อม token
// client ต้องมี req(method, url, body, headers) แบบ Client ในชุดทดสอบ
const XHR = { 'x-requested-with': 'XMLHttpRequest' };

// ส่งไฟล์ 1 ไฟล์ คืน token หรือ { error, status } ถ้าระบบไม่รับ · info = form field doc_type subject_code plan_id merged ...
async function uploadOne(client, blob, name, info = {}) {
  const start = await client.req('POST', '/upload/start', new URLSearchParams({ name, size: String(blob.size), ...info }), XHR);
  if (start.status !== 200) return { error: JSON.parse(start.text).error, status: start.status };
  const { token, chunk } = JSON.parse(start.text);
  let pos = 0;
  do {
    const end = Math.min(pos + chunk, blob.size);
    const range = blob.size ? `bytes ${pos}-${end - 1}/${blob.size}` : 'bytes */0';
    const r = await client.req('PUT', '/upload/' + token, blob.slice(pos, end), { ...XHR, 'content-type': 'application/octet-stream', 'content-range': range });
    if (r.status !== 200) return { error: JSON.parse(r.text).error, status: r.status };
    pos = end;
  } while (pos < blob.size);
  return token;
}

// รวม PDF ด้วยโมดูลเดียวกับเบราว์เซอร์
async function mergeLikeBrowser(files) {
  const { mergePdfs } = require('../public/js/pdfmerge');
  const list = [];
  for (const [blob, name] of files) list.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
  const m = await mergePdfs(require('pdf-lib'), list);
  return { blob: new Blob([m.bytes], { type: 'application/pdf' }), pages: m.pages };
}

// ฟอร์มพร้อมไฟล์: fields = ช่องในฟอร์ม · files = [[blob, name], ...] · url = ที่อยู่ฟอร์ม
// opts.field = ชื่อช่องไฟล์ · opts.merge = หลาย PDF รวมก่อนส่งแบบหน้าเว็บ (ช่องที่มี data-sortable)
// คืนค่า { fields: URLSearchParams } หรือ { error } ถ้าส่งไฟล์ไม่ผ่าน
async function formWithFiles(client, url, fields, files = [], opts = {}) {
  const field = opts.field || 'main_files';
  const body = new URLSearchParams(fields);
  const info = { form: url, field, count: String(files.length) };
  for (const k of ['doc_type', 'subject_code', 'subject_name', 'plan_id']) if (fields[k] != null) info[k] = String(fields[k]);
  if (opts.merge && files.length > 1 && files.every(([, n]) => /\.pdf$/i.test(n))) {
    const m = await mergeLikeBrowser(files);
    const token = await uploadOne(client, m.blob, 'merged.pdf', { ...info, count: '1', merged: String(files.length) });
    if (typeof token !== 'string') return token;
    body.append('upload_' + field, token);
    body.set('upload_merged', String(files.length));
    body.set('upload_pages', String(m.pages));
    return { fields: body };
  }
  for (let i = 0; i < files.length; i++) {
    const [blob, name] = files[i];
    const token = await uploadOne(client, blob, name, { ...info, idx: String(i) });
    if (typeof token !== 'string') return token;
    body.append('upload_' + field, token);
  }
  return { fields: body };
}

// ส่งฟอร์มแบบหน้าเว็บ (X-Requested-With ได้ JSON กลับ) · ส่งไฟล์ไม่ผ่านคืน { status, text } แบบเดียวกับคำตอบของฟอร์ม
// opts.headers = หัวคำขอ (ค่าเริ่มต้นแบบหน้าเว็บ ได้ JSON) ส่ง {} เพื่อได้การเปลี่ยนหน้าแบบฟอร์มธรรมดา
async function sendForm(client, url, fields, files, opts = {}) {
  const r = await formWithFiles(client, url, fields, files, opts);
  if (r.error) return { status: r.status, text: JSON.stringify({ error: r.error }) };
  return client.req('POST', url, r.fields, opts.headers || XHR);
}

module.exports = { uploadOne, formWithFiles, sendForm, mergeLikeBrowser, XHR };
