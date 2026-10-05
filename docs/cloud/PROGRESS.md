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

## ตอน 4 · ชั้นฐานข้อมูลใหม่ + โครงตาราง Postgres (5 ต.ค. 2569) ผ่าน

- แพ็กเกจ: `pg` 8.23.1 · dev `@electric-sql/pglite` 0.5.8 (Postgres 18.3 + pgcrypto) `@electric-sql/pglite-socket` `typescript` · ไม่ใช้ supabase-js
- `db/schema.sql` 13 ตาราง (ไม่มี drive_copies) + `login_attempts` + `schema_version` · id เป็น integer identity · ข้อความทุกคอลัมน์ `collate "C"` · เวลาคงเป็นข้อความ · `"current_role"` · ชื่อผู้ใช้ unique บน `lower(username)` · `verify_code` default สุ่ม 20 ตัว · audit_log กัน update delete truncate · `to_int_lenient` · `pending_uploads` `drive_folders` รอตอน 10
- `db/seed.sql` สร้างด้วย `scripts/make-seed-sql.js` จาก `src/defaults.js` (ย้ายค่าเริ่มต้นออกจาก db.js ไม่แก้ค่า) + `features.defaultSettings()`: ค่าตั้ง 49 คีย์ · กลุ่มสาระ 8 · ขั้นตอน 5 · แบบประเมิน 20 × 2 · รันซ้ำได้ · ปีการศึกษาเริ่มต้นคิดใน SQL ตามเวลาไทย
- `db/supabase-lockdown.sql` · `db/migrations/README.md`
- `src/db.js` ใหม่: PGlite (มีตัวล็อกกลาง) และ `pg.Pool` (DATABASE_URL) หน้าตาเดียวกัน · AsyncLocalStorage `requestScope` `withScope` · แปลง `?` และครอบ `current_role` ในชั้นนี้ชั้นเดียว · ตัวแปลงชนิด int8 numeric เป็น number json เป็นสตริงดิบ · `q.get` ไม่พบได้ undefined · `q.run` คืน `{ changes }` · `q.tx` ซ้อนได้ · `ensureRefs` `refs` `clearRefs` · `getSettings` ไม่ส่งรูปโลโก้ ได้ `/media/logo?v=md5 8 ตัว`
- `src/routes/media.js` (`/media/logo` `/media/memo-logo`) วางใน app.js ก่อน middleware ที่อ่านผู้ใช้
- `src/config.js`: ค่าเริ่มต้นโฟลเดอร์ข้อมูลเป็น `data-pg` (ไม่แตะ `data/`) · `PG_DIR` = `<โฟลเดอร์ข้อมูล>/pg` · `.gitignore` เพิ่ม data-pg data-files data-dev .dev.vars .env
- `node --test tests/db.test.js`: tests 10 · pass 10 · fail 0 · ชุดทดสอบอื่นพังตามที่แผนตั้งใจ (กลับมาในตอน 8)

**ตัดสินใจเองระหว่างทาง:** ครอบ `"current_role"` ให้อัตโนมัติในชั้นแปลง SQL (ข้ามข้อความในเครื่องหมายคำพูด) แทนการไล่แก้ทุกคำสั่ง ลดโอกาสลืม มีทดสอบครอบไว้ · ค่าตั้งที่ต้องดูต่อในตอน 7: หน้าตั้งค่าโรงเรียน (`src/routes/admin.js` 551) ต้องไม่เขียนที่อยู่ `/media/...` ทับรูปจริง

## ตอน 5 · ตัวช่วยกลางรอฐานข้อมูล + ล็อกแถว + รหัสผ่านในฐาน (5 ต.ค. 2569) ผ่าน

- `src/workflow.js`: ฟังก์ชันที่ยิงฐานเป็น async (submit approve sendBack withdraw submitAs overrideStep overrideAll advance progress inbox canView canWithdraw holders rolesOf getSub reviewsOf) · ฟังก์ชันที่ template เรียกคงเป็น sync อ่านจากข้อมูลอ้างอิง (allSteps activeSteps stepOf selfSign statusText rubric needsScore canReview scoreLevel) · ทางเข้า async ทุกตัว `await db.ensureRefs()` · ทั้ง 6 ฟังก์ชันที่เปลี่ยนสถานะเริ่ม transaction ด้วย `SELECT ... FOR UPDATE` (`lockSub`)
- `src/auth.js`: รหัสผ่าน `crypt(?, gen_salt('bf', 8))` และ `password_hash = crypt(?, password_hash)` ในฐาน · `verifyPassword(pw, userId)` · `loadUser` เลือกคอลัมน์ชัด ไม่เอา password_hash · `minPassword` async · ตัวกันเดารหัสยังอยู่ในหน่วยความจำ (ตอน 12)
- `src/features.js` (`isOn` ใช้ค่าเริ่มต้นใน FEATURES ถ้าไม่มีคีย์ · audit auditLog setFlag async) · `src/teaching.js` (async + upsert แบบ Postgres `teach_subjects.x` และ `GREATEST`) · `src/line.js` (async + แยก `tick()` ออกจาก setInterval ไว้ใช้กับ cron) · `src/upload.js` (อ่านขนาดไฟล์สูงสุดจาก req.settings หรือข้อมูลอ้างอิง) · `src/timetable.js` ไม่ยิงฐาน ไม่ต้องแก้
- `scripts/seed-demo.js` async · `RETURNING id` · `ILIKE` · สร้างข้อมูลทดลองบน PGlite ได้ ผู้ใช้ 16 คน งาน 26 รายการ ใน 3.5 วินาที · ชื่อยังเป็นชื่อสมมติ
- `scripts/check-await.js` (`npm run check-await`) จับแบบหลายบรรทัดได้ · `tsconfig.check.json` (`npm run check-types` strictNullChecks) · ไฟล์ของตอนนี้สะอาดทั้งสองตัว · ทั้งโปรเจกต์ยังเหลือใน routes และชุดทดสอบเดิม (check-await 336 จุด tsc 384 error เรื่อง Promise) ซึ่งเป็นงานตอน 6 ถึง 8
- `tests/workflow.test.js` แปลงเป็น PGlite + เพิ่ม 2 ข้อ (ลงนามพร้อมกันผ่านครั้งเดียว · รหัสผ่าน bcrypt และ loadUser) · `node --test tests/workflow.test.js tests/db.test.js`: tests 22 · pass 22 · fail 0

**ตัดสินใจเองระหว่างทาง (ต้องให้ผู้ใช้รู้):**
1. แผนสั่งให้ `loadUser` ไม่ดึง `signature` แต่ template ใช้ `me.signature` ทั้งเช็กว่ามีลายเซ็นและแสดงรูป (detail profile home inbox quicksign) และห้ามแก้ template · จึงให้ `me.signature` เป็นที่อยู่ `/media/signature?v=รุ่น` (เส้นทางใหม่ เห็นเฉพาะลายเซ็นของตัวเอง) และให้ workflow อ่านรูปลายเซ็นจริงจากฐานทุกครั้งที่ส่งงานหรือลงนาม (`wf.signatureOf`) มีทดสอบยืนยันว่าเอกสารเก็บรูปจริง ไม่ใช่ที่อยู่
2. ทดสอบลงนามพร้อมกันบน PGlite ผ่าน แต่ PGlite มี session เดียวจึงยังไม่ใช่การพิสูจน์ล็อกแถวจริง ต้องทดสอบซ้ำบน Postgres จริงในตอน 14 ตามแผน
3. บน Supabase ฟังก์ชัน pgcrypto อยู่ใน schema `extensions` ต้องเช็ก search_path ในตอน 14
