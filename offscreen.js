import { getRoot, getDir, writeFile, writeText, writeSidecars, computeTarget, convertBlob, convOpts, outKind, saveConvert, idbGet, idbSet, idbAll, listImages, makeThumb, readImageMeta, readSidecar, blobToDataURL, makeQueue } from './shared.js';

// 서비스 워커에선 폴더 핸들로 파일을 못 써서, 이 보이지 않는 문서가 대신 씀
// (NovelAI 페이지의 패널도 폴더를 직접 못 만지므로, 사진 목록 · 썸네일도 여기서 만들어 보내 줌)
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.target !== 'offscreen') return false;
  const fn = { write, backup, lib }[msg.type];
  if (!fn) return false;
  fn(msg).then(send, (e) => send({ ok: false, reason: 'error', error: String((e && e.message) || e) }));
  return true;
});

async function grantedRoot() {
  const root = await getRoot();
  if (!root) return null;
  try { return (await root.queryPermission({ mode: 'readwrite' })) === 'granted' ? root : null; } catch (e) { return null; }
}

// 기록 · 사전을 폴더 안 _백업 에 통째로 (불러오기와 같은 형식)
async function backup(msg) {
  const root = await grantedRoot();
  if (!root) return { ok: false, reason: 'perm' };
  const dir = await getDir(root, '_백업', true);
  const data = { app: 'nai-studio', v: 1, at: new Date().toISOString(), history: msg.history || [], dict: msg.dict || {}, snippets: msg.snippets || {} };
  await writeText(dir, '기록_사전_백업.json', JSON.stringify(data, null, 2), 'application/json');
  // 치환어(청크)는 따로 — 눈으로 읽는 txt 와 되살리기용 json
  const sn = msg.snippets || {};
  const names = Object.keys(sn).sort((a, b) => a.localeCompare(b, 'ko'));
  await writeText(dir, '치환어.json', JSON.stringify({ app: 'nai-studio', kind: 'snippets', at: data.at, snippets: sn }, null, 2), 'application/json');
  await writeText(dir, '치환어.txt', names.map((n) => `[${n}]\n${sn[n]}\n`).join('\n'));
  return { ok: true };
}

async function write(msg) {
  const root = await getRoot();
  if (!root) return { ok: false, reason: 'nofolder' };
  let perm = 'prompt';
  try { perm = await root.queryPermission({ mode: 'readwrite' }); } catch (e) { return { ok: false, reason: 'perm' }; }
  if (perm !== 'granted') return { ok: false, reason: 'perm' };

  const S = msg.settings;
  let blob = await (await fetch(msg.dataUrl)).blob();
  let kind = msg.kind || 'png';
  if (saveConvert(msg, S)) {
    blob = await convertBlob(blob, convOpts(S));
    kind = outKind(S.convFormat, kind);
  }
  const { subdir, name } = computeTarget(msg, S, kind);
  const r = await writeFile(root, subdir, name, blob);
  // 이미지 옆에 같은 이름의 .txt / .json — 메타 제거로 저장해도 생성 정보가 파일로 남음
  let side = [];
  try { side = await writeSidecars(r.dir, r.name, msg.meta, msg.t, S.sidecar); } catch (e) { console.warn('정보 파일 저장 실패', e); }
  if (msg.meta) await idbSet('meta', r.path, Object.assign({}, msg.meta, { t: msg.t, source: 'capture' }));
  libCache = null; // 새 사진 → 목록 다시 읽기
  return { ok: true, via: 'folder', path: r.path, name: r.name, side };
}

/* ---------- 패널용 사진 보기 ---------- */
const TRASH = '_휴지통';
let libCache = null;
const statQ = makeQueue(24), thumbQ = makeQueue(4);
async function libFiles(root, fresh) {
  if (!fresh && libCache && Date.now() - libCache.t < 20000) return libCache.files;
  const { files, dirs } = await listImages(root);
  await Promise.all(files.map((f) => statQ(async () => {
    try { const fl = await f.handle.getFile(); f.size = fl.size; f.mtime = fl.lastModified; } catch (e) { f.size = 0; f.mtime = 0; }
  })));
  files.sort((a, b) => b.mtime - a.mtime);
  libCache = { t: Date.now(), files, dirs };
  return files;
}
const mkey = (f) => `${f.path}|${f.mtime}|${f.size}`;
// 스튜디오와 같은 썸네일 캐시를 같이 씀
function thumbData(f) {
  return thumbQ(async () => {
    let b = await idbGet('thumbs', mkey(f)).catch(() => null);
    if (!b) {
      b = await makeThumb(await f.handle.getFile(), 420);
      idbSet('thumbs', mkey(f), b).catch(() => {});
    }
    return blobToDataURL(b);
  }).catch(() => null);
}
const slimMeta = (m) => (m ? { prompt: m.prompt || '', neg: m.neg || '', chars: m.chars || [], charNegs: m.charNegs || [], seed: m.seed, steps: m.steps, scale: m.scale, sampler: m.sampler, schedule: m.schedule, smea: m.smea, rescale: m.rescale, w: m.w, h: m.h, model: m.model || '', modelName: m.modelName || '', reqType: m.reqType || '', via: m.via || m.source || '' } : null);

