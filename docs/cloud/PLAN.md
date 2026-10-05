# แผนย้ายระบบส่งแผนการสอน ขึ้น Cloudflare + Supabase + Google Drive

> ร่างโดย แคลร์ (Claude ของพี่กัน) 5 ต.ค. 2569 · สำหรับ **Claude ของครูเต้ย** ใช้ทำงานทีละตอน
> repo `Piwatz/plan-system` · ร่างจากโค้ด commit `7489dcd` · ชุดทดสอบตั้งต้น 49 ข้อ ใน 7 ไฟล์
> เลขบรรทัดในแผนอ้างอิง commit นี้ (ตรวจซ้ำแล้วราว 75 จุด) ถ้าโค้ดขยับแล้วให้ค้นจากชื่อฟังก์ชันหรือข้อความแทน
> ⚠️ ราคา โควตา และวิธีตั้งค่าของ Cloudflare Supabase Google เช็คจากเอกสาร ณ 5 ต.ค. 2569 ก่อนใช้จริงให้เปิดเอกสารล่าสุดดูอีกครั้ง

---

## Context · ทำไมต้องย้าย

ระบบนี้ถูกสร้างให้รันบน **คอมเครื่องกลางของโรงเรียน** (Node.js + Express 5 + EJS 6 + ฐานข้อมูล `node:sqlite` ไฟล์ `data/app.db` + ไฟล์อัปโหลดใน `data/uploads`) ครูเข้าได้เฉพาะใน Wi-Fi โรงเรียน และต้องเปิดคอมทิ้งไว้
แต่โรงเรียนไม่มีคอมที่เปิดทิ้งไว้ได้ ผู้อำนวยการไม่อนุญาต และครูเต้ยไม่อยากมีค่าเช่าเครื่องรายเดือน สิ่งที่ครูเต้ยต้องการคือ **เว็บทั่วไปบนอินเทอร์เน็ต ข้อมูลอยู่บน Supabase ไฟล์ PDF อยู่ใน Google Drive ของโรงเรียน** กำหนดใช้จริง **เปิดรับงานภาค 2/2569 ต้นพฤศจิกายน 2569**

**ผลลัพธ์ที่ต้องการ:** ระบบเดิมทุกหน้า ทุกขั้นตอน หน้าตาเหมือนเดิม แต่รันบน Cloudflare แบบฟรี ข้อมูลอยู่ใน Supabase ไฟล์อยู่ใน Google Drive ของโรงเรียน เปิดได้จากทุกที่

### เคาะแล้ว (ห้ามเสนอทางอื่นกลับมา)

| เรื่อง | เคาะว่า | เหตุผล |
|---|---|---|
| ที่วางเว็บ | **Cloudflare Workers แบบฟรีเท่านั้น** | ไม่มีค่ารายเดือน ไม่หลับ ไม่ต้องเปิดคอม · ครูในโรงเรียนมีไม่กี่คน ไม่ต้องรองรับผู้ใช้จำนวนมาก |
| ตัวโปรแกรม | **Node.js + Express 5 + EJS ตัวเดิม** ห้ามเปลี่ยนเป็น Next.js React หรือหน้าเว็บฝั่งเบราว์เซอร์ | ผู้ใช้เคยแปลงเว็บไป Next.js แล้วของมาไม่ครบ · Cloudflare รันโค้ด Express เดิมได้แล้ว |
| ข้อมูลทั้งหมด (ยกเว้นไฟล์) | **Supabase (Postgres) โปรเจกต์ `plan-system` ที่ครูเต้ยสร้างไว้แล้ว** เชื่อมผ่าน **Cloudflare Hyperdrive** | ครูเต้ยต้องการ Supabase · Cloudflare แนะนำให้ต่อ Postgres ผ่าน Hyperdrive |
| ไฟล์ที่ครูอัปโหลด | **Google Drive ของโรงเรียน** (Google Education) แยกโฟลเดอร์ ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน | เนื้อที่เยอะ เป็นของโรงเรียนเอง ผู้บริหารเปิดดูได้ |
| เข้าสู่ระบบ | **ระบบเดิมของโปรแกรม** เลือกชื่อ + รหัสตัวเลข 4 หลักสำหรับครู (6 ตัวขึ้นไปสำหรับผู้ดูแล ผอ. รอง ผอ.) | ครูหลายท่านไม่คุ้นเคยกับเทคโนโลยี ต้องง่ายที่สุด · ข้อเสนอเปลี่ยนภายหลังอยู่ในหัวข้อ "ข้อเสนอเรื่องเข้าสู่ระบบ" |
| แปลง Word เป็น PDF (สวิตช์ `wordconvert`) | **ตัดออก** ไว้ทำทีหลัง | ต้องใช้ LibreOffice ในเครื่อง Workers ติดตั้งไม่ได้ |
| คัดลอกไฟล์ไป Google Drive ผ่านโปรแกรมบนคอม (สวิตช์ `drivecopy`) | **ตัดออก** เพราะไฟล์จะอยู่ใน Drive โดยตรงอยู่แล้ว (ตอน 10) | ใช้โปรแกรม Drive for desktop ซึ่งไม่มีบนคลาวด์ |
| ข้อมูลเดิม | **ไม่มีข้อมูลจริง** ไม่ต้องย้ายข้อมูล | มีแค่ข้อมูลทดลองชื่อสมมติ |
| บัญชีและรหัสลับ | **ครูเต้ยสร้างและถือเอง** (Supabase Cloudflare Google) Claude บอกทีละขั้น ห้ามขอให้ส่งรหัสลับมาในแชต | |

---

## ถึง Claude ของครูเต้ย · ทำไมแผนนี้ต่างจากเอกสาร "ส่งพี่กัน-ย้ายไป-Supabase.md"

เอกสารที่คุณเตรียมไว้ดีมากและข้อมูลถูกต้อง แต่ตั้งอยู่บนสมมติฐานว่า "ไม่มีที่ให้ Express ทำงาน" จึงต้องรื้อหน้าเว็บ 52 หน้าไปไว้ฝั่งเบราว์เซอร์ ให้เบราว์เซอร์คุยกับฐานข้อมูลตรง แล้วต้องเขียน RLS แยกบทบาทและย้ายกฎ workflow ไปไว้ใน Postgres function ซึ่งเป็นงานใหญ่และเสี่ยงที่สุด

**ตั้งแต่ ส.ค. 2568 Cloudflare Workers รันเซิร์ฟเวอร์ `node:http` ได้ (`handleAsNodeRequest` จาก `cloudflare:node` + `nodejs_compat`) Express ตัวเดิมจึงรันบน Workers ได้** แผนนี้จึงเก็บโค้ดเดิมไว้เกือบทั้งหมด เปลี่ยนแค่ "ตัวต่อ" ฐานข้อมูล ไฟล์ และเวลา เบราว์เซอร์ยังคุยกับเซิร์ฟเวอร์ Express เหมือนเดิม **ไม่คุยกับฐานข้อมูลตรง**

ผลต่อรายการในเอกสารของคุณ:
- กลุ่ม ก ข้อ 1 ไม่ต้องย้ายหน้าเว็บ · ข้อ 3 ไม่ต้องเขียน RLS แยกบทบาท (เปิด RLS ทุกตารางแบบไม่มี policy คือปิดประตูทั้งหมด แอปต่อด้วยบทบาทเจ้าของตารางผ่าน Hyperdrive) · ข้อ 4 กฎ workflow อยู่ใน `src/workflow.js` ฝั่งเซิร์ฟเวอร์เหมือนเดิม ครูแก้ไม่ได้
- กลุ่ม ข ข้อ 5 ไม่ใช้ Supabase Auth เลือกชื่อและรหัส 4 หลักอยู่ครบ · ข้อ 6 ไฟล์เข้า Google Drive แบบส่งเป็นท่อน ไม่ผ่านหน่วยความจำของเซิร์ฟเวอร์ · ข้อ 8 LINE ใช้ Cron Trigger ของ Cloudflare
- กลุ่ม ค ข้อ 14 ชุดทดสอบเดิม 49 ข้อแค่ปรับให้รอฐานข้อมูล (async) ไม่ต้องเขียนใหม่

คำตอบของคำถาม 8 ข้อในเอกสารของคุณ:

| คำถาม | คำตอบในแผนนี้ |
|---|---|
| 1 หน้าเว็บวางที่ไหน | Cloudflare Workers แบบฟรี ผูกกับ repo Private ได้ (ตอน 13 ถึง 14) |
| 2 เข้าสู่ระบบแบบไหน | ระบบเดิม เลือกชื่อ + รหัส 4 หลัก รหัสผ่านเข้ารหัสด้วย `pgcrypto` ในฐานข้อมูล ตัวกันเดารหัสย้ายไปเก็บในฐาน (ตอน 5 และ 12) |
| 3 workflow และ RLS | workflow อยู่ฝั่งเซิร์ฟเวอร์เหมือนเดิม + ล็อกแถวกันลงนามซ้อน (ตอน 5) · RLS ปิดประตูทุกตาราง (ตอน 4) · พิสูจน์ด้วยชุดทดสอบเดิมและทดสอบว่า anon key อ่านอะไรไม่ได้ (ตอน 14) |
| 4 ไฟล์เข้า Google Drive | บัญชีโรงเรียน OAuth สิทธิ์ `drive.file` · อัปโหลดแบบ resumable ส่งเป็นท่อนผ่านเซิร์ฟเวอร์ · สร้างโฟลเดอร์อัตโนมัติ · ผู้ตรวจเปิดไฟล์ผ่านเว็บเหมือนเดิม (ตอน 10) |
| 5 ตัวแปลง Word | ตัดออก (ตอน 2) |
| 6 หยุดเองหลังไม่มีคนใช้ 1 สัปดาห์ | cron อ่านฐานทุกวัน + ครูเต้ยเฝ้าดูหน้า Supabase (ตอน 14 ข้อ 9) |
| 7 สำรองข้อมูล | ปุ่มดาวน์โหลด JSON + cron สำรองเข้า Drive ทุกคืน (ตอน 10 ข้อ 9) |
| 8 ลำดับงานและเวลา | 16 ตอนตามด้านล่าง Claude ทำได้เร็ว ทันต้นพฤศจิกายน ไม่ต้องเช่าเครื่องชั่วคราว แต่ต้องทำทีละตอนและผ่านการทดสอบทุกตอน |

---

## สำหรับครูเต้ย (คนอ่าน ไม่ต้องรู้โค้ด)

- งานแบ่งเป็น **16 ตอน (ตอน 0 ถึง 15)** สั่ง Claude ทีละตอน เช่น พิมพ์ว่า **"ทำตอนที่ 3 ตามแผน"** จบตอนแล้ว Claude จะหยุด รายงานผลพร้อมหลักฐาน แล้วรอครูสั่งตอนถัดไป
- **หน้าตาเว็บ ปุ่ม ข้อความ ขั้นตอนตรวจ 5 ระดับ แบบประเมิน หน้าพิมพ์ ไม่เปลี่ยน** ยกเว้นบางข้อความที่พูดถึงคอมเครื่องกลางหรือ Wi-Fi โรงเรียน ซึ่ง Claude จะขอให้ครูเห็นชอบก่อนแก้
- ส่วนใหญ่ **ไม่ต้องมีบัญชีอะไร** Claude ทดสอบในเครื่องได้ · ที่ต้องใช้บัญชีคือ **ตอน 10 (บัญชี Google ของโรงเรียน)** และ **ตอน 14 (Supabase ที่สร้างไว้แล้ว + Cloudflare)** ครูทำเองและกรอกรหัสลับเอง Claude บอกทีละขั้น
- **ไม่มีค่าใช้จ่ายรายเดือน** ใช้แบบฟรีทั้งหมด
- ก่อนเปิดใช้จริงควรแจ้งผู้บริหาร เพราะชื่อจริงและลายเซ็นครูจะไปอยู่บนบริการคลาวด์

---

## กติกาสำหรับ Claude ที่ทำตามแผนนี้ (อ่านก่อนเริ่มทุกตอน)

1. **ทำทีละตอน** จบตอนต้องผ่านเงื่อนไข "ผ่านเมื่อ" ครบ แล้ว **หยุด รายงานผลพร้อมหลักฐาน** (ผลทดสอบจริง ภาพหน้าจอเมื่อแตะหน้าจอ) รอผู้ใช้สั่งตอนถัดไป ห้ามทำข้ามตอน
2. **อ่าน `CLAUDE.md` ของโปรเจกต์ทุกครั้ง** กฎในนั้นยังใช้ทั้งหมด เช่น ข้อความบนจอภาษาไทยทางการ ไม่มีขีดยาว จุดคั่น จุดไข่ปลา เครื่องหมายคำถาม · ปุ่มเปลี่ยนข้อมูลต้องมี `data-confirm` · ฟังก์ชันใหม่ต้องอยู่ใน `FEATURES` · ห้ามใส่ชื่อจริงในข้อมูลทดลอง
3. **ห้ามเปลี่ยนหน้าตาและพฤติกรรมที่ผู้ใช้เห็น** ยกเว้นที่แผนสั่งไว้ชัด ทุกข้อความบนจอที่จะเปลี่ยน ให้เสนอข้อความใหม่ให้ผู้ใช้เห็นชอบก่อน
4. ทำบน branch `cloud` · ก่อนเริ่มตอน 1 ติด tag `before-cloud` ไว้ย้อนกลับ · **commit ทุกจบตอน** ข้อความ commit ขึ้นต้นด้วย `ตอน N:`
5. **ห้ามใส่รหัสลับ (connection string, SESSION_SECRET, SETUP_TOKEN, Google client secret และ refresh token, LINE token) ในโค้ดหรือไฟล์ที่ commit** ใช้ `.dev.vars` และ `.env` (ใส่ใน `.gitignore`) ผู้ใช้กรอกค่าจริงเอง
6. เจอสิ่งที่แผนไม่ได้คาดไว้ หรือแผนขัดกับโค้ดจริง → **หยุดถามผู้ใช้** ห้ามเดา ห้ามแก้แผนเอง
7. จดความคืบหน้าใน `docs/cloud/PROGRESS.md` ทุกจบตอน (ทำอะไร ผลทดสอบ ปัญหาที่ค้าง)
8. ข้อเท็จจริงเรื่อง Cloudflare Supabase Google ในแผนเช็คเมื่อ 5 ต.ค. 2569 ถ้าเอกสารล่าสุดต่างไป ให้เชื่อเอกสารล่าสุดและแจ้งผู้ใช้
9. **ห้ามแตะ `data/`** (ข้อมูลของระบบเดิม) ตลอดทั้งแผน ของใหม่ในเครื่องใช้ `data-pg/` (ฐาน) และ `data-files/` (ไฟล์)
10. **ทุกงานที่ใช้ CPU หนัก ห้ามทำบนเซิร์ฟเวอร์** เพราะ Workers แบบฟรีให้ CPU 10 ms ต่อคำขอ (ภาคผนวก F)

