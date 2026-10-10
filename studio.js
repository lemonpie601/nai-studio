import * as X from './shared.js';

const { icon, esc, fmtBytes, fmtTime } = X;
const TRASH = '_휴지통';
const CONV_DIR = '_변환';
const $ = (s, el = document) => el.querySelector(s);

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */
let S = await X.getSettings();
const init = await chrome.storage.local.get(['history', 'dict', 'snippets', 'trCache', 'stats']);
let hist = init.history || [];
let dict = init.dict || {};
let snippets = init.snippets || {};
let trCacheN = Object.keys(init.trCache || {}).length;
let stats = init.stats || { day: '', count: 0 };

const F = { root: await X.getRoot(), perm: 'none' };
if (F.root) {
  try { F.perm = await X.permState(F.root, false); } catch (e) { F.perm = 'prompt'; }
  chrome.storage.local.set({ folderName: F.root.name, folderPerm: F.perm === 'granted' ? 'granted' : 'prompt' });
}

const VIEWS = {
  library: { icon: 'images', label: '라이브러리', title: '라이브러리', desc: '연결한 폴더의 이미지와 생성 정보를 한눈에' },
  convert: { icon: 'shield', label: '변환', title: '메타데이터 제거 변환', desc: '이미지를 새로 그려서 저장해서 EXIF · GPS · PNG 안 프롬프트 · 색 프로필이 전부 빠져요. 평탄화를 켜면 NovelAI 가 투명도 채널에 숨기는 정보까지 지워져요. 모든 처리는 이 컴퓨터 안에서만 해요.' },
  translate: { icon: 'languages', label: '번역기', title: '번역기', desc: '한글로 쓰면 NovelAI 태그로 바꿔요. 쉼표 단위로 나눠서 번역하고, 한글이 없으면 영→한 풀이를 보여줘요. NovelAI 프롬프트 칸에선 한글을 드래그하고 Alt+Q (칸 전체는 Alt+Shift+Q). 조각 옆 별을 누르면 사전에 저장돼요.' },
  snippets: { icon: 'at', label: '치환', title: '치환어', desc: '프롬프트에 %이름 만 쓰면 생성할 때 저장한 내용으로 바뀌어요' },
  history: { icon: 'history', label: '기록', title: '기록', desc: '생성할 때 쓴 프롬프트와 번역이 자동으로 쌓여요' },
  dict: { icon: 'book', label: '사전', title: '번역 사전', desc: '번역기 전용 단어장 — 이 한글은 항상 이 태그로 번역돼요' },
  settings: { icon: 'sliders', label: '설정', title: '설정', desc: '저장 폴더 · 파일 이름 · 변환 · 번역' },
};
let view = viewFromHash();
function viewFromHash() {
  const h = location.hash.slice(1);
  return h in VIEWS ? h : 'library';
}

/* ------------------------------------------------------------------ *
 * 공용 UI 도우미
 * ------------------------------------------------------------------ */
function toast(msg, type = 'info', ms = 2600) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info') + `<span>${esc(msg)}</span>`;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}
function copyText(text, label) {
  navigator.clipboard.writeText(text || '').then(() => toast(label || '복사했어요', 'ok', 1400), () => toast('복사하지 못했어요', 'err'));
}
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }); }
  catch (e) {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const tip = (t) => `<span class="info" tabindex="0" data-tip="${esc(t)}">${icon('info')}</span>`;
const sw = (attr, on) => `<label class="sw"><input type="checkbox" ${attr} ${on ? 'checked' : ''}><span></span></label>`;
function mount(html) {
  const v = $('#view');
  const w = document.createElement('div');
  w.innerHTML = html;
  v.replaceChildren(w);
  return w;
}
const modals = [];
function modal({ title, body, actions, onAction, onMount }) {
  const bg = document.createElement('div');
  bg.className = 'mbg';
  bg.innerHTML = `<div class="modal"><div class="mh">${esc(title)}</div><div class="mb">${body}</div>
    <div class="mf">${actions.map((a) => `<button class="btn ${a.cls || ''}" data-ma="${a.act}">${a.label}</button>`).join('')}</div></div>`;
  document.body.appendChild(bg);
  const m = { el: bg, busy: false, close() { bg.remove(); modals.splice(modals.indexOf(m), 1); } };
  modals.push(m);
  bg.addEventListener('click', async (e) => {
    if (e.target === bg && !m.busy) return m.close();
    const b = e.target.closest('[data-ma]');
    if (!b || m.busy) return;
    if (b.dataset.ma === 'close') return m.close();
    await onAction(b.dataset.ma, m);
  });
  if (onMount) onMount(m);
  return m;
}
async function savePatch(p) {
  Object.assign(S, p);
  S = await X.patchSettings(p);
}

/* ------------------------------------------------------------------ *
 * 뼈대 (사이드 내비 + 상단)
 * ------------------------------------------------------------------ */
function renderShell() {
  $('#app').innerHTML = `<div class="app">
    <aside class="nav">
      <div class="brand"><div class="logo">${icon('sparkle', true)}</div><div class="grow"><b>NAI Folio</b><small>작업 노트 · v${chrome.runtime.getManifest().version}</small></div><button class="ib" id="themeBtn"></button></div>
      ${Object.entries(VIEWS).map(([k, v]) => `<button class="navi" data-v="${k}" title="${v.label}">${icon(v.icon)}<span>${v.label}</span><span class="n" data-n="${k}"></span></button>`).join('')}
      <div class="spacer"></div>
      <div id="side"></div>
    </aside>
    <main class="main"><header class="top" id="top"></header><section class="view" id="view"></section></main>
  </div>`;
  $('.nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (b) go(b.dataset.v);
  });
  $('#themeBtn').addEventListener('click', async () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    await savePatch({ theme: dark ? 'light' : 'dark' });
    X.applyTheme(S.theme, S.colors);
    syncThemeBtn();
    if (view === 'settings') render();
  });
  syncThemeBtn();
  $('#side').addEventListener('click', async (e) => {
    if (e.target.closest('[data-auto]')) return;
    const c = e.target.closest('[data-side]');
    if (!c) return;
    if (c.dataset.side === 'folder') {
      if (!F.root) connectFolder();
      else if (F.perm !== 'granted') regrant();
      else go('library');
    }
  });
  $('#side').addEventListener('change', async (e) => {
    if (e.target.matches('[data-auto]')) {
      await savePatch({ autoSave: e.target.checked });
      toast(S.autoSave ? '자동 저장을 켰어요' : '자동 저장을 껐어요', S.autoSave ? 'ok' : 'info');
    }
  });
}
function syncThemeBtn() {
  const b = $('#themeBtn');
  if (!b) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  b.innerHTML = icon(dark ? 'sun' : 'moon');
  b.title = dark ? '밝은 노트로' : '밤 노트로';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.theme === 'auto') { X.applyTheme(S.theme, S.colors); syncThemeBtn(); }
});

function renderSide() {
  const today = stats.day === X.today() ? stats.count : 0;
  const st = !F.root ? ['', '눌러서 폴더 연결'] : F.perm === 'granted' ? ['ok', '연결됨'] : ['warn', '권한 필요 · 눌러서 허용'];
  $('#side').innerHTML = `
    <div class="side-card" data-side="folder" style="cursor:pointer" title="${F.root ? esc(F.root.name) : '폴더 연결'}">
      <div class="h">${icon('folder')} 저장 폴더</div>
      <div class="v">${F.root ? esc(F.root.name) : '연결 안 됨'}</div>
      <div class="s"><span class="dotst ${st[0]}"></span>${st[1]}</div>
    </div>
    <div class="side-card">
      <div class="h">${icon('download')} 자동 저장 <span class="grow"></span>${sw('data-auto', S.autoSave)}</div>
      <div class="s">오늘 <b style="color:var(--fg)">${today}</b>장 저장 · ${S.saveMode === 'convert' ? '메타 제거 ' + ({ jpeg: 'JPG', webp: 'WebP' }[S.convFormat] || 'PNG') : '원본 PNG'}</div>
    </div>`;
  const n = (k, v) => { const el = $(`[data-n="${k}"]`); if (el) el.textContent = v || ''; };
  n('library', L.loaded ? L.files.filter((r) => !inTrash(r)).length.toLocaleString() : '');
  n('history', hist.length || '');
  n('dict', Object.keys(dict).length || '');
  n('snippets', Object.keys(snippets).length || '');
}
function renderTop(actions = '') {
  const v = VIEWS[view];
  $('#top').innerHTML = `<div class="grow"><h1>${v.title}${v.desc ? tip(v.desc) : ''}</h1></div>${actions}`;
}
function go(v) {
  if (location.hash.slice(1) !== v) location.hash = v;
  else render();
}
window.addEventListener('hashchange', () => { view = viewFromHash(); render(); });

function render() {
  document.querySelectorAll('.navi').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  renderSide();
  $('#view').scrollTop = 0;
  ({ library: viewLibrary, convert: viewConvert, translate: viewTranslate, snippets: viewSnippets, history: viewHistory, dict: viewDict, settings: viewSettings }[view])();
}

/* ------------------------------------------------------------------ *
 * 폴더 연결
 * ------------------------------------------------------------------ */
async function connectFolder() {
  try {
    const h = await window.showDirectoryPicker({ id: 'nai-studio', mode: 'readwrite', startIn: 'downloads' });
    await X.idbSet('kv', 'root', h);
    F.root = h;
    F.perm = 'granted';
    await chrome.storage.local.set({ folderName: h.name, folderPerm: 'granted' });
    resetLibrary();
    toast(`${h.name} 폴더를 연결했어요. 이제 생성하면 여기로 저장돼요`, 'ok', 3500);
    go('library');
    render();
  } catch (e) {
    if (e.name !== 'AbortError') toast('폴더를 연결하지 못했어요: ' + e.message, 'err');
  }
}
async function regrant() {
  try {
    F.perm = await X.permState(F.root, true);
  } catch (e) {
    F.perm = 'prompt';
    toast('폴더를 찾을 수 없어요. 옮겨졌거나 지워졌다면 다시 연결해 주세요', 'err', 4000);
  }
  await chrome.storage.local.set({ folderPerm: F.perm === 'granted' ? 'granted' : 'prompt' });
  if (F.perm === 'granted') { toast('권한을 다시 허용했어요', 'ok'); resetLibrary(); }
  render();
}
async function disconnectFolder() {
  if (!confirm('폴더 연결을 끊을까요? 폴더 안 파일은 그대로 남아요.')) return;
  await X.idbDel('kv', 'root');
  await chrome.storage.local.set({ folderName: '', folderPerm: 'none' });
  F.root = null;
  F.perm = 'none';
  resetLibrary();
  render();
}

/* ------------------------------------------------------------------ *
 * 라이브러리
 * ------------------------------------------------------------------ */
let savedScope = 'day';
try { savedScope = localStorage.getItem('nai-lib-scope') || 'day'; } catch (e) { /* 없음 */ }
const L = { scope: savedScope, day: null, days: [], loaded: false, loading: false, files: [], dirs: [], q: '', dir: '*', sort: 'new', limit: 150, sel: new Set(), anchor: -1, list: [], idx: { done: 0, total: 0 }, thumbs: new Map() };
const statQ = X.makeQueue(24), metaQ = X.makeQueue(3), thumbQ = X.makeQueue(4);
let indexGen = 0, tileIO = null, sentIO = null;

const inTrash = (r) => r.dirPath === TRASH || r.dirPath.startsWith(TRASH + '/');
const mkey = (r) => `${r.path}|${r.mtime}|${r.size}`;
const metaKey = (r) => 'm2|' + mkey(r); // 1.7.4: EXIF · 숨은 정보까지 읽도록 바뀌어서 다시 색인
function resetLibrary() {
  indexGen++;
  L.loaded = false; L.fail = ''; L.files = []; L.dirs = []; L.sel.clear(); L.list = [];
  L.thumbs.forEach((u) => URL.revokeObjectURL(u));
  L.thumbs.clear();
}

async function loadLibrary() {
  if (L.loading) return;
  L.loading = true;
  try {
    const { files, dirs } = await X.listImages(F.root, {
      onProgress: (n) => { const el = $('#lprog'); if (el) el.textContent = n.toLocaleString(); },
    });
    const [metaIdx, pngIdx] = await Promise.all([X.idbAll('meta'), X.idbAll('pngmeta')]);
    await Promise.all(files.map((r) => statQ(async () => {
      const f = await r.handle.getFile();
      r.size = f.size;
      r.mtime = f.lastModified;
    })));
    for (const r of files) {
      const k = metaKey(r);
      // 우선순위: 저장할 때 기억한 정보 → 색인 캐시 → (나중에 색인) 정보 파일 · PNG 안 정보
      r.meta = metaIdx.has(r.path) ? metaIdx.get(r.path)
        : pngIdx.has(k) && (pngIdx.get(k) || !r.side) ? pngIdx.get(k)
        : undefined;
    }
    L.files = files;
    L.dirs = dirs;
    L.loaded = true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      F.perm = 'prompt';
      chrome.storage.local.set({ folderPerm: 'prompt' });
    } else L.fail = e.name === 'NotFoundError' ? 'gone' : e.message || String(e); // 다시 그려도 무한히 다시 읽지 않게
  }
  L.loading = false;
  if (view === 'library') render();
  renderSide();
  if (L.loaded) indexMeta();
}

async function indexMeta() {
  const gen = ++indexGen;
  const todo = L.files.filter((r) => r.meta === undefined);
  L.idx = { done: 0, total: todo.length };
  updateIndexing();
  let last = Date.now();
  await Promise.all(todo.map((r) => metaQ(async () => {
    if (gen !== indexGen || r.meta !== undefined) { L.idx.done++; return; }
    try { r.meta = (await X.readSidecar(r.side)) || (await X.readImageMeta(await r.handle.getFile())); } catch (e) { r.meta = null; }
    X.idbSet('pngmeta', metaKey(r), r.meta).catch(() => {});
    L.idx.done++;
    if (Date.now() - last > 800) {
      last = Date.now();
      updateIndexing();
      if (L.q && view === 'library') refreshGrid();
    }
  })));
  if (gen !== indexGen) return;
  updateIndexing();
  if (L.q && view === 'library') refreshGrid();
}
function updateIndexing() {
  const el = $('#idx');
  if (!el) return;
  const { done, total } = L.idx;
  el.innerHTML = total && done < total ? `<span class="spin"></span> 프롬프트 색인 중 ${done.toLocaleString()} / ${total.toLocaleString()}` : '';
}

