// ธีมสีของระบบ A ถึง J (ผู้ดูแลระบบเลือกในหน้าตั้งค่าโรงเรียน ค่าเริ่มต้นคือ I แนวเดียวกับระบบวัดผลของโรงเรียน)
// แต่ละธีมกำหนดสี ฟอนต์ ความโค้งของกล่อง และสีแถบเมนูด้านซ้าย
// ผู้ใช้แต่ละคนเปิดโหมดกลางคืนเองได้ ระบบจะใช้สีของธีม J แทน

// ฟอนต์ทุกตัวเก็บไว้ในเครื่อง (node_modules/@fontsource) ใช้ได้แม้อินเทอร์เน็ตล่ม
const FONTS = {
  'Noto Sans Thai Looped': 'noto-sans-thai-looped',
  'Noto Serif Thai': 'noto-serif-thai',
  'IBM Plex Sans Thai': 'ibm-plex-sans-thai',
  'IBM Plex Sans Thai Looped': 'ibm-plex-sans-thai-looped',
  Anuphan: 'anuphan',
  Trirong: 'trirong',
  'Bai Jamjuree': 'bai-jamjuree',
  Niramit: 'niramit',
  Pridi: 'pridi',
  Krub: 'krub',
  Sarabun: 'sarabun',
};

const FONT_FALLBACK = "'Noto Sans Thai Looped', 'Leelawadee UI', Tahoma, sans-serif";

// ฟอนต์หน้าเว็บที่ผู้ดูแลระบบเลือกแยกจากธีมสีได้ (ฟังก์ชันเสริม fontpick) เอกสารที่พิมพ์ไม่เกี่ยว ใช้ฟอนต์ของตัวเอง
// stack = ฟอนต์ที่ไม่มีไฟล์ให้โหลดตรง ๆ: TH Sarabun ใช้ของในเครื่อง (Web TH ใน app.css) ฟอนต์ประจำเครื่องทำให้ Apple ใช้ฟอนต์ของ Apple ได้โดยไม่ต้องฝังไฟล์
const WEB_FONTS = [
  { key: 'noto', name: 'Noto Sans Thai Looped', desc: 'มีหัว หนาแน่นเล็กน้อย', fam: 'Noto Sans Thai Looped' },
  { key: 'plexl', name: 'IBM Plex Sans Thai Looped', desc: 'มีหัว โปร่งและคมชัด', fam: 'IBM Plex Sans Thai Looped' },
  { key: 'plex', name: 'IBM Plex Sans Thai', desc: 'ไม่มีหัว คมชัด ดูเป็นทางการ', fam: 'IBM Plex Sans Thai' },
  { key: 'anuphan', name: 'Anuphan', desc: 'ไม่มีหัว สะอาด แบบแอปสมัยใหม่', fam: 'Anuphan' },
  { key: 'sarabun', name: 'Sarabun', desc: 'แนวเอกสารราชการ ใช้ได้ทุกเครื่อง', fam: 'Sarabun' },
  { key: 'krub', name: 'Krub', desc: 'มีหัว นุ่มนวล อ่านสบาย', fam: 'Krub' },
  { key: 'thsarabun', name: 'TH Sarabun PSK', desc: 'ฟอนต์ราชการ เครื่องที่ไม่มีฟอนต์นี้ใช้ Sarabun แทน', fam: 'Sarabun', stack: `'Web TH', 'Sarabun', ${FONT_FALLBACK}` },
  { key: 'system', name: 'ฟอนต์ประจำเครื่อง', desc: 'ไอแพด ไอโฟน และ Mac ใช้ฟอนต์ของ Apple เครื่องอื่นใช้ฟอนต์ของเครื่องนั้น', stack: "-apple-system, BlinkMacSystemFont, 'Leelawadee UI', 'Segoe UI', Tahoma, sans-serif" },
];


// สีปกที่ระบบวาดในคลังงาน แยกตามชนิดงาน (ฟังก์ชันเสริม coverstyle) ธีมใดอยากได้สีอื่นใส่ cvPlan cvManual cvNote ในธีมนั้น
// ปกเป็นกระดาษ จึงใช้สีเดียวกันทั้งโหมดกลางวันและกลางคืน
const COVER_BASE = { cvPlan: '#1D3A66', cvManual: '#17694F', cvNote: '#8E1B2C' };
const STATUS_BASE = { ok: '#1E6E50', okBg: '#E1F2EA', wait: '#7A5200', waitBg: '#FBEFD5', back: '#A61B1B', backBg: '#FCE7E5' };