---

## สถาปัตยกรรมเป้าหมาย

| ส่วน | ตอนนี้ | หลังย้าย |
|---|---|---|
| ตัวรัน | `node server.js` บนคอมโรงเรียน | **Cloudflare Workers แบบฟรี** · `nodejs_compat` · `compatibility_date` เป็นวันที่ทำงาน · Express รับคำขอผ่าน `handleAsNodeRequest` |
| ฐานข้อมูล | `node:sqlite` แบบ sync | **Postgres บน Supabase** · driver `pg` (≥ 8.16.3) · บน Workers ต่อผ่าน **Hyperdrive** (client ใหม่ทุกคำขอ · **ปิด query caching**) |
| ทดสอบและพัฒนาในเครื่อง | SQLite ในโฟลเดอร์ชั่วคราว | **PGlite** (`@electric-sql/pglite` คือ Postgres ที่รันในตัว Node ไม่ต้องติดตั้งโปรแกรม) |
| ไฟล์อัปโหลด | `data/uploads/ปี-เดือน/สุ่ม.ext` | **Google Drive ของโรงเรียน** โฟลเดอร์ ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน · ในเครื่องใช้ `data-files/` · ผ่านชั้นกลาง `src/storage.js` |
| อัปโหลด | multer เขียนดิสก์ แล้วรวม PDF บนเซิร์ฟเวอร์ | **รวม PDF ในเบราว์เซอร์** (pdf-lib) แล้วส่งเป็นท่อน 5 MB ผ่านเซิร์ฟเวอร์ต่อตรงเข้า Drive แบบ resumable (เซิร์ฟเวอร์ไม่เก็บไฟล์ในหน่วยความจำ) |
| รหัสผ่าน | `crypto.scryptSync` ในโปรแกรม | **`crypt()` + `gen_salt('bf')` ของ `pgcrypto` ในฐานข้อมูล** (ไม่กิน CPU ของ Workers) |
| หน้าเว็บ EJS | compile ตอนรัน (EJS ใช้ `new Function`) | **compile ล่วงหน้าตอน build** เพราะ Workers ห้าม `eval` และ `new Function` |
| ไฟล์ static (CSS JS ฟอนต์ PDF.js Chart.js) | `express.static` จาก `public/` และ `node_modules` | **Workers Static Assets** คัดลอกตอน build ไว้ที่ URL เดิม |
| LINE · ล้างไฟล์ค้าง · สำรองข้อมูล | `setInterval` | **Cron Trigger** |
| กุญแจ session | ไฟล์ `data/secret.key` | Workers secret `SESSION_SECRET` |
| เวลา | เวลาเครื่อง (ไทย) | **บังคับเวลาไทย `Asia/Bangkok` ในโค้ด** เพราะ Workers และ Supabase ใช้ UTC |

**หลักสำคัญ: แอป Express ตัวเดียวรันได้ 2 ที่** คือ Node.js (สำหรับ `npm test` และพัฒนาในเครื่อง) และ Workers (ใช้จริง) ต่างกันแค่ตัวต่อ 3 ตัว คือ ฐานข้อมูล ที่เก็บไฟล์ และตัวอ่านค่าตั้ง

---

## ภาพรวม 16 ตอน

| ตอน | ชื่อ | ต้องมีบัญชีไหม | หลังจบตอน แอปใช้ได้ไหม |
|---|---|---|---|
| 0 | เตรียมงาน | ไม่ | ได้ (ของเดิม) |
| 1 | ทดลองนำร่องบน Workers (โฟลเดอร์แยก) | ไม่ | ได้ (ของเดิม) |
| 2 | ตัด 2 ฟังก์ชันที่ใช้บนคลาวด์ไม่ได้ | ไม่ | ได้ |
| 3 | compile หน้าเว็บล่วงหน้า (ยังใช้ SQLite) | ไม่ | ได้ |
| 4 | ชั้นฐานข้อมูลใหม่ + โครงตาราง Postgres | ไม่ | ❌ พักชั่วคราว (ตั้งใจ) |
| 5 | ตัวช่วยกลางรอฐานข้อมูล + ล็อกแถว + รหัสผ่านในฐาน | ไม่ | ❌ |
| 6 | เส้นทางชุดแรก | ไม่ | ❌ |
| 7 | เส้นทางชุดใหญ่ (`work.js` `admin.js`) | ไม่ | ❌ |
| 8 | ชุดทดสอบและโหมดทดลองกลับมาใช้ได้ | ไม่ | ✅ บน Node + Postgres |
| 9 | ลดจำนวนคำสั่งและขนาดข้อมูลต่อหน้า | ไม่ | ✅ |
| 10 | ไฟล์ใน Google Drive + รวม PDF ในเบราว์เซอร์ + สำรองข้อมูล | **บัญชี Google ของโรงเรียน** (เฉพาะขั้นตั้งค่าและทดสอบ Drive จริง) | ✅ |
| 11 | บังคับเวลาไทย | ไม่ | ✅ |
| 12 | ความปลอดภัยสำหรับเปิดสู่อินเทอร์เน็ต | ไม่ | ✅ |
| 13 | ปรับให้รันบน Workers (จำลองในเครื่อง) | ไม่ | ✅ ทั้ง Node และ Workers จำลอง |
| 14 | ขึ้นใช้งานจริง | **Supabase + Cloudflare + Google** | ✅ บนเว็บจริง |
| 15 | เก็บงาน เอกสาร กฎใหม่ | ไม่ | ✅ |

ตอน 4 ถึง 7 แอปใช้งานไม่ได้ชั่วคราว เพราะฐานข้อมูลเปลี่ยนจาก "ได้คำตอบทันที" เป็น "ต้องรอคำตอบ" (async) ต้องแก้ครบทุกจุดก่อน ทำบน branch `cloud` เท่านั้น ของเดิมใน `main` ยังใช้ได้ตลอด

---

## ตอน 0 · เตรียมงาน (ไม่แก้โค้ด)

1. **เช็คพื้นที่ดิสก์ว่าง อย่างน้อย 5 GB** (ติดตั้ง wrangler PGlite และไฟล์ทดสอบชั่วคราว) ถ้าไม่พอ หยุดแจ้งผู้ใช้
2. อ่านแผนนี้ทั้งไฟล์ + `CLAUDE.md` + `README.md`
3. `git checkout -b cloud` แล้ว `git tag before-cloud`
4. `npm test` จดผล (ควรเป็น 49 ข้อ ผ่านทั้งหมด)
5. สร้าง `docs/cloud/PROGRESS.md` และวางแผนนี้ไว้ที่ `docs/cloud/PLAN.md`

**ผ่านเมื่อ:** ดิสก์พอ · มี branch `cloud` และ tag `before-cloud` · ผลทดสอบตั้งต้นจดใน PROGRESS.md

---

## ตอน 1 · ทดลองนำร่องบน Workers

**เป้าหมาย:** พิสูจน์ก่อนลงแรงใหญ่ ว่าของที่แอปนี้พึ่งพารันบน Workers ได้จริง ทำในโฟลเดอร์ `spike/` แยกจากแอป ไม่แตะโค้ดแอป

สร้างแอป Express จิ๋วใน `spike/` มี `wrangler.jsonc` ของตัวเอง (`compatibility_flags: ["nodejs_compat"]` · `compatibility_date` เป็นวันที่ทำงาน) แล้วรัน `npx wrangler dev` ในเครื่อง (ไม่ต้อง login)

| # | ทดสอบ | วิธี |
|---|---|---|
| 1 | Express 5 ผ่าน `handleAsNodeRequest(3000, request)` จาก `cloudflare:node` | GET `/` ได้ · **สร้างแอปตอนคำขอแรกภายใน `fetch()` ไม่สร้างที่ระดับบนสุดของโมดูล** เพราะ Workers ห้ามสุ่มค่าที่ระดับบนสุด และ `Date.now()` ที่ระดับบนสุดได้ 0 |
| 2 | import `src/config.js` ตัวจริงของโปรเจกต์ | ตรวจ `__dirname` (`src/config.js` 11 ใช้ `path.resolve(__dirname, '..')` ตอน import) ว่าได้ค่าที่ใช้ได้ |
| 3 | EJS แบบ compile ล่วงหน้า | compile `views/error.ejs` และ partial ที่มันเรียก ด้วยวิธีในตอน 3 แล้ว render บน Workers ได้ HTML ตรงกับที่ EJS ปกติ render บน Node ทุกไบต์ |
| 4 | `cookie-session` + `secure: true` | ใน `fetch()` สร้าง Request ใหม่ที่เติม header `x-forwarded-proto` ตามโปรโตคอลของ `request.url` และ `app.set('trust proxy', true)` เฉพาะบน Workers แล้ว Set-Cookie ต้องไม่ error (แพ็กเกจ `cookies` โยน error "Cannot send secure cookie over unencrypted connection" ถ้า `req.protocol` ไม่ใช่ https) |
| 5 | IP ผู้ใช้ | อ่าน header `CF-Connecting-IP` ได้ |
| 6 | `AsyncLocalStorage` | store ที่ตั้งใน middleware ยังอยู่หลังผ่าน `express.urlencoded` และ handler แบบ async · ตรวจด้วยว่า store ที่ตั้งใน `fetch()` ก่อนเรียก `handleAsNodeRequest` ไปถึง handler ไหม (ถ้าถึง ใช้ส่ง `ctx` เข้าแอปได้) |
| 7 | ส่งต่อข้อมูลดิบแบบไม่เก็บในหน่วยความจำ | เส้นทาง `PUT /chunk` รับข้อมูลดิบ 5 MB แล้วส่งต่อด้วย `fetch(url, { method: 'PUT', body: Readable.toWeb(req), duplex: 'half' })` ไปเซิร์ฟเวอร์ Node เล็ก ๆ อีกตัวในเครื่อง ได้ขนาดตรง |
| 8 | `pg` ผ่าน Hyperdrive แบบในเครื่อง | `npx pglite-server --port=5433` (แพ็กเกจ `@electric-sql/pglite-socket`) ตั้ง `hyperdrive.localConnectionString` แล้ว `select 1` ได้ · ลองยิง 5 คำขอพร้อมกันว่าไม่ค้าง |
| 9 | `qrcode` | สร้าง SVG ได้ และตรงกับที่ Node สร้าง (wrangler จะเลือก `lib/browser.js` ของแพ็กเกจ) |
| 10 | Static Assets | ไฟล์ใน `spike/assets/` เปิดได้โดยไม่ผ่าน Express |

- เวลา CPU วัดบน Workers ในเครื่องไม่ได้ ให้วัดบน Node แทน: render หน้าที่มี 100 แถว · สร้าง QR 20 ตัว · `JSON.stringify` ข้อมูล 2 MB · จดเป็นมิลลิวินาทีเทียบกับ 10 ms
- ถ้าเจอ error ว่า code generation from strings disallowed ให้หาว่าแพ็กเกจไหนเรียก (ที่รู้แล้ว: `ejs` และ `depd` ที่ `node_modules/depd/index.js` 425 ซึ่งเรียกเฉพาะตอนมีการเตือน deprecated)
- จดผลทุกข้อใน `docs/cloud/SPIKE.md`

**กฎหยุด:** ถ้าข้อ 1 3 4 7 หรือ 8 ไม่ผ่าน และแก้ในตอนนี้ไม่ได้ → **หยุด รายงานผู้ใช้** (ทางสำรองดูภาคผนวก E)

**ผ่านเมื่อ:** 10 ข้อผ่าน และ SPIKE.md บันทึกครบ · เก็บ `spike/` ไว้ก่อน ลบในตอน 15

---

## ตอน 2 · ตัด 2 ฟังก์ชันที่ใช้บนคลาวด์ไม่ได้

**ก่อนลบ `src/drive.js` ให้ย้ายส่วนที่คิดชื่อโฟลเดอร์ (ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน และการทำชื่อให้ปลอดภัย) ไปไว้ `src/drivepath.js` ไม่แก้ตรรกะ** จะใช้ต่อในตอน 10

ลบหรือแก้ทุกจุดต่อไปนี้:
- ไฟล์ `src/convert.js` `src/drive.js` (หลังย้ายส่วนชื่อโฟลเดอร์แล้ว)
- `src/features.js` 26 ถึง 27 (สวิตช์ `wordconvert` `drivecopy`)
- `src/routes/admin.js` 14 ถึง 15 · 583 ถึง 591 · **598 ถึง 599 เท่านั้น** (ใน `NEEDS` ห้ามลบ `line` บรรทัด 597 เพราะ 582 606 และ `views/admin/features.ejs` 14 ใช้อยู่) · 610 · 649 ถึง 691 (ห้ามลบเส้นทาง `/backup` ตั้งแต่ 693)
- `src/routes/work.js` 14 ถึง 15 · 298 ถึง 321 (เส้นทาง `/convert/word`) · 350 · 578 · 683 (`drive.forget(...)`)
- `src/app.js` 31 (`wf.onAdvance(require('./drive').queueSync)`)
- `src/db.js` 226 ถึง 234 (ตาราง `drive_copies`) · 339 ถึง 343 (ค่าตั้ง `soffice_path` และ `drive_*` 4 ตัว)
- `views/admin/features.ejs` 3 (ไอคอน) · 25 · **50 ถึง 131** (กล่องแปลง Word และ Google Drive รวมจุดที่ใช้ `process.platform`)
- `views/work_form.ejs` **แก้ 76 ถึง 81 เฉพาะเงื่อนไข `conv`** (77 ถึง 82 คือกล่องเลือกไฟล์ `main_files` ห้ามลบ) · **ลบ 93 ถึง 95** (บล็อก `if (conv)` ระวังเหลือ `<% } %>` ค้าง)
- `public/js/app.js` 145 ถึง 148 · 338 ถึง 387 · **และ 475 513 ถึง 516 525 ถึง 528** (`converted` `pending` `'converting'` `convertUrl` `isWord` `convertWord`) ถ้าหลงเหลือ เบราว์เซอร์จะ error และครูส่งงานไม่ได้
- `tests/round2.test.js` ทั้งไฟล์ (5 ข้อ)
- `README.md` 90 ถึง 103 และ 126 · ย่อหน้ารอบ 2 ใน `CLAUDE.md` (เขียนว่าตัดแล้ว ดู `docs/cloud/REMOVED.md`)

