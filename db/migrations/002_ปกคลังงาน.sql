-- รุ่น 2 (16 ต.ค. 2569) คลังงานการจัดการเรียนรู้: ช่องอ้างอิงรูปปกเล็กของแผนและคู่มือ (ตัวรูปอยู่ใน Google Drive)
-- รันซ้ำได้ไม่พัง
alter table submissions add column if not exists cover_ref text collate "C";
update schema_version set version = 2;
