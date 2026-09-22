/* 专项测试：视觉字距（AutoKernType.OPTICAL）/ 环境自报 / 官方拾色器签名 /
   图层来源回退 / 「旧的失败描述符形状」回归守卫
   用迷你 Photoshop 模型当桩，验证 host.jsx 的真实行为。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const hostPath = path.join(__dirname, '..', 'com.figmatoolbox.ps', 'jsx', 'host.jsx');
const src = fs.readFileSync(hostPath, 'utf8');

let fails = 0;
const check = (ok, label, ev) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ev ? '   [' + String(ev).slice(0, 120) + ']' : ''));
  if (!ok) fails++;
};

/* ---------- 迷你 Action Manager + 文本模型 ---------- */
const ids = new Map();
let nextId = 500;
const id = (k) => { if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };

class FakeList {
  constructor(items) { this.items = items || []; }
  get count() { return this.items.length; }
  getObjectValue(i) { return this.items[i]; }
  putObject(cls, item) { this.items.push(item === undefined ? cls : item); }
  putInteger(cls, v) { this.items.push(v); }
}
class FakeDesc {
  constructor(store) { this.store = store || new Map(); }
  putDouble(k, v) { this.store.set(k, v); }
  putInteger(k, v) { this.store.set(k, v); }
  putString(k, v) { this.store.set(k, v); }
  putBoolean(k, v) { this.store.set(k, v); }
  putUnitDouble(k, u, v) { this.store.set(k, v); }
  putObject(k, cls, o) { this.store.set(k, o === undefined ? cls : o); }
  putReference(k, r) { this.store.set(k, r); }
  putEnumerated(k, c, v) { this.store.set(k, v); }
  putList(k, l) { this.store.set(k, l); }
  hasKey(k) { return this.store.has(k); }
  erase(k) { this.store.delete(k); }
  getString(k) { return this.store.get(k); }
  getInteger(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not integer'); return v; }
  getDouble(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not double'); return v; }
  getUnitDoubleValue(k) { const v = this.store.get(k); if (typeof v !== 'number') throw new Error('not unit double'); return v; }
  getObjectValue(k) { const v = this.store.get(k); if (!(v instanceof FakeDesc)) throw new Error('not object'); return v; }
  getList(k) { const v = this.store.get(k); if (!(v instanceof FakeList)) throw new Error('not list'); return v; }
  toStream() { return cloneVal(this); }
  fromStream(s) { this.store = cloneVal(s).store; }
}
class FakeRef {
  constructor() { this.identifierKey = null; this.identifierValue = null; this.property = null; }
  putProperty(k1, k2) { this.property = k2; }
  putIdentifier(k, v) { this.identifierKey = k; this.identifierValue = v; }
  putIndex(k, i) { this.identifierKey = k; this.identifierValue = i; }
  putEnumerated() { }
}
function cloneVal(v) {
  if (v instanceof FakeDesc) { const m = new Map(); v.store.forEach((val, k) => m.set(k, cloneVal(val))); return new FakeDesc(m); }
  if (v instanceof FakeList) return new FakeList(v.items.map(cloneVal));
  return v;
}

const FONTS = [
  { family: 'PingFang SC', style: 'Regular', postScriptName: 'PingFangSC-Regular' },
  { family: 'Inter', style: 'Regular', postScriptName: 'Inter-Regular' },
];
function styleOf(ps, size) {
  return new FakeDesc(new Map([
    [id('fontPostScriptName'), ps],
    [id('size'), size === undefined ? 12 : size],
    [id('tracking'), 0],
  ]));
}
function rangeOf(from, to, style) {
  return new FakeDesc(new Map([[id('from'), from], [id('to'), to], [id('textStyle'), style]]));
}
const PS = { keys: new Map(), sets: 0 };
let nextLayerId = 700;
function makeLayer(contents) {
  const st = { text: contents, ranges: [{ from: 0, to: contents.length, style: styleOf('Inter-Regular') }] };
  const layerId = nextLayerId++;
  PS.keys.set(layerId, st);
  const layer = { id: layerId, itemIndex: 3, typename: 'ArtLayer', name: 'l', kind: 2 };
  layer.textItem = {
    get contents() { return st.text; },
    set contents(v) { st.text = v; st.ranges = [{ from: 0, to: v.length, style: st.ranges[0].style }]; },
    get font() { return st.ranges[0].style.getString(id('fontPostScriptName')); },
    set font(ps) { st.ranges.forEach((r) => r.style.store.set(id('fontPostScriptName'), ps)); },
    autoKerning: 0,
    size: 0,
    color: null,
  };
  return layer;
}
function executeActionGet(ref) {
  const isTextKeyRead = (ref instanceof FakeRef) && ref.property === id('textKey') && ref.identifierKey === id('layer');
  if (!isTextKeyRead) throw new Error('unsupported reference');
  const st = PS.keys.get(ref.identifierValue);
  if (!st) throw new Error('no textKey');
  const ranges = st.ranges.map((rr) => rangeOf(rr.from, rr.to, cloneVal(rr.style)));
  const tk = new FakeDesc(new Map([
    [id('textKey'), st.text],
    [id('textStyleRange'), new FakeList(ranges)],
  ]));
  return new FakeDesc(new Map([[id('textKey'), tk]]));
}
function executeAction(action, desc) {
  if (action !== id('set')) throw new Error('unsupported action');
  PS.sets++;
  const ref = desc.store.get(id('null'));
  const tk = desc.store.get(id('to'));
  const st = PS.keys.get(ref.identifierValue);
  const list = tk.getList(id('textStyleRange'));
  const ranges = [];
  for (let i = 0; i < list.count; i++) {
    const r = list.getObjectValue(i);
    ranges.push({ from: r.getInteger(id('from')), to: r.getInteger(id('to')), style: cloneVal(r.getObjectValue(id('textStyle'))) });
  }
  st.ranges = ranges;
}

const textLayer = makeLayer('hello 世界');
// 真实文本图层是多区间的：拉丁一段、中文一段（否则识别只能拿到单一字体）
textLayer.textItem.contents = 'hello 世界';
const _st = PS.keys.get(textLayer.id);
_st.ranges = [
  { from: 0, to: 6, style: styleOf('Inter-Regular', 18) },
  { from: 6, to: 8, style: styleOf('PingFangSC-Regular', 16) },
];
const stubs = {
  ActionDescriptor: function () { return new FakeDesc(); },
  ActionReference: function () { return new FakeRef(); },
  ActionList: function () { return new FakeList(); },
  executeActionGet,
  executeAction,
  stringIDToTypeID: id,
  charIDToTypeID: id,
  DialogModes: { NO: 3 },
  LayerKind: { TEXT: 2 },
  AutoKernType: { MANUAL: 1, METRICS: 2, OPTICAL: 3 },
  UnitValue: function (v, u) { return { value: v, units: u }; },
  SolidColor: function () { this.rgb = { red: 0, green: 0, blue: 0 }; },
  SaveOptions: { DONOTSAVECHANGES: 2 },
  NewDocumentMode: { RGB: 3 },
  DocumentFill: { TRANSPARENT: 3 },
  app: {
    name: 'Adobe Photoshop', version: '21.2.0',
    fonts: FONTS,
    documents: { length: 1, add() { throw new Error('not used here'); } },
    activeDocument: { name: 'doc.psd', activeLayers: [textLayer], selectedLayers: [textLayer], artLayers: { add() { throw new Error('n/a'); } } },
    activeLayer: textLayer,
    foregroundColor: null,
    showColorPicker: () => false,
  },
  isNaN, isFinite, Math, JSON: undefined,
};
stubs.$ = { global: {}, fileName: 'C:/ext/jsx/host.jsx' };
vm.createContext(stubs);
vm.runInContext(src, stubs, { filename: 'host.jsx' });
const g = stubs.$.global.cephostDispatch;
check(typeof g === 'function', '宿主入口可从 $.global 取到');
const call = (t, a) => { try { return JSON.parse(g(t, a ? encodeURIComponent(JSON.stringify(a)) : '')); } catch (e) { return { __parseError: e.message }; } };

/* ---------- 环境自报 ---------- */
let r = call('diag');
check(r.host && r.host === (src.match(/HOST_VERSION = '([^']+)'/) || [])[1], 'diag 报告的宿主版本与源码一致', r.host);
check(r.ps === 'Adobe Photoshop 21.2.0', 'diag 报告 Photoshop 版本', r.ps);
check(r.layerSource === 'activeLayers' && r.textLayers === 1, 'diag 报告图层来源与文本图层数', r.layerSource + '/' + r.textLayers);
check(r.autoKernType && r.autoKernType.indexOf('ok:OPTICAL=3') === 0, 'diag 确认 AutoKernType.OPTICAL 可用', r.autoKernType);
check(r.showColorPicker === 'function', 'diag 确认 showColorPicker 存在', r.showColorPicker);
check(r.stringIDToTypeID === 'function', 'diag 确认 stringIDToTypeID 存在', r.stringIDToTypeID);

/* ---------- activeLayers 返回 undefined 时不得崩（真机故障点） ---------- */
const goodDoc = stubs.app.activeDocument;
stubs.app.activeDocument = { name: 'doc.psd', activeLayers: undefined, selectedLayers: [textLayer], activeLayer: textLayer };
r = call('sel-sig');
check(r.sig === '7' || r.sig === String(textLayer.id), 'activeLayers 为 undefined 时回退 selectedLayers', JSON.stringify(r));
check(r.from === 'selectedLayers', '回退来源如实回报', r.from);
r = call('detect-font');
check(!r.error && r.empty === false, 'detect-font 在该情况下仍能识别', JSON.stringify(r).slice(0, 90));
check(r.cnFont && r.cnFont.family === 'PingFang SC', '识别出中文字体', JSON.stringify(r.cnFont));
stubs.app.activeDocument = { name: 'doc.psd', activeLayers: undefined, selectedLayers: undefined, activeLayer: textLayer };
r = call('sel-sig');
check(!r.error && r.from === 'activeLayer', '再退一步用 activeLayer', JSON.stringify(r));
stubs.app.activeDocument = goodDoc;

/* ---------- 视觉字距 ---------- */
textLayer.textItem.autoKerning = 0;
r = call('auto-kerning', { pairedOuterValue: -45 });
check(!r.error && r.mode === 'optical' && r.optical === 1, '视觉字距：写入并读回校验通过', JSON.stringify(r));
check(textLayer.textItem.autoKerning === 3, 'textItem.autoKerning 真的被写成 OPTICAL', String(textLayer.textItem.autoKerning));

/* 读回被拒绝（模拟旧版本只读）→ 必须回退符号字距而不是假装成功 */
let stored = 0;
Object.defineProperty(textLayer.textItem, 'autoKerning', {
  configurable: true,
  get: () => stored,
  set: () => { /* 静默忽略写入 */ },
});
textLayer.textItem.contents = '中(文)号';
const setsBefore = PS.sets;
r = call('auto-kerning', { pairedOuterValue: -45 });
check(!r.error && r.optical === 0 && r.tracking === 1 && r.mode === 'tracking', '写入被忽略 → 回退符号字距', JSON.stringify(r));
check(Array.isArray(r.skipped) && r.skipped.length > 0, '回退原因被回传', (r.skipped || []).join(' ; '));
check(PS.sets > setsBefore, '回退路径真的走了文本写入（textKey/set）', PS.sets - setsBefore);
delete textLayer.textItem.autoKerning;

/* 无字距可调时不得算失败 */
stubs.AutoKernType = undefined;
textLayer.textItem.autoKerning = 0;
textLayer.textItem.contents = '中文';
r = call('auto-kerning', {});
check(!r.error && r.applied === 0 && r.failed === 0 && r.mode === 'none', '无字距可调 → mode=none 且不计失败', JSON.stringify(r));
check((r.skipped || []).some((x) => /AutoKernType/.test(x)), '视觉不可用原因被回传', (r.skipped || []).join(' ; '));
stubs.AutoKernType = { MANUAL: 1, METRICS: 2, OPTICAL: 3 };
textLayer.textItem.contents = 'hello 世界';

/* ---------- 官方拾色器签名 ---------- */
const seenArgs = [];
stubs.app.showColorPicker = (flag) => {
  seenArgs.push(flag);
  if (typeof flag !== 'boolean') throw new Error('Illegal argument - parameter 1 - should be boolean');
  stubs.app.foregroundColor = { rgb: { red: 10, green: 20, blue: 30 } };
  return true;
};
r = call('pick-color', { r: 1, g: 1, b: 1 });
check(seenArgs.length === 1 && seenArgs[0] === true, '调用 showColorPicker(true)（官方布尔签名）', JSON.stringify(seenArgs));
check(r.ok === true && r.mode === 'bool', '拾色器回包 mode=bool', JSON.stringify(r).slice(0, 80));
check(Math.round(r.r * 255) === 10 && Math.round(r.g * 255) === 20 && Math.round(r.b * 255) === 30, '结果从前景色读回', r.r + ',' + r.g + ',' + r.b);

stubs.app.showColorPicker = () => false;
r = call('pick-color', { r: 0, g: 0, b: 0 });
check(r.ok === false, '取消返回 ok:false');

stubs.app.showColorPicker = (a) => {
  if (typeof a === 'boolean') throw new Error('Illegal argument - parameter 1 - should be SolidColor');
  stubs.app.foregroundColor = a;
  a.rgb.red = 200;
  return true;
};
r = call('pick-color', { r: 0.5, g: 0.5, b: 0.5 });
check(r.ok === true && r.mode === 'solid', '布尔签名失败 → 回退 SolidColor 签名', JSON.stringify(r).slice(0, 80));
check(/should be SolidColor/.test(r.notes || ''), '每个候选签名的失败原因被记录', (r.notes || '').slice(0, 60));

/* ---------- 回归守卫：旧的失败形状不得复活（只看代码，不看注释） ---------- */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
check(!/putIndex\(/.test(codeOnly), '不再使用 putIndex 索引引用（真机报 Set 不可用）');
check(!/Tckn/.test(codeOnly), "不再使用 'Tckn' 作为区间结束键");
check(!/putEnumerated\(S\('T   '\)/.test(codeOnly), "不再用 'T   ' Ordn:Styl 目标形状");
check(!/APPEND_FORMS|appendMode|appendForm/.test(codeOnly), '追加形式发现机制已整体移除');
check(/putProperty\(S\('property'\), S\('textKey'\)\)/.test(src), '读取走 property/textKey');
check(/putIdentifier\(S\('layer'\), layerId\)/.test(src), '读取用 layer 标识符');
check(/putIdentifier\(S\('textLayer'\), layerId\)/.test(src), '写入用 textLayer 标识符');
check(/putObject\(S\('to'\), S\('textLayer'\), tk\)/.test(src), "写入形状为 'to': 'textLayer': 整份 textKey");
check(/hasKey\(tk, 'engineData'\)/.test(src), 'engineData 会被丢弃');

/* ---------- 错误回包必须带定位信息（静态确认） ---------- */
check(/api: type, stage: _stage, line: e\.line/.test(src), '错误回包带 api/stage/line（便于精确定位）');
check(/stage\('layer ' /.test(src), '关键路径有 stage 标记');

console.log(fails === 0 ? '\nALL OPTICAL/PICKER CHECKS PASSED' : '\n' + fails + ' CHECK(S) FAILED');
process.exit(fails === 0 ? 0 : 1);
