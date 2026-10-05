// สคริปต์หน้าเว็บ: ป๊อปถามยืนยัน แถบความคืบหน้าอัปโหลด ลากไฟล์มาวาง ช่องเซ็นชื่อ รวมคะแนน
(function () {
  'use strict';

  const dialog = document.getElementById('confirm-dialog');
  const busy = document.getElementById('busy');

  // ---------- ป๊อปถามยืนยัน ----------
  const ICONS = {
    note: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
    danger: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    warn: 'M12 3 2 20h20zM12 10v4M12 17h.01',
    ok: 'M5 12.5 10 17l9-10',
  };
  function svg(name, size) {
    return '<svg width="' + (size || 28) + '" height="' + (size || 28) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (ICONS[name] || ICONS.note) + '"/></svg>';
  }

  function ask(text, opts = {}) {
    return new Promise((resolve) => {
      if (!dialog || typeof dialog.showModal !== 'function') return resolve(window.confirm(text));
      dialog.querySelector('[data-text]').textContent = text;
      const iconBox = dialog.querySelector('[data-icon]');
      iconBox.innerHTML = svg(opts.icon || 'note');
      iconBox.classList.toggle('danger', Boolean(opts.danger) || opts.icon === 'warn');
      const ok = dialog.querySelector('[data-ok]');
      const cancel = dialog.querySelector('[data-cancel]');
      ok.textContent = opts.ok || 'ยืนยัน';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      cancel.hidden = Boolean(opts.alertOnly);
      // ตอบจากการกดปุ่มโดยตรง ไม่รอเหตุการณ์ close ของหน้าต่าง (บางเบราว์เซอร์ส่งช้า)
      const done = (value) => {
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onEsc);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onOk = (e) => {
        e.preventDefault();
        done(true);
      };
      const onCancel = (e) => {
        e.preventDefault();
        done(false);
      };
      const onEsc = () => done(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onEsc);
      dialog.showModal();
      ok.focus();
    });
  }

  function tell(text, icon) {
    return ask(text, { icon: icon || 'warn', ok: 'ตกลง', alertOnly: true });
  }

  function showBusy(title, withBar) {
    if (!busy) return;
    busy.querySelector('[data-title]').textContent = title || 'กำลังบันทึก';
    busy.querySelector('[data-bar]').hidden = !withBar;
    busy.querySelector('[data-pct]').textContent = '';
    busy.classList.add('show');
  }

  function setProgress(pct) {
    if (!busy) return;
    busy.querySelector('[data-bar] > div').style.width = pct + '%';
    busy.querySelector('[data-pct]').textContent = pct < 100 ? 'อัปโหลดแล้ว ' + pct + '%' : 'กำลังบันทึกลงระบบ';
  }

  function hideBusy() {
    if (busy) busy.classList.remove('show');
  }

  // ส่งฟอร์มที่มีไฟล์ด้วย XHR เพื่อแสดงแถบความคืบหน้า
  function sendWithProgress(form, submitter) {
    const data = new FormData(form);
    if (submitter && submitter.name) data.set(submitter.name, submitter.value);
    const xhr = new XMLHttpRequest();
    // ใช้ getAttribute เพราะปุ่มชื่อ action จะบัง form.action
    xhr.open('POST', form.getAttribute('action') || window.location.pathname);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let res = null;
      try {
        res = JSON.parse(xhr.responseText);
      } catch {
        res = null;
      }
      if (res && res.redirect) {
        window.location.href = res.redirect;
        return;
      }
      hideBusy();
      tell((res && res.error) || 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    };
    xhr.onerror = () => {
      hideBusy();
      tell('เชื่อมต่อระบบไม่ได้ ตรวจสอบอินเทอร์เน็ตหรือ Wi-Fi แล้วลองใหม่');
    };
    showBusy(submitter && submitter.value === 'submit' ? 'กำลังส่งงาน' : 'กำลังบันทึก', true);
    setProgress(0);
    xhr.send(data);
  }

  // ส่งต่อจริง: ฟอร์มมีไฟล์ใช้ XHR พร้อมแถบความคืบหน้า ฟอร์มอื่นปล่อยเบราว์เซอร์ส่งตามปกติ
  function proceed(e, form, submitter) {
    if (form.classList.contains('js-upload')) {
      e.preventDefault();
      sendWithProgress(form, submitter);
    } else if (!form.hasAttribute('data-nobusy') && form.method.toLowerCase() === 'post') {
      showBusy(form.dataset.busy || 'กำลังบันทึก');
    }
  }

  document.addEventListener(
    'submit',
    async (e) => {
      const form = e.target;
      // ฟอร์มในหน้าต่างยืนยันเอง ไม่ต้องยุ่ง
      if (form.method === 'dialog') return;
      const submitter = e.submitter || null;
      if (form.dataset.confirmed === '1') {
        form.dataset.confirmed = '';
        proceed(e, form, form._submitter || submitter);
        return;
      }
      // ต้องเขียนเหตุผลก่อน เช่น ปุ่มส่งกลับแก้ไข
      const need = submitter && submitter.dataset.requireField;
      if (need) {
        const field = form.elements[need];
        if (field && !field.value.trim()) {
          e.preventDefault();
          await tell(submitter.dataset.requireMessage || 'กรุณากรอกข้อมูลให้ครบ');
          field.focus();
          return;
        }
      }
      if (form.querySelector('[data-dz-list] li.converting')) {
        e.preventDefault();
        await tell('รอให้แปลงไฟล์ Word เป็น PDF เสร็จก่อน แล้วกดอีกครั้ง');
        return;
      }
      if (form.querySelector('[data-dz-list] li.bad')) {
        e.preventDefault();
        await tell('มีไฟล์ที่ใช้ไม่ได้ (กรอบสีแดง) กดเอาออก แล้วเลือกไฟล์ใหม่ก่อน');
        return;
      }
      if (submitter && submitter.dataset.needChecked) {
        if (!form.querySelector('input[name="' + submitter.dataset.needChecked + '"]:checked')) {
          e.preventDefault();
          await tell('ยังไม่ได้เลือกรายการ');
          return;
        }
      }
      const text = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
      if (!text) {
        proceed(e, form, submitter);
        return;
      }
      // ถามยืนยันก่อน แล้วค่อยส่งใหม่ (ต้องส่งหลังจากเหตุการณ์นี้จบแล้ว เบราว์เซอร์จึงยอมส่ง)
      e.preventDefault();
      const danger = (submitter && submitter.dataset.danger) || form.dataset.danger;
      const ok = await ask(text, { danger: Boolean(danger), icon: danger ? 'danger' : 'note', ok: (submitter && submitter.dataset.okLabel) || form.dataset.okLabel || 'ยืนยัน' });
      if (!ok) return;
      form.dataset.confirmed = '1';
      form._submitter = submitter;
      if (form.requestSubmit) form.requestSubmit(submitter || undefined);
      else form.submit();
    },
    true
  );

  // ---------- หน้าเข้าสู่ระบบ: เลือกชื่อจากรายชื่อ หรือพิมพ์ชื่อผู้ใช้เอง ----------
  document.querySelectorAll('[data-type-name]').forEach((b) => {
    b.addEventListener('click', () => {
      const pickBox = b.closest('[data-pick-name]');
      const typeBox = document.querySelector('[data-type-field]');
      if (!pickBox || !typeBox) return;
      const sel = pickBox.querySelector('select');
      const inp = typeBox.querySelector('input');
      sel.disabled = true;
      sel.required = false;
      pickBox.hidden = true;
      inp.disabled = false;
      inp.required = true;
      typeBox.hidden = false;
      inp.focus();
    });
  });
  // เลือกกลุ่มสาระก่อน แล้วรายชื่อเหลือเฉพาะคนในกลุ่มนั้น และจำชื่อล่าสุดไว้ในเครื่องนี้ (ไม่ได้เก็บรหัสผ่าน)
  document.querySelectorAll('select.pick-name').forEach((sel) => {
    const LAST = 'plan-last-user';
    const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => ({
      label: g.label,
      users: Array.from(g.querySelectorAll('option')).map((o) => ({ value: o.value, text: o.textContent })),
    }));
    const pw = document.getElementById('password');
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML = '<label for="pick_dept">1. เลือกกลุ่มสาระ</label><select id="pick_dept" class="pick-name"></select>';
    const dept = wrap.querySelector('select');
    dept.innerHTML = '<option value="">แตะเพื่อเลือกกลุ่มสาระ</option>';
    groups.forEach((g, i) => dept.add(new Option(g.label + ' (' + g.users.length + ' คน)', String(i))));
    const field = sel.closest('[data-pick-name]');
    field.parentNode.insertBefore(wrap, field);
    field.querySelector('label').textContent = '2. เลือกชื่อของคุณ';
    function fill(i, chosen) {
      sel.innerHTML = '';
      sel.add(new Option(i === '' ? 'เลือกกลุ่มสาระก่อน' : 'แตะเพื่อเลือกชื่อ', ''));
      if (i !== '') groups[Number(i)].users.forEach((u) => sel.add(new Option(u.text, u.value, false, u.value === chosen)));
      sel.disabled = i === '';
    }
    let last = sel.value;
    if (!last) {
      try {
        last = localStorage.getItem(LAST) || '';
      } catch {
        last = '';
      }
    }
    const at = groups.findIndex((g) => g.users.some((u) => u.value === last));
    dept.value = at >= 0 ? String(at) : '';
    fill(dept.value, at >= 0 ? last : '');
    dept.addEventListener('change', () => {
      fill(dept.value, '');
      if (dept.value !== '') sel.focus();
    });
    sel.addEventListener('change', () => {
      if (sel.value && pw) pw.focus();
    });
    if (at >= 0 && pw && !document.querySelector('.alert-error')) pw.focus();
    sel.form.addEventListener('submit', () => {
      try {
        if (!sel.disabled && sel.value) localStorage.setItem(LAST, sel.value);
      } catch {
        // เครื่องนี้ไม่ให้จำ ไม่เป็นไร
      }
    });
    document.querySelectorAll('[data-type-name]').forEach((b) => b.addEventListener('click', () => (wrap.hidden = true)));
  });

  // ---------- ปุ่มเติมค่าลงช่อง เช่น เลือกโฟลเดอร์ Google Drive ที่ระบบหาเจอ ----------
  document.querySelectorAll('[data-fill]').forEach((b) => {
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.fill);
      if (!el) return;
      el.value = b.dataset.value || '';
      el.focus();
    });
  });

  // ---------- เลือกภาคเรียนแล้วเปลี่ยนหน้าเลย ----------
  document.querySelectorAll('[data-term]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const [y, s] = sel.value.split('-');
      const f = sel.form;
      f.elements.year.value = y;
      f.elements.semester.value = s;
      f.submit();
    });
  });
  document.querySelectorAll('[data-autosubmit] select:not([data-term])').forEach((sel) => {
    sel.addEventListener('change', () => sel.form.submit());
  });

  // ---------- ลากไฟล์มาวาง ----------
  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // ตรวจไฟล์ก่อนส่ง: ชนิดไฟล์ ขนาด ไฟล์เปิดได้ไหม และนับหน้า PDF
  const SIGS = { pdf: '%PDF-', docx: 'PK', xlsx: 'PK', pptx: 'PK', doc: '\xD0\xCF\x11\xE0', xls: '\xD0\xCF\x11\xE0', ppt: '\xD0\xCF\x11\xE0', png: '\x89PNG', jpg: '\xFF\xD8\xFF', jpeg: '\xFF\xD8\xFF' };
  function readHead(f, n) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const bytes = new Uint8Array(r.result);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        resolve(s);
      };
      r.onerror = () => resolve(null);
      r.readAsArrayBuffer(n ? f.slice(0, n) : f);
    });
  }
  async function checkFile(f, zone) {
    const out = [];
    let bad = false;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const accept = (zone.dataset.accept || 'pdf,doc,docx,xls,xlsx,ppt,pptx,jpg,jpeg,png').split(',');
    const maxMb = Number(zone.dataset.maxMb) || 20;
    if (!accept.includes(ext)) {
      out.push(['bad', 'ระบบไม่รับไฟล์ .' + ext]);
      return { bad: true, out };
    }
    out.push(['okc', 'ชนิดไฟล์ถูกต้อง']);
    if (f.size > maxMb * 1048576) {
      bad = true;
      out.push(['bad', 'ใหญ่เกิน ' + maxMb + ' MB']);
    } else if (f.size === 0) {
      bad = true;
      out.push(['bad', 'ไฟล์ว่างเปล่า']);
    }
    const head = await readHead(f, 8);
    if (head == null || (SIGS[ext] && !head.startsWith(SIGS[ext]))) {
      bad = true;
      out.push(['bad', 'ไฟล์เสียหรือนามสกุลไม่ตรงกับไฟล์จริง เปิดไม่ได้']);
    } else {
      out.push(['okc', 'ไฟล์เปิดได้']);
    }
    if (!bad && ext === 'pdf' && f.size < 60 * 1048576) {
      const all = await readHead(f);
      const pages = all ? (all.match(/\/Type\s*\/Page(?![a-z])/g) || []).length : 0;
      if (pages) out.push(['okc', pages + ' หน้า']);
      return { bad, out, pages };
    }
    return { bad, out };
  }

  document.querySelectorAll('[data-dropzone]').forEach((zone) => {
    const input = zone.querySelector('input[type=file]');
    const list = zone.parentElement.querySelector('[data-dz-list]');
    const doCheck = zone.hasAttribute('data-filecheck');
    // data-single: เก็บไฟล์ล่าสุดไฟล์เดียว  data-sortable: เรียงลำดับได้ ระบบรวม PDF ตามลำดับนี้
    const single = zone.hasAttribute('data-single');
    const sortable = zone.hasAttribute('data-sortable');
    const mergeNote = zone.parentElement.querySelector('[data-dz-merge]');
    const cover = zone.parentElement.querySelector('[data-cover]');
    let coverToken = 0;
    let dt = new DataTransfer();
    // แปลง Word เป็น PDF: ส่งไฟล์ไปแปลงที่เครื่องที่เปิดระบบ แล้วใส่ PDF ที่ได้ในรายการแทน ครูเปิดดูทั้งไฟล์ได้ก่อนส่ง
    const convertUrl = zone.dataset.convert || '';
    const pending = [];
    const converted = new Set();
    const keyOf = (f) => f.name + '|' + f.size;
    const isWord = (f) => /\.docx?$/i.test(f.name);
    function convertWord(f) {
      const item = { name: f.name, text: 'กำลังส่งไปแปลงเป็น PDF', el: null };
      const say = (t) => {
        item.text = t;
        if (item.el) item.el.textContent = t;
      };
      pending.push(item);
      render();
      const data = new FormData();
      data.append('file', f);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', convertUrl);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.responseType = 'arraybuffer';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) say(e.loaded < e.total ? 'กำลังส่งไปแปลง ' + Math.round((e.loaded / e.total) * 100) + '%' : 'กำลังแปลงเป็น PDF รอสักครู่');
      };
      xhr.upload.onload = () => say('กำลังแปลงเป็น PDF รอสักครู่');
      const done = () => pending.splice(pending.indexOf(item), 1);
      xhr.onload = () => {
        done();
        if (xhr.status === 200) {
          const pdf = new File([xhr.response], f.name.replace(/\.docx?$/i, '') + '.pdf', { type: 'application/pdf', lastModified: Date.now() });
          converted.add(keyOf(pdf));
          add([pdf]);
          return;
        }
        let msg = 'แปลงไฟล์ ' + f.name + ' ไม่สำเร็จ';
        try {
          const res = JSON.parse(new TextDecoder().decode(xhr.response));
          if (res && res.error) msg = res.error;
        } catch {
          // ใช้ข้อความตั้งต้น
        }
        render();
        tell(msg);
      };
      xhr.onerror = () => {
        done();
        render();
        tell('เชื่อมต่อระบบไม่ได้ ไฟล์ ' + f.name + ' ยังไม่ได้แปลง ลองเลือกใหม่อีกครั้ง');
      };
      xhr.send(data);
    }
    // ดูหน้าแรกของไฟล์ PDF ที่จะส่ง (ไฟล์แรกในรายการ = หน้าปกหลังรวมไฟล์) ด้วย PDF.js ที่มากับระบบ
    async function showCover(file) {
      if (!cover) return;
      const token = ++coverToken;
      if (!file || !/\.pdf$/i.test(file.name)) {
        cover.hidden = true;
        return;
      }
      try {
        const pdfjs = await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
        const task = pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
          cMapUrl: '/vendor/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
          wasmUrl: '/vendor/pdfjs/wasm/',
          iccUrl: '/vendor/pdfjs/iccs/',
        });
        const close = () => task.destroy().catch(() => {});
        const doc = await task.promise;
        const page = await doc.getPage(1);
        if (token !== coverToken) return close();
        const dpr = window.devicePixelRatio || 1;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 200 / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = Math.floor(vp.width) + 'px';
        canvas.style.height = Math.floor(vp.height) + 'px';
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
        if (token !== coverToken) return close();
        const box = cover.querySelector('[data-cover-img]');
        box.innerHTML = '';
        box.appendChild(canvas);
        cover.querySelector('[data-cover-info]').textContent = 'หน้าแรกของไฟล์ ' + file.name + (dt.files.length > 1 ? ' (หน้าปกของไฟล์ที่รวมแล้ว)' : ' ทั้งไฟล์ ' + doc.numPages + ' หน้า');
        cover.hidden = false;
        close();
      } catch {
        if (token === coverToken) cover.hidden = true;
      }
    }
    function reorder(order) {
      const files = Array.from(dt.files);
      const next = new DataTransfer();
      order.forEach((j) => next.items.add(files[j]));
      dt = next;
      render();
    }
    function render() {
      input.files = dt.files;
      list.innerHTML = '';
      const n = dt.files.length;
      const pages = [];
      showCover(dt.files[0]);
      if (mergeNote) {
        mergeNote.hidden = !(sortable && n > 1);
        mergeNote.textContent = 'ระบบจะรวม ' + n + ' ไฟล์เป็น PDF ไฟล์เดียว เรียงตามลำดับด้านบน';
      }
      Array.from(dt.files).forEach((f, i) => {
        const li = document.createElement('li');
        li.innerHTML = '<span class="name"></span><small class="muted"></small><button type="button" class="btn btn-ghost btn-sm" data-rm>เอาออก</button>';
        li.querySelector('.name').textContent = (sortable && n > 1 ? i + 1 + '. ' : '') + f.name;
        li.querySelector('small').textContent = fmtSize(f.size);
        li.querySelector('[data-rm]').addEventListener('click', () => {
          const next = new DataTransfer();
          Array.from(dt.files).forEach((g, j) => j !== i && next.items.add(g));
          dt = next;
          render();
        });
        if (sortable && n > 1) {
          const idx = Array.from({ length: n }, (_, j) => j);
          [['ขึ้น', i - 1], ['ลง', i + 1]].forEach(([label, to]) => {
            if (to < 0 || to >= n) return;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-ghost btn-sm';
            b.textContent = label;
            b.setAttribute('aria-label', 'เลื่อน' + label + ' ' + f.name);
            b.addEventListener('click', () => {
              [idx[i], idx[to]] = [idx[to], idx[i]];
              reorder(idx);
            });
            li.insertBefore(b, li.querySelector('[data-rm]'));
          });
        }
        if (converted.has(keyOf(f))) {
          const note = document.createElement('small');
          note.className = 'muted';
          note.textContent = 'แปลงจาก Word แล้ว';
          li.insertBefore(note, li.querySelector('[data-rm]'));
          const view = document.createElement('button');
          view.type = 'button';
          view.className = 'btn btn-ghost btn-sm';
          view.textContent = 'เปิดดูทั้งไฟล์';
          view.addEventListener('click', () => {
            const url = URL.createObjectURL(f);
            if (!window.open(url, '_blank')) window.location.assign(url);
          });
          li.insertBefore(view, li.querySelector('[data-rm]'));
        }
        list.appendChild(li);
        if (doCheck) {
          const chk = document.createElement('span');
          chk.className = 'chk';
          chk.textContent = 'กำลังตรวจไฟล์';
          li.appendChild(chk);
          checkFile(f, zone).then((res) => {
            chk.innerHTML = '';
            res.out.forEach(([cls, text]) => {
              const s = document.createElement('span');
              s.className = cls;
              s.textContent = (cls === 'bad' ? '✕ ' : '✓ ') + text;
              chk.appendChild(s);
            });
            li.classList.toggle('bad', res.bad);
            if (mergeNote && sortable && n > 1) {
              pages[i] = res.pages || 0;
              const known = pages.filter((p) => p > 0);
              if (known.length === n) mergeNote.textContent = 'ระบบจะรวม ' + n + ' ไฟล์เป็น PDF ไฟล์เดียว รวม ' + known.reduce((a, b) => a + b, 0) + ' หน้า เรียงตามลำดับด้านบน';
            }
          });
        }
      });
      pending.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'converting';
        li.innerHTML = '<span class="name"></span><small class="muted"></small>';
        li.querySelector('.name').textContent = item.name;
        item.el = li.querySelector('small');
        item.el.textContent = item.text;
        list.appendChild(li);
      });
    }
    function add(files) {
      let picked = Array.from(files);
      if (convertUrl) {
        picked.filter(isWord).forEach(convertWord);
        picked = picked.filter((f) => !isWord(f));
        if (!picked.length) return;
      }
      if (single && picked.length) dt = new DataTransfer();
      (single ? picked.slice(-1) : picked).forEach((f) => dt.items.add(f));
      render();
    }
    input.addEventListener('change', () => {
      const picked = Array.from(input.files);
      input.files = dt.files;
      add(picked);
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files);
    });
  });

  // ---------- ช่องเซ็นชื่อ ----------
  document.querySelectorAll('[data-sigpad]').forEach((pad) => {
    const canvas = pad.querySelector('canvas');
    const out = pad.querySelector('input[name=signature]');
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let dirty = false;
    let last = null;
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
    }
    function save() {
      out.value = dirty ? canvas.toDataURL('image/png') : '';
    }
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      last = pos(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.strokeStyle = '#0d1b4c';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      dirty = true;
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
      canvas.addEventListener(ev, () => {
        if (drawing) save();
        drawing = false;
      })
    );
    pad.querySelector('[data-clear]').addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
      save();
    });
    const file = pad.querySelector('[data-file]');
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        dirty = true;
        save();
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(f);
    });
  });

  // ---------- รวมคะแนนแบบประเมิน ----------
  document.querySelectorAll('[data-rubric]').forEach((box) => {
    const max = Number(box.dataset.max) || 0;
    const count = Number(box.dataset.count) || 0;
    function level(pct) {
      if (pct >= 90) return 'ดีมาก';
      if (pct >= 70) return 'ดี';
      if (pct >= 50) return 'ปานกลาง';
      if (pct >= 30) return 'พอใช้';
      return 'ปรับปรุง';
    }
    function update() {
      const picked = box.querySelectorAll('input[type=radio]:checked');
      let sum = 0;
      picked.forEach((r) => (sum += Number(r.value)));
      const lvl = picked.length === count ? 'ระดับ' + level((sum / max) * 100) : 'ให้แล้ว ' + picked.length + ' จาก ' + count + ' ข้อ';
      document.querySelectorAll('[data-total]').forEach((el) => (el.textContent = sum));
      document.querySelectorAll('[data-level]').forEach((el) => (el.textContent = lvl));
      document.querySelectorAll('[data-done]').forEach((el) => (el.textContent = picked.length));
      document.querySelectorAll('[data-meter]').forEach((el) => (el.style.width = (count ? (picked.length / count) * 100 : 0) + '%'));
    }
    box.addEventListener('change', update);
    document.querySelectorAll('[data-fill-btn]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = b.dataset.fillBtn;
        if (v === '0') box.querySelectorAll('input[type=radio]').forEach((r) => (r.checked = false));
        else box.querySelectorAll('input[type=radio][value="' + v + '"]').forEach((r) => (r.checked = true));
        update();
      })
    );
    update();
  });

  // ---------- เมนูด้านซ้ายบนมือถือ ----------
  document.querySelectorAll('[data-side-open]').forEach((b) => b.addEventListener('click', () => document.body.classList.add('side-open')));
  document.querySelectorAll('[data-side-close]').forEach((b) => b.addEventListener('click', () => document.body.classList.remove('side-open')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('side-open');
  });

  // ---------- โหมดกลางคืนและตัวอักษรใหญ่ (จำไว้ในเครื่องนี้) ----------
  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem('plan-prefs') || '{}');
    } catch {
      return {};
    }
  }
  function showPrefs() {
    const p = readPrefs();
    document.querySelectorAll('[data-pref]').forEach((b) => {
      const on = Boolean(p[b.dataset.pref]);
      b.setAttribute('aria-pressed', String(on));
      const label = b.querySelector('[data-on]');
      if (label) label.textContent = on ? label.dataset.on : label.dataset.off;
    });
  }
  document.querySelectorAll('[data-pref]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = readPrefs();
      const key = b.dataset.pref;
      p[key] = !p[key];
      try {
        localStorage.setItem('plan-prefs', JSON.stringify(p));
      } catch {
        // เบราว์เซอร์ไม่ให้จำ ใช้ได้เฉพาะหน้านี้
      }
      document.documentElement.classList.toggle(key, p[key]);
      showPrefs();
    })
  );
  showPrefs();

  // ---------- ประโยคสำเร็จรูป ----------
  function addText(ta, text) {
    const cur = ta.value.replace(/\s+$/, '');
    ta.value = cur ? cur + '\n' + text : text;
    ta.focus();
    // เลือกคำในวงเล็บให้พิมพ์ทับได้ทันที
    const at = ta.value.lastIndexOf('[');
    const end = ta.value.indexOf(']', at);
    if (at >= ta.value.length - text.length && end > at) ta.setSelectionRange(at, end + 1);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.querySelectorAll('[data-chip]').forEach((c) =>
    c.addEventListener('click', () => {
      const ta = document.getElementById(c.dataset.target);
      if (ta) addText(ta, c.dataset.chip);
    })
  );

  // ---------- คัดลอกจากบันทึกฉบับก่อน ----------
  document.querySelectorAll('[data-copy-prev]').forEach((b) =>
    b.addEventListener('click', async () => {
      let data = {};
      try {
        data = JSON.parse(b.dataset.copyPrev);
      } catch {
        return;
      }
      const fields = Object.keys(data).map((k) => document.getElementById(k)).filter(Boolean);
      if (fields.some((f) => f.value.trim())) {
        const ok = await ask('ช่องที่พิมพ์ไว้แล้วจะถูกแทนที่ด้วยข้อความจากบันทึกฉบับก่อน', { ok: 'คัดลอก' });
        if (!ok) return;
      }
      fields.forEach((f) => (f.value = data[f.id] || ''));
      b.textContent = 'คัดลอกแล้ว แก้ไขได้ตามต้องการ';
    })
  );

  // ---------- พูดแทนพิมพ์ ----------
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('[data-mic]').forEach((btn) => {
    const ta = document.getElementById(btn.dataset.mic);
    if (!Speech || !ta || !window.isSecureContext) {
      btn.remove();
      return;
    }
    ta.classList.add('has-mic');
    let rec = null;
    btn.addEventListener('click', () => {
      if (rec) {
        rec.stop();
        return;
      }
      rec = new Speech();
      rec.lang = 'th-TH';
      rec.interimResults = false;
      rec.continuous = true;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const t = e.results[i][0].transcript.trim();
            if (t) ta.value = ta.value ? ta.value.replace(/\s+$/, '') + ' ' + t : t;
          }
        }
      };
      rec.onend = () => {
        rec = null;
        btn.classList.remove('on');
        btn.setAttribute('aria-pressed', 'false');
      };
      rec.onerror = () => rec && rec.stop();
      rec.start();
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  // ---------- เลือกวิธีเขียนบันทึกหลังแผน ----------
  document.querySelectorAll('input[name=note_mode]').forEach((r) => {
    function apply() {
      const mode = document.querySelector('input[name=note_mode]:checked');
      document.querySelectorAll('[data-mode]').forEach((el) => (el.hidden = !mode || el.dataset.mode !== mode.value));
    }
    r.addEventListener('change', apply);
    apply();
  });

  // ---------- เปิดไฟล์ในกรอบดูไฟล์ ----------
  // ปุ่มเลือกไฟล์ และปุ่ม "เปิดดู" ในรายการไฟล์ เปิดไฟล์ในกรอบแสดงไฟล์ของหน้านี้ (ไม่ดาวน์โหลด)
  document.querySelectorAll('[data-view-file]').forEach((b) =>
    b.addEventListener('click', () => {
      const box = document.querySelector('[data-pdfbox]');
      if (!box) return;
      box.dispatchEvent(new CustomEvent('pdfbox:open', { detail: { url: b.dataset.viewFile, type: b.dataset.type || 'pdf' } }));
      box.querySelectorAll('[data-view-file]').forEach((x) => {
        const on = x.dataset.viewFile === b.dataset.viewFile;
        x.classList.toggle('btn-primary', on);
        x.classList.toggle('btn-ghost', !on);
      });
      const name = box.querySelector('[data-viewer-name]');
      if (name) name.textContent = b.dataset.name || '';
      const dl = box.querySelector('[data-viewer-dl]');
      if (dl) dl.href = b.dataset.viewFile + '?dl=1';
      if (!box.contains(b)) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );

  // ---------- ปุ่มความเห็นสำเร็จรูปของผู้ตรวจ ----------
  document.querySelectorAll('[data-say]').forEach((c) =>
    c.addEventListener('click', () => {
      const input = document.getElementById(c.dataset.target);
      if (!input) return;
      input.value = c.dataset.say;
      document.querySelectorAll('[data-say][data-target="' + c.dataset.target + '"]').forEach((x) => x.classList.toggle('on', x === c));
    })
  );

  // ---------- กราฟผลการสอน: แตะแท่งเพื่อดูรายละเอียด ----------
  document.querySelectorAll('[data-bars]').forEach((box) => {
    const rows = JSON.parse(box.dataset.bars || '[]');
    const out = box.querySelector('[data-bar-sel]');
    function pick(i) {
      const r = rows[i];
      if (!r || !out) return;
      box.querySelectorAll('[data-bar-i]').forEach((b) => b.classList.toggle('sel', Number(b.dataset.barI) === i));
      box.querySelectorAll('[data-bar-l]').forEach((b) => b.classList.toggle('sel', Number(b.dataset.barL) === i));
      out.querySelector('b').textContent = 'แผนที่ ' + r.no + ' ' + (r.topic || '');
      out.querySelector('span').textContent = 'ผ่าน ' + r.passed + ' จาก ' + r.total + ' คน คิดเป็นร้อยละ ' + r.pct;
    }
    box.querySelectorAll('[data-bar-i]').forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.barI))));
    pick(Number(box.dataset.start || 0));
  });

  // ---------- เลือกทั้งหมด ----------
  document.querySelectorAll('[data-check-all]').forEach((all) => {
    const name = all.dataset.checkAll;
    const counter = document.querySelector('[data-checked-count="' + name + '"]');
    const boxes = () => Array.from(document.querySelectorAll('input[name="' + name + '"]:not(:disabled)'));
    function count() {
      if (counter) counter.textContent = boxes().filter((b) => b.checked).length;
    }
    all.addEventListener('change', () => {
      boxes().forEach((b) => (b.checked = all.checked));
      count();
    });
    document.addEventListener('change', (e) => {
      if (e.target.name === name) count();
    });
    count();
  });

  // ---------- ปุ่มเลื่อนไปยังส่วนที่ต้องการ (แถบให้คะแนนบนมือถือ) ----------
  document.querySelectorAll('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.goto);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el.tagName === 'TEXTAREA') setTimeout(() => el.focus(), 350);
    })
  );

  // ---------- แถบให้คะแนนแบบย่อบนมือถือ: แตะเพื่อขยาย ปิดเพื่อย่อ ----------
  document.querySelectorAll('[data-sheet]').forEach((sheet) => {
    const set = (on) => {
      sheet.classList.toggle('open', on);
      document.body.classList.toggle('sheet-open', on);
    };
    sheet.querySelectorAll('[data-sheet-open]').forEach((b) => b.addEventListener('click', () => set(true)));
    document.querySelectorAll('[data-sheet-close]').forEach((b) => b.addEventListener('click', () => set(false)));
    sheet.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => set(false)));
  });

  // แถบด้านล่างและด้านบนหลบเองตอนเลื่อนอ่าน หยุดเลื่อนหรือเลื่อนขึ้นแล้วกลับมา (เฉพาะหน้าตรวจบนมือถือ)
  if (document.querySelector('.sheet-bar.mini')) {
    let timer = null;
    const watch = (el, getY) => {
      let last = getY();
      el.addEventListener(
        'scroll',
        () => {
          const y = getY();
          if (!document.body.classList.contains('sheet-open')) {
            if (y > last + 8) document.body.classList.add('bars-away');
            else if (y < last - 8) document.body.classList.remove('bars-away');
          }
          last = y;
          clearTimeout(timer);
          timer = setTimeout(() => document.body.classList.remove('bars-away'), 900);
        },
        { passive: true }
      );
    };
    watch(window, () => window.scrollY);
    document.querySelectorAll('.pdf-pages').forEach((p) => watch(p, () => p.scrollTop));
  }

  // ---------- เลือกทุกคนที่ยังส่งไม่ครบ ----------
  document.querySelectorAll('[data-select-todo]').forEach((b) =>
    b.addEventListener('click', () => {
      const boxes = document.querySelectorAll('input[data-todo]');
      boxes.forEach((x) => (x.checked = true));
      if (boxes[0]) boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    })
  );

  // ---------- เติมชื่อวิชาจากรหัส ----------
  const code = document.querySelector('[data-subject-code]');
  if (code) {
    code.addEventListener('change', () => {
      const opt = document.querySelector('#subject-list option[value="' + CSS.escape(code.value.trim()) + '"]');
      if (!opt) return;
      const name = document.querySelector('[name=subject_name]');
      const grade = document.querySelector('[name=grade_level]');
      if (name && !name.value) name.value = opt.dataset.name || '';
      if (grade && opt.dataset.grade && !grade.value) grade.value = opt.dataset.grade;
    });
  }

  // ---------- ปุ่มพิมพ์ ----------
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  // ---------- ปุ่มกรอกบัญชีทดลอง ----------
  document.querySelectorAll('[data-demo-user]').forEach((b) =>
    b.addEventListener('click', () => {
      const f = document.querySelector('form[data-login]');
      const all = Array.from(f.querySelectorAll('[name=username]'));
      const u = all.find((x) => x.tagName === 'SELECT') || all.find((x) => !x.disabled);
      all.forEach((x) => (x.disabled = x !== u));
      if (u.tagName === 'SELECT') u.add(new Option(b.dataset.demoUser, b.dataset.demoUser));
      u.value = b.dataset.demoUser;
      f.elements.password.value = b.dataset.demoPass;
      f.submit();
    })
  );
})();
