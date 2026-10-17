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
        this.zoom = Math.min(4, Math.max(0.5, next));
        if (this.doc) this.layout();
      })
    );
    box.addEventListener('pdfbox:open', (e) => this.open(e.detail.url, e.detail.type));
    // ปุ่มอ่านเต็มจอ
    const full = box.querySelector('[data-pdf-full]');
    if (full) {
      const toggle = (on) => {
        box.classList.toggle('is-full', on);
        const label = full.querySelector('[data-full-label]') || full;
        label.textContent = on ? 'ออกจากเต็มจอ' : 'อ่านเต็มจอ';
        setTimeout(() => this.doc && this.layout(), 60);
      };
      full.addEventListener('click', () => toggle(!box.classList.contains('is-full')));
      const exit = box.querySelector('[data-pdf-exit]');
      if (exit) exit.addEventListener('click', () => toggle(false));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && box.classList.contains('is-full')) toggle(false);
      });
    }
    this.pill = box.querySelector('[data-pdf-pagepill]');
    this.setupPinch();
    this.setupScrub();
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
    // หน้าที่มีหลายกรอบ (ลงนามทั้งเล่ม) โหลดไฟล์เมื่อเลื่อนมาใกล้ ไม่โหลดทุกไฟล์พร้อมกัน
    if (box.hasAttribute('data-lazy') && 'IntersectionObserver' in window) {
      const near = new IntersectionObserver(
        (list) => {
          if (!list.some((x) => x.isIntersecting)) return;
          near.disconnect();
          if (!this.doc && !this.task) this.open(this.pages.dataset.src, this.pages.dataset.type);
        },
        { rootMargin: '600px 0px' }
      );
      near.observe(box);
    } else this.open(this.pages.dataset.src, this.pages.dataset.type);
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
    this.seen = new Set();
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
    this.current = n;
    if (this.info && this.doc) this.info.textContent = `หน้า ${n} จาก ${this.doc.numPages}`;
    if (this.pill && this.doc) this.pill.textContent = `หน้า ${n} / ${this.doc.numPages}`;
    if (this.scrubThumb && !this.scrubThumb.parentNode.classList.contains('dragging')) this.scrubThumb.textContent = String(n);
    this.box.classList.toggle('multi', Boolean(this.doc && this.doc.numPages > 1));
  }

  // เต็มจอ: ถ่างหรือหุบสองนิ้วขยายเฉพาะไฟล์ (เบราว์เซอร์ไม่ขยายทั้งหน้าเว็บ ปุ่มกากบาทจึงอยู่ที่เดิม)
  // ระหว่างถ่างย่อขยายภาพเดิมด้วย CSS ปล่อยนิ้วแล้ววาดใหม่ให้คมตามขนาดใหม่ จุดใต้นิ้วยังอยู่ใต้นิ้ว
  setupPinch() {
    const full = () => this.box.classList.contains('is-full') && this.doc;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let start = null;
    // Safari มีเหตุการณ์ gesture ของตัวเอง ต้องห้ามไว้ ไม่งั้นขยายทั้งหน้าเว็บ
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
      this.pages.addEventListener(ev, (e) => {
        if (full()) e.preventDefault();
      })
    );
    this.pages.addEventListener(
      'touchstart',
      (e) => {
        if (!full() || e.touches.length !== 2) return;
        const r = this.pages.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        start = {
          d: dist(e.touches),
          s: 1,
          cx,
          cy,
          fx: (this.pages.scrollLeft + cx) / Math.max(1, this.pages.scrollWidth),
          fy: (this.pages.scrollTop + cy) / Math.max(1, this.pages.scrollHeight),
        };
        this.pages.classList.add('pinching');
      },
      { passive: true }
    );
    this.pages.addEventListener(
      'touchmove',
      (e) => {
        if (!start || e.touches.length !== 2) return;
        e.preventDefault();
        const z = Math.min(4, Math.max(0.5, this.zoom * (dist(e.touches) / start.d)));
        start.s = z / this.zoom;
        this.pages.style.setProperty('--pinch', String(start.s));
      },
      { passive: false }
    );
    const end = async () => {
      if (!start) return;
      const s = start;
      start = null;
      this.pages.classList.remove('pinching');
      this.pages.style.removeProperty('--pinch');
      if (Math.abs(s.s - 1) < 0.04) return;
      this.zoom = Math.min(4, Math.max(0.5, this.zoom * s.s));
      await this.layout();
      this.pages.scrollLeft = s.fx * this.pages.scrollWidth - s.cx;
      this.pages.scrollTop = s.fy * this.pages.scrollHeight - s.cy;
    };
    this.pages.addEventListener('touchend', end);
    this.pages.addEventListener('touchcancel', end);
  }

  // แถบเลื่อนเร็วด้านขวา (เต็มจอ): ปุ่มบอกเลขหน้า ลากขึ้นลงเพื่อข้ามหลายหน้า แตะที่แถบเพื่อกระโดดไปตรงนั้น
  setupScrub() {
    const bar = this.box.querySelector('[data-pdf-scrub]');
    if (!bar) return;
    const thumb = bar.querySelector('[data-scrub-thumb]');
    this.scrubThumb = thumb;
    const max = () => Math.max(1, this.pages.scrollHeight - this.pages.clientHeight);
    const place = (frac) => {
      thumb.style.top = `${Math.min(1, Math.max(0, frac)) * 100}%`;
    };
    const pageAt = (frac) => (this.doc ? 1 + Math.round(Math.min(1, Math.max(0, frac)) * (this.doc.numPages - 1)) : 1);
    this.pages.addEventListener('scroll', () => {
      if (bar.classList.contains('dragging')) return;
      place(this.pages.scrollTop / max());
    });
    const go = (e) => {
      const r = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
      place(frac);
      thumb.textContent = String(pageAt(frac));
      this.pages.scrollTop = frac * max();
    };
    bar.addEventListener('pointerdown', (e) => {
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      go(e);
    });
    bar.addEventListener('pointermove', (e) => {
      if (bar.classList.contains('dragging')) go(e);
    });
    const stop = () => bar.classList.remove('dragging');
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  }

  // เลขหน้าที่แสดง = หน้าบนสุดที่เห็นเกินครึ่ง
  onCount(list) {
    if (!this.seen) this.seen = new Set();
    for (const e of list) {
      if (e.isIntersecting) this.seen.add(Number(e.target.dataset.n));
      else this.seen.delete(Number(e.target.dataset.n));
    }
    if (this.seen.size) this.showPage(Math.min(...this.seen));
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
