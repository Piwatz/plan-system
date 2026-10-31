// รวมไฟล์ PDF หลายไฟล์ (เช่น ปกกับเนื้อหา) เป็นไฟล์เดียว เรียงตามลำดับที่ครูจัดไว้ ทำในเบราว์เซอร์ของครูก่อนส่ง
// (เซิร์ฟเวอร์บนคลาวด์มีเวลาประมวลผลน้อย จึงไม่รวมไฟล์ที่เซิร์ฟเวอร์) ใช้ pdf-lib ตัวเดียวกันทั้งเบราว์เซอร์และ Node (ทดสอบ)
// เบราว์เซอร์: window.PdfMerge.mergePdfs(window.PDFLib, files) · Node: require('./public/js/pdfmerge').mergePdfs(require('pdf-lib'), files)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class PdfError extends Error {
    constructor(msg) {
      super(msg);
      this.userMessage = msg;
    }
  }

  // files: [{ name, bytes }] (bytes = Uint8Array หรือ ArrayBuffer) คืนค่า { bytes, pages }
  async function mergePdfs(PDFLib, files) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (const f of files) {
      const broken = new PdfError('ไฟล์ ' + f.name + ' เปิดไม่ได้ จึงรวมไม่ได้ ลองบันทึกเป็น PDF ใหม่แล้วแนบอีกครั้ง');
      let src;
      try {
        src = await PDFDocument.load(f.bytes, { ignoreEncryption: true, updateMetadata: false });
      } catch {
        throw broken;
      }
      if (src.isEncrypted) throw new PdfError('ไฟล์ ' + f.name + ' ตั้งรหัสผ่านไว้ จึงรวมไม่ได้ ให้บันทึกเป็น PDF ใหม่โดยไม่ใส่รหัสผ่าน');
      let pages;
      try {
        // ไฟล์เสียบางแบบเปิดผ่าน แต่ไม่มีหน้าให้คัดลอก
        pages = await out.copyPages(src, src.getPageIndices());
      } catch {
        throw broken;
      }
      for (const p of pages) out.addPage(p);
    }
    return { bytes: await out.save(), pages: out.getPageCount() };
  }

  // เปลี่ยนปก (ฟังก์ชันเสริม coverpdf): ลบหน้าที่ติ๊ก (remove = เลขหน้าเริ่มที่ 1) แล้วต่อปกใหม่ไว้หน้าแรก
  // coverPng = รูปปกที่ระบบวาด (เต็มหน้า A4) · coverPdf = ไฟล์ปกที่เลือกเอง · แก้ในไฟล์เดิม ที่คั่นหน้าและข้อมูลไฟล์ยังอยู่
  const A4 = [595.28, 841.89];
  async function editFront(PDFLib, bytes, opts) {
    const { PDFDocument } = PDFLib;
    const o = opts || {};
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw new PdfError('เปิดไฟล์เดิมไม่ได้ จึงเปลี่ยนปกไม่ได้');
    }
    if (doc.isEncrypted) throw new PdfError('ไฟล์เดิมตั้งรหัสผ่านไว้ จึงเปลี่ยนปกไม่ได้');
    const total = doc.getPageCount();
    const remove = [...new Set(o.remove || [])].filter((n) => n >= 1 && n <= total).sort((a, b) => b - a);
    if (remove.length >= total && !o.coverPng && !o.coverPdf) throw new PdfError('ลบทุกหน้าไม่ได้ ต้องเหลืออย่างน้อย 1 หน้า');
    for (const n of remove) doc.removePage(n - 1);
    let added = 0;
    if (o.coverPdf) {
      let src;
      try {
        src = await PDFDocument.load(o.coverPdf, { ignoreEncryption: true, updateMetadata: false });
      } catch {
        throw new PdfError('ไฟล์ปกเปิดไม่ได้ ลองบันทึกเป็น PDF ใหม่แล้วเลือกอีกครั้ง');
      }
      if (src.isEncrypted) throw new PdfError('ไฟล์ปกตั้งรหัสผ่านไว้ ให้บันทึกเป็น PDF ใหม่โดยไม่ใส่รหัสผ่าน');
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p, i) => doc.insertPage(i, p));
      added = pages.length;
    } else if (o.coverPng) {
      const img = await doc.embedPng(o.coverPng);
      const page = doc.insertPage(0, A4);
      page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
      added = 1;
    }
    return { bytes: await doc.save(), pages: doc.getPageCount(), removed: remove.length, added };
  }

  // ตัดหน้าไฟล์ (ฟังก์ชันเสริม cutpages): คัดลอกเฉพาะหน้าที่เหลือลงไฟล์ใหม่ หน้าที่ลบจึงหายจากไฟล์จริง ไฟล์เล็กลง (ที่คั่นหน้าไม่ตามมา ไฟล์เดิมเก็บไว้เป็นรุ่นก่อน)
  async function cutPages(PDFLib, bytes, remove) {
    const { PDFDocument } = PDFLib;
    const broken = new PdfError('เปิดไฟล์เดิมไม่ได้ จึงตัดหน้าไม่ได้');
    let src;
    try {
      src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw broken;
    }
    if (src.isEncrypted) throw new PdfError('ไฟล์เดิมตั้งรหัสผ่านไว้ จึงตัดหน้าไม่ได้');
    const del = new Set(remove);
    const keep = src.getPageIndices().filter((i) => !del.has(i + 1));
    if (!keep.length) throw new PdfError('ลบทุกหน้าไม่ได้ ต้องเหลืออย่างน้อย 1 หน้า');
    const out = await PDFDocument.create();
    let pages;
    try {
      pages = await out.copyPages(src, keep);
    } catch {
      throw broken;
    }
    for (const p of pages) out.addPage(p);
    return { bytes: await out.save(), pages: out.getPageCount(), removed: src.getPageCount() - keep.length };
  }

  // ลำดับหน้าใหม่ของการย้ายหน้า (ฟังก์ชันเสริม movepages) pages = หน้าที่ย้าย · after = วางหลังหน้านี้ (เลขหน้าเดิม) 0 = เป็นหน้าแรก คืนค่า { order, error }
  function moveOrder(total, pages, after) {
    const moving = [...new Set(pages)].sort((a, b) => a - b);
    const set = new Set(moving);
    if (!moving.length) return { order: [], error: 'ยังไม่ได้เลือกหน้าที่จะย้าย' };
    if (moving.length >= total) return { order: [], error: 'ย้ายทุกหน้าไม่ได้ ต้องเหลือหน้าอื่นอย่างน้อย 1 หน้า' };
    if (!Number.isInteger(after) || after < 0 || after > total) return { order: [], error: 'ไฟล์นี้มี ' + total + ' หน้า พิมพ์เลขหน้าปลายทางใหม่' };
    if (set.has(after)) return { order: [], error: 'หน้าปลายทางต้องไม่ใช่หน้าที่กำลังย้าย' };
    const rest = [];
    for (let n = 1; n <= total; n++) if (!set.has(n)) rest.push(n);
    const at = after === 0 ? 0 : rest.indexOf(after) + 1;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (order.every((n, i) => n === i + 1)) return { order: [], error: 'ลำดับหน้าเหมือนเดิม เลือกปลายทางใหม่' };
    return { order, error: '' };
  }

  // ย้ายหน้า: คัดลอกทุกหน้าลงไฟล์ใหม่ตามลำดับ order (ที่คั่นหน้าไม่ตามมา ไฟล์เดิมเก็บไว้เป็นรุ่นก่อน)
  async function movePages(PDFLib, bytes, order) {
    const { PDFDocument } = PDFLib;
    const broken = new PdfError('เปิดไฟล์เดิมไม่ได้ จึงย้ายหน้าไม่ได้');
    let src;
    try {
      src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw broken;
    }
    if (src.isEncrypted) throw new PdfError('ไฟล์เดิมตั้งรหัสผ่านไว้ จึงย้ายหน้าไม่ได้');
    if (order.length !== src.getPageCount()) throw new PdfError('จำนวนหน้าของไฟล์เปลี่ยนไปแล้ว เปิดหน้างานใหม่แล้วลองอีกครั้ง');
    const out = await PDFDocument.create();
    let pages;
    try {
      pages = await out.copyPages(src, order.map((n) => n - 1));
    } catch {
      throw broken;
    }
    for (const p of pages) out.addPage(p);
    return { bytes: await out.save(), pages: out.getPageCount() };
  }

  // แทรกไฟล์ PDF (ฟังก์ชันเสริม insertpages): ทุกหน้าของไฟล์ที่เลือกวางหลังหน้า after ของไฟล์เดิม 0 = ก่อนหน้าแรก (ที่คั่นหน้าไม่ตามมา ไฟล์เดิมเก็บไว้เป็นรุ่นก่อน)
  async function insertPages(PDFLib, bytes, extraBytes, after) {
    const { PDFDocument } = PDFLib;
    const broken = new PdfError('เปิดไฟล์เดิมไม่ได้ จึงแทรกไฟล์ไม่ได้');
    const badExtra = new PdfError('เปิดไฟล์ที่จะแทรกไม่ได้ ไฟล์อาจเสีย ลองบันทึกเป็น PDF ใหม่');
    let src;
    let extra;
    try {
      src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw broken;
    }
    try {
      extra = await PDFDocument.load(extraBytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw badExtra;
    }
    if (src.isEncrypted) throw new PdfError('ไฟล์เดิมตั้งรหัสผ่านไว้ จึงแทรกไฟล์ไม่ได้');
    if (extra.isEncrypted) throw new PdfError('ไฟล์ที่จะแทรกตั้งรหัสผ่านไว้ เอารหัสผ่านออกก่อน');
    const total = src.getPageCount();
    if (!extra.getPageCount()) throw badExtra;
    if (!Number.isInteger(after) || after < 0 || after > total) throw new PdfError('ไฟล์นี้มี ' + total + ' หน้า พิมพ์เลขหน้าปลายทางใหม่');
    const out = await PDFDocument.create();
    let head;
    let added;
    try {
      head = await out.copyPages(src, src.getPageIndices());
    } catch {
      throw broken;
    }
    try {
      added = await out.copyPages(extra, extra.getPageIndices());
    } catch {
      throw badExtra;
    }
    for (const p of [...head.slice(0, after), ...added, ...head.slice(after)]) out.addPage(p);
    return { bytes: await out.save(), pages: out.getPageCount(), added: added.length };
  }

  // อ่านเลขหน้าที่พิมพ์ เช่น 1-18, 25 หรือ ๑ ถึง ๑๘ (total = จำนวนหน้าของไฟล์) คืนค่า { pages: เลขหน้าเรียงน้อยไปมาก, error: ข้อความเมื่อพิมพ์ไม่ถูก }
  function parsePages(text, total) {
    const s = String(text || '')
      .replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0e50))
      .replace(/\s*(?:ถึง|[-–—])\s*/g, '-')
      .trim();
    if (!s) return { pages: [], error: '' };
    const set = new Set();
    for (const part of s.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
      if (!m) return { pages: [], error: 'พิมพ์เลขหน้าแบบ 1-18 หรือ 1-18, 25' };
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (lo < 1) return { pages: [], error: 'เลขหน้าเริ่มที่หน้า 1' };
      if (hi > total) return { pages: [], error: 'ไฟล์นี้มี ' + total + ' หน้า ไม่มีหน้า ' + hi };
      for (let n = lo; n <= hi; n++) set.add(n);
    }
    return { pages: [...set].sort((x, y) => x - y), error: '' };
  }

  // เลขหน้าเป็นช่วงต่อเนื่อง เช่น [1, 2, 3, 25] เป็น [[1, 3], [25, 25]]
  function pageRuns(pages) {
    const runs = [];
    for (const n of [...pages].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else runs.push([n, n]);
    }
    return runs;
  }

  return { mergePdfs, editFront, cutPages, moveOrder, movePages, insertPages, parsePages, pageRuns, PdfError };
});
