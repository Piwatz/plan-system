# ผลตอน 1 · ทดลองนำร่องบน Workers (5 ต.ค. 2569)

โฟลเดอร์ `spike/` แยกจากแอป ไม่แตะโค้ดแอป · wrangler 4.147.0 · workerd 1.20261001.1 · compatibility_date 2026-10-05 · `nodejs_compat` · express 5.2.1 · pg 8.23.1 · pglite-socket 0.2.11 · Node 24.19.0

วิธีรันซ้ำ (ใน `spike/`): `node build-views.mjs` · `node sink.mjs` · `npx pglite-server --port=5433 --max-connections=10` · `npx wrangler dev --local-protocol https --port 8787 --ip 127.0.0.1` · แล้ว `node check.mjs` และ `node cpu.mjs`

## ผล 10 ข้อ: ผ่าน 10 จาก 10

| # | ทดสอบ | ผล | หลักฐาน |
|---|---|---|---|
| 1 | Express 5 ผ่าน `handleAsNodeRequest` | ผ่าน | GET `/` ได้ 200 · สร้างแอปและ `listen(3000)` ตอนคำขอแรกใน `fetch()` · ยืนยันว่า `Date.now()` ที่ระดับบนสุดได้ **0** ตอนคำขอได้เวลาจริง |
| 2 | import `src/config.js` ตัวจริง | **ผ่านเมื่อใส่ตัวแก้** | แบบตรง ๆ Worker เปิดไม่ขึ้น `ReferenceError: __dirname is not defined` ที่ `src/config.js` (บันทึกไว้ใน `spike/wrangler-dirname-fail.log`) · ใส่ `"define": { "__dirname": "\"/bundle/src\"" }` ใน `wrangler.jsonc` แล้วได้ `ROOT=/bundle` `DATA_DIR=/bundle/data` |
| 3 | EJS compile ล่วงหน้า | ผ่าน | `error.ejs` + `partials/top` + `partials/bottom` · แบบไม่เข้าระบบ 3,075 ตัวอักษร · แบบเข้าระบบ (เมนูเต็ม) 13,419 ตัวอักษร · **ตรงกับ EJS บน Node ทุกไบต์ทั้งสองแบบ** · ไม่มีการกำหนดค่าให้ตัวแปรอิสระ · ไม่มี error code generation |
| 4 | `cookie-session` + `secure: true` | ผ่าน | เติม `x-forwarded-proto` ใน `fetch()` + `trust proxy` · `req.protocol=https` · Set-Cookie มี `Secure` · ส่ง cookie กลับแล้วนับต่อเป็น 2 |
| 5 | IP ผู้ใช้ | ผ่าน | `CF-Connecting-IP` = 127.0.0.1 · `req.ip` = 127.0.0.1 |
| 6 | `AsyncLocalStorage` | ผ่าน | store จาก middleware อยู่ครบหลัง `express.urlencoded` + `await` · **store ที่ตั้งใน `fetch()` ไปถึง handler** (ส่ง `ctx` เข้าแอปได้ ใช้กับตอน 13 ข้อ 5) |
| 7 | ส่งต่อข้อมูลดิบ 5 MB | ผ่าน | `Readable.toWeb(req)` + `duplex: 'half'` · ส่ง 5,242,880 ไบต์ ปลายทางได้ 5,242,880 ไบต์ sha256 ตรง · ส่งแบบ chunked |
| 8 | `pg` ผ่าน Hyperdrive ในเครื่อง | **ผ่านเมื่อใส่ตัวเลือกเพิ่ม** | ทีละคำขอได้ `select 1` · ยิงพร้อมกัน 5 คำขอด้วยคำสั่งในแผน (`--port=5433` อย่างเดียว) ได้ `Connection terminated unexpectedly` เพราะ pglite-server ค่าเริ่มต้นรับได้ 1 การเชื่อมต่อ · เพิ่ม `--max-connections=10` แล้วผ่านครบ 5 คำขอ (2.1 วินาทีในเครื่อง) |
| 9 | `qrcode` | ผ่าน | SVG บน Workers 1,568 ตัวอักษร ตรงกับ Node ทุกไบต์ |
| 10 | Static Assets | ผ่าน | `/hello.txt` ได้ 200 เนื้อหาถูก · ตัวนับคำขอของ Express ไม่ขยับ (ไม่ผ่าน Express) |

## เวลา CPU วัดบน Node (เทียบเพดาน 10 ms)

วัดด้วย `performance.now` (งาน sync เธรดเดียว) เพราะ `process.cpuUsage` บน Windows ละเอียดแค่ราว 15 ms · ครั้งแรก = ยังไม่อุ่นเครื่อง ใกล้กับคำขอแรกบน Workers

| งาน | ครั้งแรก | ค่ากลาง 15 รอบ | เทียบ 10 ms |
|---|---|---|---|
| render หน้าเต็ม + ตาราง 100 แถว (45 KB) | 1.6 ms | 0.2 ms | สบาย |
| สร้าง QR 20 ตัว | 18.4 ms | 7.3 ms | **เกินได้** (ภาคผนวก F ข้อ 1 รองรับไว้แล้ว) |
| `JSON.stringify` 2.09 MB | 16.3 ms | 9.1 ms | **เกินได้** (ตอน 10.5 ให้ Postgres สร้าง JSON อยู่แล้ว) |

ยังไม่ได้วัด: เวลาเริ่มแอปครั้งแรก (import Express และสร้างแอป) และ CPU จริงบน Cloudflare ต้องใช้บัญชีจริง

## สิ่งที่แผนไม่ได้คาดไว้ (รอผู้ใช้ตัดสิน)

1. **`__dirname` ไม่มีบน Workers** แอปพังตั้งแต่ import `src/config.js` แผนไม่ได้ระบุวิธีแก้ · ทางที่ลองแล้วได้ผล: `define` ใน `wrangler.jsonc` ไม่ต้องแก้โค้ดแอป
2. **คำสั่ง `npx pglite-server --port=5433` ในแผนรับได้ทีละ 1 การเชื่อมต่อ** · ทางที่ลองแล้วได้ผล: เติม `--max-connections=10` (ตอน 13 ข้อ 9 เตรียมทางสำรองเป็น Supabase โปรเจกต์ทดสอบไว้ แต่ยังไม่จำเป็น)

## หมายเหตุอื่น

- npm กันสคริปต์ติดตั้งของ `workerd` (allow-scripts) แต่ wrangler dev ทำงานปกติ
- `spike/dist/` `spike/.wrangler/` และไฟล์ log ไม่เก็บใน git
