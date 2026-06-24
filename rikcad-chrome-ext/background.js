const TAPIR_PORT_MIN = 19723;
const TAPIR_PORT_MAX = 19732;

// Tapir HTTP API 呼び出し
// レスポンス形式: { succeeded: bool, result: {...} }
async function tapirCall(port, command, parameters = {}) {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, parameters })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.succeeded) {
    const msg = data.error?.message ?? JSON.stringify(data.error);
    throw new Error(`${command} 失敗: ${msg}`);
  }
  return data.result ?? {};
}

// 直接APIコマンド（API.xxx）
async function apiCall(port, name, params = {}) {
  return tapirCall(port, `API.${name}`, params);
}

// Tapirアドオンコマンド（API.ExecuteAddOnCommand 経由）
async function tapirAddon(port, name, params = null) {
  const body = {
    addOnCommandId: { commandNamespace: 'TapirCommand', commandName: name },
    ...(params ? { addOnCommandParameters: params } : {})
  };
  const result = await tapirCall(port, 'API.ExecuteAddOnCommand', body);
  return result.addOnCommandResponse ?? result;
}

async function findTapirPort() {
  // storage.session でポートをキャッシュ（失敗しても動作継続）
  let cached = null;
  try {
    const stored = await chrome.storage.session.get('tapirPort');
    cached = stored.tapirPort ?? null;
  } catch { /* storage未対応環境でも継続 */ }

  if (cached) {
    try {
      await tapirCall(cached, 'API.GetProductInfo');
      return cached;
    } catch {
      try { await chrome.storage.session.remove('tapirPort'); } catch {}
    }
  }
  for (let port = TAPIR_PORT_MIN; port <= TAPIR_PORT_MAX; port++) {
    try {
      await tapirCall(port, 'API.GetProductInfo');
      try { await chrome.storage.session.set({ tapirPort: port }); } catch {}
      return port;
    } catch {
      // 次のポートへ
    }
  }
  return null;
}

async function getGdlParams() {
  const port = await findTapirPort();
  if (!port) {
    return { ok: false, error: 'RIKCADに接続できませんでした（Tapirが起動しているか確認してください）' };
  }

  // 選択中の要素を取得（API.GetSelectedElements）
  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];

  if (elements.length === 0) {
    return { ok: false, error: 'RIKCAD上で要素を選択してから実行してください' };
  }

  // GDLパラメータを取得（TapirCommand経由）
  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', { elements });
  const gdlList = gdlResult.gdlParametersOfElements ?? [];

  // パラメータ配列が空でないものだけ抽出（Object以外は空になる）
  const results = [];
  for (let i = 0; i < elements.length; i++) {
    const params = gdlList[i]?.parameters ?? [];
    if (params.length > 0) {
      results.push({
        elementId: elements[i].elementId?.guid ?? elements[i].elementId ?? elements[i],
        params
      });
    }
  }

  return { ok: true, port, totalSelected: elements.length, objectCount: results.length, results };
}

// ─────────────────────────────────────────────
// GET_KS_DATA: estimate-edit.html の計測パレット向け
// Python API の /rikcad/keisoku と同じレスポンス形式を返す
// { ok, data: { elementType, materialName, rows, qtyMap } }
// ─────────────────────────────────────────────

const KS_PROP_DEF = {
  'Wall_CenterLength':          { label: '長さ',            unit: 'm',  is_qty: true  },
  'Wall_GrossLength':           { label: '長さ(総)',         unit: 'm',  is_qty: true  },
  'General_Height':             { label: '高さ',            unit: 'm',  is_qty: true  },
  'General_Width':              { label: '厚み',            unit: 'm',  is_qty: false },
  'Wall_NetInsideSurfaceArea':  { label: '内壁面積(正味)',  unit: 'm²', is_qty: true  },
  'Wall_NetOutsideSurfaceArea': { label: '外壁面積(正味)',  unit: 'm²', is_qty: true  },
  'Slab_GrossTopSurfaceArea':   { label: '上部表面積',      unit: 'm²', is_qty: true  },
  'Mesh_GrossTopSurfaceArea':   { label: '上部表面積',      unit: 'm²', is_qty: true  },
  'Roof_GrossTopSurfaceArea':   { label: '上部表面積',      unit: 'm²', is_qty: true  },
  'General_GrossTopSurfaceArea':{ label: '上部表面積(総)',  unit: 'm²', is_qty: true  },
  'General_NetTopSurfaceArea':  { label: '上部表面積(正味)',unit: 'm²', is_qty: true  },
  'General_Thickness':          { label: '厚さ',            unit: 'm',  is_qty: false },
  'Slab_Perimeter':             { label: '外周',            unit: 'm',  is_qty: false },
  'Mesh_Perimeter':             { label: '外周',            unit: 'm',  is_qty: false },
  'Roof_Perimeter':             { label: '外周',            unit: 'm',  is_qty: false },
  'General_Perimeter':          { label: '外周',            unit: 'm',  is_qty: false },
  'Mesh_NetVolume':             { label: '体積',            unit: 'm³', is_qty: false },
  'General_NetVolume':          { label: '体積',            unit: 'm³', is_qty: false },
  'General_SurfaceArea':        { label: '表面積',          unit: 'm²', is_qty: false },
};