ข้อสังเกต:
- `wf.onAdvance` และ `notify()` (`src/workflow.js` 90 ถึง 104) ไม่มีผู้ฟังเหลือ คงฟังก์ชันไว้ได้ แต่ `notify()` ใช้ `setImmediate` ทำงานหลังตอบคำขอ ซึ่งบน Workers ไม่รับประกันว่าจะได้ทำ ถ้าจะใช้อีกต้องใช้ `ctx.waitUntil`
- เขียน `docs/cloud/REMOVED.md`: ลบอะไร · กู้คืนจาก tag `before-cloud` · ไอเดียทำ Word เป็น PDF ใหม่ (Google Drive API แปลงให้ แต่ไม่มีฟอนต์ TH SarabunPSK · บริการแปลงไฟล์ภายนอก · Cloudflare Containers ซึ่งต้องเสียเงิน)

**ผ่านเมื่อ:** `npm test` ผ่าน 44 ข้อ (49 ลบ 5 ของ round2) · ค้น `convert` `soffice` `wordconvert` `drivecopy` `drive.` ใน `src/ views/ public/js/ tests/` ไม่เหลือ (ยกเว้น `src/drivepath.js`) · `npm run demo` หน้าฟังก์ชันเสริมไม่มี 2 สวิตช์นี้ และส่ง PDF ได้ตามปกติ ไม่มี error ใน console ของเบราว์เซอร์

---

## ตอน 3 · compile หน้าเว็บล่วงหน้า (ยังใช้ SQLite)

**ทำไมทำก่อนฐานข้อมูล:** เป็นจุดเสี่ยงสูงสุดที่ไม่เกี่ยวกับฐานข้อมูล และตอนนี้ยังเทียบผลกับแอปเดิมที่ใช้ได้จริงได้ทุกไบต์

**ปัญหา:** Workers ห้าม `eval()` และ `new Function()` ทุกกรณี แต่ EJS 6.0.1 เรียก `new Function` ตอน import (`node_modules/ejs/lib/cjs/ejs.js` 97) ตอน compile (593 ถึง 607) และอ่าน template จากดิสก์ (79 129 161) → **ห้าม import `ejs` ในโค้ดที่รันจริง** ใช้เฉพาะตอน build

1. `scripts/build-views.js` (`npm run build`): compile ทุกไฟล์ใน `views/` (52 ไฟล์ · `include()` 102 จุดใน 41 ไฟล์) เป็นไฟล์ JS ธรรมดา `dist/views.js` (map ชื่อไฟล์ → ฟังก์ชัน `(locals, escapeFn, include, rethrow)`)
   - EJS 6 ไม่มีตัวเลือก `client` แล้ว · `toString()` ของฟังก์ชันที่ `ejs.compile` คืนมาเป็นแค่ตัวห่อ `anonymous(data)` (ejs.js 628) ใช้ไม่ได้ → ใช้ `new ejs.Template(text, opts)` แล้ว `t.compile()` แล้วอ่าน `t.source` · ตั้ง `compileDebug: false` (ไม่อย่างนั้นซอร์สมี `; __line = N` ที่อ้างตัวแปรซึ่งประกาศไว้นอก `t.source`) · อ่าน ejs.js ช่วง 520 ถึง 610 ให้เข้าใจว่า EJS ประกอบตัวฟังก์ชันจริงจากอะไรบ้าง แล้วห่อเองให้เทียบเท่า
   - **ห้ามมี `with`** (โมดูล ESM เป็น strict mode) → `strict: true` (ทำให้ `_with: false`) `localsName: 'locals'` และ `destructuredLocals` = ตัวแปรอิสระทั้งหมดในฟังก์ชันที่สร้างได้ **หาด้วยการวิเคราะห์ขอบเขตตัวแปรจริง** (`acorn` + `eslint-scope` หรือเทียบเท่า) ตัดออกเฉพาะ built-in ของ ECMAScript (`Math` `JSON` `Date` `Intl` `Number` `String` `Array` `Object` `encodeURIComponent` `parseInt` `isNaN` `undefined` `NaN` `Infinity` ฯลฯ) **ห้ามใช้รายการ global ของเบราว์เซอร์** เพราะ `window` ในโปรเจกต์นี้เป็น locals จริง (ส่งที่ `src/routes/work.js` 348 576 · `src/routes/pages.js` 250 293 ใช้ใน `views/home.ejs` 11 ถึง 16 และ `views/my.ejs` 17 ถึง 18) · `process` ก็เป็นตัวแปรอิสระ (เคยใช้ใน `views/admin/features.ejs` ซึ่งตัดแล้วในตอน 2 ตรวจว่าไม่เหลือ)
   - template ไม่ต้องแก้สักบรรทัด · `locals.` 13 จุด และ `typeof x !== 'undefined'` 5 จุด (`views/login.ejs` 10 · `views/password.ejs` 19 20 24 · `views/work_form.ejs` 76) ยังทำงานเหมือนเดิม
   - ให้สคริปต์ **รายงานทุกจุดที่ template กำหนดค่าให้ตัวแปรอิสระ** (แบบ `with` จะเขียนลง locals แต่แบบ destructure ไม่เขียน partial ที่ include ทีหลังจะเห็นค่าต่างกัน) แล้วแก้ทีละจุดอย่างระวัง
   - `include(path, data)` เทียบ path กับไฟล์ที่เรียก และรวมข้อมูลแบบเดียวกับ EJS (สำเนาตื้นของ data เดิม แล้วทับด้วย data ใหม่) · ฟังก์ชัน escape ก๊อปจาก `utils.escapeXML` ของ ejs มาเป็นฟังก์ชันเล็ก ๆ ในโปรเจกต์
2. `src/view.js` คลาส View ของ Express 5 ที่ render จาก `dist/views.js` แล้ว `app.set('view', CompiledView)` (Express ปกติหาไฟล์ด้วย `fs.statSync` ซึ่งบน Workers ไม่มีไฟล์ให้หา) · ข้อมูลที่ Express ส่งเข้า (`settings` `_locals` `cache` รวม `res.locals`) ใช้แบบเดียวกับที่ EJS ได้ · **ใช้ทั้งบน Node และ Workers** `npm test` รัน build ก่อนทุกครั้ง
3. **ทดสอบเทียบผล:** ใน `View.render` ช่วงทดสอบ ให้ render ซ้ำด้วย EJS ปกติ (ภายในการเรียกเดียวกัน เพราะ locals มีฟังก์ชันที่อ่านเวลาปัจจุบันและข้อมูลต่อคำขอ) แล้วเทียบ **HTML ต้องตรงกันทุกไบต์ทุกครั้งที่ render ในชุดทดสอบ**

**ผ่านเมื่อ:** `npm test` ผ่าน 44 ข้อด้วย template ที่ compile แล้ว · ทดสอบเทียบผลไม่มีหน้าไหนต่าง · สคริปต์ build ไม่รายงานการกำหนดค่าตัวแปรอิสระที่ยังไม่ได้จัดการ · `npm run demo` เปิดได้ทุกหน้าตามปกติ

---

## ตอน 4 · ชั้นฐานข้อมูลใหม่ + โครงตาราง Postgres

### 4.1 แพ็กเกจ
`pg` (≥ 8.16.3 ตามที่ Hyperdrive กำหนด) · dev: `@electric-sql/pglite` `@electric-sql/pglite-socket` · **ห้ามใช้ `@supabase/supabase-js`** (Cloudflare ระบุว่าไม่ควรใช้คู่กับ Hyperdrive และต้องเขียนคำสั่งใหม่ทุกจุด)

### 4.2 `db/schema.sql` (13 ตาราง ไม่รวม `drive_copies`) แปลงจาก `migrate()` + `addColumn()` ใน `src/db.js` เป็นรูปสุดท้ายรูปเดียว
- `create extension if not exists pgcrypto` (บน Supabase อยู่ใน schema `extensions` ให้เรียกแบบระบุ schema หรือตั้ง search_path · บน PGlite โหลดจาก `@electric-sql/pglite/contrib/pgcrypto`)
- `id INTEGER PRIMARY KEY` → `id integer generated by default as identity primary key` · **ใช้ integer ห้าม bigint** (bigint กลับมาเป็นสตริงใน JS และโค้ดเทียบ id ด้วย `===` ที่ `src/routes/extras.js` 240 264 · `src/routes/teaching.js` 32 · `src/routes/admin.js` 205 224 · `src/routes/pages.js` 24)
- **คอลัมน์ข้อความทุกคอลัมน์ใส่ `collate "C"`** เรียงแบบไบต์เหมือน SQLite และเหมือนกันทั้ง PGlite และ Supabase
- คอลัมน์เวลา **คงเป็น `text` รูปแบบ `YYYY-MM-DD HH:MM:SS` เวลาไทย** ห้ามเปลี่ยนเป็น timestamptz หรือใช้ `now()`
- ธง 0/1 คงเป็น `integer` · `REAL` → `double precision`
- 🔴 **`submissions.current_role` เป็นคำสงวนของ Postgres** → ใช้ชื่อเดิมแต่เขียน `"current_role"` ทุกที่ใน SQL (schema ดัชนี และคำสั่ง ทั้งแบบมีและไม่มีชื่อตารางนำหน้า เช่น `s."current_role"`) ชื่อคุณสมบัติใน JS ยังเป็น `current_role` template ไม่ต้องแก้
- `username ... COLLATE NOCASE` → `username text collate "C" not null` + `create unique index users_username_lower on users (lower(username))` · คำสั่งที่ค้นหรือเทียบ username ใช้ `lower(username) = lower(?)` (`src/routes/auth.js` 95 · `src/routes/admin.js` 139 165 204 330)
- `verify_code` → `text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)` (ตัวอักษร 0 ถึง 9 a ถึง f 20 ตัว ตรงกับ `src/routes/verify.js` 35)
- `audit_log` ห้ามแก้ห้ามลบ → ฟังก์ชัน plpgsql `raise exception 'audit_log is append-only'` + trigger `before update` `before delete` และ **`before truncate`**
- ดัชนีทุกตัว foreign key ทุกตัว และ `unique (teacher_id, academic_year, semester, subject_code)` คงเดิม
- ฟังก์ชัน `to_int_lenient(text) returns integer` = `coalesce(nullif(substring($1 from '^\s*([0-9]{1,9})'), '')::integer, 0)` เขียนใน `schema.sql` (ใน SQL ไฟล์ ไม่ใช่สตริง JS เพราะ `\s` ในสตริง JS จะหาย · จำกัด 9 หลักกัน integer ล้น เพราะ `plan_no` ยาวได้ 20 ตัว `src/routes/work.js` 194)
- ตารางใหม่: `login_attempts (key text collate "C" primary key, first_at bigint not null, count integer not null)` · `pending_uploads` และ `drive_folders` (ตอน 10 สร้างจริง) · `schema_version (version integer)`
- โฟลเดอร์ `db/migrations/NNN_ชื่อ.sql` สำหรับการแก้โครงตารางในอนาคต
- `db/seed.sql` ค่าเริ่มต้นสำหรับเว็บจริง (ค่าตั้ง 49 คีย์ · กลุ่มสาระ 8 · ขั้นตอนตรวจ 5 · แบบประเมิน 20 ข้อ × 2) สร้างจากข้อมูลใน `src/db.js` และ `src/features.js`
- `db/supabase-lockdown.sql` (รันเฉพาะบน Supabase): `enable row level security` ทุกตาราง **ไม่สร้าง policy** · `revoke all on all tables, sequences, functions in schema public from anon, authenticated` · `alter default privileges in schema public revoke all on tables, sequences, functions from anon, authenticated` (ค่าเริ่มต้นของ Supabase ให้สิทธิ์ตารางใหม่แก่ anon)

### 4.3 `src/db.js` ใหม่
- **ตัวต่อ 3 แบบ หน้าตาเดียวกัน `query(text, params) → { rows, rowCount }`**
  - Node: `pg.Pool` จาก `DATABASE_URL` · `q.tx` **ยืม client ของตัวเองแล้วคืนใน `finally`** (ถ้าผูก client กับคำขอแล้วผู้ใช้ปิดหน้าเว็บกลางทาง client จะกลับเข้า pool ทั้งที่ transaction ค้าง)
  - PGlite (ทดสอบ · `npm run demo` เก็บที่ `data-demo/pg` · `npm start` ไม่มี `DATABASE_URL` เก็บที่ `data-pg/`): **PGlite มี session เดียว** → ต้องมีตัวล็อกกลาง ระหว่างที่ transaction หนึ่งทำงาน คำสั่งอื่นต้องรอ · ใช้อินสแตนซ์เดียวตลอดการทดสอบ (`scripts/seed-demo.js` 378 เรียก `db.close()` แล้วทดสอบเปิดใหม่ ถ้าเป็นหน่วยความจำ ข้อมูลจะหาย)
  - Workers: `new pg.Client({ connectionString: env.HYPERDRIVE.connectionString })` สร้างใหม่ทุกคำขอ (ต่อจริงในตอน 13)
