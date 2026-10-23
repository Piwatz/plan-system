-- รุ่น 5 (23 ต.ค. 2569) โอนงานระหว่างครู (ฟังก์ชันเสริม transfer) แบบคงชื่อครูคนเดิมบนเอกสาร เก็บชื่อและตำแหน่งที่พิมพ์ไว้ที่งาน
-- รันซ้ำได้ไม่พัง · ไม่มีตารางใหม่ ไม่ต้องรัน supabase-lockdown.sql ซ้ำ
alter table submissions add column if not exists doc_name text collate "C" not null default '';
alter table submissions add column if not exists doc_position text collate "C" not null default '';
update schema_version set version = 5;
