// NovelAI 페이지 안(MAIN world)에서 실행: 생성 요청과 결과 이미지를 감지해서 panel.js 로 넘김
(() => {
  if (window.__naiStudioHook) return;
  window.__naiStudioHook = true;

  const post = (data, transfer) => window.postMessage(Object.assign({ __naiStudio: 1, from: 'hook' }, data), location.origin, transfer || []);
  const cfg = { pngOnly: true, snipExpand: true, snippets: {}, trigger: '%' };
  const capture = { until: 0, meta: null, seq: 0 };
  const seenSrc = new Set();
  const hashes = new Set();

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__naiStudio !== 1 || d.from !== 'panel') return;
    if (d.type === 'cfg') Object.assign(cfg, d.cfg);
    else if (d.type === 'scan') scanPage();
    else if (d.type === 'fieldExpanded') fieldSnips = { names: d.names || [], t: Date.now() };
  });
  // 패널이 생성 버튼 누를 때 칸에서 미리 펼친 경우 → 기록에 쓸 치환어 이름
  let fieldSnips = null;

  // NovelAI 버전마다 주소가 조금씩 달라서 넓게 (generate-image, generate-image-stream, …)
  const isGenURL = (url) => /\/ai\/generate/.test(String(url || ''));

  /* ---------- %이름 치환: 생성 요청을 보내기 직전에 펼침 (기호는 설정값) ---------- */
  const snipRe = () => new RegExp(cfg.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\p{L}\\p{N}_\\-.]+)', 'gu');
  function expandText(s, used, depth = 0) {
    if (typeof s !== 'string' || s.indexOf(cfg.trigger) < 0 || depth > 6) return s;
    return s.replace(snipRe(), (all, name) => {
      let n = name, tail = '';
      while (!(n in cfg.snippets) && /[.\-]$/.test(n)) { tail = n.slice(-1) + tail; n = n.slice(0, -1); }
      if (!(n in cfg.snippets)) return all;
      used.add(n);
      return expandText(cfg.snippets[n], used, depth + 1) + tail;
    });
  }
  let lastUsed = [];
  // 요청 안의 모든 글자 값을 훑어서 펼침 (필드 이름이 버전마다 달라도 됨. 아주 긴 값 = 이미지 데이터는 건너뜀)
  function walk(v, ex) {
    if (typeof v === 'string') return v.length > 200000 ? v : ex(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, ex));
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k], ex); return v; }
    return v;
  }
  function applySnippets(body) {
    lastUsed = [];
    if (!cfg.snipExpand || !cfg.trigger || typeof body !== 'string' || body.indexOf(cfg.trigger) < 0 || !Object.keys(cfg.snippets).length) return body;
    let j;
    try { j = JSON.parse(body); } catch (e) { return body; }
    const used = new Set();
    j = walk(j, (s) => expandText(s, used));
    if (!used.size) return body;
    lastUsed = [...used];
    post({ type: 'expanded', names: lastUsed });
    return JSON.stringify(j);
  }
  // 글자가 아닌 형식으로 보내도 JSON 이면 읽어서 처리
  async function bodyToText(b) {
    try {
      if (typeof b === 'string') return b;
      if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
      if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
      if (b instanceof Blob) return await b.text();
    } catch (e) { /* noop */ }
    return null;
  }
  const looksJSON = (t) => typeof t === 'string' && /^\s*[{[]/.test(t);
  // FormData 안의 글자 · 작은 파일 중 JSON 인 것만 펼쳐서 새 FormData 로 (이미지 같은 큰 첨부는 그대로)
  async function expandFormData(src) {
    const out = new FormData();
    let changed = false, json = null;
    const used = new Set();
    for (const [k, v] of src.entries()) {
      if (typeof v === 'string') {
        if (looksJSON(v)) {
          const nv = applySnippets(v);
          lastUsed.forEach((n) => used.add(n));
          if (!json) json = nv;
          if (nv !== v) { changed = true; out.append(k, nv); continue; }
        }
        out.append(k, v);
      } else if (v instanceof Blob && v.size < 5e6 && (v.type === '' || /json|text/.test(v.type))) {
        const t = await v.text();
        if (looksJSON(t)) {
          const nv = applySnippets(t);
          lastUsed.forEach((n) => used.add(n));
          if (!json) json = nv;
          if (nv !== t) { changed = true; out.append(k, new Blob([nv], { type: v.type }), v.name || 'blob'); continue; }
        }
        out.append(k, v, v.name || 'blob');
      } else {
        out.append(k, v, v instanceof File ? v.name : undefined);
      }
    }
    lastUsed = [...used];
    return { fd: changed ? out : null, json };
  }
  function diag(url, kind) {
    let path = String(url);
    try { const u = new URL(path, location.href); path = u.host + u.pathname; } catch (e) { /* noop */ }
    post({ type: 'genSeen', url: path, kind, expanded: lastUsed.slice(), t: Date.now() });
  }
  function slim(v) {
    if (typeof v === 'string') return v.length > 4000 ? undefined : v;
    if (Array.isArray(v)) return v.map(slim).filter((x) => x !== undefined);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) { const s = slim(x); if (s !== undefined) o[k] = s; }
      return o;
    }
    return v;
  }

  function snapshotExisting() {
    try { document.querySelectorAll('img').forEach((img) => { const s = img.getAttribute('src'); if (s) seenSrc.add(s); }); } catch (e) { /* noop */ }
  }

  function onGenerateRequest(body) {
    snapshotExisting();
    capture.until = Date.now() + 180000;
    capture.seq = 0;
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : null;
      if (!j) return;
      const p = j.parameters || {};
      const cap = (k) => (p[k] && p[k].caption) || {};
      const v4 = Object.keys(cap('v4_prompt')).length ? cap('v4_prompt') : cap('v5_prompt');
      const v4n = Object.keys(cap('v4_negative_prompt')).length ? cap('v4_negative_prompt') : cap('v5_negative_prompt');
      const meta = {
        prompt: j.input || p.prompt || v4.base_caption || '',
        neg: p.negative_prompt || p.uc || v4n.base_caption || '',
        chars: (v4.char_captions || []).map((c) => c.char_caption).filter(Boolean),
        seed: p.seed, model: j.model || '', w: p.width, h: p.height,
        steps: p.steps, scale: p.scale, sampler: p.sampler,
        // 요청 설정 전체 (참조 이미지 같은 큰 base64 는 빼고) → .json 정보 파일에 그대로 남김
        raw: slim({ input: j.input, model: j.model, action: j.action, parameters: p }),
      };
      if (lastUsed.length) meta.snips = lastUsed.slice();
      else if (fieldSnips && Date.now() - fieldSnips.t < 15000) meta.snips = fieldSnips.names.slice();
      fieldSnips = null;
      capture.meta = meta;
      post({ type: 'gen', meta });
    } catch (e) { /* 형식이 바뀌어도 생성은 막지 않음 */ }
  }

  // fetch
  const origFetch = window.fetch;
  function track(p) {
    p.then((r) => {
      // 스트리밍이 끝까지 내려온 뒤엔 짧게만 감지 창을 열어 둠
      r.clone().arrayBuffer().then(
        () => { capture.until = Date.now() + 12000; },
        () => { capture.until = Date.now() + 12000; }
      );
    }, () => { capture.until = Date.now() + 3000; });
    return p;
  }
  window.fetch = function (input, init) {
    let gen = false;
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      gen = isGenURL(url) && method === 'POST';
    } catch (e) { gen = false; }
    if (!gen) return origFetch.apply(this, arguments);

    const self = this;
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    try {
      if (init && typeof init.body === 'string') {
        const body = applySnippets(init.body);
        onGenerateRequest(body);
        diag(url, looksJSON(body) ? 'JSON' : '글자');
        return track(origFetch.call(self, input, body !== init.body ? Object.assign({}, init, { body }) : init));
      }
      if (init && typeof FormData !== 'undefined' && init.body instanceof FormData) {
        // NovelAI V5: 요청을 FormData(첨부가 있는 양식)로 보냄 → 안의 JSON 부분을 찾아 펼침
        return expandFormData(init.body).then(({ fd, json }) => {
          onGenerateRequest(json);
          diag(url, json ? 'FormData(JSON)' : 'FormData(읽을 수 없음)');
          return track(origFetch.call(self, input, fd ? Object.assign({}, init, { body: fd }) : init));
        }, () => { onGenerateRequest(null); diag(url, 'FormData(오류)'); return track(origFetch.call(self, input, init)); });
      }
      if (init && init.body != null) {
        // ArrayBuffer · Uint8Array · Blob 로 보내는 경우
        return bodyToText(init.body).then((txt) => {
          if (!looksJSON(txt)) { onGenerateRequest(null); diag(url, '이진(읽을 수 없음)'); return track(origFetch.call(self, input, init)); }
          const body = applySnippets(txt);
          onGenerateRequest(body);
          diag(url, 'JSON(이진)');
          return track(origFetch.call(self, input, body !== txt ? Object.assign({}, init, { body }) : init));
        });
      }
      if (input && typeof input.clone === 'function') {
        return input.clone().text().then(
          (txt) => {
            const body = applySnippets(txt);
            onGenerateRequest(looksJSON(body) ? body : null);
            diag(url, looksJSON(body) ? 'JSON(Request)' : '읽을 수 없음');
            return track(origFetch.call(self, body !== txt ? new Request(input, { body }) : input, init));
          },
          () => { onGenerateRequest(null); diag(url, '읽을 수 없음'); return track(origFetch.call(self, input, init)); }
        );
      }
    } catch (e) { /* 치환이 실패해도 생성은 원래대로 */ }
    onGenerateRequest(null);
    diag(url, '본문 없음');
    return track(origFetch.call(self, input, init));
  };

  // XHR
  const XP = XMLHttpRequest.prototype;
  const oOpen = XP.open, oSend = XP.send;
  XP.open = function (method, url) {
    try { this.__naiGen = isGenURL(url) && String(method).toUpperCase() === 'POST'; this.__naiUrl = String(url); } catch (e) { /* noop */ }
    return oOpen.apply(this, arguments);
  };
  XP.send = function (body) {
    try {
      if (this.__naiGen) {
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
          const t = new TextDecoder().decode(body);
          if (looksJSON(t)) body = t;
        }
        if (typeof body === 'string') body = applySnippets(body);
        onGenerateRequest(typeof body === 'string' ? body : null);
        diag(this.__naiUrl || 'xhr', typeof body === 'string' ? 'JSON(XHR)' : '읽을 수 없음(XHR)');
        this.addEventListener('loadend', () => { capture.until = Date.now() + 12000; });
      }
    } catch (e) { /* noop */ }
    return oSend.call(this, body);
  };

  // createObjectURL — 생성 직후 페이지가 만드는 이미지 Blob
  const origCOU = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCOU.apply(this, arguments);
    try {
      if (Date.now() < capture.until && obj && typeof obj.size === 'number' && obj.size > 30000) {
        const t = String(obj.type || '');
        if (!t || t.startsWith('image/') || t === 'application/octet-stream') {
          seenSrc.add(url);
          ingest(obj, true);
        }
      }
    } catch (e) { /* noop */ }
    return url;
  };

  // DOM (data: URL · 놓친 blob:)
  function dataURLtoBlob(s) {
    const [head, b64] = s.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
  function checkImg(img) {
    if (Date.now() > capture.until) return;
    const s = img.getAttribute && img.getAttribute('src');
    if (!s || seenSrc.has(s)) return;
    if (s.startsWith('data:image/') && s.length > 40000) {
      seenSrc.add(s);
      try { ingest(dataURLtoBlob(s), true); } catch (e) { /* noop */ }
    } else if (s.startsWith('blob:')) {
      seenSrc.add(s);
      origFetch(s).then((r) => r.blob()).then((b) => ingest(b, true), () => {});
    }
  }
  const startObserver = () => new MutationObserver((muts) => {
    if (Date.now() > capture.until) return;
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.target.tagName === 'IMG') checkImg(m.target); continue; }
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IMG') checkImg(n);
        else if (n.querySelectorAll) n.querySelectorAll('img').forEach(checkImg);
      });
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  if (document.documentElement) startObserver();
  else document.addEventListener('readystatechange', startObserver, { once: true });

  // 생성 버튼 클릭 (요청 훅을 놓쳤을 때의 보험)
  document.addEventListener('click', (e) => {
    try {
      const btn = e.target && e.target.closest && e.target.closest('button');
      if (btn && !btn.closest('#nai-studio-host') && /generate|생성/i.test(btn.textContent || '')) {
        snapshotExisting();
        capture.until = Math.max(capture.until, Date.now() + 180000);
      }
    } catch (err) { /* noop */ }
  }, true);

  function sniff(u8) {
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
    if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
    return null;
  }

  async function ingest(blob, auto) {
    try {
      const buf = await blob.arrayBuffer();
      if (buf.byteLength < 12) return;
      const kind = sniff(new Uint8Array(buf, 0, 12));
      if (!kind) return;
      if (auto && cfg.pngOnly && kind !== 'png') return;
      const hd = await crypto.subtle.digest('SHA-1', buf);
      const hash = [...new Uint8Array(hd)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hashes.has(hash)) return;
      hashes.add(hash);
      let w = 0, h = 0;
      try {
        const bmp = await createImageBitmap(new Blob([buf]));
        w = bmp.width; h = bmp.height;
        if (bmp.close) bmp.close();
      } catch (e) { hashes.delete(hash); return; }
      if (Math.min(w, h) < (auto ? 256 : 32)) { hashes.delete(hash); return; }
      post({
        type: 'img', buf, kind, w, h, hash, auto,
        meta: auto && capture.meta ? Object.assign({}, capture.meta) : null,
        n: auto ? ++capture.seq : 0,
        t: Date.now(),
      }, [buf]);
    } catch (e) { /* noop */ }
  }

  async function scanPage() {
    const imgs = [...document.querySelectorAll('img')].filter((img) => {
      const s = img.currentSrc || img.src || '';
      return (s.startsWith('blob:') || s.startsWith('data:image/')) && (img.naturalWidth >= 256 || img.width >= 128);
    });
    let n = 0;
    for (const img of imgs) {
      try {
        const s = img.currentSrc || img.src;
        const blob = s.startsWith('data:') ? dataURLtoBlob(s) : await (await origFetch(s)).blob();
        await ingest(blob, false);
        n++;
      } catch (e) { /* noop */ }
    }
    post({ type: 'scanDone', found: imgs.length });
  }
})();