- **ขอบเขตต่อคำขอ** ด้วย `AsyncLocalStorage`: middleware `db.requestScope` เปิด store ต่อคำขอ (connection บน Workers + ข้อมูลอ้างอิงตอน 5)
- **แปลง `?` เป็น `$1 $2 …` ในชั้นนี้ชั้นเดียว** (ข้าม `?` ในสตริง `'...'`) ราว 310 จุด และตัวสร้างรายการ `?` แบบไดนามิก 3 จุด (`src/workflow.js` 381 · `src/routes/work.js` 461 601) ใช้ได้เอง
- **ตัวแปลงชนิดข้อมูล:** int8 (oid 20) และ numeric (1700) → `Number` · json (114) และ jsonb (3802) → **สตริงดิบไม่แปลง** (ใช้ในสำรองข้อมูลตอน 10 ไม่เปลือง CPU) ทั้งใน `pg` (`types.setTypeParser`) และ PGlite (option `parsers`)
- `q.get()` **คืน `undefined`** เมื่อไม่พบ (ทดสอบใช้ `assert/strict` เทียบ `undefined` ที่ `tests/features.test.js` 116 119 215 · `tests/round1.test.js` 120 198 211 294 304 305 316) · `q.run()` คืน `{ changes: rowCount }` · **เลิกใช้ `lastInsertRowid`** ใช้ `RETURNING id` · คง `q.exec` ไว้ (`tests/features.test.js` 95 ถึง 96)
- พารามิเตอร์ที่เป็น `undefined` ให้แปลงเป็น `null` ก่อนส่ง · `true/false` ที่ส่งเข้าคอลัมน์ integer ให้แปลงเป็น 1/0
- `q.tx(async () => { ... })`: ทุก `q.*` ข้างในวิ่งเข้า transaction เองผ่าน AsyncLocalStorage · เรียกซ้อนใช้ชั้นนอก · **ห้าม `Promise.all` หลายคำสั่งใน transaction**
- `migrate()` ใช้บน PGlite และ dev เท่านั้น (รัน `schema.sql` + seed) · **บนเว็บจริงไม่รัน migrate ตอนเริ่ม**
- **`getSettings()` ไม่ส่งรูปโลโก้** (data URL รวมกันถึงราว 2.7 MB ถูกอ่านทุกคำขอ) → คืน `school_logo` และ `memo_logo` เป็น URL `/media/logo?v=<md5 8 ตัว>` และ `/media/memo-logo?v=…` (หรือ `''` ถ้าไม่มี) คำนวณ md5 ในคำสั่ง SQL · template ทุกตัวใช้ต่อได้โดยไม่ต้องแก้ (`views/partials/top.ejs` 11 50 86 · `views/login.ejs` 4 · `views/print_pa.ejs` 13 · `views/partials/memo_page.ejs` 11 · `views/admin/settings.ejs` 24 32)
- เพิ่มเส้นทาง `/media/logo` และ `/media/memo-logo` **ในตอนนี้เลย** ส่งรูปพร้อม `Cache-Control` ยาว (URL มีเลขรุ่นแล้ว) · ต้องเปิดได้โดยไม่เข้าระบบ และวาง **ก่อน** middleware หนักใน `src/app.js` 88 ถึง 131
- `features.isOn()`: ถ้าไม่มีคีย์ `ff_*` ในฐาน ให้ใช้ค่าเริ่มต้นใน `FEATURES` (เดิม `seedDefaults` เติมคีย์ใหม่ทุกครั้งที่เริ่มระบบ บนเว็บจริงไม่มีแล้ว ฟังก์ชันใหม่ที่ค่าเริ่มต้นเปิดจะกลายเป็นปิด)

### 4.4 ทดสอบ `tests/db.test.js` (PGlite)
แปลง `?` ถูก (มี `?` ในสตริงด้วย) · `COUNT(*)` ได้ number · transaction ผิดกลางทางแล้วย้อนกลับครบ · แก้ ลบ truncate `audit_log` แล้ว error มีคำว่า append-only · `verify_code` สร้างเอง ตรงรูปแบบ · username ต่างแค่ตัวพิมพ์ใส่ซ้ำไม่ได้ · `"current_role"` อ่านเขียนได้ · `to_int_lenient('')` = 0 · `to_int_lenient('12ก')` = 12 · เลข 20 หลักไม่ error · `/media/logo` ส่งรูปได้

**ผ่านเมื่อ:** `node --test tests/db.test.js` ผ่าน · ชุดทดสอบอื่นพังได้ (ตั้งใจ กลับมาในตอน 8)

---

## ตอน 5 · ตัวช่วยกลางรอฐานข้อมูล + ล็อกแถว + รหัสผ่านในฐาน

**ไฟล์:** `src/workflow.js` `src/auth.js` `src/features.js` `src/teaching.js` `src/timetable.js` `src/line.js` `src/upload.js` (ส่วนที่อ่าน settings ซึ่ง `uploader()` อยู่ที่ 55 ถึง 65) `scripts/seed-demo.js`

1. ฟังก์ชันไหนเรียก `q.*` ตรงหรือทางอ้อม → `async` และผู้เรียก **ทุกจุด** ต้อง `await` · ในโค้ดมี `q.get` 64 `q.all` 54 `q.run` 56 `q.tx` 22 (ไม่รวม drive.js) · เรียกฐานใน `.map` `.filter` `.forEach` → `for…of` + `await` หรือรวมคำสั่ง (ตอน 9) · ค่าเริ่มต้นพารามิเตอร์ที่ยิงฐาน `canReview(…, self = selfSign())` (`src/workflow.js` 142)
2. **ข้อมูลอ้างอิงต่อคำขอ (request refs)** โหลดครั้งเดียวต่อคำขอ: settings (ไม่รวมรูปโลโก้) · ธงฟังก์ชัน · `workflow_steps` (5 แถว) · `rubric_items` (40 แถว) แล้วให้ฟังก์ชันเหล่านี้ **คงเป็น sync** อ่านจาก refs: `wf.stepOf` `wf.allSteps` `wf.activeSteps` `wf.statusText` `wf.selfSign` `features.isOn(null, key)` และส่วนอ่าน rubric ใน `needsScore`
   - เหตุผล: template เรียกและรอไม่ได้ (`views/partials/top.ejs` 16 ทุกหน้า · `views/partials/status.ejs` 1 ที่อยู่ในลูปของ `detail.ejs` 247 `my.ejs` 37 `notes.ejs` 38 `registry.ejs` 77 · `views/detail.ejs` 9 19 291 · `views/profile.ejs` 9 · `views/verify.ejs` 12 · `views/partials/eval_page.ejs` 9 ในลูป `print_pa.ejs` 64) · **ห้ามแก้ template**
   - `await db.ensureRefs()` ที่ทางเข้าแบบ async ทุกทาง (middleware · cron · ทดสอบ · seed) · ฟังก์ชัน sync ที่ถูกเรียกตอนยังไม่มี refs ให้ **โยน error ชัด ๆ** ไม่คืนค่าว่างเงียบ ๆ
   - `setSetting()` และการเขียน `workflow_steps` `rubric_items` ต้อง **ล้าง refs** ของคำขอนั้น (`tests/workflow.test.js` 109 126 ตั้ง `ff_selfsign` แล้วเรียก wf ต่อทันที)
3. **ล็อกแถว** SQLite เขียนทีละคำสั่ง Postgres ทำพร้อมกันได้ ใน `submit` `approve` `sendBack` `withdraw` `submitAs` `overrideStep` (`src/workflow.js` 198 222 256 285 310 328) คำสั่งแรกใน transaction ต้องเป็น `SELECT … FROM submissions WHERE id = ? FOR UPDATE` ไม่อย่างนั้นผู้ตรวจ 2 คนลงนามขั้นเดียวกันพร้อมกันจะผ่านทั้งคู่ (ทดสอบจริงได้บน Postgres จริงเท่านั้นในตอน 14 เพราะ PGlite มี session เดียว)
4. **รหัสผ่านในฐานข้อมูล** (ไม่กิน CPU ของ Workers): `hashPassword(pw)` → `select crypt(?, gen_salt('bf', 8)) as h` · `verifyPassword(pw, userId)` → `select password_hash = crypt(?, password_hash) as ok from users where id = ?` · ไม่ต้องรองรับรูปแบบ `scrypt$` เดิม (ไม่มีข้อมูลจริง) · กติกาความยาวขั้นต่ำเดิมคงไว้ (`auth.minPassword` 56 ถึง 63) · `loadUser` (`src/auth.js` 65 ถึง 74) **เลิกใช้ `u.*`** เลือกคอลัมน์ชัด ๆ ไม่เอา `password_hash` และ `signature`
5. **แก้ภาษา SQL ตามภาคผนวก A** จุดสำคัญในตอนนี้:
   - `src/teaching.js` 72 ถึง 75 upsert: ใน **นิพจน์** ใส่ชื่อตารางนำหน้า (`teach_subjects.subject_name` …) แต่ **ชื่อคอลัมน์หน้าเครื่องหมาย `=` ใน SET ห้ามใส่** · `MAX(is_main, excluded.is_main)` → `GREATEST(teach_subjects.is_main, excluded.is_main)` · จุดนี้รันทุกครั้งที่ครูบันทึกแผนหรือคู่มือ
   - `src/db.js` 361 368 `INSERT OR IGNORE`
6. **ตัวจับลืม `await`** สร้างในตอนนี้ ใช้ทุกตอนจนจบ:
   - `scripts/check-await.js`: ทุก `q.get(` `q.all(` `q.run(` `q.tx(` `getSettings(` `setSetting(` และฟังก์ชันที่กลายเป็น async ต้องมี `await` หรือ `return` นำหน้า · **ต้องจับแบบหลายบรรทัดด้วย** เช่น `q\n.all(` (`src/teaching.js` 63 ถึง 64 · `src/routes/work.js` 785 ถึง 786)
   - `tsconfig.check.json`: `allowJs` `checkJs` `noEmit` **`strictNullChecks: true`** (ถ้าปิด error "This condition will always return true since this 'Promise' is always defined" จะไม่ขึ้น) ส่วนที่เหลือไม่เข้มงวด · ให้ `q.*` คืน `Promise<any>` ผ่าน JSDoc · ดูเฉพาะ error เรื่อง Promise
7. `scripts/seed-demo.js` แปลงเป็น async · 126 183 261 ใช้ `RETURNING id` · 102 `LIKE` → `ILIKE` · ชื่อในข้อมูลทดลองยังเป็นชื่อสมมติ

**ผ่านเมื่อ:** `check-await` และ `tsc` สะอาดในไฟล์ของตอนนี้ · `tests/workflow.test.js` แปลงเป็น PGlite (7 `':memory:'` · 21 40 `lastInsertRowid`) แล้วผ่าน

---

## ตอน 6 · เส้นทางชุดแรก

**ไฟล์:** `src/app.js` · `src/routes/auth.js` `verify.js` `pages.js` `extras.js` `teaching.js` `ttimport.js`