function computeList() {
  const terms = L.q.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const arr = L.files.filter((r) => {
    if (L.dir === '*') { if (inTrash(r)) return false; }
    else if (L.dir === TRASH) { if (!inTrash(r)) return false; }
    else if (!(r.dirPath === L.dir || r.dirPath.startsWith(L.dir + '/'))) return false;
    if (!terms.length) return true;
    const m = r.meta || {};
    const hay = `${r.name} ${m.prompt || ''} ${(m.chars || []).join(' ')} ${m.neg || ''} ${m.seed != null ? 'seed:' + m.seed : ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  // 폴더로 나눠져 있으면 다 보여 줄 필요 없이 하루치만 (검색할 땐 전부)
  const follow = !L.day || L.day === L.days[0]; // 가장 최근 날을 보고 있었으면 새 날짜가 생겨도 따라감
  L.days = [];
  let out = arr;
  const cur = L.dir === '*' ? '' : L.dir;
  const hasSub = L.dir !== TRASH && arr.some((r) => r.dirPath !== cur);
  if (!terms.length && hasSub && L.scope !== 'all') {
    const byDay = new Map();
    for (const r of arr) { const k = dayKey(r.mtime); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
    L.days = [...byDay.keys()].sort().reverse();
    if (follow || !L.days.includes(L.day)) L.day = L.days[0];
    out = byDay.get(L.day) || [];
  }
  const by = {
    new: (a, b) => b.mtime - a.mtime,
    old: (a, b) => a.mtime - b.mtime,
    name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }),
    size: (a, b) => b.size - a.size,
  }[L.sort];
  return out.sort(by);
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${X.pad(d.getMonth() + 1)}-${X.pad(d.getDate())}`; };
function dayNavHTML() {
  const box = $('#dayNav');
  if (!box) return;
  const showSeg = L.days.length || L.scope === 'all';
  const cur = L.dir === '*' ? '' : L.dir;
  const canDay = !L.q.trim() && L.dir !== TRASH && L.files.some((r) => (cur ? r.dirPath.startsWith(cur + '/') : r.dirPath !== '') && !inTrash(r));
  if (!canDay && !showSeg) { box.innerHTML = ''; return; }
  const i = L.days.indexOf(L.day);
  const label = L.day === X.today() ? '오늘' : L.day === dayKey(Date.now() - 864e5) ? '어제' : '';
  box.innerHTML = `${L.days.length ? `<span class="daynav"><button class="ib" data-day="1" ${i >= L.days.length - 1 ? 'disabled' : ''} title="이전 날">${icon('left')}</button>
      <b>${esc(L.day)}</b>${label ? `<small>${label}</small>` : ''}
      <button class="ib" data-day="-1" ${i <= 0 ? 'disabled' : ''} title="다음 날">${icon('right')}</button></span>` : ''}
    ${canDay ? `<span class="seg sm"><button data-scope="day" class="${L.scope !== 'all' ? 'on' : ''}">하루씩</button><button data-scope="all" class="${L.scope === 'all' ? 'on' : ''}">전체</button></span>` : ''}`;
}

function viewLibrary() {
  if (!F.root) return viewOnboard();
  if (F.perm !== 'granted') return viewRegrant();
  renderTop(`<div class="row">
      <span class="cnt" title="썸네일 크기">${icon('grid').replace('<svg', '<svg style="width:15px;height:15px;display:inline"')}</span>
      <input type="range" min="140" max="360" value="${S.tile}" id="tileSize" style="--p:${((S.tile - 140) / 220) * 100}%;width:120px">
      <button class="btn sm" id="reload" title="폴더 다시 읽기">${icon('refresh')} 새로고침</button>
    </div>`);
  document.documentElement.style.setProperty('--tile', S.tile + 'px');
  $('#tileSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    S.tile = v;
    e.target.style.setProperty('--p', ((v - 140) / 220) * 100 + '%');
    document.documentElement.style.setProperty('--tile', v + 'px');
    clearTimeout(viewLibrary.t);
    viewLibrary.t = setTimeout(() => savePatch({ tile: v }), 400);
  });
  $('#reload').addEventListener('click', () => { resetLibrary(); render(); });

  if (!L.loaded && L.fail) {
    const gone = L.fail === 'gone';
    const w0 = mount(`<div class="onboard"><div class="big">${icon(gone ? 'folderOpen' : 'alert')}</div>
      <h2>${gone ? `${esc(F.root.name)} 폴더를 찾을 수 없어요` : '폴더를 읽지 못했어요'}</h2>
      <p>${gone ? '폴더가 지워졌거나 이름 · 위치가 바뀌었어요.' : esc(L.fail)}</p>
      <div class="row" style="justify-content:center"><button class="btn pri lg" id="reconnect">${icon('folder')} 폴더 다시 연결</button><button class="btn lg" id="retry">다시 읽기</button></div></div>`);
    $('#reconnect', w0).addEventListener('click', connectFolder);
    $('#retry', w0).addEventListener('click', () => { L.fail = ''; render(); });
    return;
  }
  if (!L.loaded) {
    mount(`<div class="empty"><div class="spin" style="width:30px;height:30px;margin:0 auto 16px;border-width:3px"></div>
      ${esc(F.root.name)} 읽는 중… <b id="lprog">0</b>장</div>`);
    loadLibrary();
    return;
  }
  if (!L.files.length) {
    mount(`<div class="empty">${icon('images')}<b style="color:var(--fg);font-size:14px;font-weight:600">${esc(F.root.name)} 폴더가 비어 있어요</b><br>
      <span style="font-size:12.5px">${S.autoSave ? '생성하면 여기에 나타나요' : '자동 저장이 꺼져 있어요'}</span></div>`);
    return;
  }
  const w = mount(`
    <div class="libbar">
      <div class="row">
        <div class="search">${icon('search')}<input class="in" id="q" placeholder="프롬프트 · 파일 이름 검색 — 쉼표로 여러 개 (예: blonde, smile)" value="${esc(L.q)}"></div>
        <select class="sel" id="sort">
          ${[['new', '최신순'], ['old', '오래된순'], ['name', '이름순'], ['size', '큰 파일순']].map(([k, l]) => `<option value="${k}" ${L.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="crumbs" id="crumbs"></div>
    </div>
    <div class="folders" id="dirs"></div>
    <div class="row" style="margin:0 0 12px"><span id="dayNav" class="row" style="gap:8px"></span><span class="cnt" id="lcount"></span><span class="indexing" id="idx"></span><span class="grow"></span>
      <button class="btn sm ${L.pickMode ? 'pri' : ''}" id="selMode" title="눌러서 여러 장 고르기 → 변환 · 이동 · ZIP">${icon('check')} ${L.pickMode ? '선택 끝' : '선택'}</button>
      <button class="btn sm ghost" id="selAll">전체 선택</button></div>
    <div class="gridx" id="grid"></div>
    <div class="sentinel" id="sent"></div>
    <div id="selbarBox"></div>`);
  renderDirs();
  refreshGrid();
  updateIndexing();

  const q = $('#q', w);
  q.addEventListener('input', () => {
    L.q = q.value;
    clearTimeout(q.t);
    q.t = setTimeout(() => { L.limit = 150; refreshGrid(); }, 140);
  });
  $('#sort', w).addEventListener('change', (e) => { L.sort = e.target.value; refreshGrid(); });
  $('#selMode', w).addEventListener('click', (e) => {
    L.pickMode = !L.pickMode;
    if (!L.pickMode) L.sel.clear();
    const b = e.currentTarget;
    b.classList.toggle('pri', L.pickMode);
    b.innerHTML = `${icon('check')} ${L.pickMode ? '선택 끝' : '선택'}`;
    refreshGrid(true);
  });
  $('#selAll', w).addEventListener('click', () => {
    if (L.sel.size === L.list.length) L.sel.clear();
    else L.list.forEach((r) => L.sel.add(r.path));
    refreshGrid(true);
  });
  const onDirClick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (!b) return;
    L.dir = b.dataset.dir;
    L.day = null;
    L.sel.clear();
    L.limit = 150;
    renderDirs();
    refreshGrid();
    $('#view').scrollTop = 0;
  };
  $('.libbar', w).addEventListener('click', onDirClick);
  $('#dayNav', w).addEventListener('click', (e) => {
    const d = e.target.closest('[data-day]'), s = e.target.closest('[data-scope]');
    if (d) { const i = L.days.indexOf(L.day) + +d.dataset.day; if (L.days[i]) L.day = L.days[i]; }
    else if (s) { L.scope = s.dataset.scope; try { localStorage.setItem('nai-lib-scope', L.scope); } catch (err) { /* 없음 */ } }
    else return;
    L.sel.clear();
    refreshGrid();
  });
  $('#dirs', w).addEventListener('click', onDirClick);
  const grid = $('#grid', w);
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const i = +t.dataset.i;
    if (e.target.closest('[data-ck]') || e.ctrlKey || e.metaKey || L.sel.size || L.pickMode) {
      if (e.shiftKey && L.anchor >= 0) selectRange(L.anchor, i);
      else toggleSel(i);
      return;
    }
    if (e.shiftKey) { toggleSel(i); return; }
    openLightbox(i);
  });
  grid.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const p = t.querySelector('.ov .p');
    const r = L.list[+t.dataset.i];
    if (p && !p.textContent && r && r.meta && r.meta.prompt) p.textContent = r.meta.prompt;
  });
  if (sentIO) sentIO.disconnect();
  sentIO = new IntersectionObserver((ents) => {
    if (!ents.some((e) => e.isIntersecting) || L.limit >= L.list.length) return;
    const from = L.limit;
    L.limit += 150;
    const g = $('#grid');
    g.insertAdjacentHTML('beforeend', L.list.slice(from, L.limit).map((r, k) => tileHTML(r, from + k)).join(''));
    [...g.children].slice(from).forEach((el) => tileIO.observe(el));
  }, { root: $('#view'), rootMargin: '900px' });
  sentIO.observe($('#sent', w));
}

// 폴더 탐색: 위쪽은 지금 위치(빵가루), 아래는 지금 폴더 바로 안의 폴더들
function renderDirs() {
  const box = $('#dirs'), cr = $('#crumbs');
  if (!box || !cr) return;
  const count = (d) => L.files.filter((r) => r.dirPath === d || r.dirPath.startsWith(d + '/')).length;
  const cur = L.dir === '*' ? '' : L.dir;
  const segs = cur ? cur.split('/') : [];
  cr.innerHTML = [`<button data-dir="*" class="${cur ? '' : 'cur'}">${icon('images').replace('<svg', '<svg style="display:inline;width:14px;height:14px;vertical-align:-2px;margin-right:4px"')}${esc(F.root.name)}</button>`]
    .concat(segs.map((s, i) => {
      const p = segs.slice(0, i + 1).join('/');
      return `<span class="sl">›</span><button data-dir="${esc(p)}" class="${i === segs.length - 1 ? 'cur' : ''}">${esc(p === TRASH ? '휴지통' : s)}</button>`;
    })).join('');
  // 중간 폴더도 빠짐없이 (a/b/c 가 있으면 a, a/b 도)
  const all = new Set();
  for (const d of [...L.dirs, ...L.files.map((r) => r.dirPath)]) {
    const parts = String(d || '').split('/').filter(Boolean);
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join('/')));
  }
  const parentOf = (d) => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
  const kids = [...all].filter((d) => parentOf(d) === cur && d !== TRASH).map((d) => [d, count(d)]).filter(([, c]) => c > 0);
  // 날짜·숫자 폴더는 최신이 앞으로, 이름 폴더는 가나다순
  kids.sort((a, b) => {
    const an = a[0].split('/').pop(), bn = b[0].split('/').pop();
    return /^\d/.test(an) && /^\d/.test(bn) ? bn.localeCompare(an, 'ko', { numeric: true }) : an.localeCompare(bn, 'ko', { numeric: true });
  });
  const trashN = cur ? 0 : L.files.filter(inTrash).length;
  // 폴더 카드: 노란 폴더 사이로 최근 사진 3장이 삐죽
  const newest = (pred) => L.files.filter(pred).sort((a, b) => b.mtime - a.mtime).slice(0, 3);
  const under = (d) => (r) => r.dirPath === d || r.dirPath.startsWith(d + '/');
  const cards = kids.map(([d, c]) => ({ d, c, name: d.split('/').pop(), pics: newest(under(d)) }));
  if (trashN) cards.push({ d: TRASH, c: trashN, name: '휴지통', pics: newest(inTrash), trash: true });
  box.innerHTML = cards.length ? `<div class="fh">${icon('folder')} 폴더</div><div class="fgrid">${cards.map((k, i) => `
    <button class="fcard${k.trash ? ' trash' : ''}" data-dir="${esc(k.d)}" title="${esc(k.d === TRASH ? '휴지통' : k.d)}">
      <span class="fold"><span class="back"></span>${k.pics.map((r, j) => `<img class="ph p${j}" data-fi="${i}-${j}" alt="">`).join('')}<span class="front">${k.trash ? icon('trash') : ''}</span></span>
      <b>${esc(k.name)}</b><small>${k.c.toLocaleString()}장</small></button>`).join('')}</div>` : '';
  box.hidden = !cards.length;
  cards.forEach((k, i) => k.pics.forEach((r, j) => loadThumb(r).then((u) => {
    const im = box.querySelector(`[data-fi="${i}-${j}"]`);
    if (u && im) { im.onload = () => im.classList.add('ld'); im.src = u; }
  })));
}

function tileHTML(r, i) {
  const m = r.meta;
  const ext = r.name.split('.').pop().toUpperCase();
  return `<div class="tile${L.sel.has(r.path) ? ' picked' : ''}${r.fresh ? ' fresh' : ''}" data-i="${i}">
    <img alt="" draggable="false" decoding="async">
    <button class="ck" data-ck title="선택 (Ctrl+클릭 · Shift+클릭 범위)">${icon('check')}</button>
    <div class="bdg">${r.fresh ? '<span class="new">NEW</span>' : ''}${ext !== 'PNG' ? `<span>${ext}</span>` : ''}</div>
    <div class="ov"><div class="p">${esc((m && m.prompt) || '')}</div><div class="m" title="${esc(r.path)}">${fmtTime(r.mtime)} · ${fmtBytes(r.size)}</div></div>
  </div>`;
}

function refreshGrid(keepLimit) {
  const grid = $('#grid');
  if (!grid) return;
  const prevScroll = $('#view').scrollTop;
  L.list = computeList();
  if (!keepLimit) L.limit = Math.max(150, Math.min(L.limit, 150));
  const total = L.list.reduce((a, r) => a + r.size, 0);
  $('#lcount').textContent = `${L.list.length.toLocaleString()}장 · ${fmtBytes(total)}`;
  dayNavHTML();
  grid.classList.toggle('selecting', L.sel.size > 0 || !!L.pickMode);
  grid.innerHTML = L.list.length
    ? L.list.slice(0, L.limit).map((r, i) => tileHTML(r, i)).join('')
    : `<div class="empty" style="grid-column:1/-1">${icon('search')}${L.q ? '검색 결과가 없어요' + (L.idx.done < L.idx.total ? ' — 아직 색인 중이라 조금 뒤에 더 나올 수 있어요' : '') : '이 폴더엔 이미지가 없어요'}</div>`;
  if (tileIO) tileIO.disconnect();
  tileIO = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      tileIO.unobserve(e.target);
      const r = L.list[+e.target.dataset.i];
      if (!r) continue;
      loadThumb(r).then((url) => {
        const img = e.target.querySelector('img');
        if (!url || !img) return;
        img.onload = () => img.classList.add('ld');
        img.src = url;
      });
    }
  }, { root: $('#view'), rootMargin: '700px' });
  grid.querySelectorAll('.tile').forEach((t) => tileIO.observe(t));
  if (keepLimit) $('#view').scrollTop = prevScroll;
  renderSelbar();
}

function loadThumb(r) {
  const k = mkey(r);
  if (L.thumbs.has(k)) return Promise.resolve(L.thumbs.get(k));
  return thumbQ(async () => {
    if (L.thumbs.has(k)) return L.thumbs.get(k);
    let b = await X.idbGet('thumbs', k).catch(() => null);
    if (!b) {
      b = await X.makeThumb(await r.handle.getFile(), 420);
      X.idbSet('thumbs', k, b).catch(() => {});
    }
    const url = URL.createObjectURL(b);
    L.thumbs.set(k, url);
    return url;
  }).catch(() => null);
}

function toggleSel(i) {
  const r = L.list[i];
  if (!r) return;
  if (L.sel.has(r.path)) L.sel.delete(r.path); else L.sel.add(r.path);
  L.anchor = i;
  const t = $(`.tile[data-i="${i}"]`);
  if (t) t.classList.toggle('picked', L.sel.has(r.path));
  $('#grid').classList.toggle('selecting', L.sel.size > 0 || !!L.pickMode);
  renderSelbar();
}
function selectRange(a, b) {
  const [s, e] = a < b ? [a, b] : [b, a];
  for (let i = s; i <= e; i++) {
    const r = L.list[i];
    if (!r) continue;
    L.sel.add(r.path);
    const t = $(`.tile[data-i="${i}"]`);
    if (t) t.classList.add('picked');
  }
  L.anchor = b;
  $('#grid').classList.toggle('selecting', true);
  renderSelbar();
}
const selected = () => L.list.filter((r) => L.sel.has(r.path));
function exitPick() {
  L.sel.clear();
  L.pickMode = false;
  const b = $('#selMode');
  if (b) { b.classList.remove('pri'); b.innerHTML = `${icon('check')} 선택`; }
  refreshGrid(true);
}

function renderSelbar() {
  const box = $('#selbarBox');
  if (!box) return;
  const n = L.sel.size;
  if (!n) { box.innerHTML = ''; return; }
  const trashMode = L.dir === TRASH || L.dir.startsWith(TRASH + '/');
  box.innerHTML = `<div class="selbar"><b>${n}장 선택</b>
    ${trashMode
      ? `<button class="btn sm" data-sa="restore">${icon('undo')} 복원</button><button class="btn sm danger" data-sa="purge">${icon('trash')} 영구 삭제</button>`
      : `${n === 1 ? `<button class="btn sm" data-sa="copy">${icon('copy')} 프롬프트</button><button class="btn sm" data-sa="rename">${icon('pencil')} 이름</button>` : ''}
         <button class="btn sm pri" data-sa="convert">${icon('shield')} 메타 제거 변환</button>
         <button class="btn sm" data-sa="move">${icon('move')} 이동</button>
         <button class="btn sm" data-sa="zip">${icon('zip')} ZIP</button>
         <button class="btn sm" data-sa="side" title="이미지 옆에 생성 정보 .txt / .json 만들기">${icon('file')} 정보 파일</button>
         <button class="btn sm danger" data-sa="trash">${icon('trash')} 휴지통</button>`}
    <button class="ib" data-sa="clear" title="선택 해제 (Esc)">${icon('x')}</button></div>`;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-sa]');
    if (!b) return;
    const recs = selected();
    const a = b.dataset.sa;
    if (a === 'clear') exitPick();
    else if (a === 'rename') { const i = L.list.indexOf(recs[0]); if (i >= 0) { LB.renameNext = true; openLightbox(i); } }
    else if (a === 'copy') copyText((recs[0].meta && recs[0].meta.prompt) || '', '프롬프트를 복사했어요');
    else if (a === 'convert') openConvertModal(recs);
    else if (a === 'move') openMoveModal(recs);
    else if (a === 'zip') zipRecs(recs);
    else if (a === 'side') makeSidecarsBulk(recs);
    else if (a === 'trash') trashRecs(recs);
    else if (a === 'restore') restoreRecs(recs);
    else if (a === 'purge') purgeRecs(recs);
  };
}

// 이미지를 옮길 때 같은 이름의 .txt / .json 도 같이
async function moveRec(r, dest, wantName) {
  const res = await X.moveFile(F.root, r, dest, wantName);
  res.side = null;
  if (r.side) {
    const dir = await X.getDir(F.root, dest);
    res.side = {};
    for (const [ext, s] of Object.entries(r.side)) {
      try {
        const mv = await X.moveFile(F.root, { name: s.name, handle: s.handle, dir: r.dir }, dest, `${X.baseName(res.name)}.${ext}`);
        res.side[ext] = { name: mv.name, handle: await dir.getFileHandle(mv.name) };
      } catch (e) { console.warn('정보 파일 이동 실패', e); }
    }
  }
  const m = await X.idbGet('meta', r.path).catch(() => null);
  if (m) { await X.idbSet('meta', res.path, m); await X.idbDel('meta', r.path); }
  return res;
}
const sideFmt = () => (S.sidecar && S.sidecar !== 'none' ? S.sidecar : 'both');
async function metaOf(r) {
  if (r.meta === undefined) {
    r.meta = (await X.readSidecar(r.side)) || (await X.readImageMeta(await r.handle.getFile()).catch(() => null));
  }
  return r.meta;
}
// 정보 파일이 없는 이미지에 만들어 줌 (PNG 안 정보 · 저장 때 기억한 정보에서)
async function makeSidecarsFor(r) {
  const m = await metaOf(r);
  if (!m || !(m.prompt || m.neg)) return false;
  const done = await X.writeSidecars(r.dir, r.name, m, r.mtime, sideFmt());
  r.side = r.side || {};
  for (const ext of done) {
    const name = `${X.baseName(r.name)}.${ext}`;
    r.side[ext] = { name, handle: await r.dir.getFileHandle(name) };
  }
  return done.length > 0;
}
async function makeSidecarsBulk(recs) {
  let made = 0, none = 0;
  const { fail } = await batch(recs, '정보 파일 만드는 중', async (r) => { if (await makeSidecarsFor(r)) made++; else none++; });
  toast(`${made}장에 정보 파일을 만들었어요${none ? ` · ${none}장은 생성 정보가 없어서 건너뜀` : ''}${fail ? ` · ${fail}장 실패` : ''}`, fail ? 'err' : 'ok', 4000);
}
async function batch(recs, label, fn) {
  const m = modal({ title: label, body: `<div class="prog"><i></i></div><div class="cnt" id="bp">0 / ${recs.length}</div>`, actions: [], onAction() {} });
  m.busy = true;
  let ok = 0, fail = 0;
  for (const r of recs) {
    try { await fn(r); ok++; } catch (e) { fail++; console.warn(e); }
    $('.prog i', m.el).style.width = ((ok + fail) / recs.length) * 100 + '%';
    $('#bp', m.el).textContent = `${ok + fail} / ${recs.length}`;
  }
  m.close();
  L.sel.clear();
  resetLibrary();
  render();
  return { ok, fail };
}
async function trashRecs(recs) {
  const { ok, fail } = await batch(recs, '휴지통으로 옮기는 중', (r) => moveRec(r, r.dirPath ? `${TRASH}/${r.dirPath}` : TRASH));
  toast(`${ok}장을 휴지통(${TRASH} 폴더)으로 옮겼어요${fail ? ` · ${fail}장 실패` : ''}`, fail ? 'err' : 'ok');
}
async function restoreRecs(recs) {
  const { ok, fail } = await batch(recs, '복원하는 중', (r) => moveRec(r, r.dirPath === TRASH ? '' : r.dirPath.slice(TRASH.length + 1)));
  toast(`${ok}장을 원래 폴더로 복원했어요${fail ? ` · ${fail}장 실패` : ''}`, fail ? 'err' : 'ok');
}
async function purgeRecs(recs) {
  if (!confirm(`${recs.length}장을 영구 삭제할까요? 되돌릴 수 없어요.`)) return;
  const { ok, fail } = await batch(recs, '영구 삭제하는 중', async (r) => {
    await r.dir.removeEntry(r.name);
    if (r.side) for (const s of Object.values(r.side)) await r.dir.removeEntry(s.name).catch(() => {});
    X.idbDel('meta', r.path).catch(() => {});
  });
  toast(`${ok}장을 영구 삭제했어요${fail ? ` · ${fail}장 실패` : ''}`, fail ? 'err' : 'ok');
}
async function zipRecs(recs) {
  toast(`${recs.length}장 ZIP 만드는 중…`, 'info', 1500);
  const used = new Set();
  const files = [];
  for (const r of recs) {
    let n = r.name, k = 2;
    while (used.has(n)) n = r.name.replace(/(\.[^.]+)$/, `_${k++}$1`);
    used.add(n);
    files.push({ name: n, blob: await r.handle.getFile() });
  }
  await downloadBlob(await X.makeZip(files), `NAI_${X.stamp()}.zip`);
  toast('ZIP 다운로드를 시작했어요', 'ok');
}

function openMoveModal(recs) {
  const dirs = L.dirs.filter((d) => d !== TRASH && !d.startsWith(TRASH + '/'));
  modal({
    title: `${recs.length}장을 다른 폴더로 이동`,
    body: `<div style="max-height:280px;overflow:auto;margin-bottom:10px">
        <label class="radio"><input type="radio" name="md" value="" checked><div><div class="rt">${esc(F.root.name)} (맨 위)</div></div></label>
        ${dirs.map((d) => `<label class="radio"><input type="radio" name="md" value="${esc(d)}"><div><div class="rt">${esc(d)}</div></div></label>`).join('')}
      </div>
      <label class="radio"><input type="radio" name="md" value="__new"><div class="grow"><div class="rt">새 폴더</div>
        <input class="in" id="newDir" placeholder="예: 즐겨찾기/캐릭터A" style="margin-top:6px;height:36px"></div></label>`,
    actions: [{ label: '취소', act: 'close' }, { label: '이동', cls: 'pri', act: 'go' }],
    onMount(m) { $('#newDir', m.el).addEventListener('focus', () => { $('input[value="__new"]', m.el).checked = true; }); },
    async onAction(act, m) {
      if (act !== 'go') return;
      let dest = $('input[name="md"]:checked', m.el).value;
      if (dest === '__new') {
        dest = X.sanitizePath($('#newDir', m.el).value);
        if (!dest) { toast('새 폴더 이름을 적어 주세요', 'info'); return; }
      }
      m.close();
      const { ok, fail } = await batch(recs, '옮기는 중', (r) => moveRec(r, dest));
      toast(`${ok}장을 ${dest || '맨 위 폴더'}(으)로 옮겼어요${fail ? ` · ${fail}장 실패` : ''}`, fail ? 'err' : 'ok');
    },
  });
}

function colorsHTML() {
  const t = X.effectiveTheme(S.theme);
  const c = Object.assign({}, X.COLOR_DEFAULTS[t], (S.colors && S.colors[t]) || {});
  const cur = (S.colors && S.colors.preset) || (S.colors && (S.colors.light || S.colors.dark) ? '' : 'default');
  const dots = (p) => { const v = Object.assign({}, X.COLOR_DEFAULTS[t], p[t]); return ['acc', 'base', 'char', 'neg'].map((k) => `<i style="background:${v[k]}"></i>`).join(''); };
  return `<div class="opt"><div class="t"><div class="a">색 ${tip(`묶음을 고르거나, 아래 동그라미로 직접 바꿔요. 직접 바꾼 색은 지금 보이는 ${t === 'dark' ? '밤' : '밝은'} 노트에만 적용돼요`)}</div></div></div>
    <div class="cpre">${X.COLOR_PRESETS.map((p) => `<button class="${cur === p.id ? 'on' : ''}" data-cpre="${p.id}"><span class="dots">${dots(p)}</span>${p.name}</button>`).join('')}${cur ? '' : '<button class="on" disabled><span class="dots"><i style="background:conic-gradient(#c8327f,#a07e00,#0080b8,#c8327f)"></i></span>내 색</button>'}</div>
    <div class="colors">${X.COLOR_KEYS.map(([k, l]) => `<label class="colk"><input type="color" data-col="${k}" value="${c[k]}"><span style="color:${c[k]}">${l}</span></label>`).join('')}</div>`;
}

/* ---------- 변환 옵션 UI (모달 · 변환 화면 공용) ---------- */
function convOptsHTML(o) {
  const qOn = o.format !== 'png';
  return `
    <div class="opt"><div class="t"><div class="a">형식 ${tip(`어떤 형식이든 EXIF · 메타데이터는 전부 빠져요. 원래 형식은 PNG 는 PNG 로, JPG 는 JPG 로`)}</div></div>
      <div class="seg">${['original', 'jpeg', 'png', 'webp'].map((k) => `<button data-fmt="${k}" class="${o.format === k ? 'on' : ''}">${k === 'original' ? '원래대로' : X.FMT_LABEL[k]}</button>`).join('')}</div></div>
    <div class="opt" data-qrow style="${qOn ? '' : 'opacity:.4;pointer-events:none'}"><div class="t"><div class="a">품질 ${tip(`98 이면 눈으로 차이가 거의 없어요. 낮출수록 용량이 줄어요`)}</div></div>
      <input type="range" min="50" max="100" value="${o.quality}" data-o="quality" style="--p:${((o.quality - 50) / 50) * 100}%"><span class="val">${o.quality}</span></div>
    <div class="opt"><div class="t"><div class="a">크기</div></div>
      <select class="sel" data-o="scale">${[100, 75, 50, 25].map((v) => `<option value="${v}" ${o.scale === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></div>
    <div class="opt"><div class="t"><div class="a">숨은 정보 지우기 ${tip(`NovelAI 가 픽셀 속(알파채널 최하위 비트)에 숨기는 생성 정보까지 지워요. 눈으로는 차이가 없어요 (권장)`)}</div></div>
      ${sw('data-o="scrub"', o.scrub)}</div>
    <div class="opt" data-bgrow ${o.format === 'jpeg' ? '' : 'hidden'}><div class="t"><div class="a">JPG 배경 ${tip(`투명한 부분을 채울 색`)}</div></div>
      <input type="color" value="${esc(o.bg)}" data-o="bg" title="배경색"></div>`;
}
function bindConvOpts(el, o, onChange) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (!b) return;
    o.format = b.dataset.fmt;
    el.querySelectorAll('[data-fmt]').forEach((x) => x.classList.toggle('on', x === b));
    const q = el.querySelector('[data-qrow]');
    q.style.cssText = o.format === 'png' ? 'opacity:.4;pointer-events:none' : '';
    el.querySelector('[data-bgrow]').hidden = o.format !== 'jpeg';
    if (onChange) onChange();
  });
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.o;
    if (k !== 'quality') return;
    o.quality = +e.target.value;
    e.target.style.setProperty('--p', ((o.quality - 50) / 50) * 100 + '%');
    e.target.nextElementSibling.textContent = o.quality;
    if (onChange) onChange();
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.o;
    if (k === 'scale') o.scale = +e.target.value;
    else if (k === 'bg') o.bg = e.target.value;
    else if (k === 'scrub') o.scrub = e.target.checked;
    else return;
    if (onChange) onChange();
  });
}
const optsToSettings = (o) => ({ convFormat: o.format, convQuality: o.quality, convScale: o.scale, convBg: o.bg, convScrub: o.scrub });

