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

  // ---------- ส่งฟอร์มที่มีไฟล์ ----------
  // 1) แผนและคู่มือที่เลือกหลาย PDF รวมเป็นไฟล์เดียวในเครื่องนี้ก่อน (public/js/pdfmerge.js + pdf-lib)
  // 2) ส่งไฟล์ทีละไฟล์ ท่อนละ 5 MB ได้ token กลับมา (แถบความคืบหน้ารวมทุกท่อนทุกไฟล์)
  // 3) ส่งฟอร์มแบบปกติ (ไม่มีไฟล์) พร้อม token ในช่อง upload_<ชื่อช่องไฟล์>
  const NET_ERROR = 'เชื่อมต่อระบบไม่ได้ ตรวจสอบอินเทอร์เน็ตหรือ Wi-Fi แล้วลองใหม่';

  class SendError extends Error {
    constructor(msg) {
      super(msg);
      this.userMessage = msg;
    }
  }

  // คำขอ XHR คืน JSON · onUp(ไบต์ที่ส่งแล้ว) สำหรับแถบความคืบหน้า
  function request(method, url, body, headers, onUp) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (onUp) xhr.upload.onprogress = (e) => onUp(e.loaded);
      xhr.onload = () => {
        let res = null;
        try {
          res = JSON.parse(xhr.responseText);
        } catch {
          res = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && res) return resolve(res);
        const e = new SendError((res && res.error) || 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
        // เซิร์ฟเวอร์ปลายทางไม่ตอบ (Cloudflare ตอบหน้าข้อผิดพลาดแทน) ถือว่าเชื่อมต่อไม่ได้ ลองใหม่ได้
        e.net = xhr.status >= 500 && !res;
        reject(e);
      };
      xhr.onerror = () => {
        const e = new SendError(NET_ERROR);
        e.net = true;
        reject(e);
      };
      xhr.send(body);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new SendError(NET_ERROR));
      document.head.appendChild(s);
    });
  }

  // วาดหน้าแรกของ PDF ลงผืนผ้าใบด้วย PDF.js ที่มากับระบบ · width = ความกว้างเป็นพิกเซลบนจอ · คืน { canvas, pages } หรือ null ถ้าถูกยกเลิก
  async function renderFirstPage(data, width, dpr, alive) {
    const pdfjs = await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({
      data,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
    });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      if (alive && !alive()) return null;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      const ctx = canvas.getContext('2d');
      // พื้นขาวก่อนวาด รูป JPEG จึงไม่เป็นพื้นดำตรงที่โปร่งใส
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      return { canvas, pages: doc.numPages };
    } finally {
      task.destroy().catch(() => {});
    }
  }

  // รูปปกเล็กสำหรับคลังงาน: กว้าง 300 px JPEG ราว 20 ถึง 40 KB ใหญ่เกินลดคุณภาพลง · ทำไม่ได้คืน null (ระบบวาดปกให้แทน)
  const THUMB_MAX = 40 * 1024;
  async function makeThumb(data) {
    try {
      const r = await renderFirstPage(data, 300, 1);
      let blob = null;
      for (const quality of [0.75, 0.6, 0.45, 0.32]) {
        blob = await new Promise((res) => r.canvas.toBlob(res, 'image/jpeg', quality));
        if (!blob || blob.size <= THUMB_MAX) break;
      }
      return blob && blob.size <= 300 * 1024 ? blob : null;
    } catch {
      return null;
    }
  }

  async function mergeInBrowser(files) {
    if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
    if (!window.PdfMerge) await loadScript('/static/js/pdfmerge.js');
    const list = [];
    for (const f of files) list.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    return window.PdfMerge.mergePdfs(window.PDFLib, list);
  }

  // ไฟล์ที่ต้องส่งจากทุกช่องในฟอร์ม เรียงตามลำดับที่ครูจัด
  async function collectFiles(form) {
    const jobs = [];
    for (const input of form.querySelectorAll('input[type=file][name]')) {
      const files = Array.from(input.files || []);
      if (!files.length) continue;
      const zone = input.closest('[data-dropzone]');
      const merge = zone && zone.hasAttribute('data-sortable') && files.length > 1 && files.every((f) => /\.pdf$/i.test(f.name));
      if (merge) {
        showBusy('กำลังรวมไฟล์ PDF', false);
        const m = await mergeInBrowser(files);
        jobs.push({ field: input.name, blob: new Blob([m.bytes], { type: 'application/pdf' }), name: 'merged.pdf', merged: files.length, pages: m.pages });
      } else {
        files.forEach((f, i) => jobs.push({ field: input.name, blob: f, name: f.name, idx: i, count: files.length }));
      }
      // คลังงาน: รูปปกเล็กจากหน้าแรกของไฟล์แรก (ปกของไฟล์ที่รวมแล้ว)
      if (zone && zone.hasAttribute('data-thumb') && /\.pdf$/i.test(files[0].name)) {
        showBusy('กำลังทำรูปปก', false);
        const thumb = await makeThumb(new Uint8Array(await files[0].arrayBuffer()));
        if (thumb) jobs.push({ field: 'cover_thumb', blob: thumb, name: 'cover.jpg' });
      }
    }
    return jobs;
  }

  // ---------- ส่งต่อเมื่อเน็ตหลุด (ฟังก์ชันเสริม resume) ----------
  // ท่อนส่งไม่สำเร็จ: ถามระบบว่าได้รับถึงไหน (GET /upload/token) แล้วส่งต่อจากตรงนั้น ไม่ต้องเริ่มใหม่ทั้งไฟล์
  // ระหว่างเน็ตหลุด แถบเป็นสีเหลือง ลองใหม่เองเรื่อย ๆ (และทันทีที่เครื่องต่อเน็ตได้) รอเกิน 2 นาทีขึ้นปุ่มส่งต่อจากที่ค้างให้กดเอง
  const RESUME = Boolean(busy && busy.hasAttribute('data-resume'));
  const AUTO_WAIT_MS = 2 * 60 * 1000;
  const CANCELLED = 'ยกเลิกการส่งแล้ว ไฟล์ยังไม่ได้ส่ง กดบันทึกอีกครั้งเมื่อพร้อม';

  function showPaused(on, manual) {
    if (!RESUME) return;
    const box = busy.querySelector('.overlay-box');
    box.classList.toggle('paused', on);
    busy.querySelector('[data-net]').hidden = !on;
    busy.querySelector('[data-net-btns]').hidden = !on;
    busy.querySelector('[data-resume-now]').hidden = !manual;
    if (!on) return;
    busy.querySelector('[data-net-title]').textContent = manual ? 'ยังเชื่อมต่อไม่ได้' : 'อินเทอร์เน็ตหลุด กำลังรอเชื่อมต่อใหม่';
    busy.querySelector('[data-net-text]').textContent = manual
      ? 'ตรวจ Wi-Fi แล้วกดส่งต่อ ระบบส่งต่อจากส่วนที่ค้าง ไม่ต้องเริ่มใหม่'
      : 'ไม่ต้องปิดหน้านี้ เน็ตกลับมาแล้วระบบส่งต่อจากส่วนที่ค้างให้เอง';
  }

  // รอ ms มิลลิวินาที หรือจนเครื่องต่อเน็ตได้ หรือกดส่งต่อ · กดยกเลิกแล้วโยนข้อผิดพลาด
  function pauseFor(ms) {
    return new Promise((resolve, reject) => {
      const go = busy.querySelector('[data-resume-now]');
      const stop = busy.querySelector('[data-cancel-send]');
      const timer = ms ? setTimeout(done, ms) : null;
      function off() {
        clearTimeout(timer);
        window.removeEventListener('online', done);
        go.removeEventListener('click', done);
        stop.removeEventListener('click', cancel);
      }
      function done() {
        off();
        resolve();
      }
      function cancel() {
        off();
        reject(new SendError(CANCELLED));
      }
      window.addEventListener('online', done);
      go.addEventListener('click', done);
      stop.addEventListener('click', cancel);
    });
  }

  // ถามระบบว่าไฟล์นี้ได้รับถึงไหน รอจนกว่าจะถามได้ · ระบบตอบว่าใช้ไม่ได้แล้ว (หมดเวลา) โยนข้อความนั้น
  async function askWhere(token, quiet) {
    const t0 = Date.now();
    let delay = 1000;
    for (let first = true; ; first = false) {
      if (!first) {
        const manual = !quiet && Date.now() - t0 > AUTO_WAIT_MS;
        if (!quiet) showPaused(true, manual);
        if (quiet && Date.now() - t0 > AUTO_WAIT_MS) throw new SendError(NET_ERROR);
        await pauseFor(manual ? 0 : delay);
        delay = Math.min(delay * 2, 10000);
      }
      try {
        const st = await request('GET', '/upload/' + encodeURIComponent(token) + '?t=' + Date.now());
        showPaused(false);
        return st;
      } catch (err) {
        if (!err.net) {
          showPaused(false);
          throw err;
        }
      }
    }
  }

  // ส่งไฟล์ 1 ก้อนทีละท่อนจนครบ · onBytes(ไบต์ที่ส่งแล้วของก้อนนี้) · quiet = ทำเบื้องหลัง (รูปปก) ไม่ขึ้นแถบรอเน็ต
  async function sendChunks(token, blob, chunk, onBytes, quiet) {
    const size = blob.size;
    let pos = 0;
    let fails = 0;
    do {
      const end = Math.min(pos + chunk, size);
      const range = size ? 'bytes ' + pos + '-' + (end - 1) + '/' + size : 'bytes */0';
      const from = pos;
      try {
        await request('PUT', '/upload/' + encodeURIComponent(token), blob.slice(pos, end), { 'Content-Type': 'application/octet-stream', 'Content-Range': range }, onBytes && ((n) => onBytes(from + n)));
        pos = end;
        fails = 0;
      } catch (err) {
        // ระบบตอบกลับได้แต่ส่งท่อนเดิมไม่ผ่านซ้ำหลายรอบ เลิกแล้วบอกข้อความเดิม
        if (!RESUME || ++fails > 5) throw err;
        const st = await askWhere(token, quiet);
        if (st.done) return;
        pos = st.received;
        if (onBytes) onBytes(pos);
      }
    } while (pos < size);
  }

  async function sendWithProgress(form, submitter) {
    // ใช้ getAttribute เพราะปุ่มชื่อ action จะบัง form.action
    const url = form.getAttribute('action') || window.location.pathname;
    const title = submitter && submitter.value === 'submit' ? 'กำลังส่งงาน' : 'กำลังบันทึก';
    const data = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === 'string') data.append(k, v);
    if (submitter && submitter.name) data.set(submitter.name, submitter.value);
    try {
      const jobs = await collectFiles(form);
      showBusy(title, true);
      setProgress(0);
      const total = jobs.reduce((a, j) => a + j.blob.size, 0) || 1;
      let sent = 0;
      for (const j of jobs) {
        const info = new URLSearchParams({ form: url, field: j.field, name: j.name, size: String(j.blob.size), idx: String(j.idx || 0), count: String(j.count || 1) });
        if (j.merged) info.set('merged', String(j.merged));
        ['doc_type', 'subject_code', 'subject_name', 'plan_id'].forEach((k) => data.has(k) && info.set(k, data.get(k)));
        const start = await request('POST', '/upload/start', info, { 'Content-Type': 'application/x-www-form-urlencoded' });
        const base = sent;
        await sendChunks(start.token, j.blob, start.chunk, (n) => setProgress(Math.min(99, Math.round(((base + n) / total) * 100))));
        sent += j.blob.size;
        data.append('upload_' + j.field, start.token);
        if (j.merged) {
          data.set('upload_merged', String(j.merged));
          data.set('upload_pages', String(j.pages));
        }
      }
      setProgress(100);
      const res = await request('POST', url, data, { 'Content-Type': 'application/x-www-form-urlencoded' });
      if (res.redirect) {
        window.location.href = res.redirect;
        return;
      }
      hideBusy();
      tell('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } catch (err) {
      showPaused(false);
      hideBusy();
      tell((err && err.userMessage) || NET_ERROR);
    }
  }

  // ส่งไฟล์ 1 ก้อนเข้าที่เก็บไฟล์ทีละท่อน คืน token · info = ข้อมูลฟอร์มสำหรับ /upload/start
  async function uploadBlob(blob, info) {
    const start = await request('POST', '/upload/start', new URLSearchParams({ ...info, size: String(blob.size) }), { 'Content-Type': 'application/x-www-form-urlencoded' });
    await sendChunks(start.token, blob, start.chunk, null, true);
    return start.token;
  }

  // ทำรูปปกจากหน้าแรกของไฟล์ PDF ในเครื่องนี้ แล้วส่งเข้าระบบ 1 เล่ม · it = { id: งาน, file: ไฟล์ } สำเร็จคืน true
  async function coverFromFile(it) {
    try {
      const pdf = await fetch('/f/' + it.file + '/raw');
      const thumb = pdf.ok ? await makeThumb(new Uint8Array(await pdf.arrayBuffer())) : null;
      if (!thumb) return false;
      const url = '/library/cover/' + it.id;
      const token = await uploadBlob(thumb, { form: url, field: 'cover_thumb', name: 'cover.jpg' });
      await request('POST', url, new URLSearchParams({ upload_cover_thumb: token }), { 'Content-Type': 'application/x-www-form-urlencoded' });
      return true;
    } catch {
      return false;
    }
  }

  // ผู้ดูแลระบบ (coverswap) เปลี่ยนเล่มที่เลือกปกระบบไว้ กลับไปใช้รูปจากไฟล์ · items = [{ id, file, code }]
  async function coversBackToFile(items) {
    let made = 0;
    const codes = [];
    try {
      showBusy('กำลังทำรูปปกจากไฟล์', true);
      setProgress(0);
      for (let i = 0; i < items.length; i++) {
        busy.querySelector('[data-pct]').textContent = 'เล่มที่ ' + (i + 1) + ' จาก ' + items.length;
        busy.querySelector('[data-bar] > div').style.width = Math.round((i / items.length) * 100) + '%';
        if (items[i].file && (await coverFromFile(items[i]))) {
          made++;
          codes.push(items[i].code);
        }
      }
      if (made) await request('POST', '/library/covers/done', new URLSearchParams({ n: String(made), what: 'file', codes: codes.sort().join(', ') }), { 'Content-Type': 'application/x-www-form-urlencoded' });
      hideBusy();
      const failed = items.length - made;
      await tell('ใช้รูปจากไฟล์แล้ว ' + made + ' เล่ม' + (failed ? ' ทำไม่ได้ ' + failed + ' เล่ม (ไฟล์ไม่ใช่ PDF หรือเปิดไม่ได้ ยังเป็นปกที่ระบบวาด)' : ''), made ? 'ok' : 'warn');
      window.location.reload();
    } catch (err) {
      hideBusy();
      tell((err && err.userMessage) || NET_ERROR);
    }
  }

  // ผู้ดูแลระบบ สร้างปกงานเดิมในคลังงาน: เปิด PDF ทีละเล่มในเครื่องนี้ ทำรูปปกเล็ก แล้วส่งเข้าระบบทีละรูป
  async function buildCovers(form) {
    let made = 0;
    let failed = 0;
    try {
      showBusy('กำลังสร้างปก', true);
      setProgress(0);
      const res = await fetch('/library/covers/todo', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const items = res.ok ? (await res.json()).items : [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        busy.querySelector('[data-pct]').textContent = 'เล่มที่ ' + (i + 1) + ' จาก ' + items.length;
        busy.querySelector('[data-bar] > div').style.width = Math.round((i / items.length) * 100) + '%';
        if (await coverFromFile(it)) made++;
        else failed++;
      }
      await request('POST', form.getAttribute('action'), new URLSearchParams({ n: String(made) }), { 'Content-Type': 'application/x-www-form-urlencoded' });
      hideBusy();
      await tell('สร้างปกเรียบร้อย ' + made + ' เล่ม' + (failed ? ' ทำไม่ได้ ' + failed + ' เล่ม (ไฟล์เปิดไม่ได้ ระบบใช้ปกที่วาดให้แทน)' : ''), 'ok');
      window.location.reload();
    } catch (err) {
      hideBusy();
      tell((err && err.userMessage) || NET_ERROR);
    }
  }

  // ส่งต่อจริง: ฟอร์มมีไฟล์ใช้ XHR พร้อมแถบความคืบหน้า ฟอร์มอื่นปล่อยเบราว์เซอร์ส่งตามปกติ
  function proceed(e, form, submitter) {
    if (form.hasAttribute('data-covers')) {
      e.preventDefault();
      buildCovers(form);
    } else if (form.classList.contains('js-upload')) {
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
      if (form.querySelector('[data-dz-list] li.bad')) {
        e.preventDefault();
        await tell('มีไฟล์ที่ใช้ไม่ได้ (กรอบสีแดง) กดเอาออก แล้วเลือกไฟล์ใหม่ก่อน');
        return;
      }
      if (submitter && submitter.dataset.needChecked) {
        if (!form.querySelector('input[name="' + submitter.dataset.needChecked + '"]:checked')) {
          e.preventDefault();
          await tell(submitter.dataset.needMessage || 'ยังไม่ได้เลือกรายการ');
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

  // ---------- คลังงานการจัดการเรียนรู้: สลับมุมมอง (เครื่องจำไว้) และโหลดเพิ่มทีละชุด ----------
  const lib = document.querySelector('[data-lib]');
  if (lib) {
    const LIBVIEW = 'plan-libview';
    const viewBtns = document.querySelectorAll('[data-lib-view]');
    const mark = () => viewBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libView === lib.getAttribute('data-view'))));
    mark();
    viewBtns.forEach((b) =>
      b.addEventListener('click', () => {
        lib.setAttribute('data-view', b.dataset.libView);
        mark();
        try {
          localStorage.setItem(LIBVIEW, b.dataset.libView);
        } catch {
          // เครื่องนี้ไม่ให้จำ ไม่เป็นไร
        }
      })
    );
    const more = lib.querySelector('[data-lib-more]');
    if (more) {
      more.addEventListener('click', async (e) => {
        e.preventDefault();
        if (more.getAttribute('aria-busy') === 'true') return;
        more.setAttribute('aria-busy', 'true');
        const label = more.textContent;
        more.textContent = 'กำลังโหลด';
        try {
          const res = await fetch(more.getAttribute('href') + '&part=1', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          if (!res.ok) throw new Error('load');
          const tpl = document.createElement('template');
          tpl.innerHTML = await res.text();
          // ชุดใหม่เริ่มด้วยกลุ่มสาระเดียวกับเล่มสุดท้าย ต่อแถวเดิม ไม่ขึ้นหัวกลุ่มซ้ำ
          const box = lib.querySelector('[data-lib-books]');
          const last = box.querySelector('.lib-grp:last-of-type');
          const first = tpl.content.querySelector('.lib-grp');
          if (last && first && last.dataset.dept === first.dataset.dept) {
            last.querySelector('[data-lib-row]').append(...first.querySelector('[data-lib-row]').children);
            first.remove();
          }
          box.appendChild(tpl.content);
          const next = res.headers.get('X-Lib-Next');
          const left = Number(res.headers.get('X-Lib-Left')) || 0;
          if (next) {
            more.setAttribute('href', next);
            more.textContent = 'โหลดเพิ่มอีก ' + Math.min(24, left) + ' เล่ม';
          } else {
            more.parentElement.remove();
          }
        } catch {
          more.textContent = label;
          tell(NET_ERROR);
        }
        more.removeAttribute('aria-busy');
      });
    }

    // ผู้ดูแลระบบเปลี่ยนปก (coverswap): โหมด one ปุ่มบนปก · many เลือกหลายเล่ม เครื่องจำโหมดไว้
    const bar = document.querySelector('[data-swapbar]');
    if (bar && lib.hasAttribute('data-swap')) {
      const SWAP = 'plan-libswap';
      const modeBtns = bar.querySelectorAll('[data-swap-mode]');
      const checks = () => Array.from(document.querySelectorAll('.lib-ck input:checked'));
      const count = () => {
        const on = checks();
        bar.querySelector('[data-swap-count]').textContent = on.length ? 'เลือกแล้ว ' + on.length + ' เล่ม' : 'กดที่ปกเพื่อเลือกเล่ม';
        bar.querySelector('[data-swap-go="drawn"]').disabled = !on.some((c) => c.dataset.is !== 'drawn');
        bar.querySelector('[data-swap-go="file"]').disabled = !on.some((c) => c.dataset.is !== 'img');
      };
      const setMode = (m, save) => {
        lib.setAttribute('data-swap', m);
        bar.setAttribute('data-swap', m);
        modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.swapMode === m)));
        if (m !== 'many') document.querySelectorAll('.lib-ck input').forEach((c) => (c.checked = false));
        count();
        if (save) {
          try {
            localStorage.setItem(SWAP, m);
          } catch {
            // เครื่องนี้ไม่ให้จำ ไม่เป็นไร
          }
        }
      };
      let saved = '';
      try {
        saved = localStorage.getItem(SWAP) || '';
      } catch {
        // ใช้ค่าเริ่มต้น
      }
      setMode(saved === 'many' ? 'many' : 'one', false);
      modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.swapMode, true)));
      lib.addEventListener('change', (e) => e.target.closest('.lib-ck') && count());
      // โหมดเลือกหลายเล่ม: กดที่ปกหรือชื่อ = เลือก ไม่เปิดไฟล์ (เล่มที่โหลดเพิ่มก็ใช้ได้)
      lib.addEventListener('click', (e) => {
        if (lib.getAttribute('data-swap') !== 'many' || e.target.closest('.lib-ck, .lib-more')) return;
        const book = e.target.closest('.lib-book');
        const box = book && book.querySelector('.lib-ck input');
        if (!box) return;
        e.preventDefault();
        box.checked = !box.checked;
        count();
      });
      // ปุ่มบนปก ใช้รูปจากไฟล์ (เล่มเดียว)
      lib.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-cover-file]');
        if (!b || lib.getAttribute('data-swap') !== 'one') return;
        e.preventDefault();
        if (!b.dataset.file) return tell('เล่มนี้ไม่มีไฟล์ PDF ให้ทำรูปปก');
        const ok = await ask('เปลี่ยนเล่ม ' + b.dataset.who + ' กลับไปใช้รูปหน้าแรกของไฟล์เป็นปก เครื่องนี้จะเปิดไฟล์แล้วทำรูปปกใหม่', { ok: 'ใช้รูปจากไฟล์' });
        if (ok) coversBackToFile([{ id: b.dataset.coverFile, file: b.dataset.file, code: b.dataset.code }]);
      });
      // แถบโหมดเลือกหลายเล่ม ใช้รูปจากไฟล์ (เฉพาะเล่มที่ยังไม่ใช่รูปจากไฟล์)
      bar.querySelector('[data-swap-go="file"]').addEventListener('click', async () => {
        const items = checks()
          .filter((c) => c.dataset.is !== 'img')
          .map((c) => ({ id: c.value, file: c.dataset.file, code: c.dataset.code }));
        if (!items.length) return;
        const ok = await ask('เปลี่ยนเล่มที่เลือก ' + items.length + ' เล่ม กลับไปใช้รูปหน้าแรกของไฟล์เป็นปก เครื่องนี้จะเปิดไฟล์ทีละเล่มแล้วทำรูปปกใหม่ ห้ามปิดหน้านี้จนกว่าจะเสร็จ', { ok: 'ใช้รูปจากไฟล์' });
        if (ok) coversBackToFile(items);
      });
    }
  }

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
    // ดูหน้าแรกของไฟล์ PDF ที่จะส่ง (ไฟล์แรกในรายการ = หน้าปกหลังรวมไฟล์) ด้วย PDF.js ที่มากับระบบ
    async function showCover(file) {
      if (!cover) return;
      const token = ++coverToken;
      if (!file || !/\.pdf$/i.test(file.name)) {
        cover.hidden = true;
        return;
      }
      try {
        const r = await renderFirstPage(new Uint8Array(await file.arrayBuffer()), 200, window.devicePixelRatio || 1, () => token === coverToken);
        if (!r || token !== coverToken) return;
        const box = cover.querySelector('[data-cover-img]');
        box.innerHTML = '';
        box.appendChild(r.canvas);
        cover.querySelector('[data-cover-info]').textContent = 'หน้าแรกของไฟล์ ' + file.name + (dt.files.length > 1 ? ' (หน้าปกของไฟล์ที่รวมแล้ว)' : ' ทั้งไฟล์ ' + r.pages + ' หน้า');
        cover.hidden = false;
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
    }
    function add(files) {
      const picked = Array.from(files);
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
    const mini = pad.querySelector('[data-mini-img]');
    const adjust = pad.querySelector('[data-adjust]');
    function save() {
      out.value = dirty ? canvas.toDataURL('image/png') : '';
      if (adjust) adjust.hidden = !dirty;
      // ตัวอย่างบนเอกสารเล็ก ๆ ใต้กรอบ (หน้าข้อมูลส่วนตัว)
      if (mini) {
        const src = out.value || pad.dataset.current || '';
        if (src) mini.setAttribute('src', src);
        mini.closest('[data-mini]').hidden = !src;
      }
    }
    canvas.addEventListener('pointerdown', (e) => {
      resetAdjust();
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
      resetAdjust();
      save();
    });
    // ---------- ปรับขนาดและสีเอง (ฟังก์ชันเสริม sigadjust) ----------
    // ฐาน = ลายเซ็นในกรอบที่ตัดขอบว่างแล้ว (จับไว้ตอนเริ่มปรับ) ขนาด 100 = เต็มกรอบ ลดได้ถึง 40
    // สีเปลี่ยนได้เฉพาะลายเซ็นที่พื้นใส (เซ็นในกรอบ รูปที่ปรับแล้ว ลายเซ็นที่บันทึกไว้) รูปถ่ายเดิมที่มีพื้นเปลี่ยนสีไม่ได้
    const range = pad.querySelector('[data-size-range]');
    let base = null;
    let tint = null;
    function resetAdjust() {
      base = null;
      tint = null;
      if (range) range.value = '100';
      pad.querySelectorAll('[data-color]').forEach((b) => b.classList.remove('on'));
    }
    function applyAdjust() {
      if (!dirty) return;
      if (!base) base = trimInk(canvas);
      if (!base) return;
      const zoom = (range ? Number(range.value) : 100) / 100;
      const m = 0.04;
      const k = Math.min((canvas.width * (1 - 2 * m)) / base.width, (canvas.height * (1 - 2 * m)) / base.height) * zoom;
      const w = base.width * k;
      const h = base.height * k;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      if (tint && base.clear) {
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      save();
    }
    if (range) {
      range.addEventListener('input', applyAdjust);
      pad.querySelectorAll('[data-size]').forEach((b) =>
        b.addEventListener('click', () => {
          range.value = String(Math.max(40, Math.min(100, Number(range.value) + Number(b.dataset.size) * 10)));
          applyAdjust();
        })
      );
      pad.querySelectorAll('[data-color]').forEach((b) =>
        b.addEventListener('click', () => {
          if (!dirty) return;
          if (!base) base = trimInk(canvas);
          if (!base || !base.clear) return tell('รูปนี้มีพื้นกระดาษ เปลี่ยนสีไม่ได้ กดใช้แบบปรับแล้วก่อน');
          tint = b.dataset.color;
          pad.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
          applyAdjust();
        })
      );
    }
    // แก้ลายเซ็นที่บันทึกไว้: ดึงลายเซ็นเดิมเข้ากรอบ ตัดขอบว่างให้เต็มกรอบ แล้วปรับต่อได้
    const editSaved = pad.querySelector('[data-edit-saved]');
    if (editSaved) {
      editSaved.addEventListener('click', () => {
        const img = new Image();
        img.onload = () => {
          resetAdjust();
          pic = null;
          if (note) note.hidden = true;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          dirty = true;
          applyAdjust();
        };
        img.onerror = () => tell('เปิดลายเซ็นที่บันทึกไว้ไม่ได้ ลองใหม่อีกครั้ง');
        img.src = pad.dataset.current;
      });
    }
    // วาดรูปลงกรอบให้พอดี · margin = ขอบว่างรอบรูป (สัดส่วนของกรอบ)
    function drawFit(src, margin) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const mw = canvas.width * (1 - 2 * margin);
      const mh = canvas.height * (1 - 2 * margin);
      const scale = Math.min(mw / src.width, mh / src.height);
      const w = src.width * scale;
      const h = src.height * scale;
      ctx.drawImage(src, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      dirty = true;
      save();
    }
    // ปรับรูปลายเซ็นอัตโนมัติ (ฟังก์ชันเสริม sigclean): มีป้ายบอก และกดสลับใช้รูปเดิมได้
    const note = pad.querySelector('[data-clean-note]');
    const toggle = pad.querySelector('[data-clean-toggle]');
    let pic = null;
    let usingClean = false;
    function showPic() {
      if (!pic) return;
      resetAdjust();
      if (usingClean) drawFit(pic.clean, 0.06);
      else drawFit(pic.img, 0);
      if (note) {
        note.hidden = !pic.clean;
        note.querySelector('[data-clean-text]').textContent = usingClean ? 'ปรับรูปให้แล้ว ตัดขอบว่าง ลบพื้นกระดาษ' : 'ใช้รูปเดิมอยู่';
        toggle.textContent = usingClean ? 'ใช้รูปเดิมแทน' : 'ใช้แบบปรับแล้ว';
      }
    }
    if (toggle) {
      toggle.addEventListener('click', () => {
        usingClean = !usingClean;
        showPic();
      });
    }
    canvas.addEventListener('pointerdown', () => {
      // เซ็นทับรูป: ไม่สลับรูปอีก
      pic = null;
      if (note) note.hidden = true;
    });
    const file = pad.querySelector('[data-file]');
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        let clean = null;
        if (pad.hasAttribute('data-clean')) {
          try {
            clean = cleanSignature(img);
          } catch {
            clean = null;
          }
        }
        pic = { img, clean };
        usingClean = Boolean(clean);
        showPic();
        URL.revokeObjectURL(img.src);
        file.value = '';
      };
      img.src = URL.createObjectURL(f);
    });
    pad.querySelector('[data-clear]').addEventListener('click', () => {
      pic = null;
      if (note) note.hidden = true;
    });
    // ดูตัวอย่างบนเอกสาร: ลายเซ็นในกรอบ (ถ้าเซ็นแล้ว) หรือลายเซ็นที่บันทึกไว้
    const prevBtn = pad.querySelector('[data-sig-preview]');
    const dlg = document.getElementById('sig-doc');
    if (prevBtn && dlg) {
      prevBtn.addEventListener('click', () => {
        const src = out.value || dlg.dataset.current || '';
        dlg.querySelectorAll('[data-sig-img]').forEach((im) => (src ? im.setAttribute('src', src) : im.removeAttribute('src')));
        dlg.querySelector('[data-sig-empty]').hidden = Boolean(src);
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      });
      dlg.querySelector('[data-sig-close]').addEventListener('click', () => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open')));
    }
    save();
  });

  // ตัดขอบว่างของผืนผ้าใบ (ส่วนที่ใส) คืนผืนผ้าใบใหม่ที่มีแต่ลายเซ็น · clear = พื้นใสเป็นส่วนใหญ่ (เปลี่ยนสีเส้นได้)
  function trimInk(src) {
    const W = src.width;
    const H = src.height;
    const d = src.getContext('2d').getImageData(0, 0, W, H).data;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    let see = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] < 24) continue;
        see++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < x0) return null;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    out.clear = see < W * H * 0.6;
    return out;
  }

  // ปรับรูปถ่ายลายเซ็น: ลบพื้นกระดาษให้ใส ทำเส้นเข้ม ตัดขอบว่าง ทำในเครื่องนี้ทั้งหมด
  // ความสว่างของกระดาษดูเป็นช่อง ๆ (รูปถ่ายมีเงาและแสงไม่เท่ากัน) จุดที่มืดกว่ากระดาษรอบ ๆ ชัดเจนนับเป็นหมึก
  // ได้ผืนผ้าใบที่ตัดขอบแล้ว หรือ null ถ้าไม่เหมือนรูปลายเซ็น (ใช้รูปเดิม)
  function cleanSignature(img) {
    const max = 1600;
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const W = Math.max(1, Math.round(img.width * k));
    const H = Math.max(1, Math.round(img.height * k));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const im = g.getImageData(0, 0, W, H);
    const d = im.data;
    const n = W * H;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = d[i * 4 + 3] / 255;
      // ส่วนที่โปร่งใสอยู่แล้วนับเป็นกระดาษขาว
      lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
    }
    // ความสว่างกระดาษของแต่ละช่อง = ค่าที่สว่างรองลงมา (กันจุดสว่างเดี่ยว) แล้วเกลี่ยระหว่างช่อง
    const B = Math.max(16, Math.round(Math.min(W, H) / 12));
    const gw = Math.ceil(W / B);
    const gh = Math.ceil(H / B);
    const grid = new Float32Array(gw * gh);
    for (let by = 0; by < gh; by++) {
      for (let bx = 0; bx < gw; bx++) {
        const vals = [];
        for (let y = by * B; y < Math.min(H, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x += 2) vals.push(lum[y * W + x]);
        vals.sort((p, q) => p - q);
        grid[by * gw + bx] = Math.max(40, vals[Math.floor(vals.length * 0.9)] || 255);
      }
    }
    const bgAt = (x, y) => {
      const fx = Math.min(gw - 1, Math.max(0, x / B - 0.5));
      const fy = Math.min(gh - 1, Math.max(0, y / B - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(gw - 1, x0 + 1);
      const y1 = Math.min(gh - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx;
      const bot = grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx;
      return top * (1 - ty) + bot * ty;
    };
    // ความทึบของหมึก: มืดกว่ากระดาษรอบ ๆ ไม่ถึง 20% = กระดาษ · มืดกว่า 40% ขึ้นไป = หมึกเต็ม
    const alpha = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const r = lum[i] / bgAt(x, y);
        alpha[i] = Math.max(0, Math.min(1, (0.8 - r) / 0.2));
      }
    }
    // ตัดจุดฝุ่น: จุดหมึกที่รอบตัวแทบไม่มีหมึก
    let ink = 0;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    const rows = new Uint32Array(H);
    const cols = new Uint32Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let a = alpha[i];
        if (a > 0) {
          let near = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && alpha[yy * W + xx] > 0.3) near++;
            }
          }
          if (near < 3) a = 0;
        }
        d[i * 4] = 13;
        d[i * 4 + 1] = 27;
        d[i * 4 + 2] = 76;
        d[i * 4 + 3] = Math.round(a * 255);
        if (a > 0.5) {
          ink++;
          rows[y]++;
          cols[x]++;
        }
      }
    }
    // หมึกน้อยเกินไปหรือมากเกินไป (รูปถ่ายทั่วไป ไม่ใช่ลายเซ็นบนกระดาษ) ไม่ปรับ
    if (ink < 30 || ink > n * 0.35) return null;
    // ขอบของลายเซ็น: ข้ามแถวและคอลัมน์ที่มีจุดหมึกน้อยมาก (ฝุ่น เงา)
    const minRow = Math.max(1, W * 0.002);
    const minCol = Math.max(1, H * 0.004);
    for (let y = 0; y < H; y++) {
      if (rows[y] < minRow) continue;
      y0 = Math.min(y0, y);
      y1 = y;
    }
    for (let x = 0; x < W; x++) {
      if (cols[x] < minCol) continue;
      x0 = Math.min(x0, x);
      x1 = x;
    }
    if (x1 < x0 || y1 < y0) return null;
    g.putImageData(im, 0, 0);
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad);
    y1 = Math.min(H - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

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
      const box = b.closest('[data-pdfbox]') || document.querySelector('[data-pdfbox]');
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