1. middleware ใน `src/app.js` 88 ถึง 131 ทำงานทุกคำขอ แม้หน้าเข้าสู่ระบบและหน้าสแกน QR (`loadUser` 2 คำสั่ง · `getSettings` · `wf.inbox` · นับป้าย 3 คำสั่ง · `hasUsers()` ใน `src/routes/auth.js` 14 ถึง 17) → ใช้ refs · **รวมตัวนับป้าย 3 ตัวเป็นคำสั่งเดียว** · `hasUsers()` จำผลใน refs
2. callback แบบเก่า (`logoUpload(req, res, (err) => …)` ใน `src/routes/admin.js` · `uploader()` ใน `src/upload.js`) ต้องห่อ `try/catch` แล้ว `next(e)` เอง (Express 5 จับให้เฉพาะ handler แบบ async)
3. SQL ตามภาคผนวก A:
   - `SUM(status IN (…))` → `COUNT(*) FILTER (WHERE …)` ที่ `src/routes/pages.js` 163 · `src/routes/extras.js` 212
   - `CAST(plan_no AS INTEGER)` → `to_int_lenient(plan_no)` ที่ `src/routes/extras.js` 45 77 132 · `src/routes/pages.js` 200 335
   - `GROUP_CONCAT` → `string_agg` ที่ `src/routes/auth.js` 55
   - `LIKE` → `ILIKE … ESCAPE ''` ที่ `src/routes/pages.js` 328 (Postgres ถือ `\` เป็นตัว escape คำค้นที่ลงท้ายด้วย `\` จะ error)
   - `ORDER BY d.sort` → `NULLS FIRST` ที่ `src/routes/pages.js` 335
4. **`util.idParam()`** ตัวช่วยกลาง: ไม่ใช่จำนวนเต็ม หรือเกินช่วง integer (2,147,483,647) → 404 ก่อนส่งเข้าฐาน · ใช้ทั้ง `req.params` และ `req.query` (`src/routes/pages.js` 19 314 ถึง 316 · `src/routes/extras.js` 143 151 239 · `src/routes/admin.js` 70 394 และอีกราว 45 จุด) · เดิม SQLite ไม่เจอแถวแล้วเป็น 404 แต่ Postgres error 22P02 กลายเป็น 500
5. `src/routes/verify.js` `baseUrl()` 14 ถึง 24 (ที่อยู่ LAN และ `req.protocol`) → ใช้ `public_url` เป็นหลัก ถ้าว่างใช้ `https://` + host ของคำขอ · ไม่เรียก `os.networkInterfaces()` บน Workers

**ผ่านเมื่อ:** `check-await` และ `tsc` สะอาดในไฟล์ของตอนนี้ · `node --check` ผ่าน (ทดสอบแบบเปิดเว็บยังรันไม่ได้เพราะเรียก `/admin` ซึ่งแปลงในตอน 7 และไฟล์ทดสอบแปลงในตอน 8)

---

## ตอน 7 · เส้นทางชุดใหญ่ (`work.js` 890 บรรทัด · `admin.js` 709 บรรทัด)

1. แปลงเป็น async ทั้งสองไฟล์ ใช้ตัวจับลืม await
2. `lastInsertRowid` → `RETURNING id` ที่ `src/routes/work.js` 395 474 · `src/routes/admin.js` 181 358 · `src/routes/auth.js` 42
3. SQL ตามภาคผนวก A: `to_int_lenient(plan_no)` ที่ `src/routes/work.js` 423 (ใน MAX) 526 787 · `string_agg` ที่ `src/routes/admin.js` 373 · `ILIKE … ESCAPE ''` ที่ `src/routes/admin.js` 75 · `NULLS FIRST` ที่ `src/routes/admin.js` 84 414
4. **กันส่งงานซ้ำเมื่อกดสองครั้ง** ตอนนี้ตรวจงานซ้ำก่อนเริ่ม transaction (`src/routes/work.js` 363 ก่อน 376) → ย้ายเข้าใน transaction และคำสั่งแรกเป็น `select pg_advisory_xact_lock(<teacher_id>)`
5. error ที่จับด้วยข้อความของ SQLite (ถ้ามี) → `error.code` (`23505` ซ้ำ · `23503` foreign key)
6. `GET /admin/backup` (`VACUUM INTO` 693 ถึง 706) ให้ตอบข้อความว่ากำลังปรับปรุงไปก่อน แก้จริงในตอน 10
7. ข้อความ error ใน `src/pdf.js` 16 (ให้ปิดเปิดระบบใหม่) ไม่ตรงกับคลาวด์ จะถูกตัดในตอน 10 เมื่อย้ายการรวม PDF ไปเบราว์เซอร์

**ผ่านเมื่อ:** `check-await` และ `tsc` สะอาดทั้ง `src/` · `node --check` ผ่านทุกไฟล์

---

## ตอน 8 · ชุดทดสอบและโหมดทดลองกลับมาใช้ได้

1. ชุดทดสอบใช้ `db.q.*` แบบ sync ราว 170 จุด → `await` ทั้งหมด · ใช้ PGlite อินสแตนซ์เดียวแทน `DATA_DIR` + SQLite (ยังเปิดเว็บด้วย `createApp().listen(0)` + `fetch` แบบเดิม)
2. ทดสอบที่พึ่งดิสก์ (`tests/features.test.js` 211 ถึง 216 นับไฟล์ในโฟลเดอร์ uploads · `tests/round1.test.js` 154 อ่าน PDF ที่รวมแล้ว 168 แทรกแถว files เอง) ให้ผ่านแบบดิสก์ไปก่อน แล้วเปลี่ยนในตอน 10
3. `LIKE` ในทดสอบ (`tests/features.test.js` 124 155 159 341 342 362 · `tests/round1.test.js` 125 216 307) → `ILIKE` · `current_role` ในทดสอบราว 25 จุด → `"current_role"` · `tests/features.test.js` 95 ถึง 96 → `assert.rejects`
4. ทดสอบ lockout ใน `tests/login.test.js` ที่เรียก `auth.recordFail` ตรง ให้ปรับเป็น async (ตัวนับย้ายลงฐานในตอน 12)
5. `npm run demo` ใช้ PGlite ที่ `data-demo/pg` · `npm start` ใช้ `DATABASE_URL` ถ้ามี ไม่มีก็ `data-pg/` · **ห้ามแตะ `data/app.db` เดิม**
6. `src/config.js`: `DEMO = Boolean(process.env.DEMO)` เป็นจริงแม้ค่าเป็น `"0"` → ถือว่าเปิดเฉพาะ `DEMO === '1'` หรือ `--demo`

**ผ่านเมื่อ:**
- `npm test` ผ่านทั้งหมด ≥ 44 ข้อ · `check-await` และ `tsc` สะอาดทั้ง repo
- `npm run demo` ไล่รายการตรวจภาคผนวก C **ข้อ 2 ถึง 13 และ 16** ครบ (ข้อ 1 14 15 17 รอตอน 10 ถึง 12)
- ภาพหน้าจอหน้าหลักของ 3 บทบาทเทียบกับ `before-cloud` เหมือนเดิม (ไม่นับเวลาและข้อความ "x นาทีก่อน")

---

## ตอน 9 · ลดจำนวนคำสั่งและขนาดข้อมูลต่อหน้า

**ทำไม:** บน Supabase ทุกคำสั่งคือการเดินทางไปกลับราว 20 ถึง 50 ms และ Hyperdrive แบบฟรีให้ 100,000 คำสั่งต่อวัน

1. **ลายเซ็นหนักมาก** ลายเซ็นเป็นรูป PNG 960×320 (`views/partials/sigpad.ejs` 2) หรือรูปที่อัปโหลดถึง 400 KB (`src/routes/pages.js` 463) เก็บ 3 ที่: `users.signature` · `submissions.teacher_signature` (`src/workflow.js` 205) · `reviews.signature` ทุกครั้งที่ลงนาม (`src/workflow.js` 83 228) แล้วถูกดึงด้วย `SELECT *` ทั่วระบบ: `holders` `u.*` (`src/workflow.js` 51) · inbox `s.*` (383) · ทะเบียน `s.*` สูงสุด 3,000 แถว (`src/routes/pages.js` 332) · `reviewsOf` `*` (`src/workflow.js` 346) → **คำสั่งที่ดึงรายการต้องระบุคอลัมน์ชัด ไม่เอาลายเซ็น** ดึงลายเซ็นเฉพาะหน้ารายละเอียดและหน้าพิมพ์
2. ชั้น db นับคำสั่งต่อคำขอ โหมด dev log เมื่อเกิน 15 และมีทดสอบตรวจหน้าสำคัญ
3. จุดยิงฐานในลูปที่ต้องรวมเป็นคำสั่งเดียว (`WHERE id = ANY(?)` หรือ JOIN แล้วจัดกลุ่มใน JS):
   - `src/routes/extras.js` 187 ถึง 232 `boardRows` (ครูทุกคน × `q.all` + `teaching.list` + `q.get` 2 ครั้ง) ใช้ที่ 243 267 · 41 ถึง 46 `q.all` ต่อแผน
   - `src/routes/pages.js` `lastReturn` 195 ถึง 197 และ 205 ถึง 206 · 299 `inbox().map(needsScore)` · `setupWarnings` ถูกเรียก 2 รอบในหน้าหลัก (192 252)
   - `src/workflow.js` 354 ถึง 366 `progress()` เรียก `holders()` ต่อขั้น · 393 `rows.filter(canReview…)`
   - `src/routes/work.js` 792 ถึง 795 และ `src/routes/extras.js` 155 ถึง 159 `printData()` ต่องาน
   - `src/routes/admin.js` 87 `rolesOf` ต่อผู้ใช้ · 409 ถึง 417 `allSteps().map(… q.all …)` · 301 ถึง 362 นำเข้ารายชื่อ (`autoUsername` ในลูป)
   - `src/routes/ttimport.js` 79 ถึง 106 ราว 5 คำสั่งต่อวิชาต่อครู ใน transaction เดียว
   - ลงนามหลายงาน `src/routes/work.js` 864 ถึง 883 และ `src/routes/extras.js` 327 ถึง 336
4. ห้ามเปลี่ยนผลลัพธ์บนจอ ทดสอบเดิมต้องผ่าน

**ผ่านเมื่อ:** หน้าหลัก กล่องงาน ทะเบียน หน้าสถานะกลุ่มสาระ หน้าพิมพ์ แฟ้ม PA ใช้ไม่เกิน 15 คำสั่งต่อหน้า และไม่มีหน้ารายการไหนดึงลายเซ็น (บันทึกตัวเลขก่อนและหลังใน PROGRESS.md) · `npm test` ผ่าน

---

## ตอน 10 · ไฟล์ใน Google Drive + รวม PDF ในเบราว์เซอร์ + สำรองข้อมูล

### 10.1 ตั้งค่า Google (ครูเต้ยทำเอง Claude บอกทีละขั้น)
- **แนะนำให้ใช้บัญชี Google ของโรงเรียนที่ตั้งไว้สำหรับระบบโดยเฉพาะ** ถ้าใช้บัญชีครูคนใดคนหนึ่ง เมื่อครูคนนั้นย้ายหรือถูกลบบัญชี ไฟล์ทั้งหมดจะไปด้วย (ถามผู้ใช้ก่อน)
- Google Cloud Console ด้วยบัญชีนั้น: สร้างโปรเจกต์ · เปิด Google Drive API · หน้า OAuth consent ตั้ง User type เป็น **Internal** (ให้ refresh token ไม่หมดอายุทุก 7 วัน) · สร้าง OAuth client ชนิด Desktop app · สิทธิ์ (scope) **`https://www.googleapis.com/auth/drive.file` อย่างเดียว** (เห็นเฉพาะไฟล์ที่ระบบสร้าง)
- `scripts/google-auth.js`: เปิดเบราว์เซอร์ให้ครูเต้ยเข้าสู่ระบบด้วยบัญชีนั้น แล้วแสดง refresh token ในหน้าต่างของครูเต้ย ครูเต้ยนำไปใส่ใน `.dev.vars` (ในเครื่อง) และ `wrangler secret put` (ตอน 14) เอง พร้อม `GDRIVE_CLIENT_ID` `GDRIVE_CLIENT_SECRET`
- ทางสำรองถ้าผู้ดูแล Google ของโรงเรียนไม่อนุญาต: service account + Shared Drive (ต้องให้ผู้ดูแลเพิ่ม service account เข้า Shared Drive และเซ็น JWT แบบ RS256 ด้วย WebCrypto) ถามผู้ใช้ก่อนเปลี่ยน

### 10.2 `src/storage.js` 2 แบบ หน้าตาเดียวกัน
`startUpload({ name, mime, size, folderPath })` · `putChunk(session, stream, contentRange)` · `get(fileId, { range }) → stream + headers` · `head(fileId)` (ชื่อ ขนาด ชนิด) · `trash(fileId)`
- `local` โฟลเดอร์ `data-files/` (ทดสอบและพัฒนา)
- `gdrive`: ขอ access token ด้วย refresh token (จำไว้ในหน่วยความจำจนใกล้หมดอายุ) · สร้างโฟลเดอร์ตาม `src/drivepath.js` (ภาคเรียน / กลุ่มสาระ / ชื่อครู / ชนิดงาน ใต้โฟลเดอร์หลัก `ระบบส่งแผนการสอน`) เมื่อยังไม่มี · จำ id โฟลเดอร์ในตาราง `drive_folders (path text primary key, folder_id text)` · อัปโหลดแบบ resumable · ลบใช้ **ย้ายไปถังขยะ** (กู้คืนได้ 30 วัน) ไม่ลบถาวร
- คอลัมน์ `files.stored_name` เก็บ `gdrive:<fileId>` หรือ `local:<path>`

### 10.3 อัปโหลด: เซิร์ฟเวอร์ไม่แตะเนื้อไฟล์ทั้งก้อน
1. **รวม PDF ในเบราว์เซอร์** ด้วย pdf-lib (คัดลอก `node_modules/pdf-lib/dist/pdf-lib.min.js` ไว้ใน static) เรียงตามลำดับที่ครูจัด ตรรกะเดียวกับ `src/pdf.js` (ไฟล์ตั้งรหัส ไฟล์เปิดไม่ได้ ใช้ข้อความ error เดิม) แยกเป็นไฟล์ที่ใช้ได้ทั้งเบราว์เซอร์และ Node เพื่อทดสอบ แล้ว **เลิกรวม PDF บนเซิร์ฟเวอร์**
2. ฟอร์ม `js-upload` เดิม (`public/js/app.js` 79 ถึง 110 ส่งด้วย XHR พร้อมแถบความคืบหน้า) เปลี่ยนเป็น:
   - `POST /upload/start` ส่งชื่อ ขนาด ชนิด และงานที่จะแนบ → เซิร์ฟเวอร์ตรวจสิทธิ์ ขนาด (`max_upload_mb` ค่าเดิม 100 ใช้ได้ เพราะไม่ผ่านหน่วยความจำ) แล้วสร้าง resumable session ที่ Drive เก็บ session URI ไว้ในตาราง `pending_uploads (token, user_id, session_uri, name, mime, size, drive_file_id, status, created_at)` **ไม่ส่ง session URI ให้เบราว์เซอร์** ตอบกลับเป็น token
   - เบราว์เซอร์ส่งไฟล์เป็นท่อน 5 MiB (ทวีคูณของ 256 KiB) ไปที่ `PUT /upload/:token` พร้อม `Content-Range` · เส้นทางนี้ **ไม่ผ่านตัวอ่าน body** ส่งต่อเข้า Drive ทันทีด้วย `Readable.toWeb(req)` (พิสูจน์แล้วในตอน 1 ข้อ 7) · ท่อนสุดท้าย Drive ตอบ id ของไฟล์ เก็บลง `pending_uploads`
   - แถบความคืบหน้ารวมทุกท่อนทุกไฟล์ หน้าตาเหมือนเดิม
   - ส่งฟอร์มเดิมแบบ urlencoded พร้อม token ของไฟล์ (ชื่อช่องใหม่ขึ้นต้น `upload_` ห้ามใช้รูปแบบ `ชื่อ[...]`)
3. เส้นทางบันทึก (`POST /works` 354 · `POST /notes` 443 · `POST /s/:id` 585) รับ token แทนไฟล์: ตรวจว่าเป็นของผู้ใช้ อัปโหลดครบ ยังไม่ถูกใช้ · ตรวจชนิดไฟล์ (สวิตช์ `filecheck`) โดยอ่าน 8 ไบต์แรกจาก Drive ด้วย header `Range` · บันทึกแถว `files` ใน transaction · ถ้าตรวจไม่ผ่านหรือ transaction ล้ม ให้ย้ายไฟล์ Drive เหล่านั้นไปถังขยะ · **ห้ามเรียก Drive ระหว่าง transaction ค้าง** (เดิม `saveFiles` อยู่ใน transaction ที่ `src/routes/work.js` 376 ถึง 399 457 ถึง 477 597 ถึง 647)
4. ไฟล์ที่ถูกแทน (`is_current = 0` ที่ `src/routes/work.js` 636 ถึง 645) เก็บไว้เหมือนเดิม · ลบงาน (682) ย้ายไฟล์ไปถังขยะ **หลัง** transaction สำเร็จ
5. ลบ multer ออกจากเส้นทางส่งงาน (ยังใช้กับโลโก้ 1 MB ในหน้าตั้งค่าและไฟล์ `งานล่าสุด.json` ได้ เพราะเล็ก) · `src/upload.js` `badFiles()` `storedPath` `relStored` `removeStored` แทนด้วยของใหม่

### 10.4 เปิดไฟล์
`/f/:id` (704) `/f/:id/raw` (717) `/f/:id/view` อ่านด้วย `storage.get` แล้วส่งต่อเป็นสตรีม · header เดิมทุกตัว (`Content-Type` `Content-Disposition` `Cache-Control` · `/raw` ตั้งใจส่งเป็น `application/x-lesson-file` กันโปรแกรมช่วยดาวน์โหลดดักไฟล์) · **ปิด ETag** ของเส้นทางไฟล์ (Express คำนวณ SHA-1 ของทั้งไฟล์ กิน CPU)

### 10.5 สำรองข้อมูล
- `GET /admin/backup` → JSON ทุกตาราง **ให้ Postgres สร้าง JSON** (`select coalesce(json_agg(t), '[]')::text from (select * from users) t` ทีละตาราง ตัวแปลงชนิด json เป็นสตริงดิบจากตอน 4) แล้วต่อสตริงส่งออก ไม่ parse ใน JS · ชื่อไฟล์ `สำรองข้อมูลระบบส่งแผน_YYYY-MM-DD.json` ปุ่มเดิม ข้อความบนหน้าบอกว่าไฟล์งานอยู่ใน Google Drive (เสนอข้อความให้ผู้ใช้ก่อน)
- cron ทุกคืน 02:00 เวลาไทย สำรองแบบเดียวกันเข้าโฟลเดอร์ `สำรองข้อมูล` ใน Drive เก็บ 30 ฉบับล่าสุด
- cron ทุกชั่วโมง ย้าย `pending_uploads` ที่ค้างเกิน 1 วันไปถังขยะ

### 10.6 ทดสอบ
ทดสอบอัตโนมัติใช้ `local` ทั้งหมด: อัปโหลดเป็นท่อนแล้วดาวน์โหลดได้ไบต์ตรง · รวม 3 ไฟล์ได้ PDF เดียวเรียงถูก · ไฟล์ปลอมนามสกุลถูกปฏิเสธ · token ของคนอื่นใช้ไม่ได้ · ลบงานแล้วไฟล์อยู่ในถังขยะ · ไฟล์เกินเพดานถูกปฏิเสธพร้อมข้อความไทย · สำรองข้อมูลได้ JSON ครบ 13 ตารางและ parse ได้
ทดสอบ Drive จริง (ต้องมีบัญชีจาก 10.1): `scripts/drive-check.js` อัปโหลด 30 MB เป็นท่อน ตรวจโฟลเดอร์ เปิดไฟล์ ย้ายไปถังขยะ

**ผ่านเมื่อ:** ทดสอบอัตโนมัติผ่าน · `drive-check` ผ่านกับบัญชีจริง (ถ้าครูเต้ยยังไม่พร้อม จดค้างไว้ไปทำในตอน 14) · ค้น `fs.` `sendFile` `res.download` `diskStorage` ใน `src/` เหลือเฉพาะ `storage.js` แบบ local และโค้ดเฉพาะ Node

---

## ตอน 11 · บังคับเวลาไทย

**ทำไม:** Workers และ Supabase ใช้ UTC เวลาในเอกสารราชการจะคลาด 7 ชั่วโมง เที่ยงคืนถึง 7 โมงเช้าจะได้วันที่ของเมื่อวาน และ **ช่วงเปิดรับส่งงานจะปิดช้าไป 7 ชั่วโมง**

1. `src/time.js`: `nowStr()` (รูปแบบเดิม) · `todayStr()` · `parseLocal(str)` (สตริงในฐานเป็นเวลา +07:00) · `bangkokParts()` ทั้งหมดใช้ `Intl.DateTimeFormat` + `timeZone: 'Asia/Bangkok'` · **ห้ามคำนวณเวลาที่ระดับบนสุดของโมดูล** (บน Workers `Date.now()` ตรงนั้นได้ 0)
2. แทนทุกจุด:
   - `nowStr()` `src/db.js` 387 ถึง 390 ใช้บันทึกเวลาทุกตาราง (features 72 · workflow 84 111 202 266 294 314 · admin 179 356 696 · auth 40 103 · extras 64 273 · work 109 373 454 592 · line 14 47) → ย้ายไป `src/time.js` จุดเรียกไม่ต้องเปลี่ยน
   - ช่วงเปิดรับส่งงาน `src/routes/work.js` 155
   - `util.ago()` `src/util.js` 26 ถึง 38 (ใช้ที่ `views/home.ejs` 32 157 · `views/inbox.ejs` 28 · `src/routes/extras.js` 230)
   - `util.daysUntil()` `src/util.js` 41 ถึง 45 (ใช้ที่ `src/routes/pages.js` 251 · `src/routes/extras.js` 255)
   - ปีการศึกษาเริ่มต้น `src/db.js` 331 (คำนวณตอนโหลดโมดูล บน Workers จะได้ 2513) → คำนวณตอนเรียก
   - เวลาส่ง LINE `src/line.js` 47 ถึง 49 · ชื่อโฟลเดอร์ภาคเรียนใน Drive
   - ข้อมูลทดลอง `scripts/seed-demo.js` 100 251
3. `util.thaiDate` `util.thaiDateTime` อ่านสตริงอย่างเดียว ถูกอยู่แล้ว · ฝั่งเบราว์เซอร์ไม่ต้องแก้

**ผ่านเมื่อ:** ทดสอบที่ตั้ง `process.env.TZ = 'UTC'` ก่อนโหลดโมดูลแล้ว `nowStr()` `daysUntil()` `ago()` และช่วงเปิดรับส่งเป็นเวลาไทย · `npm test` ผ่านทั้ง `TZ=UTC` และ `TZ=Asia/Bangkok`

---

## ตอน 12 · ความปลอดภัยสำหรับเปิดสู่อินเทอร์เน็ต

เดิมเข้าได้แค่คนใน Wi-Fi โรงเรียน ต่อจากนี้ใครในโลกก็เปิดหน้าเข้าสู่ระบบได้

1. **กุญแจ session** `secretKey()` (`src/app.js` 16 ถึง 26 เขียนไฟล์ `data/secret.key` และสุ่มค่า) → env `SESSION_SECRET` (บังคับเมื่อ `APP_ENV=production`) · บน Node ยังใช้ไฟล์ได้แต่ย้ายไป `data-pg/`
2. **cookie `secure: true` เมื่อ production** ต้องคู่กับการเติม `x-forwarded-proto` และ `trust proxy` บน Workers (ตอน 1 ข้อ 4 · ตอน 13) ไม่อย่างนั้นทุก Set-Cookie error · ทดสอบบน Node ส่ง header นี้เอง · `wrangler dev` ใช้ `APP_ENV=development` ใน `.dev.vars`
3. **หน้าตั้งค่าครั้งแรก `/setup`** ใครเปิดก่อนได้เป็นผู้ดูแลระบบ (`src/routes/auth.js` 14 ถึง 45) → production ต้องกรอก `SETUP_TOKEN` (env secret ที่ผู้ใช้ตั้ง) ในฟอร์ม
4. **โหมดทดลอง** กดเข้าได้ทุกบทบาทรวมผู้ดูแลระบบ ฝังรหัส `demo1234` ในหน้า (`src/routes/auth.js` 48 ถึง 61 · `views/login.ejs` 45 · `public/js/app.js` 910 ถึง 921) → เปิดได้เฉพาะ `DEMO=1` **และไม่ใช่** production บังคับในโค้ด
5. **เลือกชื่อ (`namepick`) และรหัส 4 หลัก (`pin`) คงไว้ตามที่ครูเต้ยต้องการ** ค่าเริ่มต้นเปิดเหมือนเดิม ไม่ลบ ไม่เพิ่มคำเตือน · ชดเชยด้วยตัวกันเดารหัสที่แน่นขึ้นในข้อ 6
6. **ตัวกันเดารหัส** `attempts` เป็น `Map` ในหน่วยความจำ (`src/auth.js` 20 ถึง 54) ใช้ไม่ได้บน Workers → ตาราง `login_attempts` กติกาเดิม (ผิด 8 ครั้งต่อ IP + ชื่อผู้ใช้ และ 20 ครั้งต่อชื่อผู้ใช้ ใน 10 นาที) · IP จาก `CF-Connecting-IP` · ทบทวน `app.set('trust proxy', 'loopback')` (`src/app.js` 37) ถ้า IP ว่างทุกคำขอ คนนอกล็อกบัญชีใครก็ได้
7. **ตัวกันฟอร์มจากเว็บอื่น** (`src/app.js` 73 ถึง 86) ปล่อยผ่านเมื่อไม่มี `Origin` → production ถ้าไม่มี `Origin` ให้ตรวจ `Referer` ถ้าไม่มีทั้งคู่ปฏิเสธ POST · ทดสอบฟอร์มทุกแบบรวมอัปโหลดเป็นท่อนบน Chrome Edge Safari
8. **ไม่ส่งรหัสลับเข้า template** `res.locals.settings` (`src/app.js` 103) มี `line_token` → ตัดออก และส่ง `line_token_set` (จริงหรือเท็จ) แทน ให้ `views/admin/features.ejs` 139 ใช้แสดงช่องว่าตั้งแล้ว
9. header `Strict-Transport-Security` เมื่อ production (header เดิมคงไว้)
10. ทบทวน `db/supabase-lockdown.sql` ให้ครบทุกตาราง รวมตารางใหม่

**ผ่านเมื่อ:** ทดสอบใหม่ผ่าน: production ไม่มี `SESSION_SECRET` แล้วไม่เปิด · `/setup` ไม่มี `SETUP_TOKEN` ถูกปฏิเสธ · production เปิดโหมดทดลองไม่ได้แม้ตั้ง `DEMO=1` · ผิด 8 ครั้งแล้วล็อก และยังล็อกหลังสร้างแอปใหม่ · cookie มี `Secure` · template ไม่เห็น `line_token` · ภาคผนวก C ข้อ 1 และ 17 ผ่าน

---

## ตอน 13 · ปรับให้รันบน Workers (จำลองในเครื่อง)

1. **`wrangler.jsonc`**: `main: "src/worker.mjs"` · `compatibility_date` วันที่ทำงาน · `compatibility_flags: ["nodejs_compat"]` · `assets: { directory: "dist/assets" }` · `hyperdrive: [{ binding: "HYPERDRIVE", id: "00000000000000000000000000000000", localConnectionString: "postgres://postgres:postgres@localhost:5433/postgres" }]` (id จริงใส่ตอน 14) · `triggers: { crons: ["*/5 * * * *", "0 * * * *", "0 19 * * *"] }` (LINE · ล้างไฟล์ค้าง · สำรองข้อมูลเวลา 02:00 ไทย) · `vars: { APP_ENV: "production" }` · `observability: { enabled: true }` · ไม่บังคับ `placement: { mode: "smart" }` ลองวัดก่อนและหลัง
2. **ไฟล์ static** สคริปต์ build คัดลอกไป `dist/assets/` ที่ URL เดิมตาม `src/app.js` 50 ถึง 59: `/static/*` ← `public/` · `/vendor/chart.js/*` · `/vendor/kanit/*` · `/vendor/sarabun/*` · `/vendor/fonts/*` (12 แพ็กเกจ 1,865 ไฟล์ 17 MB) · `/vendor/pdfjs/{legacy/build,cmaps,standard_fonts,wasm,iccs}/*` · pdf-lib (ตอน 10) · นับจำนวนไฟล์ (แบบฟรีไม่เกิน 20,000) และขนาด (ไฟล์ละไม่เกิน 25 MiB) จดใน PROGRESS.md · cache ตามเดิม (`maxAge` 0 7d 30d) ด้วยไฟล์ `_headers` · `express.static` คงไว้ใช้บน Node
3. **`assetVersion`** (`src/app.js` 33 `Date.now()`) → รหัสที่ build สร้าง
4. **`src/worker.mjs`**: `import { env } from 'cloudflare:workers'` + `handleAsNodeRequest` จาก `cloudflare:node` · **สร้างแอปตอนคำขอแรกใน `fetch()`** ไม่สร้างที่ระดับบนสุด · ใน `fetch()` เติม header `x-forwarded-proto` จาก `request.url` · `export default { fetch(request, env, ctx) { … return handleAsNodeRequest(3000, request2) }, scheduled(controller, env, ctx) { ctx.waitUntil(runCron(controller.cron)) } }` · `runCron` เปิด db scope + `ensureRefs()` ก่อนเรียกงาน
5. **ฐานข้อมูลบน Workers** `db.requestScope` สร้าง `pg.Client` จาก `env.HYPERDRIVE.connectionString` ต่อคำขอ เชื่อมเมื่อมีคำสั่งแรก ปิดเมื่อคำขอจบ (ถ้าตอน 1 ข้อ 6 พบว่าส่ง `ctx` เข้าแอปได้ ให้ปิดใน `ctx.waitUntil`) · **ไม่รัน `migrate()` ตอนเริ่ม** (`src/app.js` 29 เดิมรันทุกครั้ง)
6. **LINE** แยก `line.tick()` (ตรรกะเดิม) ออกจาก `setInterval` (`src/line.js` 43 ถึง 60) · Node `server.js` เรียก `tick()` ทุกนาทีเหมือนเดิม · Workers ใช้ cron ทุก 5 นาที (เวลาส่งคลาดได้ไม่เกิน 5 นาที แจ้งผู้ใช้)
7. **ของเฉพาะคอมเครื่องกลาง:** `server.js` ไม่ถูก import บน Workers · `src/routes/admin.js` 35 ถึง 39 และ 55 ถึง 57 (ที่อยู่ LAN พอร์ต โฟลเดอร์ข้อมูล) ห้ามเรียก `os.networkInterfaces()` บน Workers · ข้อความบนจอต่อไปนี้ต้องเสนอข้อความใหม่ให้ผู้ใช้เห็นชอบก่อน: `views/admin/index.ejs` 23 ถึง 31 (Wi-Fi และคัดลอกโฟลเดอร์ลงแฟลชไดรฟ์ทุกสัปดาห์) · `views/admin/settings.ejs` 41 · `views/admin/features.ejs` 135 · `views/admin/ttimport.ejs` 17 · `src/features.js` 11
8. `src/routes/auth.js` 48 require `scripts/seed-demo.js` ตอนรัน ลาก `fs` `zlib` เข้า bundle → ยอมได้ถ้า build ผ่าน แต่ต้องไม่ถูกเรียกบน production
9. **รันจำลองในเครื่อง:** `npx pglite-server --db=./data-dev/pg --port=5433` แล้ว `npm run build && npx wrangler dev` · ไฟล์ใช้ `local` หรือ `gdrive` กับบัญชีจริงจาก `.dev.vars` · ถ้า pglite-server ค้างเมื่อหลายคำขอพร้อมกัน ให้ใช้ connection string ของ Supabase โปรเจกต์ทดสอบที่ครูเต้ยสร้าง (Supabase ฟรีได้ 2 โปรเจกต์) ใน `.dev.vars`

**ผ่านเมื่อ:** `npx wrangler dev` ไล่รายการตรวจภาคผนวก C ครบ (ยกเว้นข้อที่ต้องใช้บัญชีจริง) · `npm test` ยังผ่าน · `npx wrangler deploy --dry-run` ผ่าน จดขนาด bundle · ค้นใน bundle แล้วไม่มี `require("ejs")`

---

## ตอน 14 · ขึ้นใช้งานจริง (แบบฟรีทั้งหมด)

**ครูเต้ยทำเรื่องบัญชีและรหัสลับเอง Claude บอกทีละขั้นและรอยืนยันทุกขั้น**

1. **Supabase โปรเจกต์ `plan-system` ที่ครูเต้ยสร้างไว้แล้ว** (Singapore · ปิดการเปิดตารางใหม่อัตโนมัติ · เปิด RLS อัตโนมัติ) · ใน SQL Editor รัน `db/schema.sql` → `db/seed.sql` → `db/supabase-lockdown.sql` · **แนะนำปิด Data API** (Settings → API) เพราะระบบไม่ได้ใช้ ลดช่องทางเข้าถึง
2. คัดลอก **Direct connection string** (เอกสาร Cloudflare ระบุให้ใช้ตัวนี้กับ Hyperdrive) · ถ้า Hyperdrive ต่อไม่ได้ (การเชื่อมต่อตรงของ Supabase แบบฟรีอาจเป็น IPv6 อย่างเดียว) ให้ใช้ pooler แบบ **Session mode** ห้ามใช้ Transaction mode
3. **Cloudflare:** สร้างบัญชี · `npx wrangler login` · `npx wrangler hyperdrive create plan-db --connection-string="…" --caching-disabled` (**ต้องปิด caching** ค่าเริ่มต้นจำผลการอ่าน 60 วินาที ลงนามแล้วกล่องงานจะยังแสดงงานเดิม) แล้วใส่ id ใน `wrangler.jsonc`
4. `npx wrangler secret put` ทีละตัว: `SESSION_SECRET` `SETUP_TOKEN` `GDRIVE_CLIENT_ID` `GDRIVE_CLIENT_SECRET` `GDRIVE_REFRESH_TOKEN` (ครูเต้ยวางเอง)
5. `npm run build && npx wrangler deploy` หรือผูก GitHub กับ Workers Builds (build `npm run build` · deploy `npx wrangler deploy`)
6. เปิด `*.workers.dev` → `/setup` กรอก SETUP_TOKEN สร้างผู้ดูแลระบบ → ตั้ง `public_url` (QR ใช้ค่านี้)
7. ไล่รายการตรวจภาคผนวก C บนเว็บจริงด้วยบัญชีทดลอง 3 บทบาท (ชื่อสมมติ) · `scripts/drive-check.js` กับบัญชีจริง (ถ้าค้างจากตอน 10) · **ทดสอบลงนามพร้อมกัน** สคริปต์ยิงลงนามขั้นเดียวกัน 2 คำขอพร้อมกัน ต้องผ่านแค่ 1 · **ทดสอบว่า anon key อ่านตารางไม่ได้** · แล้วลบบัญชีทดลองและไฟล์ทดลองใน Drive
8. **วัด CPU** ดู CPU time ต่อคำขอใน Cloudflare dashboard (Observability) ทุกหน้าในรายการตรวจ · ถ้ามีหน้าไหนเจอ error เกิน CPU (1102) ให้แก้ตามภาคผนวก F **ห้ามเปลี่ยนไปแบบเสียเงินเอง** ต้องถามผู้ใช้
9. **Supabase แบบฟรีพักโปรเจกต์เมื่อไม่มีการใช้งาน 1 สัปดาห์** (หน้าราคา Supabase 5 ต.ค. 2569) ช่วงปิดภาคเรียนเว็บจะเข้าไม่ได้จนกว่าจะกดเปิดกลับ · cron อ่านฐานทุก 5 นาทีและสำรองทุกคืนอยู่แล้ว อาจนับเป็นการใช้งาน แต่ **ยังไม่ยืนยัน** ให้เช็คนิยามล่าสุดแล้วแจ้งผู้ใช้ ถ้าไม่พอ ครูเต้ยกดเปิดกลับเองเมื่อเปิดเทอม (ข้อมูลไม่หาย)

**ผ่านเมื่อ:** รายการตรวจภาคผนวก C ผ่านบนเว็บจริง · ไม่มี error ใน Logs · ไม่มีหน้าไหนเกิน CPU · ผู้ใช้ยืนยันว่าใช้ได้

---

## ตอน 15 · เก็บงาน เอกสาร กฎใหม่

1. `README.md` เขียนใหม่แบบคลาวด์: รันในเครื่อง (`npm test` `npm run demo`) · ขึ้นเว็บ · บัญชีที่ต้องมี · ค่าใช้จ่าย (ฟรี) · ตัดวิธีติดตั้งบนคอมเครื่องกลาง ส่วนสำรองข้อมูล (105 ถึง 110) และเข้าจากเครื่องอื่นใน Wi-Fi (84 ถึง 88)
2. ไฟล์ `.bat` 2 ไฟล์ `.command` 2 ไฟล์ `scripts/make-install-zip.js` `scripts/pdf-to-png.ps1` ไม่จำเป็นแล้ว แต่ `CLAUDE.md` มีกฎเรื่องไฟล์คู่นี้ → **ถามผู้ใช้ก่อนลบ**
3. `CLAUDE.md` เพิ่มกฎใหม่: ฐานข้อมูล async ต้อง `await` (รัน `check-await` และ `tsc` ก่อนรายงาน) · `"current_role"` ครอบเครื่องหมายคำพูดใน SQL · ห้ามยิงฐานในลูป ห้าม `SELECT *` ในหน้ารายการ · ห้าม `fs` `child_process` ในโค้ดแอป ไฟล์ผ่าน `src/storage.js` · เวลาผ่าน `src/time.js` ห้ามคำนวณเวลาหรือสุ่มที่ระดับบนสุดของโมดูล · แก้ `views/` แล้ว `npm run build` · ห้ามแพ็กเกจที่ใช้ `eval` หรือ `new Function` ตอนรัน · งาน CPU หนักทำในเบราว์เซอร์หรือในฐานข้อมูล · ทดสอบทั้ง `TZ=UTC` · แก้กฎเดิมที่ไม่จริงแล้ว
4. ลบ `spike/`
5. ไม่บังคับ: ให้ตัวช่วยตรวจทาน diff `before-cloud..cloud` เทียบกับแผนนี้
6. merge `cloud` เข้า `main` เมื่อผู้ใช้อนุมัติ

---

## ข้อเสนอเรื่องเข้าสู่ระบบ (ไม่อยู่ในแผนนี้ ไว้คุยกันทีหลัง)

ครูเต้ยบอกว่าระบบเข้าสู่ระบบอาจเปลี่ยนภายหลัง แผนนี้จึงคงระบบเดิมไว้ก่อน (ตอน 5 ข้อ 4 และตอน 12) ทางเลือกในอนาคต:

| ทาง | ดี | ข้อจำกัด |
|---|---|---|
| **คงระบบเดิม** (แนะนำ) | เลือกชื่อ + รหัส 4 หลักได้ ครูที่ไม่คุ้นเคยกับเทคโนโลยีใช้ง่าย · รหัสผ่านก็อยู่ใน Supabase แล้ว | ต้องดูแลตัวกันเดารหัสเอง |
| **เข้าด้วยบัญชี Google ของโรงเรียน** | ครูทุกคนมีบัญชีอยู่แล้ว ไม่ต้องจำรหัสใหม่ · ใช้ Google OAuth ได้โดยตรง หรือผ่าน Supabase Auth | ครูต้องเข้าบัญชี Google บนเครื่องที่ใช้ · ต้องผูกบัญชีกับรายชื่อครูในระบบ |
| Supabase Auth แบบรหัสผ่าน | มีระบบลืมรหัสผ่าน | ต้องใช้อีเมลหรือเบอร์โทร รหัสขั้นต่ำ 6 ตัว **ใช้รหัส 4 หลักไม่ได้** |

---

## ภาคผนวก A · ตารางแปลงภาษา SQL (SQLite → Postgres)

| SQLite (ของเดิม) | Postgres (ของใหม่) | หมายเหตุ |
|---|---|---|
| `?` | `$1 $2 …` | ชั้น `src/db.js` แปลงให้ |
| คอลัมน์ `current_role` | `"current_role"` | คำสงวนของ Postgres |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` | |
| `INSERT OR REPLACE` / `REPLACE INTO` | `INSERT … ON CONFLICT (คีย์) DO UPDATE SET col = excluded.col` | |
| คอลัมน์ในนิพจน์ของ `DO UPDATE SET x = … x …` | `t.x` ในนิพจน์ · ชื่อหน้า `=` ไม่ใส่ชื่อตาราง | |
| `lastInsertRowid` | `INSERT … RETURNING id` | |
| `lower(hex(randomblob(10)))` | ค่า default ของคอลัมน์ | |
| `PRAGMA …` · `VACUUM INTO` | ลบทิ้ง | |
| `COLLATE NOCASE` | `lower(col) = lower(?)` + unique index บน `lower(col)` | |
| `LIKE ?` | `ILIKE ? ESCAPE ''` | |
| `CAST(plan_no AS INTEGER)` | `to_int_lenient(plan_no)` | ฟังก์ชันใน `schema.sql` |
| `SUM(เงื่อนไข)` | `COUNT(*) FILTER (WHERE เงื่อนไข)` | |
| `MAX(a, b)` / `MIN(a, b)` แบบ 2 ค่า | `GREATEST` / `LEAST` | |
| `GROUP_CONCAT(x, sep)` | `string_agg(x, sep)` | |
| `ORDER BY col` ที่มีค่าว่างได้ | `ORDER BY col NULLS FIRST` | SQLite เอา NULL ขึ้นก่อน |
| เรียงข้อความ | คอลัมน์ `collate "C"` | เรียงแบบไบต์เหมือน SQLite |
| `WHERE flag` (0/1) | `flag = 1` | ไม่พบตอนร่าง ระวังเวลาแก้ |
| id ไม่ใช่จำนวนเต็มหรือเกินช่วง | `util.idParam()` ตอบ 404 | Postgres error 22P02 และ 22003 |
| `COUNT(*)` `SUM()` | number จากตัวแปลงชนิด | ห้ามลบตัวแปลงชนิด |
| error `UNIQUE constraint failed` | `error.code === '23505'` | |
| error `FOREIGN KEY constraint failed` | `error.code === '23503'` | |
| อ่าน ตรวจ แล้วเขียน | `SELECT … FOR UPDATE` ใน transaction | |
| `SELECT *` ในหน้ารายการ | ระบุคอลัมน์ ไม่เอาลายเซ็นและรหัสผ่าน | ลายเซ็นแถวละหลายร้อย KB |

---

## ภาคผนวก B · ปัญหาที่เจอในโค้ดจริง พร้อมวิธีแก้

🔴 = ไม่แก้แล้วระบบพังหรือข้อมูลผิด · 🟠 = ช้า เปลือง หรือเสี่ยง · รายละเอียดตำแหน่งอยู่ในตอนที่อ้าง

| # | ปัญหา | ทำไม | แก้ที่ |
|---|---|---|---|
| B1 🔴 | EJS ใช้ `new Function` ตอน import และ compile | Workers ห้าม แค่ import ก็พัง | ตอน 3 |
| B2 🔴 | template เรียก `wf.stepOf` `wf.statusText` ที่ยิงฐาน บางจุดในลูปถึง 3,000 แถว | template รอ async ไม่ได้ | ตอน 5 ข้อ 2 |
| B3 🔴 | คอลัมน์ `current_role` | คำสงวนของ Postgres สร้างตารางไม่ได้ หรือได้ชื่อบทบาทฐานข้อมูลกลับมาแบบเงียบ | ตอน 4 |
| B4 🔴 | `CAST(plan_no AS INTEGER)` 8 จุด บนข้อความที่ครูพิมพ์ ยาวได้ 20 ตัว | Postgres error เมื่อว่าง ไม่ใช่เลข หรือล้น integer | ตอน 4 6 7 |
| B5 🔴 | `COUNT` `SUM` กลับมาเป็นสตริง | ลบกลุ่มสาระไม่ได้ตลอด (`admin.js` 400) · คำเตือนตั้งค่าไม่ขึ้น (`pages.js` 46) · ป้ายเมนูขึ้น "0" · LINE นับได้ "032" แทน 5 (`line.js` 20) | ตอน 4 ตัวแปลงชนิด |
| B6 🔴 | `lastInsertRowid` 10 จุด (`admin.js` 181 358 · `auth.js` 42 · `work.js` 395 474 · `seed-demo.js` 126 183 261 · `workflow.test.js` 21 40) | ได้ `NaN` ผูก id ผิดแบบเงียบ | ตอน 5 7 8 |
| B7 🔴 | SQL เฉพาะ SQLite: `SUM(เงื่อนไข)` 2 จุด · upsert `teaching.js` 72 ถึง 75 · `INSERT OR IGNORE` 3 จุด · `GROUP_CONCAT` 2 จุด · trigger `randomblob` และ `RAISE(ABORT)` · `PRAGMA` · `VACUUM INTO` | Postgres ไม่รู้จัก | ตอน 4 ถึง 7 |
| B8 🔴 | ชื่อผู้ใช้ `COLLATE NOCASE` · `LIKE` ไม่สนตัวพิมพ์ | Postgres แยกตัวพิมพ์ ครูพิมพ์ `Teacher` เข้าไม่ได้ | ตอน 4 6 7 |
| B9 🟠 | ลำดับการเรียงบนจอ (NULL และภาษาไทย) | Postgres เรียงต่างจาก SQLite | ตอน 4 6 7 |
| B10 🔴 | ลงนามพร้อมกันและกดส่งสองครั้ง | Postgres ทำหลายคำขอพร้อมกัน ผ่านทั้งคู่ได้ | ตอน 5 ข้อ 3 · ตอน 7 ข้อ 4 |
| B11 🔴 | ลายเซ็นหลายร้อย KB ถูกดึงด้วย `SELECT *` ทั่วระบบ รวมถึงทุกคำขอ (`loadUser` `u.*` ซึ่งดึง `password_hash` ด้วย) | หน้าเว็บช้า หน่วยความจำ 128 MB ฐาน 500 MB โตเร็ว | ตอน 5 ข้อ 4 · ตอน 9 ข้อ 1 |
| B12 🟠 | ยิงฐานในลูปหลายจุด และอย่างน้อย 7 คำสั่งทุกคำขอ | ไปกลับ Supabase ครั้งละ 20 ถึง 50 ms · โควตา Hyperdrive | ตอน 5 6 9 |
| B13 🟠 | โลโก้ base64 อ่านทุกคำขอและฝังทุกหน้า | เปลืองทุกคำขอ | ตอน 4 (`/media`) |
| B14 🔴 | เวลาเครื่องคือ UTC · ค่าที่คำนวณที่ระดับบนสุดของโมดูลได้ 0 | เอกสารคลาด 7 ชั่วโมง ช่วงรับส่งปิดช้า ปีการศึกษาเริ่มต้นเป็น 2513 | ตอน 11 |
| B15 🔴 | อัปโหลดเขียนดิสก์ เพดาน 100 MB × 10 ไฟล์ รวม PDF บนเซิร์ฟเวอร์ | ไม่มีดิสก์ หน่วยความจำ 128 MB CPU 10 ms | ตอน 10 |
| B16 🔴 | สำรองข้อมูลใช้ `VACUUM INTO` | Postgres ไม่มี | ตอน 10 ข้อ 5 |
| B17 🔴 | กุญแจ session เป็นไฟล์ และสุ่มตอนเริ่ม | Workers ไม่มีดิสก์ถาวร ห้ามสุ่มที่ระดับบนสุด ผู้ใช้หลุดตลอด | ตอน 12 ข้อ 1 |
| B18 🔴 | `secure: true` แล้ว `cookies` โยน error เมื่อ `req.protocol` ไม่ใช่ https | ทุก Set-Cookie พังบน Workers ในทดสอบ และใน `wrangler dev` | ตอน 1 ข้อ 4 · ตอน 12 ข้อ 2 · ตอน 13 ข้อ 4 |
| B19 🔴 | `/setup` เปิดให้คนแรก · โหมดทดลองกดเป็นผู้ดูแลได้และ `DEMO="0"` ถือว่าเปิด · ตัวกันเดารหัสอยู่ในหน่วยความจำ · ไม่มี `Origin` ก็ผ่าน · `line_token` เข้า template · anon key ของ Supabase | เปิดสู่อินเทอร์เน็ตแล้ว | ตอน 4 (lockdown) · ตอน 8 ข้อ 6 · ตอน 12 |
| B20 🔴 | LINE ใช้ `setInterval` | Workers ไม่มีโปรเซสค้าง | ตอน 13 ข้อ 6 |
| B21 🔴 | static จาก `node_modules` · `assetVersion` จาก `Date.now()` | ไม่มี `node_modules` บน Workers | ตอน 13 ข้อ 2 ถึง 3 |
| B22 🔴 | Hyperdrive จำผลการอ่าน 60 วินาทีโดยค่าเริ่มต้น | ลงนามแล้วหน้ายังแสดงสถานะเดิม | ตอน 14 ข้อ 3 |
| B23 🔴 | scrypt ในโปรแกรม (`src/auth.js` 6 ถึง 18 · เปลี่ยนรหัสรัน 3 ครั้ง) | เกิน CPU 10 ms ของแบบฟรี | ตอน 5 ข้อ 4 (`pgcrypto`) |
| B24 🔴 | PGlite มี session เดียว | คำขอพร้อมกันใน `npm run demo` จะเข้าไปอยู่ใน transaction ของกันและกัน | ตอน 4 ตัวล็อกกลาง |
| B25 🔴 | refs ค้างหลัง `setSetting` · ฟังก์ชันเพิ่มใหม่ค่าเริ่มต้นเปิดจะกลายเป็นปิดบนเว็บจริง | ผลผิดแบบเงียบ | ตอน 4 · ตอน 5 ข้อ 2 |
| B26 🔴 | `saveFiles` อยู่ใน transaction | เรียก Drive ระหว่างค้าง transaction · rollback แล้วไฟล์ค้าง | ตอน 10 ข้อ 3 |
| B27 🟠 | ETag ของไฟล์ใหญ่ | Express คำนวณ SHA-1 ทั้งไฟล์ กิน CPU | ตอน 10 ข้อ 4 |
| B28 🟠 | ตัวจับลืม await แบบหละหลวม | `strictNullChecks` ปิด หรือไม่จับหลายบรรทัด จะพลาดบั๊กที่ตั้งใจจับ | ตอน 5 ข้อ 6 |
| B29 🟠 | `window` เป็น locals จริง | ถ้าตัดชื่อ global ของเบราว์เซอร์ทิ้ง หน้าแรกพัง | ตอน 3 ข้อ 1 |
| B30 🟠 | `npm start` เดิมเก็บใน `data/` | ขัดกฎห้ามแตะ `data/` | ใช้ `data-pg/` `data-files/` |
| B31 🟠 | ข้อความบนจอที่อ้าง Wi-Fi แฟลชไดรฟ์ การเปิดระบบใหม่ | ไม่ตรงกับคลาวด์ | ตอน 13 ข้อ 7 (ผู้ใช้เห็นชอบก่อน) |

---

## ภาคผนวก C · รายการตรวจหน้าจอ (ใช้ตอน 8 · 13 · 14)

ทุกข้อต้องดูหน้าจอจริง และตรวจว่าข้อมูลเข้าฐานจริง

1. ฐานว่าง → เปิดเว็บแล้วพาไป `/setup` → สร้างผู้ดูแลระบบได้ (production ต้องกรอก SETUP_TOKEN)
2. ผู้ดูแลระบบ: ตั้งค่าโรงเรียน (ชื่อ ปีการศึกษา ภาค ช่วงวันรับส่ง ธีม) · อัปโหลดโลโก้และตราครุฑ เห็นบนหน้าเว็บ หน้าตั้งค่า และหน้าพิมพ์ · ลบโลโก้ได้
3. กลุ่มสาระ (ลบกลุ่มที่ไม่มีคนได้ ที่มีคนลบไม่ได้) · วางรายชื่อครูจาก Excel · ตั้งผู้ตรวจแต่ละระดับ · ขั้นตอนการตรวจ · แบบประเมิน · นำเข้ารายวิชาจาก `งานล่าสุด.json` (ไฟล์ทดลองไม่มีชื่อจริง)
4. หน้าฟังก์ชันเสริม เปิดปิดสวิตช์ได้ ประวัติขึ้นใน audit log · แก้หรือลบ audit log ตรงในฐานไม่ได้
5. ครู: เข้าระบบด้วยการเลือกชื่อ + รหัส 4 หลัก · ครั้งแรกถูกบังคับเปลี่ยนรหัสผ่าน · ชื่อผู้ใช้พิมพ์ตัวพิมพ์ต่างจากที่ตั้งก็เข้าได้ · เซ็นชื่อในข้อมูลส่วนตัว · เลือกรายวิชาที่สอนและวิชาหลัก
6. ครูส่งคู่มือรายวิชา (PDF เดียว) · ส่งแผนแบบรวม 3 ไฟล์ เรียงลำดับใหม่ก่อนรวม · ดูหน้าปกก่อนส่ง · แถบความคืบหน้าขยับถึง 100 · ไฟล์ผิดชนิดหรือเสียถูกปฏิเสธ · ไฟล์เกินเพดานถูกปฏิเสธพร้อมข้อความไทย · กดส่งสองครั้งเร็ว ๆ ได้งานเดียว · (บนเว็บจริง) ไฟล์ไปอยู่ในโฟลเดอร์ Drive ที่ถูกต้อง
7. หัวหน้ากลุ่มสาระให้คะแนน 20 ข้อ (ระดับคุณภาพตามเกณฑ์ 90 70 50 30) แล้วลงนาม → ไล่ลงนามครบ 5 ระดับ · ส่งคืนแก้ไขแล้วครูส่งใหม่ · ผู้ตรวจลงนามงานของตัวเอง (สวิตช์ `selfsign`)
8. บันทึกหลังแผน: เขียนในระบบ (เลขแผนเว้นว่างหรือพิมพ์ตัวอักษรได้ไม่พัง) · ประโยคสำเร็จรูป · คัดลอกจากฉบับก่อน · แนบไฟล์ของตัวเอง · ลงนามแบบไล่การ์ด 3 ระดับ
9. พิมพ์บันทึกข้อความ แบบประเมิน บันทึกหลังแผน → จบใน 1 หน้า ฟอนต์ถูก QR อยู่มุม · สแกน `/v/รหัส` โดยไม่เข้าระบบแล้วเห็นผลตรวจ ลิงก์ใน QR เป็น `public_url`
10. เปิด PDF ในตัวแสดงในหน้าเว็บ (`/f/:id/view`) และดาวน์โหลด (`/f/:id?dl=1`) ชื่อไฟล์ภาษาไทยถูก
11. ผู้ดูแลระบบดำเนินการแทน (แก้ ส่งแทน ดันผ่านระดับ) บันทึกใน `reviews` action `override` และ `audit_log` · ดำเนินการแทนในงานของตัวเองไม่ได้
12. แจ้งเตือน · กล่องงานรอลงนาม · ตัวเลขบนเมนู (ไม่มีงานต้องไม่ขึ้น 0) · หน้าสถานะกลุ่มสาระ · ส่งเตือน · ผลการสอนของฉัน (กราฟ) · แฟ้มผลงาน PA · ทะเบียนและส่งออก CSV · หน้าสถิติ
13. โหมดกลางคืน ตัวใหญ่ หน้ามือถือ (แถบเมนูล่าง) บน Chrome Edge Safari iPhone iPad
14. สำรองข้อมูลได้ไฟล์ JSON ครบทุกตาราง
15. เวลาบนหน้าเว็บและในเอกสารเป็นเวลาไทย (เทียบนาฬิกาจริง) · ช่วงเปิดรับส่งปิดตรงเวลาไทย
16. ส่งข้อความทดลองเข้า LINE จากหน้าฟังก์ชันเสริม (ถ้ามีบัญชี LINE OA) ข้อความมีแต่จำนวน ไม่มีชื่อ
17. ออกจากระบบ · เข้าผิด 8 ครั้งแล้วถูกล็อก

---

## ภาคผนวก D · บัญชี โควตา (แบบฟรีทั้งหมด เช็คเมื่อ 5 ต.ค. 2569)

| บริการ | แบบฟรี | เกี่ยวกับระบบนี้ |
|---|---|---|
| Cloudflare Workers | 100,000 คำขอต่อวัน · **CPU 10 ms ต่อคำขอ** · หน่วยความจำ 128 MB · cron 5 ตัว · subrequest 50 ต่อคำขอ | ใช้ cron 3 ตัว · งานหนักย้ายไปเบราว์เซอร์และฐานข้อมูล (ภาคผนวก F) |
| Workers Static Assets | ไม่เกิน 20,000 ไฟล์ ไฟล์ละไม่เกิน 25 MiB · ไม่คิดค่าคำขอ | ฟอนต์ 1,865 ไฟล์ + PDF.js + Chart.js + pdf-lib |
| Hyperdrive | **100,000 คำสั่งต่อวัน** | หลังตอน 9 หน้าละไม่เกิน 15 คำสั่ง ครูไม่กี่คนเหลือเฟือ |
| Supabase | ฐานข้อมูล 500 MB · 2 โปรเจกต์ต่อบัญชี · **พักเมื่อไม่มีการใช้งาน 1 สัปดาห์** · ไม่สำรองข้อมูลให้ · มีโควตาข้อมูลขาออกต่อเดือน (เช็คตัวเลขล่าสุด) | เก็บแต่ข้อความ ไม่เก็บไฟล์ · ลายเซ็นไม่ถูกดึงในหน้ารายการ (ตอน 9) |
| Google Drive (Google Education ของโรงเรียน) | ตามโควตาของบัญชีที่ใช้ (ครูเต้ยแจ้ง 100 GB) | ไฟล์ทั้งหมด + สำรองข้อมูลทุกคืน |
| ขนาดคำขอ | 100 MB ต่อคำขอ (บัญชี Cloudflare แบบฟรี) | ไฟล์ส่งเป็นท่อน 5 MiB จึงไม่ติด |

---

## ภาคผนวก E · ทางสำรอง ถ้าตอน 1 พิสูจน์แล้ว Workers ไม่ไหว

ทุกทางสำรองต้องเสียเงิน จึง **ห้ามเปลี่ยนเอง ต้องถามผู้ใช้**
- **Cloudflare Containers** รัน Node.js ตัวจริง (ใส่ LibreOffice ได้) แต่ต้องใช้ Workers Paid ราว 5 ดอลลาร์ต่อเดือน ต้องมี Docker ตอนขึ้นเว็บ และคอนเทนเนอร์หลับเมื่อไม่มีคนใช้
- ตอน 2 ถึง 12 ยังต้องทำเหมือนเดิม (Postgres ไม่มีตัวต่อแบบ sync และดิสก์คอนเทนเนอร์ไม่ถาวร) เปลี่ยนแค่ตอน 13

---

## ภาคผนวก F · ทำให้อยู่ในโควตา CPU 10 ms ของแบบฟรี

ทำแล้วในแผน: รหัสผ่านใช้ `pgcrypto` ในฐาน (ตอน 5) · รวม PDF ในเบราว์เซอร์ (ตอน 10) · ไฟล์ส่งต่อเป็นสตรีมไม่ parse (ตอน 10) · ปิด ETag ไฟล์ (ตอน 10) · JSON สำรองข้อมูลสร้างใน Postgres (ตอน 10) · ไม่ดึงลายเซ็นและโลโก้โดยไม่จำเป็น (ตอน 4 และ 9) · template compile ล่วงหน้า (ตอน 3)

ถ้าวัดในตอน 14 แล้วยังมีหน้าเกิน ให้แก้ตามลำดับนี้ แล้วรายงานผู้ใช้:
1. หน้าที่มี QR หลายตัว (พิมพ์หลายฉบับ แฟ้ม PA) → สร้าง QR ในเบราว์เซอร์ด้วย `qrcode` ตัวเดียวกัน (ผลเป็น SVG เหมือนเดิม)
2. ทะเบียน (สูงสุด 3,000 แถว) และส่งออก CSV → แบ่งหน้า หรือให้ Postgres สร้าง CSV เป็นสตริงทีเดียว
3. หน้าสถิติที่โหลดงานทั้งภาค (`src/routes/pages.js` 385 ถึง 389) → ให้ Postgres รวมผล (GROUP BY) แทนการวนใน JS
4. ถ้ายังไม่พอ แจ้งผู้ใช้พร้อมตัวเลข CPU ของหน้านั้น ผู้ใช้ตัดสินใจเอง

---

## การตรวจรับทั้งโครงการ (Verification)

1. `npm test` ผ่านทั้งหมด ทั้ง `TZ=UTC` และ `TZ=Asia/Bangkok` (Node + PGlite) รวมทดสอบเทียบ HTML ของ template ที่ compile แล้ว
2. `node scripts/check-await.js` และ `npx tsc -p tsconfig.check.json` ไม่มี error เรื่อง Promise
3. หน้าสำคัญยิงฐานไม่เกิน 15 คำสั่งต่อหน้า และไม่มีหน้ารายการไหนดึงลายเซ็น
4. `npm run build && npx wrangler dev` ผ่านรายการตรวจภาคผนวก C
5. เว็บจริงบน `*.workers.dev` ผ่านรายการตรวจภาคผนวก C · Logs ไม่มี error · ไม่มีหน้าไหนเกิน CPU · ไฟล์อยู่ใน Drive ตามโฟลเดอร์ · anon key ของ Supabase อ่านตารางไม่ได้ · ลงนามพร้อมกันผ่านแค่ 1
6. ค้นทั้ง repo ไม่เจอรหัสลับ
7. หน้าตาเว็บเทียบกับ tag `before-cloud` เหมือนเดิมทุกหน้า ยกเว้นที่แผนสั่ง (2 ฟังก์ชันที่ตัด · สำรองข้อมูลเป็น JSON · ข้อความที่อ้างถึงคอมเครื่องกลาง) ซึ่งผู้ใช้เห็นชอบแล้ว