function inferElementType(valueMap) {
  if (valueMap['Wall_CenterLength'] != null || valueMap['Wall_NetInsideSurfaceArea'] != null) return 'Wall';
  if (valueMap['Mesh_GrossTopSurfaceArea'] != null || valueMap['Mesh_Perimeter'] != null)     return 'Mesh';
  if (valueMap['Roof_GrossTopSurfaceArea'] != null || valueMap['Roof_Perimeter'] != null)     return 'Roof';
  if (valueMap['Slab_GrossTopSurfaceArea'] != null || valueMap['Slab_Perimeter'] != null)     return 'Slab';
  return 'Unknown';
}

// ライブラリパーツ名プロパティGUIDをメモリキャッシュ（軽量・エラーなし）
let _libPartGuid = null;
async function getLibPartNameGuid(port) {
  if (_libPartGuid) return _libPartGuid;
  const res = await apiCall(port, 'GetPropertyIds', {
    properties: [{ type: 'BuiltIn', nonLocalizedName: 'IdAndCategories_LibraryPartName' }]
  });
  _libPartGuid = res.properties?.[0]?.propertyId?.guid ?? null;
  return _libPartGuid;
}

// 要素のライブラリパーツ名（Objectタイプ向け・NAMEが空の場合のフォールバック）
async function fetchLibPartName(port, firstEl) {
  try {
    const guid = await getLibPartNameGuid(port);
    if (!guid) return '';
    const res = await apiCall(port, 'GetPropertyValuesOfElements', {
      elements: firstEl,
      properties: [{ propertyId: { guid } }]
    });
    const val = res.propertyValuesForElements?.[0]?.propertyValues?.[0]?.propertyValue?.value;
    return (typeof val === 'string' && val) ? val : '';
  } catch {
    return '';
  }
}

// Wall / Slab / Mesh / Roof の表面材名称を GetMaterialNameOfElements カスタムコマンドで取得
async function fetchSurfaceMaterialName(port, firstEl) {
  try {
    const res = await tapirAddon(port, 'GetMaterialNameOfElements', { elements: firstEl });
    return res.materialNames?.[0]?.materialName ?? '';
  } catch {
    return '';
  }
}

async function getKsData() {
  const port = await findTapirPort();
  if (!port) throw new Error('RIKCADに接続できませんでした');

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (elements.length === 0) throw new Error('RIKCAD上で要素を選択してください');

  const firstEl = [elements[0]];

  // GDLパラメータを確認（Objectタイプ判定）
  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', { elements: firstEl });
  const allParams = gdlResult.gdlParametersOfElements?.[0]?.parameters ?? [];
  const gdlParams = allParams.filter(p => !p.flags?.includes('Hidden'));

  if (gdlParams.length > 0) {
    // Object タイプ：GDL の NAME パラメータを優先、なければライブラリパーツ名
    const nameParam = gdlParams.find(p => p.name === 'NAME');
    const gdlName   = nameParam?.value?.toString().trim() ?? '';
    const materialName = gdlName || await fetchLibPartName(port, firstEl);

    const rows = [];
    // NAME は先頭に '名称' 行として追加（マスタ検索・カタログ検索のキーワードになる）
    if (materialName) {
      rows.push({ label: '名称', value: materialName, unit: '', is_qty: false });
    }
    // Hidden を含む全パラメータから mai/MAI・FS_FP を明示取得して先頭に追加
    const maiParam  = allParams.find(p => p.name === 'mai') ?? allParams.find(p => p.name === 'MAI');
    const fsfpParam = allParams.find(p => p.name === 'FS_FP');
    const gdlV = p => typeof p.value === 'number' ? Math.round(p.value * 1000) / 1000 : p.value;
    if (maiParam  != null) rows.push({ label: maiParam.name, value: gdlV(maiParam),  unit: '枚', is_qty: true });
    if (fsfpParam != null) rows.push({ label: 'FS_FP',       value: gdlV(fsfpParam), unit: '本', is_qty: true });
    // 残りの GDL パラメータ（NAME / Hidden 以外・mai/MAI/FS_FP は上で追加済みのためスキップ）
    const FENCE_PARAMS = new Set(['mai', 'MAI', 'FS_FP']);
    gdlParams
      .filter(p => p.name !== 'NAME' && !FENCE_PARAMS.has(p.name))
      .forEach(p => {
        rows.push({
          label: p.name,
          value: gdlV(p),
          unit: p.type === 'Length' ? 'm' : p.type === 'Area' ? 'm²' : p.type === 'Volume' ? 'm³' : '',
          is_qty: p.type === 'Length' || p.type === 'Area' || p.type === 'Volume'
        });
      });
    const qtyMap = {};
    rows.filter(r => r.is_qty && r.unit && r.value != null)
        .forEach(r => { if (!qtyMap[r.unit]) qtyMap[r.unit] = r.value; });
    return { ok: true, data: { elementType: 'Object', materialName, rows, qtyMap } };
  }

  // Wall / Slab / Mesh / Roof：数量プロパティと表面材名称を並行取得
  const propNames = Object.keys(KS_PROP_DEF);
  const [idRes, materialName] = await Promise.all([
    apiCall(port, 'GetPropertyIds', {
      properties: propNames.map(n => ({ type: 'BuiltIn', nonLocalizedName: n }))
    }),
    fetchSurfaceMaterialName(port, firstEl)  // GetMaterialNameOfElements カスタムコマンド
  ]);

  const validProps = [];
  (idRes.properties ?? []).forEach((p, i) => {
    if (p?.propertyId?.guid) validProps.push({ name: propNames[i], guid: p.propertyId.guid });
  });

  const valRes = await apiCall(port, 'GetPropertyValuesOfElements', {
    elements: firstEl,
    properties: validProps.map(p => ({ propertyId: { guid: p.guid } }))
  });
  const rawVals = valRes.propertyValuesForElements?.[0]?.propertyValues ?? [];
  const valueMap = {};
  validProps.forEach((p, j) => {
    const val = rawVals[j]?.propertyValue?.value;
    if (val != null) valueMap[p.name] = val;
  });

  const elementType = inferElementType(valueMap);
  const rows = [];
  const qtyMap = {};

  // 表面材名称（GetMaterialNameOfElements カスタムコマンドで取得）
  if (materialName) {
    rows.push({ label: '材質名', value: materialName, unit: '', is_qty: false });
  }

  const seenLabels = new Set(['材質名']);
  for (const [propName, meta] of Object.entries(KS_PROP_DEF)) {
    const val = valueMap[propName];
    if (val == null || seenLabels.has(meta.label)) continue;
    seenLabels.add(meta.label);
    const rounded = Math.round(val * 1000) / 1000;
    rows.push({ label: meta.label, value: rounded, unit: meta.unit, is_qty: meta.is_qty });
    if (meta.is_qty && meta.unit && !qtyMap[meta.unit]) qtyMap[meta.unit] = rounded;
  }

  // スラブ・メッシュ外周：BuiltIn 取得不可のため polygonOutline/polygonCoordinates から算出
  // Slab → polygonOutline (2D {x,y})、Mesh → polygonCoordinates (3D {x,y,z}、x/yのみ使用)
  if ((elementType === 'Slab' || elementType === 'Mesh') && !seenLabels.has('外周')) {
    try {
      const detRes = await tapirAddon(port, 'GetDetailsOfElements', { elements: firstEl });
      const det = detRes.detailsOfElements?.[0]?.details;
      const outline = det?.polygonOutline ?? det?.polygonCoordinates ?? [];
      if (outline.length >= 2) {
        let perimeter = 0;
        for (let i = 0; i < outline.length; i++) {
          const a = outline[i];
          const b = outline[(i + 1) % outline.length];
          perimeter += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
        }
        const rounded = Math.round(perimeter * 1000) / 1000;
        rows.push({ label: '外周', value: rounded, unit: 'm', is_qty: false });
        // Slab/Mesh では単位 m に対して高さでなく外周を優先させる
        qtyMap['m'] = rounded;
      }
    } catch {}
  }

  return { ok: true, data: { elementType, materialName, rows, qtyMap } };
}

