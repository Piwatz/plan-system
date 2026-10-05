// ไฟล์ static ทั้งหมดของระบบ ที่อยู่บนเว็บ (url) กับโฟลเดอร์ต้นทาง (dir จากโฟลเดอร์โปรเจกต์) และอายุ cache
// ใช้ 2 ที่: src/app.js (express.static บน Node) และ scripts/build-assets.js (คัดลอกไป dist/assets สำหรับ Workers)
const STATIC_MOUNTS = [
  { url: '/static', dir: 'public', maxAge: 0 },
  { url: '/vendor/chart.js', dir: 'node_modules/chart.js/dist', maxAge: '7d' },
  { url: '/vendor/kanit', dir: 'node_modules/@fontsource/kanit', maxAge: '30d' },
  { url: '/vendor/sarabun', dir: 'node_modules/@fontsource/sarabun', maxAge: '30d' },
  { url: '/vendor/fonts', dir: 'node_modules/@fontsource', maxAge: '30d', index: false },
  // ตัวแสดงไฟล์ PDF ในหน้าเว็บ (PDF.js) ใช้แทนการให้เบราว์เซอร์เปิดไฟล์เอง
  ...['legacy/build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].map((d) => ({ url: `/vendor/pdfjs/${d}`, dir: `node_modules/pdfjs-dist/${d}`, maxAge: '7d', index: false })),
  // ตัวรวม PDF ในเบราว์เซอร์ (pdf-lib) ใช้ตอนครูแนบหลายไฟล์
  { url: '/vendor/pdf-lib', dir: 'node_modules/pdf-lib/dist', maxAge: '7d', index: false },
];

module.exports = { STATIC_MOUNTS };
