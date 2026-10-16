// หน้าพิมพ์บันทึกหลังแผน: วาดแผ่น PDF ของครูเป็นภาพในเครื่องที่เปิด (ฟังก์ชันเสริม notesign) ไม่ทำบนเซิร์ฟเวอร์
// ทุกหน้าของไฟล์เป็นภาพ หน้าสุดท้ายอยู่ในแผ่นที่มีแถบลงนาม หน้าก่อนหน้าแทรกเป็นแผ่นเต็มไว้ข้างหน้า
// วาดทีละแผ่นต่อกัน ไม่พร้อมกัน กันหน่วยความจำเต็มบน iPad และ Safari · ปุ่มพิมพ์รอจนวาดครบ
import * as pdfjs from '/vendor/pdfjs/legacy/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
const OPTS = {
  cMapUrl: '/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  wasmUrl: '/vendor/pdfjs/wasm/',
  iccUrl: '/vendor/pdfjs/iccs/',
};
// ความกว้างภาพราว 1400 จุด พิมพ์ได้คมราว 200 dpi บน A4
const WIDTH = 1400;

const sheets = [...document.querySelectorAll('[data-pdf-sheet]')];
const printBtn = document.querySelector('.toolbar button');
const label = printBtn ? printBtn.textContent : '';

function busy(done, total) {
  if (!printBtn) return;
  const on = done < total;
  printBtn.disabled = on;
  printBtn.style.opacity = on ? '0.6' : '';
  printBtn.textContent = on ? `กำลังเตรียมแผ่นของครู ${done}/${total}` : label;
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function pageImg(page) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, WIDTH / base.width) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  canvas.width = 0;
  canvas.height = 0;
  return loadImg(URL.createObjectURL(blob));
}

async function images(file) {
  if (file.type === 'image') return [await loadImg(file.url)];
  const res = await fetch(`${file.url}/raw`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('load');
  const task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), ...OPTS });
  const doc = await task.promise;
  const out = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) out.push(await pageImg(await doc.getPage(n)));
  } finally {
    task.destroy();
  }
  return out;
}

async function draw(sheet) {
  const slot = sheet.querySelector('.pdf-slot');
  const imgs = [];
  try {
    for (const f of JSON.parse(sheet.dataset.files || '[]')) imgs.push(...(await images(f)));
  } catch {
    imgs.length = 0;
  }
  if (!imgs.length) {
    slot.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'pdf-wait';
    msg.textContent = `เปิดไฟล์ของครู ${sheet.dataset.name || ''} ไม่ได้ ลองเปิดหน้านี้ใหม่`;
    slot.appendChild(msg);
    return;
  }
  imgs.forEach((img, i) => (img.alt = `แผ่นของครู ${sheet.dataset.name || ''} หน้า ${i + 1}`));
  // หน้าก่อนหน้าสุดท้าย เป็นแผ่นเต็มแทรกไว้ข้างหน้า
  for (const img of imgs.slice(0, -1)) {
    const paper = document.createElement('div');
    paper.className = 'paper note-pdf';
    const s = document.createElement('div');
    s.className = 'pdf-slot';
    s.appendChild(img);
    paper.appendChild(s);
    sheet.before(paper);
  }
  slot.innerHTML = '';
  slot.appendChild(imgs[imgs.length - 1]);
}

(async () => {
  busy(0, sheets.length);
  for (let i = 0; i < sheets.length; i++) {
    await draw(sheets[i]);
    busy(i + 1, sheets.length);
  }
})();
