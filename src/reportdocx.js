// ไฟล์ Word (.docx) ของบันทึกข้อความรายงานการส่งงาน สร้างเองไม่ต้องพึ่งไลบรารี ใช้ได้ทั้งบน Node และ Workers (zip จาก xlsx.js)
// ค่าวัดจากไฟล์ Word ของโรงเรียน 3 ไฟล์: ขอบ บน 1.5 ขวา 1.5 ล่าง 1.5 ซ้าย 2 ซม. TH SarabunPSK หัวข้อ 20 ตัวหนา เรียน 18 ตัวหนา เนื้อหา 16
// ตารางกว้างเกินขอบกระดาษออกไปทางซ้ายตามฟอร์ม
const { zip } = require('./xlsx');
const report = require('./reportsum');

const FONT = 'TH SarabunPSK';
const TICK_FONT = 'Segoe UI Symbol';
const tw = (pt) => Math.round(pt * 20);

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ขนาดตัวอักษรไทยใช้ szCs และ bCs (ภาษาไทยเป็น complex script) ใส่ทั้งคู่ให้ตรงกัน
function run(text, o = {}) {
  const font = o.font || FONT;
  const size = (o.size || 16) * 2;
  const props = [
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
    o.bold ? '<w:b/><w:bCs/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:cs/><w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="th-TH"/>`,
  ].join('');
  const parts = String(text).split('\t').map((s) => `<w:t xml:space="preserve">${esc(s)}</w:t>`);
  return `<w:r><w:rPr>${props}</w:rPr>${parts.join('<w:tab/>')}</w:r>`;
}

