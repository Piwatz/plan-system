// ข้อมูลตายตัวสำหรับเทียบผล render ระหว่าง Node (ejs ปกติ) กับ Workers (compile แล้ว)
import icons from '../src/icons.js';
import themes from '../src/themes.js';

export function locals(kind) {
  const theme = themes.resolve('I');
  const base = {
    title: 'ไม่พบหน้าที่ต้องการ',
    message: 'ลิงก์อาจไม่ถูกต้อง <ทดสอบ & escape>',
    settings: { school_name: 'โรงเรียนทดลอง', mobile_layout: 'simple', semester: '2', academic_year: '2569' },
    ff: { prefs: true, teachlist: true, results: true, pa: true, board: true, quicksign: true },
    icon: icons.icon,
    theme,
    themeCss: themes.cssVars(theme),
    fontFiles: themes.fontFiles(theme),
    logoUrl: '/static/img/school-logo-sm.png',
    demo: false,
    assetVersion: 'spike1',
    currentPath: '/ไม่มี',
    flash: { type: 'error', text: 'ข้อความทดสอบ' },
    badges: { inbox: 3, returned: 1, notes: 0, alerts: 2 },
    me: null,
  };
  if (kind === 'me') {
    base.me = { full_name: 'ครูสมมติ ทดลองดี', position: 'ครู', dept_name: 'วิทยาศาสตร์', roles: ['dept_head'], is_teacher: true, is_admin: true };
    base.wf = { stepOf: (r) => ({ role: r, for_note: true, scope: 'dept' }) };
    base.currentPath = '/inbox';
  }
  return base;
}