// 壁・スラブ・メッシュ・屋根の数量取得
const QUANTITY_PROPS = [
  'General_ElementID',
  'General_SurfaceArea',
  'General_NetVolume',
  'General_GrossTopSurfaceArea', 'General_NetTopSurfaceArea',
  'General_Height', 'General_Width', 'General_Thickness',
  'General_Perimeter',
  'Slab_GrossTopSurfaceArea', 'Slab_Perimeter',
  'Mesh_GrossTopSurfaceArea', 'Mesh_Perimeter', 'Mesh_NetVolume',
  'Roof_GrossTopSurfaceArea', 'Roof_Perimeter',
  'Wall_CenterLength', 'Wall_Height', 'Wall_GrossLength',
  'Wall_NetInsideSurfaceArea', 'Wall_NetOutsideSurfaceArea',
];

async function getQuantities() {
  const port = await findTapirPort();
  if (!port) {
    return { ok: false, error: 'RIKCADに接続できませんでした（Tapirが起動しているか確認してください）' };
  }

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (elements.length === 0) {
    return { ok: false, error: 'RIKCAD上で要素を選択してから実行してください' };
  }

  // BuiltInプロパティのGUIDを取得（存在しないものはnullになる）
  const idRes = await apiCall(port, 'GetPropertyIds', {
    properties: QUANTITY_PROPS.map(n => ({ type: 'BuiltIn', nonLocalizedName: n }))
  });
  const propDefs = idRes.properties ?? [];

  // 有効なGUIDのみ抽出（要素タイプにより存在しないプロパティはスキップ）
  const validProps = [];
  for (let i = 0; i < QUANTITY_PROPS.length; i++) {
    const guid = propDefs[i]?.propertyId?.guid;
    if (guid) validProps.push({ name: QUANTITY_PROPS[i], guid });
  }

  if (validProps.length === 0) {
    return { ok: false, error: 'プロパティIDが取得できませんでした' };
  }

  // 値を取得
  const valRes = await apiCall(port, 'GetPropertyValuesOfElements', {
    elements,
    properties: validProps.map(p => ({ propertyId: { guid: p.guid } }))
  });
  const valList = valRes.propertyValuesForElements ?? [];

  const results = [];
  for (let i = 0; i < elements.length; i++) {
    const propValues = valList[i]?.propertyValues ?? [];
    const row = { elementId: elements[i].elementId?.guid ?? elements[i].elementId };
    let hasValue = false;
    for (let j = 0; j < validProps.length; j++) {
      const pv = propValues[j]?.propertyValue;
      const val = pv?.value;
      if (val !== undefined && val !== null) {
        row[validProps[j].name] = val;
        hasValue = true;
      }
    }
    if (hasValue) results.push(row);
  }

  return { ok: true, port, totalSelected: elements.length, resultCount: results.length, results };
}

