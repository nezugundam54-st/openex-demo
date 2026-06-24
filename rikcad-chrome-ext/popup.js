// ─────────────────────────────────────────────────────────────────────────
// OPEN EX ページ定義
// ─────────────────────────────────────────────────────────────────────────
const PAGES = [
  { file: 'index.html',            icon: '🏠', label: '物件一覧' },
  { file: 'estimate-list.html',    icon: '📋', label: '見積一覧' },
  { file: 'estimate-compact.html', icon: '📐', label: 'コンパクト見積', badge: 'RIKCAD' },
  { file: 'shodan-kanri.html',     icon: '📊', label: '商談管理' },
  { file: 'hacchukanri.html',      icon: '📦', label: '発注管理' },
  { file: 'schedule.html',         icon: '📅', label: 'スケジュール' },
  { file: 'master-edit.html',      icon: '🗂️', label: 'マスタ編集' },
  { file: 'settings.html',         icon: '⚙️', label: '設定' },
];

const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const pageLinks  = document.getElementById('page-links');
const hintNoBase = document.getElementById('hint-nobase');
const baseInput  = document.getElementById('base-path');
const btnSave    = document.getElementById('btn-save');
const output     = document.getElementById('output');

// ─────────────────────────────────────────────────────────────────────────
// 保存済みベースパスの読み込み
// ─────────────────────────────────────────────────────────────────────────
let basePath = '';

chrome.storage.local.get('openex_base_path', (data) => {
  basePath = data.openex_base_path || '';
  baseInput.value = basePath;
  renderPageLinks();
});

btnSave.addEventListener('click', () => {
  basePath = baseInput.value.trim().replace(/[\\/]+$/, '');
  chrome.storage.local.set({ openex_base_path: basePath }, () => {
    renderPageLinks();
    btnSave.textContent = '✅';
    setTimeout(() => { btnSave.textContent = '保存'; }, 1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ページリンクの生成
// ─────────────────────────────────────────────────────────────────────────
function toFileUrl(winPath, fileName) {
  // Windows パス → file:// URL 変換
  const normalized = winPath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(seg => encodeURIComponent(seg).replace(/%2F/g, '/')).join('/');
  return `file:///${encoded}/${encodeURIComponent(fileName)}`;
}

function renderPageLinks() {
  pageLinks.innerHTML = '';

  if (!basePath) {
    hintNoBase.style.display = '';
    return;
  }
  hintNoBase.style.display = 'none';

  for (const p of PAGES) {
    const btn = document.createElement('button');
    btn.className = 'page-btn';
    btn.innerHTML = `
      <span class="icon">${p.icon}</span>
      <span class="label">${p.label}</span>
      ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
    `;
    btn.addEventListener('click', () => {
      const url = toFileUrl(basePath, p.file);
      chrome.tabs.create({ url });
    });
    pageLinks.appendChild(btn);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// RIKCAD 接続ステータス確認
// ─────────────────────────────────────────────────────────────────────────
function setStatus(ok, msg) {
  statusDot.className = 'dot' + (ok === null ? ' spin' : ok ? ' ok' : ' error');
  statusText.textContent = msg;
}

chrome.runtime.sendMessage({ type: 'PING' }, () => {
  // Service Worker 起動後に LOCAL_API で ping
  chrome.runtime.sendMessage({ type: 'LOCAL_API', method: 'GET', path: '/rikcad/ping', params: {}, body: null }, (res) => {
    if (res?.ok) {
      setStatus(true, `RIKCAD 接続済み (port: ${res.port}, v${res.version})`);
    } else {
      setStatus(false, 'RIKCAD 未接続（RIKCAD+Tapir を起動してください）');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// デバッグボタン
// ─────────────────────────────────────────────────────────────────────────
const BTN_LABELS = {
  'btn-gdl': 'GDL取得',
  'btn-qty': '数量取得',
  'btn-sel': '選択切替テスト',
  'btn-hl':  'ハイライト',
};
const MSGS = {
  'btn-gdl': { type: 'GET_GDL_PARAMS' },
  'btn-qty': { type: 'GET_QUANTITIES' },
  'btn-sel': { type: 'TEST_CHANGE_SELECTION' },
  'btn-hl':  { type: 'TEST_HIGHLIGHT' },
};

for (const [id, msgDef] of Object.entries(MSGS)) {
  const btn = document.getElementById(id);
  if (!btn) continue;
  btn.addEventListener('click', () => {
    btn.textContent = '…';
    output.style.display = 'none';
    chrome.runtime.sendMessage(msgDef, (res) => {
      btn.textContent = BTN_LABELS[id];
      if (!res?.ok) {
        output.textContent = `❌ ${res?.error ?? '不明なエラー'}`;
      } else {
        output.textContent = JSON.stringify(res, null, 2);
      }
      output.style.display = 'block';
    });
  });
}
