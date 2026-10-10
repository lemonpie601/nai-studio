// NovelAI 페이지 위에 뜨는 작은 패널 (isolated world)
(() => {
  'use strict';
  if (window.__naiStudioPanel) return;
  window.__naiStudioPanel = true;

  /* ------------------------------------------------------------------ *
   * 확장 프로그램과 통신
   * ------------------------------------------------------------------ */
  let alive = true;
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: '응답 없음' });
        });
      } catch (e) {
        alive = false;
        resolve({ ok: false, error: 'invalidated' });
      }
    });
  }
  // 확장 프로그램을 새로고침(업데이트)하면 이미 열려 있던 페이지는 연결이 끊김 → 저장이 조용히 실패함
  const isAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const deadToast = () => showDead();
  function showDead() {
    alive = false;
    toast('연결이 끊겨서 저장하지 못했어요. 새로고침해 주세요', 'err', 4000);
    const pnl = root && root.querySelector('.panel');
    if (!pnl || pnl.querySelector('.dead')) return;
    const bar = document.createElement('div');
    bar.className = 'dead';
    bar.innerHTML = `<span class="grow">확장 프로그램이 업데이트돼서 연결이 끊겼어요</span><button class="btn sm pri">새로고침</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      // 쓰던 내용은 새로고침 뒤에 되살림
      try { sessionStorage.setItem('nai-studio-draft', JSON.stringify({ sn: { name: SN.name, text: SN.text, editing: SN.editing }, tr: T.input, tab: UI.tab })); } catch (e) { /* noop */ }
      location.reload();
    });
    pnl.insertBefore(bar, pnl.querySelector('.tabs'));
  }
  async function sget(k) {
    if (!isAlive()) { showDead(); throw new Error('invalidated'); }
    return chrome.storage.local.get(k);
  }
  async function sset(o) {
    if (!isAlive()) { showDead(); throw new Error('invalidated'); }
    try { await chrome.storage.local.set(o); } catch (e) { showDead(); throw e; }
  }

  const DEFAULTS = { autoSave: true, saveMode: 'original', pngOnly: true, snipExpand: true, snipTrigger: '%', theme: 'auto', autoIns: false, tagMode: true, lowercase: true, stripArticles: true, convFormat: 'webp' };
  let S = Object.assign({}, DEFAULTS);
  let history = [], dict = {}, snippets = {}, folder = { name: '', perm: 'none' }, stats = { day: '', count: 0 };

  async function loadStore() {
    try {
      const d = await chrome.storage.local.get(['settings', 'history', 'dict', 'snippets', 'folderName', 'folderPerm', 'stats']);
      S = Object.assign({}, DEFAULTS, d.settings || {});
      history = d.history || [];
      dict = d.dict || {};
      snippets = d.snippets || {};
      folder = { name: d.folderName || '', perm: d.folderPerm || 'none' };
      stats = d.stats || stats;
      postCfg();
    } catch (e) { alive = false; }
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.settings) { S = Object.assign({}, DEFAULTS, ch.settings.newValue || {}); postCfg(); applyTheme(); updateChrome(); hlSchedule(); }
      if (ch.history) { history = ch.history.newValue || []; refreshTab('history'); }
      if (ch.dict) { dict = ch.dict.newValue || {}; refreshTab('dict'); }
      if (ch.snippets) { snippets = ch.snippets.newValue || {}; postCfg(); hlSchedule(); if (!SN.editing) refreshTab('snip'); }
      if (ch.folderName || ch.folderPerm) {
        if (ch.folderName) folder.name = ch.folderName.newValue || '';
        if (ch.folderPerm) folder.perm = ch.folderPerm.newValue || 'none';
        refreshTab('recent');
        refreshTab('settings');
      }
      if (ch.stats) stats = ch.stats.newValue || stats;
    });
  } catch (e) { alive = false; }
  async function setS(patch) {
    Object.assign(S, patch);
    try {
      const { settings } = await sget('settings');
      await sset({ settings: Object.assign({}, settings || {}, patch) });
    } catch (e) { deadToast(); }
  }
  const TG = () => S.snipTrigger || '%'; // 치환어 앞 기호
  const postCfg = () => window.postMessage({ __naiStudio: 1, from: 'panel', type: 'cfg', cfg: { pngOnly: S.pngOnly, snipExpand: S.snipExpand, snippets, trigger: TG() } }, location.origin);
  // hook.js 가 나중에 준비될 수도 있어서 한 번 더
  setTimeout(() => postCfg(), 1500);

  /* ------------------------------------------------------------------ *
   * %이름 치환 (앞 기호는 설정값)
   * ------------------------------------------------------------------ */
  const TRIGGERS = ['%', '#', '$', '~', '&', '!', '@'];
  const cleanSnipName = (s) => String(s || '').trim().replace(/^[%#$~&!@]+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_\-.]/gu, '');
  const snipRe = () => new RegExp(TG().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\p{L}\\p{N}_\\-.]+)', 'gu');
  function expandSnippets(text, used = new Set(), depth = 0) {
    if (typeof text !== 'string' || text.indexOf(TG()) < 0 || depth > 6) return text;
    return text.replace(snipRe(), (all, name) => {
      let n = name, tail = '';
      while (!(n in snippets) && /[.\-]$/.test(n)) { tail = n.slice(-1) + tail; n = n.slice(0, -1); }
      if (!(n in snippets)) return all;
      used.add(n);
      return expandSnippets(snippets[n], used, depth + 1) + tail;
    });
  }
  // 기호를 바꾸면 치환어 안에 적어 둔 다른 치환어(%화풍 → #화풍)도 같이 바꿈
  async function changeTrigger(nt) {
    const old = TG();
    if (nt === old) return;
    const re = new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\p{L}\\p{N}_\\-.]+)', 'gu');
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(snippets)) {
      next[k] = String(v).replace(re, (all, n) => {
        let m = n;
        while (!(m in snippets) && /[.\-]$/.test(m)) m = m.slice(0, -1);
        if (!(m in snippets)) return all;
        changed = true;
        return nt + n;
      });
    }
    await setS({ snipTrigger: nt });
    if (changed) await saveSnippets(next);
    postCfg();
    toast(`이제 ${nt}이름 으로 써요`, 'ok');
  }
  // 저장이 실제로 끝난 뒤에만 반영 (실패하면 false)
  async function saveSnippets(next) {
    try { await sset({ snippets: next }); } catch (e) { return false; }
    snippets = next;
    postCfg();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 유틸
   * ------------------------------------------------------------------ */
  const HANGUL = /[ㄱ-ㆎ가-힣]/;
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function fmtTime(t) {
    const d = new Date(t), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? `오늘 ${hm}` : `${d.getMonth() + 1}.${d.getDate()} ${hm}`;
  }
  const fmtBytes = (n) => (n < 1024 * 1024 ? (n / 1024).toFixed(0) + 'KB' : (n / 1024 / 1024).toFixed(1) + 'MB');
  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }
  function rebuildOutput(r) {
    if (!r.pieces) return r.output;
    const pieces = r.pieces.slice();
    r.jobs.forEach((j) => (pieces[j.i] = j.lead + j.dst + j.tail));
    r.output = pieces.join('');
    return r.output;
  }
  /* ---------- 칸을 고칠 땐 '내 치환어 자리'만 ----------
     칸 전체를 글자로 뽑아 다시 쓰면 NovelAI 청크(⌜macro:…⌟ 블록)가 풀려 버림 → 절대 통째로 바꾸지 않음 */
  // 칸 안의 글자 조각만 (청크 같은 편집 불가 블록 안은 제외)
  function textNodesOf(rootEl) {
    const out = [];
    const w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const lock = n.parentElement && n.parentElement.closest('[contenteditable="false"]');
        return lock && rootEl.contains(lock) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }
  // NovelAI 는 1.2::…:: 같은 강조를 색칠하느라 글자를 여러 조각으로 나눔 → 조각들을 이어 붙인 글자로 찾고, 위치를 다시 조각으로 바꿈
  function flatText(rootEl) {
    let text = '', prevBlock = null;
    const map = [];
    for (const n of textNodesOf(rootEl)) {
      const blk = n.parentElement && n.parentElement.closest('p, li, h1, h2, h3, pre, blockquote');
      if (map.length && blk !== prevBlock) text += '\n'; // 문단이 바뀌면 줄바꿈으로 구분
      prevBlock = blk;
      map.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
    }
    return { text, map };
  }
  function rangeOf(flat, a, b) {
    const s = flat.map.find((m) => a >= m.start && a < m.end) || flat.map.find((m) => a === m.end);
    const e = flat.map.find((m) => b > m.start && b <= m.end);
    if (!s || !e) return null;
    const r = document.createRange();
    r.setStart(s.node, a - s.start);
    r.setEnd(e.node, b - e.start);
    return r;
  }
  function replaceRange(el, r, text) {
    el.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return execInsert(el, text);
  }
  function replaceText(el, node, start, end, text) {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    return replaceRange(el, r, text);
  }
  // 치환어 자리를 하나씩 펼침 → 되돌릴 수 있게 [{ token, expanded }]
  function expandTokensInPlace(el, used) {
    const applied = [];
    for (let guard = 0; guard < 60; guard++) {
      const t = scanTokens(el).find((x) => x.known);
      if (!t) break;
      const token = t.token;
      const expanded = expandSnippets(token, used);
      if (expanded === token) break;
      if (!replaceRange(el, t.range, expanded)) break;
      applied.push({ token, expanded });
    }
    return applied;
  }
  // 펼쳤던 자리를 다시 치환어로 (뒤에서부터)
  function collapseInPlace(el, applied) {
    for (let i = applied.length - 1; i >= 0; i--) {
      const { token, expanded } = applied[i];
      const flat = flatText(el);
      const k = flat.text.lastIndexOf(expanded);
      if (k < 0) continue;
      const r = rangeOf(flat, k, k + expanded.length);
      if (r) replaceRange(el, r, token);
    }
  }
  // Alt+E: 칸 안의 %이름 을 그 자리에서 펼쳐 보기 (청크는 그대로)
  function expandInField() {
    const el = editableRoot(document.activeElement) || findPromptTarget();
    if (!el) { toast('프롬프트 칸을 클릭한 뒤 Alt+E 를 눌러 주세요', 'info'); return; }
    const used = new Set();
    if (isTextField(el)) {
      const out = expandSnippets(el.value, used);
      if (used.size) { el.focus(); el.select(); execInsert(el, out); }
    } else {
      expandTokensInPlace(el, used);
    }
    if (!used.size) { toast(`펼칠 ${TG()}치환어가 없어요`, 'info'); return; }
    toast(`펼쳤어요 · ${[...used].map((n) => TG() + n).join(' ')}`, 'ok');
  }

  /* ---------- % 자동완성 ---------- */
  const AC = { open: false, items: [], idx: 0, ctx: null, box: null };
  function caretContext() {
    const el = editableRoot(document.activeElement);
    if (!el || (host && host.contains(el))) return null;
    let before, rect, node = null, end;
    if (isTextField(el)) {
      if (el.selectionStart !== el.selectionEnd) return null;
      end = el.selectionStart;
      before = el.value.slice(0, end);
      const r = el.getBoundingClientRect();
      rect = { left: r.left + 12, bottom: r.bottom };
    } else {
      const sel = window.getSelection();
      if (!sel.rangeCount || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3) return null;
      node = sel.anchorNode;
      end = sel.anchorOffset;
      before = node.textContent.slice(0, end);
    }
    const at = before.lastIndexOf(TG());
    if (at < 0) return null;
    const q = before.slice(at + 1);
    if (!/^[\p{L}\p{N}_\-.]*$/u.test(q)) return null;
    if (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1])) return null; // 이메일 같은 건 무시
    if (node) {
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, end);
      const b = r.getBoundingClientRect();
      rect = { left: b.left, bottom: b.bottom };
    }
    return { el, node, start: at, end, q, rect };
  }
  function acMatches(q) {
    const names = Object.keys(snippets);
    const lq = q.toLowerCase();
    const a = names.filter((n) => n.toLowerCase().startsWith(lq));
    const b = names.filter((n) => !n.toLowerCase().startsWith(lq) && n.toLowerCase().includes(lq));
    return a.sort().concat(b.sort()).slice(0, 8);
  }
  function acClose() {
    AC.open = false;
    if (AC.box) AC.box.hidden = true;
  }
  function acUpdate() {
    if (!root || !Object.keys(snippets).length) return acClose();
    const ctx = caretContext();
    if (!ctx) return acClose();
    const items = acMatches(ctx.q);
    if (!items.length) return acClose();
    if (!AC.box) {
      AC.box = document.createElement('div');
      AC.box.className = 'ac';
      root.querySelector('.root').appendChild(AC.box);
      AC.box.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 프롬프트 칸 포커스 유지
        const it = e.target.closest('[data-ac]');
        if (it) acAccept(+it.dataset.ac, e.shiftKey);
      });
    }
    const same = AC.open && AC.items.join('|') === items.join('|');
    AC.items = items;
    AC.ctx = ctx;
    if (!same) AC.idx = 0;
    AC.open = true;
    AC.box.hidden = false;
    AC.box.innerHTML = items.map((n, i) => `<div class="aci ${i === AC.idx ? 'on' : ''}" data-ac="${i}"><b>${esc(TG() + n)}</b><span>${esc(snippets[n])}</span></div>`).join('')
      + `<div class="acf"><kbd>Enter</kbd> 넣기 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 펼쳐 넣기 · <kbd>Esc</kbd></div>`;
    const w = 340;
    const x = Math.min(Math.max(8, ctx.rect.left), window.innerWidth - w - 8);
    let y = ctx.rect.bottom + 6;
    const h = AC.box.offsetHeight || 200;
    if (y + h > window.innerHeight - 8) y = Math.max(8, ctx.rect.bottom - h - 30);
    Object.assign(AC.box.style, { left: x + 'px', top: y + 'px' });
  }
  function acAccept(i, expand) {
    const name = AC.items[i];
    const ctx = caretContext() || AC.ctx;
    acClose();
    if (!name || !ctx) return;
    const el = ctx.el;
    el.focus();
    if (isTextField(el)) el.setSelectionRange(ctx.start, ctx.end);
    else {
      const r = document.createRange();
      r.setStart(ctx.node, ctx.start);
      r.setEnd(ctx.node, Math.min(ctx.end, ctx.node.textContent.length));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    execInsert(el, expand ? expandSnippets(snippets[name]) : TG() + name);
  }
  let acTimer = 0;
  const acSchedule = () => { clearTimeout(acTimer); acTimer = setTimeout(acUpdate, 0); };
  document.addEventListener('input', acSchedule, true);
  document.addEventListener('selectionchange', () => { if (AC.open) acSchedule(); });
  document.addEventListener('focusout', (e) => { if (!host || !e.composedPath().includes(host)) setTimeout(() => { if (!editableRoot(document.activeElement)) acClose(); }, 0); }, true);
  window.addEventListener('resize', acClose);
  function acKey(e) {
    if (!AC.open || e.isComposing || e.keyCode === 229) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      AC.idx = (AC.idx + (e.key === 'ArrowDown' ? 1 : -1) + AC.items.length) % AC.items.length;
      AC.box.querySelectorAll('.aci').forEach((x, i) => x.classList.toggle('on', i === AC.idx));
    } else if (e.key === 'Enter' || e.key === 'Tab') acAccept(AC.idx, e.shiftKey);
    else if (e.key === 'Escape') acClose();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  }

  /* ---------- 프롬프트 칸의 치환어 표시 ----------
     NovelAI 칸의 글은 건드리지 않고 브라우저 하이라이트로 밑줄만 그림 + 칸 아래 꼬리표 */
  const HL_OK = 'nai-snip', HL_BAD = 'nai-snip-bad';
  let hlStyled = false, hlTimer = 0, badge = null;
  function ensureHlStyle() {
    if (hlStyled) return;
    hlStyled = true;
    const css = `::highlight(${HL_OK}){background-color:rgba(217,194,126,.2);text-decoration:underline 1.5px rgba(217,194,126,.95);text-underline-offset:3px}
::highlight(${HL_BAD}){text-decoration:underline wavy rgba(226,126,100,.95);text-underline-offset:3px}`;
    try {
      const sh = new CSSStyleSheet();
      sh.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh];
    } catch (e) {
      const st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    }
  }
  function editorRoots() {
    const set = new Set();
    document.querySelectorAll('.ProseMirror, [contenteditable="true"]').forEach((el) => {
      const r = editableRoot(el);
      if (r && !(host && host.contains(r))) set.add(r);
    });
    return [...set];
  }
  function scanTokens(rootEl) {
    const out = [];
    const tg = TG();
    const flat = flatText(rootEl);
    const t = flat.text;
    if (t.indexOf(tg) < 0) return out;
    const re = snipRe();
    let m;
    while ((m = re.exec(t))) {
      if (m.index > 0 && /[\p{L}\p{N}_]/u.test(t[m.index - 1])) continue; // 50%off 같은 건 무시
      let name = m[1];
      while (!(name in snippets) && /[.\-]$/.test(name)) name = name.slice(0, -1);
      const end = m.index + tg.length + name.length;
      const r = rangeOf(flat, m.index, end);
      if (r) out.push({ range: r, name, token: t.slice(m.index, end), known: name in snippets });
    }
    return out;
  }
  function refreshHighlights() {
    try {
      // 이 파일엔 스타일 문자열 상수 CSS 가 있어서 브라우저의 CSS 는 window.CSS 로 써야 함
      const reg = window.CSS && window.CSS.highlights;
      if (!reg || !window.Highlight) return;
      ensureHlStyle();
      const ok = [], bad = [];
      for (const r of editorRoots()) for (const t of scanTokens(r)) (t.known ? ok : bad).push(t.range);
      reg.set(HL_OK, new Highlight(...ok));
      reg.set(HL_BAD, new Highlight(...bad));
      updateBadge();
    } catch (e) {
      console.warn('[NAI Folio] 치환어 표시 실패', e);
    }
  }
  function updateBadge() {
    if (!root) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'snipbadge';
      badge.hidden = true;
      root.querySelector('.root').appendChild(badge);
    }
    const el = editableRoot(document.activeElement);
    const toks = el && !(host && host.contains(el)) && !isTextField(el) ? scanTokens(el) : [];
    if (!toks.length) { badge.hidden = true; return; }
    const known = [...new Set(toks.filter((t) => t.known).map((t) => t.name))];
    const unknown = [...new Set(toks.filter((t) => !t.known).map((t) => t.name))];
    const text = (el.innerText || '').replace(/\n+$/, '');
    const expanded = expandSnippets(text);
    // 작게: 칸 오른쪽 위 테두리에 걸치는 꼬리표 (아래 칸을 안 가리게). 자세한 건 마우스를 올리면
    badge.className = 'snipbadge' + (unknown.length ? ' warn' : '');
    badge.innerHTML = `${icon('at')}<span>${known.length}${unknown.length ? ` · <b>?${unknown.length}</b>` : ''}</span>`;
    badge.dataset.tip = (known.length ? (S.snipExpand ? `생성 버튼을 누르면 펼쳐져서 보내져요.\n\n${expanded.length > 600 ? expanded.slice(0, 600) + '…' : expanded}` : '펼치기가 꺼져 있어요 (치환 탭)') : '')
      + (unknown.length ? `${known.length ? '\n\n' : ''}없는 이름: ${unknown.map((n) => TG() + n).join(' ')}` : '');
    const r = el.getBoundingClientRect();
    badge.hidden = false;
    const w = badge.offsetWidth;
    badge.style.left = Math.max(8, Math.min(r.right - w - 10, innerWidth - w - 8)) + 'px';
    badge.style.top = Math.max(4, r.top - 9) + 'px';
  }
  const hlSchedule = () => { clearTimeout(hlTimer); hlTimer = setTimeout(refreshHighlights, 120); };
  document.addEventListener('input', hlSchedule, true);
  document.addEventListener('focusin', hlSchedule, true);
  document.addEventListener('focusout', () => setTimeout(updateBadge, 0), true);
  window.addEventListener('resize', hlSchedule);
  window.addEventListener('scroll', () => { if (badge && !badge.hidden) updateBadge(); }, true);
  setInterval(() => { if (!document.hidden) refreshHighlights(); }, 2000); // NovelAI 가 칸 내용을 직접 바꿨을 때 대비

  /* ---------- 생성 버튼을 누르는 순간: 칸에서 잠깐 펼쳤다가 되돌림 ----------
     NovelAI 요청 형식이 바뀌어도(V5 등) 칸 내용을 그대로 읽어 가니 확실하게 펼쳐짐 */
  let fieldRestore = null, restoreTimer = 0, lastGen = null;
  function scanTokensText(text) {
    const out = [], re = snipRe();
    let m;
    while ((m = re.exec(text))) {
      let n = m[1];
      while (!(n in snippets) && /[.\-]$/.test(n)) n = n.slice(0, -1);
      if (n in snippets) out.push(n);
    }
    return out;
  }
  const hasKnownTokens = () => editorRoots().some((el) => scanTokens(el).some((t) => t.known));
  function genButtonOf(node) {
    const b = node && node.closest && node.closest('button, [role="button"]');
    if (!b || (host && host.contains(b))) return null;
    return /generate|생성/i.test(b.textContent || '') ? b : null;
  }
  function findGenButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find((b) => b.offsetParent !== null && /^\s*generate/i.test(b.textContent || ''))
      || [...document.querySelectorAll('button, [role="button"]')].find((b) => b.offsetParent !== null && /generate|생성/i.test(b.textContent || ''));
  }
  function expandFieldsForGenerate() {
    if (!S.snipExpand || !Object.keys(snippets).length || fieldRestore) return false;
    const used = new Set(), changed = [];
    const active = document.activeElement;
    for (const el of editorRoots()) {
      if (!scanTokens(el).some((t) => t.known)) continue;
      const applied = expandTokensInPlace(el, used); // 치환어 자리만 — 청크는 그대로
      if (applied.length) changed.push({ el, applied });
    }
    try { if (active && active.focus) active.focus(); } catch (e) { /* noop */ }
    if (!changed.length) return false;
    fieldRestore = changed;
    window.postMessage({ __naiStudio: 1, from: 'panel', type: 'fieldExpanded', names: [...used] }, location.origin);
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(restoreFields, 6000); // 요청을 못 봤어도 결국 되돌림
    return true;
  }
  function restoreFields() {
    clearTimeout(restoreTimer);
    if (!fieldRestore) return;
    const list = fieldRestore;
    fieldRestore = null;
    const active = document.activeElement;
    for (const { el, applied } of list) if (el.isConnected) collapseInPlace(el, applied);
    try { if (active && active.focus) active.focus(); } catch (e) { /* noop */ }
    hlSchedule();
  }
  // 마우스: 버튼을 누르는 순간(click 보다 먼저) 펼쳐 둠
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isTrusted) return;
    if (genButtonOf(e.composedPath()[0]) && hasKnownTokens()) expandFieldsForGenerate();
  }, true);
  // 키보드: Ctrl+Enter 생성 → 펼친 뒤 생성 버튼을 대신 눌러 줌
  function onGenKey(e) {
    if (e.__naiSkip || !(e.ctrlKey || e.metaKey) || e.altKey || e.key !== 'Enter' || e.isComposing) return false;
    if (host && e.composedPath().includes(host)) return false;
    if (!editableRoot(document.activeElement) || !S.snipExpand || !hasKnownTokens()) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    expandFieldsForGenerate();
    setTimeout(() => {
      const b = findGenButton();
      if (b) { b.click(); return; }
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
      ev.__naiSkip = true;
      (document.activeElement || document.body).dispatchEvent(ev);
    }, 120);
    return true;
  }

  function copyText(text, silent) {
    navigator.clipboard.writeText(text).then(
      () => { if (!silent) toast('복사했어요', 'ok', 1200); },
      () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.documentElement.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        if (!silent) toast('복사했어요', 'ok', 1200);
      }
    );
  }

  /* ------------------------------------------------------------------ *
   * 생성 감지 → 기록 · 자동 저장
   * ------------------------------------------------------------------ */
  const R = { items: [] }; // 이번 세션에 잡힌 이미지
  let sessionSaved = 0;

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__naiStudio !== 1 || d.from !== 'hook') return;
    if (d.type === 'gen') {
      const r = await send({ type: 'gen', meta: d.meta });
      if (!r.ok && r.error === 'invalidated') deadToast();
    } else if (d.type === 'img') {
      const blob = new Blob([d.buf], { type: 'image/' + d.kind });
      const it = { id: uid(), blob, url: URL.createObjectURL(blob), w: d.w, h: d.h, kind: d.kind, hash: d.hash, meta: d.meta, n: d.n, t: d.t, status: 'idle', path: '', via: '' };
      R.items.unshift(it);
      while (R.items.length > 40) URL.revokeObjectURL(R.items.pop().url);
      if (d.auto && S.autoSave) await saveItem(it, false);
      else if (d.auto) showSavePill(it);
      refreshTab('recent');
    } else if (d.type === 'expanded') {
      toast(`치환해서 생성 · ${d.names.map((n) => TG() + n).join(' ')}`, 'ok', 1800);
    } else if (d.type === 'genSeen') {
      lastGen = d;
      // 칸에서 펼쳤던 거면: 알림 + NovelAI 가 다 읽어 갔으니 원래대로
      if (fieldRestore) {
        const names = [...new Set(fieldRestore.flatMap(({ applied }) => applied.flatMap(({ token }) => scanTokensText(token))))];
        toast(`치환해서 생성 · ${names.map((n) => TG() + n).join(' ')}`, 'ok', 1800);
        setTimeout(restoreFields, 400);
      }
    } else if (d.type === 'scanDone') {
      toast(d.found ? `화면에서 ${d.found}장 확인했어요` : '화면에서 가져올 이미지를 못 찾았어요', 'info');
      refreshTab('recent');
    }
  });

  async function saveItem(it, force, pick) {
    it.status = 'saving';
    refreshTab('recent');
    const dataUrl = await blobToDataURL(it.blob);
    decorateBars();
    const r = await send(Object.assign({ type: 'save', dataUrl, kind: it.kind, meta: it.meta, t: it.t, n: it.n, w: it.w, h: it.h, hash: it.hash, force }, pick || {}));
    if (r.ok) {
      it.status = 'saved';
      it.path = r.path || '';
      it.via = r.via || '';
      if (!r.dup) {
        sessionSaved++;
        updateChrome();
        if (r.via === 'folder') { libDirty = true; toast(`저장됨 · ${folder.name || '폴더'}/${r.path}`, 'ok', 2200); }
        else if (r.fallbackReason === 'perm') toast('폴더 권한이 꺼져 있어서 다운로드 폴더에 저장했어요. 툴바 아이콘을 눌러 다시 허용해 주세요', 'err', 4500);
        else toast(`다운로드 폴더에 저장 · ${r.path}`, 'ok', 2200);
      }
    } else {
      it.status = 'fail';
      if (r.error === 'invalidated') deadToast();
      else toast('저장 실패: ' + (r.error || r.reason || '알 수 없음'), 'err');
    }
    decorateBars();
    refreshTab('recent');
  }

  // 자동 저장이 꺼져 있을 때: 새 그림이 오면 NovelAI 도구 줄의 우리 버튼에 금색 테두리, 플로팅 별 버튼엔 작은 금색 점
  function showSavePill(it) {
    pendingIt = it;
    decorateBars();
  }
  function hideSavePill() {
    if (pendingIt) pendingIt = null;
    decorateBars();
  }

  /* ---------- NovelAI 도구 줄(핀 · 클립보드 · 저장) 끝에 우리 저장 버튼 ----------
   * 1) 오른쪽 아래 도구 줄: 클래스 이름이 없어서 아이콘 파일로 찾음 (핀 · 클립보드 · 저장 중 2개 이상 있는 묶음)
   * 2) 그림 위에 마우스를 올리면 나오는 줄 (.image-gen-save-bar, 여러 장 보기 등) */
  const BAR_SEL = '.image-gen-save-bar';
  const TOOL_ICONS = ['8a391c7b.svg', '579cb9e6.svg', '36b86afc.svg'];
  let pendingIt = null;
  let toolGroups = [];
  const BAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="m9 13 3 3 3-3"/></svg>';
  const iconFile = (d) => { const cs = getComputedStyle(d); return ((cs.maskImage || cs.webkitMaskImage || '').match(/[\w-]+\.svg/) || [''])[0]; };
  function findToolGroups() {
    if (toolGroups.length && toolGroups.every((g) => g.isConnected)) return toolGroups;
    const hits = new Map();
    document.querySelectorAll('button > div').forEach((d) => {
      if (!TOOL_ICONS.includes(iconFile(d))) return;
      const g = d.parentElement.parentElement && d.parentElement.parentElement.parentElement;
      if (g) hits.set(g, (hits.get(g) || 0) + 1);
    });
    toolGroups = [...hits].filter(([, n]) => n >= 2).map(([g]) => g);
    return toolGroups;
  }
  function makeBarButton(like, wrapLike, onClick) {
    const b = like ? like.cloneNode(false) : document.createElement('button');
    b.removeAttribute('disabled');
    b.removeAttribute('aria-label');
    b.type = 'button';
    b.classList.add('nais-save');
    b.title = 'NAI Folio · 폴더 · 이름 정해서 저장 (Alt+S)';
    b.innerHTML = BAR_ICON;
    b.style.color = '#e9c46a';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    if (!wrapLike) return b;
    const w = wrapLike.cloneNode(false);
    w.classList.add('nais-save-wrap');
    w.appendChild(b);
    return w;
  }
  function decorateBars() {
    const pending = !!(pendingIt && pendingIt.status !== 'saved' && pendingIt.status !== 'saving');
    for (const g of findToolGroups()) {
      if (g.querySelector('.nais-save')) continue;
      const wrap0 = [...g.children].find((c) => c.querySelector('button'));
      if (!wrap0) continue;
      g.appendChild(makeBarButton(wrap0.querySelector('button'), wrap0, () => saveFromImg(mainImage())));
    }
    document.querySelectorAll(BAR_SEL).forEach((bar) => {
      if (bar.querySelector(':scope > .nais-save')) return;
      const ref = [...bar.querySelectorAll('button')].pop();
      bar.appendChild(makeBarButton(ref, null, () => saveFromImg(imageNear(bar))));
    });
    document.querySelectorAll('.nais-save').forEach((b) => { b.style.boxShadow = pending ? 'inset 0 0 0 1.5px #e9c46a' : ''; });
    if (fab) fab.classList.toggle('unsaved', pending);
  }
  const genImgs = (root) => [...root.querySelectorAll('img')].filter((i) => /^(blob|data):/.test(i.src) && i.naturalWidth >= 256);
  // 가운데 크게 떠 있는 그림 (화면에 그려진 크기가 제일 큰 것)
  function mainImage() {
    const area = (i) => { const r = i.getBoundingClientRect(); return r.width * r.height; };
    return genImgs(document).sort((a, b) => area(b) - area(a))[0] || null;
  }
  // 마우스를 올린 그림의 줄이면 그 그림
  function imageNear(bar) {
    for (let el = bar.parentElement, k = 0; el && k < 8; el = el.parentElement, k++) {
      const imgs = genImgs(el);
      if (imgs.length) return imgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    }
    return mainImage();
  }
  async function saveFromImg(img) {
    if (!img) return openSaveSheet(R.items[0]);
    let blob = null;
    try { blob = await (await fetch(img.src)).blob(); } catch (e) {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      } catch (err) { /* 못 읽음 */ }
    }
    if (!blob) return openSaveSheet(R.items[0]);
    // 이번 접속에서 잡은 그림이면 그 기록(프롬프트 · 시드)을 그대로 씀
    let it = R.items.find((x) => x.blob.size === blob.size);
    if (!it) {
      const kind = /webp/.test(blob.type) ? 'webp' : /jpe?g/.test(blob.type) ? 'jpeg' : 'png';
      it = { id: uid(), blob, url: URL.createObjectURL(blob), w: img.naturalWidth, h: img.naturalHeight, kind, hash: '', meta: null, n: 1, t: Date.now(), status: 'idle', path: '', via: '' };
      R.items.unshift(it);
    }
    openSaveSheet(it);
  }
  // 화면이 바뀔 때마다 (너무 자주는 말고) 다시 붙이기
  let barTimer = 0;
  new MutationObserver(() => {
    if (barTimer) return;
    barTimer = setTimeout(() => { barTimer = 0; if (document.body) decorateBars(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- 골라서 저장 (폴더 · 이름 · 형식 정하기) ---------- */
  let lastPickDir = null;
  try { lastPickDir = sessionStorage.getItem('nai-studio-pickdir'); } catch (e) { /* 없음 */ }
  const FMT = { jpeg: ['JPG', 'jpg'], png: ['PNG', 'png'], webp: ['WebP', 'webp'] };
  async function openSaveSheet(it) {
    if (!it) { toast('아직 이번 접속에서 생성한 그림이 없어요', 'info'); return; }
    if (!UI.open) togglePanel(true);
    const pnl = root.querySelector('.panel');
    pnl.querySelectorAll('.viewer').forEach((v) => v.remove());
    const v = document.createElement('div');
    v.className = 'viewer savesheet';
    v.innerHTML = `<div class="vh"><span class="grow nm">골라서 저장</span><button class="ib" data-s="close" title="닫기 (Esc)">${icon('x')}</button></div><div class="vb"><div class="empty">불러오는 중…</div></div>`;
    pnl.appendChild(v);
    let mode = S.saveMode === 'convert' ? 'convert' : 'original';
    const tg = await send({ type: 'saveTarget', kind: it.kind, meta: it.meta, t: it.t, n: it.n, w: it.w, h: it.h, hash: it.hash, mode, fresh: true });
    if (!tg.ok) { v.remove(); toast('저장 위치를 못 읽었어요', 'err'); return; }
    const conv = FMT[S.convFormat] || (S.convFormat === 'original' ? FMT[it.kind] : FMT.webp);
    const extOf = () => '.' + (mode === 'convert' ? conv[1] : FMT[it.kind] ? FMT[it.kind][1] : 'png');
    const base = tg.folder ? tg.folder + '/' : `다운로드/${tg.dlFolder || 'NovelAI'}/`;
    const dirs = tg.dirs || [];
    const startDir = lastPickDir != null ? lastPickDir : tg.subdir;
    v.querySelector('.vb').innerHTML = `<img class="vimg" src="${it.url}" alt="" style="max-height:210px;object-fit:contain">
      <div class="lbl" style="margin-top:12px">폴더 ${tip('비우면 맨 위에 저장해요. 없는 폴더는 새로 만들어요. / 로 나누면 폴더 안의 폴더')}<span class="grow"></span><button class="btn sm" data-s="newdir" title="지금 폴더 안에 새 폴더 만들기">${icon('plus')} 새 폴더</button></div>
      <div class="pathin"><span>${esc(base)}</span><input class="in" data-s="dir" value="${esc(startDir)}" placeholder="(맨 위)" spellcheck="false"></div>
      <div class="newhint" data-s="newhint" hidden></div>
      <div class="dchips" data-s="chips"></div>
      <div class="lbl" style="margin-top:10px">파일 이름</div>
      <div class="pathin"><input class="in" data-s="name" value="${esc(tg.name)}" spellcheck="false"><span data-s="ext">${extOf()}</span></div>
      <div class="lbl" style="margin-top:10px">형식</div>
      <div class="seg" data-s="mode"><button data-m="original" class="${mode === 'original' ? 'on' : ''}">원본 그대로</button><button data-m="convert" class="${mode === 'convert' ? 'on' : ''}">메타 제거 ${conv[0]}</button></div>`;
    const foot = document.createElement('div');
    foot.className = 'vf';
    foot.innerHTML = `<button class="btn sm" data-s="default" title="설정의 폴더 나누기 · 파일 이름 규칙으로">규칙대로</button><span class="grow"></span><button class="btn pri" data-s="save">${icon('download')} 저장 <kbd>Enter</kbd></button>`;
    v.appendChild(foot);
    const dirIn = v.querySelector('[data-s="dir"]'), nameIn = v.querySelector('[data-s="name"]'), chips = v.querySelector('[data-s="chips"]');
    let typed = false;
    const drawChips = () => {
      const q = typed ? dirIn.value.trim().toLowerCase() : '';
      const list = [...new Set([tg.subdir, lastPickDir, ...dirs].filter((d) => d != null && d !== ''))]
        .filter((d) => !q || d.toLowerCase().includes(q) && d.toLowerCase() !== q).slice(0, 12);
      chips.innerHTML = list.map((d) => `<button data-dir="${esc(d)}" title="${esc(d)}">${icon('folder')}${esc(d)}${d === tg.subdir ? ' <small>규칙</small>' : d === lastPickDir ? ' <small>지난번</small>' : ''}</button>`).join('');
    };
    // 아직 없는 폴더면 '새로 만들어요' 표시
    const hint = v.querySelector('[data-s="newhint"]');
    const updHint = () => {
      const d = dirIn.value.trim().replace(/^\/+|\/+$/g, '');
      const isNew = !!d && !dirs.includes(d);
      hint.hidden = !isNew;
      if (isNew) hint.innerHTML = `${icon('folder')} 새 폴더로 만들어요 · <b>${esc(d)}</b>`;
    };
    drawChips();
    updHint();
    nameIn.focus();
    nameIn.select();
    const doSave = async () => {
      const subdir = dirIn.value.trim().replace(/^\/+|\/+$/g, '');
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); return; }
      lastPickDir = subdir;
      try { sessionStorage.setItem('nai-studio-pickdir', subdir); } catch (e) { /* 없음 */ }
      v.remove();
      await saveItem(it, true, { subdir, name, mode });
    };
    dirIn.addEventListener('input', () => { typed = true; drawChips(); updHint(); });
    v.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); v.remove(); }
      else if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT') { e.preventDefault(); doSave(); }
    });
    v.addEventListener('click', (e) => {
      const c = e.target.closest('[data-dir]');
      if (c) { dirIn.value = c.dataset.dir; updHint(); nameIn.focus(); return; }
      const m = e.target.closest('[data-m]');
      if (m) {
        mode = m.dataset.m;
        v.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === m));
        v.querySelector('[data-s="ext"]').textContent = extOf();
        return;
      }
      const b = e.target.closest('[data-s]');
      if (!b) return;
      if (b.dataset.s === 'close') v.remove();
      else if (b.dataset.s === 'save') doSave();
      else if (b.dataset.s === 'default') { dirIn.value = tg.subdir; nameIn.value = tg.name; drawChips(); updHint(); }
      else if (b.dataset.s === 'newdir') {
        // 지금 칸에 있는 폴더 안에 새 이름을 바로 이어 쓸 수 있게
        const cur = dirIn.value.trim().replace(/\/+$/, '');
        dirIn.value = cur ? cur + '/' : '';
        dirIn.placeholder = '새 폴더 이름';
        typed = true;
        drawChips();
        updHint();
        dirIn.focus();
        dirIn.setSelectionRange(dirIn.value.length, dirIn.value.length);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 프롬프트 칸 다루기
   * ------------------------------------------------------------------ */
  let lastEditable = null;
  function editableRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '')) return el;
    if (el.isContentEditable) {
      let r = el;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return r;
    }
    return null;
  }
  document.addEventListener('focusin', (e) => {
    const path = e.composedPath();
    if (host && path.includes(host)) return;
    const r = editableRoot(path[0]);
    if (r) { lastEditable = r; if (UI.open && UI.tab === 'translate') updateTargetLabel(); }
  }, true);
  const findPromptTarget = () => (lastEditable && lastEditable.isConnected ? lastEditable : document.querySelector('.ProseMirror[contenteditable="true"]') || document.querySelector('[contenteditable="true"]'));
  const isTextField = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  function selectNodeContents(el, collapseEnd) {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (collapseEnd) r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function execInsert(el, text) {
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (ok) return true;
    if (isTextField(el)) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const v = el.value, a = el.selectionStart, b = el.selectionEnd;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v.slice(0, a) + text + v.slice(b));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }
  function insertIntoPage(text, mode) {
    const el = findPromptTarget();
    if (!el) { toast('NovelAI 프롬프트 칸을 한 번 클릭한 뒤 다시 눌러 주세요', 'err'); return; }
    el.focus();
    const tf = isTextField(el);
    const cur = tf ? el.value : el.innerText || '';
    if (mode === 'replace') {
      if (tf) el.select(); else selectNodeContents(el, false);
    } else {
      if (tf) el.setSelectionRange(el.value.length, el.value.length); else selectNodeContents(el, true);
      const trimmed = cur.replace(/\s+$/, '');
      if (trimmed && !/,$/.test(trimmed)) text = ', ' + text;
      else if (trimmed && !/\s$/.test(cur)) text = ' ' + text;
    }
    if (execInsert(el, text)) toast(mode === 'replace' ? '프롬프트를 교체했어요' : '프롬프트 끝에 추가했어요', 'ok');
    else { copyText(text, true); toast('직접 넣기 실패 → 클립보드에 복사했어요 (Ctrl+V)', 'err'); }
  }
  async function inlineTranslate(all) {
    let el = editableRoot(document.activeElement);
    if (!el && all) el = findPromptTarget();
    if (!el) { toast('프롬프트 칸에서 한글을 드래그하고 Alt+Q 를 눌러 주세요', 'info'); return; }
    const tf = isTextField(el);
    // 칸 전체 번역: 글자 조각마다 따로 → 청크 블록은 건드리지 않음
    if (all && !tf) {
      const todo = textNodesOf(el).map((n) => n.nodeValue).filter((t) => HANGUL.test(t) && t.trim());
      if (!todo.length) { toast('한글이 없어서 번역할 게 없어요', 'info'); return; }
      toast('번역 중…', 'info', 900);
      let jobs = 0;
      for (const src of todo) {
        const res = await send({ type: 'translate', text: src });
        if (!res.ok) { toast(res.error === 'invalidated' ? '확장 프로그램이 업데이트됐어요. 새로고침해 주세요' : '번역 실패: ' + res.error, 'err'); return; }
        const node = textNodesOf(el).find((n) => n.nodeValue === src);
        if (node && res.r.output !== src) { replaceText(el, node, 0, src.length, res.r.output); jobs += res.r.jobs.length; }
      }
      toast(`번역 완료 · ${jobs}개 조각`, 'ok');
      return;
    }
    let text, range = null, ss = 0, se = 0;
    if (all) text = el.value.replace(/\n+$/, '');
    else if (tf) { ss = el.selectionStart; se = el.selectionEnd; text = el.value.slice(ss, se); }
    else {
      const sel = window.getSelection();
      text = String(sel);
      if (sel.rangeCount) range = sel.getRangeAt(0).cloneRange();
    }
    if (!text.trim()) { toast(all ? '칸이 비어 있어요' : '번역할 부분을 드래그해서 선택해 주세요', 'info'); return; }
    if (!HANGUL.test(text)) { toast('한글이 없어서 번역할 게 없어요', 'info'); return; }
    toast('번역 중…', 'info', 900);
    const res = await send({ type: 'translate', text });
    if (!res.ok) { toast(res.error === 'invalidated' ? '확장 프로그램이 업데이트됐어요. 새로고침해 주세요' : '번역 실패: ' + res.error, 'err'); return; }
    el.focus();
    if (all) { if (tf) el.select(); else selectNodeContents(el, false); }
    else if (tf) el.setSelectionRange(ss, se);
    else if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
    if (!execInsert(el, res.r.output)) { copyText(res.r.output, true); toast('직접 넣기 실패 → 클립보드에 복사했어요', 'err'); }
    else toast(`번역 완료 · ${res.r.jobs.length}개 조각`, 'ok');
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const ICONS = {
    sparkle: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    replace: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  };
  const icon = (n, fill) => `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{--paper:#f4efe4;--paper-dk:#ebe4d4;--panel:#fbf8f1;--hover:#e9e1d0;--line:#e0d7c5;--line2:#cbbfa8;--fg:#2b2925;--mut:#645d52;--dim:#9a9182;--acc: #33598e;--acc-bg: rgba(51,89,142,.08);--bad-bg: rgba(184,67,47,.07);--bad-line: rgba(184,67,47,.45);--neg: #8a6a34;--acc-line: rgba(51,89,142,.42);--ok:#4c7a48;--bad:#b8432f;--on:#fbf8f1;--tape:rgba(222,199,128,.62);--note:#f7e9a6;--rule:rgba(160,140,105,.14);--sheet:#fffdf8;--sheet-a:rgba(255,253,248,.92);--wash:rgba(255,255,255,.45);--pri-hover:#3a3732;--on-line:rgba(251,248,241,.35);--margin:rgba(51,89,142,.2);--backdrop:rgba(236,229,214,.97);--blue:#4a5f86;--note-fg:#3b3524;--note-ic:#8a7b4a;--note-err:#f6d5c8;--scroll:#cfc4af;
  --serif:"Gowun Batang","Nanum Myeongjo","Noto Serif KR",Batang,"바탕",serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;font-size:13px;line-height:1.5;color:var(--fg);color-scheme:light;-webkit-font-smoothing:antialiased}
.root.dark{--paper:#1c1a17;--paper-dk:#161512;--panel:#23211d;--panel2:#29261f;--hover:#302d26;--line:#36322b;--line2:#4b463c;--fg:#ebe4d4;--mut:#b3aa96;--dim:#7f7766;--acc:#8fb0e3;--acc-bg:rgba(143,176,227,.1);--acc-line:rgba(143,176,227,.5);--bad-bg:rgba(226,126,100,.1);--bad-line:rgba(226,126,100,.55);--neg:#cfae6e;--ok:#93c08a;--bad:#e27e64;--on:#1c1a17;--tape:rgba(196,172,104,.34);--note:#d8c673;--rule:rgba(235,228,212,.055);--sheet:#2a2722;--sheet-a:rgba(42,39,34,.94);--wash:rgba(255,255,255,.04);--pri-hover:#fff8ea;--on-line:rgba(28,26,23,.3);--margin:rgba(143,176,227,.22);--backdrop:rgba(18,17,15,.97);--blue:#8ea3cc;--note-fg:#2a2618;--note-ic:#5d5330;--note-err:#e3a594;--scroll:#4b463c;color-scheme:dark}
button,input,select,textarea{font-family:inherit}
svg{stroke-width:1.8}
.fab{all:unset;position:fixed;right:22px;bottom:22px;z-index:2147483600;width:44px;height:44px;display:grid;place-items:center;cursor:pointer;color:var(--acc);touch-action:none;background:var(--panel);border:1.5px solid var(--fg);box-shadow:3px 3px 0 var(--fg);transform:rotate(-3deg);transition:transform .15s,box-shadow .15s}
.fab::before{content:"";position:absolute;top:-8px;left:50%;width:30px;height:12px;background:var(--tape);transform:translateX(-50%) rotate(6deg)}
.fab:hover{transform:rotate(0) translate(-1px,-1px);box-shadow:4px 4px 0 var(--fg)}
.fab.open{transform:rotate(0) translate(2px,2px);box-shadow:1px 1px 0 var(--fg)}
.fab svg{width:20px;height:20px}
.fab .badge{position:absolute;top:-9px;right:-10px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--panel);color:var(--acc);border:1.5px solid var(--acc);font:700 11px/17px "IBM Plex Mono",Consolas,monospace;text-align:center;display:none;transform:rotate(8deg)}
.fab .dot{position:absolute;bottom:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--ok);display:none}
.fab .dot.warn{background:var(--bad)}
.panel{position:fixed;right:22px;bottom:80px;z-index:2147483601;width:410px;max-width:calc(100vw - 24px);height:min(620px,calc(100vh - 104px));display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line2);box-shadow:0 2px 4px rgba(60,40,10,.2),0 26px 50px -18px rgba(0,0,0,.55);animation:fade .15s}
.panel::before{content:"";position:absolute;z-index:3;top:-9px;left:50%;width:84px;height:18px;background:var(--tape);transform:translateX(-50%) rotate(-2deg);pointer-events:none}
.panel[hidden]{display:none}
@keyframes fade{from{opacity:0}}
.hd{display:flex;align-items:center;gap:9px;padding:14px 8px 11px 16px;cursor:move;user-select:none;border-bottom:1.5px solid var(--line2)}
.logo{width:24px;height:24px;display:grid;place-items:center;color:var(--acc);border:1.5px solid var(--acc);transform:rotate(-5deg)}
.logo svg{width:12px;height:12px}
.ttl{font-family:var(--serif);font-weight:700;font-size:15.5px;line-height:1.2}
.sub{font-size:11.5px;color:var(--mut);font-family:var(--serif);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grow{flex:1;min-width:0}
.ac{position:fixed;z-index:2147483603;width:340px;max-width:calc(100vw - 16px);padding:4px;background:var(--panel);border:1px solid var(--line2);box-shadow:0 2px 3px rgba(60,40,10,.18),0 14px 30px -12px rgba(0,0,0,.5);font-family:"Pretendard Variable",Pretendard,"Malgun Gothic",system-ui,sans-serif}
.ac[hidden]{display:none}
.aci{display:flex;flex-direction:column;gap:1px;padding:6px 9px;cursor:pointer;border-left:2px solid transparent}
.aci b{color:var(--fg);font-size:13px;font-family:var(--serif)}
.aci span{font-family:var(--mono);font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aci.on,.aci:hover{background:var(--paper);border-left-color:var(--acc)}
.aci.on b{color:var(--acc)}
.acf{font-size:11px;color:var(--dim);padding:6px 9px 3px;border-top:1px dashed var(--line2);margin-top:3px;font-family:var(--serif);font-style:italic}
.snt{display:inline-flex;align-items:center;height:32px;padding:0 2px 0 6px;color:var(--acc);font-weight:700;font-size:16px;font-family:var(--serif)}
.tabs{display:flex;gap:1px;padding:8px 10px 0;border-bottom:1px solid var(--line2);background:var(--paper-dk)}
.tab{all:unset;cursor:pointer;display:flex;align-items:center;gap:5px;padding:6px 8px;color:var(--mut);font-size:12.5px;font-family:var(--serif);border:1px solid transparent;border-bottom:0;border-radius:3px 3px 0 0;margin-bottom:-1px;position:relative;white-space:nowrap}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--fg);background:var(--panel);border-color:var(--line2);font-weight:700}
.tab svg{width:13px;height:13px}
.tab.on svg{color:var(--acc)}
.tab .nb{font-family:var(--mono);font-size:10px;color:var(--acc)}
.bd{flex:1;overflow-y:auto;padding:14px 14px 20px 26px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin;scrollbar-color:var(--scroll) transparent;
  background-image:linear-gradient(90deg,transparent 15px,var(--margin) 15px,var(--margin) 16px,transparent 16px),repeating-linear-gradient(transparent 0 25px,var(--rule) 25px 26px);background-attachment:local}
