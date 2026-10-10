// NAI Folio 공용 모듈 — background(서비스 워커) · offscreen · studio · popup 에서 import
// (content script 는 모듈을 못 쓰므로 content/panel.js 에 필요한 부분만 따로 있음)

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */
export const DEFAULTS = {
  autoSave: true,
  saveMode: 'original', // 'original' | 'convert'
  subdirTpl: '{date}',
  filenameTpl: 'NAI_{ymd}_{time}_{seed}_{n}',
  dlFolder: 'NovelAI',
  pngOnly: true,
  sidecar: 'none', // 'none' | 'txt' | 'json' | 'both' — 이미지 옆에 생성 정보 파일 (기본 꺼짐, 설정에서 켬)
  folderBackup: true, // 기록·사전·치환어를 폴더의 _백업 에 계속 저장
  snipExpand: true, // 생성할 때 %이름 을 저장된 내용으로 펼침
  snipTrigger: '%', // 치환어 앞에 붙이는 기호
  theme: 'auto', // 'auto' | 'light' | 'dark'
  colors: {}, // { light: {acc,title,base,char,neg}, dark: {...} } — 바꾼 색만
  project: '', // 지금 작업 이름 — 폴더 규칙의 {project}
  autoIns: false, // 번역하면 바로 프롬프트 칸에 추가
  tagMode: true,
  lowercase: true,
  stripArticles: true,
  historyMax: 500,
  convFormat: 'webp',
  convQuality: 98,
  convScale: 100,
  convBg: '#ffffff',
  convScrub: true, // 숨은 정보(픽셀 최하위 비트 · 스텔스 메타) 지우기
  tile: 210,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, settings || {});
}
export async function patchSettings(patch) {
  const s = await getSettings();
  Object.assign(s, patch);
  await chrome.storage.local.set({ settings: s });
  return s;
}
export const convOpts = (S) => ({ format: S.convFormat, quality: S.convQuality, scale: S.convScale, bg: S.convBg, scrub: S.convScrub !== false });
// 'original' 은 들어온 형식 그대로
export const outKind = (fmt, inKind) => (fmt && fmt !== 'original' ? fmt : MIME[inKind] ? inKind : 'png');
export const FMT_LABEL = { original: '원래 형식', jpeg: 'JPG', png: 'PNG', webp: 'WebP' };

/* ------------------------------------------------------------------ *
 * 유틸
 * ------------------------------------------------------------------ */
export const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
export const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const HANGUL = /[ㄱ-ㆎ가-힣]/;
const WRAP_RE = /^((?:\s|[{\[(]|-?\d+(?:\.\d+)?::)*)([\s\S]*?)((?:\s|[}\])]|::)*)$/;

