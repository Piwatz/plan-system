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
    close: 'M6 6l12 12M18 6 6 18',
    next: 'm9 6 6 6-6 6',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
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

  // PDF.js ที่มากับระบบ · src = ข้อมูลไฟล์ (Uint8Array) หรือที่อยู่ไฟล์ในระบบ (โหลดเฉพาะส่วนที่ใช้ด้วย Range)
  async function pdfjsLib() {
    const pdfjs = await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
    return pdfjs;
  }
  function openPdf(pdfjs, src) {
    return pdfjs.getDocument({
      ...(typeof src === 'string' ? { url: src, disableAutoFetch: true, disableStream: true } : { data: src }),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
    });
  }

  // วาดหน้าแรกของ PDF ลงผืนผ้าใบ · width = ความกว้างเป็นพิกเซลบนจอ · คืน { canvas, pages } หรือ null ถ้าถูกยกเลิก
  async function renderFirstPage(data, width, dpr, alive) {
    const task = openPdf(await pdfjsLib(), data);
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
        ['doc_type', 'subject_code', 'subject_name', 'plan_id', 'for_teacher'].forEach((k) => data.has(k) && info.set(k, data.get(k)));
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

  // ---------- ต่อปกที่ระบบวาดลงในไฟล์ทีละหลายเล่ม (ฟังก์ชันเสริม libcoverpdf) หน้าคลังงาน ----------
  // 2 แบบ สลับได้ เครื่องจำไว้: all ใช้กับทุกเล่ม (เก็บหรือลบหน้า 1 เดิม) · each ดูหน้า 1 ของทุกเล่มแล้วเลือกทีละเล่ม
  // แต่ละเล่ม: เปิดไฟล์ในเครื่องนี้ ต่อปก (pdf-lib) แล้วส่งทางเดียวกับปุ่มเปลี่ยนปกในหน้างาน POST /s/<id>/cover
  const LP_MODE = 'plan-libpdf';
  const LP_SKIP = { done: 'ต่อปกระบบไว้แล้ว ข้าม', nopdf: 'ไม่มีไฟล์ PDF ข้าม', own: 'งานของตัวเองที่ผ่านครบแล้ว ข้าม' };
  function libCoverPdf(btn, checks) {
    const dlg = document.getElementById('lp-dlg');
    if (!dlg) return;
    const list = dlg.querySelector('[data-lp-list]');
    const okBtn = dlg.querySelector('[data-lp-ok]');
    const modeBtns = dlg.querySelectorAll('[data-lp-mode]');
    let items = [];
    let mode = 'all';
    try {
      mode = localStorage.getItem(LP_MODE) === 'each' ? 'each' : 'all';
    } catch {
      // ใช้ค่าเริ่มต้น
    }
    const oldDel = () => dlg.querySelector('input[name=lp_old]:checked').value === 'del';
    const skipped = (it) => mode === 'each' && it.row.querySelector('[data-lp-skip]').checked;
    // เล่มที่จะต่อจริงตามแบบที่เลือก { it, del }
    const plan = () =>
      items
        .filter((it) => it.st === 'ok' && !skipped(it))
        .map((it) => ({ it, del: mode === 'each' ? it.row.querySelector('[data-lp-del]').checked : oldDel() }));
    const refresh = () => {
      dlg.setAttribute('data-lp', mode);
      modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lpMode === mode)));
      dlg.querySelector('[data-lp-all]').hidden = mode !== 'all';
      dlg.querySelector('[data-lp-hint]').textContent = mode === 'each' ? 'ซ้าย หน้า 1 ตอนนี้ ขวา ปกใหม่ ติ๊กลบหน้า 1 เดิมเฉพาะเล่มที่ปกผิด' : 'เล่มที่เลือก';
      items.forEach((it) => {
        it.row.classList.toggle('off', it.st !== 'ok' || skipped(it));
        if (it.st === 'ok') it.row.querySelector('[data-lp-old]').classList.toggle('del', mode === 'each' ? it.row.querySelector('[data-lp-del]').checked && !skipped(it) : false);
      });
      const n = plan().length;
      okBtn.textContent = n ? 'ต่อปก ' + n + ' เล่ม' : 'ต่อปก';
      okBtn.disabled = !n;
      if (mode === 'each') thumbs();
    };
    // ภาพหน้า 1 ตอนนี้ของทุกเล่ม เปิดเฉพาะส่วนที่ใช้ของไฟล์ วาดครั้งเดียวต่อการเปิดกล่อง
    let drawing = false;
    async function thumbs() {
      if (drawing) return;
      drawing = true;
      const open = items;
      for (const it of open) {
        if (items !== open) break;
        if (it.thumbDone || it.st !== 'ok') continue;
        it.thumbDone = true;
        const box = it.row.querySelector('[data-lp-old]');
        try {
          const r = await renderFirstPage('/f/' + it.file + '/raw', 64, window.devicePixelRatio || 1);
          box.textContent = '';
          if (r) {
            r.canvas.style.width = '';
            r.canvas.style.height = '';
            box.appendChild(r.canvas);
            it.row.querySelector('[data-lp-pages]').textContent = r.pages + ' หน้า';
          }
        } catch {
          box.textContent = 'เปิดไม่ได้';
        }
      }
      drawing = false;
    }
    modeBtns.forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.lpMode;
        try {
          localStorage.setItem(LP_MODE, mode);
        } catch {
          // เครื่องนี้ไม่ให้จำ ไม่เป็นไร
        }
        refresh();
      })
    );
    dlg.addEventListener('change', refresh);
    dlg.querySelector('[data-lp-cancel]').addEventListener('click', () => dlg.close());
    btn.addEventListener('click', () => {
      items = checks()
        .filter((c) => c.dataset.pdf)
        .map((c) => ({ id: c.value, file: c.dataset.pdfFile, code: c.dataset.code, who: c.dataset.who, st: c.dataset.pdf }));
      if (!items.length) return;
      list.textContent = '';
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'lp-row';
        const tpl = document.querySelector('template[data-pdf-cover="' + it.id + '"]');
        it.cover = tpl ? tpl.content.querySelector('.lib-cover') : null;
        row.innerHTML =
          '<span class="lp-th" data-lp-old></span><span class="lp-ar">' + svg('next', 18) + '</span><span class="lp-th lp-new"></span>' +
          '<span class="lp-info"><b></b><span class="muted small" data-lp-pages></span>' +
          (it.st === 'ok'
            ? '<span class="lp-each"><label><input type="checkbox" data-lp-del> ลบหน้า 1 เดิม</label><label><input type="checkbox" data-lp-skip> ไม่ต่อเล่มนี้</label></span><span class="badge badge-green lp-go">จะต่อปก</span>'
            : '<span class="badge badge-gray">' + LP_SKIP[it.st] + '</span>') +
          '</span>';
        row.querySelector('b').textContent = it.who;
        if (it.cover) row.querySelector('.lp-new').appendChild(it.cover.cloneNode(true));
        it.row = row;
        list.appendChild(row);
      }
      dlg.querySelector('[data-lp-title]').textContent = 'ต่อปกที่ระบบวาดลงในไฟล์ ' + items.length + ' เล่ม';
      dlg.showModal();
      refresh();
    });
    okBtn.addEventListener('click', async () => {
      const todo = plan();
      if (!todo.length) return;
      const dels = todo.filter((x) => x.del).length;
      dlg.close();
      const msg = 'ต่อปกที่ระบบวาดเป็นหน้า 1 ของไฟล์ ' + todo.length + ' เล่ม' + (dels ? ' ลบหน้า 1 เดิม ' + dels + ' เล่ม' : '') + '\nไฟล์เดิมเก็บไว้ในไฟล์รุ่นก่อนแก้ไข ผู้ตรวจไม่ต้องลงนามใหม่ ห้ามปิดหน้านี้จนกว่าจะเสร็จ';
      if (!(await ask(msg, { icon: 'note', ok: 'ต่อปก' }))) return dlg.showModal();
      let made = 0;
      const failed = [];
      try {
        showBusy('กำลังต่อปก', true);
        if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
        if (!window.PdfMerge) await loadScript('/static/js/pdfmerge.js');
        for (let i = 0; i < todo.length; i++) {
          const { it, del } = todo[i];
          busy.querySelector('[data-pct]').textContent = 'เล่มที่ ' + (i + 1) + ' จาก ' + todo.length + ' ' + it.code;
          busy.querySelector('[data-bar] > div').style.width = Math.round((i / todo.length) * 100) + '%';
          try {
            await coverOne(it, del);
            made++;
          } catch (err) {
            if (err && err.net) throw err;
            failed.push(it.code + ' ' + ((err && err.userMessage) || 'ทำไม่ได้'));
          }
        }
        hideBusy();
        const skip = items.length - todo.length;
        await tell('ต่อปกเรียบร้อย ' + made + ' เล่ม' + (skip ? ' ข้าม ' + skip + ' เล่ม' : '') + (failed.length ? '\nทำไม่ได้ ' + failed.length + ' เล่ม ' + failed.join(' · ') : ''), made && !failed.length ? 'ok' : 'warn');
        window.location.reload();
      } catch (err) {
        hideBusy();
        await tell(((err && err.userMessage) || NET_ERROR) + (made ? '\nต่อปกแล้ว ' + made + ' เล่ม กดต่อปกเล่มที่เหลือได้อีกครั้ง' : ''));
        if (made) window.location.reload();
      }
    });
    // ต่อปก 1 เล่ม: ไฟล์ใหม่ + รูปปกเล็กในคลังจากไฟล์ใหม่ · หน้าแรกเป็นปกที่ระบบวาด เซิร์ฟเวอร์จดไว้เอง (ครั้งหน้าข้ามเล่มนี้)
    async function coverOne(it, del) {
      if (!it.cover) throw new SendError('ไม่พบปกที่ระบบวาด');
      const res = await fetch('/f/' + it.file + '/raw');
      if (!res.ok) throw new SendError('เปิดไฟล์เดิมไม่ได้');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const m = await window.PdfMerge.editFront(window.PDFLib, bytes, { remove: del ? [1] : [], coverPng: await drawnPng(it.cover), coverPdf: null });
      const url = '/s/' + it.id + '/cover';
      const data = new URLSearchParams({ front: '1', removed: del ? '1' : '', drawn: '1', newcover: '' });
      data.append('upload_main_files', await uploadBlob(new Blob([m.bytes], { type: 'application/pdf' }), { form: url, field: 'main_files', name: 'merged.pdf', merged: '2' }));
      const thumb = await makeThumb(new Uint8Array(m.bytes));
      if (thumb) data.append('upload_cover_thumb', await uploadBlob(thumb, { form: url, field: 'cover_thumb', name: 'cover.jpg' }));
      await request('POST', url, data, { 'Content-Type': 'application/x-www-form-urlencoded' });
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

  // ปกที่ระบบวาดเป็นรูป PNG สำหรับต่อเป็นหน้าแรกของ PDF (coverpdf libcoverpdf) · cover = .lib-cover ของงานนั้น
  // วาดจากปกตัวใหญ่ที่ซ่อนไว้นอกจอ ตัวหนังสือจึงคมและตัดบรรทัดเหมือนในคลังงาน
  async function drawnPng(cover) {
    if (!window.CoverDraw) await loadScript('/static/js/coverdraw.js');
    const wrap = document.createElement('div');
    wrap.className = 'front-render';
    wrap.appendChild(cover.cloneNode(true));
    document.body.appendChild(wrap);
    try {
      const canvas = await window.CoverDraw.draw(wrap.firstChild, 1654);
      const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!png) throw new SendError('วาดปกไม่สำเร็จ ลองใหม่อีกครั้ง');
      return new Uint8Array(await png.arrayBuffer());
    } finally {
      wrap.remove();
    }
  }

  // ---------- เพิ่มหน้าปกให้งานที่ส่งแล้ว (ฟังก์ชันเสริม addcover) ----------
  // เลือกไฟล์ปก แล้วรวมปกไว้หน้าแรกของไฟล์เดิมในเครื่องนี้ (pdf-lib) ส่งเป็นไฟล์ใหม่ ไฟล์เดิมระบบเก็บเป็นประวัติ
  document.querySelectorAll('[data-add-cover]').forEach((form) => {
    const input = form.querySelector('[data-cover-file]');
    input.addEventListener('change', async () => {
      const cover = input.files[0];
      input.value = '';
      if (!cover) return;
      if (!/\.pdf$/i.test(cover.name)) return tell('เลือกไฟล์ปกเป็น PDF');
      const ok = await ask('ต่อไฟล์ ' + cover.name + ' ไว้หน้าแรกของ ' + form.dataset.name + ' ใช่ไหม\nเนื้อหาเดิมไม่เปลี่ยน ไฟล์เดิมเก็บไว้ในประวัติ', { icon: 'note', ok: 'เพิ่มหน้าปก' });
      if (!ok) return;
      const url = form.getAttribute('action');
      try {
        showBusy('กำลังเพิ่มหน้าปก', false);
        const res = await fetch(form.dataset.file);
        if (!res.ok) throw new SendError('เปิดไฟล์เดิมไม่ได้ ลองใหม่อีกครั้ง');
        const old = new File([await res.blob()], form.dataset.name, { type: 'application/pdf' });
        const m = await mergeInBrowser([cover, old]);
        const merged = new Blob([m.bytes], { type: 'application/pdf' });
        const thumb = form.dataset.library ? await makeThumb(new Uint8Array(m.bytes)) : null;
        showBusy('กำลังเพิ่มหน้าปก', true);
        setProgress(0);
        const data = new URLSearchParams();
        const total = merged.size + (thumb ? thumb.size : 0);
        const start = await request('POST', '/upload/start', new URLSearchParams({ form: url, field: 'main_files', name: 'merged.pdf', merged: '2', size: String(merged.size) }), { 'Content-Type': 'application/x-www-form-urlencoded' });
        await sendChunks(start.token, merged, start.chunk, (n) => setProgress(Math.min(99, Math.round((n / total) * 100))));
        data.append('upload_main_files', start.token);
        if (thumb) data.append('upload_cover_thumb', await uploadBlob(thumb, { form: url, field: 'cover_thumb', name: 'cover.jpg' }));
        setProgress(100);
        const r = await request('POST', url, data, { 'Content-Type': 'application/x-www-form-urlencoded' });
        window.location.href = r.redirect || window.location.pathname;
      } catch (err) {
        showPaused(false);
        hideBusy();
        tell((err && err.userMessage) || NET_ERROR);
      }
    });
  });

  // ---------- ใช้ไฟล์รุ่นก่อน (ฟังก์ชันเสริม oldfile) ----------
  // ไฟล์ PDF: ทำรูปปกในคลังจากไฟล์ที่กลับไปใช้ในเครื่องนี้ส่งไปด้วย ทำรูปไม่ได้ก็ยังส่งได้ (ระบบใช้ปกที่วาดให้แทน)
  // เฉพาะฟอร์ม: รายการตรวจก่อนส่งในหน้าแก้ไขก็มี data-old-file (เลขไฟล์เดิม) แต่ไม่มีปุ่ม
  document.querySelectorAll('form[data-old-file]').forEach((form) => {
    form.querySelector('button').addEventListener('click', async () => {
      const ok = await ask(form.dataset.text, { icon: 'note', ok: 'ใช้ไฟล์นี้' });
      if (!ok) return;
      const url = form.getAttribute('action');
      try {
        showBusy('กำลังเปลี่ยนไฟล์', false);
        const data = new URLSearchParams();
        try {
          const res = await fetch(form.dataset.oldFile);
          const thumb = res.ok ? await makeThumb(new Uint8Array(await res.arrayBuffer())) : null;
          if (thumb) data.append('upload_cover_thumb', await uploadBlob(thumb, { form: url, field: 'cover_thumb', name: 'cover.jpg' }));
        } catch {
          // ไม่มีรูปปกก็กลับไปใช้ไฟล์ได้
        }
        const r = await request('POST', url, data, { 'Content-Type': 'application/x-www-form-urlencoded' });
        window.location.href = r.redirect || window.location.pathname;
      } catch (err) {
        hideBusy();
        tell((err && err.userMessage) || NET_ERROR);
      }
    });
  });

  // ---------- เปลี่ยนปก (ฟังก์ชันเสริม coverpdf) ----------
  // เปิดไฟล์เดิม แสดงภาพหน้าแรก ๆ ให้ติ๊กหน้าที่จะลบ เลือกปกใหม่ (ปกที่ระบบวาด หรือไฟล์ปก) แล้วทำไฟล์ใหม่ในเครื่องนี้ (pdf-lib)
  // ส่งทางเดียวกับปุ่มเพิ่มหน้าปก พร้อมบอก front=1 removed drawn newcover ให้เซิร์ฟเวอร์บันทึกประวัติ
  const FRONT_SHOW = 6;
  document.querySelectorAll('[data-front-open]').forEach((btn) => {
    const dlg = document.getElementById(btn.dataset.frontOpen);
    if (!dlg) return;
    const box = dlg.querySelector('[data-front-pages]');
    const sum = dlg.querySelector('[data-front-sum]');
    const fileIn = dlg.querySelector('[data-front-file]');
    const fname = dlg.querySelector('[data-front-fname]');
    const drawnBox = dlg.querySelector('[data-front-drawn]');
    let bytes = null;
    let total = 0;
    let coverFile = null;
    const choice = () => (dlg.querySelector('input[name=front_new]:checked') || {}).value || 'none';
    const removed = () => [...box.querySelectorAll('input:checked')].map((i) => Number(i.value));
    function refresh() {
      if (drawnBox) drawnBox.hidden = choice() !== 'drawn';
      const del = removed();
      const mode = choice();
      const parts = [];
      if (del.length) parts.push('ลบหน้า ' + del.join(', '));
      if (mode === 'drawn') parts.push('ต่อปกที่ระบบวาดเป็นหน้า 1');
      if (mode === 'file' && coverFile) parts.push('ต่อไฟล์ ' + coverFile.name + ' ไว้หน้าแรก');
      const left = total - del.length + (mode === 'drawn' ? 1 : 0);
      sum.textContent = total ? (parts.length ? parts.join(' แล้ว') : 'ยังไม่ได้เลือกหน้าที่จะลบหรือปกใหม่') + (parts.length && mode !== 'file' ? ' ไฟล์ใหม่มี ' + left + ' หน้า' : '') : '';
    }
    dlg.addEventListener('change', (e) => {
      if (e.target === fileIn) {
        const f = fileIn.files[0];
        fileIn.value = '';
        if (f && !/\.pdf$/i.test(f.name)) tell('เลือกไฟล์ปกเป็น PDF');
        else if (f) coverFile = f;
        fname.textContent = coverFile ? coverFile.name : 'ยังไม่ได้เลือก';
        if (coverFile) dlg.querySelector('input[name=front_new][value=file]').checked = true;
      }
      if (e.target.closest('[data-front-pages]')) e.target.closest('label').classList.toggle('on', e.target.checked);
      refresh();
    });
    dlg.querySelector('[data-front-cancel]').addEventListener('click', () => dlg.close());
    btn.addEventListener('click', async () => {
      dlg.showModal();
      refresh();
      if (bytes) return;
      try {
        const res = await fetch(dlg.dataset.file);
        if (!res.ok) throw new SendError('เปิดไฟล์เดิมไม่ได้ ลองใหม่อีกครั้ง');
        bytes = new Uint8Array(await res.arrayBuffer());
        const task = openPdf(await pdfjsLib(), bytes.slice());
        try {
          const doc = await task.promise;
          total = doc.numPages;
          box.textContent = '';
          for (let n = 1; n <= Math.min(FRONT_SHOW, total); n++) {
            const page = await doc.getPage(n);
            const vp0 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: 300 / vp0.width });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
            const label = document.createElement('label');
            label.className = 'front-page';
            label.innerHTML = '<input type="checkbox" value="' + n + '"><span class="fp-del">ลบ</span><span class="fp-n">หน้า ' + n + '</span>';
            label.insertBefore(canvas, label.lastChild);
            box.appendChild(label);
          }
          if (total > FRONT_SHOW) box.insertAdjacentHTML('beforeend', '<span class="muted small front-more">แสดง ' + FRONT_SHOW + ' หน้าแรก จากทั้งหมด ' + total + ' หน้า</span>');
        } finally {
          task.destroy().catch(() => {});
        }
        refresh();
      } catch (err) {
        bytes = null;
        box.textContent = (err && err.userMessage) || 'เปิดไฟล์เดิมไม่ได้ ลองใหม่อีกครั้ง';
      }
    });
    dlg.querySelector('[data-front-ok]').addEventListener('click', async () => {
      if (!bytes || !total) return tell('รอให้เปิดไฟล์เสร็จก่อน');
      const del = removed();
      const mode = choice();
      if (mode === 'file' && !coverFile) return tell('ยังไม่ได้เลือกไฟล์ปก กดที่ ไฟล์ปก PDF เพื่อเลือก');
      if (!del.length && mode === 'none') return tell('ยังไม่ได้เลือกหน้าที่จะลบหรือปกใหม่');
      if (del.length >= total && mode === 'none') return tell('ลบทุกหน้าไม่ได้ ต้องเหลืออย่างน้อย 1 หน้า');
      dlg.close();
      const ok = await ask('เปลี่ยนปก ' + dlg.dataset.name + '\n' + sum.textContent + '\nไฟล์เดิมเก็บไว้ในไฟล์รุ่นก่อนแก้ไข ผู้ตรวจไม่ต้องลงนามใหม่', { icon: 'note', ok: 'เปลี่ยนปก' });
      if (!ok) return dlg.showModal();
      const url = dlg.dataset.action;
      try {
        showBusy('กำลังเปลี่ยนปก', false);
        if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
        if (!window.PdfMerge) await loadScript('/static/js/pdfmerge.js');
        const coverPng = mode === 'drawn' ? await drawnPng(drawnBox.querySelector('.lib-cover')) : null;
        const coverPdf = mode === 'file' ? new Uint8Array(await coverFile.arrayBuffer()) : null;
        const m = await window.PdfMerge.editFront(window.PDFLib, bytes.slice(), { remove: del, coverPng, coverPdf });
        const merged = new Blob([m.bytes], { type: 'application/pdf' });
        const thumb = dlg.dataset.library ? await makeThumb(new Uint8Array(m.bytes)) : null;
        showBusy('กำลังเปลี่ยนปก', true);
        setProgress(0);
        const all = merged.size + (thumb ? thumb.size : 0);
        const start = await request('POST', '/upload/start', new URLSearchParams({ form: url, field: 'main_files', name: 'merged.pdf', merged: '2', size: String(merged.size) }), { 'Content-Type': 'application/x-www-form-urlencoded' });
        await sendChunks(start.token, merged, start.chunk, (n) => setProgress(Math.min(99, Math.round((n / all) * 100))));
        const data = new URLSearchParams({ front: '1', removed: del.join(','), drawn: mode === 'drawn' ? '1' : '', newcover: mode === 'file' ? '1' : '' });
        data.append('upload_main_files', start.token);
        // ผลตรวจหน้าแรกของไฟล์ใหม่ (ฟังก์ชันเสริม frontcheck) ปกที่ระบบวาดถือว่าเป็นปกแน่นอน
        if (dlg.dataset.frontcheck) data.append('front_check', mode === 'drawn' ? 'ok' : await frontCheck(new Uint8Array(m.bytes), dlg.dataset.code));
        if (thumb) data.append('upload_cover_thumb', await uploadBlob(thumb, { form: url, field: 'cover_thumb', name: 'cover.jpg' }));
        setProgress(100);
        const r = await request('POST', url, data, { 'Content-Type': 'application/x-www-form-urlencoded' });
        window.location.href = r.redirect || window.location.pathname;
      } catch (err) {
        showPaused(false);
        hideBusy();
        tell((err && err.userMessage) || NET_ERROR);
      }
    });
    // มาจากรายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก (หน้าผู้ดูแลระบบ) เปิดกล่องเปลี่ยนปกให้เลย
    if (new URLSearchParams(window.location.search).get('front') === '1') btn.click();
  });

  // ---------- รายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก (ฟังก์ชันเสริม frontcheck) หน้าผู้ดูแลระบบ ----------
  // ภาพหน้าแรกเล็ก ๆ ของแต่ละงานในรายการ วาดทีละงานจากไฟล์จริง
  (async () => {
    for (const el of document.querySelectorAll('[data-fc-thumb]')) {
      try {
        const r = await renderFirstPage(el.dataset.fcThumb, 44, window.devicePixelRatio || 1);
        if (!r) continue;
        r.canvas.style.width = '';
        r.canvas.style.height = '';
        el.appendChild(r.canvas);
      } catch {
        // เปิดไฟล์ไม่ได้ เว้นกรอบว่างไว้ กดเปิดงานดูเองได้
      }
    }
  })();
  // ตรวจหน้าแรกของงานเดิม: เครื่องนี้เปิดไฟล์ทีละงาน (โหลดเฉพาะส่วนที่ใช้) แล้วส่งผลกลับทีละไฟล์ หยุดกลางคันแล้วกดต่อได้
  document.querySelectorAll('[data-fc-scan]').forEach((box) => {
    const start = box.querySelector('[data-fc-start]');
    const stop = box.querySelector('[data-fc-stop]');
    const text = box.querySelector('[data-fc-text]');
    const bar = box.querySelector('[data-fc-bar]');
    let stopped = false;
    stop.addEventListener('click', () => {
      stopped = true;
      stop.disabled = true;
      text.textContent = 'กำลังหยุด รอไฟล์ที่ตรวจอยู่ให้เสร็จก่อน';
    });
    start.addEventListener('click', async () => {
      if (!(await ask(start.dataset.ask, { icon: 'eye', ok: 'เริ่มตรวจ' }))) return;
      stopped = false;
      start.hidden = true;
      stop.hidden = false;
      stop.disabled = false;
      bar.hidden = false;
      const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
      let done = 0;
      let bad = 0;
      try {
        const res = await fetch('/admin/frontcheck/todo', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const items = res.ok ? (await res.json()).items : [];
        for (let i = 0; i < items.length && !stopped; i++) {
          text.textContent = 'ตรวจงานเดิมแล้ว ' + i + ' จาก ' + items.length + ' งาน';
          bar.firstElementChild.style.width = Math.round((i / items.length) * 100) + '%';
          const v = await frontCheck('/f/' + items[i].file + '/raw', items[i].code);
          if (!v) continue;
          await request('POST', '/admin/frontcheck/' + items[i].file, new URLSearchParams({ v }), form);
          done++;
          if (v !== 'ok') bad++;
        }
        await request('POST', '/admin/frontcheck-done', new URLSearchParams({ n: String(done), bad: String(bad) }), form);
        await tell((stopped ? 'หยุดตรวจแล้ว ' : 'ตรวจเสร็จแล้ว ') + done + ' งาน พบหน้าแรกน่าจะไม่ใช่ปก ' + bad + ' งาน', 'ok');
        window.location.reload();
      } catch (err) {
        start.hidden = false;
        stop.hidden = true;
        tell((err && err.userMessage) || NET_ERROR);
      }
    });
  });

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
      // รายการตรวจก่อนส่ง (ฟังก์ชันเสริม precheck): ยังมีข้อแดงหรือข้อส้มที่ต้องติ๊ก บอกเหตุผลแทนการส่ง
      if (submitter && submitter.dataset.blocked) {
        e.preventDefault();
        await tell(submitter.dataset.blocked);
        const box = form.querySelector('[data-precheck]') || document.querySelector('[data-precheck]');
        if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
          await tell(submitter.dataset.needMessage || 'ยังไม่ได้เลือกรายการ');
          return;
        }
      }
      // ครูที่ยังไม่มีลายเซ็นกดส่งงาน (ฟังก์ชันเสริม sigrequire): เปิดกรอบเซ็นชื่อแทนป๊อปยืนยัน เซ็นแล้วส่งต่อทันที
      if (submitter && submitter.hasAttribute('data-need-sig') && sigDlg && sigDlg.hasAttribute('data-require') && !form.querySelector('input[data-sig-copy][name=signature]')) {
        e.preventDefault();
        const got = await askSignature('submit', (submitter && submitter.dataset.confirm) || form.dataset.confirm);
        if (!got) return;
        for (const [k, v] of Object.entries(got)) if (v) putSigField(form, k, v);
        form.dataset.confirmed = '1';
        form._submitter = submitter;
        if (form.requestSubmit) form.requestSubmit(submitter);
        else form.submit();
        return;
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

  // ---------- กรอบเซ็นชื่อสำหรับครูที่ยังไม่มีลายเซ็น (ฟังก์ชันเสริม sigrequire signag) ----------
  // mode submit = เซ็นก่อนส่งงาน (ค่าที่ได้ใส่ในฟอร์มส่งงาน) · save = บันทึกเป็นลายเซ็นในข้อมูลส่วนตัว (ปุ่ม เซ็นตอนนี้)
  const sigDlg = document.getElementById('sig-need');
  function askSignature(mode, text) {
    return new Promise((resolve) => {
      if (!sigDlg || typeof sigDlg.showModal !== 'function') return resolve(null);
      const pad = sigDlg.querySelector('[data-sigpad]');
      const ok = sigDlg.querySelector('[data-sig-ok]');
      const cancel = sigDlg.querySelector('[data-sig-cancel]');
      const msg = sigDlg.querySelector('[data-sig-text]');
      const rem = pad.querySelector('input[name=remember_signature]');
      const remLabel = rem && rem.closest('label');
      // form = เซ็นจากรายการตรวจก่อนส่ง ค่าที่ได้ใส่ในฟอร์มส่งงาน ใช้ตอนกดส่ง
      sigDlg.querySelector('[data-sig-title]').textContent = mode === 'submit' ? 'เซ็นชื่อก่อนส่งงาน' : 'เซ็นชื่อของคุณ';
      const base = mode === 'save' ? 'เซ็นครั้งเดียว ใช้ในบันทึกข้อความและเอกสารที่พิมพ์จากระบบทุกงาน' : 'ลายเซ็นนี้จะอยู่ในบันทึกข้อความและเอกสารที่พิมพ์จากระบบ';
      msg.textContent = text ? text + '\n' + base : base;
      msg.classList.remove('sig-need-err');
      ok.textContent = mode === 'save' ? 'บันทึกลายเซ็น' : mode === 'form' ? 'ใช้ลายเซ็นนี้' : 'เซ็นแล้ว ส่งงาน';
      if (remLabel) remLabel.hidden = mode === 'save';
      const done = (v) => {
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        sigDlg.removeEventListener('cancel', onEsc);
        if (sigDlg.open) sigDlg.close();
        resolve(v);
      };
      const onOk = () => {
        const v = pad.querySelector('input[name=signature]').value;
        if (!v) {
          msg.textContent = 'ยังไม่ได้เซ็นชื่อ เซ็นด้วยนิ้วหรือเมาส์ในกรอบก่อน';
          msg.classList.add('sig-need-err');
          return;
        }
        const choice = pad.querySelector('input[name=sig_choice]');
        done({ signature: v, sig_choice: mode !== 'save' && choice ? choice.value : '', remember_signature: mode !== 'save' && rem && rem.checked ? '1' : '' });
      };
      const onCancel = () => done(null);
      const onEsc = (ev) => {
        ev.preventDefault();
        done(null);
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      sigDlg.addEventListener('cancel', onEsc);
      sigDlg.showModal();
    });
  }
  function putSigField(form, name, value) {
    let i = form.querySelector('input[data-sig-copy][name="' + name + '"]');
    if (!i) {
      i = document.createElement('input');
      i.type = 'hidden';
      i.name = name;
      i.setAttribute('data-sig-copy', '');
      form.appendChild(i);
    }
    i.value = value;
  }
  document.querySelectorAll('[data-sig-open]').forEach((b) => {
    b.addEventListener('click', async () => {
      const got = await askSignature('save');
      if (!got) return;
      const f = document.createElement('form');
      f.method = 'post';
      f.setAttribute('action', '/profile/sign');
      putSigField(f, 'signature', got.signature);
      putSigField(f, 'back', window.location.pathname);
      document.body.appendChild(f);
      showBusy('กำลังบันทึกลายเซ็น');
      f.submit();
    });
  });

  // ---------- หลังครูกดส่ง: ป๊อปกลางจอ (ฟังก์ชันเสริม sentpop) ขึ้นครั้งเดียว ครูกดปิดเอง ----------
  const sentPop = document.querySelector('[data-sent-pop]');
  if (sentPop && typeof sentPop.showModal === 'function') {
    sentPop.querySelectorAll('[data-sent-close]').forEach((b) => b.addEventListener('click', () => sentPop.close()));
    sentPop.showModal();
  }

  // ---------- พลุตอนกดส่งงาน (ฟังก์ชันเสริม confetti) กระดาษสีโปรยจากบน + พลุแตก 2 ลูก ราว 3 วินาที ----------
  // ใส่ไว้ในป๊อปที่เปิดอยู่ (dialog อยู่ชั้นบนสุด) ไม่อย่างนั้นพลุจะอยู่ใต้ฉากมืด · เครื่องที่ตั้งลดภาพเคลื่อนไหวไม่แสดง
  function confetti() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}
    const css = getComputedStyle(document.documentElement);
    const colors = ['--c-red', '--c-amber', '--c-blue', '--c-violet', '--c-teal', '--c-orange', '--c-pink', '--c-green', '--c-gold']
      .map((v) => css.getPropertyValue(v).trim())
      .filter(Boolean);
    if (!colors.length) colors.push('#E5484D', '#E0A100', '#2F6FEB', '#20A35A');
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = () => colors[Math.floor(Math.random() * colors.length)];
    const layer = document.createElement('div');
    layer.className = 'fx-confetti';
    layer.setAttribute('aria-hidden', 'true');
    const small = window.innerWidth < 640;
    for (let n = 0; n < (small ? 70 : 120); n++) {
      const i = document.createElement('i');
      i.style.cssText = `--x:${rnd(0, 100)}%;--w:${rnd(7, 13)}px;--c:${pick()};--d:${rnd(2.2, 3.6)}s;--dl:${rnd(0, 0.9)}s;--dx:${rnd(-120, 120)}px;--r:${rnd(360, 1080)}deg`;
      layer.appendChild(i);
    }
    for (const [ox, oy, dl] of [[small ? 30 : 25, 38, 0.1], [small ? 70 : 75, 30, 0.45]]) {
      for (let n = 0; n < (small ? 22 : 34); n++) {
        const a = rnd(0, Math.PI * 2);
        const dist = rnd(60, small ? 150 : 230);
        const b = document.createElement('b');
        b.style.cssText = `--ox:${ox}%;--oy:${oy}%;--w:${rnd(5, 10)}px;--br:${Math.random() < 0.5 ? '50%' : '2px'};--c:${pick()};--d:${rnd(1.6, 2.4)}s;--dl:${dl}s;--bx:${Math.cos(a) * dist}px;--by:${Math.sin(a) * dist}px;--r:${rnd(90, 360)}deg`;
        layer.appendChild(b);
      }
    }
    const host = document.querySelector('dialog[open]') || document.body;
    host.appendChild(layer);
    setTimeout(() => layer.remove(), 5000);
  }
  if (document.querySelector('[data-confetti]')) setTimeout(confetti, 250);
  // ส่งครบทุกงานของภาคเรียน: พลุที่หน้าแรกครั้งเดียว (จำในเครื่อง)
  const allSent = document.querySelector('[data-confetti-once]');
  if (allSent) {
    const key = allSent.getAttribute('data-confetti-once');
    try {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1');
        setTimeout(confetti, 400);
      }
    } catch (e) {}
  }

  // ---------- แถบโหลดสีรุ้งบนสุดตอนเปลี่ยนหน้า (สีสันแบบจัดเต็ม) ----------
  if (document.querySelector('.fx-loadbar')) {
    // ลิงก์ที่เป็นการดาวน์โหลดไฟล์ไม่เปลี่ยนหน้า จึงเอาแถบออกเองหลัง 8 วินาที
    let leaveTimer = 0;
    const leave = () => {
      document.documentElement.classList.add('fx-leaving');
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => document.documentElement.classList.remove('fx-leaving'), 8000);
    };
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname && a.search === window.location.search && a.hash) return;
      leave();
    });
    document.addEventListener('submit', (e) => {
      if (!e.defaultPrevented) leave();
    });
    // กลับมาด้วยปุ่มย้อนกลับ (หน้าที่เบราว์เซอร์จำไว้) ต้องเอาแถบออก
    window.addEventListener('pageshow', () => document.documentElement.classList.remove('fx-leaving'));
  }

  // ---------- ครั้งแรกที่เปิดหน้างานที่ส่งแล้ว: ป้ายสีทองชี้การ์ดพิมพ์ (printtip) และขอบเรือง (printglow) จำใน localStorage ----------
  const firstTime = (key) => {
    try {
      return !localStorage.getItem(key);
    } catch (e) {
      return false; // เครื่องที่จำไม่ได้ ไม่ขึ้นทุกครั้งให้รำคาญ
    }
  };
  const remember = (key) => {
    try {
      localStorage.setItem(key, '1');
    } catch (e) {}
  };
  const pTip = document.querySelector('[data-print-tip]');
  const pCard = document.querySelector('.print-card');
  if (pTip && firstTime('cw-print-tip')) {
    pTip.hidden = false;
    if (pCard) pCard.classList.add('pc-hold');
    pTip.querySelector('[data-print-tip-ok]').addEventListener('click', () => {
      remember('cw-print-tip');
      pTip.hidden = true;
      if (pCard) pCard.classList.remove('pc-hold');
    });
  }
  if (pCard && pCard.hasAttribute('data-print-glow') && firstTime('cw-print-glow')) {
    remember('cw-print-glow');
    pCard.classList.add('pc-glow');
    pCard.addEventListener('animationend', () => pCard.classList.remove('pc-glow'));
  }

  // ---------- วิธีติดตั้งเป็นแอป (ฟังก์ชันเสริม appicon installtip aboutpage) ----------
  // ขึ้นเองครั้งแรกครั้งเดียวต่อเครื่อง เฉพาะไอโฟน ไอแพด แอนดรอยด์ที่ยังไม่ได้เปิดจากไอคอนแอป (จำใน localStorage)
  const inst = document.getElementById('install-tip');
  if (inst) {
    const KEY = 'cw-install-tip';
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    const now = inst.querySelector('[data-install-now]');
    let deferred = null;
    // Chrome บนแอนดรอยด์และคอมติดตั้งให้ได้ทันทีด้วยปุ่มเดียว
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
    });
    const seen = () => {
      try {
        localStorage.setItem(KEY, '1');
      } catch (e) {}
    };
    const openTip = (os) => {
      inst.querySelectorAll('[data-install-os]').forEach((s) => {
        s.hidden = s.dataset.installOs !== os;
      });
      now.hidden = !(deferred && os !== 'ios');
      if (typeof inst.showModal === 'function') inst.showModal();
    };
    inst.querySelectorAll('[data-install-close]').forEach((b) =>
      b.addEventListener('click', () => {
        seen();
        inst.close();
      })
    );
    inst.addEventListener('cancel', seen);
    now.addEventListener('click', () => {
      seen();
      inst.close();
      if (deferred) deferred.prompt();
      deferred = null;
    });
    document.querySelectorAll('[data-install-open]').forEach((b) => b.addEventListener('click', () => openTip(b.dataset.installOpen)));
    let first = false;
    try {
      first = !localStorage.getItem(KEY);
    } catch (e) {}
    if (inst.hasAttribute('data-auto') && first && !standalone && (ios || android)) {
      setTimeout(() => {
        if (!document.querySelector('dialog[open]')) openTip(ios ? 'ios' : 'android');
      }, 1500);
    }
  }

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
        const pdf = bar.querySelector('[data-swap-go="pdf"]');
        if (pdf) pdf.disabled = !on.some((c) => c.dataset.pdf);
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
      const pdfBtn = bar.querySelector('[data-swap-go="pdf"]');
      if (pdfBtn) libCoverPdf(pdfBtn, checks);
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
    // ยังไม่เลือกไฟล์ใหม่ แต่มีไฟล์เดิม (data-old-cover ฟังก์ชันเสริม precheck) ดูหน้าแรกของไฟล์เดิมจากระบบ
    async function showCover(file) {
      if (!cover) return;
      const token = ++coverToken;
      const oldUrl = !file && zone.dataset.oldCover ? '/f/' + zone.dataset.oldCover + '/raw' : '';
      if (!oldUrl && (!file || !/\.pdf$/i.test(file.name))) {
        cover.hidden = true;
        return;
      }
      try {
        const r = await renderFirstPage(oldUrl || new Uint8Array(await file.arrayBuffer()), 200, window.devicePixelRatio || 1, () => token === coverToken);
        if (!r || token !== coverToken) return;
        const box = cover.querySelector('[data-cover-img]');
        box.innerHTML = '';
        box.appendChild(r.canvas);
        cover.querySelector('[data-cover-info]').textContent = oldUrl ? 'หน้าแรกของไฟล์เดิมที่แนบไว้ ทั้งไฟล์ ' + r.pages + ' หน้า' : 'หน้าแรกของไฟล์ ' + file.name + (dt.files.length > 1 ? ' (หน้าปกของไฟล์ที่รวมแล้ว)' : ' ทั้งไฟล์ ' + r.pages + ' หน้า');
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
      zone.dispatchEvent(new CustomEvent('dz:change', { detail: { files: Array.from(dt.files) } }));
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
    if (zone.dataset.oldCover) showCover(null);
  });
  // ---------- รายการตรวจก่อนส่งแผนและคู่มือ (ฟังก์ชันเสริม precheck precheckforce dupfile blankcover) ----------
  // ข้อแดงเขียว = ระบบรู้แน่นอน (กรอกครบ เป็น PDF เปิดได้ ไม่ติดรหัส ไม่ซ้ำกับงานอื่น) ข้อแดงทำให้ปุ่มส่งบอกเหตุผลแทนการส่ง
  // ข้อส้ม = ระบบเดา (หน้าแรกเกือบว่าง ไม่พบรหัสวิชา ชื่อไฟล์มีรหัสอื่น หน้าน้อยผิดปกติ) ครูดูเองแล้วติ๊ก ดูแล้ว (บังคับเมื่อเปิด precheckforce)
  const INK_MIN = 0.004; // สัดส่วนจุดสีเข้มของหน้าแรก ต่ำกว่านี้ถือว่าเกือบว่าง (วัดจากไฟล์ทดลอง หน้าว่าง 0 ปกที่มีแค่ชื่อเรื่องราว 0.01 ขึ้นไป)
  const CK_ICON = { ok: 'ok', bad: 'close', look: 'eye', wait: 'clock' };
  const CODE_RE = /[ก-ฮ]\s?[0-9๐-๙]{5}/g;
  function normCode(s) {
    return String(s || '')
      .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
      .replace(/\s+/g, '')
      .toUpperCase();
  }
  // สัดส่วนจุดสีเข้มของหน้า (วาดเล็ก ๆ กว้าง 120 px)
  async function inkOf(page) {
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 120 / base.width });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) dark++;
    return dark / (d.length / 4);
  }
  // เปิด PDF ครั้งเดียว: จำนวนหน้า ตัวหนังสือ n หน้าแรก ความเข้มหน้าแรก · เปิดไม่ได้คืน { error: locked | broken }
  async function inspectPdf(src, textPages, wantInk) {
    let task;
    try {
      task = openPdf(await pdfjsLib(), src);
      const doc = await task.promise;
      const out = { pages: doc.numPages, text: [], ink: null };
      for (let p = 1; p <= Math.min(doc.numPages, textPages); p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        out.text.push(tc.items.map((x) => x.str || '').join(' '));
      }
      // วาดไม่เสร็จใน 8 วินาที (เครื่องช้าหรือฟอนต์โหลดไม่ขึ้น) ข้ามการวัดความเข้ม ไม่ให้รายการตรวจค้าง
      if (wantInk) out.ink = await Promise.race([inkOf(await doc.getPage(1)), new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null);
      return out;
    } catch (e) {
      return { error: e && e.name === 'PasswordException' ? 'locked' : 'broken' };
    } finally {
      if (task) task.destroy().catch(() => {});
    }
  }
  // ผลตรวจหน้าแรก (ฟังก์ชันเสริม frontcheck) เก็บคู่กับไฟล์ ให้ผู้ดูแลเห็นรายชื่องานที่หน้าแรกน่าจะไม่ใช่ปก
  // blank = หน้าแรกเกือบว่าง · nocode = หน้าแรกมีตัวหนังสือแต่ไม่มีรหัสวิชา (ไฟล์สแกนไม่มีตัวหนังสือ ไม่นับข้อนี้) · ok · ว่าง = วัดไม่ได้
  function frontVerdict(ink, page1, code) {
    if (ink == null) return '';
    const c = normCode(code);
    const t = normCode(page1);
    const out = [];
    if (ink < INK_MIN) out.push('blank');
    if (c && t.length >= 30 && !t.includes(c)) out.push('nocode');
    return out.join(' ') || 'ok';
  }
  async function frontCheck(src, code) {
    const r = await inspectPdf(src, 1, true);
    return r.error ? '' : frontVerdict(r.ink, r.text[0], code);
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  document.querySelectorAll('[data-precheck][data-mode=form]').forEach((box) => {
    const form = box.closest('form');
    if (!form) return;
    const btn = form.querySelector('[data-precheck-btn]');
    const note = form.querySelector('[data-ck-note]');
    const zone = form.querySelector('[data-dropzone]');
    const warn = form.querySelector('[data-cover-warn]');
    const count = box.querySelector('[data-ck-count]');
    let dup = [];
    try {
      dup = JSON.parse(box.dataset.dup || '[]');
    } catch {
      dup = [];
    }
    const minPages = Number(box.dataset.minPages) || 0;
    const oldFile = box.dataset.oldFile || '';
    const force = box.hasAttribute('data-force');
    const blankOn = box.hasAttribute('data-blank');
    const pdfOnly = box.hasAttribute('data-pdfonly');
    const fCode = form.elements.subject_code;
    const fields = [
      ['รหัสวิชา', fCode],
      ['ชื่อวิชา', form.elements.subject_name],
      ['ระดับชั้น', form.elements.grade_level],
    ];
    let run = 0;
    let names = [];
    let text = null; // ตัวหนังสือ 3 หน้าแรก (null = ไฟล์สแกนหรือยังไม่รู้ ไม่เตือนเรื่องรหัสวิชา)
    let oldPages = null;
    const item = (k) => box.querySelector('[data-ck="' + k + '"]');
    // ผลตรวจหน้าแรกของไฟล์ที่เพิ่งเลือก (ฟังก์ชันเสริม frontcheck) ส่งไปพร้อมฟอร์ม ไฟล์เดิมไม่ส่ง
    const frontIn = form.querySelector('[data-front-check]');
    let front = null;
    function putFront() {
      if (frontIn) frontIn.value = front ? frontVerdict(front.ink, front.page1, fCode && fCode.value) : '';
    }

    function update() {
      const shown = Array.from(box.querySelectorAll('[data-ck]')).filter((x) => !x.hidden);
      let done = 0;
      const bad = [];
      const look = [];
      for (const it of shown) {
        const tick = it.querySelector('.tick input');
        const ticked = Boolean(tick && tick.checked);
        it.classList.toggle('ticked', ticked);
        const title = it.querySelector('[data-ck-title]').textContent;
        if (it.classList.contains('ok') || (it.classList.contains('look') && ticked)) done++;
        if (it.classList.contains('bad') && it.hasAttribute('data-block')) bad.push(title);
        if (it.classList.contains('look') && !ticked) look.push(title);
      }
      if (count) count.textContent = done + '/' + shown.length;
      box.classList.toggle('all-ok', done === shown.length);
      let msg = '';
      if (bad.length) msg = 'ยังส่งไม่ได้ ต้องแก้ข้อสีแดงก่อน\n' + bad.join('\n') + '\nกดบันทึกร่างไว้ก่อนได้';
      else if (force && look.length) msg = 'ติ๊ก ดูแล้ว ในข้อสีส้มให้ครบก่อนส่ง\n' + look.join('\n');
      if (btn) {
        if (msg) btn.dataset.blocked = msg;
        else delete btn.dataset.blocked;
        btn.classList.toggle('is-blocked', Boolean(msg));
      }
      if (note) {
        note.hidden = !msg;
        note.textContent = msg ? (bad.length ? 'กดส่งได้เมื่อแก้ข้อสีแดงแล้ว' : 'กดส่งได้เมื่อติ๊ก ดูแล้ว ในข้อสีส้มครบ') : '';
      }
    }
    function set(k, st, sub) {
      const it = item(k);
      if (!it) return;
      it.classList.remove('ok', 'bad', 'look', 'wait');
      it.classList.add(st);
      it.querySelector('[data-ck-ic]').innerHTML = svg(CK_ICON[st], 16);
      if (sub != null) it.querySelector('[data-ck-sub]').textContent = sub;
      update();
    }
    function show(k, on, sub) {
      const it = item(k);
      if (!it) return;
      it.hidden = !on;
      if (on && sub != null) it.querySelector('[data-ck-sub]').textContent = sub;
      update();
    }
    function untick(k) {
      const it = item(k);
      const c = it && it.querySelector('.tick input');
      if (c) c.checked = false;
    }

    function checkCode() {
      const code = normCode(fCode && fCode.value);
      const miss = Boolean(code && text != null && !normCode(text).includes(code));
      show('code', miss, 'ตัวหนังสือใน 3 หน้าแรกไม่มีรหัส ' + code + ' ตรวจว่าแนบไฟล์ถูกวิชา');
    }
    function checkNames() {
      const code = normCode(fCode && fCode.value);
      let hit = '';
      for (const n of names) {
        const other = (n.match(CODE_RE) || []).map(normCode).find((c) => c !== code);
        if (other) {
          hit = 'ชื่อไฟล์ ' + n + ' มีรหัส ' + other + ' แต่รหัสวิชาที่กรอกคือ ' + code;
          break;
        }
      }
      show('fname', Boolean(code && hit), hit);
    }
    function checkFields() {
      const miss = fields.filter(([, el]) => !(el && el.value.trim())).map(([label]) => label);
      set('fields', miss.length ? 'bad' : 'ok', miss.length ? 'ยังไม่ได้กรอก ' + miss.join(' ') : fields.map(([, el]) => el.value.trim()).join(' '));
      checkCode();
      checkNames();
      putFront();
    }
    // เลขที่บันทึกข้อความ (ฟังก์ชันเสริม docnoreq) รับเฉพาะตัวเลข
    const docNo = form.querySelector('[data-docno]');
    function checkDocNo() {
      if (!docNo || !item('docno')) return;
      docNo.value = docNo.value.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)).replace(/[^0-9]/g, '');
      const tail = docNo.nextElementSibling ? docNo.nextElementSibling.textContent : '';
      set('docno', docNo.value ? 'ok' : 'bad', docNo.value ? 'ที่ ' + (docNo.previousElementSibling ? docNo.previousElementSibling.textContent : '') + docNo.value + tail : 'ขอเลขที่ห้องวิชาการ แล้วกรอกเฉพาะตัวเลข');
    }
    if (docNo) docNo.addEventListener('input', checkDocNo);
    for (const [, el] of fields) {
      if (!el) continue;
      el.addEventListener('input', checkFields);
      el.addEventListener('change', checkFields);
    }
    box.addEventListener('change', update);

    async function checkPages(pages, isNew) {
      let msg = '';
      if (minPages && pages < minPages) msg = 'ไฟล์มี ' + pages + ' หน้า น้อยกว่า ' + minPages + ' หน้าที่โรงเรียนตั้งไว้ ตรวจว่าแนบไฟล์ครบทั้งเล่ม';
      else if (isNew && oldFile) {
        if (oldPages == null) {
          const r = await inspectPdf('/f/' + oldFile + '/raw', 0, false);
          oldPages = r.error ? 0 : r.pages;
        }
        if (oldPages && pages < oldPages / 2) msg = 'ไฟล์ใหม่มี ' + pages + ' หน้า ไฟล์เดิมมี ' + oldPages + ' หน้า ตรวจว่าแนบไฟล์ครบทั้งเล่ม';
      }
      return msg;
    }

    // ผลการเปิดไฟล์ (ใช้ทั้งไฟล์ที่เพิ่งเลือกและไฟล์เดิม)
    async function showInspect(token, r, isNew) {
      if (r.error) {
        set('open', 'bad', 'ไฟล์ ' + r.name + (r.error === 'locked' ? ' ติดรหัสผ่าน ผู้ตรวจเปิดไม่ได้ ให้บันทึกเป็น PDF ใหม่แบบไม่ใส่รหัสผ่าน' : ' เปิดไม่ได้ ไฟล์อาจเสีย ให้บันทึกเป็น PDF ใหม่แล้วแนบอีกครั้ง'));
        for (const k of ['blank', 'code', 'pages']) show(k, false);
        if (warn) warn.hidden = true;
        text = null;
        return;
      }
      set('open', 'ok', r.pages + ' หน้า เปิดได้ ไม่ติดรหัสผ่าน');
      front = isNew ? { ink: r.ink, page1: r.text[0] } : null;
      putFront();
      const blank = blankOn && r.ink != null && r.ink < INK_MIN;
      show('blank', blank, 'หน้าแรกแทบไม่มีตัวหนังสือ ดูภาพหน้าปกด้านบนว่าเป็นหน้าปกจริง');
      if (warn) warn.hidden = !blank;
      const joined = r.text.join(' ');
      text = normCode(joined).length >= 30 ? joined : null;
      checkCode();
      const msg = await checkPages(r.pages, isNew);
      if (token !== run) return;
      show('pages', Boolean(msg), msg);
    }

    async function checkDup(token, files) {
      const it = item('dup');
      if (!it) return;
      show('dup', true);
      if (files.length !== 1) {
        set('dup', 'ok', 'ไฟล์ที่รวมแล้ว ระบบเทียบอีกครั้งตอนกดส่ง');
        return;
      }
      const f = files[0];
      const same = dup.filter((d) => d.size === f.size);
      if (same.length) set('dup', 'wait', 'กำลังเทียบกับงานอื่นของคุณ');
      const mine = same.length ? new Uint8Array(await f.arrayBuffer()) : null;
      for (const d of same) {
        try {
          const r = await fetch('/f/' + d.id + '/raw', { credentials: 'same-origin' });
          if (!r.ok) continue;
          const other = new Uint8Array(await r.arrayBuffer());
          if (token !== run) return;
          if (sameBytes(mine, other)) {
            set('dup', 'bad', 'เป็นไฟล์เดียวกับ' + d.label + ' ที่แนบไว้แล้ว แนบไฟล์ของวิชานี้แทน');
            return;
          }
        } catch {
          // เทียบไม่ได้ ระบบตรวจอีกครั้งตอนกดส่ง
        }
      }
      if (token === run) set('dup', 'ok', 'ไม่ซ้ำกับไฟล์ในงานอื่นของคุณ');
    }

    async function onFiles(files) {
      const token = ++run;
      for (const k of ['cover', 'blank', 'code', 'fname', 'pages']) untick(k);
      text = null;
      front = null;
      putFront();
      names = files.map((f) => f.name);
      checkNames();
      if (!files.length) {
        if (oldFile) return inspectOld(token);
        set('pdf', 'bad', 'ยังไม่ได้เลือกไฟล์');
        for (const k of ['open', 'dup', 'blank', 'code', 'pages']) show(k, false);
        if (warn) warn.hidden = true;
        return;
      }
      const notPdf = files.filter((f) => !/\.pdf$/i.test(f.name));
      if (pdfOnly && notPdf.length) set('pdf', 'bad', notPdf.map((f) => f.name).join(' ') + ' ไม่ใช่ PDF');
      else set('pdf', 'ok', files.length > 1 ? 'เลือก ' + files.length + ' ไฟล์ ระบบรวมเป็นไฟล์เดียวตอนส่ง' : files[0].name + ' ' + fmtSize(files[0].size));
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
      checkDup(token, files);
      if (!pdfs.length) {
        for (const k of ['open', 'blank', 'code', 'pages']) show(k, false);
        return;
      }
      show('open', true);
      set('open', 'wait', 'กำลังตรวจ');
      const all = { pages: 0, text: [], ink: null };
      for (let i = 0; i < pdfs.length; i++) {
        const r = await inspectPdf(new Uint8Array(await pdfs[i].arrayBuffer()), 3 - all.text.length, i === 0 && (blankOn || Boolean(frontIn)));
        if (token !== run) return;
        if (r.error) return showInspect(token, { error: r.error, name: pdfs[i].name }, true);
        all.pages += r.pages;
        all.text.push(...r.text);
        if (i === 0) all.ink = r.ink;
      }
      showInspect(token, all, true);
    }
    // ยังไม่เลือกไฟล์ใหม่: ตรวจไฟล์เดิมที่แนบไว้ (โหลดเฉพาะส่วนที่ใช้)
    async function inspectOld(token) {
      set('pdf', 'ok', item('pdf').querySelector('[data-ck-sub]').dataset.old || item('pdf').querySelector('[data-ck-sub]').textContent);
      show('open', true);
      set('open', 'wait', 'กำลังตรวจไฟล์เดิม');
      const r = await inspectPdf('/f/' + oldFile + '/raw', 3, blankOn);
      if (token !== run) return;
      showInspect(token, { ...r, name: 'เดิม' }, false);
    }

    // เซ็นชื่อจากรายการตรวจ: ใส่ลายเซ็นในฟอร์ม ใช้ตอนกดส่ง ไม่ต้องออกจากหน้านี้
    const signBtn = box.querySelector('[data-ck-sign]');
    if (signBtn) {
      signBtn.addEventListener('click', async () => {
        const got = await askSignature('form');
        if (!got) return;
        for (const [k, v] of Object.entries(got)) if (v) putSigField(form, k, v);
        signBtn.hidden = true;
        set('sig', 'ok', 'เซ็นแล้ว ลายเซ็นนี้ใช้ตอนกดส่ง');
      });
    }

    const pdfSub = item('pdf') && item('pdf').querySelector('[data-ck-sub]');
    if (pdfSub) pdfSub.dataset.old = pdfSub.textContent;
    if (zone) zone.addEventListener('dz:change', (e) => onFiles(e.detail.files || []));
    checkFields();
    checkDocNo();
    if (oldFile) inspectOld(++run);
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
      applyScope();
    }
    r.addEventListener('change', apply);
    apply();
  });
  // ไฟล์นี้มีบันทึก แผนเดียว หลายแผน ทั้งเล่ม (ฟังก์ชันเสริม notewhole) พิมพ์ในระบบเป็นแผนเดียวเสมอ
  // ช่องของแบบที่ไม่ได้เลือกปิดไว้ (disabled) ไม่ส่งไปกับฟอร์ม เช่น ช่องเรื่องมี 2 ช่อง
  function applyScope() {
    if (!document.querySelector('[data-scope]')) return;
    const mode = document.querySelector('input[name=note_mode]:checked');
    const pick = document.querySelector('input[name=plan_scope]:checked');
    const scope = mode && mode.value === 'file' && pick ? pick.value : 'one';
    document.querySelectorAll('[data-scope]').forEach((el) => {
      el.hidden = el.dataset.scope !== scope;
      el.querySelectorAll('input, select, textarea').forEach((i) => (i.disabled = el.hidden));
    });
  }
  document.querySelectorAll('input[name=plan_scope]').forEach((r) => r.addEventListener('change', applyScope));
  applyScope();

  // ---------- จำนวนนักเรียนแยกรายห้อง (ฟังก์ชันเสริม noterooms) ----------
  // แถวเดียวไม่ใส่ห้อง = ยอดรวม · เพิ่มห้องคัดลอกแถวสุดท้ายแบบว่าง · สรุปยอดรวมใต้ตาราง (เซิร์ฟเวอร์คิดซ้ำตอนบันทึก)
  document.querySelectorAll('[data-rooms]').forEach((grid) => {
    const card = grid.parentElement;
    const add = card.querySelector('[data-room-add]');
    const sum = card.querySelector('[data-room-sum]');
    const rows = () => [...grid.querySelectorAll('[data-room-row]')];
    const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
    function update() {
      const list = rows();
      list.forEach((r) => (r.querySelector('[data-room-del]').hidden = list.length < 2));
      if (add) add.hidden = list.length >= Number(add.dataset.max || 20);
      const filled = list.map((r) => ({ total: num(r.querySelector('[name=room_total]')), passed: num(r.querySelector('[name=room_passed]')) })).filter((x) => x.total != null);
      if (!sum) return;
      sum.hidden = !filled.length;
      if (!filled.length) return;
      const total = filled.reduce((a, x) => a + x.total, 0);
      const done = filled.every((x) => x.passed != null);
      const passed = filled.reduce((a, x) => a + (x.passed || 0), 0);
      const head = (list.length > 1 ? 'รวม ' + list.length + ' ห้อง ' : '') + 'นักเรียน ' + total + ' คน';
      sum.textContent = done ? head + ' ผ่าน ' + passed + ' คน' + (total ? ' (' + Math.round((passed / total) * 100) + '%)' : '') : head + ' ยังกรอกจำนวนที่ผ่านไม่ครบทุกห้อง';
    }
    if (add)
      add.addEventListener('click', () => {
        const last = rows().pop();
        const row = last.cloneNode(true);
        row.querySelectorAll('input').forEach((i) => (i.value = ''));
        last.after(row);
        row.querySelector('input').focus();
        update();
      });
    grid.addEventListener('click', (e) => {
      const del = e.target.closest('[data-room-del]');
      if (!del || rows().length < 2) return;
      del.closest('[data-room-row]').remove();
      update();
    });
    grid.addEventListener('input', update);
    update();
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
      // เติมด้วยสคริปต์ไม่เกิดเหตุการณ์ input เอง ต้องส่งต่อให้รายการตรวจก่อนส่ง (ข้อกรอกครบ) รู้ว่ากรอกแล้ว
      if (name && !name.value) {
        name.value = opt.dataset.name || '';
        name.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (grade && opt.dataset.grade && !grade.value) {
        grade.value = opt.dataset.grade;
        grade.dispatchEvent(new Event('change', { bubbles: true }));
      }
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
