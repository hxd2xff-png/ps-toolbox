/* 宿主 host.jsx 离线冒烟测试
   用一个「迷你 Photoshop 文本模型」当桩，验证：
   1) 文件能整体求值（无顶层异常）、纯 ASCII / 无 BOM / 无 ES5+ 语法
   2) 入口被发布到 $.global.cephostDispatch
   3) ping / list-fonts / sel-sig / pick-color / unknown-type 返回合法 JSON
   4) detect-font 能读出文本图层的字体/字号/颜色
   5) font-mixer 走 textKey 路径真的把两个字体写进两段，且区间无缝覆盖全文
   6) 字体被 Photoshop 替换时，宿主必须如实上报并保留已写入结果（绝不整层覆盖）
   7) engineData 必须被丢弃（否则版式会回退）
   8) selftest 在临时文档里跑完整链路并关闭该文档
   9) auto-kerning 写入 AutoKernType.OPTICAL 并回读校验

   注意：桩模拟的是「我以为的 Photoshop 行为」，它能证明宿主逻辑自洽，
   不能证明真机接受这个描述符形状 —— 那由面板启动时的 selftest 负责。
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.join(__dirname, '..', 'com.figmatoolbox.ps', 'jsx', 'host.jsx');
const raw = fs.readFileSync(srcPath);
const src = raw.toString('latin1'); // 保留字节，便于检查非 ASCII

let fails = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) fails++; };
const checkEq = (a, b, label) => check(a === b, label + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

/* ---- 静态检查 ---- */
check(raw[0] !== 0xef, 'no UTF-8 BOM');
check(/^[\x00-\x7f]*$/.test(src), 'pure ASCII source');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
[
  [/\b(let|const)\b/, 'let/const'],
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\?\./, 'optional chaining'],
  [/\?\?/, 'nullish coalescing'],
  [/catch\s*\{/, 'catch without binding'],
  [/\.forEach\(|\.map\(|\.filter\(|\.reduce\(|\.indexOf\(|\.includes\(/, 'ES5+ array extras'],
  [/\.\.\./, 'spread'],
].forEach(([re, name]) => check(!re.test(code), 'ES3 clean: ' + name));

const reserved = /[\{,\s](class|default|delete|function|in|do|if|else|for|while|return|this|with|var|case|switch|throw|try|catch|finally|break|continue|instanceof|new|typeof|void|enum|export|import|extends|super|const|let|yield|char|int|byte|long|float|double|boolean|final|native|short|static|public|private|protected|abstract|goto|synchronized|throws|transient|volatile|package|implements|interface)\s*:/.exec(code);
check(!reserved, 'ES3 clean: no reserved word as object key' + (reserved ? ' -> ' + reserved[0] : ''));

/* ================= 迷你 Photoshop 文本模型 ================= */

const ids = new Map();
const idName = (n) => { for (const [k, v] of ids) if (v === n) return k; return String(n); };
let nextId = 1000;
const id = (k) => { if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };

class FakeList {
  constructor(items) { this.items = items || []; }
  get count() { return this.items.length; }
  getObjectValue(i) { return this.items[i]; }
  getReference(i) { return this.items[i]; }
  putObject(cls, item) { const v = item === undefined ? cls : item; this.items.push(v); }
  putInteger(cls, v) { this.items.push(v); }
}
function cloneVal(v) {
  if (v instanceof FakeDesc) {
    const m = new Map();
    v.store.forEach((val, k) => m.set(k, cloneVal(val)));
    return new FakeDesc(m);
  }
  if (v instanceof FakeList) return new FakeList(v.items.map(cloneVal));
  return v;
}
class FakeDesc {
  constructor(store) { this.store = store || new Map(); }
  putDouble(k, v) { this.store.set(k, v); }
  putInteger(k, v) { this.store.set(k, v); }
  putString(k, v) { this.store.set(k, v); }
  putBoolean(k, v) { this.store.set(k, v); }
  putUnitDouble(k, unit, v) { this.store.set(k, v); }
  putObject(k, cls, o) { this.store.set(k, o === undefined ? cls : o); }
  putReference(k, r) { this.store.set(k, r); }
  putEnumerated(k, c, v) { this.store.set(k, v); }
  putList(k, l) { this.store.set(k, l); }
  hasKey(k) { return this.store.has(k); }
  erase(k) { this.store.delete(k); }
  getString(k) { return this.store.get(k); }
  getInteger(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not an integer: ' + idName(k)); return v; }
  getDouble(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not a double: ' + k); return v; }
  getBoolean(k) { return this.store.get(k); }
  getUnitDoubleValue(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not a unit double: ' + k); return v; }
  getObjectValue(k) { const v = this.store.get(k); if (!(v instanceof FakeDesc)) throw new Error('not an object: ' + k); return v; }
  getList(k) { const v = this.store.get(k); if (!(v instanceof FakeList)) throw new Error('not a list: ' + k); return v; }
  toStream() { return cloneVal(this); }
  fromStream(s) { this.store = cloneVal(s).store; }
}
class FakeRef {
  constructor() { this.kind = 'ref'; this.identifierKey = null; this.identifierValue = null; this.property = null; }
  putProperty(k1, k2) { this.property = k2; }
  putIdentifier(k, v) { this.identifierKey = k; this.identifierValue = v; }
  putIndex(k, i) { this.identifierKey = k; this.identifierValue = i; }
  putEnumerated() { }
}
/* reference inside the targetLayers list: getIdentifier() -> layer id */
class FakeRef2 {
  constructor(idv) { this.idv = idv; }
  getIdentifier() { return this.idv; }
}
/* index-form reference: getIdentifier throws, getIndex returns the index
   (mimics what PS 20/21 really hands back for targetLayers) */
class FakeRefIdx {
  constructor(idx) { this.idx = idx; }
  getIdentifier() { throw new Error('no identifier (index-form ref)'); }
  getIndex() { return this.idx; }
}

/* ---- 字体 ---- */
const FONTS = [
  // 排在第一位的是纯 emoji 字体：自检绝不能挑它（真机上就是它造成误报）
  { family: 'Emoji One Color', style: 'Regular', postScriptName: 'EmojiOneColor' },
  { family: 'PingFang SC', style: 'Regular', postScriptName: 'PingFangSC-Regular' },
  { family: 'PingFang SC', style: 'Bold', postScriptName: 'PingFangSC-Bold' },
  { family: 'Inter', style: 'Regular', postScriptName: 'Inter-Regular' },
];
const fontByPS = (ps) => FONTS.find((f) => f.postScriptName === ps) || null;

/* ---- 文档 / 图层 ---- */
let nextLayerId = 100;
const closedDocs = [];
const PS = {
  substituteTo: null,     // 非空时：写入的某一层字体被 Photoshop 悄悄替换
  lastSet: null,          // 记录最后一次 set 的描述符
  throwOnSet: null,       // 非空时：set 抛错（模拟描述符被拒）
  ignoreSize: false,      // true 时：set 接受但不改字号（真机上的静默忽略）
  sizeKeysWritten: [],    // 每次 set 里出现的字号键
  lastAutoLeading: null,  // 最后一次 set 里是否写了 autoLeading
};

function styleOf(ps, size, rgb, tracking) {
  return new FakeDesc(new Map([
    [id('fontPostScriptName'), ps],
    [id('size'), size === undefined ? 12 : size],
    [id('color'), new FakeDesc(new Map([[id('red'), rgb ? rgb[0] : 0], [id('grain'), rgb ? rgb[1] : 0], [id('blue'), rgb ? rgb[2] : 0]]))],
    [id('tracking'), tracking || 0],
  ]));
}
function rangeOf(from, to, style) { return new FakeDesc(new Map([[id('from'), from], [id('to'), to], [id('textStyle'), style]])); }

function makeDoc(name) {
  const doc = { name: name || 'doc', _layers: [] };
  doc.artLayers = {
    add() { const l = makeLayer('', [{ from: 0, to: 0, style: styleOf('Inter-Regular') }]); doc._layers.push(l); return l; },
  };
  doc.layers = doc._layers;
  doc.close = () => { closedDocs.push(doc.name); };
  doc.suspendHistory = () => { };
  return doc;
}
function makeLayer(name, ranges, opts) {
  const st = { text: '', ranges: ranges || [], engineData: 'opaque-typesetting-snapshot' };
  const layerId = nextLayerId++;
  PS.textKeys = PS.textKeys || new Map();
  PS.textKeys.set(layerId, st);
  const o = opts || {};
  const layer = {
    id: layerId,
    itemIndex: o.itemIndex || 1,
    typename: 'ArtLayer',
    name: name || 'text layer',
    kind: 2,          // LayerKind.TEXT
  };
  layer.textItem = {
    get contents() { return st.text; },
    set contents(v) {
      st.text = v;
      // Photoshop re-tiles the style ranges for the new text
      st.ranges = [{ from: 0, to: v.length, style: st.ranges.length ? st.ranges[0].style : styleOf('Inter-Regular') }];
    },
    get font() { return st.ranges.length ? st.ranges[0].style.getString(id('fontPostScriptName')) : null; },
    set font(ps) { st.ranges.forEach((r) => r.style.store.set(id('fontPostScriptName'), ps)); },
    autoKerning: 0,
    size: 0,
    color: null,
    _state: st,
  };
  return layer;
}
function textKeyDescOf(st) {
  const m = new Map([
    [id('textKey'), st.text],
    [id('textStyleRange'), new FakeList(st.ranges.map((r) => rangeOf(r.from, r.to, cloneVal(r.style))))],
    [id('engineData'), new FakeDesc(new Map([[id('opaque'), 1]]))],
  ]);
  if (st.transform) {
    m.set(id('transform'), new FakeDesc(new Map([
      [id('xx'), st.transform.xx], [id('yy'), st.transform.yy],
      [id('tx'), 0], [id('ty'), 0],
    ])));
  }
  return new FakeDesc(m);
}

function executeActionGet(ref) {
  if (ref instanceof FakeRef && ref.property === id('textKey') && ref.identifierKey === id('layer')) {
    const st = PS.textKeys.get(ref.identifierValue);
    if (!st) throw new Error('no textKey for layer ' + ref.identifierValue);
    return new FakeDesc(new Map([[id('textKey'), textKeyDescOf(st)]]));
  }
  if (ref instanceof FakeRef && ref.property === id('targetLayers')) {
    if (PS.targetLayerIds === null) throw new Error('no targetLayers property');
    // PS.targetLayerIdx: INDEX-form references (PS 20/21 quirk). When set,
    // entries are FakeRef2 with no identifier; getIndex() yields the index.
    const lst = PS.targetLayerIdx
      ? new FakeList(PS.targetLayerIdx.map((i) => new FakeRefIdx(i)))
      : new FakeList(PS.targetLayerIds.map((i) => new FakeRef2(i)));
    return new FakeDesc(new Map([[id('targetLayers'), lst]]));
  }
  if (ref instanceof FakeRef && ref.property === id('layerId') && ref.identifierKey === id('layer') && ref.identifierValue) {
    throw new Error('AM layerId-by-index not used (host must resolve via DOM stack)');
  }
  if (ref instanceof FakeRef && ref.identifierKey === id('layer')) {
    // bare layer reference (id lookup): return name only
    for (const [lid, st] of PS.textKeys) {
      if (lid === ref.identifierValue) return new FakeDesc(new Map([[id('name'), 'layer-' + lid]]));
    }
    throw new Error('no layer ' + ref.identifierValue);
  }
  throw new Error('executeActionGet: unsupported reference');
}
function executeAction(action, desc) {
  if (action !== id('set')) throw new Error('unsupported action');
  if (PS.throwOnSet) throw new Error(PS.throwOnSet);
  const ref = desc.store.get(id('null'));
  const tkDesc = desc.store.get(id('to'));
  const st = PS.textKeys.get(ref.identifierValue);
  if (!st) throw new Error('no layer ' + ref.identifierValue);
  PS.lastSet = { engineDataPresent: tkDesc.store.has(id('engineData')), ranges: [] };
  const list = tkDesc.getList(id('textStyleRange'));
  const newRanges = [];
  for (let i = 0; i < list.count; i++) {
    const r = list.getObjectValue(i);
    const style = cloneVal(r.getObjectValue(id('textStyle')));
    const from = r.getInteger(id('from'));
    const to = r.getInteger(id('to'));
    if (PS.substituteFn) {
      const sub = PS.substituteFn(from, to, style.store.get(id('fontPostScriptName')));
      if (sub) style.store.set(id('fontPostScriptName'), sub);
    } else if (PS.substituteTo && from === 0) style.store.set(id('fontPostScriptName'), PS.substituteTo);
    // a layer transform makes PS store PRE-transform base values: written 50
    // with K=6.5625 is stored as 7.62 and the character panel shows 50 again
    if (st.transform && style.store.has(id('size'))) {
      style.store.set(id('size'), style.store.get(id('size')) / st.transform.xx);
    }
    const sizeKeyNames = [];
    ['size', 'impliedFontSize', 'Sz  '].forEach((k) => { if (style.store.has(id(k))) sizeKeyNames.push(k); });
    PS.sizeKeysWritten.push(sizeKeyNames.join('+'));
    if (PS.ignoreSize) sizeKeyNames.forEach((k) => style.store.delete(id(k)));
    if (style.store.get(id('autoLeading')) === true) PS.lastAutoLeading = true;
    newRanges.push({ from, to, style });
    PS.lastSet.ranges.push(from + '-' + to + ':' + style.getString(id('fontPostScriptName')));
  }
  st.ranges = newRanges;
}
function executeActionGetAutoKerning() { return null; }

/* ---- app ---- */
PS.targetLayerIds = null;   // null = stub has no targetLayers (DOM fallback path)
const mainLayer = makeLayer('hello 世界', [
  { from: 0, to: 6, style: styleOf('Inter-Regular', 18, [0, 0, 0]) },
  { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16, [255, 0, 0]) },
]);
mainLayer.textItem._state.text = 'hello 世界';
mainLayer.textItem._state.ranges[0].to = 8;      // 0..8 覆盖全文
mainLayer.textItem._state.ranges = [
  { from: 0, to: 6, style: styleOf('Inter-Regular', 18, [0, 0, 0]) },
  { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16, [255, 0, 0]) },
];
mainLayer.textItem._state.text = 'hello 世界';

const mainDoc = { name: 'main.psd', activeLayers: [mainLayer], activeLayer: mainLayer, layers: [mainLayer], suspendHistory() { }, activeHistoryState: 1 };
mainDoc.artLayers = { add() { const l = makeLayer('', [{ from: 0, to: 0, style: styleOf('Inter-Regular') }]); mainDoc.layers.push(l); return l; } };

const docs = [mainDoc];
const openDocs = () => docs.filter((d) => !closedDocs.includes(d.name));
const documents = {
  get length() { return openDocs().length; },
  add() { const d = makeDoc('PSToolbox selftest'); docs.unshift(d); return d; },
};

let foreground = null;
const sandbox = {
  $: { global: {}, evalFile() { }, writeln() { } },
  ActionDescriptor: function () { return new FakeDesc(); },
  ActionReference: function () { return new FakeRef(); },
  ActionList: function () { return new FakeList(); },
  executeActionGet,
  executeAction,
  stringIDToTypeID: id,
  charIDToTypeID: id,
  DialogModes: { NO: 3, YES: 1, ALL: 2 },
  LayerKind: { TEXT: 2, NORMAL: 1 },
  AutoKernType: { OPTICAL: 3, METRICS: 1, MANUAL: 2 },
  UnitValue: function (v, u) { return { value: v, units: u }; },
  SolidColor: function () { this.rgb = { red: 0, green: 0, blue: 0 }; },
  SaveOptions: { DONOTSAVECHANGES: 2 },
  NewDocumentMode: { RGB: 3 },
  DocumentFill: { TRANSPARENT: 3 },
  app: {
    fonts: FONTS,
    get documents() { return documents; },
    get activeDocument() { return openDocs()[0] || null; },
    set activeDocument(d) { /* 只需不抛错 */ },
    get foregroundColor() { return foreground; },
    set foregroundColor(v) { foreground = v; },
    showColorPicker: () => false,
  },
  isNaN, isFinite, Math, JSON: undefined,
};
sandbox.global = sandbox;
vm.createContext(sandbox);

let loadErr = null;
try { vm.runInContext(src, sandbox, { filename: 'host.jsx' }); } catch (e) { loadErr = e; }
check(!loadErr, 'host.jsx evaluates without top-level throw' + (loadErr ? ' -> ' + loadErr.message : ''));

const g = sandbox.$ && sandbox.$['global'] ? sandbox.$['global']['cephostDispatch'] : null;
check(typeof g === 'function', 'entry published on $.global');
check(/\$\.global\.cephostDispatch\s*=\s*cephostDispatch/.test(src), 'explicit $.global export present');

if (typeof g !== 'function') {
  console.log('\n' + fails + ' HOST CHECK(S) FAILED');
  process.exit(1);
}

const tryCall = (type, args) => {
  try {
    const json = g(type, args ? encodeURIComponent(JSON.stringify(args)) : '');
    return { ok: true, parsed: global.JSON.parse(json) };
  } catch (e) { return { ok: false, err: e.message }; }
};
const stale = () => { fails++; };

/* ---- 1. 基础 API ---- */
let r = tryCall('ping');
check(r.ok && r.parsed.pong === true && r.parsed.version === '4.7.0', 'ping -> v4.7.0');

r = tryCall('list-fonts');
check(r.ok && r.parsed.families.length === 3, 'list-fonts merges families (3)');
check(r.ok && r.parsed.families.some((f) => f.styles.length === 2), 'list-fonts keeps multiple styles');

r = tryCall('sel-sig');
check(r.ok && typeof r.parsed.sig === 'string', 'sel-sig -> ok');

r = tryCall('unknown-thing');
check(r.ok && /unknown type/.test(r.parsed.error), 'unknown type -> error json');

r = tryCall('pick-color', { r: 0.5, g: 0.2, b: 0.1 });
check(r.ok && r.parsed.ok === false, 'pick-color cancel -> {ok:false}');

/* ---- 2. detect-font 走 textKey 读取 ---- */
r = tryCall('detect-font');
check(r.ok && r.parsed.empty === false, 'detect-font reads the text layer');
check(r.ok && r.parsed.cnFont && r.parsed.cnFont.family === 'PingFang SC', 'detect-font cn font from textKey');
check(r.ok && r.parsed.enFont && r.parsed.enFont.family === 'Inter', 'detect-font en font from textKey');
check(r.ok && r.parsed.cnSize === 16 && r.parsed.enSize === 18, 'detect-font sizes from textKey');

/* ---- 3. 读取失败必须报错，绝不静默返回空 ---- */
PS.textKeys.delete(mainLayer.id);
r = tryCall('detect-font');
check(r.ok && !!r.parsed.error, 'detect-font surfaces a read failure instead of silent nulls');
PS.textKeys.set(mainLayer.id, mainLayer.textItem._state);

/* ---- 4. font-mixer 走 textKey 写入 ---- */
r = tryCall('font-mixer', {
  cnFont: { family: 'PingFang SC', style: 'Bold' },
  enFont: { family: 'Inter', style: 'Regular' },
});
check(r.ok && r.parsed.ok === 1 && r.parsed.failed.length === 0, 'font-mixer applies to the layer');
checkEq(r.parsed.path, 'canonical', 'font-mixer used the canonical textKey path');
check(PS.lastSet && !PS.lastSet.engineDataPresent, 'engineData is dropped from the written descriptor');
const written = mainLayer.textItem._state.ranges;
// v4.7 (per spec MD §7): the space at index 5 rides with the PREVIOUS char's
// side -> plan is EN 0-6 / CN 6-8; two ranges, gapless.
check(written.length === 2, 'two style ranges written (got ' + written.length + ')');
checkEq(written[0].from + '-' + written[0].to, '0-6', 'latin range incl. trailing space (space rides previous side)');
checkEq(written[1].from + '-' + written[1].to, '6-8', 'CJK range');
checkEq(written[0].style.getString(id('fontPostScriptName')), 'Inter-Regular', 'latin range got the English font');
checkEq(written[1].style.getString(id('fontPostScriptName')), 'PingFangSC-Bold', 'CJK range got the Chinese font');

/* 区间必须无缝覆盖全文（Photoshop 要求 from/to 连续） */
let cover = 0, gapless = true;
for (let i = 0; i < written.length; i++) { if (written[i].from !== cover) gapless = false; cover = written[i].to; }
check(gapless && cover === 8, 'written ranges tile the whole text');

/* ---- 4b. 全角标点必须归中文字体（真机回归：全角括号曾被划给英文字体，
   没有全角字形的字体会被 Photoshop 替换，进而引发整层覆盖事故） ---- */
const USER_TEXT = '光感「」无瑕  （24H）润贴';   // 真机故障文案原文
const fwLayer = makeLayer('fw punct layer', [{ from: 0, to: USER_TEXT.length, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
fwLayer.textItem._state.text = USER_TEXT;
mainDoc.activeLayers = [fwLayer];
mainDoc.activeLayer = fwLayer;
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.ok === 1, 'font-mixer runs on the real-world mixed text');
checkEq(r.parsed.path, 'canonical', 'real-world text keeps the canonical path');
check(r.ok && r.parsed.substituted.length === 0 && r.parsed.layerFallback.length === 0, 'fullwidth punctuation no longer forces a substitution');
{
  const w = fwLayer.textItem._state.ranges;
  const fontAt = (k) => { for (let t = 0; t < w.length; t++) if (k >= w[t].from && k < w[t].to) return w[t].style.getString(id('fontPostScriptName')); return null; };
  checkEq(fontAt(0), 'PingFangSC-Bold', 'CJK ideographs get the Chinese font');
  checkEq(fontAt(8), 'PingFangSC-Bold', 'fullwidth ( gets the Chinese font (regression)');
  checkEq(fontAt(12), 'PingFangSC-Bold', 'fullwidth ) gets the Chinese font (regression)');
  checkEq(fontAt(10), 'Inter-Regular', 'latin 24H keeps the English font');
  let cov = 0, tiling = true;
  for (let t = 0; t < w.length; t++) { if (w[t].from !== cov) tiling = false; cov = w[t].to; }
  check(tiling && cov === USER_TEXT.length, 'ranges tile the full text');
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 4c. symSide: symbol ownership switch (auto / cn / en) ----
   Text "Hi (你好)" - halfwidth ( ) are auto-side English; fullwidth chars
   are always Chinese; latin letters are always English. */
const SYM_TEXT = 'Hi(你好)';
function makeSymLayer() {
  const l = makeLayer('sym layer', [{ from: 0, to: SYM_TEXT.length, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
  l.textItem._state.text = SYM_TEXT;
  mainDoc.activeLayers = [l];
  mainDoc.activeLayer = l;
  return l;
}
const symFontAt = (w, k) => { for (let t = 0; t < w.length; t++) if (k >= w[t].from && k < w[t].to) return w[t].style.getString(id('fontPostScriptName')); return null; };
// auto (v4.7, aligned with the MD reference): fullwidth/CJK punct rides with
// the Chinese font; ASCII punctuation stays English (the reference keeps it EN
// in auto — every Latin face carries those glyphs); explicit switches win.
let symLayer = makeSymLayer();
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'canonical', 'symSide auto: mix runs on canonical path');
let w = symLayer.textItem._state.ranges;
checkEq(symFontAt(w, 0), 'Inter-Regular', 'symSide auto: latin H stays English');
checkEq(symFontAt(w, 2), 'Inter-Regular', 'symSide auto: halfwidth ( stays English (MD ref)');
checkEq(symFontAt(w, 3), 'PingFangSC-Bold', 'symSide auto: ideograph stays Chinese');
checkEq(symFontAt(w, 5), 'Inter-Regular', 'symSide auto: halfwidth ) stays English (MD ref)');
// cn: ALL symbols (halfwidth included) go to the Chinese font
symLayer = makeSymLayer();
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, symSide: 'cn' });
check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'canonical', 'symSide cn: mix runs on canonical path');
w = symLayer.textItem._state.ranges;
checkEq(symFontAt(w, 0), 'Inter-Regular', 'symSide cn: latin letters never move');
checkEq(symFontAt(w, 2), 'PingFangSC-Bold', 'symSide cn: halfwidth ( moved to Chinese font');
checkEq(symFontAt(w, 5), 'PingFangSC-Bold', 'symSide cn: halfwidth ) moved to Chinese font');
let cov2 = 0, tile2 = true;
for (let t = 0; t < w.length; t++) { if (w[t].from !== cov2) tile2 = false; cov2 = w[t].to; }
check(tile2 && cov2 === SYM_TEXT.length, 'symSide cn: ranges still tile the whole text');
// en: fullwidth/CJK punctuation joins the English side
const FW_SYM = '「Hi」';
const fwl = makeLayer('fw sym layer', [{ from: 0, to: FW_SYM.length, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
fwl.textItem._state.text = FW_SYM;
mainDoc.activeLayers = [fwl];
mainDoc.activeLayer = fwl;
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, symSide: 'en' });
check(r.ok && r.parsed.ok === 1, 'symSide en: mix runs');
wf = fwl.textItem._state.ranges;
checkEq(symFontAt(wf, 0), 'Inter-Regular', 'symSide en: fullwidth corner bracket moved to English font');
checkEq(symFontAt(wf, 3), 'Inter-Regular', 'symSide en: closing corner bracket moved to English font');
checkEq(symFontAt(wf, 1), 'Inter-Regular', 'symSide en: latin inside stays English');
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 5. 空文档 / 无文本图层 ---- */
const emptyDoc = { name: 'empty.psd', activeLayers: [], activeLayer: null, layers: [] };
docs.unshift(emptyDoc);
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Regular' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.empty === true && r.parsed.total === 0, 'font-mixer reports an empty selection');
r = tryCall('detect-font');
check(r.ok && r.parsed.empty === true, 'detect-font reports an empty selection');
docs.shift();

/* ---- 5b. empty feedback: non-text layer / empty text layer must explain why ---- */
const notTextLayer = { id: 9901, typename: 'ArtLayer', name: 'xuejiani adjustment', kind: 1, itemIndex: 1 };
mainDoc.activeLayers = [notTextLayer];
mainDoc.activeLayer = notTextLayer;
r = tryCall('detect-font');
check(r.ok && r.parsed.empty === true && r.parsed.emptyReason === 'no-text-layer', 'detect-font: non-text layer reports emptyReason no-text-layer');
check(r.ok && r.parsed.emptyLayer === 'xuejiani adjustment', 'detect-font: non-text layer reports its name');
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Regular' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.empty === true && r.parsed.emptyReason === 'no-text-layer', 'font-mixer: non-text layer reports emptyReason no-text-layer');

const emptyTextLayer = makeLayer('blank text layer', [{ from: 0, to: 0, style: styleOf('Inter-Regular') }]);
emptyTextLayer.textItem.contents = '';
mainDoc.activeLayers = [emptyTextLayer];
mainDoc.activeLayer = emptyTextLayer;
r = tryCall('detect-font');
check(r.ok && r.parsed.empty === true && r.parsed.emptyReason === 'empty-text', 'detect-font: empty text layer reports emptyReason empty-text');
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Regular' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.empty === false || r.parsed.emptyReason === 'empty-text', 'font-mixer: empty-text is explained');

/* ---- 5c. size stored as a plain double (no unit) is still readable ---- */
const dblLayer = makeLayer('double size layer', []);
dblLayer.textItem.contents = 'Ab';
dblLayer.textItem._state.ranges = [{ from: 0, to: 2, style: styleOf('Inter-Regular') }];
dblLayer.textItem._state.ranges[0].style = new FakeDesc(new Map([
  [id('fontPostScriptName'), 'Inter-Regular'],
  [id('size'), 17.5],
]));
// the stub's getUnitDoubleValue throws on non-number; a number is a number here.
// Force the unit path to fail so the getDouble fallback is exercised:
dblLayer.textItem._state.ranges[0].style.getUnitDoubleValue = function () { throw new Error('not a unit double'); };
PS.textKeys.set(dblLayer.id, dblLayer.textItem._state);
mainDoc.activeLayers = [dblLayer];
mainDoc.activeLayer = dblLayer;
r = tryCall('detect-font');
check(r.ok && r.parsed.empty === false && r.parsed.cnSize === 17.5, 'detect-font: plain-double size read via getDouble fallback, got ' + r.parsed.cnSize);

mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 6. 缺字体 ---- */
r = tryCall('font-mixer', { cnFont: { family: 'Nope', style: 'X' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.missingFonts.length === 1, 'font-mixer reports missing font instead of throwing');

/* ---- 7. 字体被替换且修不了（每次写入都被换回）→ 如实上报 + 不整层覆盖 ---- */
PS.substituteFn = () => 'Inter-Regular';   // PS keeps swapping EVERY write back
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.substituted.length === 1, 'an unrepairable substitution is reported in substituted[]');
check(r.ok && r.parsed.failed.length === 0, 'substitution is not reported as a hard failure');
check(r.ok && r.parsed.layerFallback.length === 0, 'substitution must NOT trigger the destructive whole-layer repaint');
{
  const w = mainLayer.textItem._state.ranges;
  check(w.length === 2 && w.every((t) => t.style.getString(id('fontPostScriptName')) === 'Inter-Regular'),
    'the written ranges stay as written (no DOM repaint over them)');
}PS.substituteFn = null;

/* ---- 7b. 自修复：EN 字体缺字形被替换 → 换中文字体重写一次并验证通过 ---- */
PS.substituteFn = (from, to, psName) => (psName === 'Inter-Regular' ? 'PingFangSC-Regular' : null);
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.substituted.length === 0, 'self-repair: no substitution left after the repair rewrite');
check(r.ok && /repair/.test(String(r.parsed.path)), 'self-repair: path reports the repair (got ' + r.parsed.path + ')');
{
  const w = mainLayer.textItem._state.ranges;
  const allCN = w.every((t) => t.style.getString(id('fontPostScriptName')) === 'PingFangSC-Bold');
  check(allCN && w.length >= 1, 'self-repair: every range now carries the CN font');
}PS.substituteFn = null;

/* ---- 8. set 被拒 -> 整层 DOM 兜底并说明 ---- */
mainLayer.textItem._state.ranges = [
  { from: 0, to: 6, style: styleOf('Inter-Regular', 18, [0, 0, 0]) },
  { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16, [255, 0, 0]) },
];
PS.throwOnSet = 'the command Set is not currently available';
r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Regular' }, enFont: { family: 'Inter', style: 'Regular' } });
check(r.ok && r.parsed.ok === 1 && r.parsed.layerFallback.length === 1, 'a rejected descriptor falls back to the DOM write');
check(r.ok && /dom-font:ok/.test(String(r.parsed.layerFallback[0])), 'the DOM fallback is reported with its result');
PS.throwOnSet = null;

/* ---- 9. selftest 在临时文档上跑完整链路 ---- */
PS.substituteTo = null;
r = tryCall('selftest', {});
check(r.ok && r.parsed.steps.indexOf('read=ok') >= 0, 'selftest read path');
check(r.ok && r.parsed.steps.indexOf('write=ok') >= 0, 'selftest write path');
check(r.ok && r.parsed.steps.indexOf('verify=ok') >= 0, 'selftest verify path');
check(r.ok && r.parsed.closed === true, 'selftest closes its temporary document');
check(closedDocs.indexOf('PSToolbox selftest') >= 0, 'the temporary document really was closed');
r = tryCall('selftest', { cnFont: { family: 'PingFang SC', style: 'Bold' } });
check(r.ok && r.parsed.cnFont === 'PingFangSC-Bold', 'selftest accepts family/style from the panel');

/* ---- 10. 字号：能写入时必须真的写进去（回读确认） ---- */
const resetRanges = () => {
  mainLayer.textItem._state.ranges = [
    { from: 0, to: 6, style: styleOf('Inter-Regular', 18, [0, 0, 0]) },
    { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16, [255, 0, 0]) },
  ];
};
resetRanges();
PS.sizeKeysWritten = [];
PS.ignoreSize = false;
r = tryCall('font-mixer', {
  cnFont: { family: 'PingFang SC', style: 'Regular' },
  enFont: { family: 'Inter', style: 'Regular' },
  cnSize: 20, enSize: 30,
});
check(r.ok && r.parsed.ok === 1 && (r.parsed.notes || []).length === 0, 'font-mixer applies sizes without notes');
{
  const wr = mainLayer.textItem._state.ranges;
  checkEq(wr[0].style.store.get(id('size')), 30, 'latin range size written');
  checkEq(wr[1].style.store.get(id('size')), 20, 'CJK range size written');
}

/* ---- 11. 字号被静默忽略时必须报出来，绝不假装成功 ---- */
resetRanges();
PS.sizeKeysWritten = [];
PS.ignoreSize = true;
r = tryCall('font-mixer', {
  cnFont: { family: 'PingFang SC', style: 'Regular' },
  enFont: { family: 'Inter', style: 'Regular' },
  cnSize: 20, enSize: 30,
});
check(r.ok && r.parsed.ok === 1, 'fonts are still applied when the size cannot be written');
check(r.ok && (r.parsed.notes || []).some((x) => /\u5b57\u53f7/.test(x)), 'an ignored size is reported to the panel: ' + JSON.stringify(r.parsed.notes));
check(r.ok && PS.sizeKeysWritten.filter((x) => x.length).length >= 1, 'the size write was actually attempted: ' + PS.sizeKeysWritten.join(','));
PS.ignoreSize = false;
resetRanges();

/* ---- 11b. 带变换的图层：字号必须按面板尺寸写入并验证（真机回归：
   K=6.5625 的图层上写 50，PS 存 7.62、面板显示 50；校验必须接受） ---- */
const K = 6.5625;
const scaled = makeLayer('scaled layer', [
  { from: 0, to: 6, style: styleOf('Inter-Regular', 18, [0, 0, 0]) },
  { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16, [255, 0, 0]) },
]);
scaled.textItem._state.text = 'hello 世界';
scaled.textItem._state.transform = { xx: K, yy: K };
mainDoc.activeLayers = [scaled];
mainDoc.activeLayer = scaled;
PS.sizeKeysWritten = [];
PS.ignoreSize = false;
r = tryCall('font-mixer', {
  cnFont: { family: 'PingFang SC', style: 'Regular' },
  enFont: { family: 'Inter', style: 'Regular' },
  cnSize: 50, enSize: 50,
});
check(r.ok && r.parsed.ok === 1, 'size write succeeds on a transformed layer (K=6.5625)');
checkEq(r.parsed.path, 'canonical', 'transformed layer keeps the canonical path (no false notes)');
check((r.parsed.notes || []).length === 0, 'no false size-failure note on transformed layers: ' + JSON.stringify(r.parsed.notes));
{
  const wr = scaled.textItem._state.ranges;
  const stored = wr[0].style.store.get(id('size'));
  check(Math.abs(stored - 50 / K) < 0.1, 'PS stored the pre-transform base value: ' + stored);
  check(Math.abs(stored * K - 50) < 0.5, 'the character panel shows the requested size: ' + (stored * K));
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 12. 自检不得挑 emoji/符号字体，并要报出可用的字号模式 ---- */
r = tryCall('selftest', {});
check(r.ok && r.parsed.cnFont === 'PingFangSC-Regular', 'selftest skips the emoji face for the CJK role: ' + (r.parsed && r.parsed.cnFont));
check(r.ok && r.parsed.enFont === 'Inter-Regular', 'selftest picks a latin face for the EN role: ' + (r.parsed && r.parsed.enFont));
check(r.ok && r.parsed.steps.indexOf('size=ok') >= 0, 'selftest discovers a working size mode: ' + (r.parsed && r.parsed.sizeMode));
check(r.ok && typeof r.parsed.sizeSteps === 'string' && r.parsed.sizeSteps.length > 0, 'selftest reports each size candidate result');

/* ---- 13. 视觉字距 + 行间距自动（默认开启，可关） ---- */
mainLayer.textItem.autoKerning = 0;
mainLayer.textItem.useAutoLeading = false;
PS.lastAutoLeading = null;
r = tryCall('auto-kerning', { pairedOuterValue: -45 });
check(r.ok && r.parsed.optical === 1 && r.parsed.applied === 1, 'auto-kerning applies OPTICAL and verifies it');
checkEq(mainLayer.textItem.autoKerning, 3, 'AutoKernType.OPTICAL was written to the layer');
check(r.ok && r.parsed.leadingRequested === true, 'leading is requested by default');
check(r.ok && r.parsed.leading === 1 && r.parsed.leadingMode === 'dom', 'leading=Auto written through the DOM and verified');
checkEq(mainLayer.textItem.useAutoLeading, true, 'textItem.useAutoLeading was set');

/* 不勾选 → 完全不碰行间距 */
mainLayer.textItem.autoKerning = 0;
mainLayer.textItem.useAutoLeading = false;
PS.lastAutoLeading = null;
r = tryCall('auto-kerning', { pairedOuterValue: -45, setLeading: false });
check(r.ok && r.parsed.leading === 0 && r.parsed.leadingMode === 'off', 'unchecked option leaves the leading alone');
check(r.ok && r.parsed.leadingRequested === false, 'the panel sees that leading was not requested');
checkEq(mainLayer.textItem.useAutoLeading, false, 'useAutoLeading untouched when unchecked');
check(r.ok && PS.lastAutoLeading !== true, 'no autoLeading reached the descriptor when unchecked');

/* DOM 写入被忽略 → 描述符回退，仍要回读确认 */
mainLayer.textItem.autoKerning = 0;
{
  let leadStored = false;
  Object.defineProperty(mainLayer.textItem, 'useAutoLeading', {
    configurable: true, get: () => leadStored, set: () => { /* 静默忽略 */ },
  });
  PS.lastAutoLeading = null;
  r = tryCall('auto-kerning', { pairedOuterValue: -45, setLeading: true });
  check(r.ok && r.parsed.leading === 1 && r.parsed.leadingMode === 'descriptor', 'leading falls back to the textKey descriptor');
  check(r.ok && PS.lastAutoLeading === true, 'autoLeading really went into the written style');
  check(mainLayer.textItem._state.ranges.some((x) => x.style.store.get(id('autoLeading')) === true),
    'the layer state has autoLeading after the fallback');
  delete mainLayer.textItem.useAutoLeading;
}

/* ============================================================   13. syncColor: optional colour sync for the font mixer   Default off -> only fonts/sizes are written; the original colors   arrive untouched via the copied base style. On -> per-side colors   are applied. The whole-layer DOM fallback honours the switch too.   ============================================================ */function rangeColors(wr) {  return wr.map((x) => (x.style.hasKey(id('color')) ? [x.style.store.get(id('color')).store.get(id('red')), x.style.store.get(id('color')).store.get(id('blue'))] : null));}/* on: colors are written per side */mainLayer.textItem._state.ranges = [{ from: 0, to: 8, style: styleOf('Inter-Regular', 24, [0.1, 0.2, 0.3]) }];r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, syncColor: true, cnColor: { r: 1, g: 0, b: 0 }, enColor: { r: 0, g: 0, b: 1 } });check(r.ok && r.parsed.ok === 1, 'syncColor on: apply succeeds');checkEq(r.parsed.path, 'canonical', 'syncColor on: canonical path');{  const cs = rangeColors(mainLayer.textItem._state.ranges);  check(cs[0] !== null && cs[0][1] > 0.9, 'syncColor on: EN range got blue');  check(cs[1] !== null && cs[1][0] > 0.9, 'syncColor on: CN range got red');}/* omitted (legacy panel/legacy scheme semantics): original colors kept */mainLayer.textItem._state.ranges = [{ from: 0, to: 8, style: styleOf('Inter-Regular', 24, [0.1, 0.2, 0.3]) }];r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, cnSize: 30, enSize: 30 });check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'canonical', 'syncColor omitted (legacy): apply succeeds');{  const cs = rangeColors(mainLayer.textItem._state.ranges);  check(cs.length === 2 && cs.every((c) => c && c[0] === 0.1 && c[1] === 0.3), 'syncColor omitted: original colors kept: ' + JSON.stringify(cs));}/* explicitly off: same semantics */mainLayer.textItem._state.ranges = [{ from: 0, to: 8, style: styleOf('Inter-Regular', 24, [0.1, 0.2, 0.3]) }];r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, syncColor: false });check(r.ok && r.parsed.ok === 1, 'syncColor false: apply succeeds');{  const cs = rangeColors(mainLayer.textItem._state.ranges);  check(cs.every((c) => c && c[0] === 0.1 && c[1] === 0.3), 'syncColor false: original colors kept everywhere: ' + JSON.stringify(cs));}/* the whole-layer DOM fallback must also honour the switch */PS.throwOnSet = 'the command Set is not currently available';const noColLayer = makeLayer('nocolor fallback layer', [{ from: 0, to: 8, style: styleOf('Inter-Regular', 18, [0.1, 0.2, 0.3]) }]);noColLayer.textItem.contents = 'Mix 24H';mainDoc.activeLayers = [noColLayer];mainDoc.activeLayer = noColLayer;const colorBefore = noColLayer.textItem.color;r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, syncColor: false });check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'dom-fallback', 'fallback honors syncColor: dom path taken');check(noColLayer.textItem.color === colorBefore, 'fallback with syncColor off never touches textItem.color');/* and with syncColor ON the fallback does set it */const colLayer = makeLayer('color fallback layer', [{ from: 0, to: 8, style: styleOf('Inter-Regular', 18, [0.1, 0.2, 0.3]) }]);colLayer.textItem.contents = '混排 24H';mainDoc.activeLayers = [colLayer];mainDoc.activeLayer = colLayer;r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' }, syncColor: true, cnColor: { r: 1, g: 0, b: 0 }, enColor: { r: 0, g: 0, b: 0 } });check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'dom-fallback', 'fallback with syncColor on: dom path taken');check(colLayer.textItem.color && colLayer.textItem.color.rgb && colLayer.textItem.color.rgb.red === 255, 'fallback with syncColor on sets textItem.color');PS.throwOnSet = null;
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 14. baseline preservation: superscript must not leak across pieces ---- */
{
  const supLayer = makeLayer('sup layer', []);
  supLayer.textItem._state.text = 'x2ab';
  const normalStyle = styleOf('Inter-Regular', 18, [0, 0, 0]);
  normalStyle.store.set(id('baselineDirection'), 'baseline');
  const supStyle = styleOf('Inter-Regular', 18, [0, 0, 0]);
  supStyle.store.set(id('baselineDirection'), 'superscript');
  supLayer.textItem._state.ranges = [
    { from: 0, to: 1, style: normalStyle },
    { from: 1, to: 2, style: supStyle },     // the '2' is superscript
    { from: 2, to: 4, style: normalStyle },
  ];
  mainDoc.activeLayers = [supLayer];
  mainDoc.activeLayer = supLayer;
  r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
  check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'canonical', 'superscript layer: canonical apply ok');
  const wr = supLayer.textItem._state.ranges;
  const dirAt = (k) => { for (const t of wr) if (k >= t.from && k < t.to) return t.style.store.get(id('baselineDirection')); return null; };
  checkEq(dirAt(0), 'baseline', 'superscript: index 0 keeps baseline');
  checkEq(dirAt(1), 'superscript', 'superscript: the 2 keeps superscript');
  checkEq(dirAt(2), 'baseline', 'superscript: text AFTER the sup is NOT superscript');
  checkEq(dirAt(3), 'baseline', 'superscript: tail keeps baseline');
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 15. multi-selection: targetLayers drives, every text layer gets the mix ---- */
{
  const l2 = makeLayer('second text layer', [{ from: 0, to: 4, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
  l2.textItem._state.text = 'ABcd';
  PS.targetLayerIds = [mainLayer.id, l2.id];   // true multi-selection (AM path)
  r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
  if (!(r.ok && r.parsed.ok === 2 && r.parsed.total === 2)) console.log('MULTI DEBUG', JSON.stringify(r.parsed).slice(0, 400));
check(r.ok && r.parsed.ok === 2 && r.parsed.total === 2, 'multi-select: both layers applied');
  checkEq(r.parsed.source, 'targetLayers', 'multi-select: used the AM targetLayers path');
  checkEq(l2.textItem._state.ranges[0].style.getString(id('fontPostScriptName')), 'Inter-Regular', 'multi-select: second layer got the mix too');
  PS.targetLayerIds = null;
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 15b. multi-selection with INDEX-form references (PS 20/21 quirk) ----
   getIdentifier() throws on every entry; the host must resolve indexes
   through the DOM stack (mainLayer is bottom -> AM idx 1, l2 -> idx 2). */
{
  const l2 = makeLayer('second text layer idx', [{ from: 0, to: 4, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
  l2.textItem._state.text = 'ABcd';
  mainDoc.layers = [mainLayer, l2];   // DOM stack order = AM index order
  PS.targetLayerIds = [mainLayer.id, l2.id];
  PS.targetLayerIdx = [1, 2];          // index-form: bottom = 1
  r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
  if (!(r.ok && r.parsed.ok === 2 && r.parsed.total === 2)) console.log('MULTI-IDX DEBUG', JSON.stringify(r.parsed).slice(0, 400));
  check(r.ok && r.parsed.ok === 2 && r.parsed.total === 2, 'multi-select (index refs): both layers applied');
  checkEq(r.parsed.source, 'targetLayers', 'multi-select (index refs): still the AM path');
  checkEq(l2.textItem._state.ranges[0].style.getString(id('fontPostScriptName')), 'Inter-Regular', 'multi-select (index refs): second layer got the mix');
  PS.targetLayerIdx = null;
  PS.targetLayerIds = null;
  mainDoc.layers = [mainLayer];
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 16. roman numerals default to the Chinese font (substitution regression) ---- */
{
  const rnLayer = makeLayer('roman layer', [{ from: 0, to: 7, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
  rnLayer.textItem._state.text = '\u246324H\u2160';   // circled 4 + latin + roman I
  mainDoc.activeLayers = [rnLayer];
  mainDoc.activeLayer = rnLayer;
  r = tryCall('font-mixer', { cnFont: { family: 'PingFang SC', style: 'Bold' }, enFont: { family: 'Inter', style: 'Regular' } });
  check(r.ok && r.parsed.ok === 1, 'roman numerals: apply ok');
  check(r.parsed.substituted.length === 0, 'roman numerals: no substitution (they ride with the CN font now)');
  const wrn = rnLayer.textItem._state.ranges;
  const fontAt2 = (k) => { for (const t of wrn) if (k >= t.from && k < t.to) return t.style.getString(id('fontPostScriptName')); return null; };
  // ④ (U+2463) is a larger circled form: per spec MD §4 only I..XII roman and
  // ①-⑳ 0x2460-0x2473 stay CN; beyond that = EN (conservative strategy).
  checkEq(fontAt2(0), 'Inter-Regular', 'circled ④ beyond ⑳ stays EN font (spec §4)');
  checkEq(fontAt2(4), 'PingFangSC-Bold', 'roman I gets CN font');
  checkEq(fontAt2(1), 'Inter-Regular', 'latin 24H stays EN font');
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;

/* ---- 17. multi-line text: every line gets fonts/sizes/colours ----
   Style ranges cover the whole char stream INCLUDING newlines, so line
   breaks must not create pointless splits (or worse, unassigned chars). */
{
  const ml = makeLayer('multi-line layer', [{ from: 0, to: 13, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }]);
  ml.textItem._state.text = '\u4e70\u5c31\u9001\nBuy\n\u4e70\u5c31\u9001';   // CN / EN / CN lines
  const n = ml.textItem._state.text.length;
  ml.textItem._state.ranges = [{ from: 0, to: n, style: styleOf('Inter-Regular', 18, [0, 0, 0]) }];
  mainDoc.activeLayers = [ml];
  mainDoc.activeLayer = ml;
  r = tryCall('font-mixer', {
    cnFont: { family: 'PingFang SC', style: 'Bold' },
    enFont: { family: 'Inter', style: 'Regular' },
    cnSize: 40, enSize: 20,
    cnColor: { r: 1, g: 0, b: 0 }, enColor: { r: 0, g: 0, b: 1 },
    syncColor: true,
  });
  check(r.ok && r.parsed.ok === 1 && r.parsed.path === 'canonical', 'multi-line: apply runs canonical');
  const wml = ml.textItem._state.ranges;
  const fml = (k) => { for (const t of wml) if (k >= t.from && k < t.to) return t; return null; };
  // text: 买0 就1 送2 \n3 B4 u5 y6 \n7 买8 就9 送10 \n11 ... wait: 4+1+3+1+4 = 13
  // indices: CN 0-3, \n 3, EN 4-7, \n 7, CN 8-12 -> newline rides with previous side
  checkEq(fml(0) && fml(0).style.getString(id('fontPostScriptName')), 'PingFangSC-Bold', 'multi-line: line1 CN font');
  checkEq(fml(3) && fml(3).style.getString(id('fontPostScriptName')), 'PingFangSC-Bold', 'multi-line: newline rides with line1 side');
  checkEq(fml(5) && fml(5).style.getString(id('fontPostScriptName')), 'Inter-Regular', 'multi-line: line2 EN font');
  checkEq(fml(7) && fml(7).style.getString(id('fontPostScriptName')), 'Inter-Regular', 'multi-line: newline rides with line2 side');
  checkEq(fml(9) && fml(9).style.getString(id('fontPostScriptName')), 'PingFangSC-Bold', 'multi-line: line3 CN font');
  checkEq(fml(0) && String(fml(0).style.store.get(id('size'))), '40', 'multi-line: CN size applied');
  checkEq(fml(5) && String(fml(5).style.store.get(id('size'))), '20', 'multi-line: EN size applied');
  const c0 = fml(0) && fml(0).style.store.get(id('color'));
  const c5 = fml(5) && fml(5).style.store.get(id('color'));
  check(c0 && c5 && c0 !== c5, 'multi-line: colours applied per side');
  let mCov = 0, mTiling = true;
  for (const t of wml) { if (t.from !== mCov) mTiling = false; mCov = t.to; }
  check(mTiling && mCov === n, 'multi-line: ranges tile the whole text incl. newlines');
}
mainDoc.activeLayers = [mainLayer];
mainDoc.activeLayer = mainLayer;
console.log('\n' + (fails === 0 ? 'ALL HOST CHECKS PASSED' : fails + ' HOST CHECK(S) FAILED'));
process.exit(fails === 0 ? 0 : 1);



console.log('\n' + (fails === 0 ? 'ALL HOST CHECKS PASSED' : fails + ' HOST CHECK(S) FAILED'));
process.exit(fails === 0 ? 0 : 1);