// 材料名取得テスト
async function getMaterials() {
  const port = await findTapirPort();
  if (!port) {
    return { ok: false, error: 'RIKCADに接続できませんでした' };
  }

  // ① 全BuildingMaterialリストを取得（index → name の辞書を作る）
  const matRes = await tapirAddon(port, 'GetAttributesByType', { attributeType: 'BuildingMaterial' });
  const matIndex = {};
  for (const a of matRes.attributes ?? []) {
    matIndex[a.index] = a.name;
  }

  // 選択要素
  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (elements.length === 0) {
    return { ok: false, error: 'RIKCAD上で要素を選択してから実行してください' };
  }

  // ② GetDetailsOfElements で要素詳細を取得（材料インデックスが含まれるか確認）
  let detailsRaw = null;
  try {
    const detRes = await tapirAddon(port, 'GetDetailsOfElements', { elements });
    detailsRaw = JSON.stringify(detRes, null, 2);
  } catch (e) {
    // GetDetailsOfElements は直接APIコマンド
    try {
      const detRes = await apiCall(port, 'GetDetailsOfElements', { elements });
      detailsRaw = JSON.stringify(detRes, null, 2);
    } catch (e2) {
      detailsRaw = `GetDetailsOfElements エラー: ${e2.message}`;
    }
  }

  // GetMaterialNameOfElements カスタムコマンドで表面材名称を取得
  let surfaceMaterials = null;
  try {
    const selEl = elements.map(e => ({ elementId: e.elementId }));
    const matNameRes = await tapirAddon(port, 'GetMaterialNameOfElements', { elements: selEl });
    surfaceMaterials = matNameRes.materialNames ?? null;
  } catch (e) {
    surfaceMaterials = `GetMaterialNameOfElements エラー: ${e.message}`;
  }

  return {
    ok: true,
    port,
    matIndexCount: Object.keys(matIndex).length,
    matIndex,
    detailsRaw,
    surfaceMaterials,
    note: 'GetMaterialNameOfElements カスタムコマンドで表面材名称を取得（Slab/Wall/Mesh/Roof対応）。'
  };
}

// ─────────────────────────────────────────────
// テスト: ChangeSelectionOfElements
// 選択中の要素を一旦デセレクト → 1秒後に再セレクト
// RIKCAD上で選択が外れてから戻れば成功
// ─────────────────────────────────────────────
async function testChangeSelection() {
  const port = await findTapirPort();
  if (!port) throw new Error('RIKCADに接続できませんでした');

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (elements.length === 0) throw new Error('RIKCAD上で要素を選択してから実行してください');

  const steps = [];

  // Step1: removeElementsFromSelection
  try {
    const r1 = await tapirAddon(port, 'ChangeSelectionOfElements', {
      removeElementsFromSelection: elements
    });
    steps.push({ step: 'remove', result: r1 });
  } catch (e) {
    steps.push({ step: 'remove', error: e.message });
  }

  // 1秒待機（RIKCADで変化が見えるように）
  await new Promise(r => setTimeout(r, 1000));

  // Step2: addElementsToSelection
  try {
    const r2 = await tapirAddon(port, 'ChangeSelectionOfElements', {
      addElementsToSelection: elements
    });
    steps.push({ step: 'add', result: r2 });
  } catch (e) {
    steps.push({ step: 'add', error: e.message });
  }

  return { ok: true, port, elementCount: elements.length, steps };
}

// ─────────────────────────────────────────────
// テスト: HighlightElements
// 選択中の要素をオレンジ色でハイライト（再実行で解除）
// ─────────────────────────────────────────────
let _highlightActive = false;

