import { EXT, getSettings, translatePrompt, computeTarget, convertBlob, convOpts, outKind, saveConvert, blobToDataURL, today, uid, sidecarJSON, sidecarTXT, baseName } from './shared.js';

/* ------------------------------------------------------------------ *
 * 직렬 처리 (기록 동시 수정 방지)
 * ------------------------------------------------------------------ */
let lock = Promise.resolve();
const serial = (fn) => (lock = lock.then(fn, fn));

/* ------------------------------------------------------------------ *
 * offscreen 문서 — 폴더 핸들로 실제 파일을 쓰는 곳
 * ------------------------------------------------------------------ */
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '생성된 이미지를 사용자가 연결한 폴더에 저장합니다.' })
      .catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { creating = null; });
  }
  await creating;
}
async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let i = 0; i < 3; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      if (r) return r;
    } catch (e) { /* 아직 로드 중 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, reason: 'offscreen' };
}

/* ------------------------------------------------------------------ *
 * 배지 · 통계
 * ------------------------------------------------------------------ */
async function bumpStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const d = today();
  const s = stats && stats.day === d ? stats : { day: d, count: 0 };
  s.count++;
  await chrome.storage.local.set({ stats: s });
}
async function updateBadge() {
  const { stats, folderPerm, settings } = await chrome.storage.local.get(['stats', 'folderPerm', 'settings']);
  const S = Object.assign({ autoSave: true }, settings || {});
  if (folderPerm === 'prompt' && S.autoSave) {
    await chrome.action.setBadgeBackgroundColor({ color: '#fb7185' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'NAI Studio — 폴더 권한을 다시 허용해 주세요 (아이콘 클릭)' });
    return;
  }
  const n = stats && stats.day === today() ? stats.count : 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#b9a6ff' });
  await chrome.action.setBadgeText({ text: S.autoSave && n ? String(n > 999 ? '999+' : n) : '' });
  await chrome.action.setTitle({ title: `NAI Studio — 자동 저장 ${S.autoSave ? 'ON' : 'OFF'} · 오늘 ${n}장` });
}
// 기록 · 사전이 바뀌면 잠깐 모았다가 폴더 _백업 에도 저장
let backupTimer = null;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    const S = await getSettings();
    if (!S.folderBackup) return;
    const { history = [], dict = {}, snippets = {}, folderName } = await chrome.storage.local.get(['history', 'dict', 'snippets', 'folderName']);
    if (!folderName) return;
    await toOffscreen({ type: 'backup', history, dict, snippets });
  }, 3000);
}
chrome.storage.onChanged.addListener((ch) => {
  if (ch.stats || ch.folderPerm || ch.settings) updateBadge();
  if (ch.history || ch.dict || ch.snippets) scheduleBackup();
});

/* ------------------------------------------------------------------ *
 * 기록
 * ------------------------------------------------------------------ */
function prune(history, max) {
  let rest = 0;
  return history.filter((h) => h.fav || ++rest <= max);
}
function addGenHistory(fullMeta) {
  const meta = Object.assign({}, fullMeta);
  delete meta.raw; // 요청 전체는 정보 파일에만 — 기록은 가볍게
  return serial(async () => {
    const S = await getSettings();
    let { history = [] } = await chrome.storage.local.get('history');
    const same = (h) => h.type === 'gen' && h.prompt === meta.prompt && h.neg === meta.neg && JSON.stringify(h.chars || []) === JSON.stringify(meta.chars || []);
    const last = history.find((h) => h.type === 'gen');
    if (last && same(last)) Object.assign(last, meta, { t: Date.now(), count: (last.count || 1) + 1 });
    else history.unshift(Object.assign({ id: uid(), type: 'gen', t: Date.now(), fav: false, count: 1 }, meta));
    history.sort((a, b) => (b.t || 0) - (a.t || 0));
    history = prune(history, S.historyMax);
    await chrome.storage.local.set({ history });
  });
}
function addTrHistory(src, dst) {
  return serial(async () => {
    const S = await getSettings();
    let { history = [] } = await chrome.storage.local.get('history');
    const last = history.find((h) => h.type === 'tr');
    if (last && last.src === src) Object.assign(last, { dst, t: Date.now() });
    else history.unshift({ id: uid(), type: 'tr', t: Date.now(), fav: false, src, dst });
    history.sort((a, b) => (b.t || 0) - (a.t || 0));
    history = prune(history, S.historyMax);
    await chrome.storage.local.set({ history });
  });
}

/* ------------------------------------------------------------------ *
 * 저장 — 폴더가 되면 폴더, 안 되면 다운로드 폴더
 * ------------------------------------------------------------------ */
async function fallbackDownload(msg, S) {
  let dataUrl = msg.dataUrl, kind = msg.kind || 'png';
  if (saveConvert(msg, S)) {
    const blob = await (await fetch(msg.dataUrl)).blob();
    dataUrl = await blobToDataURL(await convertBlob(blob, convOpts(S)));
    kind = outKind(S.convFormat, kind);
  }
  const { subdir, name } = computeTarget(msg, S, kind);
  const filename = [S.dlFolder, subdir, name].map((p) => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false });
  // 다운로드 폴더로 저장할 때도 정보 파일을 같이
  const m = msg.meta;
  if (m && (m.prompt || m.neg) && S.sidecar && S.sidecar !== 'none') {
    const base = baseName(filename);
    const txtUrl = (s, mime) => `data:${mime};charset=utf-8,` + encodeURIComponent(s);
    if (S.sidecar === 'json' || S.sidecar === 'both') await chrome.downloads.download({ url: txtUrl(sidecarJSON(m, name, msg.t), 'application/json'), filename: base + '.json', conflictAction: 'uniquify', saveAs: false });
    if (S.sidecar === 'txt' || S.sidecar === 'both') await chrome.downloads.download({ url: txtUrl(sidecarTXT(m, name, msg.t), 'text/plain'), filename: base + '.txt', conflictAction: 'uniquify', saveAs: false });
  }
  return { ok: true, via: 'download', path: filename };
}

