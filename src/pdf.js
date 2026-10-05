// รวมไฟล์ PDF หลายไฟล์ (เช่น ปกกับเนื้อหา) เป็นไฟล์เดียว เรียงตามลำดับที่ครูจัดไว้
// ใช้ pdf-lib ซึ่งเป็น JavaScript ล้วน ทำงานได้ทั้ง Windows และ Mac ไม่ต้องติดตั้งโปรแกรมอื่น
const fs = require('fs');

class PdfError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

function lib() {
  try {
    return require('pdf-lib');
  } catch {
    throw new PdfError('เครื่องที่ติดตั้งระบบยังไม่มีตัวรวม PDF ให้ผู้ดูแลระบบปิดแล้วเปิดระบบใหม่ด้วยไฟล์เปิดระบบ (ต้องต่ออินเทอร์เน็ตครั้งแรก)');
  }
}

// files: [{ path, name }] คืนค่า { buffer, pages }
async function mergePdfs(files) {
  const { PDFDocument } = lib();
  const out = await PDFDocument.create();
  for (const f of files) {
    let src;
    try {
      src = await PDFDocument.load(fs.readFileSync(f.path), { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw new PdfError(`ไฟล์ ${f.name} เปิดไม่ได้ จึงรวมไม่ได้ ลองบันทึกเป็น PDF ใหม่แล้วแนบอีกครั้ง`);
    }
    if (src.isEncrypted) throw new PdfError(`ไฟล์ ${f.name} ตั้งรหัสผ่านไว้ จึงรวมไม่ได้ ให้บันทึกเป็น PDF ใหม่โดยไม่ใส่รหัสผ่าน`);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return { buffer: Buffer.from(await out.save()), pages: out.getPageCount() };
}

module.exports = { mergePdfs, PdfError };
