// ชื่อระบบ ข้อมูลหน่วยงานท้ายเว็บ และไอคอนแอป (ผู้ดูแลระบบแก้ได้ในหน้าตั้งค่าโรงเรียน)
// ยังไม่มีคีย์ในฐาน = ใช้ค่าเริ่มต้นด้านล่าง · ผู้ดูแลลบให้ว่าง = ไม่แสดงช่องนั้น
// ค่าเริ่มต้นเป็นข้อมูลหน่วยงานของโรงเรียน (ไม่ใช่ชื่อบุคคล) ห้ามใส่ชื่อจริงของครูหรือผู้บริหารที่นี่

const FIELDS = [
  { key: 'app_name', label: 'ชื่อสั้น (ใต้ไอคอนแอป บนแถบเมนู และชื่อแท็บ)', def: 'CW-Learn', max: 30 },
  { key: 'app_full', label: 'ชื่อเต็ม', def: 'งานส่งเสริมพัฒนากระบวนการเรียนรู้', max: 120 },
  { key: 'app_full_en', label: 'ชื่อเต็มภาษาอังกฤษ', def: 'Learning Process Development', max: 120 },
  { key: 'unit_name', label: 'หน่วยงานที่ดูแล', def: 'งานส่งเสริมพัฒนากระบวนการเรียนรู้', max: 120 },
  { key: 'unit_group', label: 'กลุ่มงาน', def: 'กลุ่มบริหารงานวิชาการ', max: 120 },
  { key: 'school_name_en', label: 'ชื่อโรงเรียนภาษาอังกฤษ', def: 'Chanumanwittayakom School', max: 120 },
  { key: 'school_affiliation', label: 'สังกัด', def: 'สำนักงานเขตพื้นที่การศึกษามัธยมศึกษาอุบลราชธานี อำนาจเจริญ', max: 200 },
  { key: 'school_address', label: 'ที่อยู่โรงเรียน', def: 'เลขที่ 683 ตำบลชานุมาน อำเภอชานุมาน จังหวัดอำนาจเจริญ 37210', max: 200 },
  { key: 'school_phone', label: 'โทรศัพท์', def: '093-414-5385', max: 60 },
  { key: 'school_email', label: 'อีเมล', def: 'chanumanwittayakom@chanu.ac.th', max: 120 },
  { key: 'school_web', label: 'เว็บไซต์โรงเรียน', def: 'https://www.chanu.ac.th/home', max: 200, url: true },
  { key: 'school_facebook', label: 'เพจ Facebook', def: 'https://www.facebook.com/chanumanwittayakom/', max: 200, url: true },
  { key: 'contact_name', label: 'ติดต่อผู้ดูแลระบบ', def: 'ฝ่ายวิชาการ งานส่งเสริมพัฒนากระบวนการเรียนรู้', max: 120 },
  { key: 'contact_line', label: 'LINE ผู้ดูแลระบบ (ไอดี หรือลิงก์)', def: '', max: 200 },
  { key: 'contact_hours', label: 'เวลาติดต่อ', def: '', max: 120 },
];

// ไอคอนแอปที่เลือกได้ (ไฟล์อยู่ใน public/img/app สร้างด้วย scripts/make-app-icons.py)
const ICONS = {
  A: 'ตราเต็มกรอบ',
  B: 'ตราบนวงกลมครีม',
  C: 'แดงไล่เฉด ขอบทอง',
  D: 'กรมท่าแบบหน้าเว็บ',
};

function iconKey(k) {
  return ICONS[k] ? k : 'A';
}

// ค่าที่ใช้จริง: settings มีคีย์แล้ว (แม้ว่าง) ใช้ค่านั้น ไม่มีคีย์ใช้ค่าเริ่มต้น
function of(settings) {
  const s = settings || {};
  const out = {};
  for (const f of FIELDS) out[f.key] = s[`site_${f.key}`] == null ? f.def : String(s[`site_${f.key}`]);
  out.app_name = out.app_name || 'CW-Learn';
  out.app_full = out.app_full || out.app_name;
  out.icon = iconKey(s.site_icon);
  return out;
}

// ค่าจากฟอร์มตั้งค่า คืน [คีย์ settings, ค่า] ลิงก์ต้องขึ้นต้นด้วย http หรือ https ไม่อย่างนั้นเก็บว่าง
function fromForm(b) {
  const out = FIELDS.map((f) => {
    let v = String((b && b[`site_${f.key}`]) || '').trim().slice(0, f.max);
    if (f.url && v && !/^https?:\/\/[^\s"<>]+$/i.test(v)) v = '';
    return [`site_${f.key}`, v];
  });
  out.push(['site_icon', iconKey(b && b.site_icon)]);
  return out;
}

function iconUrl(key, size) {
  return `/static/img/app/icon-${iconKey(key)}-${size}.png`;
}

// manifest สำหรับเพิ่มไปยังหน้าจอโฮม (แอนดรอยด์ คอม) ไอโฟนใช้ apple-touch-icon ใน top.ejs
function manifest(settings, themeColor) {
  const s = of(settings);
  return {
    name: s.app_full === s.app_name ? s.app_name : `${s.app_name} ${s.app_full}`,
    short_name: s.app_name,
    description: [...new Set([s.app_full, s.unit_name, settings && settings.school_name].filter(Boolean))].join(' '),
    lang: 'th',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: themeColor,
    icons: [
      { src: iconUrl(s.icon, 192), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl(s.icon, 512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/static/img/app/maskable-${s.icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

module.exports = { FIELDS, ICONS, iconKey, of, fromForm, iconUrl, manifest };
