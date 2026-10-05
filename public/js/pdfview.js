// แสดงไฟล์ PDF ในหน้าเว็บด้วย PDF.js (Mozilla) ทุกหน้า เลื่อนดูได้
// ไม่ขึ้นกับการตั้งค่าเบราว์เซอร์ที่สั่งให้ดาวน์โหลด PDF และแก้ปัญหา iPad ที่แสดง PDF ได้แค่หน้าแรก
import * as pdfjs from '/vendor/pdfjs/legacy/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
const OPTS = {
  cMapUrl: '/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  wasmUrl: '/vendor/pdfjs/wasm/',
  iccUrl: '/vendor/pdfjs/iccs/',
};

class Viewer {
  constructor(box) {
    this.box = box;
    this.pages = box.querySelector('[data-pdf-pages]');
    this.info = box.querySelector('[data-pdf-info]');
    this.zoom = 1;
    this.doc = null;
    this.task = null;
    this.token = 0;
    this.observer = new IntersectionObserver((list) => this.onSeen(list), { root: this.pages, rootMargin: '800px 0px' });
    this.counter = new IntersectionObserver((list) => this.onCount(list), { root: this.pages, threshold: 0.5 });
    box.querySelectorAll('[data-pdf-zoom]').forEach((b) =>
      b.addEventListener('click', () => {
        const next = b.dataset.pdfZoom === 'in' ? this.zoom * 1.25 : this.zoom / 1.25;
        this.zoom = Math.min(3, Math.max(0.5, next));
        if (this.doc) this.layout();
      })
    );
    box.addEventListener('pdfbox:open', (e) => this.open(e.detail.url, e.detail.type));
    // ปุ่มอ่านเต็มจอ
    const full = box.querySelector('[data-pdf-full]');
    if (full) {
      const toggle = (on) => {
        box.classList.toggle('is-full', on);
        full.textContent = on ? 'ออกจากเต็มจอ' : 'เต็มจอ';
        setTimeout(() => this.doc && this.layout(), 60);
      };
      full.addEventListener('click', () => toggle(!box.classList.contains('is-full')));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && box.classList.contains('is-full')) toggle(false);
      });
    }
    let last = this.pages.clientWidth;
    window.addEventListener('resize', () => {
      clearTimeout(this.rt);
      this.rt = setTimeout(() => {
        if (this.doc && Math.abs(this.pages.clientWidth - last) > 40) {
          last = this.pages.clientWidth;
          this.layout();
        }
      }, 250);
    });
    this.open(this.pages.dataset.src, this.pages.dataset.type);
  }

  message(text) {
    this.pages.innerHTML = '';
    const m = document.createElement('div');
    m.className = 'pdf-msg';
    m.textContent = text;
    this.pages.appendChild(m);
    if (this.info) this.info.textContent = '';
  }

  async open(url, type) {
    const token = ++this.token;
    this.zoom = 1;
    if (this.task) this.task.destroy();
    this.doc = null;
    if (!url) return this.message('ไม่มีไฟล์ให้แสดง');
    if (type === 'image') {
      this.pages.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'pdf-img';
      img.alt = 'ไฟล์รูปที่ส่ง';
      img.src = url;
      this.pages.appendChild(img);
      if (this.info) this.info.textContent = 'รูปภาพ';
      return;
    }
    this.message('กำลังเปิดไฟล์');
    try {
      // ขอไฟล์ทาง /raw ซึ่งไม่บอกชื่อไฟล์ .pdf โปรแกรมช่วยดาวน์โหลดจึงไม่ดักไป
      const res = await fetch(`${url}/raw`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('load');
      const data = new Uint8Array(await res.arrayBuffer());
      if (token !== this.token) return;
      this.task = pdfjs.getDocument({ data, ...OPTS });
      const doc = await this.task.promise;
      if (token !== this.token) return;
      this.doc = doc;
      await this.layout();
    } catch {
      if (token === this.token) this.message('เปิดไฟล์นี้ในหน้าเว็บไม่ได้ กดปุ่มดาวน์โหลดเพื่อเปิดในเครื่องแทน');
    }
  }

  async layout() {
    const doc = this.doc;
    const token = this.token;
    this.observer.disconnect();
    this.counter.disconnect();
    const keep = this.pages.scrollTop / Math.max(1, this.pages.scrollHeight);
    this.pages.innerHTML = '';
    const width = Math.max(240, this.pages.clientWidth - 24);
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (token !== this.token || doc !== this.doc) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / base.width) * this.zoom });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.style.width = `${Math.floor(vp.width)}px`;
      wrap.style.height = `${Math.floor(vp.height)}px`;
      wrap.dataset.n = String(n);
      wrap.pdf = { page, vp };
      this.pages.appendChild(wrap);
      this.observer.observe(wrap);
      this.counter.observe(wrap);
    }
    this.pages.scrollTop = keep * this.pages.scrollHeight;
    this.showPage(1);
  }

  showPage(n) {
    if (this.info && this.doc) this.info.textContent = `หน้า ${n} จาก ${this.doc.numPages}`;
  }

  onCount(list) {
    for (const e of list) if (e.isIntersecting) this.showPage(Number(e.target.dataset.n));
  }

  onSeen(list) {
    for (const e of list) {
      if (!e.isIntersecting || e.target.dataset.done) continue;
      e.target.dataset.done = '1';
      const { page, vp } = e.target.pdf;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      e.target.appendChild(canvas);
      page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise.catch(() => {});
    }
  }
}

document.querySelectorAll('[data-pdfbox]').forEach((box) => new Viewer(box));