.bd>div:empty{display:none}
.card{background:var(--sheet);border:1px solid var(--line);padding:12px;box-shadow:0 1px 2px rgba(80,60,20,.07)}
.lbl{display:flex;align-items:center;gap:6px;font-family:var(--serif);font-size:13px;font-weight:700;color:var(--mut);margin-bottom:8px}
.ta,.in{width:100%;background:var(--sheet);border:1px solid var(--line2);border-radius:2px;color:var(--fg);font-size:13px;outline:none}
.ta{min-height:92px;resize:vertical;padding:4px 10px;line-height:26px;background-image:repeating-linear-gradient(var(--sheet) 0 25px,var(--line) 25px 26px);background-attachment:local}
.ta.out{min-height:70px;font-family:var(--mono);font-size:12.5px}
.in{height:32px;padding:0 10px}
.ta:focus,.in:focus{border-color:var(--fg)}
.ta::placeholder,.in::placeholder{color:var(--dim);font-style:italic}
.row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ta+.row{margin-top:8px}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border-radius:3px;font-size:12.5px;color:var(--fg);background:var(--panel);border:1px solid var(--line2);white-space:nowrap}
.btn:hover{background:var(--sheet);border-color:var(--mut)}
.btn:active{transform:translateY(1px)}
.btn.pri{color:var(--on);background:var(--fg);border-color:var(--fg);box-shadow:2px 2px 0 var(--acc-line)}
.btn.pri:hover{background:var(--pri-hover)}
.btn.wide{width:100%;height:34px}
.btn.danger{color:var(--bad);border-color:var(--bad-line)}
.btn[disabled]{opacity:.4;pointer-events:none}
.btn svg{width:14px;height:14px}
.btn.sm{height:26px;padding:0 8px;font-size:12px}
.btn.sm svg{width:13px;height:13px}
kbd{font:500 10.5px/1 var(--mono);padding:2px 5px;border-radius:2px;background:var(--panel);border:1px solid var(--line2);border-bottom-width:2px;color:var(--mut)}
.btn.pri kbd{background:transparent;border-color:var(--on-line);color:var(--on)}
.ib{all:unset;cursor:pointer;width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:3px;color:var(--dim)}
.ib:hover{background:var(--hover);color:var(--fg)}
.ib svg{width:15px;height:15px}
.ib.on{color:var(--acc)}
.ib.del:hover{color:var(--bad)}
.sw{position:relative;width:34px;height:19px;flex:none;display:inline-block}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.sw span{position:absolute;inset:0;border-radius:10px;border:1.5px solid var(--mut);background:var(--panel)}
.sw span::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--mut);transition:transform .15s,background .15s}
.sw input:checked+span{background:var(--fg);border-color:var(--fg)}
.sw input:checked+span::after{transform:translateX(15px);background:var(--on)}
.mini{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--mut);cursor:pointer;font-family:var(--serif)}
.seg{display:inline-flex;background:var(--panel);border:1px solid var(--line2);border-radius:3px;overflow:hidden}
.seg button{all:unset;cursor:pointer;padding:3px 9px;font-size:12px;color:var(--mut);border-right:1px solid var(--line)}
.seg button:last-child{border-right:0}
.seg button:hover{color:var(--fg);background:var(--sheet)}
.seg button.on{background:var(--fg);color:var(--on)}
.chips{display:flex;flex-direction:column;gap:5px}
.chip{display:flex;align-items:center;gap:8px;padding:2px 3px 2px 10px;background:var(--sheet);border:1px solid var(--line)}
.chip .src{flex:0 1 38%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--serif)}
.chip .arr{color:var(--dim);flex:none}.chip .arr svg{width:12px;height:12px;display:block}
.chip input{all:unset;flex:1;min-width:0;padding:5px 7px;color:var(--acc);font-family:var(--mono);font-size:12px;border-bottom:1px dashed transparent}
.chip input:focus{border-bottom-color:var(--acc-line)}
.k{font-size:10.5px;padding:0 5px;border-radius:2px;flex:none;border:1px solid currentColor;color:var(--mut);line-height:16px}
.k.dict{color:var(--ok)}.k.cache{color:var(--mut)}.k.mt{color:var(--dim)}
.k.gen{color:var(--acc);transform:rotate(-2deg)}.k.tr{color:var(--blue)}
.tip{font-size:12.5px;color:var(--mut);padding:2px 0 2px 12px;border-left:2px solid var(--acc-line);line-height:1.7;font-family:var(--serif)}
.tip b{color:var(--fg)}
.search{position:relative}
.search svg{position:absolute;left:10px;top:50%;width:14px;height:14px;transform:translateY(-50%);color:var(--dim)}
.search .in{padding-left:31px}
.list{display:flex;flex-direction:column;gap:8px}
.hi{padding:10px 12px;background:var(--sheet);border:1px solid var(--line);box-shadow:0 1px 2px rgba(80,60,20,.06)}
.hi.fav{border-left:2px solid var(--acc)}
.hi-top{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.hi-top .time{font-size:12px;color:var(--mut);font-family:var(--serif);font-style:italic}
.hi-top .meta{font-size:11px;color:var(--dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.txt{font-family:var(--mono);font-size:12px;color:var(--fg);word-break:break-word;white-space:pre-wrap;cursor:pointer;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.txt.open{display:block}
.txt.sm{font-size:11.5px;color:var(--mut);-webkit-line-clamp:2;margin-top:4px}
.txt .lab{color:var(--dim);font-family:var(--serif);font-style:italic}
.hi-act{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}
.sect{border-left:2px solid var(--line2);padding:1px 0 2px 8px;margin-top:6px}
.sect .sh{display:flex;align-items:center;justify-content:space-between;font-family:var(--serif);font-size:11.5px;font-weight:700;color:var(--mut);height:20px}
.sect .sh .ib{width:20px;height:20px}.sect .sh .ib svg{width:12px;height:12px}
.sect.base{--bc:var(--c-base)}.sect.char{--bc:var(--c-char)}.sect.neg{--bc:var(--c-neg)}
.sect.base,.sect.char,.sect.neg{border-left-color:var(--bc)}.sect.base .sh span,.sect.char .sh span,.sect.neg .sh span{color:var(--bc)}
.viewer .sect .txt{color:var(--bc)}
.empty{text-align:center;color:var(--mut);padding:30px 10px;font-size:13px;line-height:1.8;font-family:var(--serif)}
.empty svg{width:26px;height:26px;color:var(--dim);display:block;margin:0 auto 10px;stroke-width:1.5}
.hero{display:flex;align-items:center;gap:11px;padding:11px 12px;background:var(--sheet);border:1px solid var(--line);box-shadow:0 1px 2px rgba(80,60,20,.07)}
.hero .ic{color:var(--acc);flex:none}
.hero .ic svg{width:18px;height:18px}
.hero .t1{font-family:var(--serif);font-weight:700;font-size:14px}
.hero .t2{font-size:12px;color:var(--mut);margin-top:1px;overflow:hidden;text-overflow:ellipsis}
.hero.warn{border:1px dashed var(--bad)}.hero.warn .ic{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 10px;padding-top:4px}
.gi{position:relative;aspect-ratio:3/4.15;padding:4px 4px 18px;background:var(--sheet);cursor:pointer;box-shadow:0 1px 2px rgba(60,40,10,.2),0 4px 10px -6px rgba(60,40,10,.35)}
.gi:nth-child(3n+1){transform:rotate(-1.2deg)}.gi:nth-child(3n+2){transform:rotate(.9deg)}.gi:nth-child(3n){transform:rotate(-.5deg)}
.gi:hover{transform:rotate(0)}
.gi img{width:100%;height:100%;object-fit:cover;display:block;background:var(--paper-dk)}
.gi .st{position:absolute;top:8px;right:8px;font-size:9.5px;padding:0 4px;line-height:15px;background:var(--sheet-a);border:1px solid currentColor;transform:rotate(-4deg)}
.st.saved{color:var(--ok)}.st.saving{color:var(--mut)}.st.fail{color:var(--bad)}.st.idle{color:var(--mut)}
.gi .dim{position:absolute;bottom:0;left:0;right:0;height:18px;line-height:18px;padding:0 6px;font-size:10px;color:var(--mut);font-family:var(--serif);font-style:italic;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.opt{display:flex;align-items:center;gap:10px;padding:9px 0}
.opt+.opt{border-top:1px dashed var(--line2)}
.opt .t{flex:1;min-width:0}
.opt .t .a{font-weight:600;font-size:13px}
.opt .t .b{font-size:11.5px;color:var(--mut);margin-top:1px}
.info{display:inline-flex;vertical-align:-2px;margin-left:4px;color:var(--dim);cursor:help;outline:none}
.info svg{width:13px;height:13px}
.info:hover,.info:focus{color:var(--acc)}
.tipbox{position:fixed;z-index:2147483604;max-width:260px;padding:8px 11px;background:var(--note);color:var(--note-fg);font-family:var(--serif);font-size:12.5px;line-height:1.6;font-weight:400;box-shadow:0 1px 2px rgba(60,40,10,.25),0 10px 20px -10px rgba(0,0,0,.5);transform:rotate(-.6deg);pointer-events:none}
.tipbox[hidden]{display:none}
.tipbox{white-space:pre-wrap}
.snipbadge{position:fixed;z-index:2147483599;display:flex;align-items:center;gap:3px;height:18px;padding:0 6px 0 4px;font:600 10.5px/18px "IBM Plex Mono",Consolas,monospace;color:var(--fg);background:var(--panel);border:1px solid var(--line2);border-radius:9px;box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:help;opacity:.92}
.snipbadge:hover{opacity:1}
.snipbadge[hidden]{display:none}
.snipbadge svg{width:11px;height:11px;color:var(--acc)}
.snipbadge b{color:var(--acc);font-weight:600}
.snipbadge.warn{border-color:var(--bad)}.snipbadge.warn svg,.snipbadge.warn b{color:var(--bad)}
.crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-family:var(--serif);font-size:13px}
.crumbs button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border-radius:3px;color:var(--mut)}
.crumbs button svg{width:13px;height:13px}
.crumbs button:hover{color:var(--fg);background:var(--hover)}
.crumbs button.cur{color:var(--fg);font-weight:700}
.crumbs .sl{color:var(--dim)}
.dirs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}
.daynav{display:inline-flex;align-items:center;gap:1px}.daynav b{font-family:var(--serif);font-size:13px;padding:0 3px}.daynav small{font-size:10.5px;color:var(--acc);border:1px solid var(--acc-line);padding:0 4px;line-height:15px;transform:rotate(-3deg)}.daynav .ib[disabled]{opacity:.3;pointer-events:none}
.fgrid{--kraft:#d5ae7f;--kraft-dk:#b98f60;display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0 -6px 6px}.root.dark .fgrid{--kraft:#9a7752;--kraft-dk:#7d5e3f}
.fcard{all:unset;cursor:pointer;display:flex;flex-direction:column;align-items:center;padding:12px 2px 8px;border:1px solid transparent;border-radius:10px;min-width:0;transition:background .15s,border-color .15s}
.fcard:hover{background:var(--sheet);border-color:var(--line)}
.fcard b{margin-top:8px;font-family:var(--serif);font-size:13.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fcard small{font-size:11px;color:var(--mut)}
.fold{position:relative;width:116px;height:96px}
.fold .back{position:absolute;left:0;right:0;bottom:0;height:58px;background:var(--kraft-dk);border-radius:3px}
.fold .back::before{content:"";position:absolute;left:0;right:0;bottom:100%;height:15px;background:var(--kraft-dk);clip-path:polygon(0 100%,12% 0,88% 0,100% 100%);filter:brightness(.94)}
.fold .ph{position:absolute;bottom:22px;width:37px;height:48px;object-fit:cover;padding:2px 2px 7px;background:#fdfbf5;box-shadow:0 1px 3px rgba(60,40,10,.35);transition:transform .2s}
.fold .p0{left:6px;transform:rotate(-9deg)}.fold .p1{left:39px;bottom:27px;transform:rotate(2deg)}.fold .p2{left:72px;transform:rotate(10deg)}
.fcard:hover .p0{transform:rotate(-14deg) translateY(-5px)}.fcard:hover .p1{transform:translateY(-7px)}.fcard:hover .p2{transform:rotate(15deg) translateY(-5px)}
.fold .front{position:absolute;left:0;right:0;bottom:0;height:38px;border-radius:2px 2px 3px 3px;background:var(--kraft) repeating-linear-gradient(100deg,transparent 0 3px,rgba(255,255,255,.05) 3px 4px,transparent 4px 9px);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 2px 4px -2px rgba(60,40,10,.45)}
.fold .front::before{content:"";position:absolute;left:50%;top:15px;width:50px;height:14px;transform:translateX(-50%) rotate(-2deg);background:#fbf7ec repeating-linear-gradient(transparent 0 4px,rgba(160,140,105,.25) 4px 5px);background-position:0 2px;box-shadow:0 1px 1px rgba(60,40,10,.2)}
.fold .front::after{content:"";position:absolute;left:50%;top:3px;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:var(--kraft-dk);box-shadow:0 0 0 1px rgba(60,40,10,.25),4px 7px 0 -2.5px rgba(120,30,20,.55)}
.dchip{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;font-size:12px;font-family:var(--serif);color:var(--fg);background:var(--sheet);border:1px solid var(--line2);border-radius:3px}
.dchip:hover{border-color:var(--mut)}
.dchip svg{width:12px;height:12px;color:var(--dim)}
.dchip .c{font-family:var(--mono);font-size:10.5px;color:var(--dim)}
.viewer{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--panel)}
.viewer .vh{display:flex;align-items:center;gap:6px;padding:10px 8px 8px 14px;border-bottom:1.5px solid var(--line2)}
.viewer .nm{color:var(--c-title);font-family:var(--serif);font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer .vb{flex:1;overflow-y:auto;padding:12px 14px 16px}
.viewer .vimg{display:block;width:100%;background:var(--sheet);padding:6px 6px 18px;box-shadow:0 1px 3px rgba(60,40,10,.25)}
.viewer .vmeta{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 2px}.viewer .vmeta span{font:11px/18px "IBM Plex Mono",Consolas,monospace;padding:0 6px;border:1px solid var(--line2);color:var(--mut);background:var(--sheet)}
.viewer .sect.sub{margin-left:12px}
.fab.unsaved::after{content:"";position:absolute;top:-5px;left:-5px;width:11px;height:11px;border-radius:50%;background:#e9c46a;box-shadow:0 0 0 2px var(--panel)}
.pathin{display:flex;align-items:center;gap:4px}.pathin span{flex:none;font:12px "IBM Plex Mono",Consolas,monospace;color:var(--mut);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pathin .in{flex:1;min-width:0;height:30px}
.newhint{display:flex;align-items:center;gap:5px;margin-top:6px;font-size:12px;color:var(--acc);font-family:var(--serif)}.newhint[hidden]{display:none}.newhint svg{width:12px;height:12px}.newhint b{font-family:"IBM Plex Mono",Consolas,monospace;font-weight:500;font-size:11.5px}
.dchips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;max-height:84px;overflow-y:auto}.dchips:empty{display:none}.dchips button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:2px 7px;font-size:11.5px;border:1px solid var(--line2);background:var(--sheet);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dchips button:hover{border-color:var(--acc);color:var(--acc)}.dchips svg{width:11px;height:11px;flex:none}.dchips small{color:var(--dim);font-size:10px}
.savesheet .vf kbd{font:500 10px/1 "IBM Plex Mono",Consolas,monospace;padding:1px 4px;border:1px solid var(--on-line);margin-left:2px}
.viewer .vf{display:flex;gap:4px;padding:10px 12px;border-top:1.5px solid var(--line2);flex-wrap:wrap}
.dead{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;background:var(--bad-bg);border-bottom:1px dashed var(--bad);color:var(--bad);font-family:var(--serif);font-size:12.5px}
.sec{font-family:var(--serif);font-size:13px;font-weight:700;color:var(--fg);margin:4px 0 -4px;padding-bottom:2px;border-bottom:1.5px solid var(--fg);align-self:flex-start}
.cnt{font-size:12px;color:var(--mut);font-family:var(--serif);font-style:italic}
.spin{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--on-line);border-top-color:var(--on);animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.toasts{position:fixed;z-index:2147483602;right:24px;bottom:84px;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.toast{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--note);color:var(--note-fg);font-size:13px;font-family:var(--serif);box-shadow:0 1px 2px rgba(60,40,10,.25),0 10px 20px -10px rgba(0,0,0,.5);transform:rotate(-.8deg);animation:stick .2s ease-out;max-width:min(420px,calc(100vw - 32px))}
.toast:nth-child(even){transform:rotate(.7deg)}
.toast svg{width:15px;height:15px;flex:none;color:var(--note-ic)}
.toast.ok svg{color:var(--ok)}.toast.err{background:var(--note-err)}.toast.err svg{color:var(--bad)}
.toast.out{opacity:0;transition:opacity .2s}
@keyframes stick{from{opacity:0;transform:translateY(8px) rotate(-3deg)}}
@media (max-width:520px){.panel{right:12px!important;left:12px!important;width:auto;bottom:80px!important;top:auto!important}}
`;

  let host = null, root = null, fab = null, panel = null, bd = null, toastsEl = null;
  const UI = { open: false, tab: 'translate', pos: null, fabPos: null };
  const TABS = [['translate', 'languages', '번역'], ['snip', 'at', '치환'], ['history', 'history', '기록'], ['dict', 'book', '사전'], ['recent', 'image', '사진'], ['settings', 'sliders', '설정']];
  try { Object.assign(UI, JSON.parse(localStorage.getItem('nai-studio-ui') || '{}'), { open: false }); } catch (e) { /* noop */ }
  const saveUI = () => { try { localStorage.setItem('nai-studio-ui', JSON.stringify({ tab: UI.tab, pos: UI.pos, fabPos: UI.fabPos })); } catch (e) { /* noop */ } };

  function toast(msg, type = 'info', ms = 2400) {
    if (!toastsEl) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info') + `<span>${esc(msg)}</span>`;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
  }

  function loadFonts() {
    // 글꼴은 문서 단위라 shadow DOM 안에서도 쓰임. 사이트가 막으면 시스템 명조(바탕)로 대체
    if (document.getElementById('nai-studio-fonts')) return;
    const l = document.createElement('link');
    l.id = 'nai-studio-fonts';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap';
    (document.head || document.documentElement).appendChild(l);
  }

  function buildUI() {
    loadFonts();
    host = document.createElement('div');
    host.id = 'nai-studio-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483600;';
    root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    const wrap = document.createElement('div');
    wrap.className = 'root';
    wrap.innerHTML = `
      <button class="fab" title="NAI Folio (Alt+N)">${icon('sparkle', true)}<span class="badge"></span><span class="dot"></span></button>
      <section class="panel" hidden>
        <header class="hd">
          <div class="logo">${icon('sparkle', true)}</div>
          <div class="grow"><div class="ttl">NAI Folio</div><div class="sub" data-r="sub"></div></div>
          <button class="ib" data-act="theme" title="밝은 노트 / 밤 노트"></button>
          <button class="btn sm" data-act="studio" title="큰 화면 스튜디오 열기 (Alt+Shift+S)">${icon('external')} 스튜디오</button>
          <button class="ib" data-act="close" title="닫기 (Alt+N)">${icon('x')}</button>
        </header>
        <nav class="tabs">${TABS.map(([id, ic, label]) => `<button class="tab" data-tab="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>
        <main class="bd"></main>
      </section>
      <div class="toasts"></div>`;
    root.appendChild(wrap);
    fab = wrap.querySelector('.fab');
    panel = wrap.querySelector('.panel');
    bd = wrap.querySelector('.bd');
    toastsEl = wrap.querySelector('.toasts');

    // NovelAI 단축키(Ctrl+Enter 생성 등)·드롭 업로드가 패널 입력에 반응하지 않도록
    ['keydown', 'keyup', 'keypress'].forEach((t) => host.addEventListener(t, (e) => {
      if (t === 'keydown' && e.altKey && (e.code === 'KeyN' || e.code === 'KeyQ')) return;
      e.stopPropagation();
    }));
    ['dragover', 'drop', 'paste'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));

    const tipBox = document.createElement('div');
    tipBox.className = 'tipbox';
    tipBox.hidden = true;
    wrap.appendChild(tipBox);
    const showTip = (el) => {
      tipBox.textContent = el.dataset.tip;
      tipBox.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
      tipBox.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
      tipBox.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
    };
    root.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); else tipBox.hidden = true; });
    root.addEventListener('focusin', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
    root.addEventListener('focusout', () => { tipBox.hidden = true; });
    // 패널 밖(NovelAI 화면)으로 마우스가 나가면 바로 숨김
    root.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (!to || !root.contains(to) || !(to.closest && to.closest('[data-tip]'))) tipBox.hidden = true;
    });
    wrap.addEventListener('scroll', () => { tipBox.hidden = true; }, true);
    wrap.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      UI.tab = b.dataset.tab;
      saveUI();
      renderTab();
    });
    wrap.querySelector('[data-act="close"]').addEventListener('click', () => togglePanel(false));
    wrap.querySelector('[data-act="studio"]').addEventListener('click', openStudio);
    wrap.querySelector('[data-act="theme"]').addEventListener('click', () => {
      const dark = wrap.classList.contains('dark');
      setS({ theme: dark ? 'light' : 'dark' });
      applyTheme();
      if (UI.open && UI.tab === 'settings') renderTab();
    });
    applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.theme === 'auto') applyTheme(); });

    setupDrag(fab, 'fabPos', () => togglePanel());
    setupDrag(panel, 'pos', null, wrap.querySelector('.hd'));
    applyPos(fab, UI.fabPos);
    applyPos(panel, UI.pos);
    window.addEventListener('resize', () => { applyPos(fab, UI.fabPos); applyPos(panel, UI.pos); });

    document.documentElement.appendChild(host);
    updateChrome();
    const tick = () => {
      host.style.display = location.pathname.startsWith('/image') ? '' : 'none';
      if (!host.isConnected) document.documentElement.appendChild(host);
    };
    tick();
    setInterval(tick, 1000);
  }

  function applyTheme() {
    const wrap = root && root.querySelector('.root');
    if (!wrap) return;
    const t = S.theme === 'light' || S.theme === 'dark' ? S.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    wrap.classList.toggle('dark', t === 'dark');
    // 색 꾸미기 (스튜디오 설정과 같은 값)
    const CD = { light: { acc: '#33598e', title: '#2b2925', base: '#2c6a55', char: '#6e3f86', neg: '#9a4a22' }, dark: { acc: '#8fb0e3', title: '#ebe4d4', base: '#86c4ad', char: '#c9a3dc', neg: '#e0a074' } };
    const c = Object.assign({}, CD[t], (S.colors && S.colors[t]) || {});
    const vars = { '--acc': c.acc, '--acc-bg': c.acc + (t === 'dark' ? '1a' : '14'), '--acc-line': c.acc + (t === 'dark' ? '80' : '6b'), '--c-title': c.title, '--c-base': c.base, '--c-char': c.char, '--c-neg': c.neg };
    for (const [k, v] of Object.entries(vars)) wrap.style.setProperty(k, v);
    const b = wrap.querySelector('[data-act="theme"]');
    if (b) b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  }

  async function openStudio() {
    const r = await send({ type: 'openStudio' });
    if (!r.ok) deadToast();
  }

  function applyPos(el, pos) {
    if (!pos) return;
    const r = el.getBoundingClientRect();
    const w = r.width || 54, h = r.height || 54;
    const x = Math.min(Math.max(8, pos.x), window.innerWidth - Math.min(w, window.innerWidth - 16) - 8);
    const y = Math.min(Math.max(8, pos.y), window.innerHeight - Math.min(h, window.innerHeight - 16) - 8);
    Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  }
  function setupDrag(el, key, onClick, handle) {
    const h = handle || el;
    let st = null;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (handle && e.target.closest('button'))) return;
      const r = el.getBoundingClientRect();
      st = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, moved: false };
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) < 5) return;
      st.moved = true;
      UI[key] = { x: st.l + dx, y: st.t + dy };
      applyPos(el, UI[key]);
    });
    h.addEventListener('pointerup', () => {
      if (!st) return;
      const moved = st.moved;
      st = null;
      if (moved) saveUI();
      else if (onClick) onClick();
    });
    h.addEventListener('pointercancel', () => { st = null; });
  }
  function togglePanel(force) {
    UI.open = force === undefined ? !UI.open : force;
    panel.hidden = !UI.open;
    fab.classList.toggle('open', UI.open);
    if (UI.open) {
      if (UI.pos) applyPos(panel, UI.pos);
      renderTab();
      if (!isAlive()) showDead(); // 열자마자 끊긴 걸 알려 줌
    }
  }
  function updateChrome() {
    if (!fab) return;
    const badge = fab.querySelector('.badge');
    badge.textContent = sessionSaved > 99 ? '99+' : String(sessionSaved);
    badge.style.display = sessionSaved ? 'block' : 'none';
    const dot = fab.querySelector('.dot');
    dot.style.display = S.autoSave ? 'block' : 'none';
    dot.classList.toggle('warn', folder.perm === 'prompt');
    const sub = root.querySelector('[data-r="sub"]');
    sub.textContent = S.autoSave ? `자동 저장 켜짐 · ${folder.name || '다운로드 폴더'}${S.project && String(S.subdirTpl || '').includes('{project}') ? ' › ' + S.project : ''}` : '자동 저장 꺼짐';
    const nb = root.querySelector('.tab[data-tab="recent"]');
    if (nb) {
      let b = nb.querySelector('.nb');
      if (R.items.length) { if (!b) { b = document.createElement('span'); b.className = 'nb'; nb.appendChild(b); } b.textContent = R.items.length; }
      else if (b) b.remove();
    }
  }
  let libDirty = false, libTimer = 0;
  function refreshTab(name) {
    updateChrome();
    if (!(UI.open && UI.tab === name && bd)) return;
    if (name !== 'recent') return renderTab();
    // 내 폴더 보기: 새로 저장된 게 있을 때만 목록만 조용히 다시 읽음 (스크롤 · 검색칸 그대로)
    if (LIB.mode === 'folder') {
      if (!libDirty) return;
      clearTimeout(libTimer);
      libTimer = setTimeout(() => { libDirty = false; loadLib(true, true, true); }, 500);
      return;
    }
    // 이번 접속 보기: 다시 그리되 스크롤 유지, 작업 이름 칸에 쓰는 중이면 잠깐 미룸
    const a = root.activeElement;
    if (a && a.tagName === 'INPUT' && bd.contains(a)) { clearTimeout(libTimer); libTimer = setTimeout(() => refreshTab(name), 800); return; }
    const y = bd.scrollTop;
    renderTab();
    bd.scrollTop = y;
  }
  function renderTab() {
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === UI.tab));
    bd.onclick = bd.oninput = bd.onchange = bd.onkeydown = null;
    ({ translate: renderTranslate, snip: renderSnip, history: renderHistory, dict: renderDict, recent: renderRecent, settings: renderSettings }[UI.tab] || renderTranslate)();
  }
  const tip = (t) => `<span class="info" tabindex="0" data-tip="${esc(t)}">${icon('info')}</span>`;
  const sw = (k, on) => `<label class="sw"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}><span></span></label>`;

  /* ---------------- 번역 ---------------- */
  const T = { input: '', result: null, busy: false };
  function renderTranslate() {
    bd.innerHTML = `
      <div class="card">
        <div class="lbl">한글 입력 ${tip('쉼표로 나누면 태그별로 번역돼요. 한글이 없으면 영→한 풀이. 프롬프트 칸에서 한글을 드래그하고 Alt+Q, 칸 전체는 Alt+Shift+Q. 조각 옆 별을 누르면 사전에 저장돼요.')}</div>
        <textarea class="ta" data-r="in" placeholder="한글로 적어 보세요. 쉼표(,)로 나누면 태그별로 번역돼요.&#10;예) 1girl, 금발, 파란 눈, 1.2::미소::, 교복">${esc(T.input)}</textarea>
        <div class="row">
          <button class="btn pri" data-act="go" ${T.busy ? 'disabled' : ''}>${T.busy ? '<span class="spin"></span>' : icon('languages')} 번역 <kbd>Ctrl+Enter</kbd></button>
          <label class="mini">${sw('tagMode', S.tagMode)} 태그 모드</label>
          <span class="grow"></span>
          <button class="ib" data-act="clear" title="지우기">${icon('x')}</button>
        </div>
        <div class="row" style="margin-top:8px;flex-wrap:nowrap">
          <label class="mini" style="flex:none">${sw('autoIns', S.autoIns)} 번역하면 바로 칸에 추가</label>
          <span class="cnt grow" data-r="target" style="text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        </div>
      </div>
      <div data-r="out"></div>`;
    updateTargetLabel();
    renderTrResult();
    const ta = bd.querySelector('[data-r="in"]');
    bd.oninput = (e) => {
      if (e.target === ta) T.input = ta.value;
      const j = e.target.dataset.job;
      if (j != null && T.result) {
        T.result.jobs[+j].dst = e.target.value;
        rebuildOutput(T.result);
        const out = bd.querySelector('[data-r="output"]');
        if (out) out.value = T.result.output;
      }
      if (e.target.dataset.r === 'output' && T.result) T.result.output = e.target.value;
    };
    bd.onchange = (e) => {
      const k = e.target.dataset.k;
      if (k === 'tagMode' || k === 'autoIns') setS({ [k]: e.target.checked });
    };
    bd.onkeydown = (e) => { if (e.target === ta && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doTranslate(); } };
    bd.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'go') doTranslate();
      else if (act === 'clear') { T.input = ''; T.result = null; renderTranslate(); bd.querySelector('[data-r="in"]').focus(); }
      else if (act === 'copy' && T.result) copyText(T.result.output);
      else if (act === 'append' && T.result) insertIntoPage(T.result.output, 'append');
      else if (act === 'replace' && T.result) insertIntoPage(T.result.output, 'replace');
      else if (act === 'star' && T.result) {
        const j = T.result.jobs[+b.dataset.i];
        if (!j || !j.dst.trim()) return;
        const { dict: cur = {} } = await sget('dict');
        if (cur[j.src] === j.dst.trim()) { delete cur[j.src]; j.kind = 'mt'; toast(`사전에서 뺐어요 · ${j.src}`, 'info'); }
        else { cur[j.src] = j.dst.trim(); j.kind = 'dict'; toast(`사전에 저장 · ${j.src} → ${j.dst.trim()}`, 'ok'); }
        dict = cur;
        await sset({ dict: cur });
        renderTrResult();
      }
    };
  }
  function renderTrResult() {
    const box = bd.querySelector('[data-r="out"]');
    if (!box) return;
    const r = T.result;
    if (!r) { box.innerHTML = ''; return; }
    const kl = { dict: '사전', cache: '기억', mt: '번역기' };
    box.innerHTML = `
      <div class="card">
        <div class="lbl">${r.dir === 'en2ko' ? '한국어 풀이' : '결과 프롬프트'} <span class="grow"></span>${r.jobs.length ? `<span class="cnt">${r.jobs.length}개 조각</span>` : ''}</div>
        <textarea class="ta out" data-r="output" spellcheck="false">${esc(r.output)}</textarea>
        <div class="row">
          <button class="btn sm" data-act="copy">${icon('copy')} 복사</button>
          ${r.dir === 'ko2en' ? `<button class="btn sm" data-act="append" title="마지막으로 클릭한 프롬프트 칸 끝에 추가">${icon('plus')} 프롬프트 끝에 추가</button>
          <button class="btn sm" data-act="replace" title="마지막으로 클릭한 프롬프트 칸 내용을 교체">${icon('replace')} 교체</button>` : ''}
        </div>
      </div>
      ${r.jobs.length ? `<div class="card"><div class="lbl">조각별로 다듬기  ${tip('고치면 위 결과에 바로 반영돼요')}<span class="grow"></span></div><div class="chips">
        ${r.jobs.map((j, i) => `<div class="chip"><span class="src" title="${esc(j.src)}">${esc(j.src)}</span><span class="arr">${icon('arrow')}</span>
          <input data-job="${i}" value="${esc(j.dst)}" spellcheck="false"><span class="k ${j.kind}">${kl[j.kind] || ''}</span>
          <button class="ib ${dict[j.src] ? 'on' : ''}" data-act="star" data-i="${i}" title="${dict[j.src] ? '사전에서 빼기' : '사전에 저장'}">${icon('star', !!dict[j.src])}</button></div>`).join('')}
      </div></div>` : ''}`;
  }
  async function doTranslate() {
    const text = T.input.trim();
    if (!text || T.busy) return;
    T.busy = true;
    renderTranslate();
    const res = await send({ type: 'translate', text });
    if (res.ok) T.result = res.r;
    else toast(res.error === 'invalidated' ? '확장 프로그램이 업데이트됐어요. 새로고침해 주세요' : '번역 실패: ' + res.error, 'err');
    T.busy = false;
    if (UI.tab === 'translate') renderTranslate();
    // 바로 칸에 추가 (한→영 번역일 때만)
    if (res.ok && S.autoIns && T.result.dir === 'ko2en' && T.result.output.trim()) insertIntoPage(T.result.output, 'append');
  }
  // 번역 결과가 들어갈 칸을 미리 보여줌 (마지막으로 클릭한 NovelAI 프롬프트 칸)
  function updateTargetLabel() {
    const lab = bd && bd.querySelector('[data-r="target"]');
    if (!lab) return;
    const el = findPromptTarget();
    if (!el) { lab.textContent = '넣을 칸: 프롬프트 칸을 한 번 클릭해 주세요'; return; }
    const t = (isTextField(el) ? el.value : el.innerText || '').replace(/\s+/g, ' ').trim();
    lab.textContent = '넣을 칸: ' + (t ? '…' + t.slice(-22) : '(빈 칸)');
    lab.title = '마지막으로 클릭한 프롬프트 칸 끝에 들어가요. 다른 칸에 넣으려면 그 칸을 한 번 클릭하세요.';
  }

  /* ---------------- 치환 ---------------- */
  const SN = { q: '', name: '', text: '', editing: '' };
  function renderSnip() {
    bd.innerHTML = `
      <div class="row"><span class="cnt">앞에 붙일 기호</span><div class="seg" data-r="trig">${TRIGGERS.map((c) => `<button data-tg="${esc(c)}" class="${TG() === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div></div>
      <div class="card">
        <div class="lbl">${SN.editing ? `${esc(TG() + SN.editing)} 고치기` : '새 치환어'} ${tip(`프롬프트 칸에서 ${TG()} 를 치면 목록이 떠요. Enter 로 넣고 Shift+Enter 면 펼쳐서 넣어요. 칸엔 짧게 두면 생성 버튼을 누르는 순간 펼쳐져요. 미리 펼쳐 보려면 Alt+E. 치환어 안에 다른 치환어를 넣어도 돼요.`)}<span class="grow"></span>
          <button class="btn sm" data-act="grab" title="마지막으로 클릭한 프롬프트 칸 내용을 가져와요">${icon('download')} 칸 내용</button>
          <button class="btn sm" data-act="importChunks" title="지금 프롬프트 칸들에 들어 있는 NovelAI 청크를 이름 그대로 치환어로 가져와요. 폴더의 _백업/치환어.txt 에도 남아요.">${icon('download')} NovelAI 청크 가져오기</button></div>
        <div class="row" style="flex-wrap:nowrap;margin-bottom:8px"><span class="snt">${esc(TG())}</span><input class="in" data-r="name" placeholder="이름 (예: 미오)" value="${esc(SN.name)}"></div>
        <textarea class="ta" data-r="text" placeholder="펼쳐질 내용&#10;예) 1girl, silver hair, long hair, red eyes, gothic dress">${esc(SN.text)}</textarea>
        <div class="row">
          <button class="btn pri" data-act="save">${icon('check')} ${SN.editing ? '저장' : '추가'}</button>
          ${SN.editing ? `<button class="btn" data-act="cancel">취소</button>` : ''}
          <span class="grow"></span>
          <label class="mini">${sw('snipExpand', S.snipExpand)} 생성할 때 펼치기</label>
        </div>
      </div>
      <div class="search">${icon('search')}<input class="in" data-r="q" placeholder="치환어 검색" value="${esc(SN.q)}"></div>
      <div class="list" data-r="sl"></div>`;
    renderSnipList();
    bd.oninput = (e) => {
      const r = e.target.dataset.r;
      if (r === 'name') SN.name = e.target.value;
      else if (r === 'text') SN.text = e.target.value;
      else if (r === 'q') { SN.q = e.target.value; renderSnipList(); }
    };
    bd.onchange = (e) => { if (e.target.dataset.k === 'snipExpand') { setS({ snipExpand: e.target.checked }); setTimeout(postCfg, 50); } };
    // 이름 칸 Enter · 내용 칸 Ctrl+Enter 로 바로 저장
    bd.onkeydown = (e) => {
      if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
      const r = e.target.dataset.r;
      if (r === 'name' || (r === 'text' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        bd.querySelector('[data-act="save"]').click();
      }
    };
    bd.onclick = async (e) => {
      const tg = e.target.closest('[data-tg]');
      if (tg) { await changeTrigger(tg.dataset.tg); renderSnip(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const item = b.closest('[data-sn]');
      const n = item ? item.dataset.sn : '';
      if (act === 'save') {
        const name = cleanSnipName(SN.name);
        if (!name || !SN.text.trim()) { toast('이름과 내용을 둘 다 적어 주세요', 'info'); return; }
        if (!SN.editing && snippets[name] != null && !confirm(`${TG()}${name} 이(가) 이미 있어요. 덮어쓸까요?`)) return;
        const next = Object.assign({}, snippets);
        if (SN.editing && SN.editing !== name) delete next[SN.editing];
        next[name] = SN.text.trim();
        if (!(await saveSnippets(next))) return; // 실패하면 쓴 내용 그대로 둠
        toast(`${TG()}${name} 저장했어요`, 'ok');
        SN.name = SN.text = SN.editing = '';
        renderSnip();
      } else if (act === 'importChunks') {
        // NovelAI 청크 블록엔 이름(data-macro-label)과 내용(data-macro-expansion)이 들어 있음
        const found = {};
        document.querySelectorAll('.macro-node[data-macro-label]').forEach((m) => {
          const name = cleanSnipName(m.dataset.macroLabel);
          const text = (m.dataset.macroExpansion || '').trim();
          if (name && text) found[name] = text;
        });
        const names = Object.keys(found);
        if (!names.length) { toast('프롬프트 칸에 NovelAI 청크가 없어요', 'info'); return; }
        const next = Object.assign({}, snippets);
        const conflicts = names.filter((n) => n in next && next[n] !== found[n]);
        const overwrite = conflicts.length ? confirm(`이름이 같은 치환어 ${conflicts.length}개(${conflicts.map((n) => TG() + n).join(' ')})를 청크 내용으로 바꿀까요?`) : false;
        let added = 0, updated = 0, same = 0;
        for (const n of names) {
          if (!(n in next)) { next[n] = found[n]; added++; }
          else if (next[n] === found[n]) same++;
          else if (overwrite) { next[n] = found[n]; updated++; }
        }
        if (!added && !updated) { toast(`청크 ${names.length}개 모두 이미 있어요`, 'info'); return; }
        if (!(await saveSnippets(next))) return;
        toast(`청크 ${added}개 추가${updated ? ` · ${updated}개 바꿈` : ''}${same ? ` · ${same}개는 이미 있음` : ''}`, 'ok', 2600);
        renderSnip();
      } else if (act === 'cancel') { SN.name = SN.text = SN.editing = ''; renderSnip(); }
      else if (act === 'grab') {
        const el = findPromptTarget();
        const t = el ? (isTextField(el) ? el.value : el.innerText || '').trim() : '';
        if (!t) { toast('프롬프트 칸을 한 번 클릭한 뒤 눌러 주세요', 'info'); return; }
        SN.text = t;
        renderSnip();
      } else if (act === 'edit') { SN.editing = n; SN.name = n; SN.text = snippets[n] || ''; renderSnip(); bd.scrollTop = 0; }
      else if (act === 'del') {
        if (!confirm(`${TG()}${n} 을(를) 지울까요?`)) return;
        const next = Object.assign({}, snippets);
        delete next[n];
        await saveSnippets(next);
        renderSnipList();
      } else if (act === 'ins') insertIntoPage(TG() + n, 'append');
      else if (act === 'insx') insertIntoPage(expandSnippets(snippets[n]), 'append');
      else if (act === 'copy') copyText(TG() + n);
    };
  }
  function renderSnipList() {
    const box = bd.querySelector('[data-r="sl"]');
    if (!box) return;
    const q = SN.q.trim().toLowerCase();
    const list = Object.keys(snippets).filter((n) => !q || n.toLowerCase().includes(q) || String(snippets[n]).toLowerCase().includes(q)).sort();
    box.innerHTML = list.length ? list.map((n) => `<div class="hi" data-sn="${esc(n)}">
        <div class="hi-top"><span class="k gen">${esc(TG() + n)}</span><span class="grow"></span>
          <button class="ib" data-act="edit" title="고치기">${icon('pencil')}</button><button class="ib del" data-act="del" title="삭제">${icon('trash')}</button></div>
        <div class="txt">${esc(snippets[n])}</div>
        <div class="hi-act"><button class="btn sm" data-act="ins" title="프롬프트 칸 끝에 ${esc(TG() + n)} 추가">${icon('plus')} ${esc(TG())}넣기</button>
          <button class="btn sm" data-act="insx" title="내용을 펼쳐서 추가">${icon('plus')} 펼쳐 넣기</button>
          <button class="btn sm" data-act="copy">${icon('copy')} 복사</button></div></div>`).join('')
      : `<div class="empty">${icon('at')}${Object.keys(snippets).length ? '검색 결과가 없어요' : '아직 치환어가 없어요.<br>캐릭터 외형 · 화풍 · 자주 쓰는 네거티브를<br>짧은 이름으로 저장해 보세요.'}</div>`;
  }

  /* ---------------- 기록 ---------------- */
  const H = { q: '', filter: 'all', limit: 50 };
  function renderHistory() {
    const seg = [['all', '전체'], ['gen', '생성'], ['tr', '번역'], ['fav', '즐겨찾기']];
    bd.innerHTML = `
      <div class="search">${icon('search')}<input class="in" data-r="q" placeholder="프롬프트·번역 검색" value="${esc(H.q)}"></div>
      <div class="row"><div class="seg">${seg.map(([k, l]) => `<button data-f="${k}" class="${H.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div><span class="grow"></span><span class="cnt" data-r="hc"></span></div>
      <div data-r="hl"></div>`;
    renderHistoryList();
    const qi = bd.querySelector('[data-r="q"]');
    bd.oninput = (e) => { if (e.target === qi) { H.q = qi.value; H.limit = 50; renderHistoryList(); } };
    bd.onclick = async (e) => {
      const f = e.target.closest('[data-f]');
      if (f) { H.filter = f.dataset.f; bd.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === f)); renderHistoryList(); return; }
      const t = e.target.closest('.txt');
      if (t && !e.target.closest('[data-act]')) { t.classList.toggle('open'); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'more') { H.limit += 50; renderHistoryList(); return; }
      const h = history.find((x) => x.id === b.closest('[data-id]').dataset.id);
      if (!h) return;
      const main = h.type === 'gen' ? h.prompt : h.dst;
      if (act === 'fav' || act === 'del') {
        const { history: cur = [] } = await sget('history');
        const next = act === 'del' ? cur.filter((x) => x.id !== h.id) : cur.map((x) => (x.id === h.id ? Object.assign({}, x, { fav: !x.fav }) : x));
        await sset({ history: next });
      }
      else if (act === 'copy') copyText(main);
      else if (act === 'copyNeg') copyText(h.neg || '');
      else if (act === 'copySec') {
        const k = b.dataset.sec;
        copyText(k === 'base' ? h.prompt : k === 'neg' ? h.neg || '' : (h.chars || [])[+k.slice(1)] || '');
      }
      else if (act === 'append') insertIntoPage(main, 'append');
      else if (act === 'replace') insertIntoPage(main, 'replace');
    };
  }
  function renderHistoryList() {
    const box = bd.querySelector('[data-r="hl"]');
    if (!box) return;
    const q = H.q.trim().toLowerCase();
    const list = history.filter((h) => {
      if (H.filter === 'gen' && h.type !== 'gen') return false;
      if (H.filter === 'tr' && h.type !== 'tr') return false;
      if (H.filter === 'fav' && !h.fav) return false;
      return !q || [h.prompt, h.neg, h.src, h.dst, (h.chars || []).join(' ')].some((s) => s && String(s).toLowerCase().includes(q));
    });
    bd.querySelector('[data-r="hc"]').textContent = `${list.length}개`;
    box.innerHTML = `<div class="list">${list.length ? list.slice(0, H.limit).map((h) => {
      const meta = h.type === 'gen' ? [h.w && h.h ? `${h.w}×${h.h}` : '', h.seed != null ? `seed ${h.seed}` : '', h.count > 1 ? `×${h.count}` : '', (h.snips || []).map((n) => TG() + n).join(' ')].filter(Boolean).join(' · ') : '';
      // 베이스 · 캐릭터 · 네거티브를 구역으로 나눠서 (각각 복사 버튼)
      const sec = (key, label, text, cls) => `<div class="sect ${cls}"><div class="sh"><span>${label}</span><button class="ib" data-act="copySec" data-sec="${key}" title="${label} 복사">${icon('copy')}</button></div><div class="txt${cls === 'base' ? '' : ' sm'}">${esc(text)}</div></div>`;
      const body = h.type === 'gen'
        ? sec('base', '베이스', h.prompt, 'base') + (h.chars || []).map((c, i) => sec('c' + i, `캐릭터 ${i + 1}`, c, 'char')).join('') + (h.neg ? sec('neg', '네거티브', h.neg, 'neg') : '')
        : `<div class="txt sm" style="margin:0 0 4px">${esc(h.src)}</div><div class="txt">${esc(h.dst)}</div>`;
      return `<div class="hi ${h.fav ? 'fav' : ''}" data-id="${h.id}">
        <div class="hi-top"><span class="k ${h.type}">${h.type === 'gen' ? '생성' : '번역'}</span><span class="time">${fmtTime(h.t)}</span><span class="meta grow">${esc(meta)}</span>
          <button class="ib ${h.fav ? 'on' : ''}" data-act="fav">${icon('star', h.fav)}</button><button class="ib del" data-act="del">${icon('trash')}</button></div>
        ${body}
        <div class="hi-act">${h.type === 'gen' ? '' : `<button class="btn sm" data-act="copy">${icon('copy')} 복사</button>`}
          <button class="btn sm" data-act="append" title="${h.type === 'gen' ? '베이스 프롬프트를 ' : ''}프롬프트 칸 끝에 추가">${icon('plus')} 추가</button><button class="btn sm" data-act="replace" title="${h.type === 'gen' ? '베이스 프롬프트로 ' : ''}프롬프트 칸 교체">${icon('replace')} 교체</button></div></div>`;
    }).join('') : `<div class="empty">${icon('history')}${history.length ? '검색 결과가 없어요' : '아직 기록이 없어요.<br>생성하거나 번역하면 자동으로 쌓여요.'}</div>`}</div>
    ${list.length > H.limit ? `<button class="btn wide" data-act="more" style="margin-top:8px">더 보기 (${list.length - H.limit})</button>` : ''}`;
  }

  /* ---------------- 사전 ---------------- */
  const D = { q: '', ko: '', en: '' };
  function renderDict() {
    bd.innerHTML = `
      <div class="card">
        <div class="lbl">나만의 번역 사전 <span class="grow"></span><span class="cnt">${Object.keys(dict).length}개</span></div>
        <div class="row" style="flex-wrap:nowrap">
          <input class="in" data-r="ko" placeholder="한글 (예: 고양이귀)" value="${esc(D.ko)}">
          <input class="in" data-r="en" placeholder="태그 (예: cat ears)" value="${esc(D.en)}">
          <button class="btn pri" data-act="add">${icon('plus')}</button>
        </div>
      </div>
      <div class="search">${icon('search')}<input class="in" data-r="q" placeholder="사전 검색" value="${esc(D.q)}"></div>
      <div class="list" data-r="dl"></div>`;
    renderDictList();
    const add = async () => {
      const ko = D.ko.trim(), en = D.en.trim();
      if (!ko || !en) { toast('한글과 태그를 둘 다 적어 주세요', 'info'); return; }
      const { dict: cur = {} } = await sget('dict');
      cur[ko] = en;
      await sset({ dict: cur });
      D.ko = D.en = '';
      toast(`사전에 추가 · ${ko} → ${en}`, 'ok');
      renderDict();
      bd.querySelector('[data-r="ko"]').focus();
    };
    bd.oninput = (e) => {
      const r = e.target.dataset.r;
      if (r === 'ko') D.ko = e.target.value;
      else if (r === 'en') D.en = e.target.value;
      else if (r === 'q') { D.q = e.target.value; renderDictList(); }
    };
    bd.onchange = async (e) => {
      const k = e.target.dataset.edit;
      if (k == null || !e.target.value.trim()) return;
      const { dict: cur = {} } = await sget('dict');
      cur[k] = e.target.value.trim();
      await sset({ dict: cur });
      toast('수정했어요', 'ok', 1000);
    };
    bd.onkeydown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && (e.target.dataset.r === 'ko' || e.target.dataset.r === 'en')) { e.preventDefault(); add(); }
    };
    bd.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'add') add();
      else if (b.dataset.act === 'del') {
        const { dict: cur = {} } = await sget('dict');
        delete cur[b.closest('[data-key]').dataset.key];
        await sset({ dict: cur });
      }
    };
  }
  function renderDictList() {
    const box = bd.querySelector('[data-r="dl"]');
    if (!box) return;
    const q = D.q.trim().toLowerCase();
    const entries = Object.entries(dict).filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)).reverse();
    box.innerHTML = entries.length ? entries.map(([k, v]) => `<div class="chip" data-key="${esc(k)}"><span class="src" title="${esc(k)}">${esc(k)}</span><span class="arr">${icon('arrow')}</span>
        <input data-edit="${esc(k)}" value="${esc(v)}" spellcheck="false"><button class="ib del" data-act="del" title="삭제">${icon('trash')}</button></div>`).join('')
      : `<div class="empty">${icon('book')}${Object.keys(dict).length ? '검색 결과가 없어요' : '사전이 비어 있어요.<br>번역 결과 옆 별 버튼을 누르거나 위에서 추가해 보세요.'}</div>`;
  }

  /* ---------------- 최근 ---------------- */
  const DIR_LABEL = { '{project}': '작업 이름', '{char}': '캐릭터', '{date}': '날짜', '{ym}': '연-월', '{year}': '연도', '{month}': '월', '{day}': '일', '{orient}': '방향', '{model}': '모델', '{tag}': '첫 태그' };
  function dirRuleLabel() {
    const segs = String(S.subdirTpl == null ? '{date}' : S.subdirTpl).split('/').filter(Boolean);
    if (!segs.length) return '나누지 않음 (맨 위에 저장)';
    return segs.map((s) => (s === '{project}' && S.project ? S.project : DIR_LABEL[s] || s)).join(' › ');
  }
  /* ---------- 사진 탭: [이번 접속 | 내 폴더] ---------- */
  let libScope = 'day';
  try { libScope = localStorage.getItem('nai-studio-libscope') || 'day'; } catch (e) { /* 없음 */ }
  const LIB = { scope: libScope, day: '', days: [], mode: 'session', dir: '', q: '', items: [], total: 0, dirs: [], loading: false, err: '', folder: '', qTimer: 0 };
  const modeSeg = () => `<div class="seg"><button data-m="session" class="${LIB.mode === 'session' ? 'on' : ''}">이번 접속</button><button data-m="folder" class="${LIB.mode === 'folder' ? 'on' : ''}">내 폴더</button></div>`;
  function onModeClick(e) {
    const m = e.target.closest('[data-m]');
    if (!m) return false;
    LIB.mode = m.dataset.m;
    renderRecent();
    return true;
  }
  function renderFolder() {
    const segs = LIB.dir ? LIB.dir.split('/') : [];
    bd.innerHTML = `
      <div class="row">${modeSeg()}<span class="grow"></span><button class="ib" data-act="libReload" title="폴더 다시 읽기">${icon('replace')}</button></div>
      <div class="crumbs"><button data-dir="" class="${LIB.dir ? '' : 'cur'}">${icon('folder')}${esc(LIB.folder || folder.name || '내 폴더')}</button>${segs.map((s, i) => `<span class="sl">›</span><button data-dir="${esc(segs.slice(0, i + 1).join('/'))}" class="${i === segs.length - 1 ? 'cur' : ''}">${esc(s)}</button>`).join('')}</div>
      <div class="search">${icon('search')}<input class="in" data-r="libq" placeholder="프롬프트 · 파일 이름 검색 (쉼표로 여러 개)" value="${esc(LIB.q)}"></div>
      <div data-r="libbody"></div>`;
    renderLibBody();
    if (!LIB.items.length && !LIB.loading && !LIB.err) loadLib(true);
    else if (libDirty) { libDirty = false; loadLib(true, true, true); } // 다른 화면에 있는 동안 저장된 그림
    bd.onkeydown = null;
    bd.onchange = null;
    bd.oninput = (e) => {
      if (e.target.dataset.r !== 'libq') return;
      LIB.q = e.target.value;
      clearTimeout(LIB.qTimer);
      LIB.qTimer = setTimeout(() => loadLib(true), 350);
    };
    bd.onclick = async (e) => {
      if (onModeClick(e)) return;
      const d = e.target.closest('[data-dir]');
      if (d) { LIB.dir = d.dataset.dir; LIB.day = ''; LIB.items = []; LIB.err = ''; renderFolder(); return; }
      const dn = e.target.closest('[data-day]');
      if (dn) { const i = (LIB.days || []).indexOf(LIB.day) + +dn.dataset.day; if (LIB.days[i]) { LIB.day = LIB.days[i]; loadLib(true); } return; }
      const sc = e.target.closest('[data-scope]');
      if (sc) { LIB.scope = sc.dataset.scope; try { localStorage.setItem('nai-studio-libscope', LIB.scope); } catch (err) { /* 없음 */ } loadLib(true); return; }
      const b = e.target.closest('[data-act]');
      if (b) {
        if (b.dataset.act === 'libReload') { LIB.items = []; LIB.err = ''; loadLib(true, true); }
        else if (b.dataset.act === 'libMore') loadLib(false);
        else if (b.dataset.act === 'studio') openStudio();
        return;
      }
      const gi = e.target.closest('.gi[data-p]');
      if (gi) openViewer(gi.dataset.p);
    };
  }
  function dayNav() {
    const days = LIB.days || [];
    const canDay = !LIB.q.trim() && LIB.dirs.length;
    if (!canDay) return '';
    const i = days.indexOf(LIB.day);
    const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${days.length ? `<span class="daynav"><button class="ib" data-day="1" ${i >= days.length - 1 ? 'disabled' : ''} title="이전 날">${icon('left')}</button><b>${esc(LIB.day)}</b>${LIB.day === today ? '<small>오늘</small>' : ''}<button class="ib" data-day="-1" ${i <= 0 ? 'disabled' : ''} title="다음 날">${icon('right')}</button></span>` : ''}<span class="seg"><button data-scope="day" class="${LIB.scope !== 'all' ? 'on' : ''}">하루씩</button><button data-scope="all" class="${LIB.scope === 'all' ? 'on' : ''}">전체</button></span>`;
  }
  function renderLibBody() {
    const box = bd.querySelector('[data-r="libbody"]');
    if (!box) return;
    if (LIB.err) {
      const msg = { nofolder: '아직 폴더를 연결하지 않았어요', perm: '폴더 권한이 꺼져 있어요 · 툴바의 NAI Folio 아이콘을 눌러 허용해 주세요', invalidated: '확장 프로그램이 업데이트됐어요 · 페이지를 새로고침해 주세요' }[LIB.err] || '폴더를 읽지 못했어요: ' + LIB.err;
      box.innerHTML = `<div class="empty">${icon('folder')}${esc(msg)}${LIB.err === 'nofolder' ? `<br><button class="btn sm" data-act="studio" style="margin-top:10px">스튜디오에서 연결하기</button>` : ''}</div>`;
      return;
    }
    if (LIB.loading && !LIB.items.length) { box.innerHTML = `<div class="empty"><span class="spin" style="display:inline-block;border-color:var(--line2);border-top-color:var(--fg)"></span><br>폴더 읽는 중…</div>`; return; }
    box.innerHTML = `
      ${LIB.dirs.length ? `<div class="fgrid">${LIB.dirs.map((d) => `<button class="fcard" data-dir="${esc(d.path)}" title="${esc(d.path)}">
          <span class="fold"><span class="back"></span>${(d.thumbs || []).map((u, j) => `<img class="ph p${j}" src="${u}" alt="">`).join('')}<span class="front"></span></span>
          <b>${esc(d.path.split('/').pop())}</b><small>${d.count}장</small></button>`).join('')}</div>` : ''}
      <div class="row" style="margin:4px 0 8px;gap:6px">${dayNav()}<span class="cnt">${LIB.total}장</span></div>
      ${LIB.items.length ? `<div class="grid">${LIB.items.map((it) => `<div class="gi" data-p="${esc(it.path)}" title="${esc(it.name)}">
          ${it.thumb ? `<img src="${it.thumb}" alt="">` : '<div style="width:100%;height:100%"></div>'}<span class="dim">${fmtTime(it.mtime).replace('오늘 ', '')}</span></div>`).join('')}</div>`
        : `<div class="empty">${icon('image')}${LIB.q ? '검색 결과가 없어요' : '이 폴더엔 사진이 없어요'}</div>`}
      ${LIB.items.length < LIB.total ? `<button class="btn wide" data-act="libMore" style="margin-top:10px" ${LIB.loading ? 'disabled' : ''}>${LIB.loading ? '불러오는 중…' : `더 보기 (${LIB.total - LIB.items.length})`}</button>` : ''}`;
  }
  async function loadLib(reset, fresh, keep) {
    if (LIB.loading) { if (keep) LIB.again = true; return; }
    LIB.loading = true;
    const want = keep ? Math.max(24, LIB.items.length) : 24;
    if (reset && !keep) LIB.items = [];
    if (!keep) renderLibBody();
    const onLatest = keep && LIB.day && LIB.day === (LIB.days || [])[0];
    const r = await send({ type: 'lib', op: 'list', dir: LIB.dir, q: LIB.q.trim(), offset: reset ? 0 : LIB.items.length, limit: reset ? want : 24, fresh: !!fresh, day: onLatest ? '' : LIB.day, scope: LIB.scope });
    LIB.loading = false;
    if (!r.ok) LIB.err = r.reason || r.error || '오류';
    else {
      LIB.err = '';
      LIB.folder = r.folder;
      LIB.total = r.total;
      LIB.dirs = r.dirs;
      LIB.days = r.days || [];
      LIB.day = r.day || '';
      LIB.items = reset ? r.items : LIB.items.concat(r.items);
    }
    if (UI.tab === 'recent' && LIB.mode === 'folder') { const y = bd.scrollTop; renderLibBody(); bd.scrollTop = y; } // 패널을 닫았다 열어도 결과가 보이게
    if (LIB.again) { LIB.again = false; loadLib(true, true, true); }
  }
  // 크게 보기 (패널 안에 겹쳐서)
  async function openViewer(p) {
    const pnl = root.querySelector('.panel');
    pnl.querySelectorAll('.viewer').forEach((v) => v.remove());
    const v = document.createElement('div');
    v.className = 'viewer';
    v.innerHTML = `<div class="vh"><span class="grow nm">${esc(p.split('/').pop())}</span><button class="ib" data-v="close" title="닫기">${icon('x')}</button></div><div class="vb"><div class="empty">불러오는 중…</div></div>`;
    pnl.appendChild(v);
    v.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const a = b.dataset.v, m = v.__meta || {};
      if (a === 'close') v.remove();
      else if (a === 'copy') { const k = b.dataset.sec; copyText(k === 'base' ? m.prompt : k === 'neg' ? m.neg : k.startsWith('n') ? (m.charNegs || [])[+k.slice(1)] || '' : (m.chars || [])[+k.slice(1)] || ''); }
      else if (a === 'add') insertIntoPage(m.prompt || '', 'append');
      else if (a === 'replace') insertIntoPage(m.prompt || '', 'replace');
      else if (a === 'studio') openStudio();
    });
    const r = await send({ type: 'lib', op: 'full', path: p });
    if (!v.isConnected) return;
    if (!r.ok) { v.querySelector('.vb').innerHTML = `<div class="empty">${icon('alert')}사진을 열지 못했어요</div>`; return; }
    const m = r.meta;
    v.__meta = m || {};
    const sec = (key, label, text, cls) => `<div class="sect ${cls}"><div class="sh"><span>${label}</span><button class="ib" data-v="copy" data-sec="${key}" title="${label} 복사">${icon('copy')}</button></div><div class="txt open${cls === 'base' ? '' : ' sm'}">${esc(text)}</div></div>`;
    v.querySelector('.vb').innerHTML = `<img class="vimg" src="${r.data}" alt="">
      <div class="cnt" style="margin:8px 0 2px">${esc(r.path)} · ${fmtTime(r.mtime)}</div>
      ${m && (m.prompt || m.neg) ? `<div class="vmeta">${[m.modelName, m.w && m.h ? `${m.w}×${m.h}` : '', m.seed != null ? `seed ${m.seed}` : '', m.steps ? `${m.steps} steps` : '', m.sampler ? m.sampler + (m.schedule ? ` (${m.schedule})` : '') : '', m.scale != null ? `CFG ${m.scale}` : '', m.rescale ? `rescale ${m.rescale}` : ''].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      ${m && (m.prompt || m.neg) ? sec('base', '베이스', m.prompt, 'base') + (m.chars || []).map((c, i) => sec('c' + i, `캐릭터 ${i + 1}`, c, 'char') + ((m.charNegs || [])[i] ? sec('n' + i, `캐릭터 ${i + 1} 네거티브`, m.charNegs[i], 'neg sub') : '')).join('') + (m.neg ? sec('neg', '네거티브', m.neg, 'neg') : '')
        : `<div class="empty" style="padding:16px">이 사진엔 생성 정보가 없어요</div>`}`;
    if (m && m.prompt) {
      const f = document.createElement('div');
      f.className = 'vf';
      f.innerHTML = `<button class="btn sm" data-v="add" title="마지막으로 클릭한 프롬프트 칸 끝에">${icon('plus')} 베이스를 칸에 추가</button><button class="btn sm" data-v="replace" title="마지막으로 클릭한 프롬프트 칸을 이걸로">${icon('replace')} 교체</button><span class="grow"></span><button class="btn sm" data-v="studio">${icon('external')} 스튜디오</button>`;
      v.appendChild(f);
    }
  }

  function renderRecent() {
    if (LIB.mode === 'folder') return renderFolder();
    const warn = S.autoSave && folder.perm === 'prompt';
    const where = folder.name || '다운로드/NovelAI';
    bd.innerHTML = `
      <div class="row">${modeSeg()}</div>
      <div class="hero ${warn ? 'warn' : ''}">
        <div class="ic">${icon(warn ? 'alert' : 'folder')}</div>
        <div class="grow"><div class="t1">${warn ? '폴더 권한이 필요해요' : '자동 저장'}</div>
          <div class="t2">${warn ? '지금은 다운로드 폴더에 대신 저장 중 · 툴바의 NAI Folio 아이콘을 눌러 허용' : S.autoSave ? `${where} · ${S.saveMode === 'convert' ? '메타 제거 ' + ({ jpeg: 'JPG', webp: 'WebP' }[S.convFormat] || 'PNG') : '원본 PNG'}` : '꺼짐 · 아래 그림을 눌러 골라서 저장 (Alt+S 최근 그림)'}</div></div>
        ${sw('autoSave', S.autoSave)}
      </div>
      ${!folder.name ? `<button class="btn wide" data-act="studio">${icon('folder')} 내 폴더 연결하기 (스튜디오)</button>` : ''}
      <div class="card" style="padding:10px 12px">
        <div class="row" style="flex-wrap:nowrap"><span class="cnt" style="flex:none">폴더 나누기</span><span class="grow" style="font-family:var(--serif);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dirRuleLabel())}</span>
          <button class="btn sm" data-act="studio" title="스튜디오 설정에서 바꾸기">바꾸기</button></div>
        <div class="row" style="flex-wrap:nowrap;margin-top:7px"><span class="cnt" style="flex:none">지금 작업 ${tip('폴더 나누기에 작업 이름 칸이 있으면 이 이름으로 폴더가 생겨요')}</span>
          <input class="in" data-r="project" placeholder="미분류 (예: 미오 표정 연습)" value="${esc(S.project || '')}" style="height:28px"></div>
      </div>
      <div class="row"><span class="cnt">이번 접속에서 ${R.items.length}장 · 저장 ${sessionSaved}장</span><span class="grow"></span>
        <button class="btn sm" data-act="scan" title="화면에 떠 있는 생성 이미지를 가져와요">${icon('scan')} 화면에서 가져오기</button></div>
      ${R.items.length ? `<div class="grid">${R.items.map((it) => `<div class="gi" data-id="${it.id}" title="${esc(it.meta ? it.meta.prompt : '')}${it.status !== 'saved' ? '\n클릭해서 저장' : ''}">
          <img src="${it.url}" alt=""><span class="st ${it.status}">${{ saved: it.via === 'folder' ? '저장됨' : '다운로드됨', saving: '저장 중', fail: '실패', idle: '저장 안 됨' }[it.status]}</span>
          <span class="dim">${fmtTime(it.t).replace('오늘 ', '')} · ${it.w}×${it.h}</span></div>`).join('')}</div>
        <button class="btn pri wide" data-act="studio">${icon('external')} 스튜디오에서 전체 보기</button>`
      : `<div class="empty">${icon('image')}아직 이번 접속에서 생성한 이미지가 없어요.<br>생성하면 여기에 바로 떠요.</div>`}`;
    bd.onkeydown = (e) => { if (e.target.dataset.r === 'project' && e.key === 'Enter' && !e.isComposing) e.target.blur(); };
    bd.onchange = (e) => {
      if (e.target.dataset.r === 'project') {
        const v = e.target.value.trim();
        setS({ project: v });
        toast(v ? `지금 작업: ${v}` : '작업 이름을 비웠어요 (미분류)', 'ok', 1500);
        return;
      }
      if (e.target.dataset.k === 'autoSave') {
        setS({ autoSave: e.target.checked });
        toast(e.target.checked ? '자동 저장을 켰어요' : '자동 저장을 껐어요', e.target.checked ? 'ok' : 'info');
        renderRecent();
      }
    };
    bd.oninput = null;
    bd.onclick = (e) => {
      if (onModeClick(e)) return;
      const b = e.target.closest('[data-act]');
      if (b) {
        if (b.dataset.act === 'studio') openStudio();
        else if (b.dataset.act === 'scan') window.postMessage({ __naiStudio: 1, from: 'panel', type: 'scan' }, location.origin);
        return;
      }
      const gi = e.target.closest('.gi');
      if (!gi) return;
      const it = R.items.find((x) => x.id === gi.dataset.id);
      if (it) openSaveSheet(it);
    };
  }

  /* ---------------- 설정 ---------------- */
  function renderSettings() {
    bd.innerHTML = `
      <div class="sec">저장</div>
      <div class="card">
        <div class="opt"><div class="t"><div class="a">자동 저장</div><div class="b">${folder.name ? `${esc(folder.name)}${folder.perm === 'prompt' ? ' · 권한 필요' : ''}` : '폴더 미연결 · 다운로드 폴더에 저장'}</div></div>${sw('autoSave', S.autoSave)}</div>
        <div class="opt"><div class="t"><div class="a">저장 방식</div></div>
          <div class="seg"><button data-sm="original" class="${S.saveMode === 'original' ? 'on' : ''}">원본 PNG</button><button data-sm="convert" class="${S.saveMode === 'convert' ? 'on' : ''}">메타 제거</button></div></div>
        <div class="opt"><div class="t"><div class="a">PNG 최종본만 잡기 ${tip(`생성 중 미리보기는 저장 안 해요`)}</div></div>${sw('pngOnly', S.pngOnly)}</div>
      </div>
      <div class="sec">화면</div>
      <div class="card">
        <div class="opt"><div class="t"><div class="a">노트 색 ${tip(`자동은 윈도우 · 브라우저 설정을 따라가요`)}</div></div>
          <div class="seg">${[['auto', '자동'], ['light', '밝게'], ['dark', '밤']].map(([k, l]) => `<button data-th="${k}" class="${S.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      </div>
      <div class="sec">치환</div>
      <div class="card">
        <div class="opt"><div class="t"><div class="a">생성할 때 ${esc(TG())}이름 펼치기 ${tip(`끄면 자동완성만 쓰고, 보낼 땐 그대로 보내요`)}</div></div>${sw('snipExpand', S.snipExpand)}</div>
        <div class="opt"><div class="t"><div class="a">앞에 붙일 기호</div></div><div class="seg">${TRIGGERS.map((c) => `<button data-tg="${esc(c)}" class="${TG() === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div></div>
      </div>
      <div class="sec">번역</div>
      <div class="card">
        <div class="opt"><div class="t"><div class="a">태그 모드 ${tip(`쉼표 단위로 나눠서 번역`)}</div></div>${sw('tagMode', S.tagMode)}</div>
        <div class="opt"><div class="t"><div class="a">소문자로</div></div>${sw('lowercase', S.lowercase)}</div>
        <div class="opt"><div class="t"><div class="a">관사 빼기 ${tip(`a / an / the`)}</div></div>${sw('stripArticles', S.stripArticles)}</div>
      </div>
      <button class="btn wide" data-act="studio">${icon('sliders')} 폴더 · 파일 이름 · 변환 설정은 스튜디오에서</button>
      <div class="tip"><kbd>Alt</kbd>+<kbd>N</kbd> 패널 · <kbd>Alt</kbd>+<kbd>Q</kbd> 선택 번역 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> 칸 전체 번역 · <kbd>${esc(TG())}</kbd> 치환어 목록 · <kbd>Alt</kbd>+<kbd>E</kbd> 치환어 펼쳐 보기 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> 스튜디오</div>
      <div class="cnt" data-r="diag">마지막 생성 요청: ${lastGen ? `${esc(lastGen.url)} · ${esc(lastGen.kind)}` : '아직 없음'} ${tip('치환이 안 될 때 이 줄을 알려 주세요. 어떤 주소 · 형식으로 보내는지 보여줘요.')}</div>
      <div class="cnt" data-r="ver" style="text-align:right">NAI Folio v${esc(isAlive() ? chrome.runtime.getManifest().version : '?')}</div>`;
    bd.onchange = (e) => {
      const k = e.target.dataset.k;
      if (k) { setS({ [k]: e.target.checked }); if (k === 'snipExpand' || k === 'pngOnly') setTimeout(postCfg, 50); }
    };
    bd.onclick = async (e) => {
      const tg = e.target.closest('[data-tg]');
      if (tg) { await changeTrigger(tg.dataset.tg); renderSettings(); return; }
      const th = e.target.closest('[data-th]');
      if (th) { await setS({ theme: th.dataset.th }); applyTheme(); renderSettings(); return; }
      const sm = e.target.closest('[data-sm]');
      if (sm) { setS({ saveMode: sm.dataset.sm }); renderSettings(); return; }
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'studio') openStudio();
    };
  }

  /* ------------------------------------------------------------------ *
   * 단축키
   * ------------------------------------------------------------------ */
  window.addEventListener('keydown', (e) => {
    if (acKey(e)) return;
    if (onGenKey(e)) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyE' && !e.shiftKey) {
      if (host && e.composedPath().includes(host)) return;
      e.preventDefault();
      e.stopPropagation();
      expandInField();
    } else if (e.code === 'KeyS' && !e.shiftKey) {
      if (!host || host.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      openSaveSheet(R.items[0]);
    } else if (e.code === 'KeyN' && !e.shiftKey) {
      if (!host || host.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    } else if (e.code === 'KeyQ') {
      e.preventDefault();
      e.stopPropagation();
      if (host && e.composedPath().includes(host)) { if (UI.tab === 'translate') doTranslate(); return; }
      inlineTranslate(e.shiftKey);
    }
  }, true);

  // 스튜디오 번역기의 "NovelAI 칸에 추가" → 이 탭의 프롬프트 칸에 넣음
  try {
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (!m || m.type !== 'insertPrompt') return false;
      insertIntoPage(m.text, m.mode || 'append');
      reply({ ok: true });
      return false;
    });
  } catch (e) { /* noop */ }

  async function init() {
    await loadStore();
    // 연결 끊김으로 새로고침했을 때 쓰던 내용 되살리기
    try {
      const d = JSON.parse(sessionStorage.getItem('nai-studio-draft') || 'null');
      if (d) {
        sessionStorage.removeItem('nai-studio-draft');
        Object.assign(SN, d.sn || {});
        T.input = d.tr || '';
        if (d.tab) { UI.tab = d.tab; setTimeout(() => togglePanel(true), 300); }
      }
    } catch (e) { /* noop */ }
    buildUI();
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