export const pad = (n) => String(n).padStart(2, '0');
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + 'MB';
  return (n / 1024 ** 3).toFixed(2) + 'GB';
}
export function fmtTime(t) {
  const d = new Date(t), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `오늘 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `어제 ${hm}`;
  return `${d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '.' : ''}${d.getMonth() + 1}.${d.getDate()} ${hm}`;
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function stamp(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[.\s_]+|[.\s_]+$/g, '').slice(0, 150);
// 폴더 이름은 띄어쓰기를 그대로 둠 (윈도우에서 못 쓰는 글자만 바꿈)
export const sanitizeDir = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 100);
export const sanitizePath = (p) => String(p || '').split(/[\\/]+/).map(sanitizeDir).filter(Boolean).join('/');

export function sniff(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  return null;
}

export function makeQueue(concurrency) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= concurrency || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  const run = (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
  run.clear = () => { q.length = 0; };
  return run;
}

export async function blobToDataURL(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/* ------------------------------------------------------------------ *
 * 파일 이름 템플릿
 * ------------------------------------------------------------------ */
// 프롬프트 첫 태그 (강조 문법 · 괄호 빼고)
export function firstTag(prompt) {
  return String(prompt || '').split(/[,\n|]/).map((s) => s.replace(/-?\d+(\.\d+)?::|::|[{}\[\]()]/g, '').trim()).find(Boolean) || '';
}
// 폴더 나누기에 쓸 수 있는 칸 (설정 화면의 1단 · 2단 · 3단 선택지)
export const DIR_PARTS = [
  ['', '없음'],
  ['{project}', '작업 이름'],
  ['{char}', '치환어 (캐릭터)'],
  ['{date}', '날짜 (2026-10-08)'],
  ['{ym}', '연-월 (2026-10)'],
  ['{year}', '연도'],
  ['{month}', '월'],
  ['{day}', '일'],
  ['{orient}', '방향 (세로·가로)'],
  ['{model}', '모델'],
  ['{tag}', '첫 태그'],
];
export function tplCtx(t, meta, extra = {}, S = {}) {
  const d = new Date(t || Date.now());
  const Y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate());
  const w = extra.w || (meta && meta.w), h = extra.h || (meta && meta.h);
  return {
    date: `${Y}-${M}-${D}`, ymd: `${Y}${M}${D}`, ym: `${Y}-${M}`, year: Y, month: M, day: D,
    project: String(S.project || '').trim() || '미분류',
    char: (meta && meta.snips && meta.snips[0]) || '기타',
    orient: w && h ? (+w > +h ? '가로' : +w < +h ? '세로' : '정사각') : '기타',
    tag: firstTag(meta && meta.prompt) || '기타',
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    seed: meta && meta.seed != null ? meta.seed : 'noseed',
    n: extra.n || 1,
    prompt: ((meta && meta.prompt) || '').slice(0, 40),
    model: (meta && meta.model) || '',
    w: extra.w || '', h: extra.h || '',
    hash: String(extra.hash || '').slice(0, 8),
  };
}
export const fillTpl = (tpl, ctx) => String(tpl || '').replace(/\{(\w+)\}/g, (a, k) => (k in ctx ? String(ctx[k]) : a));
export function computeTarget(msg, S, kind) {
  const ctx = tplCtx(msg.t, msg.meta, msg, S);
  let subdir = sanitizePath(fillTpl(S.subdirTpl, ctx));
  let name = (sanitize(fillTpl(S.filenameTpl, ctx)) || `NAI_${ctx.ymd}_${ctx.time}`) + '.' + EXT[kind];
  // 골라서 저장: 폴더 · 이름을 직접 정했으면 그걸로
  if (msg.subdir != null) subdir = sanitizePath(msg.subdir);
  if (msg.name) name = (sanitizeDir(String(msg.name).replace(/\.(png|jpe?g|webp)$/i, '')) || baseName(name)) + '.' + EXT[kind];
  return { subdir, name };
}
// 저장할 때 변환할지 — 골라서 저장에서 정한 게 있으면 그걸로
export const saveConvert = (msg, S) => (msg.mode || S.saveMode) === 'convert';

/* ------------------------------------------------------------------ *
 * IndexedDB (폴더 핸들 · 메타 인덱스 · 썸네일 캐시)
 * ------------------------------------------------------------------ */
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('nai-studio', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['kv', 'meta', 'thumbs', 'pngmeta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
export async function idbGet(store, key) {
  const d = await db();
  return reqP(d.transaction(store).objectStore(store).get(key));
}
export async function idbSet(store, key, val) {
  const d = await db();
  return reqP(d.transaction(store, 'readwrite').objectStore(store).put(val, key));
}
export async function idbDel(store, key) {
  const d = await db();
  return reqP(d.transaction(store, 'readwrite').objectStore(store).delete(key));
}
export async function idbAll(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const map = new Map();
    const r = d.transaction(store).objectStore(store).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(map);
      map.set(c.key, c.value);
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
}

/* ------------------------------------------------------------------ *
 * 폴더 (File System Access)
 * ------------------------------------------------------------------ */
export async function getRoot() {
  try { return (await idbGet('kv', 'root')) || null; } catch (e) { return null; }
}
export async function permState(handle, request) {
  if (!handle) return 'none';
  const o = { mode: 'readwrite' };
  let s = await handle.queryPermission(o);
  if (s !== 'granted' && request) s = await handle.requestPermission(o);
  return s;
}
export async function getDir(root, path, create) {
  let d = root;
  for (const part of String(path || '').split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create: !!create });
  return d;
}
export async function uniqueName(dir, name) {
  const m = name.match(/^(.*?)(\.[^.]+)?$/);
  const base = m[1], ext = m[2] || '';
  let n = name, i = 2;
  for (;;) {
    try {
      await dir.getFileHandle(n);
      n = `${base}_${i++}${ext}`;
    } catch (e) {
      if (e.name === 'NotFoundError') return n;
      if (e.name === 'TypeMismatchError') { n = `${base}_${i++}${ext}`; continue; }
      throw e;
    }
  }
}
export async function writeFile(root, dirPath, name, blob) {
  const dir = await getDir(root, dirPath, true);
  const final = await uniqueName(dir, name);
  const fh = await dir.getFileHandle(final, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return { path: dirPath ? `${dirPath}/${final}` : final, name: final, dirPath: dirPath || '', handle: fh, dir };
}
export async function writeText(dir, name, text, mime = 'text/plain') {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([text], { type: mime + ';charset=utf-8' }));
  await w.close();
  return fh;
}
export const IMG_RE = /\.(png|jpe?g|webp)$/i;
export const SIDE_RE = /\.(json|txt)$/i;
export const baseName = (n) => String(n).replace(/\.[^.]+$/, '');
export const sideKey = (dirPath, name) => `${dirPath}/${baseName(name)}`;
export async function listImages(root, { maxDepth = 6, onProgress } = {}) {
  const files = [], dirs = new Set(), sides = new Map();
  async function walk(dir, path, depth) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') {
        const p = path ? `${path}/${name}` : name;
        dirs.add(p);
        if (depth < maxDepth) await walk(h, p, depth + 1);
      } else if (IMG_RE.test(name)) {
        files.push({ name, dirPath: path, path: path ? `${path}/${name}` : name, handle: h, dir });
      } else if (SIDE_RE.test(name)) {
        const k = sideKey(path, name);
        const s = sides.get(k) || {};
        s[name.split('.').pop().toLowerCase()] = { name, handle: h };
        sides.set(k, s);
      }
    }
    if (onProgress) onProgress(files.length);
  }
  await walk(root, '', 0);
  for (const f of files) f.side = sides.get(sideKey(f.dirPath, f.name)) || null;
  return { files, dirs: [...dirs].sort() };
}
export async function moveFile(root, rec, destPath, wantName) {
  const dest = await getDir(root, destPath, true);
  const name = await uniqueName(dest, wantName || rec.name);
  if (typeof rec.handle.move === 'function') {
    try { await rec.handle.move(dest, name); return { name, path: destPath ? `${destPath}/${name}` : name }; } catch (e) { /* 아래 방식으로 */ }
  }
  const file = await rec.handle.getFile();
  const fh = await dest.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(file);
  await w.close();
  await rec.dir.removeEntry(rec.name);
  return { name, path: destPath ? `${destPath}/${name}` : name };
}

/* ------------------------------------------------------------------ *
 * 이미지 변환 (메타데이터 제거) · ZIP
 * ------------------------------------------------------------------ */
// 캔버스에 새로 그려서 인코딩 → EXIF · PNG 텍스트 · ICC 가 빠짐
// + 픽셀 최하위 비트를 지워 알파채널 스텔스 메타데이터까지 제거 (투명도는 유지)
// 참고: nai-remove-exif.pages.dev 의 방식 (JPG 는 흰 배경 · 품질 0.98)
export const blobKind = (b) => (/jpe?g/.test(b.type) ? 'jpeg' : /webp/.test(b.type) ? 'webp' : 'png');
export function scrubLSB(d) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] &= 0xfe; d[i + 1] &= 0xfe; d[i + 2] &= 0xfe;
    const a = d[i + 3];
    d[i + 3] = a >= 254 ? 255 : a & 0xfe; // 불투명은 그대로 불투명
  }
  return d;
}
export async function convertBlob(blob, o) {
  const inKind = blob.type ? blobKind(blob) : sniff(new Uint8Array(await blob.slice(0, 12).arrayBuffer())) || 'png';
  const kind = outKind(o.format, inKind);
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { bmp = await createImageBitmap(blob); }
  const w = Math.max(1, Math.round((bmp.width * (o.scale || 100)) / 100));
  const h = Math.max(1, Math.round((bmp.height * (o.scale || 100)) / 100));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (kind === 'jpeg') {
    ctx.fillStyle = o.bg || '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  if (o.scrub !== false && kind !== 'jpeg') {
    const img = ctx.getImageData(0, 0, w, h);
    scrubLSB(img.data);
    ctx.putImageData(img, 0, 0);
  }
  return c.convertToBlob({ type: MIME[kind], quality: (o.quality || 98) / 100 });
}
export async function makeThumb(file, width = 400) {
  let bmp;
  try { bmp = await createImageBitmap(file, { resizeWidth: width, resizeQuality: 'medium' }); } catch (e) { bmp = await createImageBitmap(file); }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return c.convertToBlob({ type: 'image/webp', quality: 0.82 });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 무압축(STORE) ZIP · UTF-8 파일명
export async function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0, cdSize = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    cdSize += 46 + name.length;
    offset += 30 + name.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ *
 * PNG 안의 생성 정보 읽기 (NovelAI · A1111)
 * ------------------------------------------------------------------ */
async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  const out = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}
function parseChunks(buf, texts, fromIdat) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const latin = new TextDecoder('latin1');
  let p = 8, sawIdat = false;
  const pending = [];
  while (p + 8 <= buf.length) {
    const len = dv.getUint32(p);
    const type = latin.decode(buf.subarray(p + 4, p + 8));
    if (type === 'IEND') break;
    if (p + 12 + len > buf.length) return { truncated: true, sawIdat, pending };
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IDAT') sawIdat = true;
    else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') pending.push({ type, data });
    p += 12 + len;
    if (sawIdat && !fromIdat && pending.length) break;
  }
  return { truncated: false, sawIdat, pending };
}
async function decodeText(c, texts) {
  const utf8 = new TextDecoder();
  const z = c.data.indexOf(0);
  if (z < 0) return;
  const key = new TextDecoder('latin1').decode(c.data.subarray(0, z));
  let val = '';
  if (c.type === 'tEXt') val = utf8.decode(c.data.subarray(z + 1));
  else if (c.type === 'zTXt') val = utf8.decode(await inflate(c.data.subarray(z + 2)));
  else {
    const comp = c.data[z + 1];
    let q = z + 3;
    q = c.data.indexOf(0, q) + 1; // language tag
    q = c.data.indexOf(0, q) + 1; // translated keyword
    const body = c.data.subarray(q);
    val = utf8.decode(comp ? await inflate(body) : body);
  }
  texts[key] = val;
}
// 예전 이름 — 이제 PNG 말고도 (EXIF · 숨은 정보) 다 읽음
export const readPngMeta = (file) => readImageMeta(file);
async function readPngTexts(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head[0] !== 0x89 || head[1] !== 0x50) return null;
  const texts = {};
  let buf = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  let r = parseChunks(buf, texts, false);
  if (!r.pending.length && (r.truncated || r.sawIdat) && file.size < 40 * 1024 * 1024) {
    buf = new Uint8Array(await file.arrayBuffer());
    r = parseChunks(buf, texts, true);
  }
  for (const c of r.pending) { try { await decodeText(c, texts); } catch (e) { /* 깨진 청크 무시 */ } }
  return texts;
}
/* ---------- NovelAI 이미지 정보 보기 (novelai.net/inspect 와 같은 순서) ----------
 * 1) PNG 글자 청크  2) EXIF UserComment (JPG · WebP)  3) 알파채널 숨은 정보 (stealth_pngcomp, gzip) */
function exifUserComment(u8) {
  // JPEG APP1 "Exif\0\0" 또는 WebP "EXIF" 청크 → TIFF
  let tiff = null;
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let p = 2;
    while (p + 4 < u8.length && u8[p] === 0xff) {
      const mk = u8[p + 1], len = (u8[p + 2] << 8) | u8[p + 3];
      if (mk === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) { tiff = u8.subarray(p + 10, p + 2 + len); break; }
      if (mk === 0xda) break;
      p += 2 + len;
    }
  } else if (sniff(u8) === 'webp') {
    let p = 12;
    while (p + 8 <= u8.length) {
      const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
      const len = u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24);
      if (id === 'EXIF') { tiff = u8.subarray(p + 8, p + 8 + len); if (tiff[0] === 0x45 && tiff[1] === 0x78) tiff = tiff.subarray(6); break; }
      p += 8 + len + (len % 2);
    }
  }
  if (!tiff || tiff.length < 8) return null;
  const le = tiff[0] === 0x49;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const findTag = (ifd, tag) => {
    if (ifd + 2 > tiff.length) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return null;
      if (u16(e) === tag) return { type: u16(e + 2), count: u32(e + 4), off: u32(e + 8), at: e + 8 };
    }
    return null;
  };
  const exifPtr = findTag(u32(4), 0x8769);
  const uc = exifPtr && findTag(exifPtr.off, 0x9286);
  if (!uc) return null;
  const raw = uc.count <= 4 ? tiff.subarray(uc.at, uc.at + uc.count) : tiff.subarray(uc.off, uc.off + uc.count);
  if (raw.length < 8) return null;
  const head = String.fromCharCode(...raw.subarray(0, 8));
  let s;
  if (head === 'UNICODE\0') { const b = raw.subarray(8); s = new TextDecoder(b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : 'utf-16be').decode(b); }
  else s = new TextDecoder().decode(head === 'ASCII\0\0\0' || head === '\0\0\0\0\0\0\0\0' ? raw.subarray(8) : raw);
  return s.replace(/\0+$/, '').replace(/\0/g, '');
}
async function gunzip(u8) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
// 알파채널 최하위 비트에 숨긴 정보 — 세로줄 순서로 읽음 (x 바깥, y 안쪽)
export async function readStealth(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { return null; }
  const w = bmp.width, h = bmp.height, total = w * h;
  if (total > 0x1000000 || total < 200) { bmp.close && bmp.close(); return null; }
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  const d = x.getImageData(0, 0, w, h).data;
  let a = 0;
  const byte = () => { let v = 0; for (let i = 0; i < 8; i++, a++) v |= (d[4 * ((a % h) * w + Math.floor(a / h)) + 3] & 1) << (7 - i); return v; };
  const magic = 'stealth_pngcomp';
  for (let i = 0; i < magic.length; i++) if (byte() !== magic.charCodeAt(i)) return null;
  const bits = ((byte() << 24) | (byte() << 16) | (byte() << 8) | byte()) >>> 0;
  if (!bits || bits > total - a) return null;
  const out = new Uint8Array(Math.ceil(bits / 8));
  for (let i = 0; i < out.length; i++) out[i] = byte();
  try { return new TextDecoder().decode(await gunzip(out)); } catch (e) { return null; }
}
// 파일 하나에서 생성 정보 → { ...meta, via: 'png'|'exif'|'stealth', texts, params }
export async function readImageMeta(file, { stealth = true } = {}) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  if (!kind) return null;
  let texts = null, via = '';
  if (kind === 'png') {
    const m = await readPngTexts(file);
    if (m && Object.keys(m).length) { texts = m; via = 'png'; }
  }
  if (!texts && kind !== 'png') {
    const u8 = new Uint8Array(await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer());
    try { const s = exifUserComment(u8); if (s) { texts = JSON.parse(s); via = 'exif'; } } catch (e) { /* 다른 프로그램의 EXIF */ }
  }
  if (!texts && stealth && kind !== 'jpeg') {
    const s = await readStealth(file).catch(() => null);
    if (s) { try { texts = JSON.parse(s); via = 'stealth'; } catch (e) { texts = { Comment: s }; via = 'stealth'; } }
  }
  if (!texts) return null;
  for (const [k, v] of Object.entries(texts)) if (typeof v !== 'string') texts[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return Object.assign(normalizeMeta(texts), { via });
}
// Source "NovelAI Diffusion V4.5 4BDE2A90" → 보기 좋은 모델 이름 (NovelAI 사이트와 같은 표)
const MODEL_HASH = {
  '657484A5': 'V5 Full', '0ADF9AB7': 'V5 Full', 'DB276663': 'V5 Curated', '93F4BD30': 'V5 Full (Medium)', '70AB5786': 'V5 Full (Medium)',
  '4BDE2A90': 'V4.5 Full', '1229B44F': 'V4.5 Full', 'B9F340FD': 'V4.5 Full', 'F3D95188': 'V4.5 Full',
  'C02D4F98': 'V4.5 Curated', '5AB81C7C': 'V4.5 Curated', 'B5A2A797': 'V4.5 Curated',
  '37442FCA': 'V4 Full', '4F49EC75': 'V4 Full', 'CA4B7203': 'V4 Full', '79F47848': 'V4 Full', 'F6302A9D': 'V4 Full',
  '7ABFFA2A': 'V4 Curated', 'C1CCBA86': 'V4 Curated', '770A9E12': 'V4 Curated',
};
export function modelName(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  const h = (s.match(/\b([0-9A-F]{8})\s*$/) || [])[1];
  if (h && MODEL_HASH[h]) return 'NAI Diffusion ' + MODEL_HASH[h];
  const m = s.match(/(V\d(?:\.\d)?)/i);
  if (/Anime V3|Diffusion V3/i.test(s)) return 'NAI Diffusion Anime V3';
  if (/Furry/i.test(s)) return 'NAI Diffusion Furry' + (m ? ' ' + m[1] : '');
  return m ? 'NAI Diffusion ' + m[1].toUpperCase() : s.replace(/\s+[0-9A-F]{8}$/, '');
}
export const REQ_TYPE = { PromptGenerateRequest: '텍스트 → 이미지', Img2ImgRequest: '이미지 → 이미지', NativeInfillingRequest: '인페인트' };
// 원본 설정(JSON)은 큰 이미지 데이터만 줄여서 보관
function slimParams(c) {
  const o = {};
  for (const [k, v] of Object.entries(c || {})) {
    if (typeof v === 'string' && v.length > 300 && /image|reference|mask/i.test(k)) o[k] = v.slice(0, 24) + `… (${v.length.toLocaleString()}자)`;
    else if (Array.isArray(v) && /image/i.test(k) && v.some((x) => typeof x === 'string' && x.length > 300)) o[k] = v.map((x) => (typeof x === 'string' && x.length > 300 ? x.slice(0, 24) + `… (${x.length.toLocaleString()}자)` : x));
    else o[k] = v;
  }
  return o;
}
export function normalizeMeta(t) {
  let c = {};
  try { c = JSON.parse(t.Comment || '{}'); } catch (e) { c = {}; }
  const meta = { source: 'png' };
  if (t.Comment || t.Description) {
    const v4 = (c.v4_prompt && c.v4_prompt.caption) || {};
    const v4n = (c.v4_negative_prompt && c.v4_negative_prompt.caption) || {};
    const refs = (Array.isArray(c.reference_strength_multiple) && c.reference_strength_multiple.length) || c.reference_strength > 0;
    Object.assign(meta, {
      prompt: c.prompt || v4.base_caption || t.Description || '',
      neg: c.uc || v4n.base_caption || c.negative_prompt || '',
      chars: (v4.char_captions || []).map((x) => x.char_caption).filter(Boolean),
      charNegs: (v4.char_captions || []).map((_, i) => ((v4n.char_captions || [])[i] || {}).char_caption || ''),
      seed: c.seed, steps: c.steps, scale: c.scale, sampler: c.sampler,
      schedule: c.noise_schedule, smea: c.sm_dyn ? 'SMEA+DYN' : c.sm ? 'SMEA' : '',
      rescale: c.cfg_rescale, ucScale: c.uncond_scale, variety: c.skip_cfg_above_sigma != null ? true : undefined,
      strength: c.request_type === 'Img2ImgRequest' ? c.strength : undefined, noise: c.request_type === 'Img2ImgRequest' ? c.noise : undefined,
      reqType: c.request_type || '', extras: [c.controlnet_model ? 'ControlNet' : '', refs ? '바이브' : '', Array.isArray(c.director_reference_strengths) && c.director_reference_strengths.length ? '캐릭터 참조' : ''].filter(Boolean),
      w: c.width, h: c.height, model: t.Source || '', modelName: modelName(t.Source), software: t.Software || '',
      title: t.Title || '', genTime: t['Generation time'] || '',
      params: Object.keys(c).length ? slimParams(c) : undefined,
    });
  } else if (t.parameters) {
    const s = t.parameters;
    const ni = s.indexOf('\nNegative prompt:');
    const si = s.indexOf('\nSteps:');
    meta.prompt = s.slice(0, ni >= 0 ? ni : si >= 0 ? si : s.length).trim();
    meta.neg = ni >= 0 ? s.slice(ni + 17, si > ni ? si : s.length).trim() : '';
    const g = (k) => { const m = s.match(new RegExp(k + ':\\s*([^,\\n]+)')); return m ? m[1].trim() : undefined; };
    Object.assign(meta, { seed: g('Seed'), steps: g('Steps'), scale: g('CFG scale'), sampler: g('Sampler'), model: g('Model') || '', software: 'Stable Diffusion' });
  } else {
    meta.prompt = '';
  }
  return meta;
}

/* ------------------------------------------------------------------ *
 * 치환어 (%이름 — 앞 기호는 설정에서 바꿀 수 있음)
 * ------------------------------------------------------------------ */
// NovelAI 문법({} [] :: , | ( ))과 안 겹치는 기호만
export const SNIP_TRIGGERS = ['%', '#', '$', '~', '&', '!', '@'];
export const SNIP_NAME_RE = /^[\p{L}\p{N}_\-.]+$/u;
const reEsc = (c) => String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const snipRegex = (trigger) => new RegExp(reEsc(trigger || '%') + '([\\p{L}\\p{N}_\\-.]+)', 'gu');
export const cleanSnipName = (s) => String(s || '').trim().replace(/^[%#$~&!@]+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_\-.]/gu, '');
export function expandSnippets(text, snippets, used = new Set(), trigger = '%', depth = 0) {
  if (typeof text !== 'string' || text.indexOf(trigger) < 0 || depth > 6) return text;
  return text.replace(snipRegex(trigger), (all, name) => {
    let n = name, tail = '';
    while (!(n in snippets) && /[.\-]$/.test(n)) { tail = n.slice(-1) + tail; n = n.slice(0, -1); }
    if (!(n in snippets)) return all;
    used.add(n);
    return expandSnippets(snippets[n], snippets, used, trigger, depth + 1) + tail;
  });
}

/* ------------------------------------------------------------------ *
 * 생성 정보 파일 (이미지 옆 .txt / .json) — PNG 안 정보가 날아가도 남도록
 * ------------------------------------------------------------------ */
function fmtDateTime(t) {
  const d = new Date(t || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function sidecarJSON(meta, imageName, t) {
  const m = meta || {};
  const o = {
    app: 'NAI Folio',
    format: 1,
    image: imageName,
    savedAt: new Date(t || Date.now()).toISOString(),
    prompt: m.prompt || '',
    characters: m.chars || [],
    negative: m.neg || '',
    seed: m.seed, steps: m.steps, scale: m.scale, sampler: m.sampler,
    width: m.w, height: m.h, model: m.model || undefined,
  };
  if (m.raw) o.request = m.raw; // NovelAI 로 보낸 요청 설정 전체 (참조 이미지 같은 큰 데이터는 뺌)
  return JSON.stringify(o, null, 2);
}
export function sidecarTXT(meta, imageName, t) {
  const m = meta || {};
  const out = ['[프롬프트]', m.prompt || ''];
  (m.chars || []).forEach((c, i) => out.push('', `[캐릭터 ${i + 1}]`, c));
  if (m.neg) out.push('', '[네거티브]', m.neg);
  const rows = [['시드', m.seed], ['스텝', m.steps], ['가이던스', m.scale], ['샘플러', m.sampler], ['크기', m.w && m.h ? `${m.w}x${m.h}` : ''], ['모델', m.model]]
    .filter(([, v]) => v != null && v !== '');
  out.push('', '[설정]', ...rows.map(([k, v]) => `${k}: ${v}`), `이미지: ${imageName}`, `저장 시각: ${fmtDateTime(t)}`);
  return out.join('\n') + '\n';
}
// fmt: 'none' | 'txt' | 'json' | 'both'. 같은 폴더에 이미지와 같은 이름으로 (있으면 덮어씀)
export async function writeSidecars(dir, imageName, meta, t, fmt) {
  if (!meta || !fmt || fmt === 'none' || !(meta.prompt || meta.neg)) return [];
  const base = baseName(imageName), done = [];
  if (fmt === 'json' || fmt === 'both') { await writeText(dir, base + '.json', sidecarJSON(meta, imageName, t), 'application/json'); done.push('json'); }
  if (fmt === 'txt' || fmt === 'both') { await writeText(dir, base + '.txt', sidecarTXT(meta, imageName, t)); done.push('txt'); }
  return done;
}
export function parseSidecarJSON(text) {
  const j = JSON.parse(text);
  if (j && (j.app === 'NAI Folio' || j.app === 'NAI Studio' || 'negative' in j)) { // 예전 이름으로 만든 파일도
    return { prompt: j.prompt || '', neg: j.negative || '', chars: j.characters || [], seed: j.seed, steps: j.steps, scale: j.scale, sampler: j.sampler, w: j.width, h: j.height, model: j.model || '', raw: j.request, source: 'sidecar' };
  }
  // NovelAI Comment 형식을 그대로 저장해 둔 경우
  return Object.assign(normalizeMeta({ Comment: text }), { source: 'sidecar' });
}
export function parseSidecarTXT(text) {
  const sec = {};
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\[(.+?)\]\s*$/);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur) sec[cur].push(line);
  }
  const get = (k) => (sec[k] || []).join('\n').trim();
  const set = {};
  get('설정').split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) set[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const [w, h] = (set['크기'] || '').split('x');
  return {
    prompt: get('프롬프트'), neg: get('네거티브'),
    chars: Object.keys(sec).filter((k) => /^캐릭터 \d+$/.test(k)).map(get).filter(Boolean),
    seed: set['시드'], steps: set['스텝'], scale: set['가이던스'], sampler: set['샘플러'], w: w || undefined, h: h || undefined, model: set['모델'] || '',
    source: 'sidecar',
  };
}
export async function readSidecar(side) {
  if (!side) return undefined;
  try {
    if (side.json) return parseSidecarJSON(await (await side.json.handle.getFile()).text());
    if (side.txt) return parseSidecarTXT(await (await side.txt.handle.getFile()).text());
  } catch (e) { /* 깨진 파일은 무시 */ }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 번역
 * ------------------------------------------------------------------ */
export async function machineTranslate(text, sl, tl) {
  const q = encodeURIComponent(text);
  try {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${q}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j[0].map((x) => x[0]).join('');
  } catch (e) {
    const r = await fetch(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${q}`);
    if (!r.ok) throw new Error('번역 서버 응답 ' + r.status);
    const j = await r.json();
    if (j && j.sentences) return j.sentences.map((s) => s.trans || '').join('');
    const first = Array.isArray(j) ? j[0] : j;
    if (Array.isArray(first)) return first[0];
    if (typeof first === 'string') return first;
    throw e;
  }
}
async function mtBatch(list, sl, tl) {
  const out = new Array(list.length);
  let i = 0;
  while (i < list.length) {
    const chunk = [];
    let len = 0;
    while (i + chunk.length < list.length) {
      const next = list[i + chunk.length];
      if (chunk.length && len + next.length > 900) break;
      chunk.push(next);
      len += next.length + 1;
    }
    let res = null;
    if (chunk.length > 1) {
      const lines = (await machineTranslate(chunk.join('\n'), sl, tl)).split('\n');
      if (lines.length === chunk.length) res = lines;
    }
    if (!res) res = await Promise.all(chunk.map((s) => machineTranslate(s, sl, tl)));
    res.forEach((r, k) => (out[i + k] = String(r || '').trim()));
    i += chunk.length;
  }
  return out;
}
export function postTag(s, S) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!S.tagMode) return s;
  s = s.replace(/[.。!！?？]+$/, '');
  if (S.lowercase) s = s.toLowerCase();
  if (S.stripArticles) s = s.replace(/^(a|an|the)\s+/i, '');
  return s;
}
export function rebuildOutput(r) {
  if (!r.pieces) return r.output;
  const pieces = r.pieces.slice();
  r.jobs.forEach((j) => (pieces[j.i] = j.lead + j.dst + j.tail));
  r.output = pieces.join('');
  return r.output;
}
// 한글이 있으면 한→영(쉼표 단위 태그), 없으면 영→한(풀이)
export async function translatePrompt(text, S, dict, cache) {
  if (!HANGUL.test(text)) {
    const [out] = await mtBatch([text], 'en', 'ko');
    return { dir: 'en2ko', output: out, pieces: null, jobs: [] };
  }
  // %이름 치환어는 번역하지 않고 그대로 둠 (구분자처럼 취급)
  const snip = reEsc(S.snipTrigger || '%') + '[\\p{L}\\p{N}_\\-.]+';
  const pieces = text.split(new RegExp(S.tagMode ? `(,|\\n|\\||${snip})` : `(\\n|${snip})`, 'u'));
  const jobs = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const p = pieces[i];
    if (!HANGUL.test(p)) continue;
    const m = p.match(WRAP_RE) || ['', '', p, ''];
    jobs.push({ i, lead: m[1], tail: m[3], src: m[2].trim(), dst: '', kind: '' });
  }
  const need = [];
  for (const j of jobs) {
    if (dict[j.src]) { j.dst = dict[j.src]; j.kind = 'dict'; }
    else if (cache[j.src]) { j.dst = postTag(cache[j.src], S); j.kind = 'cache'; }
    else need.push(j);
  }
  const uniq = [...new Set(need.map((j) => j.src))];
  if (uniq.length) {
    const res = await mtBatch(uniq, 'ko', 'en');
    const map = {};
    uniq.forEach((s, k) => { map[s] = res[k]; if (res[k]) cache[s] = res[k]; });
    need.forEach((j) => { j.dst = postTag(map[j.src], S) || j.src; j.kind = 'mt'; });
  }
  const r = { dir: 'ko2en', pieces, jobs, output: '' };
  rebuildOutput(r);
  return r;
}

