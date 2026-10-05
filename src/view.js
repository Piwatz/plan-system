// ตัว render หน้าเว็บของ Express ที่ใช้ template ซึ่ง compile ไว้แล้วใน dist/views.js (สร้างด้วย npm run build)
// ใช้ทั้งบน Node และ Cloudflare Workers ห้าม require ejs หรืออ่านไฟล์จากดิสก์ในไฟล์นี้
const views = require('../dist/views');

// ก๊อปจาก ejs 6.0.1 utils.escapeXML
const ENCODE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
const MATCH = /[&<>'"]/g;
function escapeXML(markup) {
  return markup == undefined ? '' : String(markup).replace(MATCH, (c) => ENCODE[c] || c);
}

function rethrow(err) {
  throw err;
}

// ก๊อปจาก ejs 6.0.1 utils.shallowCopy
function shallowCopy(to, from) {
  from = from || {};
  for (const p in from) {
    if (!Object.prototype.hasOwnProperty.call(from, p)) continue;
    if (p === '__proto__' || p === 'constructor') continue;
    to[p] = from[p];
  }
  return to;
}

// ชื่อ template แบบเดียวกับที่ EJS หาไฟล์: include เทียบกับไฟล์ที่เรียก และเติม .ejs
function resolveName(from, p) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of String(p).replace(/\.ejs$/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function renderTemplate(name, data) {
  const fn = views[name];
  if (!fn) throw new Error(`ไม่พบหน้าเว็บ views/${name}.ejs (ลืมรัน npm run build หรือไม่)`);
  // เหมือน EJS: include ได้สำเนาตื้นของ data เดิม ทับด้วย data ใหม่
  const include = (p, includeData) => {
    let d = shallowCopy(Object.create(null), data);
    if (includeData) d = shallowCopy(d, includeData);
    return renderTemplate(resolveName(name, p), d);
  };
  return fn(shallowCopy(Object.create(null), data), escapeXML, include, rethrow);
}

// ช่องสำหรับชุดทดสอบ: render ซ้ำด้วย EJS ปกติแล้วเทียบผลทุกไบต์ (tests/verify-views.js)
let verifier = null;

// คลาส View แบบที่ Express 5 ต้องการ (app.set('view', CompiledView)) ไม่หาไฟล์ในดิสก์
class CompiledView {
  constructor(name) {
    this.name = name;
    const key = String(name).replace(/^\/+/, '').replace(/\.ejs$/, '');
    this.path = views[key] ? key : undefined;
  }

  render(options, callback) {
    let html;
    try {
      html = renderTemplate(this.path, options);
      if (verifier) verifier(this.path, options, html);
    } catch (err) {
      return callback(err);
    }
    callback(null, html);
  }
}

module.exports = { CompiledView, renderTemplate, escapeXML, setVerifier: (fn) => (verifier = fn) };
