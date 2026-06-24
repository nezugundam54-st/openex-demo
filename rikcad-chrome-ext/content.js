// ① ページに拡張機能の存在を通知（bridge-main.js が MAIN world で先にセットするが念のため）
document.documentElement.setAttribute('data-rikcad-ext', '1');

// Service Workerを事前起動 + Tapirポートをキャッシュ（ボタン押下時の遅延を防ぐ）
chrome.runtime.sendMessage({ type: 'PING' }, () => { void chrome.runtime.lastError; });

// ② RIKCAD ブリッジ（__rikcad_request）
document.addEventListener('__rikcad_request', (e) => {
  const { reqId, type } = e.detail ?? {};
  if (!reqId || !type) return;

  chrome.runtime.sendMessage({ ...e.detail }, (res) => {
    void chrome.runtime.lastError;
    document.dispatchEvent(new CustomEvent('__rikcad_response', {
      detail: { reqId, ...(res ?? { ok: false, error: '拡張機能からの応答なし' }) }
    }));
  });
});

// ③ localhost:8767 API ブリッジ（bridge-main.js が MAIN world でパッチした fetch/XHR から呼ばれる）
document.addEventListener('__local_api_request', (e) => {
  const { reqId, method, path, params, body } = e.detail ?? {};
  if (!reqId) return;

  chrome.runtime.sendMessage({ type: 'LOCAL_API', method, path, params, body }, (res) => {
    void chrome.runtime.lastError;
    document.dispatchEvent(new CustomEvent('__local_api_response', {
      detail: { reqId, ...(res ?? { ok: false, error: '拡張機能からの応答なし' }) }
    }));
  });
});

// ③ スタンドアロン用フローティングボタン（localhost:8767 以外で使う場合向け）
//    localhost:8767 上では estimate-edit.html の計測パレットが使われるため目立たない位置に
(function () {
  if (document.getElementById('rikcad-gdl-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'rikcad-gdl-btn';
  btn.textContent = '🔧';
  btn.title = 'RIKCAD Connector';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '8px', right: '8px', zIndex: '99999',
    width: '28px', height: '28px', padding: '0',
    background: '#2563eb', color: '#fff', border: 'none',
    borderRadius: '50%', fontSize: '13px', cursor: 'pointer',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)', opacity: '0.5'
  });
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.5'; });
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_GDL_PARAMS' }, (res) => {
      void chrome.runtime.lastError;
      if (!res?.ok) { console.warn('[RIKCAD]', res?.error); return; }
      console.group('[RIKCAD] GDL');
      console.log(`ポート:${res.port} / Object:${res.objectCount}`);
      res.results?.forEach((item, i) => {
        console.group(`Object[${i+1}] ${item.elementId}`);
        console.table(item.params.map(p => ({ name: p.name, value: p.value, type: p.type })));
        console.groupEnd();
      });
      console.groupEnd();
    });
  });
  document.body.appendChild(btn);
})();