async function testHighlightElements() {
  const port = await findTapirPort();
  if (!port) throw new Error('RIKCADに接続できませんでした');

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (elements.length === 0) throw new Error('RIKCAD上で要素を選択してから実行してください');

  if (_highlightActive) {
    // 2回目: ハイライト解除（空配列で全解除）
    const r = await tapirAddon(port, 'HighlightElements', {
      elements: [],
      highlightedColors: []
    });
    _highlightActive = false;
    return { ok: true, port, action: 'cleared', result: r };
  } else {
    // 1回目: オレンジでハイライト、他要素は半透明グレー
    const colors = elements.map(() => [255, 140, 0, 255]);
    const r = await tapirAddon(port, 'HighlightElements', {
      elements,
      highlightedColors: colors,
      nonHighlightedColor: [128, 128, 128, 80]
    });
    _highlightActive = true;
    return { ok: true, port, action: 'highlighted', elementCount: elements.length, result: r };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL_API: localhost:8767 の代替エンドポイント群
// bridge-main.js → content.js → background.js の順で転送される
// ═══════════════════════════════════════════════════════════════════════════

// GDLパラメータから値を文字列で取得するヘルパー
function gdlParam(params, name) {
  const p = params.find(x => x.name === name);
  if (!p) return '';
  const val = p.value;
  if (Array.isArray(val)) return val.length ? String(val[0]) : '';
  return String(val ?? '').trim();
}

// 選択要素の rows 形式データを構築（Python の _build_rows_from_gdl を移植）
function buildRowsFromGdl(guids, gdlList, libNameMap, areaMap, objectGuids, cadTypeMap, leaderNameMap, elementIdMap) {
  const rows = [];
  let lastKoji = '';

  for (let i = 0; i < guids.length; i++) {
    const guid = guids[i];
    const params = gdlList[i]?.parameters ?? [];
    const extra = {
      guid,
      cadType:    cadTypeMap[guid]    ?? '',
      leaderName: leaderNameMap[guid] ?? '',
      elementId:  elementIdMap[guid]  ?? '',
    };

    if (!objectGuids.has(guid)) {
      // Slab / Mesh / Wall（面積要素）
      const area = areaMap[guid];
      rows.push({
        kojiName: '', name: guid.slice(0, 8) + '...', spec: '面積要素',
        qty: area != null ? String(area) : '', unit: 'm²', price: '', cost: '',
        elementType: 'AreaElement', ...extra,
      });
      continue;
    }

    const nameVal = gdlParam(params, 'NAME') || libNameMap[guid] || '';

    // 植栽（NM パラメータ）
    const nm = gdlParam(params, 'NM');
    if (nm) {
      rows.push({ kojiName: '植栽工事', name: nm, spec: '', qty: '1', unit: '本',
        price: '', cost: '', elementType: 'Plant', ...extra });
      continue;
    }

    // フェンス（IsFence=1）
    const isFenceRaw = gdlParam(params, 'IsFence');
    const isFence = isFenceRaw !== '' && !['0', '0.0', 'false'].includes(isFenceRaw.toLowerCase());
    if (isFence) {
      const mai  = gdlParam(params, 'mai') || gdlParam(params, 'MAI');
      const fs_fp = gdlParam(params, 'FS_FP');
      const a_val = gdlParam(params, 'A');
      if (mai)   rows.push({ kojiName: 'フェンス工事', name: '本体',       spec: nameVal, qty: mai,   unit: '枚', price: '', cost: '', elementType: 'Fence', ...extra });
      if (fs_fp) rows.push({ kojiName: 'フェンス工事', name: '柱',         spec: nameVal, qty: fs_fp, unit: '本', price: '', cost: '', elementType: 'Fence', ...extra });
      if (a_val) rows.push({ kojiName: 'フェンス工事', name: 'フェンス全長', spec: nameVal, qty: a_val, unit: 'mm', price: '', cost: '', elementType: 'Fence', ...extra });
      if (!mai && !fs_fp && !a_val) rows.push({ kojiName: 'フェンス工事', name: nameVal, spec: '', qty: '', unit: '式', price: '', cost: '', elementType: 'Fence', ...extra });
      continue;
    }

    // 通常オブジェクト（LOGBIKOU をパース）
    const logbikou = gdlParam(params, 'LOGBIKOU');
    let koji = '', spec = '', qty = '', price = '', cost = '', unit = '式';
    if (logbikou) {
      for (const seg of logbikou.replace(/、/g, ',').split(',')) {
        const s = seg.trim();
        const idx = s.indexOf(':');
        if (idx > 0) {
          const k = s.slice(0, idx).trim(), v = s.slice(idx + 1).trim();
          if (['工事名', 'kojiName'].includes(k)) koji  = v;
          else if (['仕様',   'spec'  ].includes(k)) spec  = v;
          else if (['単位',   'unit'  ].includes(k)) unit  = v;
          else if (['数量',   'qty'   ].includes(k)) qty   = v;
          else if (['単価',   'price' ].includes(k)) price = v;
          else if (['原価',   'cost'  ].includes(k)) cost  = v;
        }
      }
      if (!koji && !spec && !qty && !price) spec = logbikou;
    }
    if (koji) lastKoji = koji; else koji = lastKoji;

    rows.push({ kojiName: koji, name: nameVal, spec, qty, unit, price, cost, elementType: 'Object', ...extra });
  }
  return rows;
}

// 選択要素の rows を取得（/rikcad/elements, /api/selection/elements に対応）
async function getElementsData() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (!elements.length) return { ok: true, has_selection: false };

  const guids = elements.map(e => e.elementId?.guid ?? e.elementId).filter(Boolean);

  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', {
    elements: guids.map(g => ({ elementId: { guid: g } }))
  });
  const gdlList = gdlResult.gdlParametersOfElements ?? [];

  // Object 判定
  const objectGuids = new Set();
  const noNameGuids = [];
  for (let i = 0; i < guids.length; i++) {
    const params = gdlList[i]?.parameters ?? [];
    if (params.some(p => p.name === 'NAME')) {
      objectGuids.add(guids[i]);
      if (!String(params.find(p => p.name === 'NAME')?.value ?? '').trim()) noNameGuids.push(guids[i]);
    }
  }

  // ライブラリパーツ名（NAME が空の Object 向け）
  const libNameMap = {};
  if (noNameGuids.length) {
    try {
      const libGuid = await getLibPartNameGuid(port);
      if (libGuid) {
        const res = await apiCall(port, 'GetPropertyValuesOfElements', {
          elements: noNameGuids.map(g => ({ elementId: { guid: g } })),
          properties: [{ propertyId: { guid: libGuid } }],
        });
        noNameGuids.forEach((g, i) => {
          const pv = res.propertyValuesForElements?.[i]?.propertyValues?.[0]?.propertyValue;
          if (pv?.status === 'normal') libNameMap[g] = String(pv.value ?? '');
        });
      }
    } catch {}
  }

  // 面積（非 Object）
  const areaGuids = guids.filter(g => !objectGuids.has(g));
  const areaMap = {};
  if (areaGuids.length) {
    try {
      const idRes = await apiCall(port, 'GetPropertyIds', {
        properties: [{ type: 'BuiltIn', nonLocalizedName: 'Geometry_NetTopSurfaceArea' }]
      });
      const areaPropGuid = idRes.properties?.[0]?.propertyId?.guid;
      if (areaPropGuid) {
        const valRes = await apiCall(port, 'GetPropertyValuesOfElements', {
          elements: areaGuids.map(g => ({ elementId: { guid: g } })),
          properties: [{ propertyId: { guid: areaPropGuid } }],
        });
        areaGuids.forEach((g, i) => {
          const pv = valRes.propertyValuesForElements?.[i]?.propertyValues?.[0]?.propertyValue;
          if (pv?.status === 'normal' && pv.value != null) areaMap[g] = Math.round(pv.value * 10000) / 10000;
        });
      }
    } catch {}
  }

  // GetDetailsOfElements（要素タイプ・引出線名称・要素ID）
  const cadTypeMap = {}, leaderNameMap = {}, elementIdMap = {};
  try {
    const detRes = await tapirAddon(port, 'GetDetailsOfElements', {
      elements: guids.map(g => ({ elementId: { guid: g } }))
    });
    (detRes.detailsOfElements ?? []).forEach((det, i) => {
      const g = guids[i];
      cadTypeMap[g]    = String(det?.type ?? '');
      leaderNameMap[g] = String(det?.labelText ?? det?.leaderName ?? '');
      elementIdMap[g]  = String(det?.id ?? '');
    });
  } catch {}

  const rows = buildRowsFromGdl(guids, gdlList, libNameMap, areaMap, objectGuids, cadTypeMap, leaderNameMap, elementIdMap);

  const hashParts = guids.map((g, i) => {
    const params = gdlList[i]?.parameters ?? [];
    const relevant = ['NAME', 'NM', 'LOGBIKOU', 'IsFence', 'mai', 'FS_FP', 'A'];
    const vals = params.filter(p => relevant.includes(p.name)).map(p => `${p.name}=${p.value}`).sort().join('|');
    return `${g}:${vals}|area=${areaMap[g] ?? ''}|ln=${leaderNameMap[g] ?? ''}`;
  });
  const hash = [...hashParts].sort().join(';;');

  return { ok: true, has_selection: true, hash, rows };
}