async function saveImage(msg) {
  const S = await getSettings();
  const { savedHashes = [] } = await chrome.storage.local.get('savedHashes');
  if (msg.hash && !msg.force && savedHashes.includes(msg.hash)) return { ok: true, dup: true };

  let res = await toOffscreen({ type: 'write', dataUrl: msg.dataUrl, kind: msg.kind, meta: msg.meta, t: msg.t, n: msg.n, w: msg.w, h: msg.h, hash: msg.hash, subdir: msg.subdir, name: msg.name, mode: msg.mode, settings: S });
  const reason = res && res.reason;
  if (res && res.ok) await chrome.storage.local.set({ folderPerm: 'granted' });
  else {
    if (reason === 'perm') await chrome.storage.local.set({ folderPerm: 'prompt' });
    res = await fallbackDownload(msg, S);
    res.fallbackReason = reason;
  }
  if (res.ok) {
    if (msg.hash) {
      savedHashes.push(msg.hash);
      await chrome.storage.local.set({ savedHashes: savedHashes.slice(-3000) });
    }
    await bumpStats();
    chrome.runtime.sendMessage({ type: 'saved', via: res.via, path: res.path, side: res.side || [], meta: msg.meta || null, t: msg.t || Date.now() }).catch(() => {});
  }
  return res;
}

async function openStudio(hash) {
  const url = chrome.runtime.getURL('studio.html');
  const tabs = await chrome.tabs.query({ url: url + '*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, ...(hash ? { url: url + '#' + hash } : {}) });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url + (hash ? '#' + hash : '') });
  }
}

/* ------------------------------------------------------------------ *
 * 메시지
 * ------------------------------------------------------------------ */
const handlers = {
  async translate(msg) {
    const S = await getSettings();
    const { dict = {}, trCache = {} } = await chrome.storage.local.get(['dict', 'trCache']);
    const before = Object.keys(trCache).length;
    const r = await translatePrompt(msg.text, S, dict, trCache);
    const keys = Object.keys(trCache);
    if (keys.length !== before) {
      if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach((k) => delete trCache[k]);
      await chrome.storage.local.set({ trCache });
    }
    if (r.dir === 'ko2en' && msg.record !== false) await addTrHistory(msg.text, r.output);
    return { ok: true, r };
  },
  async gen(msg) {
    if (msg.meta && msg.meta.prompt) await addGenHistory(msg.meta);
    return { ok: true };
  },
  async trHistory(msg) {
    await addTrHistory(msg.src, msg.dst);
    return { ok: true };
  },
  save: saveImage,
  // 패널의 "내 폴더" 사진 보기 — 폴더는 offscreen 문서만 읽을 수 있어서 거기로 전달
  async lib(msg) {
    return toOffscreen({ type: 'lib', op: msg.op, dir: msg.dir, q: msg.q, offset: msg.offset, limit: msg.limit, path: msg.path, fresh: msg.fresh, day: msg.day, scope: msg.scope });
  },
  // 골라서 저장 — 기본 폴더 · 이름 · 고를 수 있는 폴더 목록
  async saveTarget(msg) {
    const S = await getSettings();
    const kind = saveConvert(msg, S) ? outKind(S.convFormat, msg.kind || 'png') : msg.kind || 'png';
    const { subdir, name } = computeTarget({ t: msg.t, meta: msg.meta, n: msg.n, w: msg.w, h: msg.h, hash: msg.hash }, S, kind);
    const { folderName } = await chrome.storage.local.get('folderName');
    let dirs = [];
    if (folderName) { const r = await toOffscreen({ type: 'lib', op: 'dirs', fresh: !!msg.fresh }); if (r && r.ok) dirs = r.dirs; }
    return { ok: true, subdir, name: name.replace(/\.[^.]+$/, ''), ext: EXT[kind], dirs, folder: folderName || '', dlFolder: S.dlFolder };
  },
  async download(msg) {
    await chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename, conflictAction: 'uniquify', saveAs: !!msg.saveAs });
    return { ok: true };
  },
  async openStudio(msg) {
    await openStudio(msg.hash);
    return { ok: true };
  },
  async status() {
    const { stats, folderPerm, folderName } = await chrome.storage.local.get(['stats', 'folderPerm', 'folderName']);
    return { ok: true, folderName: folderName || '', folderPerm: folderPerm || 'none', today: stats && stats.day === today() ? stats.count : 0 };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.target === 'offscreen') return false;
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(send, (e) => send({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-studio') openStudio();
});

chrome.runtime.onInstalled.addListener((d) => {
  updateBadge();
  if (d.reason === 'install') openStudio('welcome');
});
chrome.runtime.onStartup.addListener(updateBadge);

// 1.6.9: 이미지마다 만드는 정보 파일은 기본 꺼짐으로 — 예전 버전에서 저장된 '둘 다' 설정도 한 번만 끔
(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && !settings._sidecarOff) {
    settings.sidecar = 'none';
    settings._sidecarOff = true;
    await chrome.storage.local.set({ settings });
  }
})();