async function convertMany(items, o, dest, onProg) {
  const outs = [], used = new Set();
  const sub = `${CONV_DIR}/${X.today()}`;
  let done = 0, fail = 0, inB = 0, outB = 0;
  for (const it of items) {
    try {
      const src = await it.getBlob();
      inB += src.size;
      const b = await X.convertBlob(src, o);
      outB += b.size;
      const ext = X.EXT[X.blobKind(b)];
      const base = X.sanitizeDir(it.outBase || X.baseName(it.name)) || 'image';
      if (dest === 'folder') {
        const wr = await X.writeFile(F.root, sub, `${base}.${ext}`, b);
        // 메타를 지운 사본도 내 폴더 안에선 생성 정보 파일을 옆에 남겨 둠 (ZIP · 다운로드엔 안 넣음)
        if (S.sidecar !== 'none') {
          let meta = it.meta;
          if (meta === undefined) meta = (await X.readSidecar(it.side)) || (await X.readImageMeta(src).catch(() => null));
          if (meta) await X.writeSidecars(wr.dir, wr.name, meta, Date.now(), S.sidecar).catch(() => {});
        }
      } else {
        let n = `${base}.${ext}`, k = 2;
        while (used.has(n)) n = `${base}_${k++}.${ext}`;
        used.add(n);
        outs.push({ name: n, blob: b });
      }
      it.status = 'done';
      it.outSize = b.size;
    } catch (e) {
      fail++;
      it.status = 'err';
      it.err = e.message;
    }
    done++;
    if (onProg) onProg(done, items.length, it);
  }
  if (outs.length) {
    if (dest === 'zip' && outs.length > 1) await downloadBlob(await X.makeZip(outs), `NAI_변환_${X.stamp()}.zip`);
    else for (const f of outs) { await downloadBlob(f.blob, f.name); await X.sleep(200); }
  }
  return { ok: done - fail, fail, inB, outB, sub };
}
const destRadios = (cur, folderOk) => `
  ${folderOk ? `<label class="radio"><input type="radio" name="dest" value="folder" ${cur === 'folder' ? 'checked' : ''}><div><div class="rt">내 폴더에 저장</div><div class="rd">${esc(F.root.name)}/${CONV_DIR}/${X.today()}${S.sidecar !== 'none' ? ' · 생성 정보 파일도 옆에 남겨요' : ''}</div></div></label>` : ''}
  <label class="radio"><input type="radio" name="dest" value="zip" ${cur === 'zip' ? 'checked' : ''}><div><div class="rt">ZIP 하나로 다운로드</div><div class="rd">여러 장을 한 파일로</div></div></label>
  <label class="radio"><input type="radio" name="dest" value="files" ${cur === 'files' ? 'checked' : ''}><div><div class="rt">한 장씩 다운로드</div></div></label>`;

