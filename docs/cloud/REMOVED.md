# ฟังก์ชันที่ตัดออกเมื่อย้ายขึ้นคลาวด์ (ตอน 2 · 5 ต.ค. 2569)

Cloudflare Workers ไม่มีเครื่องให้ติดตั้งโปรแกรม และไม่มีโฟลเดอร์ในเครื่อง จึงตัด 2 ฟังก์ชันนี้ออก

## 1. แปลง Word เป็น PDF ในระบบ (สวิตช์ `wordconvert`)

- เดิมใช้โปรแกรม LibreOffice ในเครื่องที่เปิดระบบ (`src/convert.js`) หน้าส่งงานส่งไฟล์ Word ไป `POST /convert/word` ได้ PDF กลับมาให้ครูดูก่อนบันทึก
- ลบ: `src/convert.js` · เส้นทาง `/convert/word` · `/admin/convert` · กล่อง "ตัวแปลง Word เป็น PDF" ในหน้าฟังก์ชันเสริม · ค่าตั้ง `soffice_path` · โค้ดแปลงในหน้าเว็บ (`public/js/app.js`) · เงื่อนไข `conv` ใน `views/work_form.ejs` · ชุดทดสอบใน `tests/round2.test.js`
- ตอนนี้: หน้าส่งงานรับเฉพาะ PDF ครูบันทึกเป็น PDF จาก Word เอง วิธีอยู่ในหัวข้อ "มีแต่ไฟล์ Word ทำอย่างไร" ใต้ช่องเลือกไฟล์ (คงไว้)

**ไอเดียทำใหม่ภายหลัง**
- Google Drive API แปลงไฟล์ให้ (อัปโหลดเป็น Google Docs แล้วส่งออกเป็น PDF) ฟรี แต่ไม่มีฟอนต์ TH SarabunPSK หน้าตาจะเพี้ยน
- บริการแปลงไฟล์ภายนอก (มีโควตาฟรีจำกัด และต้องส่งไฟล์ออกไปนอกโรงเรียน)
- Cloudflare Containers ใส่ LibreOffice และฟอนต์ได้ แต่ต้องใช้ Workers Paid ราว 5 ดอลลาร์ต่อเดือน

## 2. คัดลอกแผนและคู่มือไป Google Drive ผ่าน Drive for desktop (สวิตช์ `drivecopy`)

- เดิมคัดลอกไฟล์ลงโฟลเดอร์ของโปรแกรม Google Drive for desktop ในเครื่องที่เปิดระบบ (`src/drive.js`) ทำงานต่อจาก `wf.onAdvance` เบื้องหลัง
- ลบ: `src/drive.js` · ตาราง `drive_copies` · ค่าตั้ง `drive_dir` `drive_when` `drive_last_ok` `drive_last_error` · เส้นทาง `/admin/drive` `/admin/drive/sync` · กล่อง "คัดลอกไป Google Drive" · การเรียก `drive.forget` ตอนลบงาน · `wf.onAdvance(...)` ใน `src/app.js`
- เก็บไว้: การคิดชื่อโฟลเดอร์และชื่อไฟล์ (`safeName` `relPath`) ย้ายไป `src/drivepath.js` ตรรกะเดิมทุกตัวอักษร ใช้ต่อในตอน 10 ซึ่งไฟล์จะเก็บใน Google Drive โดยตรง
- `wf.onAdvance` และ `notify()` ใน `src/workflow.js` ยังอยู่แต่ไม่มีผู้ฟัง ถ้าจะใช้อีกบน Workers ต้องใช้ `ctx.waitUntil` แทน `setImmediate`

## 3. รวม PDF และรับไฟล์งานบนเซิร์ฟเวอร์ (ตอน 10 · 6 ต.ค. 2569)

ไม่ได้ตัดฟังก์ชัน แต่ย้ายที่ทำงาน เพราะ Workers แบบฟรีมีเวลาประมวลผล 10 ms ต่อคำขอ และไม่มีโฟลเดอร์ในเครื่อง

- ลบ: `src/pdf.js` (รวม PDF บนเซิร์ฟเวอร์) · multer แบบเขียนดิสก์ในเส้นทางส่งงาน `/works` `/notes` `/s/:id` · `storedPath` `relStored` `removeStored` · โฟลเดอร์ `uploads` · `config.UPLOAD_DIR`
- แทนด้วย: รวม PDF ในเบราว์เซอร์ `public/js/pdfmerge.js` (ข้อความ error เดิม) · ส่งไฟล์เป็นท่อน `/upload/start` `PUT /upload/:token` · ที่เก็บไฟล์ `src/storage.js` (Google Drive หรือโฟลเดอร์ในเครื่อง) · ตรวจชนิดไฟล์จาก 8 ไบต์แรก
- multer ยังใช้กับโลโก้ (1 MB) และไฟล์ `งานล่าสุด.json` เพราะเล็ก

## กู้คืน

ของเดิมทั้งหมดอยู่ที่ tag `before-cloud` เช่น `git checkout before-cloud -- src/convert.js src/drive.js tests/round2.test.js`
