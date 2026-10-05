# ความคืบหน้าการย้ายขึ้นคลาวด์

แผนอยู่ที่ `docs/cloud/PLAN.md` (คัดลอกจาก `PLAN-cloudflare-supabase.md` ของพี่กัน ไม่แก้เนื้อหา)

## ตอน 0 · เตรียมงาน (5 ต.ค. 2569) ผ่าน

- พื้นที่ว่าง: ไดรฟ์ E (โปรเจกต์) 111 GB · ไดรฟ์ C (แคช npm) 36 GB · เกิน 5 GB ทั้งคู่
- Node.js v24.19.0
- branch `cloud` แยกจาก `main` ที่ commit `7489dcd` (ตรงกับ commit ที่แผนอ้างอิง) · tag `before-cloud` ชี้ `7489dcd`
- ผลทดสอบตั้งต้น `npm test`: tests 49 · pass 49 · fail 0 · ใน 7 ไฟล์ (features http login round1 round2 setup workflow) ตรงกับแผน
- อ่านแล้ว: กติกาในแผน สถาปัตยกรรมเป้าหมาย ภาพรวม 16 ตอน ตอน 0 · `CLAUDE.md`
- เอกสารเดิม `docs/ส่งพี่กัน-ย้ายไป-Supabase.md` ยังไม่ได้ commit แผนนี้ใช้แทน คงไว้ในเครื่องตามเดิม

**ค้าง / ต้องถามผู้ใช้:** ไม่มี

**วิธีประหยัดโทเค่นที่ตกลงกับผู้ใช้:** แต่ละตอนอ่านเฉพาะกติกาในแผน + หัวข้อของตอนนั้น + ภาคผนวกที่อ้างถึง แล้วอ่านไฟล์นี้เพื่อรู้สถานะ เริ่มแชทใหม่ทุกตอน

## ตอน 1 · ทดลองนำร่องบน Workers (5 ต.ค. 2569) ผ่าน 10 จาก 10 ข้อ

- รายละเอียดและหลักฐานทุกข้ออยู่ใน `docs/cloud/SPIKE.md` · โค้ดทดลองอยู่ใน `spike/` (ไม่แตะโค้ดแอป เก็บไว้ ลบในตอน 15)
- Express 5 ตัวจริง cookie แบบ secure AsyncLocalStorage ส่งต่อไฟล์ 5 MB แบบสตรีม pg QR และไฟล์ static ใช้บน Workers จำลองได้
- template ที่ compile ล่วงหน้าได้ HTML ตรงกับ EJS ทุกไบต์ (หน้า error พร้อม top และ bottom ทั้งแบบเข้าระบบและไม่เข้าระบบ)
- CPU บน Node: หน้า 100 แถว 0.2 ถึง 1.6 ms · QR 20 ตัว 7 ถึง 18 ms · JSON 2 MB 9 ถึง 16 ms

**ค้าง / ต้องถามผู้ใช้:**
1. `__dirname` ไม่มีบน Workers (ข้อ 2) แผนไม่ได้ระบุวิธีแก้ · ใช้ `define` ใน `wrangler.jsonc` ได้ผล รอผู้ใช้เห็นชอบก่อนใช้ในตอน 13
2. คำสั่ง pglite-server ในแผนต้องเติม `--max-connections=10` (ข้อ 8) รอผู้ใช้เห็นชอบ
3. ยังไม่ได้วัด CPU บน Cloudflare จริง (ต้องใช้บัญชี) ข้อเสนอเลื่อนมาวัดก่อนยังรอคำตอบ

**ผู้ใช้ตอบเรื่องค้างของตอน 1 (5 ต.ค. 2569):** รับตัวแก้ทั้ง 2 ข้อ (`define` สำหรับ `__dirname` ในตอน 13 · `--max-connections=10` ของ pglite-server) · เรื่องวัด CPU บน Cloudflare จริงก่อนยังไม่ได้ตอบ ทำตามลำดับแผนไปก่อน · ผู้ใช้ให้ทำต่อเนื่องตอน 2 ถึง 5 โดยไม่ต้องหยุดรายงานทีละตอน (ยัง commit ทุกตอน และหยุดถามเมื่อเจอเรื่องที่แผนไม่ได้คาดไว้)

## ตอน 2 · ตัด 2 ฟังก์ชันที่ใช้บนคลาวด์ไม่ได้ (5 ต.ค. 2569) ผ่าน