// สีเสริมของสีสัน 4 ระดับ (ฟังก์ชันเสริม colorful) ใช้กับไอคอนเมนู การ์ดสถิติ ป้าย และพลุ · กลางคืนใช้สีอ่อนลงให้เห็นบนพื้นมืด
const FX_LIGHT = { cRed: '#E5484D', cAmber: '#E0A100', cBlue: '#2F6FEB', cViolet: '#7C4DDB', cTeal: '#12A594', cOrange: '#F07B12', cPink: '#E5468F', cGreen: '#20A35A', cGold: '#E8B524' };
const FX_DARK = { cRed: '#FF6B6F', cAmber: '#F5C443', cBlue: '#6C9BFF', cViolet: '#A98BFF', cTeal: '#3DD6C3', cOrange: '#FF9F4A', cPink: '#FF7AB6', cGreen: '#4CD38A', cGold: '#F5CC4F' };

// สีสัน 4 ระดับ เรียงน้อยไปมาก ผู้ดูแลระบบเลือกในหน้าตั้งค่าโรงเรียน · ระดับสูงกว่ารวมของระดับต่ำกว่าทั้งหมด
const FX_LEVELS = [
  { key: 'classic', name: 'แบบเดิม', desc: 'หน้าตาเดิม ไม่เปลี่ยนอะไร' },
  { key: 'light', name: 'แบบเบา', desc: 'ไอคอนเมนูมีสี จุดสีหน้าสถานะ การ์ดตัวเลขมีขอบสี' },
  { key: 'mid', name: 'แบบกลาง', desc: 'ไอคอนในกล่องสี การ์ดตัวเลขมีแถบสีและแถบความคืบหน้า ป้ายวิชาหลักสีทอง' },
  { key: 'full', name: 'แบบจัดเต็ม', desc: 'แถบต้อนรับไล่เฉดพร้อมวงแหวนความคืบหน้า ปุ่มและการ์ดลอยเมื่อเอาเมาส์ชี้ ปกในคลังเอียง ป้ายด่วนกระพริบ แถบโหลดตอนเปลี่ยนหน้า เหรียญเมื่อส่งครบ' },
];
const FX_DEFAULT = 'full';

// ระดับสีสันที่ใช้อยู่ 0 ถึง 3 (ปิดฟังก์ชันเสริม colorful = 0 แบบเดิม)
function fxLevel(settings, ff) {
  if (!ff || !ff.colorful) return 0;
  const i = FX_LEVELS.findIndex((x) => x.key === (settings && settings.color_level));
  return i >= 0 ? i : FX_LEVELS.findIndex((x) => x.key === FX_DEFAULT);
}

// class ที่ใส่ใน <body> เช่น ระดับกลางได้ fx fx1 fx2
function fxClass(level) {
  if (!level) return '';
  let c = 'fx';
  for (let i = 1; i <= level; i++) c += ' fx' + i;
  return c;
}