// 全要素 GUID スナップショット（/rikcad/snapshot, /api/elements/snapshot）
async function getSnapshot() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
  const res = await tapirAddon(port, 'GetAllElements');
  const guids = (res.elements ?? []).map(e => e.elementId?.guid).filter(Boolean);
  return { ok: true, guids, count: guids.length };
}

// 新規要素のデータ取得（/rikcad/newelements, /api/elements/new）
async function getNewElements(knownRaw) {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };

  const knownGuids = new Set((knownRaw || '').split(',').map(s => s.trim()).filter(Boolean));
  const allRes = await tapirAddon(port, 'GetAllElements');
  const allGuids = (allRes.elements ?? []).map(e => e.elementId?.guid).filter(Boolean);

  const newGuids = allGuids.filter(g => !knownGuids.has(g));
  if (!newGuids.length) return { ok: true, has_new: false, all_guids: allGuids };

  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', {
    elements: newGuids.map(g => ({ elementId: { guid: g } }))
  });
  const gdlList = gdlResult.gdlParametersOfElements ?? [];

  const objectGuids = new Set();
  const noNameGuids = [];
  for (let i = 0; i < newGuids.length; i++) {
    const params = gdlList[i]?.parameters ?? [];
    if (params.some(p => p.name === 'NAME')) {
      objectGuids.add(newGuids[i]);
      if (!String(params.find(p => p.name === 'NAME')?.value ?? '').trim()) noNameGuids.push(newGuids[i]);
    }
  }

  const libNameMap = {};
  if (noNameGuids.length) {
    try {
      const libGuid = await getLibPartNameGuid(port);
      if (libGuid) {
        const res = await apiCall(port, 'GetPropertyValuesOfElements', {
          elements: noNameGuids.map(g => ({ elementId: { guid: g } })),
          properties: [{ propertyId: { guid: libGuid } }],
        });
        noNameGuids.forEach((g, i) => {
          const pv = res.propertyValuesForElements?.[i]?.propertyValues?.[0]?.propertyValue;
          if (pv?.status === 'normal') libNameMap[g] = String(pv.value ?? '');
        });
      }
    } catch {}
  }

  const areaGuids = newGuids.filter(g => !objectGuids.has(g));
  const areaMap = {};
  if (areaGuids.length) {
    try {
      const idRes = await apiCall(port, 'GetPropertyIds', {
        properties: [{ type: 'BuiltIn', nonLocalizedName: 'Geometry_NetTopSurfaceArea' }]
      });
      const areaPropGuid = idRes.properties?.[0]?.propertyId?.guid;
      if (areaPropGuid) {
        const valRes = await apiCall(port, 'GetPropertyValuesOfElements', {
          elements: areaGuids.map(g => ({ elementId: { guid: g } })),
          properties: [{ propertyId: { guid: areaPropGuid } }],
        });
        areaGuids.forEach((g, i) => {
          const pv = valRes.propertyValuesForElements?.[i]?.propertyValues?.[0]?.propertyValue;
          if (pv?.status === 'normal' && pv.value != null) areaMap[g] = Math.round(pv.value * 10000) / 10000;
        });
      }
    } catch {}
  }

  const cadTypeMap = {}, leaderNameMap = {}, elementIdMap = {};
  try {
    const detRes = await tapirAddon(port, 'GetDetailsOfElements', {
      elements: newGuids.map(g => ({ elementId: { guid: g } }))
    });
    (detRes.detailsOfElements ?? []).forEach((det, i) => {
      const g = newGuids[i];
      cadTypeMap[g]    = String(det?.type ?? '');
      leaderNameMap[g] = String(det?.labelText ?? det?.leaderName ?? '');
      elementIdMap[g]  = String(det?.id ?? '');
    });
  } catch {}

  const rows = buildRowsFromGdl(newGuids, gdlList, libNameMap, areaMap, objectGuids, cadTypeMap, leaderNameMap, elementIdMap);
  return { ok: true, has_new: true, rows, all_guids: allGuids };
}