async function lib(msg) {
  const root = await grantedRoot();
  if (!root) return { ok: false, reason: (await getRoot()) ? 'perm' : 'nofolder' };
  const files = await libFiles(root, msg.fresh);

  if (msg.op === 'list') {
    const dir = msg.dir || '';
    const inDir = files.filter((f) => f.dirPath !== TRASH && !f.dirPath.startsWith(TRASH + '/') && (!dir || f.dirPath === dir || f.dirPath.startsWith(dir + '/')));
    let list = inDir;
    const terms = String(msg.q || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (terms.length) {
      const [capIdx, pngIdx] = await Promise.all([idbAll('meta'), idbAll('pngmeta')]);
      list = inDir.filter((f) => {
        const m = capIdx.get(f.path) || pngIdx.get('m2|' + mkey(f)) || {};
        const hay = `${f.name} ${m.prompt || ''} ${(m.chars || []).join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    // 지금 폴더 바로 안의 폴더들
    const kids = new Map();
    for (const f of inDir) {
      if (!f.dirPath || (dir && !f.dirPath.startsWith(dir + '/'))) continue;
      if (dir && f.dirPath === dir) continue;
      const rest = dir ? f.dirPath.slice(dir.length + 1) : f.dirPath;
      const p = (dir ? dir + '/' : '') + rest.split('/')[0];
      kids.set(p, (kids.get(p) || 0) + 1);
    }
    const dirs = [...kids].map(([path, count]) => ({ path, count }))
      .sort((a, b) => (/^\d/.test(a.path.split('/').pop()) ? b.path.localeCompare(a.path, 'ko', { numeric: true }) : a.path.localeCompare(b.path, 'ko', { numeric: true })));
    // 폴더 카드에 삐죽 나올 최근 사진 3장 (files 는 최신순)
    await Promise.all(dirs.slice(0, 24).map(async (d) => {
      const pics = inDir.filter((f) => f.dirPath === d.path || f.dirPath.startsWith(d.path + '/')).slice(0, 3);
      d.thumbs = (await Promise.all(pics.map(thumbData))).filter(Boolean);
    }));
    // 안에 폴더가 있으면 하루치만 (검색할 땐 전부)
    let days = [], day = '';
    if (!terms.length && dirs.length && msg.scope !== 'all') {
      const dk = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      days = [...new Set(list.map((f) => dk(f.mtime)))].sort().reverse();
      day = days.includes(msg.day) ? msg.day : days[0] || '';
      list = list.filter((f) => dk(f.mtime) === day);
    }
    const off = msg.offset || 0, lim = msg.limit || 24;
    const page = list.slice(off, off + lim);
    const items = await Promise.all(page.map(async (f) => ({ path: f.path, name: f.name, mtime: f.mtime, thumb: await thumbData(f) })));
    return { ok: true, folder: root.name, total: list.length, dirs, items, days, day };
  }

  // 골라서 저장할 때 고를 수 있는 폴더들
  if (msg.op === 'dirs') {
    return { ok: true, folder: root.name, dirs: (libCache.dirs || []).filter((d) => !/^(_휴지통|_백업)(\/|$)/.test(d)) };
  }

  if (msg.op === 'full') {
    const f = files.find((x) => x.path === msg.path) || (await libFiles(root, true)).find((x) => x.path === msg.path);
    if (!f) return { ok: false, reason: 'gone' };
    const file = await f.handle.getFile();
    const meta = (await idbGet('meta', f.path).catch(() => null)) || (await readSidecar(f.side)) || (await readImageMeta(file).catch(() => null));
    return { ok: true, path: f.path, name: f.name, mtime: f.mtime, size: file.size, data: await blobToDataURL(file), meta: slimMeta(meta) };
  }
  return { ok: false, reason: 'op' };
}
