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

  return { mergePdfs, editFront, PdfError };
});