function openConvertModal(recs) {
  const o = X.convOpts(S);
  modal({
    title: `${recs.length}장 메타데이터 제거 변환`,
    body: `<div id="co">${convOptsHTML(o)}</div><div class="lbl" style="margin-top:14px">저장할 곳</div>${destRadios('folder', true)}
      <div id="cp" hidden><div class="prog"><i></i></div><div class="cnt" id="cpt"></div></div>`,
    actions: [{ label: '취소', act: 'close' }, { label: `${icon('shield')} 변환 시작`, cls: 'pri', act: 'go' }],
    onMount(m) { bindConvOpts($('#co', m.el), o); },
    async onAction(act, m) {
      if (act !== 'go') return;
      savePatch(optsToSettings(o));
      const dest = $('input[name="dest"]:checked', m.el).value;
      m.busy = true;
      m.el.querySelectorAll('[data-ma]').forEach((b) => (b.disabled = true));
      $('#cp', m.el).hidden = false;
      const items = recs.map((r) => ({ name: r.name, meta: r.meta, side: r.side, getBlob: () => r.handle.getFile() }));
      const res = await convertMany(items, o, dest, (d, t) => {
        $('#cp .prog i', m.el).style.width = (d / t) * 100 + '%';
        $('#cpt', m.el).textContent = `${d} / ${t}`;
      });
      m.close();
      const pct = res.inB ? Math.round((1 - res.outB / res.inB) * 100) : 0;
      toast(`${res.ok}장 변환 완료 · ${fmtBytes(res.inB)} → ${fmtBytes(res.outB)}${pct > 0 ? ` (-${pct}%)` : ''}${dest === 'folder' ? ` · ${res.sub}` : ''}${res.fail ? ` · ${res.fail}장 실패` : ''}`, res.fail ? 'err' : 'ok', 4000);
      if (dest === 'folder') { L.sel.clear(); resetLibrary(); render(); }
    },
  });
}

/* ---------- 생성 정보 보기 (novelai.net/inspect 처럼: 기본 정보 + 간단히 / 원본 설정) ---------- */
const VIA = { png: 'PNG 글자 정보', exif: 'EXIF', stealth: '숨은 정보 (알파채널)', sidecar: '정보 파일', capture: '저장할 때 기록' };
let metaTab = 'simple';
try { metaTab = localStorage.getItem('nai-meta-tab') || 'simple'; } catch (e) { /* 없음 */ }
function metaBodyHTML(m) {
  if (!m || !(m.prompt || m.neg)) return `<div class="empty" style="padding:40px 10px">${icon('info')}생성 정보가 없어요 ${tip('메타데이터가 지워졌거나 다른 프로그램에서 만든 이미지예요. PNG 글자 정보 · EXIF · 알파채널 숨은 정보까지 다 찾아봤어요')}</div>`;
  const param = (k, v) => (v != null && v !== '' ? `<div><small>${k}</small><span>${esc(v)}</span></div>` : '');
  const hrow = (k, v) => (v ? `<div><small>${k}</small><span>${v}</span></div>` : '');
  const blk = (cls, label, key, text) => `<div class="blk ${cls}"><div class="bh">${label}<span class="grow"></span><button class="btn sm ghost" data-copy="${key}" title="복사">${icon('copy')}</button></div><div class="bt">${esc(text || '—')}</div></div>`;
  const kind = [X.REQ_TYPE[m.reqType] || '', ...(m.extras || [])].filter(Boolean).join(' · ');
  const raw = m.params ? JSON.stringify(m.params, null, 2) : '';
  const simple = `
    ${blk('base', '프롬프트', 'prompt', m.prompt)}
    ${(m.chars || []).map((c, k) => blk('char', `캐릭터 ${k + 1}`, 'char' + k, c) + ((m.charNegs || [])[k] ? blk('neg sub', `캐릭터 ${k + 1} 네거티브`, 'cneg' + k, m.charNegs[k]) : '')).join('')}
    ${m.neg ? blk('neg', '네거티브', 'neg', m.neg) : ''}
    <div class="params">${param('크기', m.w && m.h ? `${m.w}×${m.h}` : '')}${param('시드', m.seed)}${param('스텝', m.steps)}
      ${param('샘플러', [m.sampler, m.schedule ? `(${m.schedule})` : '', m.smea ? `[${m.smea}]` : ''].filter(Boolean).join(' '))}
      ${param('가이던스', m.scale)}${param('가이던스 리스케일', m.rescale)}${param('네거티브 강도', m.ucScale)}
      ${param('강도 (img2img)', m.strength)}${param('노이즈 (img2img)', m.noise)}</div>`;
  return `<div class="insp">${hrow('모델', esc(m.modelName || m.model || ''))}${hrow('방식', esc(kind))}${hrow('읽은 곳', esc(VIA[m.via] || VIA[m.source] || ''))}${m.genTime ? hrow('생성 시간', esc(Number(m.genTime).toFixed(1)) + '초') : ''}</div>
    ${raw ? `<div class="mtabs"><button data-mtab="simple" class="${metaTab === 'simple' ? 'on' : ''}">간단히</button><button data-mtab="raw" class="${metaTab === 'raw' ? 'on' : ''}">원본 설정</button></div>` : ''}
    <div data-mpane="simple" ${raw && metaTab === 'raw' ? 'hidden' : ''}>${simple}</div>
    ${raw ? `<div data-mpane="raw" ${metaTab === 'raw' ? '' : 'hidden'}><div class="rawbox"><button class="btn sm ghost" data-copy="raw">${icon('copy')} 복사</button><pre>${esc(raw)}</pre></div></div>` : ''}`;
}
// 복사 · 탭 바꾸기 — 처리했으면 true
function metaBodyClick(e, m) {
  const t = e.target.closest('[data-mtab]');
  if (t) {
    metaTab = t.dataset.mtab;
    try { localStorage.setItem('nai-meta-tab', metaTab); } catch (err) { /* 없음 */ }
    const box = t.closest('.mtabs').parentElement;
    box.querySelectorAll('[data-mtab]').forEach((x) => x.classList.toggle('on', x === t));
    box.querySelectorAll('[data-mpane]').forEach((p) => { p.hidden = p.dataset.mpane !== metaTab; });
    return true;
  }
  const c = e.target.closest('[data-copy]');
  if (!c) return false;
  const k = c.dataset.copy;
  const text = k === 'prompt' ? m.prompt : k === 'neg' ? m.neg : k === 'raw' ? JSON.stringify(m.params, null, 2)
    : k.startsWith('cneg') ? (m.charNegs || [])[+k.slice(4)] : (m.chars || [])[+k.slice(4)];
  copyText(text || '');
  return true;
}

/* ---------- 라이트박스 ---------- */
const LB = { i: -1, open: false, tok: 0, cache: new Map(), cur: null };
function openLightbox(i) {
  LB.i = i;
  LB.open = true;
  renderLB();
}
function closeLB() {
  LB.open = false;
  LB.tok++;
  $('#overlay').innerHTML = '';
  LB.cache.forEach((c) => c.then((e) => e && URL.revokeObjectURL(e.url)));
  LB.cache.clear();
  LB.cur = null;
}
// 사진 한 장 준비: 파일 → 미리 그려 둔(decode) 이미지 + 생성 정보. 앞뒤 사진은 미리 준비해 둬서 넘길 때 안 깜빡임
function lbEntry(r) {
  const k = mkey(r);
  if (!LB.cache.has(k)) {
    LB.cache.set(k, (async () => {
      const f = await r.handle.getFile();
      const url = URL.createObjectURL(f);
      const im = new Image();
      im.src = url;
      // 탭이 안 보일 땐 decode 가 끝나지 않을 수 있어서 너무 오래 기다리진 않음
      await Promise.race([im.decode().catch(() => {}), X.sleep(700)]);
      // 파일 안 정보는 NovelAI inspect 와 같은 방식으로 직접 읽음 (PNG 글자 → EXIF → 숨은 정보)
      const fm = await X.readImageMeta(f).catch(() => null);
      return { url, w: im.naturalWidth, h: im.naturalHeight, fm };
    })().catch(() => null));
  }
  return LB.cache.get(k);
}
function lbTrim() {
  const keep = new Set([LB.i - 1, LB.i, LB.i + 1].map((i) => L.list[i]).filter(Boolean).map(mkey));
  for (const [k, p] of LB.cache) if (!keep.has(k)) { LB.cache.delete(k); p.then((e) => e && URL.revokeObjectURL(e.url)); }
}
async function renderLB() {
  const tok = ++LB.tok;
  const r = L.list[LB.i];
  if (!r) return closeLB();
  const [ent] = await Promise.all([lbEntry(r), metaOf(r).catch(() => null)]);
  if (tok !== LB.tok) return; // 그 사이에 또 넘겼으면 이건 버림
  if (!ent) { toast('파일을 열 수 없어요 (옮겨졌거나 지워졌어요)', 'err'); return closeLB(); }
  const m = ent.fm || r.meta || {};
  const has = !!(m.prompt || m.neg);
  const trashMode = inTrash(r);
  LB.cur = { r, m };
  let lb = $('#overlay .lb');
  if (!lb) {
    $('#overlay').innerHTML = `<div class="lb"><div class="stage" data-close><img alt="" id="lbimg"><span id="lbnav"></span></div><aside class="lbside"></aside></div>`;
    lb = $('#overlay .lb');
    lb.onclick = lbClick;
  }
  $('#lbimg').src = ent.url;
  $('#lbnav').innerHTML = `${LB.i > 0 ? `<button class="navb l" data-nav="-1" title="이전 (←)">${icon('left')}</button>` : ''}
      ${LB.i < L.list.length - 1 ? `<button class="navb r" data-nav="1" title="다음 (→)">${icon('right')}</button>` : ''}`;
  lb.querySelector('.lbside').innerHTML = `
      <div class="ih"><div class="grow"><button class="nm rn" data-lb="rename" title="이름 바꾸기 (F2)">${esc(r.name)}${icon('pencil')}</button>
        <div class="sub">${esc(r.dirPath || '/')} · ${fmtTime(r.mtime)} · ${fmtBytes(r.size)} · <span id="lbdim">${ent.w ? `${ent.w}×${ent.h}` : ''}</span></div></div>
        <button class="ib" data-lb="close" title="닫기 (Esc)">${icon('x')}</button></div>
      <div class="ib2">
        ${r.side
          ? `<div class="sidebadge ok">${icon('file')}<span>정보 파일 있음 · ${Object.values(r.side).map((s) => esc(s.name.split('.').pop().toUpperCase())).join(' · ')}</span>${m.source === 'sidecar' ? '<small>이 파일에서 읽음</small>' : ''}</div>`
          : has ? `<div class="sidebadge">${icon('file')}<span>정보 파일 없음</span><button class="btn sm" data-lb="mkside">만들기</button></div>` : ''}
        ${metaBodyHTML(m)}
      </div>
      <div class="ia">
        ${has ? `<button class="btn sm" data-lb="copyAll">${icon('copy')} 전체 정보 복사</button>` : '<span></span>'}
        <button class="btn sm" data-lb="clean">${icon('shield')} 메타 제거 사본</button>
        ${trashMode ? `<button class="btn sm" data-lb="restore">${icon('undo')} 복원</button>` : `<button class="btn sm" data-lb="select">${icon('check')} ${L.sel.has(r.path) ? '선택 해제' : '선택'}</button>`}
        ${trashMode ? `<button class="btn sm danger" data-lb="purge">${icon('trash')} 영구 삭제</button>` : `<button class="btn sm danger" data-lb="trash">${icon('trash')} 휴지통 <kbd>Del</kbd></button>`}
      </div>`;
  // 앞뒤 사진 미리 준비 · 멀어진 건 정리
  lbTrim();
  [L.list[LB.i + 1], L.list[LB.i - 1]].forEach((x) => x && lbEntry(x));
  if (LB.renameNext) { LB.renameNext = false; startRename(r); }
}
async function lbClick(e) {
  if (!LB.cur) return;
  const { r, m } = LB.cur;
  if (e.target.matches('[data-close]')) return closeLB();
  const nav = e.target.closest('[data-nav]');
  if (nav) { LB.i += +nav.dataset.nav; return renderLB(); }
  if (metaBodyClick(e, m)) return;
  const b = e.target.closest('[data-lb]');
  if (!b) return;
  const a = b.dataset.lb;
  if (a === 'close') closeLB();
  else if (a === 'rename') startRename(r);
  else if (a === 'copyAll') {
    const parts = [m.prompt];
    (m.chars || []).forEach((c2, k) => parts.push(`[캐릭터 ${k + 1}] ${c2}`));
    if (m.neg) parts.push(`[네거티브] ${m.neg}`);
    const ps = [['시드', m.seed], ['스텝', m.steps], ['가이던스', m.scale], ['샘플러', m.sampler]].filter(([, v]) => v != null && v !== '').map(([k2, v]) => `${k2} ${v}`).join(' · ');
    if (ps) parts.push(ps);
    copyText(parts.join('\n\n'), '전체 정보를 복사했어요');
  } else if (a === 'clean') { closeLB(); openConvertModal([r]); }
  else if (a === 'mkside') {
    try {
      if (await makeSidecarsFor(r)) toast('이미지 옆에 정보 파일을 만들었어요', 'ok');
      else toast('생성 정보가 없어서 만들 수 없어요', 'info');
    } catch (err) { toast('만들지 못했어요: ' + err.message, 'err'); }
    renderLB();
  }
  else if (a === 'select') { toggleSelByPath(r.path); renderLB(); }
  else if (a === 'trash') lbTrash(r);
  else if (a === 'restore') { closeLB(); restoreRecs([r]); }
  else if (a === 'purge') { closeLB(); purgeRecs([r]); }
}
// 이름 바꾸기 — 확장자는 그대로, 같은 이름의 .txt / .json 도 같이
function startRename(r) {
  const nm = $('.lb .rn');
  if (!nm || $('.lb .rnin')) return;
  const ext = (r.name.match(/\.[^.]+$/) || [''])[0];
  nm.outerHTML = `<div class="rnbox"><input class="in rnin" value="${esc(X.baseName(r.name))}" spellcheck="false"><span class="rnext">${esc(ext)}</span></div>`;
  const inp = $('.lb .rnin');
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const base = X.sanitizeDir(inp.value);
    if (!save || !base || base + ext === r.name) return renderLB();
    try {
      const oldPath = r.path, wasSel = L.sel.has(oldPath);
      const res = await moveRec(r, r.dirPath, base + ext);
      const dir = await X.getDir(F.root, r.dirPath);
      Object.assign(r, { dir, handle: await dir.getFileHandle(res.name), name: res.name, path: res.path, side: res.side });
      if (wasSel) { L.sel.delete(oldPath); L.sel.add(r.path); }
      toast(`이름을 바꿨어요 · ${res.name}`, 'ok', 1600);
      refreshGrid(true);
      LB.i = Math.max(0, L.list.indexOf(r));
    } catch (e) { toast('이름을 바꾸지 못했어요: ' + e.message, 'err'); }
    renderLB();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}
function toggleSelByPath(p) {
  if (L.sel.has(p)) L.sel.delete(p); else L.sel.add(p);
  const i = L.list.findIndex((r) => r.path === p);
  const t = $(`.tile[data-i="${i}"]`);
  if (t) t.classList.toggle('picked', L.sel.has(p));
  const g = $('#grid');
  if (g) g.classList.toggle('selecting', L.sel.size > 0 || !!L.pickMode);
  renderSelbar();
}
async function lbTrash(r) {
  try {
    const dest = r.dirPath ? `${TRASH}/${r.dirPath}` : TRASH;
    const res = await moveRec(r, dest);
    toast(`휴지통으로 옮겼어요 · ${r.name}`, 'ok', 1600);
    // 휴지통 쪽 기록으로 바꾸고 다음 사진으로
    L.sel.delete(r.path);
    try {
      const dir = await X.getDir(F.root, dest);
      Object.assign(r, { dir, handle: await dir.getFileHandle(res.name), name: res.name, path: res.path, dirPath: dest, side: res.side });
      if (!L.dirs.includes(dest)) L.dirs.push(dest);
    } catch (e) { L.files = L.files.filter((x) => x !== r); }
    const i = LB.i;
    L.list = computeList();
    refreshGrid(true);
    if (!L.list.length) return closeLB();
    LB.i = Math.min(i, L.list.length - 1);
    renderLB();
    renderDirs();
    renderSide();
  } catch (e) { toast('옮기지 못했어요: ' + e.message, 'err'); }
}

