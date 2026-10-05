// เวลาไทยเสมอ (ตอน 11): Workers และ Supabase ใช้ UTC ถ้าคิดเวลาตามเครื่อง เวลาในเอกสารจะคลาด 7 ชั่วโมง
// ตั้งเครื่องเป็น UTC ก่อนโหลดโมดูล แล้วตรวจว่าทุกจุดยังได้เวลาไทย
process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');

const time = require('../src/time');
const util = require('../src/util');
const db = require('../src/db');
const { DEFAULT_SETTINGS } = require('../src/defaults');
const { submitWindow } = require('../src/routes/work');

// 5 ต.ค. 2569 เวลา 20:30 UTC = 6 ต.ค. 2569 เวลา 03:30 น. ในประเทศไทย (ช่วงเที่ยงคืนถึง 7 โมงเช้าที่วันที่ต่างกัน)
const AT = new Date(Date.UTC(2026, 9, 5, 20, 30, 15));

test('เครื่องทดสอบตั้งเป็น UTC จริง', () => {
  assert.equal(AT.getHours(), 20);
  assert.equal(AT.getDate(), 5);
});

test('nowStr todayStr bangkokParts เป็นเวลาไทย', () => {
  assert.equal(time.nowStr(AT), '2026-10-06 03:30:15');
  assert.equal(db.nowStr(AT), '2026-10-06 03:30:15');
  assert.equal(time.todayStr(AT), '2026-10-06');
  assert.deepEqual(time.bangkokParts(AT), { y: 2026, mo: 10, d: 6, h: 3, mi: 30, s: 15 });
  // เที่ยงคืนพอดีต้องได้ 00 ไม่ใช่ 24
  assert.equal(time.nowStr(new Date(Date.UTC(2026, 9, 5, 17, 0, 0))), '2026-10-06 00:00:00');
  // ข้ามปี
  assert.equal(time.nowStr(new Date(Date.UTC(2026, 11, 31, 18, 5, 0))), '2027-01-01 01:05:00');
  // ไม่ส่งเวลามา ใช้เวลาปัจจุบัน ห่างจาก UTC 7 ชั่วโมงพอดี
  const now = new Date();
  assert.equal(time.parseLocal(time.nowStr(now)).getTime(), Math.floor(now.getTime() / 1000) * 1000);
});

test('parseLocal อ่านสตริงในฐานเป็นเวลา +07:00', () => {
  assert.equal(time.parseLocal('2026-10-06 03:30:15').getTime(), AT.getTime());
  assert.equal(time.parseLocal('2026-10-06').toISOString(), '2026-10-05T17:00:00.000Z');
  assert.equal(time.parseLocal('ไม่ใช่วันที่'), null);
  assert.equal(time.parseLocal(''), null);
});

test('daysUntil นับจากวันที่ไทย', () => {
  assert.equal(util.daysUntil('2026-10-06', AT), 0);
  assert.equal(util.daysUntil('2026-10-07', AT), 1);
  assert.equal(util.daysUntil('2026-10-05', AT), -1);
  assert.equal(util.daysUntil('2026-12-30', AT), 85);
  assert.equal(util.daysUntil('', AT), null);
  assert.equal(util.daysUntil(time.todayStr()), 0);
});

test('ago นับตามเวลาไทย', () => {
  assert.equal(util.ago('2026-10-06 03:30:00', AT), 'เมื่อสักครู่');
  assert.equal(util.ago('2026-10-06 03:00:00', AT), '30 นาทีก่อน');
  assert.equal(util.ago('2026-10-06 01:00:00', AT), '2 ชั่วโมงก่อน');
  // 23:00 เมื่อคืน ผ่านมา 4 ชั่วโมงครึ่ง แต่คนละวัน
  assert.equal(util.ago('2026-10-05 23:00:00', AT), 'เมื่อวาน');
  assert.equal(util.ago('2026-10-03 10:00:00', AT), '3 วันก่อน');
  assert.equal(util.ago('2026-09-20 10:00:00', AT), '20 ก.ย. 2569');
  assert.equal(util.ago(time.nowStr()), 'เมื่อสักครู่');
  assert.equal(util.ago(''), '');
});

test('ช่วงเปิดรับส่งงาน ปิดตรงเที่ยงคืนเวลาไทย ไม่ช้าไป 7 ชั่วโมง', (t) => {
  const s = { submit_open: '1', submit_start: '2026-10-01', submit_end: '2026-10-05' };
  // 5 ต.ค. 23:59 น. เวลาไทย ยังเปิดอยู่
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 16, 59, 0) });
  assert.equal(submitWindow(s).open, true);
  // 6 ต.ค. 00:01 น. เวลาไทย (เครื่อง UTC ยังเป็น 5 ต.ค.) ต้องปิดแล้ว
  t.mock.timers.setTime(Date.UTC(2026, 9, 5, 17, 1, 0));
  const w = submitWindow(s);
  assert.equal(w.open, false);
  assert.match(w.reason, /ปิดรับส่งแล้ว/);
  // วันเปิดรับ: 1 ต.ค. 00:30 น. เวลาไทย (เครื่อง UTC ยังเป็น 30 ก.ย.) ต้องเปิดแล้ว
  t.mock.timers.setTime(Date.UTC(2026, 8, 30, 17, 30, 0));
  assert.equal(submitWindow(s).open, true);
  t.mock.timers.setTime(Date.UTC(2026, 8, 30, 16, 30, 0));
  assert.equal(submitWindow(s).open, false);
});

test('ปีการศึกษาเริ่มต้นคิดตอนเรียกตามปีไทย', (t) => {
  // 1 ม.ค. 2570 เวลา 01:00 น. เวลาไทย (เครื่อง UTC ยังเป็นปี 2026)
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 11, 31, 18, 0, 0) });
  assert.equal(DEFAULT_SETTINGS.academic_year, '2570');
  t.mock.timers.setTime(Date.UTC(2026, 11, 31, 16, 0, 0));
  assert.equal(DEFAULT_SETTINGS.academic_year, '2569');
});
