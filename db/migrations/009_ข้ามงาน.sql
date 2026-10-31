-- รุ่น 9 (31 ต.ค. 2569) ข้ามงานนี้ไปก่อน (ฟังก์ชันเสริม skipwork) เฉพาะผู้ดูแลระบบ จำแยกตามบัญชี
-- รันซ้ำได้ไม่พัง · มีตารางใหม่ รัน db/supabase-lockdown.sql ซ้ำหลังรันไฟล์นี้
create table if not exists review_skips (
  user_id integer not null references users(id) on delete cascade,
  kind text collate "C" not null,
  submission_id integer not null references submissions(id) on delete cascade,
  skipped_at text collate "C" not null default '',
  primary key (user_id, kind, submission_id)
);
update schema_version set version = 9;
