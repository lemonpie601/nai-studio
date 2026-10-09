import { getSettings, patchSettings, getRoot, permState, icon, esc, today, applyTheme } from './shared.js';

const root = document.getElementById('root');

async function render() {
  const S = await getSettings();
  applyTheme(S.theme, S.colors);
  const { stats, history = [] } = await chrome.storage.local.get(['stats', 'history']);
  const handle = await getRoot();
  let perm = 'none';
  if (handle) { try { perm = await permState(handle, false); } catch (e) { perm = 'prompt'; } }
  const n = stats && stats.day === today() ? stats.count : 0;
  const warn = handle && perm !== 'granted';

  root.innerHTML = `
    <div class="brand"><div class="logo">${icon('sparkle', true)}</div><div><b>NAI Studio</b><small>작업 노트</small></div></div>
    <div class="card">
      <div class="ic">${icon('download')}</div>
      <div class="t"><div class="a">자동 저장</div><div class="b">${S.autoSave ? (S.saveMode === 'convert' ? '메타 제거 ' + ({ jpeg: 'JPG', webp: 'WebP' }[S.convFormat] || 'PNG') : '원본 PNG') : '꺼짐'}</div></div>
      <label class="sw"><input type="checkbox" id="auto" ${S.autoSave ? 'checked' : ''}><span></span></label>
    </div>
    <div class="card ${warn ? 'warn' : ''}" id="folder" style="cursor:pointer">
      <div class="ic">${icon(warn ? 'lock' : 'folder')}</div>
      <div class="t"><div class="a">${handle ? esc(handle.name) : '폴더 연결 안 됨'}</div>
        <div class="b">${!handle ? '눌러서 스튜디오에서 연결' : warn ? '권한이 꺼졌어요 — 눌러서 다시 허용' : '연결됨 · 여기로 저장돼요'}</div></div>
    </div>
    <div class="stat"><div><small>오늘 저장</small><b>${n}</b>장</div><div><small>기록</small><b>${history.length}</b>개</div></div>
    <button class="btn pri" id="studio">${icon('images')} 스튜디오 열기</button>
    <div class="row">
      <button class="btn sm" id="nai">${icon('external')} NovelAI</button>
      <button class="btn sm" id="conv">${icon('shield')} 변환</button>
    </div>`;

  document.getElementById('auto').addEventListener('change', async (e) => {
    await patchSettings({ autoSave: e.target.checked });
    render();
  });
  document.getElementById('folder').addEventListener('click', async () => {
    if (handle && warn) {
      // 팝업 클릭 = 사용자 동작이라 여기서 바로 권한을 다시 받을 수 있음
      try {
        const s = await permState(handle, true);
        await chrome.storage.local.set({ folderPerm: s === 'granted' ? 'granted' : 'prompt' });
      } catch (err) { /* noop */ }
      render();
    } else {
      chrome.runtime.sendMessage({ type: 'openStudio', hash: handle ? 'library' : 'settings' });
      window.close();
    }
  });
  document.getElementById('studio').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'openStudio' }); window.close(); });
  document.getElementById('conv').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'openStudio', hash: 'convert' }); window.close(); });
  document.getElementById('nai').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://novelai.net/*' });
    if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
    else await chrome.tabs.create({ url: 'https://novelai.net/image' });
    window.close();
  });
}
render();
