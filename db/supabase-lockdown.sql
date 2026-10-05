-- รันเฉพาะบน Supabase (SQL Editor) หลัง schema.sql และ seed.sql ทุกครั้งที่เพิ่มตาราง
-- ระบบนี้ให้เซิร์ฟเวอร์ต่อฐานข้อมูลด้วยบทบาทเจ้าของตารางผ่าน Hyperdrive เท่านั้น เบราว์เซอร์ไม่คุยกับฐานข้อมูลตรง
-- จึงปิดประตูทั้งหมด: เปิด RLS ทุกตารางแบบไม่มี policy และถอนสิทธิ์ของ anon และ authenticated (กุญแจสาธารณะของ Supabase)

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end
$$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- ค่าเริ่มต้นของ Supabase ให้สิทธิ์ตารางใหม่แก่ anon ถอนไว้ก่อนสำหรับตารางที่จะสร้างภายหลัง
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ตรวจผล: แสดงตารางที่ยังไม่ปิด (ยังไม่เปิด RLS หรือ anon และ authenticated ยังมีสิทธิ์ใด ๆ) ไม่มีแถว = ปิดครบทุกตาราง
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and (not c.relrowsecurity
    or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