/* ---------- 온보딩 · 권한 ---------- */
function viewOnboard() {
  renderTop();
  const w = mount(`<div class="onboard">
    <div class="big">${icon('folderOpen')}</div>
    <h2>생성한 그림이 내 폴더로 바로 들어가요</h2>
    <p>생성할 때마다 이 폴더에 자동 저장돼요.</p>
    <button class="btn pri lg" id="connect">${icon('folder')} 폴더 연결하기</button>
    <div class="tip" style="margin-top:22px">권한 창에선 <b>방문할 때마다 허용</b>을 골라 주세요. ${tip('다운로드 폴더 안에 NovelAI 폴더를 만들어 연결하면, 권한이 잠깐 꺼져도 같은 곳에 저장돼요.')}</div>
    <div class="feats">
      <div class="feat"><div class="fi">${icon('download')}</div><b>자동 저장 ${tip('생성 즉시 날짜별 폴더로. 원본 PNG 또는 메타 제거본으로.')}</b></div>
      <div class="feat"><div class="fi">${icon('search')}</div><b>프롬프트로 찾기 ${tip('그림에 쓴 프롬프트를 읽어서 태그로 검색해요.')}</b></div>
      <div class="feat"><div class="fi">${icon('shield')}</div><b>메타 제거 변환 ${tip('여러 장을 골라 JPG · PNG · WebP 로 한 번에.')}</b></div>
    </div></div>`);
  $('#connect', w).addEventListener('click', connectFolder);
}
function viewRegrant() {
  renderTop();
  const w = mount(`<div class="onboard">
    <div class="big">${icon('lock')}</div>
    <h2>폴더 권한을 다시 허용해 주세요</h2>
    <p>브라우저를 다시 켜면 한 번 더 물어봐요. ${tip('허용 창에서 방문할 때마다 허용을 고르면 다음부턴 안 물어봐요.')}</p>
    <div class="row" style="justify-content:center">
      <button class="btn pri lg" id="grant">${icon('folder')} ${esc(F.root.name)} 허용하기</button>
      <button class="btn lg" id="other">다른 폴더 연결</button>
    </div></div>`);
  $('#grant', w).addEventListener('click', regrant);
  $('#other', w).addEventListener('click', connectFolder);
}

/* ------------------------------------------------------------------ *
 * 변환 화면
 * ------------------------------------------------------------------ */
const C = { items: [], busy: false, dest: null };
function addConvFiles(files) {
  let n = 0;
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    C.items.push({ id: X.uid(), name: f.name || 'image.png', blob: f, url: URL.createObjectURL(f), status: 'wait' });
    n++;
  }
  if (n) toast(`${n}장 추가했어요`, 'ok', 1200);
  else toast('이미지 파일만 넣을 수 있어요', 'err');
  if (view === 'convert') viewConvert();
}
function viewConvert() {
  renderTop();
  const folderOk = !!F.root && F.perm === 'granted';
  if (!C.dest || (C.dest === 'folder' && !folderOk)) C.dest = folderOk ? 'folder' : 'zip';
  const o = X.convOpts(S);
  const total = C.items.reduce((a, it) => a + it.blob.size, 0);
  const w = mount(`<div class="two">
    <div class="col">
      <div class="drop" id="drop">${icon('upload')}<div class="t1">이미지를 끌어다 놓거나 클릭해서 고르기</div>
        <div class="t2">여러 장 한 번에 · <kbd>Ctrl</kbd>+<kbd>V</kbd> 붙여넣기</div>
        <input type="file" accept="image/*" multiple hidden id="file"></div>
      ${folderOk ? `<button class="btn" id="pickLib" ${C.busy ? 'disabled' : ''}>${icon('images')} 라이브러리에서 고르기</button>` : ''}
      ${C.items.length ? `<div class="row"><span class="cnt">${C.items.length}장 · ${fmtBytes(total)} ${tip('이름 칸을 눌러 저장할 파일 이름을 바꿀 수 있어요')}</span><span class="grow"></span>
          <button class="btn sm ghost" id="clr" ${C.busy ? 'disabled' : ''}>${icon('trash')} 목록 비우기</button></div>
        <div class="queue" id="queue">${C.items.map(qRow).join('')}</div>` : ''}
    </div>
    <div class="col">
      <div class="card"><h3>변환 설정 ${tip(`모든 처리는 이 컴퓨터 안에서만 이뤄져요`)}</h3><div id="co">${convOptsHTML(o)}</div></div>
      <div class="card"><h3>저장할 곳</h3>${destRadios(C.dest, folderOk)}</div>
      <button class="btn pri lg" id="run" ${C.items.length && !C.busy ? '' : 'disabled'}>${C.busy ? '<span class="spin"></span> 변환 중…' : `${icon('shield')} ${C.items.length ? C.items.length + '장 ' : ''}메타데이터 지우고 저장`}</button>
    </div></div>`);
  bindConvOpts($('#co', w), o, () => {
    savePatch(optsToSettings(o));
    C.items.forEach((it) => { const e = $(`.qi[data-id="${it.id}"] .ext`, w); if (e) e.textContent = '.' + X.EXT[X.outKind(o.format, X.blobKind(it.blob))]; });
  });
  const file = $('#file', w), drop = $('#drop', w);
  drop.addEventListener('click', (e) => { if (e.target !== file) file.click(); });
  file.addEventListener('change', () => { if (file.files.length) addConvFiles(file.files); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) addConvFiles(e.dataTransfer.files); });
  w.addEventListener('change', (e) => { if (e.target.name === 'dest') C.dest = e.target.value; });
  const clr = $('#clr', w);
  if (clr) clr.addEventListener('click', () => { C.items.forEach((it) => URL.revokeObjectURL(it.url)); C.items = []; viewConvert(); });
  const pick = $('#pickLib', w);
  if (pick) pick.addEventListener('click', openLibPicker);
  const q = $('#queue', w);
  if (q) q.addEventListener('input', (e) => {
    const it = e.target.dataset.nm && C.items.find((x) => x.id === e.target.dataset.nm);
    if (it) it.outBase = e.target.value;
  });
  if (q) q.addEventListener('click', (e) => {
    const ins = e.target.closest('[data-insp]');
    if (ins) { const it = C.items.find((x) => x.id === ins.dataset.insp); if (it) openInspect(it.blob, it.name); return; }
    const b = e.target.closest('[data-rm]');
    if (!b || C.busy) return;
    const it = C.items.find((x) => x.id === b.dataset.rm);
    if (it) URL.revokeObjectURL(it.url);
    C.items = C.items.filter((x) => x !== it);
    viewConvert();
  });
  $('#run', w).addEventListener('click', async () => {
    if (C.busy || !C.items.length) return;
    C.busy = true;
    viewConvert();
    const todo = C.items.map((it) => Object.assign(it, { getBlob: async () => it.blob, status: 'run' }));
    const res = await convertMany(todo, X.convOpts(S), C.dest, (d, t, it) => {
      const row = $(`.qi[data-id="${it.id}"]`);
      if (row) row.outerHTML = qRow(it);
    });
    C.busy = false;
    const pct = res.inB ? Math.round((1 - res.outB / res.inB) * 100) : 0;
    toast(`${res.ok}장 변환 완료 · ${fmtBytes(res.inB)} → ${fmtBytes(res.outB)}${pct > 0 ? ` (-${pct}%)` : ''}${res.fail ? ` · ${res.fail}장 실패` : ''}`, res.fail ? 'err' : 'ok', 4000);
    if (C.dest === 'folder') resetLibrary();
    if (view === 'convert') viewConvert();
  });
}
function qRow(it) {
  let st = fmtBytes(it.blob.size);
  if (it.status === 'run') st += ' · 대기 중';
  else if (it.status === 'done') {
    const pct = Math.round((1 - it.outSize / it.blob.size) * 100);
    st = `${fmtBytes(it.blob.size)} → <span class="ok">${fmtBytes(it.outSize)}</span> ${pct > 0 ? `(-${pct}%)` : `(+${-pct}%)`} · 메타 제거됨`;
  } else if (it.status === 'err') st = `<span class="err">실패: ${esc(it.err)}</span>`;
  const ext = '.' + X.EXT[X.outKind(S.convFormat, X.blobKind(it.blob))];
  const nameEl = it.status === 'wait'
    ? `<input data-nm="${it.id}" value="${esc(it.outBase != null ? it.outBase : X.baseName(it.name))}" spellcheck="false" title="저장할 이름 (원본: ${esc(it.name)})"><span class="ext">${ext}</span>`
    : esc((it.outBase || X.baseName(it.name)) + ext);
  return `<div class="qi" data-id="${it.id}"><img src="${it.url}" alt="" data-insp="${it.id}" title="생성 정보 보기" style="cursor:zoom-in"><div class="nm"><div class="a">${nameEl}</div><div class="b">${st}</div></div>
    ${it.status === 'done' ? `<span class="ib ok">${icon('check')}</span>` : `<button class="ib del" data-rm="${it.id}" title="빼기">${icon('x')}</button>`}</div>`;
}
// 아무 이미지나 생성 정보 보기 (NovelAI inspect 처럼)
async function openInspect(blob, name) {
  const m = await X.readImageMeta(blob).catch(() => null);
  const url = URL.createObjectURL(blob);
  modal({
    title: name || '생성 정보',
    body: `<div class="inspm"><img src="${url}" alt=""><div class="inspb">${metaBodyHTML(m)}</div></div>`,
    actions: [{ label: '닫기', act: 'close' }],
    onMount(md) {
      md.el.classList.add('wide');
      md.el.addEventListener('click', (ev) => metaBodyClick(ev, m || {}));
      const close = md.close;
      md.close = () => { URL.revokeObjectURL(url); close(); };
    },
    onAction() {},
  });
}
// 변환 화면 — 내 폴더 사진을 골라서 목록에 넣기
async function openLibPicker() {
  if (!L.loaded) {
    toast('폴더 읽는 중…', 'info', 1200);
    if (!L.loading) await loadLibrary();
    while (L.loading) await X.sleep(150);
    if (!L.loaded) return;
  }
  const P = { q: '', picked: new Set(), limit: 120 };
  const pool = () => {
    const terms = P.q.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    return L.files.filter((r) => !inTrash(r) && terms.every((t) => `${r.path} ${(r.meta && r.meta.prompt) || ''}`.toLowerCase().includes(t))).sort((a, b) => b.mtime - a.mtime);
  };
  const draw = (m) => {
    const list = pool();
    const g = $('#pkg', m.el);
    g.innerHTML = list.slice(0, P.limit).map((r) => `<button class="pk${P.picked.has(r.path) ? ' on' : ''}" data-p="${esc(r.path)}" title="${esc(r.path)}"><img alt=""><span class="ck">${icon('check')}</span></button>`).join('')
      + (list.length > P.limit ? `<button class="btn sm ghost" data-more style="grid-column:1/-1">더 보기 (${list.length - P.limit})</button>` : '')
      || `<div class="empty" style="grid-column:1/-1">${icon('search')}없어요</div>`;
    const gen = (draw.gen = (draw.gen || 0) + 1);
    g.querySelectorAll('.pk').forEach((el) => {
      const r = L.files.find((x) => x.path === el.dataset.p);
      if (r) loadThumb(r).then((u) => {
        const im = el.querySelector('img');
        if (gen !== draw.gen || !u || !im) return;
        im.onload = () => im.classList.add('ld');
        im.src = u;
      });
    });
    $('#pkn', m.el).textContent = P.picked.size ? `${P.picked.size}장 고름` : '';
    const go = m.el.querySelector('[data-ma="add"]');
    if (go) go.disabled = !P.picked.size;
  };
  modal({
    title: '라이브러리에서 고르기',
    body: `<div class="row" style="margin-bottom:10px"><div class="search grow">${icon('search')}<input class="in" id="pkq" placeholder="프롬프트 · 폴더 · 파일 이름"></div><span class="cnt" id="pkn"></span></div>
      <div class="pkgrid" id="pkg"></div>`,
    actions: [{ label: '취소', act: 'close' }, { label: `${icon('plus')} 추가`, cls: 'pri', act: 'add' }],
    onMount(m) {
      m.el.classList.add('wide');
      draw(m);
      const qi = $('#pkq', m.el);
      qi.focus();
      qi.addEventListener('input', () => { P.q = qi.value; P.limit = 120; clearTimeout(qi.t); qi.t = setTimeout(() => draw(m), 140); });
      $('#pkg', m.el).addEventListener('click', (e) => {
        if (e.target.closest('[data-more]')) { P.limit += 120; return draw(m); }
        const b = e.target.closest('.pk');
        if (!b) return;
        const p = b.dataset.p;
        if (P.picked.has(p)) P.picked.delete(p); else P.picked.add(p);
        b.classList.toggle('on', P.picked.has(p));
        $('#pkn', m.el).textContent = P.picked.size ? `${P.picked.size}장 고름` : '';
        m.el.querySelector('[data-ma="add"]').disabled = !P.picked.size;
      });
    },
    async onAction(act, m) {
      if (act !== 'add') return;
      const recs = L.files.filter((r) => P.picked.has(r.path));
      let n = 0;
      for (const r of recs) {
        try {
          const f = await r.handle.getFile();
          C.items.push({ id: X.uid(), name: r.name, blob: f, url: URL.createObjectURL(f), status: 'wait', meta: r.meta, side: r.side });
          n++;
        } catch (e) { /* 옮겨진 파일 */ }
      }
      m.close();
      toast(`${n}장 추가했어요`, 'ok', 1200);
      if (view === 'convert') viewConvert();
    },
  });
}
document.addEventListener('paste', (e) => {
  if (view !== 'convert' || !e.clipboardData) return;
  const files = [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); addConvFiles(files); }
});

/* ------------------------------------------------------------------ *
 * 번역기
 * ------------------------------------------------------------------ */