const THEMES = {
  a: { name: 'ขาวแดงหรู', desc: 'แดงเลือดหมูตามสีโรงเรียน พื้นงาช้าง หัวเรื่องตัวมีเชิง', head: 'Noto Serif Thai', body: 'IBM Plex Sans Thai', bg: '#F7F3EF', surface: '#FFFFFF', ink: '#241517', muted: '#665558', line: '#E7DDD7', primary: '#8E1B2C', soft: '#F5E6E7', accent: '#A6834B', side: '#6E1422', r: 22, rs: 14 },
  b: { name: 'มินิมอลขาวสะอาด', desc: 'พื้นขาว แดงสดเป็นสีเน้นสีเดียว แบบแอปโทรศัพท์', head: 'Anuphan', body: 'Anuphan', bg: '#F4F4F6', surface: '#FFFFFF', ink: '#1C1C1E', muted: '#5C5C63', line: '#E3E3E8', primary: '#C8102E', soft: '#FCEBEE', accent: '#1C1C1E', side: '#1C1C1E', r: 18, rs: 12 },
  c: { name: 'กรมท่าทองทางการ', desc: 'น้ำเงินกรมท่ากับทอง สุขุม แบบหน่วยงานราชการ', head: 'IBM Plex Sans Thai', body: 'IBM Plex Sans Thai', bg: '#EDF0F5', surface: '#FFFFFF', ink: '#101B31', muted: '#4D5A71', line: '#D9DFE9', primary: '#1B2A4A', soft: '#E5EAF3', accent: '#B08A2E', side: '#1B2A4A', r: 16, rs: 10 },
  d: { name: 'มรกตทอง', desc: 'เขียวมรกตเข้มกับทองหม่น สงบ คลาสสิก อ่านง่าย', head: 'Trirong', body: 'Noto Sans Thai Looped', bg: '#F2F5F1', surface: '#FFFFFF', ink: '#14231C', muted: '#4F6158', line: '#DCE5DF', primary: '#1F5C46', soft: '#E2EEE7', accent: '#B4924A', side: '#18493A', r: 20, rs: 14 },
  e: { name: 'กลางคืนแดงพรีเมียม', desc: 'พื้นมืดกับแดงสด ถนอมสายตาตอนกลางคืน', head: 'Bai Jamjuree', body: 'Bai Jamjuree', dark: true, bg: '#141113', surface: '#1E1A1D', ink: '#F3EEEF', muted: '#B3A9AD', line: '#342D31', primary: '#D42E45', soft: '#3A1D24', link: '#FF7A8C', accent: '#D9B36C', side: '#0E0C0D', r: 20, rs: 13, ok: '#7AD3A6', okBg: '#163A2B', wait: '#F1C46A', waitBg: '#3A2F14', back: '#FF8D8D', backBg: '#431C20' },
  f: { name: 'ฟ้าครามสดใส', desc: 'น้ำเงินสดกับส้มเล็กน้อย สดใส เป็นมิตร', head: 'Niramit', body: 'Niramit', bg: '#F1F5FD', surface: '#FFFFFF', ink: '#13203B', muted: '#4D5B78', line: '#DCE4F3', primary: '#2453D6', soft: '#E4ECFC', accent: '#F59E2A', side: '#1A3FA8', r: 20, rs: 14 },
  g: { name: 'ดินเผาอบอุ่น', desc: 'ส้มอิฐกับเขียวมะกอก อบอุ่น แบบกระดาษสมุด', head: 'Pridi', body: 'Krub', bg: '#F8F2EB', surface: '#FFFDFA', ink: '#2B1D16', muted: '#6B584D', line: '#EADDD0', primary: '#A5462A', soft: '#F5E2D8', accent: '#6E7F4E', side: '#7E3520', r: 18, rs: 12 },
  h: { name: 'ชมพูแดงพาสเทลนุ่ม', desc: 'สีโรงเรียนแบบนุ่มนวล ขอบโค้งมนมาก เป็นกันเอง', head: 'IBM Plex Sans Thai Looped', body: 'IBM Plex Sans Thai Looped', bg: '#FFF6F6', surface: '#FFFFFF', ink: '#2E1A1F', muted: '#6E5560', line: '#F2DEE2', primary: '#C2354F', soft: '#FDE6EA', link: '#A82A43', accent: '#F2A7B5', side: '#A82A43', r: 28, rs: 18 },
  i: { name: 'กรมท่าสถาบัน', desc: 'แนวเดียวกับระบบวัดผลของโรงเรียน แถบเมนูกรมท่า ตัวอักษรคมชัด', head: 'Noto Sans Thai Looped', body: 'Noto Sans Thai Looped', bg: '#EEF2F7', surface: '#FFFFFF', ink: '#0F1E33', muted: '#4E5F78', line: '#D6DEE9', primary: '#1D3A66', soft: '#E4ECF7', accent: '#E3A21A', side: '#1B3762', sideMuted: '#B9C7DB', sideBtn: '#152E55', r: 16, rs: 10, ok: '#1B7343', okBg: '#E4F4EA', wait: '#875700', waitBg: '#FFF2DA', back: '#B0341F', backBg: '#FDEAE4' },
  j: { name: 'กรมท่ากลางคืน', desc: 'โหมดกลางคืนของธีม I พื้นน้ำเงินเข้ม ถนอมสายตา', head: 'Noto Sans Thai Looped', body: 'Noto Sans Thai Looped', dark: true, bg: '#0C1626', surface: '#142139', ink: '#E9EFF8', muted: '#A3B3CA', line: '#25344F', primary: '#3D6BC0', soft: '#1B2D4D', link: '#8FB5F6', accent: '#F2B43A', side: '#08111F', sideMuted: '#9AABC4', sideBtn: '#13203A', sideActiveBg: '#1F3966', sideActiveFg: '#FFFFFF', r: 16, rs: 10, ok: '#7FD4A2', okBg: '#163828', wait: '#F2C46B', waitBg: '#3A2E12', back: '#FF9C88', backBg: '#432019' },
};

const DEFAULT_THEME = 'i';

function themeKey(k) {
  return THEMES[k] ? k : DEFAULT_THEME;
}

function resolve(key, { dark = false } = {}) {
  const k = dark && !THEMES[themeKey(key)].dark ? 'j' : themeKey(key);
  const t = { ...COVER_BASE, ...STATUS_BASE, ...(THEMES[k].dark ? FX_DARK : FX_LIGHT), ...THEMES[k], key: k };
  t.link = t.link || t.primary;
  t.sideMuted = t.sideMuted || 'rgba(255,255,255,.72)';
  t.sideBtn = t.sideBtn || 'rgba(0,0,0,.2)';
  t.sideActiveBg = t.sideActiveBg || '#FFFFFF';
  t.sideActiveFg = t.sideActiveFg || t.side;
  return t;
}

