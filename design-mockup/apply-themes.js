// ใส่ธีม A ถึง H ลงในหน้าจอทั้ง 3 สร้างหน้ารายการธีม และไฟล์แถวธีม D ถึง H
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'project');
const block = fs.readFileSync(path.join(__dirname, 'themes-block.txt'), 'utf8').trim();
const FONTS =
  'https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600&amp;family=Bai+Jamjuree:wght@400;500;600&amp;family=IBM+Plex+Sans+Thai:wght@400;500;600&amp;family=IBM+Plex+Sans+Thai+Looped:wght@400;500;600&amp;family=Krub:wght@400;500;600&amp;family=Niramit:wght@400;500;600&amp;family=Noto+Sans+Thai+Looped:wght@400;500;600&amp;family=Noto+Serif+Thai:wght@500;600;700&amp;family=Pridi:wght@500;600&amp;family=Sarabun:wght@400;700&amp;family=Trirong:wght@500;600&amp;display=swap';
const OPTIONS = '"options":["a","b","c","d","e","f","g","h"]';

function rep(s, from, to, file) {
  if (!s.includes(from)) throw new Error(`${file}: ไม่พบ ${from.slice(0, 60)}`);
  return s.split(from).join(to);
}

function common(s, file) {
  s = s.replace(/<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">/, `<link href="${FONTS}" rel="stylesheet">`);
  const a = s.indexOf('const THEMES = {');
  const b = s.indexOf('\n};', a) + 3;
  if (a < 0 || b < 3) throw new Error(`${file}: ไม่พบ THEMES`);
  s = s.slice(0, a) + block + s.slice(b);
  s = rep(s, '"options":["a","b","c"]', OPTIONS, file);
  s = rep(s, 'const t = THEMES[this.props.theme] || THEMES.a;', 'const t = themeOf(this.props.theme);', file);
  return s;
}

// หน้าแรกครู
let f = 'Main.dc.html';
let s = common(fs.readFileSync(path.join(dir, f), 'utf8'), f);
s = s.replace(/\nconst STATUS = \{[^\n]*\n/, '\n');
s = rep(s, "return { bg: STATUS[kind].bg, fg: STATUS[kind].fg, bd: 'transparent' };", "return { bg: t[kind + 'Bg'], fg: t[kind], bd: 'transparent' };", f);
s = rep(s, "if (kind === 'info') return { bg: t.soft, fg: t.primary, bd: 'transparent' };", "if (kind === 'info') return { bg: t.soft, fg: t.link, bd: 'transparent' };", f);
s = rep(s, "fg: s.code === subject ? t.primary : t.ink,", "fg: s.code === subject ? t.link : t.ink,", f);
s = rep(s, 'background: {{t.surface}}; color: {{t.primary}}; font: 600 17px/1', 'background: {{t.surface}}; color: {{t.link}}; font: 600 17px/1', f);
s = rep(s, 'background: none; color: {{t.primary}}; font: 600 13px/1.2', 'background: none; color: {{t.link}}; font: 600 13px/1.2', f);
s = rep(s, 'background: #B42318; flex: none', 'background: {{t.back}}; flex: none', f);
s = rep(s, 'background: #C98A00; flex: none', 'background: {{t.wait}}; flex: none', f);
fs.writeFileSync(path.join(dir, f), s);

// ผู้ตรวจ ไอแพดและมือถือ
for (f of ['Review.dc.html', 'ReviewPhone.dc.html']) {
  s = common(fs.readFileSync(path.join(dir, f), 'utf8'), f);
  if (s.includes("levelBg: complete ? '#E1F2EA' : t.bg,")) {
    s = rep(s, "levelBg: complete ? '#E1F2EA' : t.bg,", 'levelBg: complete ? t.okBg : t.bg,', f);
    s = rep(s, "levelFg: complete ? '#1E6E50' : t.muted,", 'levelFg: complete ? t.ok : t.muted,', f);
  }
  s = s.split('background: {{t.soft}}; color: {{t.primary}};').join('background: {{t.soft}}; color: {{t.link}};');
  s = s.split('color: {{t.primary}}; font-weight: 600; white-space: nowrap').join('color: {{t.link}}; font-weight: 600; white-space: nowrap');
  fs.writeFileSync(path.join(dir, f), s);
}

// หน้ารายการธีม
const tpl = fs.readFileSync(path.join(__dirname, 'Themes.template.html'), 'utf8');
fs.writeFileSync(path.join(dir, 'Themes.dc.html'), tpl.replace('/*FONTS*/', FONTS).replace('/*THEMES*/', block));

// แถวธีม B ถึง H (ไฟล์เล็กที่ดึงหน้าจอเดิมมาแสดงด้วยธีมอื่น)
const screens = [
  ['Home', 'Main', 390, 844, 'ครู หน้าแรก'],
  ['Review', 'Review', 1180, 820, 'ผู้ตรวจ ดูไฟล์และให้คะแนน'],
  ['ReviewPhone', 'ReviewPhone', 390, 844, 'ผู้ตรวจบนมือถือ'],
];
for (const theme of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
  for (const [prefix, comp, w, h, title] of screens) {
    fs.writeFileSync(
      path.join(dir, `${prefix}${theme}.dc.html`),
      `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>ธีม ${theme} ${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="${FONTS}" rel="stylesheet">
<style>body{margin:0}</style>
</helmet>
<dc-import name="${comp}" theme="${theme.toLowerCase()}" hint-size="${w}px,${h}px"></dc-import>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
`
    );
  }
}

// ตรวจว่าไม่มีสีแข็งที่ควรมาจากธีมหลงเหลือ
for (const file of ['Main.dc.html', 'Review.dc.html', 'ReviewPhone.dc.html']) {
  const txt = fs.readFileSync(path.join(dir, file), 'utf8');
  const left = ['STATUS[', 'THEMES.a;', '#E1F2EA', '#B42318', '#C98A00'].filter((x) => txt.includes(x));
  console.log(file, left.length ? 'ยังเหลือ ' + left.join(' ') : 'ok', (txt.match(/const THEMES/g) || []).length);
}
console.log(fs.readdirSync(dir).length, 'files');