const T = { input: '', result: null, busy: false };
function viewTranslate() {
  renderTop();
  const w = mount(`<div class="two">
    <div class="card">
      <div class="lbl">한글 입력 </div>
      <textarea class="ta" id="tin" style="min-height:220px" placeholder="한글로 적어 보세요. 쉼표(,)로 나누면 태그별로 번역돼요.&#10;&#10;예) 1girl, 금발, 파란 눈, 1.2::미소::, 교복, 벚꽃 아래">${esc(T.input)}</textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn pri" id="tgo" ${T.busy ? 'disabled' : ''}>${T.busy ? '<span class="spin"></span>' : icon('languages')} 번역 <kbd>Ctrl+Enter</kbd></button>
        <label class="row" style="gap:8px;font-size:13px;color:var(--mut);font-weight:600;cursor:pointer">${sw('id="ttag"', S.tagMode)} 태그 모드</label>
        <span class="grow"></span><button class="ib" id="tclr" title="지우기">${icon('x')}</button>
      </div>
    </div>
    <div class="col" id="tout"></div></div>`);
  renderTrOut();
  const ta = $('#tin', w);
  ta.addEventListener('input', () => (T.input = ta.value));
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doTranslate(); } });
  $('#tgo', w).addEventListener('click', doTranslate);
  $('#ttag', w).addEventListener('change', (e) => savePatch({ tagMode: e.target.checked }));
  $('#tclr', w).addEventListener('click', () => { T.input = ''; T.result = null; viewTranslate(); $('#tin').focus(); });
  $('#tout', w).addEventListener('input', (e) => {
    const j = e.target.dataset.job;
    if (j != null && T.result) {
      T.result.jobs[+j].dst = e.target.value;
      X.rebuildOutput(T.result);
      $('#tres').value = T.result.output;
    }
    if (e.target.id === 'tres' && T.result) T.result.output = e.target.value;
  });
  $('#tout', w).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ta]');
    if (!b || !T.result) return;
    if (b.dataset.ta === 'copy') copyText(T.result.output);
    else if (b.dataset.ta === 'send') sendToNai(T.result.output);
    else if (b.dataset.ta === 'star') {
      const j = T.result.jobs[+b.dataset.i];
      if (!j || !j.dst.trim()) return;
      const { dict: cur = {} } = await chrome.storage.local.get('dict');
      if (cur[j.src] === j.dst.trim()) { delete cur[j.src]; j.kind = 'mt'; toast(`사전에서 뺐어요 · ${j.src}`, 'info'); }
      else { cur[j.src] = j.dst.trim(); j.kind = 'dict'; toast(`사전에 저장 · ${j.src} → ${j.dst.trim()}`, 'ok'); }
      dict = cur;
      await chrome.storage.local.set({ dict: cur });
      renderTrOut();
    }
  });
}
function renderTrOut() {
  const box = $('#tout');
  if (!box) return;
  const r = T.result;
  if (!r) {
    box.innerHTML = `<div class="card empty" style="padding:70px 20px">${icon('languages')}번역 결과가 여기에 나와요</div>`;
    return;
  }
  const kl = { dict: '사전', cache: '기억', mt: '번역기' };
  box.innerHTML = `
    <div class="card"><div class="lbl">${r.dir === 'en2ko' ? '한국어 풀이' : '결과 프롬프트'}<span class="grow"></span>${r.jobs.length ? `<span class="cnt">${r.jobs.length}개 조각</span>` : ''}</div>
      <textarea class="ta mono" id="tres" style="min-height:120px" spellcheck="false">${esc(r.output)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-ta="copy">${icon('copy')} 복사</button>
        ${r.dir === 'ko2en' ? `<button class="btn pri sm" data-ta="send">${icon('plus')} NovelAI 칸에 추가 ${tip('열려 있는 NovelAI 탭으로 가서, 마지막으로 클릭한 프롬프트 칸 끝에 넣어요')}</button>` : ''}</div></div>
    ${r.jobs.length ? `<div class="card"><div class="lbl">조각별로 다듬기 ${tip('고치면 위 결과에 바로 반영돼요')}<span class="grow"></span></div><div class="chips">
      ${r.jobs.map((j, i) => `<div class="chip"><span class="src" title="${esc(j.src)}">${esc(j.src)}</span><span class="arr">${icon('arrow')}</span>
        <input data-job="${i}" value="${esc(j.dst)}" spellcheck="false"><span class="k ${j.kind}">${kl[j.kind] || ''}</span>
        <button class="ib ${dict[j.src] ? 'on' : ''}" data-ta="star" data-i="${i}" title="${dict[j.src] ? '사전에서 빼기' : '사전에 저장'}">${icon('star', !!dict[j.src])}</button></div>`).join('')}
    </div></div>` : ''}`;
}
// 번역 결과를 열려 있는 NovelAI 탭의 프롬프트 칸에 넣음 (그 탭으로 이동)
async function sendToNai(text) {
  const matches = chrome.runtime.getManifest().content_scripts[0].matches;
  const tabs = (await chrome.tabs.query({ url: matches })).filter((t) => /\/image/.test(t.url || ''));
  if (!tabs.length) { toast('열려 있는 NovelAI 이미지 탭이 없어요', 'info'); return; }
  const tab = tabs.find((t) => t.active) || tabs[0];
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await X.sleep(250);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'insertPrompt', text, mode: 'append' });
  } catch (e) {
    toast('NovelAI 탭과 연결이 안 돼요. 그 탭을 새로고침해 주세요', 'err');
  }
}
async function doTranslate() {
  const text = T.input.trim();
  if (!text || T.busy) return;
  T.busy = true;
  viewTranslate();
  const res = await chrome.runtime.sendMessage({ type: 'translate', text }).catch((e) => ({ ok: false, error: e.message }));
  T.busy = false;
  if (res && res.ok) T.result = res.r;
  else toast('번역 실패: ' + ((res && res.error) || '알 수 없음'), 'err');
  if (view === 'translate') viewTranslate();
}

/* ------------------------------------------------------------------ *
 * 치환어 (%이름 — 앞 기호는 설정값)
 * ------------------------------------------------------------------ */
const SN = { q: '', sel: null, name: '', text: '', test: '' };
const TG = () => S.snipTrigger || '%';
function viewSnippets() {
  VIEWS.snippets.desc = `프롬프트에 ${TG()}이름 만 쓰면 생성할 때 저장한 내용으로 바뀌어요. 프롬프트 칸에서 ${TG()} 를 치면 목록이 떠요 — Enter 로 넣고 Shift+Enter 면 펼쳐서 넣어요. 칸에서 미리 펼쳐 보려면 Alt+E. 기록과 정보 파일엔 펼쳐진 프롬프트가 남아요.`;
  renderTop(`<div class="row" style="gap:14px">
      <div class="row" style="gap:8px"><span class="cnt">앞 기호</span><div class="seg" id="sntg">${X.SNIP_TRIGGERS.map((c) => `<button data-tg="${esc(c)}" class="${TG() === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div></div>
      <label class="row" style="gap:8px;font-size:13px;color:var(--mut);font-weight:600;cursor:pointer">${sw('id="snx"', S.snipExpand)} 생성할 때 펼치기</label></div>`);
  $('#snx').addEventListener('change', (e) => savePatch({ snipExpand: e.target.checked }));
  $('#sntg').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tg]');
    if (!b || b.dataset.tg === TG()) return;
    // 치환어 안에 적어 둔 다른 치환어(%화풍 → #화풍)도 같이 바꿈
    const old = TG(), nt = b.dataset.tg;
    const cur = (await chrome.storage.local.get('snippets')).snippets || {};
    let changed = false;
    for (const k of Object.keys(cur)) {
      cur[k] = String(cur[k]).replace(X.snipRegex(old), (all, n) => {
        let m = n;
        while (!(m in cur) && /[.\-]$/.test(m)) m = m.slice(0, -1);
        if (!(m in cur)) return all;
        changed = true;
        return nt + n;
      });
    }
    await savePatch({ snipTrigger: nt });
    if (changed) { snippets = cur; await chrome.storage.local.set({ snippets: cur }); }
    if (SN.sel != null) SN.text = snippets[SN.sel] || SN.text;
    toast(`이제 ${nt}이름 으로 써요 · 저장한 치환어는 그대로예요`, 'ok');
    viewSnippets();
  });
  const w = mount(`<div class="two">
    <div class="col">
      <div class="row"><div class="search grow">${icon('search')}<input class="in" id="snq" placeholder="치환어 검색" value="${esc(SN.q)}"></div>
        <button class="btn pri" id="snnew">${icon('plus')} 새 치환어</button></div>
      <div class="col" id="snlist" style="gap:8px"></div>
    </div>
    <div class="col">
      <div class="card" id="sned"></div>
      <div class="card"><h3>미리보기</h3>
        <textarea class="ta mono" id="sntest" style="min-height:80px" placeholder="예) ${esc(TG())}미오, smile, ${esc(TG())}배경_벚꽃">${esc(SN.test)}</textarea>
        <div class="tip mono" id="snout" style="margin-top:10px;white-space:pre-wrap;word-break:break-word"></div></div>
    </div></div>`);
  renderSnList();
  renderSnEditor();
  renderSnTest();
  $('#snq', w).addEventListener('input', (e) => { SN.q = e.target.value; renderSnList(); });
  $('#snnew', w).addEventListener('click', () => { SN.sel = null; SN.name = SN.text = ''; renderSnList(); renderSnEditor(); $('#snname').focus(); });
  $('#sntest', w).addEventListener('input', (e) => { SN.test = e.target.value; renderSnTest(); });
  $('#snlist', w).addEventListener('click', (e) => {
    const it = e.target.closest('[data-sn]');
    if (!it) return;
    if (e.target.closest('[data-copy]')) { copyText(TG() + it.dataset.sn); return; }
    SN.sel = it.dataset.sn;
    SN.name = SN.sel;
    SN.text = snippets[SN.sel] || '';
    renderSnList();
    renderSnEditor();
  });
}
function renderSnList() {
  const box = $('#snlist');
  if (!box) return;
  const q = SN.q.trim().toLowerCase();
  const list = Object.keys(snippets).filter((n) => !q || n.toLowerCase().includes(q) || String(snippets[n]).toLowerCase().includes(q)).sort();
  box.innerHTML = list.length
    ? list.map((n) => `<div class="hi" data-sn="${esc(n)}" style="cursor:pointer;${SN.sel === n ? 'border-color:var(--acc);box-shadow:2px 2px 0 var(--acc-line)' : ''}">
        <div class="hi-top"><span class="k gen" style="font-size:12px">${esc(TG() + n)}</span><span class="grow"></span><button class="ib" data-copy title="${esc(TG() + n)} 복사">${icon('copy')}</button></div>
        <div class="txt" style="-webkit-line-clamp:2">${esc(snippets[n])}</div></div>`).join('')
    : `<div class="empty">${icon('at')}${Object.keys(snippets).length ? '검색 결과가 없어요' : '아직 치환어가 없어요.<br>캐릭터 외형 · 화풍 · 자주 쓰는 네거티브를 짧은 이름으로 저장해 보세요.'}</div>`;
}
function renderSnEditor() {
  const box = $('#sned');
  if (!box) return;
  const editing = SN.sel != null;
  box.innerHTML = `<h3>${editing ? `${esc(TG() + SN.sel)} 고치기` : '새 치환어'} ${tip(`이름엔 한글 · 영문 · 숫자 · _ - . 를 쓸 수 있어요`)}</h3>
    <div class="row" style="flex-wrap:nowrap;margin-bottom:10px"><span style="color:var(--acc);font-weight:800;font-size:18px;padding:0 2px 0 4px">${esc(TG())}</span>
      <input class="in" id="snname" placeholder="이름 (예: 미오)" value="${esc(SN.name)}"></div>
    <textarea class="ta mono" id="sntext" style="min-height:160px" placeholder="펼쳐질 내용&#10;예) 1girl, silver hair, long hair, red eyes, gothic dress, ${esc(TG())}화풍_수채화">${esc(SN.text)}</textarea>
    <div class="row" style="margin-top:12px"><button class="btn pri" id="snsave">${icon('check')} 저장</button>
      ${editing ? `<button class="btn danger" id="sndel">${icon('trash')} 삭제</button>` : ''}</div>`;
  $('#snname').addEventListener('input', (e) => (SN.name = e.target.value));
  $('#sntext').addEventListener('input', (e) => (SN.text = e.target.value));
  $('#snsave').addEventListener('click', async () => {
    const name = X.cleanSnipName(SN.name);
    if (!name || !SN.text.trim()) { toast('이름과 내용을 둘 다 적어 주세요', 'info'); return; }
    const cur = (await chrome.storage.local.get('snippets')).snippets || {};
    if (name !== SN.sel && cur[name] != null && !confirm(`${TG()}${name} 이(가) 이미 있어요. 덮어쓸까요?`)) return;
    if (SN.sel != null && SN.sel !== name) delete cur[SN.sel];
    cur[name] = SN.text.trim();
    snippets = cur;
    await chrome.storage.local.set({ snippets: cur });
    SN.sel = name;
    SN.name = name;
    toast(`${TG()}${name} 저장했어요`, 'ok');
    renderSnList();
    renderSnEditor();
    renderSnTest();
  });
  const del = $('#sndel');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`${TG()}${SN.sel} 을(를) 지울까요?`)) return;
    const cur = (await chrome.storage.local.get('snippets')).snippets || {};
    delete cur[SN.sel];
    snippets = cur;
    await chrome.storage.local.set({ snippets: cur });
    SN.sel = null;
    SN.name = SN.text = '';
    renderSnList();
    renderSnEditor();
    renderSnTest();
  });
}
function renderSnTest() {
  const box = $('#snout');
  if (!box) return;
  if (!SN.test.trim()) { box.textContent = '여기에 펼쳐진 결과가 나와요'; return; }
  const used = new Set();
  const out = X.expandSnippets(SN.test, snippets, used, TG());
  box.innerHTML = esc(out) + (used.size ? `<div style="margin-top:8px;font-family:inherit;color:var(--ok)">${[...used].map((n) => esc(TG() + n)).join(' ')} 펼침</div>` : '<div style="margin-top:8px;color:var(--dim)">펼칠 치환어가 없어요</div>');
}

/* ------------------------------------------------------------------ *
 * 기록
 * ------------------------------------------------------------------ */
const H = { q: '', filter: 'all', limit: 60 };
function viewHistory() {
  renderTop(hist.length ? `<button class="btn sm danger" id="hclear">${icon('trash')} 즐겨찾기 빼고 비우기</button>` : '');
  const hc = $('#hclear');
  if (hc) hc.addEventListener('click', async () => {
    if (!confirm('즐겨찾기를 제외한 기록을 모두 지울까요?')) return;
    hist = hist.filter((h) => h.fav);
    await chrome.storage.local.set({ history: hist });
    viewHistory();
  });
  const seg = [['all', '전체'], ['gen', '생성'], ['tr', '번역'], ['fav', '즐겨찾기']];
  const w = mount(`
    <div class="row" style="margin-bottom:14px">
      <div class="search grow" style="max-width:520px">${icon('search')}<input class="in" id="hq" placeholder="프롬프트 · 번역 검색" value="${esc(H.q)}"></div>
      <div class="seg" id="hseg">${seg.map(([k, l]) => `<button data-f="${k}" class="${H.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="cnt" id="hc"></span>
    </div>
    <div id="hlist"></div>`);
  renderHistList();
  $('#hq', w).addEventListener('input', (e) => { H.q = e.target.value; H.limit = 60; renderHistList(); });
  $('#hseg', w).addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (!f) return;
    H.filter = f.dataset.f;
    w.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === f));
    renderHistList();
  });
  $('#hlist', w).addEventListener('click', async (e) => {
    const t = e.target.closest('.txt');
    if (t && !e.target.closest('[data-h]')) { t.classList.toggle('open'); return; }
    const b = e.target.closest('[data-h]');
    if (!b) return;
    if (b.dataset.h === 'more') { H.limit += 60; renderHistList(); return; }
    const h = hist.find((x) => x.id === b.closest('[data-id]').dataset.id);
    if (!h) return;
    const a = b.dataset.h;
    if (a === 'fav') { h.fav = !h.fav; await chrome.storage.local.set({ history: hist }); }
    else if (a === 'del') { hist = hist.filter((x) => x !== h); await chrome.storage.local.set({ history: hist }); }
    else if (a === 'copy') copyText(h.type === 'gen' ? h.prompt : h.dst);
    else if (a === 'neg') copyText(h.neg || '');
    else if (a === 'sec') {
      const k = b.dataset.sec;
      copyText(k === 'base' ? h.prompt : k === 'neg' ? h.neg || '' : (h.chars || [])[+k.slice(1)] || '');
    }
    else if (a === 'all') {
      const parts = [h.prompt];
      (h.chars || []).forEach((c, i) => parts.push(`[캐릭터 ${i + 1}] ${c}`));
      if (h.neg) parts.push(`[네거티브] ${h.neg}`);
      if (h.seed != null) parts.push(`[시드] ${h.seed}`);
      copyText(parts.join('\n\n'));
    } else if (a === 'search') { L.q = (h.prompt || '').split(',').slice(0, 3).join(','); go('library'); }
    else if (a === 'retr') { T.input = h.src; T.result = null; go('translate'); }
  });
}
function renderHistList() {
  const box = $('#hlist');
  if (!box) return;
  const q = H.q.trim().toLowerCase();
  const list = hist.filter((h) => {
    if (H.filter === 'gen' && h.type !== 'gen') return false;
    if (H.filter === 'tr' && h.type !== 'tr') return false;
    if (H.filter === 'fav' && !h.fav) return false;
    return !q || [h.prompt, h.neg, h.src, h.dst, (h.chars || []).join(' ')].some((s) => s && String(s).toLowerCase().includes(q));
  });
  $('#hc').textContent = `${list.length}개`;
  if (!list.length) {
    box.innerHTML = `<div class="empty">${icon('history')}${hist.length ? '검색 결과가 없어요' : '아직 기록이 없어요.<br>NovelAI 에서 생성하거나 번역하면 자동으로 쌓여요.'}</div>`;
    return;
  }
  box.innerHTML = `<div class="hl">${list.slice(0, H.limit).map((h) => {
    const meta = h.type === 'gen' ? [h.w && h.h ? `${h.w}×${h.h}` : '', h.seed != null ? `seed ${h.seed}` : '', h.count > 1 ? `${h.count}번 생성` : '', (h.snips || []).map((n) => TG() + n).join(' ')].filter(Boolean).join(' · ') : '';
    const sec = (key, label, text, cls) => `<div class="sect ${cls}"><div class="sh"><span>${label}</span><button class="ib" data-h="sec" data-sec="${key}" title="${label} 복사">${icon('copy')}</button></div><div class="txt${cls === 'base' ? '' : ' sm'}">${esc(text)}</div></div>`;
    const body = h.type === 'gen'
      ? sec('base', '베이스', h.prompt, 'base') + (h.chars || []).map((c, i) => sec('c' + i, `캐릭터 ${i + 1}`, c, 'char')).join('') + (h.neg ? sec('neg', '네거티브', h.neg, 'neg') : '')
      : `<div class="txt sm" style="margin:0 0 5px">${esc(h.src)}</div><div class="txt">${esc(h.dst)}</div>`;
    return `<div class="hi ${h.fav ? 'fav' : ''}" data-id="${h.id}">
      <div class="hi-top"><span class="k ${h.type}">${h.type === 'gen' ? '생성' : '번역'}</span><span class="time">${fmtTime(h.t)}</span><span class="meta grow">${esc(meta)}</span>
        <button class="ib ${h.fav ? 'on' : ''}" data-h="fav" title="즐겨찾기">${icon('star', h.fav)}</button><button class="ib del" data-h="del" title="삭제">${icon('trash')}</button></div>
      ${body}
      <div class="hi-act">${h.type === 'gen' ? '' : `<button class="btn sm" data-h="copy">${icon('copy')} 복사</button>`}
        ${h.type === 'gen' ? `<button class="btn sm" data-h="all">${icon('copy')} 전체 복사</button>
          ${F.root ? `<button class="btn sm" data-h="search">${icon('images')} 이 프롬프트 그림 찾기</button>` : ''}`
        : `<button class="btn sm" data-h="retr">${icon('languages')} 다시 번역</button>`}</div></div>`;
  }).join('')}</div>${list.length > H.limit ? `<div class="row" style="justify-content:center;margin-top:16px"><button class="btn" data-h="more">더 보기 (${list.length - H.limit})</button></div>` : ''}`;
}