// 選択要素の NAME/LOGBIKOU 情報（/rikcad/selection_items）
async function getSelectionItems() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (!elements.length) return { ok: false, error: '選択中の要素がありません' };

  const guids = elements.map(e => e.elementId?.guid).filter(Boolean);
  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', {
    elements: guids.map(g => ({ elementId: { guid: g } }))
  });
  const gdlList = gdlResult.gdlParametersOfElements ?? [];

  const items = [];
  for (let i = 0; i < guids.length; i++) {
    const guid = guids[i];
    const params = gdlList[i]?.parameters ?? [];
    const allParams = {};
    for (const p of params) {
      if (!p.name || p.name.startsWith('_')) continue;
      let val = Array.isArray(p.value) ? (p.value[0] ?? '') : p.value;
      if (typeof val === 'boolean') val = val ? 'あり' : 'なし';
      allParams[p.name] = String(val ?? '');
    }

    const getP = (name) => gdlParam(params, name);
    const item = { guid, NAME: getP('NAME'), LOGBIKOU: getP('LOGBIKOU'), allParams };

    const isFenceRaw = getP('IsFence');
    if (isFenceRaw && !['', '0', 'false'].includes(isFenceRaw.toLowerCase())) {
      item.mai   = getP('mai');
      item.FS_FP = getP('FS_FP');
    }

    if (!item.NAME) {
      try {
        const libGuid = await getLibPartNameGuid(port);
        if (libGuid) {
          const res = await apiCall(port, 'GetPropertyValuesOfElements', {
            elements: [{ elementId: { guid } }],
            properties: [{ propertyId: { guid: libGuid } }],
          });
          const pv = res.propertyValuesForElements?.[0]?.propertyValues?.[0]?.propertyValue;
          if (pv?.status === 'normal') item.NAME = String(pv.value ?? '');
        }
      } catch {}
    }
    items.push(item);
  }

  return { ok: true, items };
}

// 選択要素の CAD NAME を取得（/api/cad/name）
async function getCadName() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (!elements.length) return { ok: false, error: '選択中の要素がありません' };

  const guid = elements[0].elementId?.guid ?? elements[0].elementId;
  const gdlResult = await tapirAddon(port, 'GetGDLParametersOfElements', {
    elements: [{ elementId: { guid } }]
  });
  const params = gdlResult.gdlParametersOfElements?.[0]?.parameters ?? [];

  let name = gdlParam(params, 'NAME');
  if (!name) {
    try {
      const libGuid = await getLibPartNameGuid(port);
      if (libGuid) {
        const res = await apiCall(port, 'GetPropertyValuesOfElements', {
          elements: [{ elementId: { guid } }],
          properties: [{ propertyId: { guid: libGuid } }],
        });
        const pv = res.propertyValuesForElements?.[0]?.propertyValues?.[0]?.propertyValue;
        if (pv?.status === 'normal') name = String(pv.value ?? '');
      }
    } catch {}
  }
  return { ok: true, name, guid };
}

// 選択要素の面積データ（/rikcad/areas）
async function getAreaDataForBridge() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };

  const selResult = await apiCall(port, 'GetSelectedElements');
  const elements = selResult.elements ?? [];
  if (!elements.length) return { ok: false, error: '選択中の要素がありません' };

  const guids = elements.map(e => e.elementId?.guid).filter(Boolean);

  const idRes = await apiCall(port, 'GetPropertyIds', {
    properties: [{ type: 'BuiltIn', nonLocalizedName: 'Geometry_NetTopSurfaceArea' }]
  });
  const areaPropGuid = idRes.properties?.[0]?.propertyId?.guid;
  if (!areaPropGuid) return { ok: false, error: 'プロパティID取得失敗' };

  const valRes = await apiCall(port, 'GetPropertyValuesOfElements', {
    elements: guids.map(g => ({ elementId: { guid: g } })),
    properties: [{ propertyId: { guid: areaPropGuid } }],
  });

  const items = guids.map((guid, i) => {
    const pv = valRes.propertyValuesForElements?.[i]?.propertyValues?.[0]?.propertyValue;
    const area = pv?.status === 'normal' && pv.value != null ? Math.round(pv.value * 10000) / 10000 : null;
    return { guid, area };
  });

  return { ok: true, items };
}