- พบว่ามีการแก้ค้างไว้ก่อนเริ่ม (`src/drivepath.js` ใหม่ และ `src/routes/admin.js` ตัดส่วน Word และ Drive) ไม่ทราบที่มา ผู้ใช้ยืนยันว่าไม่มีใครทำอยู่ จึงรับช่วงต่อ · ตรวจ admin.js แล้วตรงตามแผน · **drivepath.js มีบั๊ก** `safeName` ทำ `\` หายจากรายการตัวอักษรต้องห้าม แก้แล้ว เทียบกับ `src/drive.js` เดิม 6 กรณีได้ผลตรงทุกกรณี
- ลบ `src/convert.js` `src/drive.js` `tests/round2.test.js` (ผู้ใช้อนุญาต) · สวิตช์ `wordconvert` `drivecopy` · ตาราง `drive_copies` · ค่าตั้ง 5 ตัว · `wf.onAdvance(...)` ใน app.js · เส้นทาง `/convert/word` `/admin/convert` `/admin/drive` `/admin/drive/sync` · กล่อง 2 กล่องในหน้าฟังก์ชันเสริม · เงื่อนไข `conv` ใน work_form.ejs · โค้ดแปลงใน public/js/app.js · CSS `li.converting` · README และ CLAUDE.md
- เขียน `docs/cloud/REMOVED.md`
- `npm test`: tests 44 · pass 44 · fail 0
- ค้น `convert` `soffice` `wordconvert` `drivecopy` `drive.` ใน src views public/js tests ไม่เหลือ (ยกเว้น drivepath.js)
- `npm run demo` (preview plan-demo): หน้าฟังก์ชันเสริมไม่มี 2 สวิตช์และ 2 กล่อง · หน้าส่งคู่มือรับ `.pdf` อย่างเดียว เลือก 2 ไฟล์ ตรวจไฟล์ผ่าน เรียงลำดับได้ ดูปกได้ · กดบันทึกร่างได้ "บันทึกร่างเรียบร้อย รวม 2 ไฟล์เป็นไฟล์เดียวแล้ว 2 หน้า" · console มี error เดียวคือ 400 จากหน้าส่งแผนที่ครูทดลองมีแผนครบโควตาแล้ว (ข้อความเตือนปกติ ไม่ใช่บั๊ก)
- หมายเหตุ: เครื่องมือ Bash ในเครื่องนี้กิน `\` ใน heredoc บางกรณี (น่าจะเป็นที่มาของบั๊ก drivepath) แก้โค้ดที่มี `\` ด้วย Edit/Write เท่านั้น

## ตอน 3 · compile หน้าเว็บล่วงหน้า (5 ต.ค. 2569) ผ่าน

- `scripts/build-views.js` (`npm run build`): compile 52 ไฟล์ใน `views/` เป็น `dist/views.js` (276 KB) ด้วย `ejs.Template` + `strict` + `destructuredLocals` จากการวิเคราะห์ขอบเขตตัวแปรจริง (acorn + eslint-scope เพิ่มเป็น dependencies) · ไม่มี `with` · พบตัวแปรจาก locals 135 ตัว · **ไม่มีจุดที่ template กำหนดค่าให้ตัวแปรอิสระ** (สคริปต์จะหยุด build ถ้ามี)
- `src/view.js`: `CompiledView` สำหรับ Express 5 (`app.set('view', CompiledView)`) · escape และ shallowCopy ก๊อปจาก ejs 6.0.1 · include เทียบ path กับไฟล์ที่เรียก · ไม่ require ejs และไม่อ่านดิสก์ · `src/` ไม่มี `require('ejs')` แล้ว
- `tests/verify-views.js` โหลดด้วย `--require` ก่อนชุดทดสอบทุกไฟล์: render ซ้ำด้วย EJS ปกติในการเรียกเดียวกันแล้วเทียบทุกไบต์ · ผล: **38 หน้า (ครบทุกหน้าที่ไม่ใช่ partial) รวม 307 ครั้ง ไม่ตรง 0 ครั้ง** (partial 14 ไฟล์ถูกเทียบไปในหน้าที่ include)
- `npm test` = build + ทดสอบ: tests 44 · pass 44 · fail 0
- `server.js` build ทุกครั้งที่เปิดระบบ (.bat .command และ `npm start` `npm run demo` ไม่ต้องสั่งเอง) · `dist/` ไม่เก็บใน git
- `npm run demo`: ไล่เปิดทุกลิงก์ด้วยบัญชีทดลอง 4 บทบาท (ผู้ดูแลระบบ 62 หน้า ครู 53 หัวหน้ากลุ่มสาระ 31 ผู้อำนวยการ 23) ไม่มีรหัส 4xx 5xx ไม่มีหน้า "เกิดข้อผิดพลาด" · log ของ server ไม่มี error

**สิ่งที่ตัดสินใจเองระหว่างทาง (แจ้งผู้ใช้แล้ว):**
1. `URLSearchParams` (ใช้ใน `views/registry.ejs`) ไม่ใช่ built-in ของ ECMAScript ตามรายการในแผน แต่เป็นมาตรฐาน WHATWG ที่มีทั้งบน Node และ Workers จึงนับเป็น global ไม่ดึงจาก locals (ถ้าดึงจาก locals จะได้ undefined และหน้าทะเบียนพัง)
2. ไฟล์ .bat 2 ไฟล์ และ .command 2 ไฟล์ เปลี่ยนตัวเช็กว่าต้อง `npm install` ใหม่จาก `node_modules\pdf-lib` เป็น `node_modules\eslint-scope` เพราะเครื่องที่ติดตั้งรุ่นก่อนไม่มีแพ็กเกจใหม่ (บรรทัดคงแบบ CRLF และ LF ตามเดิม)
