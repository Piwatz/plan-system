// ตัว render template ที่ compile แล้ว ใช้ได้ทั้ง Node และ Workers (ไม่มี ejs ไม่มี new Function)
import { views } from './dist/views.mjs';

// ก๊อปจาก utils.escapeXML ของ ejs 6.0.1
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
function escapeXML(s) {
  return s == undefined ? '' : String(s).replace(/[&<>'"]/g, (c) => ESC[c]);
}
function rethrow(err) {
  throw err;
}
function resolve(from, p) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of p.replace(/\.ejs$/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function render(name, data) {
  const fn = views[name];
  if (!fn) throw new Error('ไม่พบ template ' + name);
  // เหมือน ejs: include ได้สำเนาตื้นของ data เดิม ทับด้วย data ใหม่
  const include = (p, includeData) => render(resolve(name, p), Object.assign(Object.create(null), data, includeData || {}));
  return fn(Object.assign(Object.create(null), data), escapeXML, include, rethrow);
}
