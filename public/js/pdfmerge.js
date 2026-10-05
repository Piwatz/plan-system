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

  return { mergePdfs, PdfError };
});