function para(runs, o = {}) {
  const tabs = (o.tabs || []).map((t) => `<w:tab w:val="left" w:pos="${tw(t)}"/>`).join('');
  const props = [
    o.pageBreak ? '<w:pageBreakBefore/>' : '',
    o.border ? '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="000000"/></w:pBdr>' : '',
    tabs ? `<w:tabs>${tabs}</w:tabs>` : '',
    `<w:spacing w:before="${tw(o.before || 0)}" w:after="${tw(o.after || 0)}"/>`,
    o.left || o.first || o.right ? `<w:ind w:left="${tw(o.left || 0)}" w:right="${tw(o.right || 0)}" w:firstLine="${tw(o.first || 0)}"/>` : '',
    o.align ? `<w:jc w:val="${o.align}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${props}</w:pPr>${Array.isArray(runs) ? runs.join('') : runs || ''}</w:p>`;
}

function image(logo) {
  if (!logo) return '';
  const cx = Math.round(61.1 * 12700);
  const cy = Math.round(64.45 * 12700);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="ตราครุฑ"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="ตราครุฑ"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

const NO_BORDERS = '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
const LINE_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('');
const cell = (w, body, tight) => `<w:tc><w:tcPr><w:tcW w:w="${tw(w)}" w:type="dxa"/>${tight ? '<w:tcMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>' : ''}</w:tcPr>${body}</w:tc>`;

// ช่องซ้ายกว้างตามฟอร์ม ช่องขวาเยื้องเข้า 63 พอยต์ ชื่อและตำแหน่งอยู่กึ่งกลางของแต่ละช่อง
const DOTS = (n) => '.'.repeat(n);

function signBoxes(names) {
  const box = (w, left, dots, title, name, pos) =>
    cell(w, [
      para(run(title), { align: 'center', left }),
      para(run(DOTS(dots)), { align: 'center', left }),
      para(run(DOTS(dots)), { align: 'center', left }),
      para(run(`(${name || DOTS(30)})`), { align: 'center', left, before: 12 }),
      para(run(pos), { align: 'center', left }),
    ].join(''));
  const widths = [232, 264];
  return `<w:tbl><w:tblPr><w:tblW w:w="${tw(496)}" w:type="dxa"/>${NO_BORDERS}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid><w:tr>${box(widths[0], 0, 86, 'ความเห็นของหัวหน้าสำนักงานกลุ่มบริหารงานวิชาการ', names.head, 'หัวหน้าสำนักงานกลุ่มบริหารงานวิชาการ')}${box(widths[1], 63, 72, 'ความเห็นของรองผู้อำนวยการโรงเรียน', names.deputy, 'รองผู้อำนวยการกลุ่มบริหารงานวิชาการ')}</w:tr></w:tbl>`;
}

function grid(p, color) {
  const widths = [28.25, 149, 165.5, 167.1, 56.7];
  const line = (texts, head) =>
    `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(head ? 31 : 21.4)}" w:hRule="atLeast"/>${head ? '<w:tblHeader/>' : ''}</w:trPr>${texts.map((c, i) => cell(widths[i], c, i === 4)).join('')}</w:tr>`;
  const center = (r) => para(r, { align: 'center' });
  // ตารางเริ่มหน้าใหม่เสมอ ขึ้นหน้าที่ช่องแรกของหัวตาราง จึงไม่มีบรรทัดว่างบนหัวหน้า
  const head = line(['ที่', 'ชื่อ-สกุล', p.text.sent, p.text.unsent, 'หมายเหตุ'].map((h, i) => para(run(h, { bold: true }), { align: 'center', pageBreak: i === 0 })), true);
  const ok = color ? '1E6E50' : '000000';
  const no = color ? 'C00000' : '000000';
  const body = p.rows.map((r) => {
    const sent = r.state === 'notsent' ? '' : run('✓', { font: TICK_FONT, color: ok, size: 14 });
    const unsent = r.state === 'notsent' ? run('✗', { font: TICK_FONT, color: no, size: 14 }) : '';
    const note = run(r.note, r.noteRed ? { color: 'C00000', size: 14 } : { size: 14 }); // ช่องแคบ ไม่เว้นขอบเซลล์ คำว่าส่งเกินกำหนดจึงอยู่บรรทัดเดียว
    return line([para(run(r.no)), para(run(r.full_name)), center(sent), center(unsent), center(note)]);
  });
  return `<w:tbl><w:tblPr><w:tblW w:w="${tw(566.55)}" w:type="dxa"/><w:tblInd w:w="${tw(-41.7)}" w:type="dxa"/><w:tblBorders>${LINE_BORDERS}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>${head}${body.join('')}</w:tbl>`;
}

function documentXml(p, settings, logo) {
  const school = settings.school_name || '';
  const place = String(settings.school_location || '').trim().split(' ').filter(Boolean).join('  ');
  const round = p.data.round;
  const color = round.color_mode !== 'black';
  const b = [];
  b.push(para([image(logo), run('\tบันทึกข้อความ', { bold: true, size: 20 })], { tabs: [187] }));
  b.push(para([run('ส่วนราชการ', { bold: true, size: 20 }), run(`\t${school}  ${place}`)], { tabs: [107.7] }));
  b.push(para([run('ที่', { bold: true, size: 20 }), run(`\t${round.doc_no}\t`), run('วันที่', {}), run(`  ${report.formDate(round.doc_date)}`)], { tabs: [36, 122.5] }));
  b.push(para([run('เรื่อง', { bold: true, size: 20 }), run(`\t${p.text.subject}`)], { tabs: [36], border: true, after: 8 }));
  b.push(para([run('เรียน', { bold: true, size: 18 }), run(`\tผู้อำนวยการ${school}`)], { tabs: [41.5], after: 8 }));
  b.push(para(run(p.text.p1), { first: 36, align: 'thaiDistribute' }));
  b.push(para(run(p.text.p2), { first: 36, align: 'thaiDistribute' }));
  p.text.items.forEach((it, i) => {
    b.push(para(run(`${i + 1}.  ${it.label}\tจำนวน   ${it.n}    คน\tคิดเป็นร้อยละ  ${it.pct}`), { left: 72, tabs: [213, 324], after: i === p.text.items.length - 1 ? 6 : 0 }));
  });
  if (p.endNote) b.push(para(run(p.endNote), { left: 72, after: 6 }));
  b.push(para(run('จึงเรียนบันทึกรายงานการส่งเอกสารดังกล่าว ดังเอกสารที่แนบมาพร้อมนี้'), { left: p.type === 'manual' ? 36 : 72 }));
  b.push(para(run('จึงเรียนมาเพื่อโปรดทราบ'), { left: 108, before: 12 }));
  b.push(para(run('ลงชื่อ'), { left: 215.6, before: 18 }));
  b.push(para(run(`(${p.names.reporter})`), { left: 188, right: 108, align: 'center', before: 3 }));
  b.push(para(run('ผู้รายงาน'), { left: 188, right: 108, align: 'center', after: 18 }));
  b.push(signBoxes(p.names));
  b.push(para(run('ความเห็นของผู้อำนวยการโรงเรียน'), { align: 'center', before: 24 }));
  b.push(para(run(DOTS(78)), { align: 'center' }));
  b.push(para(run(DOTS(78)), { align: 'center' }));
  b.push(para(run(`(${p.names.director || DOTS(30)})`), { align: 'center', before: 12 }));
  b.push(para(run(`ผู้อำนวยการ${school}`), { align: 'center', after: 4 }));
  b.push(grid(p, color));
  if (p.late.length) {
    b.push(para(run(p.text.listTitle, { bold: true }), { pageBreak: true, align: 'center' }));
    b.push(para(run(p.text.listCount, { bold: true }), { align: 'center', after: 18 }));
    p.late.forEach((r, i) => {
      b.push(para(run(`${i + 1}.\t${r.full_name}\tตำแหน่ง\t${r.position}`), { left: 17.8, tabs: [36, 215.6, 288] }));
    });
  } else {
    b.push(para(''));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${b.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="851" w:right="851" w:bottom="851" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:val="th-TH" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;

// โหมดเอกสารรุ่นใหม่ และภาษาไทยเป็นค่าเริ่มต้น Word จึงตัดคำไทยได้
const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:themeFontLang w:val="th-TH" w:bidi="th-TH"/></w:settings>`;

// รูปตราครุฑเก็บเป็น data URL ในค่าตั้ง คืน { ext, mime, bytes } หรือ null
function logoBytes(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { ext: m[1] === 'png' ? 'png' : 'jpeg', mime: m[1] === 'png' ? 'image/png' : 'image/jpeg', bytes: new Uint8Array(Buffer.from(m[2], 'base64')) };
}

function build(p) {
  const logo = logoBytes(p.logo);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${logo ? `<Default Extension="${logo.ext}" ContentType="${logo.mime}"/>` : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${logo ? `<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.${logo.ext}"/>` : ''}</Relationships>`],
    ['word/styles.xml', STYLES],
    ['word/settings.xml', SETTINGS],
    ['word/document.xml', documentXml(p, p.settings, logo)],
  ];
  if (logo) files.push([`word/media/logo.${logo.ext}`, logo.bytes]);
  return zip(files);
}

module.exports = { build, esc };
