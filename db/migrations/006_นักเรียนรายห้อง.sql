-- รุ่น 6 (24 ต.ค. 2569) จำนวนนักเรียนรายห้องของบันทึกหลังแผน (ฟังก์ชันเสริม noterooms)
-- เก็บเป็น JSON [{"room":"ม.5/1","total":38,"passed":30}] ว่าง = กรอกยอดรวมแถวเดียว ยอดรวมยังอยู่ที่ students_total students_passed
-- รันซ้ำได้ไม่พัง · ไม่มีตารางใหม่ ไม่ต้องรัน supabase-lockdown.sql ซ้ำ
alter table submissions add column if not exists student_rooms text collate "C" not null default '';
update schema_version set version = 6;