// 選択中 GUID リスト（/rikcad/selection）
async function getSelectionGuids() {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
  const res = await apiCall(port, 'GetSelectedElements');
  const guids = (res.elements ?? []).map(e => e.elementId?.guid).filter(Boolean);
  return { ok: true, guids };
}

// 選択状態を変更（/rikcad/select?guids=..., /api/selection/select）
async function setSelectionByGuids(guidsStr) {
  const port = await findTapirPort();
  if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
  const guids = (guidsStr || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!guids.length) return { ok: false, error: 'guids が指定されていません' };
  try {
    await tapirAddon(port, 'ChangeSelectionOfElements', {
      addElementsToSelection: guids.map(g => ({ elementId: { guid: g } })),
      removeElementsFromSelection: [],
    });
    return { ok: true, selected: guids.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// LOCAL_API メッセージハンドラ（すべての localhost:8767 呼び出しをここで処理）
async function handleLocalApi({ method = 'GET', path = '', params = {}, body }) {
  method = method.toUpperCase();

  // ── RIKCAD エンドポイント ──
  if (path === '/rikcad/ping') {
    const port = await findTapirPort();
    if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
    try {
      const data = await tapirCall(port, 'API.GetProductInfo');
      const version = data?.version ?? '不明';
      return { ok: true, version, port };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (path === '/rikcad/elements' || path === '/api/selection/elements') {
    return await getElementsData();
  }

  if (path === '/rikcad/selection' || path === '/api/selection/guids') {
    return await getSelectionGuids();
  }

  if (path === '/rikcad/select' || path === '/api/selection/select') {
    return await setSelectionByGuids(params.guids || params.guid || '');
  }

  if (path === '/rikcad/snapshot' || path === '/api/elements/snapshot') {
    return await getSnapshot();
  }

  if (path === '/rikcad/newelements' || path === '/api/elements/new') {
    return await getNewElements(params.known || '');
  }

  if (path === '/rikcad/selection_items') {
    return await getSelectionItems();
  }

  if (path === '/rikcad/areas') {
    return await getAreaDataForBridge();
  }

  if (path === '/rikcad/keisoku') {
    return await getKsData();
  }

  if (path === '/api/cad/name') {
    return await getCadName();
  }

  // ── スタブ（未実装・グレースフルデグラデーション）──
  if (path === '/ocr/csv') {
    return { ok: true, updated: false };
  }

  if (path === '/api/keisoku/reload') {
    return { ok: true, message: 'Chrome拡張モードではCSVキャッシュ再読み込み不要です' };
  }

  if (path === '/api/project_info') {
    const port = await findTapirPort().catch(() => null);
    return { ok: true, tapir_port: port, mode: 'chrome-extension' };
  }

  if (path === '/api/elements/watch') {
    return { ok: true, has_new: false };
  }

  // ── ファイルシステム（ローカルCSV）──
  // file:// 環境ではファイルアクセスAPIが使用できないためスタブ
  if (path === '/api/files') {
    if (method === 'POST') {
      return { __status: 503, __text: 'Chrome拡張モードではファイル書き込みはサポートされていません' };
    }
    return { __status: 404, __text: 'Chrome拡張モードではローカルファイルへのアクセスはサポートされていません' };
  }

  if (path === '/api/list') {
    return { ok: false, error: 'Chrome拡張モードではディレクトリ一覧はサポートされていません', files: [] };
  }

  return { ok: false, error: `Unknown path: ${path}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    findTapirPort().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'LOCAL_API') {
    handleLocalApi(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'GET_GDL_PARAMS') {
    getGdlParams()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_QUANTITIES') {
    getQuantities()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MATERIALS') {
    getMaterials()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_KS_DATA') {
    Promise.resolve()
      .then(() => getKsData())
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'SET_SELECTION') {
    (async () => {
      const port = await findTapirPort();
      if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
      const toRemove = (msg.removeGuids || []).map(g => ({ elementId: { guid: g } }));
      const toAdd    = (msg.addGuids    || []).map(g => ({ elementId: { guid: g } }));
      const params = {};
      if (toRemove.length) params.removeElementsFromSelection = toRemove;
      if (toAdd.length)    params.addElementsToSelection      = toAdd;
      if (!Object.keys(params).length) return { ok: true };
      const r = await tapirAddon(port, 'ChangeSelectionOfElements', params);
      return { ok: true, result: r };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'CHANGE_SELECTION') {
    (async () => {
      const port = await findTapirPort();
      if (!port) return { ok: false, error: 'RIKCADに接続できませんでした' };
      const elements = [{ elementId: { guid: msg.guid } }];
      const r = await tapirAddon(port, 'ChangeSelectionOfElements', {
        addElementsToSelection: elements
      });
      return { ok: true, result: r };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_SELECTED_GUIDS') {
    (async () => {
      const port = await findTapirPort();
      if (!port) return { ok: true, guids: [] };
      const res = await apiCall(port, 'GetSelectedElements');
      const guids = (res.elements ?? []).map(e => e.elementId?.guid).filter(Boolean);
      return { ok: true, guids };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: true, guids: [] }));
    return true;
  }
  if (msg.type === 'TEST_CHANGE_SELECTION') {
    testChangeSelection()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'TEST_HIGHLIGHT') {
    testHighlightElements()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