/* ------------------------------------------------------------------ *
 * 아이콘 (lucide 스타일)
 * ------------------------------------------------------------------ */
export const ICONS = {
  sparkle: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  images: '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L12 17"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
  convert: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  zip: '<path d="M10 12v-1"/><path d="M10 18v-2"/><path d="M10 7V6"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h.5"/><circle cx="10" cy="20" r="2"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
};
// 실제로 쓸 테마 ('auto' 면 윈도우/브라우저 설정을 따라감)
export const effectiveTheme = (t) => (t === 'light' || t === 'dark' ? t : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
// 색 꾸미기 — 밝은 노트 · 밤 노트 따로 (설정의 colors.light / colors.dark 가 기본값을 덮음)
export const COLOR_KEYS = [['acc', '강조'], ['title', '제목'], ['base', '프롬프트'], ['char', '캐릭터'], ['neg', '네거티브']];
export const COLOR_DEFAULTS = {
  light: { acc: '#33598e', title: '#2b2925', base: '#2c6a55', char: '#6e3f86', neg: '#9a4a22' },
  dark: { acc: '#8fb0e3', title: '#ebe4d4', base: '#86c4ad', char: '#c9a3dc', neg: '#e0a074' },
};
// 기본 제공 색 묶음 — 감산 혼합(CMY) 그림의 색들. 밝은 노트에선 글자가 잘 보이게 조금 진하게
const P = {
  pink: ['#c8327f', '#f28dbf'], yellow: ['#a07e00', '#f5dc3a'], cyan: ['#0080b8', '#5cc2f0'],
  red: ['#c41f30', '#f07a84'], green: ['#00804a', '#5fcf95'], navy: ['#2a3a8f', '#9aa8f0'], ink: ['#2e3a3c', '#c9d3d4'],
};
const preset = (id, name, acc, base, char, neg) => ({
  id, name,
  light: { acc: P[acc][0], title: '#2b2925', base: P[base][0], char: P[char][0], neg: P[neg][0] },
  dark: { acc: P[acc][1], title: '#ebe4d4', base: P[base][1], char: P[char][1], neg: P[neg][1] },
});
export const COLOR_PRESETS = [
  { id: 'default', name: '기본', light: {}, dark: {} },
  preset('cmy', '삼원색', 'pink', 'cyan', 'yellow', 'red'),
  preset('pink', '분홍', 'pink', 'pink', 'cyan', 'navy'),
  preset('yellow', '노랑', 'yellow', 'yellow', 'green', 'red'),
  preset('cyan', '하늘', 'cyan', 'cyan', 'navy', 'pink'),
  preset('red', '빨강', 'red', 'red', 'yellow', 'navy'),
  preset('green', '초록', 'green', 'green', 'cyan', 'red'),
  preset('navy', '남색', 'navy', 'navy', 'pink', 'green'),
  preset('ink', '먹', 'ink', 'ink', 'navy', 'red'),
];
export function colorVars(colors, t) {
  const c = Object.assign({}, COLOR_DEFAULTS[t], (colors && colors[t]) || {});
  return { '--acc': c.acc, '--acc-bg': c.acc + (t === 'dark' ? '1a' : '14'), '--acc-line': c.acc + (t === 'dark' ? '80' : '6b'), '--c-title': c.title, '--c-base': c.base, '--c-char': c.char, '--c-neg': c.neg };
}
export function applyTheme(t, colors) {
  const e = effectiveTheme(t);
  const el = document.documentElement;
  el.dataset.theme = e;
  for (const [k, v] of Object.entries(colorVars(colors, e))) el.style.setProperty(k, v);
}
export const icon = (n, fill) => `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