/* ------------------------------------------------------------------ *
 * 사전
 * ------------------------------------------------------------------ */
const D = { q: '' };
function viewDict() {
  renderTop();
  const w = mount(`<div class="two">
    <div class="col">
      <div class="card"><h3>단어 추가 ${tip(`번역할 때 사전 → 기억 → 번역기 순서로 찾아요`)}</h3>
        <div class="row" style="flex-wrap:nowrap"><input class="in" id="dko" placeholder="한글 (예: 고양이귀)"><input class="in" id="den" placeholder="태그 (예: cat ears)">
          <button class="btn pri" id="dadd">${icon('plus')} 추가</button></div></div>
      <div class="search">${icon('search')}<input class="in" id="dq" placeholder="사전 검색" value="${esc(D.q)}"></div>
      <div class="chips" id="dlist"></div>
    </div>
    <div class="col">
      <div class="card"><h3>한 번에 여러 개 넣기 ${tip(`한 줄에 하나씩 한글 = 태그 형식으로 적어 주세요`)}</h3>
        <textarea class="ta mono" id="dbulk" placeholder="금발 = blonde hair&#10;고양이귀 = cat ears&#10;교복 = school uniform"></textarea>
        <div class="row" style="margin-top:10px"><button class="btn" id="dbulkgo">${icon('upload')} 모두 추가</button></div></div>
      <div class="card"><h3>번역 기억 ${tip(`번역기로 한 번 번역한 단어는 기억해 뒀다가 바로 꺼내 써요`)}</h3>
        <div class="row"><span class="cnt">지금 <b style="color:var(--fg)">${trCacheN.toLocaleString()}</b>개 기억 중</span><span class="grow"></span><button class="btn sm" id="dcache">${icon('trash')} 기억 비우기</button></div></div>
    </div></div>`);
  renderDictList();
  const add = async (pairs) => {
    const { dict: cur = {} } = await chrome.storage.local.get('dict');
    pairs.forEach(([k, v]) => (cur[k] = v));
    dict = cur;
    await chrome.storage.local.set({ dict: cur });
    renderDictList();
  };
  const addOne = async () => {
    const ko = $('#dko').value.trim(), en = $('#den').value.trim();
    if (!ko || !en) { toast('한글과 태그를 둘 다 적어 주세요', 'info'); return; }
    await add([[ko, en]]);
    $('#dko').value = $('#den').value = '';
    $('#dko').focus();
    toast(`사전에 추가 · ${ko} → ${en}`, 'ok');
  };
  $('#dadd', w).addEventListener('click', addOne);
  [$('#dko', w), $('#den', w)].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); addOne(); }
  }));
  $('#dq', w).addEventListener('input', (e) => { D.q = e.target.value; renderDictList(); });
  $('#dbulkgo', w).addEventListener('click', async () => {
    const pairs = $('#dbulk').value.split('\n').map((l) => l.split(/\s*(?:=|\t|→|->)\s*/)).filter((p) => p.length >= 2 && p[0].trim() && p[1].trim()).map((p) => [p[0].trim(), p.slice(1).join(' ').trim()]);
    if (!pairs.length) { toast('"한글 = 태그" 형식의 줄을 못 찾았어요', 'info'); return; }
    await add(pairs);
    $('#dbulk').value = '';
    toast(`${pairs.length}개를 사전에 넣었어요`, 'ok');
  });
  $('#dcache', w).addEventListener('click', async () => {
    if (!confirm('번역 기억을 비울까요? 사전은 그대로 남아요.')) return;
    await chrome.storage.local.set({ trCache: {} });
    trCacheN = 0;
    viewDict();
  });
  $('#dlist', w).addEventListener('change', async (e) => {
    const k = e.target.dataset.edit;
    if (k == null || !e.target.value.trim()) return;
    await add([[k, e.target.value.trim()]]);
    toast('수정했어요', 'ok', 1000);
  });
  $('#dlist', w).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const { dict: cur = {} } = await chrome.storage.local.get('dict');
    delete cur[b.dataset.del];
    dict = cur;
    await chrome.storage.local.set({ dict: cur });
    renderDictList();
  });
}
function renderDictList() {
  const box = $('#dlist');
  if (!box) return;
  const q = D.q.trim().toLowerCase();
  const entries = Object.entries(dict).filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)).reverse();
  box.innerHTML = entries.length
    ? entries.map(([k, v]) => `<div class="chip"><span class="src" title="${esc(k)}">${esc(k)}</span><span class="arr">${icon('arrow')}</span>
        <input data-edit="${esc(k)}" value="${esc(v)}" spellcheck="false"><button class="ib del" data-del="${esc(k)}" title="삭제">${icon('trash')}</button></div>`).join('')
    : `<div class="empty" style="padding:40px 10px">${icon('book')}${Object.keys(dict).length ? '검색 결과가 없어요' : '사전이 비어 있어요'}</div>`;
}

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */
function viewSettings() {
  renderTop();
  const sample = { t: Date.now(), meta: { seed: 1234567890, prompt: '1girl, blonde hair', model: 'nai-diffusion-4-5-full', snips: ['미오'] }, n: 1, w: 832, h: 1216, hash: 'a1b2c3d4e5' };
  // 저장 위치를 폴더 나무로 보여줌
  const preview = () => {
    const { subdir, name } = X.computeTarget(sample, S, S.saveMode === 'convert' ? X.outKind(S.convFormat, 'png') : 'png');
    const exts = { none: [], txt: ['txt'], json: ['json'], both: ['txt', 'json'] }[S.sidecar] || [];
    const parts = subdir ? subdir.split('/') : [];
    const ind = (n) => '&nbsp;&nbsp;&nbsp;'.repeat(n);
    const lines = [`${icon('folder')}<b>${esc(F.root ? F.root.name : '다운로드/' + S.dlFolder)}</b>`];
    parts.forEach((p, i) => lines.push(`${ind(i)}└ ${icon('folder')}<b>${esc(p)}</b>`));
    lines.push(`${ind(parts.length)}└ <span style="color:var(--acc)">${esc(name)}</span>`);
    exts.forEach((e) => lines.push(`${ind(parts.length)}&nbsp;&nbsp;&nbsp;${esc(X.baseName(name))}.${e}`));
    return `<div class="tree">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
  };
  // 폴더 규칙 ↔ 1단·2단·3단 칸
  const PART_VALUES = X.DIR_PARTS.map(([v]) => v).filter(Boolean);
  const segs = String(S.subdirTpl || '').split('/').filter(Boolean);
  const slots = segs.length > 3 ? null : [0, 1, 2].map((i) => {
    const s = segs[i];
    if (!s) return { v: '', text: '' };
    return PART_VALUES.includes(s) ? { v: s, text: '' } : { v: 'custom', text: s };
  });
  const PRESETS = [['날짜별', '{date}'], ['캐릭터 › 날짜', '{char}/{date}'], ['작업 › 날짜', '{project}/{date}'], ['연도 › 월 › 일', '{year}/{month}/{day}'], ['작업 › 연-월 › 일', '{project}/{ym}/{day}'], ['캐릭터 › 방향 › 날짜', '{char}/{orient}/{date}']];
  const slotHTML = (s, i) => `<div class="slot"><div class="cnt">${i + 1}단</div>
      <select class="sel" data-slot="${i}">${X.DIR_PARTS.map(([v, l]) => `<option value="${v}" ${s.v === v ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${s.v === 'custom' ? 'selected' : ''}>직접 입력…</option></select>
      <input class="in" data-slot-text="${i}" placeholder="폴더 이름" value="${esc(s.text)}" ${s.v === 'custom' ? '' : 'hidden'}></div>`;
  const o = X.convOpts(S);
  const w = mount(`<div class="two">
    <div class="col">
      <div class="card"><h3>저장 폴더 ${tip(`생성된 이미지가 들어갈 곳이에요`)}</h3>
        <div class="opt"><div class="t"><div class="a">${F.root ? esc(F.root.name) : '연결 안 됨'}</div>
          <div class="b"><span class="dotst ${!F.root ? '' : F.perm === 'granted' ? 'ok' : 'warn'}"></span>${!F.root ? '연결하지 않으면 다운로드 폴더에 저장돼요' : F.perm === 'granted' ? '연결됨' : '권한이 필요해요'}</div></div>
          ${F.root && F.perm !== 'granted' ? `<button class="btn sm pri" data-s="grant">허용</button>` : ''}
          <button class="btn sm" data-s="connect">${F.root ? '변경' : '연결'}</button>
          ${F.root ? `<button class="btn sm ghost" data-s="disconnect">끊기</button>` : ''}</div>
        <div class="opt"><div class="t"><div class="a">권한 없을 때 저장할 다운로드 폴더 ${tip(`권한이 꺼져 있을 때 다운로드/${esc(S.dlFolder)} 에 대신 저장해요`)}</div></div>
          <input class="in" data-k="dlFolder" value="${esc(S.dlFolder)}" style="width:150px;height:34px"></div>
      </div>
      <div class="card"><h3>자동 저장 ${tip(`NovelAI 에서 생성하면 바로 저장돼요`)}</h3>
        <div class="opt"><div class="t"><div class="a">자동 저장</div></div>${sw('data-k="autoSave"', S.autoSave)}</div>
        <div class="opt"><div class="t"><div class="a">저장 방식 ${tip(`메타 제거는 오른쪽 변환 기본값을 따라요`)}</div></div>
          <div class="seg" id="smode"><button data-sm="original" class="${S.saveMode === 'original' ? 'on' : ''}">원본 PNG</button><button data-sm="convert" class="${S.saveMode === 'convert' ? 'on' : ''}">메타 제거</button></div></div>
        <div class="opt"><div class="t"><div class="a">PNG 최종본만 잡기 ${tip(`생성 중 미리보기는 저장하지 않아요`)}</div></div>${sw('data-k="pngOnly"', S.pngOnly)}</div>
        <div class="opt" style="display:block"><div class="t"><div class="a">파일 이름 규칙</div><div class="b"><code>{date} {ymd} {time} {seed} {n} {prompt} {model} {w} {h} {hash}</code></div></div>
          <input class="in mono" data-k="filenameTpl" value="${esc(S.filenameTpl)}" style="margin-top:8px"></div>
      </div>
      <div class="card"><h3>폴더 나누기 ${tip(`최대 3단까지 나눠서 저장해요. 1단이 가장 큰 폴더예요.`)}</h3>
        <div class="row" id="presets" style="margin-bottom:12px">${PRESETS.map(([l, v]) => `<button class="btn sm ${S.subdirTpl === v ? 'pri' : ''}" data-preset="${esc(v)}">${l}</button>`).join('')}<button class="btn sm ghost" data-preset="">나누지 않기</button></div>
        ${slots ? `<div class="dirb" id="dirb">${slots.map(slotHTML).join('<div class="sep">›</div>')}</div>`
          : `<div class="tip">3단보다 깊은 규칙이에요. 아래 직접 쓰기에서 고쳐 주세요.</div>`}
        <div class="opt" style="margin-top:6px"><div class="t"><div class="a">지금 작업 이름 ${tip(`＂작업 이름＂ 칸에 들어가요 · NovelAI 패널의 최근 탭에서도 바꿀 수 있어요`)}</div></div>
          <input class="in" data-k="project" value="${esc(S.project || '')}" placeholder="미분류" style="width:170px;height:32px"></div>
        <div class="lbl" style="margin:10px 0 6px">이렇게 저장돼요</div>
        <div id="pv">${preview()}</div>
        <details style="margin-top:12px"><summary class="cnt" style="cursor:pointer">직접 쓰기 (고급)</summary>
          <input class="in mono" data-k="subdirTpl" value="${esc(S.subdirTpl)}" style="margin-top:8px">
          <div class="cnt" style="margin-top:4px">${X.DIR_PARTS.filter(([v]) => v).map(([v, l]) => `<code>${v}</code> ${l}`).join(' · ')}</div></details>
      </div>
      <div class="card"><h3>생성 정보 파일 ${tip(`PNG 안 정보는 메타 제거·편집·업로드하면 사라질 수 있어요. 이미지 옆에 같은 이름의 텍스트 파일로도 남겨 둬요.`)}</h3>
        <div class="opt"><div class="t"><div class="a">이미지 옆에 저장 ${tip(`TXT 는 눈으로 읽기 좋고, JSON 은 생성 설정 전체가 들어가요`)}</div></div>
          <div class="seg" id="sidefmt">${[['none', '끄기'], ['txt', 'TXT'], ['json', 'JSON'], ['both', '둘 다']].map(([k, l]) => `<button data-sf="${k}" class="${S.sidecar === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="opt"><div class="t"><div class="a">기록 · 사전도 폴더에 백업 ${tip(`바뀔 때마다 _백업/기록_사전_백업.json 에 저장 · 설정의 ＂백업 불러오기＂로 되살릴 수 있어요`)}</div></div>${sw('data-k="folderBackup"', S.folderBackup)}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" data-s="sideAll" ${F.root && F.perm === 'granted' ? '' : 'disabled'}>${icon('file')} 정보 파일 없는 사진에 모두 만들기</button>
          <button class="btn sm" data-s="exportMeta" ${F.root && F.perm === 'granted' ? '' : 'disabled'}>${icon('download')} 전체 생성 정보 한 파일로</button>
        </div>
      </div>
    </div>
    <div class="col">
      <div class="card"><h3>변환 기본값 ${tip(`자동 저장(메타 제거)과 변환 화면에서 써요`)}</h3><div id="co">${convOptsHTML(o)}</div></div>
      <div class="card"><h3>화면</h3>
        <div class="opt"><div class="t"><div class="a">노트 색 ${tip(`자동은 윈도우 · 브라우저의 밝게/어둡게 설정을 따라가요`)}</div></div>
          <div class="seg" id="thseg">${[['auto', '자동'], ['light', '밝은 노트'], ['dark', '밤 노트']].map(([k, l]) => `<button data-th="${k}" class="${S.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div id="colors">${colorsHTML()}</div></div>
      <div class="card"><h3>번역</h3>
        <div class="opt"><div class="t"><div class="a">태그 모드 ${tip(`쉼표 단위로 나눠서 번역하고 태그 모양으로 다듬어요`)}</div></div>${sw('data-k="tagMode"', S.tagMode)}</div>
        <div class="opt"><div class="t"><div class="a">소문자로</div></div>${sw('data-k="lowercase"', S.lowercase)}</div>
        <div class="opt"><div class="t"><div class="a">관사 빼기 ${tip(`a / an / the 로 시작하면 지워요`)}</div></div>${sw('data-k="stripArticles"', S.stripArticles)}</div></div>
      <div class="card"><h3>기록 · 백업</h3>
        <div class="opt"><div class="t"><div class="a">기록 최대 개수 ${tip(`즐겨찾기는 개수와 상관없이 남아요`)}</div></div>
          <select class="sel" data-k="historyMax">${[100, 300, 500, 1000, 3000].map((v) => `<option value="${v}" ${S.historyMax === v ? 'selected' : ''}>${v}개</option>`).join('')}</select></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-s="export">${icon('download')} 백업 내보내기</button><button class="btn sm" data-s="import">${icon('upload')} 백업 불러오기</button>
          <input type="file" accept=".json,application/json" hidden id="imp"><span class="grow"></span><button class="btn sm danger" data-s="wipe">${icon('trash')} 초기화</button></div></div>
      <div class="card"><h3>단축키</h3><div class="cd" style="margin:0;line-height:2">
        <kbd>Alt</kbd>+<kbd>N</kbd> NovelAI 페이지 패널 열기 · 닫기<br><kbd>Alt</kbd>+<kbd>Q</kbd> 선택한 한글을 그 자리에서 번역<br>
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> 프롬프트 칸 전체 번역<br><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> 스튜디오 열기 (chrome://extensions/shortcuts 에서 변경)<br>
        라이브러리: <kbd>/</kbd> 검색 · <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+클릭 선택 · 보기 창에서 <kbd>←</kbd><kbd>→</kbd> <kbd>Del</kbd> <kbd>Esc</kbd></div></div>
    </div></div>`);
  bindConvOpts($('#co', w), o, () => { savePatch(optsToSettings(o)); $('#pv').innerHTML = preview(); });
  // 1단·2단·3단 칸 → 폴더 규칙
  const slotsToTpl = () => [0, 1, 2].map((i) => {
    const v = w.querySelector(`[data-slot="${i}"]`).value;
    return v === 'custom' ? X.sanitizeDir(w.querySelector(`[data-slot-text="${i}"]`).value) : v;
  }).filter(Boolean).join('/');
  const rerender = () => { const y = $('#view').scrollTop; viewSettings(); $('#view').scrollTop = y; };
  let slotTimer = 0;
  const applySlots = (later) => {
    S.subdirTpl = slotsToTpl();
    $('#pv').innerHTML = preview();
    const raw = w.querySelector('[data-k="subdirTpl"]');
    if (raw) raw.value = S.subdirTpl;
    clearTimeout(slotTimer);
    slotTimer = setTimeout(() => savePatch({ subdirTpl: S.subdirTpl }), later ? 500 : 0);
  };
  w.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-preset]');
    if (!p) return;
    await savePatch({ subdirTpl: p.dataset.preset });
    toast(p.dataset.preset ? `폴더 나누기: ${p.textContent.trim()}` : '폴더를 나누지 않고 맨 위에 저장해요', 'ok', 1500);
    rerender();
  });
  w.addEventListener('change', async (e) => {
    if (e.target.dataset.slot != null) {
      const t = w.querySelector(`[data-slot-text="${e.target.dataset.slot}"]`);
      t.hidden = e.target.value !== 'custom';
      if (!t.hidden) t.focus();
      applySlots(false);
      return;
    }
    const k = e.target.dataset.k;
    if (!k) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'historyMax') v = +v;
    if (k === 'filenameTpl' && !String(v).trim()) v = X.DEFAULTS.filenameTpl;
    if (k === 'dlFolder') v = X.sanitizePath(v) || 'NovelAI';
    if (k === 'subdirTpl') v = X.sanitizePath(v);
    if (k === 'project') v = String(v).trim();
    await savePatch({ [k]: v });
    if (k === 'subdirTpl') { rerender(); return; }
    $('#pv').innerHTML = preview();
    renderSide();
  });
  w.addEventListener('input', (e) => {
    if (e.target.dataset.slotText != null) { applySlots(true); return; }
    const k = e.target.dataset.k;
    if (k === 'subdirTpl' || k === 'filenameTpl' || k === 'project') { S[k] = e.target.value; $('#pv').innerHTML = preview(); }
  });
  $('#thseg', w).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-th]');
    if (!b) return;
    await savePatch({ theme: b.dataset.th });
    X.applyTheme(S.theme, S.colors);
    syncThemeBtn();
    $('#thseg').querySelectorAll('[data-th]').forEach((x) => x.classList.toggle('on', x === b));
    $('#colors').innerHTML = colorsHTML();
  });
  // 색 꾸미기 — 지금 보이는 노트(밝은/밤)의 색만 바꿈
  const colorBox = $('#colors', w);
  let colorTimer = 0;
  colorBox.addEventListener('input', (e) => {
    const k = e.target.dataset.col;
    if (!k) return;
    const t = X.effectiveTheme(S.theme);
    const cols = JSON.parse(JSON.stringify(S.colors || {}));
    cols[t] = Object.assign({}, cols[t], { [k]: e.target.value });
    const wasPreset = 'preset' in cols;
    delete cols.preset; // 직접 바꾸면 '내 색'
    S.colors = cols;
    X.applyTheme(S.theme, S.colors);
    e.target.nextElementSibling.style.color = e.target.value;
    if (wasPreset || colorBox.querySelector('.cpre .on[data-cpre]')) {
      colorBox.querySelectorAll('.cpre .on').forEach((x) => x.classList.remove('on'));
      if (!colorBox.querySelector('.cpre [disabled]')) colorBox.querySelector('.cpre').insertAdjacentHTML('beforeend', '<button class="on" disabled><span class="dots"><i style="background:conic-gradient(#c8327f,#a07e00,#0080b8,#c8327f)"></i></span>내 색</button>');
    }
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => savePatch({ colors: S.colors }), 300);
  });
  colorBox.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cpre]');
    if (!b) return;
    const p = X.COLOR_PRESETS.find((x) => x.id === b.dataset.cpre);
    const cols = p.id === 'default' ? {} : { light: Object.assign({}, p.light), dark: Object.assign({}, p.dark), preset: p.id };
    await savePatch({ colors: cols });
    X.applyTheme(S.theme, S.colors);
    colorBox.innerHTML = colorsHTML();
  });
  $('#sidefmt', w).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sf]');
    if (!b) return;
    await savePatch({ sidecar: b.dataset.sf });
    $('#sidefmt').querySelectorAll('[data-sf]').forEach((x) => x.classList.toggle('on', x === b));
    $('#pv').innerHTML = preview();
  });
  $('#smode', w).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sm]');
    if (!b) return;
    await savePatch({ saveMode: b.dataset.sm });
    $('#smode').querySelectorAll('[data-sm]').forEach((x) => x.classList.toggle('on', x === b));
    $('#pv').innerHTML = preview();
    renderSide();
  });
  const imp = $('#imp', w);
  imp.addEventListener('change', async () => {
    const f = imp.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const { history: cur = [], dict: cd = {}, snippets: cs = {} } = await chrome.storage.local.get(['history', 'dict', 'snippets']);
      const ids = new Set(cur.map((h) => h.id));
      (j.history || []).forEach((h) => { if (h && h.id && !ids.has(h.id)) cur.push(h); });
      cur.sort((a, b) => (b.t || 0) - (a.t || 0));
      await chrome.storage.local.set({ history: cur, dict: Object.assign(cd, j.dict || {}), snippets: Object.assign(cs, j.snippets || {}) });
      toast(`불러왔어요 · 기록 ${(j.history || []).length}개 · 사전 ${Object.keys(j.dict || {}).length}개 · 치환어 ${Object.keys(j.snippets || {}).length}개`, 'ok');
    } catch (err) { toast('백업 파일을 읽지 못했어요', 'err'); }
    imp.value = '';
  });
  w.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const a = b.dataset.s;
    if (a === 'grant') regrant();
    else if (a === 'connect') connectFolder();
    else if (a === 'sideAll' || a === 'exportMeta') {
      if (!L.loaded) { toast('폴더를 읽는 중이에요…', 'info', 1500); await loadLibrary(); }
      if (!L.loaded) return;
      const recs = L.files.filter((r) => !inTrash(r));
      if (a === 'sideAll') {
        const todo = recs.filter((r) => !r.side);
        if (!todo.length) { toast('모든 사진에 이미 정보 파일이 있어요', 'ok'); return; }
        if (!confirm(`정보 파일이 없는 사진 ${todo.length}장에 .txt / .json 을 만들까요?`)) return;
        await makeSidecarsBulk(todo);
        if (view !== 'settings') go('settings');
      } else {
        toast(`${recs.length}장의 생성 정보를 모으는 중…`, 'info', 2000);
        const out = [];
        for (const r of recs) {
          const m = await metaOf(r).catch(() => null);
          if (!m || !(m.prompt || m.neg)) continue;
          out.push({ path: r.path, savedAt: new Date(r.mtime).toISOString(), prompt: m.prompt || '', characters: m.chars || [], negative: m.neg || '', seed: m.seed, steps: m.steps, scale: m.scale, sampler: m.sampler, width: m.w, height: m.h, model: m.model || undefined, request: m.raw });
        }
        const data = JSON.stringify({ app: 'NAI Folio', format: 1, folder: F.root.name, exportedAt: new Date().toISOString(), count: out.length, images: out }, null, 2);
        await downloadBlob(new Blob([data], { type: 'application/json' }), `NAI_생성정보_전체_${X.stamp()}.json`);
        toast(`${out.length}장의 생성 정보를 한 파일로 저장했어요`, 'ok');
      }
    }
    else if (a === 'disconnect') disconnectFolder();
    else if (a === 'export') {
      const data = JSON.stringify({ app: 'nai-studio', v: 1, at: new Date().toISOString(), history: hist, dict, snippets, settings: S }, null, 2);
      downloadBlob(new Blob([data], { type: 'application/json' }), `nai-studio-backup_${X.stamp()}.json`);
    } else if (a === 'import') imp.click();
    else if (a === 'wipe') {
      if (!confirm('기록 · 사전 · 번역 기억 · 설정을 모두 지울까요? (폴더 연결과 폴더 안 파일은 그대로예요)')) return;
      await chrome.storage.local.set({ history: [], dict: {}, trCache: {}, savedHashes: [], settings: Object.assign({}, X.DEFAULTS) });
      S = await X.getSettings();
      trCacheN = 0;
      toast('초기화했어요', 'ok');
      render();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 실시간 반영
 * ------------------------------------------------------------------ */
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.settings) { S = Object.assign({}, X.DEFAULTS, ch.settings.newValue || {}); X.applyTheme(S.theme, S.colors); syncThemeBtn(); }
  if (ch.history) { hist = ch.history.newValue || []; if (view === 'history') renderHistList(); }
  if (ch.dict) { dict = ch.dict.newValue || {}; if (view === 'dict') renderDictList(); }
  if (ch.snippets) { snippets = ch.snippets.newValue || {}; if (view === 'snippets') { renderSnList(); renderSnTest(); } }
  if (ch.trCache) trCacheN = Object.keys(ch.trCache.newValue || {}).length;
  if (ch.stats) stats = ch.stats.newValue || stats;
  if (ch.folderPerm && F.root && ch.folderPerm.newValue === 'prompt' && F.perm === 'granted') {
    // 다른 곳에서 권한 문제를 발견 → 다시 확인
    X.permState(F.root, false).then((s) => { if (s !== F.perm) { F.perm = s; render(); } }).catch(() => {});
  }
  renderSide();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target === 'offscreen') return false;
  if (msg.type === 'saved') addSavedFile(msg);
  return false;
});
async function addSavedFile(msg) {
  if (msg.via !== 'folder' || !F.root || !L.loaded) return;
  const idx = msg.path.lastIndexOf('/');
  const dirPath = idx >= 0 ? msg.path.slice(0, idx) : '';
  const name = msg.path.slice(idx + 1);
  try {
    const dir = await X.getDir(F.root, dirPath);
    const handle = await dir.getFileHandle(name);
    const f = await handle.getFile();
    let side = null;
    for (const ext of msg.side || []) {
      try { const n = `${X.baseName(name)}.${ext}`; (side = side || {})[ext] = { name: n, handle: await dir.getFileHandle(n) }; } catch (e) { /* noop */ }
    }
    const r = { name, dirPath, path: msg.path, handle, dir, side, size: f.size, mtime: f.lastModified, meta: msg.meta ? Object.assign({ source: 'capture' }, msg.meta) : undefined, fresh: true };
    L.files.unshift(r);
    if (dirPath && !L.dirs.includes(dirPath)) { L.dirs.push(dirPath); L.dirs.sort(); }
    setTimeout(() => { r.fresh = false; }, 6000);
    // 빈 폴더 화면이었다면 목록 화면을 처음부터 그려야 함
    if (view === 'library' && !LB.open) { if ($('#grid')) { renderDirs(); refreshGrid(true); } else render(); }
    renderSide();
  } catch (e) { /* 다음 새로고침 때 잡힘 */ }
}

