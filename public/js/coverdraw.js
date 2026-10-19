// วาดปกที่ระบบวาด (views/partials/lib_cover.ejs) ลงผืนผ้าใบขนาดหน้า A4 เพื่อต่อเป็นหน้าแรกของ PDF (ฟังก์ชันเสริม coverpdf)
// อ่านตำแหน่ง สี และตัวหนังสือจากปกที่แสดงอยู่บนจอจริง ปกใน PDF จึงหน้าตาเหมือนคลังงานทุกแบบ (ก ถึง ง และแบบสีเดียวเดิม)
// เบราว์เซอร์วางสระและวรรณยุกต์ไทยให้เองตอนวาดตัวหนังสือ จึงไม่ต้องฝังฟอนต์ใน PDF
// ใช้: window.CoverDraw.draw(ปกบนจอ, ความกว้างพิกเซล) คืนผืนผ้าใบ
(function () {
  'use strict';

  const px = (v) => parseFloat(v) || 0;
  const visible = (c) => c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
  // สระบน สระล่าง วรรณยุกต์ ไม้ไต่คู้ การันต์ อยู่กับตัวอักษรหน้า
  const MARK = /[ัิ-ฺ็-๎]/;

  function clusters(text) {
    const out = [];
    for (const ch of text) {
      if (out.length && MARK.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function radiusOf(cs, w) {
    const v = cs.borderTopLeftRadius || '0';
    return /%$/.test(v) ? (px(v) / 100) * w : px(v);
  }

  // ความทึบรวมจากตัวเองถึงปก
  function alphaOf(el, root) {
    let a = 1;
    for (let n = el; n && n !== root.parentNode; n = n.parentNode) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(v)) a *= v;
    }
    return a;
  }

  function boxOf(el, o, s) {
    const r = el.getBoundingClientRect();
    return { x: (r.left - o.left) * s, y: (r.top - o.top) * s, w: r.width * s, h: r.height * s };
  }

  function drawBox(ctx, el, cs, b, s) {
    const rad = radiusOf(cs, b.w / s) * s;
    if (visible(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      roundRect(ctx, b.x, b.y, b.w, b.h, rad);
      ctx.fill();
    }
    const bw = px(cs.borderTopWidth) * s;
    if (bw > 0 && cs.borderTopStyle !== 'none' && visible(cs.borderTopColor)) {
      ctx.strokeStyle = cs.borderTopColor;
      const lines = cs.borderTopStyle === 'double' ? [[bw / 3, bw / 6], [bw / 3, bw - bw / 6]] : [[bw, bw / 2]];
      for (const [w, at] of lines) {
        ctx.lineWidth = w;
        roundRect(ctx, b.x + at, b.y + at, b.w - at * 2, b.h - at * 2, Math.max(0, rad - at));
        ctx.stroke();
      }
    }
    const ow = px(cs.outlineWidth) * s;
    if (ow > 0 && cs.outlineStyle !== 'none' && visible(cs.outlineColor)) {
      const off = px(cs.outlineOffset) * s + ow / 2;
      ctx.strokeStyle = cs.outlineColor;
      ctx.lineWidth = ow;
      ctx.strokeRect(b.x - off, b.y - off, b.w + off * 2, b.h + off * 2);
    }
  }

  // ตัวหนังสือ: หาบรรทัดจากตำแหน่งของแต่ละตัวที่เบราว์เซอร์ตัดคำไว้แล้ว วาดทีละบรรทัดกึ่งกลางที่เดิม
  function drawText(ctx, node, o, s, root) {
    const el = node.parentNode;
    const cs = getComputedStyle(el);
    const range = document.createRange();
    const lines = [];
    let at = 0;
    for (const c of clusters(node.data)) {
      range.setStart(node, at);
      range.setEnd(node, at + c.length);
      at += c.length;
      const r = range.getClientRects()[0];
      if (!r || (!r.width && !c.trim())) continue;
      let line = lines[lines.length - 1];
      if (!line || Math.abs(r.top - line.top) > r.height / 2) {
        line = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, text: '' };
        lines.push(line);
      }
      line.text += c;
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.bottom = Math.max(line.bottom, r.bottom);
    }
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px(cs.fontSize) * s}px ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.globalAlpha = alphaOf(el, root);
    ctx.textAlign = 'center';
    for (const l of lines) {
      const text = l.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const m = ctx.measureText(text);
      const x = ((l.left + l.right) / 2 - o.left) * s;
      const top = (l.top - o.top) * s;
      const h = (l.bottom - l.top) * s;
      if (m.fontBoundingBoxAscent && m.fontBoundingBoxDescent) {
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, x, top + (h * m.fontBoundingBoxAscent) / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent));
      } else {
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, top + h / 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  async function draw(root, width) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(
      imgs.map((i) => {
        i.loading = 'eager';
        return i.complete ? null : new Promise((r) => (i.onload = i.onerror = r));
      })
    );
    const o = root.getBoundingClientRect();
    const s = width / o.width;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width);
    canvas.height = Math.round((width * 297) / 210);
    const ctx = canvas.getContext('2d');
    const rcs = getComputedStyle(root);
    ctx.fillStyle = visible(rcs.backgroundColor) ? rcs.backgroundColor : '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // แถบสีท้ายปก (แบบ ก ใช้ ::after)
    const after = getComputedStyle(root, '::after');
    if (after.content && after.content !== 'none' && visible(after.backgroundColor)) {
      const h = px(after.height) * s;
      ctx.fillStyle = after.backgroundColor;
      ctx.fillRect(0, canvas.height - h, canvas.width, h);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if (n.data.trim()) drawText(ctx, n, o, s, root);
        continue;
      }
      if (n.closest('.lib-lock')) continue;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const b = boxOf(n, o, s);
      if (!b.w || !b.h) continue;
      ctx.globalAlpha = alphaOf(n, root);
      drawBox(ctx, n, cs, b, s);
      if (n.tagName === 'IMG' && n.naturalWidth) ctx.drawImage(n, b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
    }
    return canvas;
  }

  window.CoverDraw = { draw };
})();
