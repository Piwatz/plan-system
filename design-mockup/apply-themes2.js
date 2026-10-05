// รอบสอง: อัปเดตรายการธีม (เพิ่ม I และ J) ในหน้าจอทั้ง 3 หน้ารายการธีม และสร้างไฟล์แถวธีม I และ J
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'project');
const block = fs.readFileSync(path.join(__dirname, 'themes-block.txt'), 'utf8').trim();
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const FONTS =
  'https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600&amp;family=Bai+Jamjuree:wght@400;500;600&amp;family=IBM+Plex+Sans+Thai:wght@400;500;600&amp;family=IBM+Plex+Sans+Thai+Looped:wght@400;500;600&amp;family=Krub:wght@400;500;600&amp;family=Niramit:wght@400;500;600&amp;family=Noto+Sans+Thai+Looped:wght@400;500;600;700&amp;family=Noto+Serif+Thai:wght@500;600;700&amp;family=Pridi:wght@500;600&amp;family=Sarabun:wght@400;700&amp;family=Trirong:wght@500;600&amp;display=swap';

function swapBlock(s, file) {
  const a = s.indexOf('const THEMES = {');
  const fn = s.indexOf('function themeOf(', a);
  const b = s.indexOf('\n}\n', fn) + 3;
  if (a < 0 || fn < 0 || b < 3) throw new Error(`${file}: ไม่พบรายการธีม`);
  return s.slice(0, a) + block + '\n' + s.slice(b);
}

for (const f of ['Main.dc.html', 'Review.dc.html', 'ReviewPhone.dc.html']) {
  let s = fs.readFileSync(path.join(dir, f), 'utf8');
  s = swapBlock(s, f);
  s = s.replace(/"options":\["a"[^\]]*\]/, `"options":${JSON.stringify(KEYS)}`);
  s = s.replace(/<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">/, `<link href="${FONTS}" rel="stylesheet">`);
  fs.writeFileSync(path.join(dir, f), s);
}

const tpl = fs.readFileSync(path.join(__dirname, 'Themes.template.html'), 'utf8');
fs.writeFileSync(path.join(dir, 'Themes.dc.html'), tpl.replace('/*FONTS*/', FONTS).replace('/*THEMES*/', block));

const screens = [
  ['Home', 'Main', 390, 844, 'ครู หน้าแรก'],
  ['Review', 'Review', 1180, 820, 'ผู้ตรวจ ดูไฟล์และให้คะแนน'],
  ['ReviewPhone', 'ReviewPhone', 390, 844, 'ผู้ตรวจบนมือถือ'],
];
for (const theme of ['I', 'J']) {
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
for (const f of ['Main.dc.html', 'Review.dc.html', 'ReviewPhone.dc.html', 'Themes.dc.html']) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  console.log(f, 'themes:', (t.match(/^\s{2}[a-j]: \{ letter/gm) || []).length, 'themeOf:', (t.match(/function themeOf/g) || []).length);
}