/* ------------------------------------------------------------------ *
 * 키보드
 * ------------------------------------------------------------------ */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (modals.length) {
    if (e.key === 'Escape' && !modals[modals.length - 1].busy) modals[modals.length - 1].close();
    return;
  }
  if (LB.open) {
    if (typing) return;
    if (e.key === 'F2') { e.preventDefault(); const r = L.list[LB.i]; if (r && !inTrash(r)) startRename(r); }
    else if (e.key === 'Escape') closeLB();
    else if (e.key === 'ArrowLeft' && LB.i > 0) { LB.i--; renderLB(); }
    else if (e.key === 'ArrowRight' && LB.i < L.list.length - 1) { LB.i++; renderLB(); }
    else if (e.key === 'Delete') {
      const r = L.list[LB.i];
      if (r && !inTrash(r)) lbTrash(r);
    }
    return;
  }
  if (view === 'library' && !typing) {
    if (e.key === '/') { e.preventDefault(); const q = $('#q'); if (q) q.focus(); }
    else if (e.key === 'Escape' && (L.sel.size || L.pickMode)) exitPick();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && L.list.length) { e.preventDefault(); L.list.forEach((r) => L.sel.add(r.path)); refreshGrid(true); }
  }
});

/* ------------------------------------------------------------------ *
 * ⓘ 툴팁 (포스트잇)
 * ------------------------------------------------------------------ */
const tipBox = document.createElement('div');
tipBox.className = 'tipbox';
tipBox.hidden = true;
document.body.appendChild(tipBox);
function showTip(el) {
  tipBox.textContent = el.dataset.tip;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  let y = r.top - h - 8;
  if (y < 8) y = r.bottom + 8;
  tipBox.style.left = x + 'px';
  tipBox.style.top = y + 'px';
}
document.addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t); else tipBox.hidden = true; });
document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', () => { tipBox.hidden = true; });
document.addEventListener('scroll', () => { tipBox.hidden = true; }, true);

/* ------------------------------------------------------------------ *
 * 시작
 * ------------------------------------------------------------------ */
document.documentElement.style.setProperty('--tile', S.tile + 'px');
X.applyTheme(S.theme, S.colors);
renderShell();
render();