// ตัวแปรสีสำหรับใส่ใน <style> ของทุกหน้า
function cssVars(t, selector = ':root') {
  const fam = (f) => t.fontStack || `'${f}', ${FONT_FALLBACK}`;
  const v = {
    '--bg': t.bg,
    '--surface': t.surface,
    '--ink': t.ink,
    '--muted': t.muted,
    '--line': t.line,
    '--primary': t.primary,
    '--soft': t.soft,
    '--link': t.link,
    '--accent': t.accent,
    '--side': t.side,
    '--side-muted': t.sideMuted,
    '--side-btn': t.sideBtn,
    '--side-active-bg': t.sideActiveBg,
    '--side-active-fg': t.sideActiveFg,
    '--ok': t.ok,
    '--ok-bg': t.okBg,
    '--wait': t.wait,
    '--wait-bg': t.waitBg,
    '--back': t.back,
    '--back-bg': t.backBg,
    '--cv-plan': t.cvPlan,
    '--cv-manual': t.cvManual,
    '--cv-note': t.cvNote,
    '--c-red': t.cRed,
    '--c-amber': t.cAmber,
    '--c-blue': t.cBlue,
    '--c-violet': t.cViolet,
    '--c-teal': t.cTeal,
    '--c-orange': t.cOrange,
    '--c-pink': t.cPink,
    '--c-green': t.cGreen,
    '--c-gold': t.cGold,
    '--r': `${t.r}px`,
    '--rs': `${t.rs}px`,
    '--font': fam(t.body),
    '--font-head': fam(t.head),
    '--head-weight': t.head === t.body ? '700' : '600',
    '--shadow': t.dark ? '0 1px 0 rgba(255,255,255,.03), 0 10px 26px rgba(0,0,0,.4)' : '0 1px 2px rgba(15,30,51,.05), 0 4px 14px rgba(15,30,51,.05)',
    '--head-bg': t.dark ? 'rgba(255,255,255,.04)' : 'rgba(15,30,51,.03)',
    '--input-bg': t.dark ? 'rgba(0,0,0,.18)' : '#FFFFFF',
  };
  return `${selector}{${Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';')};color-scheme:${t.dark ? 'dark' : 'light'}}`;
}

// ไฟล์ฟอนต์ที่หน้าเว็บต้องโหลดสำหรับธีมนี้ (น้ำหนัก 400 500 700 และ 600 สำหรับหัวเรื่อง)
function fontFiles(t) {
  const out = [];
  for (const [fam, weights] of [[t.body, [400, 500, 700]], [t.head, [600, 700]]]) {
    const pkg = FONTS[fam];
    if (!pkg) continue;
    for (const w of weights) {
      const href = `/vendor/fonts/${pkg}/${w}.css`;
      if (!out.includes(href)) out.push(href);
    }
  }
  return out;
}

// รหัสฟอนต์ที่ใช้ได้ ค่าอื่นหรือค่าว่างหมายถึงตามธีม
function webFontKey(k) {
  return WEB_FONTS.some((f) => f.key === k) ? k : '';
}

// ธีมที่เปลี่ยนเฉพาะฟอนต์ สีเหมือนเดิม
function withFont(t, key) {
  const f = WEB_FONTS.find((x) => x.key === key);
  return f ? { ...t, body: f.fam, head: f.fam, fontStack: f.stack } : t;
}

// ตัวเลือกในหน้าตั้งค่า พร้อมไฟล์และชื่อฟอนต์สำหรับตัวอย่าง แถวแรกคือตามธีม
function webFontChoices(themeK) {
  const t = resolve(themeK);
  const row = (f) => ({ ...f, href: FONTS[f.fam] ? `/vendor/fonts/${FONTS[f.fam]}/400.css` : '', css: f.stack || `'${f.fam}', ${FONT_FALLBACK}` });
  return [row({ key: '', name: 'ตามธีมสี', desc: `ตอนนี้คือ ${t.body}`, fam: t.body }), ...WEB_FONTS.map(row)];
}

function list() {
  return Object.entries(THEMES).map(([key, t]) => ({ key, letter: key.toUpperCase(), ...t }));
}

module.exports = { FX_LEVELS, FX_DEFAULT, fxLevel, fxClass, THEMES, FONTS, DEFAULT_THEME, themeKey, resolve, cssVars, fontFiles, list, WEB_FONTS, webFontKey, withFont, webFontChoices };
