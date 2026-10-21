-- รุ่น 3 (22 ต.ค. 2569) รายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก (ฟังก์ชันเสริม frontcheck): ผลตรวจหน้าแรกของไฟล์ PDF ที่เบราว์เซอร์ส่งมา
-- รันซ้ำได้ไม่พัง
alter table files add column if not exists front_check text collate "C";
update schema_version set version = 3;
