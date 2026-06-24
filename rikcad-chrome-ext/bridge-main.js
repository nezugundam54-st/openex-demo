/**
 * bridge-main.js
 * Chrome Extension MAIN world content script
 * - window.fetch / XMLHttpRequest を横取りして localhost:8767 の呼び出しを拡張機能経由に転換
 * - content.js (ISOLATED world) に CustomEvent で橋渡しする
 */
(function () {
  'use strict';

  const LOCAL_BASE = 'http://localhost:8767';

  // 拡張機能の存在を HTML ファイルに通知
  document.documentElement.setAttribute('data-rikcad-ext', '1');

  // ── CustomEvent ブリッジ（__rikcad_request は content.js が処理）────────────────
  // MAIN world から LOCAL_API リクエストを送る仕組み
  function dispatchLocalApi(method, path, params, body) {
    return new Promise((resolve) => {
      const reqId = '__la_' + Date.now() + '_' + Math.random().toString(36).slice(2);

      const handler = (e) => {
        if (e.detail?.reqId !== reqId) return;
        document.removeEventListener('__local_api_response', handler);
        resolve(e.detail);
      };
      document.addEventListener('__local_api_response', handler);

      // タイムアウト (15秒)
      setTimeout(() => {
        document.removeEventListener('__local_api_response', handler);
        resolve({ ok: false, error: 'タイムアウト' });
      }, 15000);

      document.dispatchEvent(new CustomEvent('__local_api_request', {
        detail: { reqId, method, path, params, body }
      }));
    });
  }

  // URL をパース → { path, params }
  function parseLocalUrl(url) {
    try {
      const u = new URL(url);
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      return { path: u.pathname, params };
    } catch {
      const [p, q] = url.replace(LOCAL_BASE, '').split('?');
      const params = {};
      if (q) q.split('&').forEach(seg => {
        const [k, v] = seg.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      });
      return { path: p || '/', params };
    }
  }

  // dispatchLocalApi の結果から fetch Response を構築
  async function bridgeFetch(method, url, body) {
    const { path, params } = parseLocalUrl(url);
    const res = await dispatchLocalApi(method, path, params, body);

    // __status が指定されている場合（ファイルが見つからない等）
    if (res?.__status != null) {
      return new Response(res.__text ?? '', { status: res.__status });
    }

    // 通常は JSON として返す
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // ── window.fetch のパッチ ──────────────────────────────────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = function (resource, options) {
    const url = typeof resource === 'string' ? resource
      : (resource instanceof Request ? resource.url : String(resource));
    if (url.startsWith(LOCAL_BASE)) {
      const method = ((options?.method) || 'GET').toUpperCase();
      const body = options?.body != null
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : null;
      return bridgeFetch(method, url, body);
    }
    return origFetch.apply(this, arguments);
  };

  // ── XMLHttpRequest のパッチ ───────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;

  function BridgeXHR() {
    const real = new OrigXHR();
    let _bridged = false, _method, _parsedUrl;
    let _onload, _onerror, _ontimeout;
    let _timeoutMs = 0, _responseText = '', _readyState = 0;

    const self = {
      // ── 状態プロパティ ──
      get readyState()   { return _bridged ? _readyState : real.readyState; },
      get status()       { return _bridged ? 200 : real.status; },
      get statusText()   { return _bridged ? 'OK' : real.statusText; },
      get responseText() { return _bridged ? _responseText : real.responseText; },
      get response()     { return _bridged ? _responseText : real.response; },
      get responseURL()  { return _bridged ? '' : real.responseURL; },

      // ── タイムアウト ──
      get timeout() { return _bridged ? _timeoutMs : real.timeout; },
      set timeout(v) {
        _timeoutMs = v;
        if (!_bridged) real.timeout = v;
      },

      // ── イベントハンドラ ──
      get onload()  { return _onload; },
      set onload(fn) { _onload = fn; if (!_bridged) real.onload = fn; },
      get onerror() { return _onerror; },
      set onerror(fn) { _onerror = fn; if (!_bridged) real.onerror = fn; },
      get ontimeout() { return _ontimeout; },
      set ontimeout(fn) { _ontimeout = fn; if (!_bridged) real.ontimeout = fn; },
      set onreadystatechange(fn) { if (!_bridged) real.onreadystatechange = fn; },

      // ── open ──
      open(method, url, async = true) {
        if (typeof url === 'string' && url.startsWith(LOCAL_BASE)) {
          _bridged = true;
          _method = method.toUpperCase();
          _parsedUrl = parseLocalUrl(url);
          _readyState = 1;
        } else {
          real.open(method, url, async);
        }
      },

      // ── send ──
      send(body) {
        if (!_bridged) { real.send(body); return; }

        _readyState = 2;

        let timedOut = false;
        let tid;
        if (_timeoutMs > 0) {
          tid = setTimeout(() => {
            timedOut = true;
            if (_ontimeout) _ontimeout.call(self, new Event('timeout'));
          }, _timeoutMs);
        }

        const bodyStr = body != null
          ? (typeof body === 'string' ? body : JSON.stringify(body))
          : null;

        dispatchLocalApi(_method, _parsedUrl.path, _parsedUrl.params, bodyStr)
          .then((res) => {
            if (timedOut) return;
            if (tid) clearTimeout(tid);

            // __status が指定されている場合（ファイルが見つからない等）
            if (res?.__status != null) {
              // XHR では status を変えられないので responseText にエラーを入れる
              _responseText = res.__text ?? '';
            } else {
              _responseText = JSON.stringify(res ?? { ok: false });
            }
            _readyState = 4;
            if (_onload) _onload.call(self, new ProgressEvent('load'));
          })
          .catch(() => {
            if (timedOut) return;
            if (tid) clearTimeout(tid);
            if (_onerror) _onerror.call(self, new ProgressEvent('error'));
          });
      },

      // ── その他メソッド ──
      setRequestHeader() {},
      getResponseHeader() { return null; },
      getAllResponseHeaders() { return ''; },
      abort() { if (!_bridged) real.abort(); },
      addEventListener(ev, fn) {
        if (!_bridged) real.addEventListener(ev, fn);
      },
      removeEventListener(ev, fn) {
        if (!_bridged) real.removeEventListener(ev, fn);
      },

      // 定数
      DONE: 4, UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3,
    };

    return self; // new BridgeXHR() は self を返す（コンストラクタが object を返す）
  }

  BridgeXHR.DONE = 4; BridgeXHR.UNSENT = 0; BridgeXHR.OPENED = 1;
  BridgeXHR.HEADERS_RECEIVED = 2; BridgeXHR.LOADING = 3;
  window.XMLHttpRequest = BridgeXHR;

})();
