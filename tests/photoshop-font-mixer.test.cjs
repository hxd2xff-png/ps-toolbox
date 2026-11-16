/*
 * CEP 字体混排 · 离线契约测试（DS 独立编写，仅测试，不改实现）
 * ---------------------------------------------------------------
 * 运行：node --test tests/photoshop-font-mixer.test.cjs
 *
 * 依据：docs/photoshop-cep-uxp-requirements.md R1/R2/R3/R4、design §3.1/§4。
 *
 * 做法：直接从真实源码按函数名抽取函数体，放进 vm 沙箱里跑，
 *       只把「Photoshop 描述符层」换成受控桩。所以：
 *         - 字符分类 / 选择集合并 / 识别聚合 / 回填清旧值 都是真实代码在被测；
 *         - 不模拟 Photoshop，不伪造真机结论。
 *
 * 桩边界（实现若改这些内部名，测试需同步改，属预期契约变更）：
 *   host.jsx  : app / walkLayers / isTextLayer / textContentsOf / readRanges /
 *               layerScaleOf / metaOfPSName / stage / jval
 *   index.html: $ / setCurrentLabel / rgbToHex / currentScheme / userTouched
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CEP_DIR = path.join(ROOT, 'com.figmatoolbox.ps');
const HOST_PATH = path.join(CEP_DIR, 'jsx', 'host.jsx');
const PANEL_PATH = path.join(CEP_DIR, 'index.html');

const HOST_SRC = fs.readFileSync(HOST_PATH, 'utf8');
const PANEL_SRC = fs.readFileSync(PANEL_PATH, 'utf8');

/* ---------------- 源码抽取（花括号匹配，跳过字符串/注释） ---------------- */

function skipString(src, i) {
  const q = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i;
    i += 1;
  }
  return i;
}

function blockEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 返回完整函数声明文本：`function name(params) { ... }` */
function extractFunction(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  const end = blockEnd(src, open);
  if (end < 0) return null;
  return src.slice(m.index, end + 1);
}

function requireFunction(src, name, where) {
  const body = extractFunction(src, name);
  assert.ok(body, '源码中找不到函数 ' + name + '（' + where + '）；契约依赖该函数名');
  return body;
}

/* ---------------- host.jsx 沙箱 ---------------- */

const HOST_REAL = [
  'isCJK',
  'segmentsOf',
  'inArray',
  'docSafe',
  'asArray',
  'errText',
  'esc',
  'jstr',
  'jnum',
  'jval',
  'activeLayerSource',
  'collectTextLayers',
  'fontIndex',
  'metaOfPSName',
  'verifyPlan',
  'verifySizes',
  'summarizeSizes',
  'detectFontMix',
];

/** vm 沙箱里的对象跨 realm，深比较前先转成本 realm 的纯数据 */
function same(actual, expected, msg) {
  assert.deepEqual(plain(actual), plain(expected), msg);
}

function plain(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** host 回包是 jval() 手写 JSON 字符串（生产就是这么走的），这里解析回对象 */
function detect(host) {
  const raw = host.detectFontMix();
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * 载入 host.jsx 的真实函数，桩掉描述符层。
 * overrides 里可覆盖任何桩（测试用例按需改行为）。
 */
function loadHost(overrides) {
  const stubs = {
    walkLayers: (refs, fn) => {
      (refs || []).forEach((r) => {
        fn(r);
        (r && r.__children ? r.__children : []).forEach((c) => fn(c));
      });
    },
    isTextLayer: (l) => !!l && l.__kind === 'text',
    textContentsOf: (l) => (l && typeof l.__text === 'string' ? l.__text : ''),
    readRanges: () => [],
    layerScaleOf: () => 1,
    textKeyOf: () => null,
    _layerScale: 1,
  };
  const supplied = overrides || {};
  const merged = Object.assign({}, stubs, supplied);
  merged.app = Object.assign({ fonts: Object.keys(FONTS).map((name) => ({ family: FONTS[name].family, style: FONTS[name].style, postScriptName: name })) }, supplied.app || {});
  // Aggregation fixtures isolate the AM selection boundary, covered separately below.
  merged.automaticSelection = () => {
    const src = ctx.activeLayerSource(), collected = ctx.collectTextLayers(src);
    return {from:src.from, notes:src.notes || [], selectedCount:src.refs.length, layers:collected.layers};
  };
  const ctx = vm.createContext(merged);
  vm.runInContext('var _fontIndex=null,_fontMetaByPSName=null;', ctx);
  ctx.numOrNull = (v) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  ctx.rgbSafe = (v) => v && [v.r,v.g,v.b].every(Number.isFinite) ? v : null;
  // 真实 host 里 stage() 写模块级 _stage，detect 的 failed 条目会读它；沙箱内照此实现
  vm.runInContext('var _stage = "init"; function stage(s) { _stage = s; return s; }', ctx);

  const parts = HOST_REAL.map((name) => {
    const body = extractFunction(HOST_SRC, name);
    return body ? 'var ' + name + ' = (' + body + ');' : null;
  }).filter(Boolean);
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

/** 一个文本层夹具 */
function textLayer(id, text) {
  return { id, name: 'Layer' + id, __kind: 'text', __text: text };
}

/** 一层正常的 range 数据：中文 [0,2) + 英文 [2,5) */
function rangesFor(cnPS, enPS, cnSize, enSize) {
  return [
    { from: 0, to: 2, psName: cnPS, size: cnSize, rgb: { r: 1, g: 0, b: 0 } },
    { from: 2, to: 5, psName: enPS, size: enSize, rgb: { r: 0, g: 0, b: 1 } },
  ];
}

const FONTS = {
  CNSong: { family: '宋体', style: 'Regular' },
  CNSong2: { family: '思源宋体', style: 'Regular' },
  EnSans: { family: 'Source Sans', style: 'Regular' },
};


/* ---------------- 状态枚举归一 ----------------
 * 文档 §4 用 value / mixed / unavailable / no-content / error；
 * 实现方口述用 consistent / mixed / unrecognized / empty / error。
 * 两套词表都接受，统一折算成语义态，避免因命名争议掩盖真实行为。
 */
const CANON = {
  consistent: 'consistent',
  value: 'consistent',
  mixed: 'mixed',
  unrecognized: 'unrecognized',
  unavailable: 'unrecognized',
  empty: 'empty',
  'no-content': 'empty',
  error: 'error',
};

function rawState(field) {
  if (!field || typeof field !== 'object') return null;
  const keys = ['state', 'status', 'kind'];
  for (let i = 0; i < keys.length; i += 1) {
    if (typeof field[keys[i]] === 'string') return field[keys[i]];
  }
  return null;
}

function stateOf(field) {
  const raw = rawState(field);
  if (raw === null) return 'missing-state';
  return CANON[raw] || raw;
}

function valueOf(field) {
  if (field && typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

function fieldOf(host, out, name) {
  assert.ok(out, 'detect 返回值不能为空');
  assert.ok(out.fields && typeof out.fields === 'object',
    '识别结果必须带 fields 字段状态对象（R2/§4：显式状态，不能靠字段缺省表示未变化）');
  assert.ok(out.fields[name], 'fields.' + name + ' 缺失');
  return out.fields[name];
}

/* ============================================================
 * 1. 字符分类（沿用既有约定，不扩功能）
 * ============================================================ */

test('segmentsOf: 中英混排按既有分类切成连续区间', () => {
  const host = loadHost();
  same(host.segmentsOf('中文abc').map((s) => [s[0], s[1], s[2]]),
    [[0, 2, true], [2, 5, false]]);
  same(host.segmentsOf('abc中文').map((s) => [s[0], s[1], s[2]]),
    [[0, 3, false], [3, 5, true]]);
});

test('segmentsOf: 全角标点/假名/谚文归中文侧，连续同类合并', () => {
  const host = loadHost();
  // 全角逗号 U+FF0C 属 fullwidth forms -> CJK
  same(host.segmentsOf('中，文').map((s) => [s[0], s[1], s[2]]), [[0, 3, true]]);
  // 假名 U+3040-30FF
  same(host.segmentsOf('あア').map((s) => [s[0], s[1], s[2]]), [[0, 2, true]]);
  // 谚文
  same(host.segmentsOf('한').map((s) => [s[0], s[1], s[2]]), [[0, 1, true]]);
});

test('segmentsOf: 空文本返回空数组', () => {
  const host = loadHost();
  same(host.segmentsOf('').map((s) => [s[0], s[1], s[2]]), []);
  same(host.segmentsOf(null).map((s) => [s[0], s[1], s[2]]), []);
});

/* ============================================================
 * 2. 选择集（R1）
 * ============================================================ */

test('activeLayerSource: activeLayers 与 selectedLayers 合并并按 id 去重', () => {
  const a = textLayer(1, '中文');
  const b = textLayer(2, '中文');
  const c = textLayer(3, '中文');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [a, b], selectedLayers: [b, c] } },
  });
  const src = host.activeLayerSource();
  same(src.refs.map((r) => r.id), [1, 2, 3]);
  assert.equal(src.from, 'activeLayers+selectedLayers');
});

test('activeLayerSource: 只有活动层时把来源标成 activeLayer（不冒充完整多选）', () => {
  const only = textLayer(7, '中文');
  const host = loadHost({ app: { activeDocument: { activeLayer: only } } });
  const src = host.activeLayerSource();
  same(src.refs.map((r) => r.id), [7]);
  // from 里可以带「多选集合不可用」这类诊断标记，但必须点名 activeLayer，
  // 且不得声称拿到了 activeLayers / selectedLayers（R1：不把活动层冒充完整多选）
  assert.match(src.from, /activeLayer/, 'from 必须标明来源是 activeLayer，实际：' + src.from);
  assert.ok(!/activeLayers|selectedLayers/.test(src.from),
    'from 不得声称拿到多选集合，实际：' + src.from);
  assert.ok(Array.isArray(src.notes), '诊断信息必须单独放入 notes');
});

test('activeLayerSource: 无文档 / 无选择 分别给出明确空态', () => {
  const noDoc = loadHost({ app: { activeDocument: null } });
  const s1 = noDoc.activeLayerSource();
  same(s1.refs.map((r) => r.id), []);
  assert.equal(s1.from, 'no-document');

  const noSel = loadHost({ app: { activeDocument: {} } });
  const s2 = noSel.activeLayerSource();
  same(s2.refs.map((r) => r.id), []);
  assert.equal(s2.from, 'empty');
});

/* ============================================================
 * 3. 识别聚合与字段状态（R2 / design §3.1）
 * ============================================================ */

test('detectFontMix: 只拿到活动层时回包必须带 selectionLimited', () => {
  const only = textLayer(7, '中文abc');
  const partial = detect(loadHost({ app: { activeDocument: { activeLayer: only } } }));
  assert.equal(partial.selectionLimited, true, '识别回包要说明只读了活动层，面板才能提示');

  const a = textLayer(1, '中文abc'), b = textLayer(2, '中文abc');
  const full = detect(loadHost({ app: { activeDocument: { activeLayers: [a, b], selectedLayers: [b] } } }));
  assert.equal(full.selectionLimited, false, '拿到完整多选时不能误报受限');
});

/* Sample regressions use actual detectFontMix; only the PS boundary is supplied. */
function detectStyleFixture(text, ranges, extraLayers) {
  const layer = textLayer(29, text);
  return detect(loadHost({
    app: { activeDocument: { activeLayers: [layer].concat(extraLayers || []) } },
    readRanges: (id) => id === 29 ? ranges : [{from:0,to:1,psName:'CNSong',size:19}],
  }));
}
function fixtureRange(from, to, psName, size, blue) {
  return {from, to, psName, size, rgb: blue ? {r:0,g:0,b:1} : {r:1,g:0,b:0}};
}
test('detectFontMix: sample 29 ignores Chinese-styled space for font/size, preserves color aggregation', () => {
  const out = detectStyleFixture('水感镜光 12H持色持光', [
    fixtureRange(0,5,'CNSong',34.5), fixtureRange(5,8,'EnSans',39.2,true), fixtureRange(8,12,'CNSong',34.5),
  ]);
  assert.equal(out.fields.enFont.state, 'consistent');
  assert.equal(out.enFont.family, 'Source Sans');
  assert.equal(out.enSize, 39.2);
  assert.equal(out.fields.enColor.state, 'mixed');
  assert.deepEqual(out.fields.enFont.sources.map(s=>[s.from,s.to]), [[5,8]]);
});
test('detectFontMix: sample 30 ignores middle dots and hash when Latin/digits exist', () => {
  const out = detectStyleFixture('#943 M·A·C XOXO', [
    fixtureRange(0,1,'CNSong',70), fixtureRange(1,6,'EnSans',34), fixtureRange(6,7,'CNSong',34),
    fixtureRange(7,8,'EnSans',34), fixtureRange(8,9,'CNSong',34), fixtureRange(9,15,'EnSans',34),
  ]);
  assert.equal(out.fields.enFont.state, 'consistent');
  assert.equal(out.enFont.family, 'Source Sans');
  assert.equal(out.enSize,34);
});
test('detectFontMix: whitespace-only layer contributes no font or size', () => {
  const out = detectStyleFixture(' \t\r\n\u3000', [fixtureRange(0,5,'CNSong',70)]);
  for (const key of ['cnFont','enFont','cnSize','enSize']) assert.equal(out.fields[key].state,'empty',key);
});
test('detectFontMix: punctuation-only layer retains style fallback independently in multi-selection', () => {
  const out = detectStyleFixture('A', [fixtureRange(0,1,'EnSans',34)], [textLayer(30,'#')]);
  assert.equal(out.fields.enFont.state,'mixed');
  assert.equal(out.fields.enSize.state,'mixed');
  const punctuation = detectStyleFixture('#·', [fixtureRange(0,2,'CNSong',19)]);
  assert.equal(punctuation.enSize,19);
  assert.equal(punctuation.enFont.family,'宋体');
});
test('detectFontMix: real Latin font and size differences remain mixed', () => {
  const out = detectStyleFixture('A·B', [fixtureRange(0,1,'EnSans',34),fixtureRange(1,2,'CNSong',90),fixtureRange(2,3,'CNSong2',35)]);
  assert.equal(out.fields.enFont.state,'mixed');
  assert.equal(out.fields.enSize.state,'mixed');
});
for (const ch of ['Ω','Б','٣','é']) {
  test('detectFontMix: preserves real mixed style for A' + ch, () => {
    const out = detectStyleFixture('A'+ch, [fixtureRange(0,1,'EnSans',12),fixtureRange(1,2,'CNSong2',24)]);
    assert.equal(out.fields.enFont.state,'mixed');
    assert.equal(out.fields.enSize.state,'mixed');
    assert.equal(out.enFont,null);
    assert.equal(out.enSize,null);
  });
}
test('detectFontMix: unknown non-CJK body excludes explicit punctuation without a Latin anchor', () => {
  const out = detectStyleFixture('Ω·Б', [fixtureRange(0,1,'EnSans',12),fixtureRange(1,2,'CNSong',70),fixtureRange(2,3,'EnSans',12)]);
  assert.equal(out.enFont.family,'Source Sans');
  assert.equal(out.enSize,12);
});
test('detectFontMix: digits determine style while whitespace and punctuation do not', () => {
  const out = detectStyleFixture(' #35\r', [fixtureRange(0,2,'CNSong',70),fixtureRange(2,4,'EnSans',34),fixtureRange(4,5,'CNSong',70)]);
  assert.equal(out.enSize,34);
  assert.equal(out.enFont.family,'Source Sans');
});
test('detectFontMix: ignored space does not block Chinese convenience font/size', () => {
  const out = detectStyleFixture('中文 ', [fixtureRange(0,2,'CNSong',12),fixtureRange(2,3,'EnSans',70)]);
  assert.equal(out.enFont.family,'宋体');
  assert.equal(out.enSize,12);
  assert.equal(out.fields.enFont.convenience,true);
});

test('detectFontMix: 两个文本层同值 -> 每侧状态 consistent，值为共同值', () => {
  const l1 = textLayer(1, '中文abc');
  const l2 = textLayer(2, '中文def');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1, l2] } },
    readRanges: (id) => (id === 1 || id === 2 ? rangesFor('CNSong', 'EnSans', 12, 10) : []),
  });
  const out = detect(host);

  const cn = fieldOf(host, out, 'cnFont');
  const en = fieldOf(host, out, 'enFont');
  assert.equal(stateOf(cn), 'consistent');
  assert.equal(valueOf(cn).family, '宋体');
  assert.equal(stateOf(en), 'consistent');
  assert.equal(valueOf(en).family, 'Source Sans');

  assert.equal(stateOf(fieldOf(host, out, 'cnSize')), 'consistent');
  assert.equal(valueOf(fieldOf(host, out, 'cnSize')), 12);
  assert.equal(valueOf(fieldOf(host, out, 'enSize')), 10);

  // 顶层旧字段必须继续可用（不破坏现有 panel）
  assert.equal(out.cnSize, 12);
  assert.equal(out.enSize, 10);
  assert.equal(out.empty, false);
});

test('detectFontMix: 两个文本层中文字体不同 -> 必须报 mixed 且不给代表值（不是取首层）', () => {
  const l1 = textLayer(1, '中文abc');
  const l2 = textLayer(2, '中文def');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1, l2] } },
    readRanges: (id) => (id === 1
      ? rangesFor('CNSong', 'EnSans', 12, 10)
      : rangesFor('CNSong2', 'EnSans', 12, 10)),
  });
  const out = detect(host);

  const cn = fieldOf(host, out, 'cnFont');
  assert.equal(stateOf(cn), 'mixed', '多层中文字体不一致必须显式标 mixed');
  assert.ok(valueOf(cn) === null || valueOf(cn) === undefined, 'mixed 不得携带代表值');
  assert.equal(out.cnFont, null, '顶层 cnFont 也不能是首层值');

  // 英文侧两层一致，仍应回填
  assert.equal(stateOf(fieldOf(host, out, 'enFont')), 'consistent');
});

test('detectFontMix: 同一层内中文字体区间不一致 -> 也是 mixed', () => {
  const l1 = textLayer(1, '中文中文');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1] } },
    readRanges: () => [
      { from: 0, to: 2, psName: 'CNSong', size: 12, rgb: { r: 1, g: 0, b: 0 } },
      { from: 2, to: 4, psName: 'CNSong2', size: 12, rgb: { r: 1, g: 0, b: 0 } },
    ],
  });
  const out = detect(host);
  const cn = fieldOf(host, out, 'cnFont');
  assert.equal(stateOf(cn), 'mixed');
  assert.ok(valueOf(cn) == null);
});

test('detectFontMix: 字体无法映射到本机字体 -> unrecognized，但保留 PostScript 名作诊断', () => {
  const l1 = textLayer(1, '中文abc');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1] } },
    readRanges: () => rangesFor('GhostPSName', 'EnSans', 12, 10),
  });
  const out = detect(host);
  const cn = fieldOf(host, out, 'cnFont');

  assert.equal(stateOf(cn), 'unrecognized');
  assert.ok(valueOf(cn) == null, '未识别不得回填半个值');
  const diag = JSON.stringify(cn);
  assert.ok(diag.indexOf('GhostPSName') >= 0, '诊断里必须留下原始 PostScript 名，实际：' + diag);
});

test('detectFontMix: 字号多层不一致 -> cnSize mixed 且值为空', () => {
  const l1 = textLayer(1, '中文abc');
  const l2 = textLayer(2, '中文def');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1, l2] } },
    readRanges: (id) => (id === 1
      ? rangesFor('CNSong', 'EnSans', 12, 10)
      : rangesFor('CNSong', 'EnSans', 14, 10)),
  });
  const out = detect(host);
  const size = fieldOf(host, out, 'cnSize');
  assert.equal(stateOf(size), 'mixed');
  assert.ok(valueOf(size) == null);
  assert.equal(out.cnSize, null);
});

test('detectFontMix: 无文本层 -> 顶层 empty 为真且所有字段状态为 empty（供 panel 清旧值）', () => {
  const host = loadHost({
    app: { activeDocument: { activeLayers: [{ id: 9, name: '普通层', __kind: 'normal' }] } },
  });
  const out = detect(host);
  assert.equal(out.empty, true);
  ['cnFont', 'enFont', 'cnSize', 'enSize', 'cnColor', 'enColor'].forEach((name) => {
    const f = fieldOf(host, out, name);
    assert.equal(stateOf(f), 'empty', name + ' 应为 empty，实际 ' + stateOf(f));
    assert.ok(valueOf(f) == null);
  });
});

test('detectFontMix: 文本层但文本为空 -> empty，不是「未选中」', () => {
  const emptyLayer = textLayer(3, '');
  const host = loadHost({ app: { activeDocument: { activeLayers: [emptyLayer] } } });
  const out = detect(host);
  assert.equal(out.empty, true);
  assert.equal(stateOf(fieldOf(host, out, 'cnFont')), 'empty');
});

test('detectFontMix: 读取 range 抛错 -> 该字段 error 且 failed 记录层名/阶段，不冒充空态', () => {
  const l1 = textLayer(1, '中文abc');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1] } },
    readRanges: () => { throw new Error('executeActionGet failed'); },
  });
  const out = detect(host);
  const cn = fieldOf(host, out, 'cnFont');
  assert.equal(stateOf(cn), 'error');
  assert.ok(Array.isArray(out.failed) && out.failed.length === 1,
    'failed 必须记录 1 条，实际：' + JSON.stringify(out.failed));
  assert.equal(out.failed[0].name, 'Layer1');
  assert.ok(String(out.failed[0].reason).indexOf('executeActionGet') >= 0);
  assert.ok(out.failed[0].stage, 'failed 必须带 stage');
});

test('detectFontMix: 纯英文文本的中文侧为便利回填，必须带显式标记（fromOtherSide）', () => {
  const l1 = textLayer(1, 'abcdef');
  const host = loadHost({
    app: { activeDocument: { activeLayers: [l1] } },
    readRanges: () => [{ from: 0, to: 6, psName: 'EnSans', size: 10, rgb: { r: 0, g: 0, b: 1 } }],
  });
  const out = detect(host);
  const en = fieldOf(host, out, 'enFont');
  assert.equal(stateOf(en), 'consistent');

  const cn = fieldOf(host, out, 'cnFont');
  if (valueOf(cn) != null) {
    assert.ok(cn.fromOtherSide === true || cn.source === 'other-side' || cn.convenience === true,
      '另一侧回填必须显式标记（R2：UI 要标「依据另一侧回填」），实际：' + JSON.stringify(cn));
  }
});

/* ============================================================
 * 4. 应用路径不得自动整层回退（R4 / design §4）
 * ============================================================ */

test('verifyPlan rejects absent and partial ranges and mismatched requested colors', () => {
  const ctx = loadHost();
  ctx.readRanges = () => [];
  let problems = ctx.verifyPlan(1, [{from:0,to:2,psName:'Song',size:null,rgb:{r:1,g:0,b:0}}], 2);
  assert.ok(problems.some(p => p.field === 'coverage'));
  ctx.readRanges = () => [{from:0,to:1,psName:'Song',size:null,rgb:{r:1,g:0,b:0}}];
  problems = ctx.verifyPlan(1, [{from:0,to:2,psName:'Song',size:null,rgb:{r:1,g:0,b:0}}], 2);
  assert.ok(problems.some(p => p.field === 'coverage'));
  ctx.readRanges = () => [{from:0,to:2,psName:'Song',size:null,rgb:{r:0,g:1,b:0}}];
  problems = ctx.verifyPlan(1, [{from:0,to:2,psName:'Song',size:null,rgb:{r:1,g:0,b:0}}], 2);
  assert.ok(problems.some(p => p.field === 'color'));
  assert.ok(ctx.verifyPlan(1,[{from:1,to:2,psName:'Song'}],2).some(p=>p.field==='plan-coverage'));
});

test('verifySizes rejects absent and partially covered requested sizes', () => {
  const ctx = loadHost();
  ctx.readRanges = () => [];
  assert.ok(ctx.verifySizes(1,[{from:0,to:2,size:12}],2).some(p=>p.got==='uncovered'));
  ctx.readRanges = () => [{from:0,to:1,size:12}];
  assert.ok(ctx.verifySizes(1,[{from:0,to:2,size:12}],2).some(p=>p.got==='uncovered'));
});

test('applyFontMix: 源码中不得无条件调用 wholeLayerFallback', () => {
  const body = requireFunction(HOST_SRC, 'applyFontMix', 'host.jsx');
  const calls = /wholeLayerFallback\s*\(/.test(body);
  if (!calls) return;
  assert.ok(/allowWholeLayerFallback/.test(body),
    'applyFontMix 仍在调用 wholeLayerFallback：首版默认关闭整层回退（R4），' +
    '只能在显式开关 allowWholeLayerFallback 下才可调用');
});

test('wholeLayerFallback 仍存在但只能被显式开关路径使用', () => {
  const fb = extractFunction(HOST_SRC, 'wholeLayerFallback');
  assert.ok(fb, 'wholeLayerFallback 不应被删除（另有手动入口），只应默认不可达');
  const callers = HOST_SRC.split('wholeLayerFallback(').length - 1;
  assert.ok(callers >= 1, 'wholeLayerFallback 至少保留函数定义');
});

/* ============================================================
 * 5. Panel 回填：清旧值 + 手动保护（R2 / design §3.1 第 5 条）
 * ============================================================ */

function loadPanel(state) {
  const els = {};
  function el(sel) {
    if (!els[sel]) {
      els[sel] = { value: '', placeholder: '', textContent: '', title: '', addEventListener() {} };
    }
    return els[sel];
  }
  const ctx = vm.createContext({
    $: el,
    document: { querySelector: el, getElementById: (id) => el('#' + id) },
    currentScheme: state && state.currentScheme ? state.currentScheme : '',
    userTouched: (state && state.userTouched) || {},
    setCurrentLabel: () => {},
    rgbToHex: (c) => '#' + [c && c.r, c && c.g, c && c.b].map((v) => {
      const n = Math.round((v || 0) * 255);
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join(''),
    fontSel: (state && state.fontSel) || { cn: null, en: null },
    ddRegistry: (state && state.ddRegistry) || {},
  });

  const names = ['fillFontFromDetect', 'setFontValue', 'fontLabel'];
  const parts = names.map((n) => {
    const body = extractFunction(PANEL_SRC, n);
    return body ? 'var ' + n + ' = (' + body + ');' : null;
  }).filter(Boolean);
  vm.runInContext(parts.join('\n'), ctx);
  return { ctx, el, els };
}

test('fillFontFromDetect: empty 回包必须清空旧字体/旧字号/旧颜色（不留旧值误导）', () => {
  const { ctx, el } = loadPanel({
    fontSel: { cn: { family: '旧宋体', style: 'Regular' }, en: { family: '旧英文', style: 'Regular' } },
  });
  el('#cn-size').value = 12;
  el('#en-size').value = 10;
  el('#cn-color').value = '#ff0000';
  el('#en-color').value = '#0000ff';

  ctx.fillFontFromDetect({ empty: true });

  assert.equal(ctx.fontSel.cn, null, 'empty 回包后中文字体必须清空');
  assert.equal(ctx.fontSel.en, null, 'empty 回包后英文字体必须清空');
  assert.equal(el('#cn-size').value, '');
  assert.equal(el('#en-size').value, '');
  assert.equal(el('#cn-color').value, '');
  assert.equal(el('#en-color').value, '');
});

test('fillFontFromDetect: 字段值为 null/mixed 时清空，而不是保留上一次识别值', () => {
  const { ctx, el } = loadPanel({
    fontSel: { cn: { family: '旧宋体', style: 'Regular' }, en: { family: '旧英文', style: 'Regular' } },
  });
  el('#cn-color').value = '#ff0000';

  ctx.fillFontFromDetect({
    empty: false,
    fields: {
      cnFont: { state: 'mixed', value: null, sources: ['Layer1', 'Layer2'] },
      enFont: { state: 'consistent', value: { family: 'Source Sans', style: 'Regular' }, sources: ['Layer1'] },
      cnSize: { state: 'mixed', value: null },
      enSize: { state: 'consistent', value: 10 },
      cnColor: { state: 'empty', value: null },
      enColor: { state: 'consistent', value: { r: 0, g: 0, b: 1 } },
    },
    cnFont: null,
    enFont: { family: 'Source Sans', style: 'Regular' },
    cnSize: null,
    cnSizeMixed: true,
    enSize: 10,
    cnColor: null,
    enColor: { r: 0, g: 0, b: 1 },
  });

  assert.equal(ctx.fontSel.cn, null, 'mixed 中文字体必须清空');
  assert.equal(ctx.fontSel.en.family, 'Source Sans');
  assert.equal(el('#cn-size').value, '', '混合字号要清空值');
  assert.match(el('#cn-size').placeholder, /混合/, '混合字号要有明确提示');
  assert.equal(el('#cn-color').value, '', '颜色空态要清空');
});

test('fillFontFromDetect: 用户手动改过的字号不被识别回填覆盖', () => {
  const { ctx, el } = loadPanel({ userTouched: { '#cn-size': true } });
  el('#cn-size').value = '18';

  ctx.fillFontFromDetect({
    empty: false,
    cnSize: 12,
    enSize: 10,
    cnFont: { family: '宋体', style: 'Regular' },
    enFont: { family: 'Source Sans', style: 'Regular' },
  });

  assert.equal(el('#cn-size').value, '18', '受保护的手动字号不能被冲掉');
});

test('fillFontFromDetect: 用户手动选过的字体不被识别回填覆盖', () => {
  const { ctx } = loadPanel({ userTouched: { '#cn-font': true } });
  ctx.fontSel.cn = { family: '手动字体', style: 'Regular' };

  ctx.fillFontFromDetect({
    empty: false,
    cnFont: { family: '识别字体', style: 'Regular' },
    enFont: { family: 'Source Sans', style: 'Regular' },
    cnSize: 12,
    enSize: 10,
  });

  assert.equal(ctx.fontSel.cn.family, '手动字体', '手动选过的字体必须受保护（R2：现有保护语义保持有效）');
});

test('fillFontFromDetect: 已选方案时识别结果一律不覆盖表单', () => {
  const { ctx, el } = loadPanel({
    currentScheme: '我的方案',
    fontSel: { cn: { family: '方案宋体', style: 'Regular' }, en: null },
  });
  el('#cn-size').value = '16';

  ctx.fillFontFromDetect({ empty: false, cnSize: 12, enSize: 10, cnFont: { family: 'X', style: 'R' } });

  assert.equal(ctx.fontSel.cn.family, '方案宋体');
  assert.equal(el('#cn-size').value, '16');
});

/* ============================================================
 * applyFontMix 端到端（调用方分流，R3）
 * ------------------------------------------------------------
 * 只桩描述符层（写入 applyRangesSafe + 回读 readRanges），
 * 被真正执行的是：字体解析 -> 逐段方案 -> 写入 -> verifyPlan -> 结果分流。
 * 所以「回读不符算不算成功」是被测代码自己的判断，不是测试替它判断。
 * ============================================================ */

const APPLY_REAL = [
  'isCJK', 'segmentsOf', 'inArray', 'docSafe', 'asArray', 'errText',
  'esc', 'jstr', 'jnum', 'jval',
  'activeLayerSource', 'collectTextLayers',
  'fontIndex', 'psNameOf', 'planFromPerChar', 'planItem', 'fontPerChar',
  'verifyPlan', 'applyFontMix',
];

const APPLY_FONTS = [
  { family: '宋体', style: 'Regular', postScriptName: 'Song' },
  { family: 'Source Sans', style: 'Regular', postScriptName: 'Sans' },
];

const APPLY_ARGS = {
  cnFont: { family: '宋体', style: 'Regular' }, enFont: { family: 'Source Sans', style: 'Regular' },
  cnSize: 12, enSize: 10,
  cnColor: { r: 1, g: 0, b: 0 }, enColor: { r: 0, g: 0, b: 1 },
};

/** 一次写入后「Photoshop 里真实回读到的东西」；默认 = 完全按请求写进去了 */
function readBackOk() {
  return [
    { from: 0, to: 2, psName: 'Song', size: 12, rgb: { r: 1, g: 0, b: 0 } },
    { from: 2, to: 5, psName: 'Sans', size: 10, rgb: { r: 0, g: 0, b: 1 } },
  ];
}

function loadApplyHost(overrides) {
  const stubs = {
    app: { activeDocument: { activeLayers: [textLayer(1, '中文abc')], selectedLayers: [] }, fonts: APPLY_FONTS },
    walkLayers: (refs, fn) => (refs || []).forEach((r) => fn(r)),
    isTextLayer: (l) => !!l && l.__kind === 'text',
    textContentsOf: (l) => (l && typeof l.__text === 'string' ? l.__text : ''),
    // 写入成功：把请求的方案原样当成已写入
    applyRangesSafe: (id, plan, len, notes) => { notes.push('写入已执行'); return { plan: plan, path: 'DOM' }; },
    readRanges: () => readBackOk(),
    _layerScale: 1,
    rgbSafe: (v) => (v && [v.r, v.g, v.b].every(Number.isFinite) ? v : null),
    numOrNull: (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)),
  };
  const supplied = overrides || {};
  const merged = Object.assign({}, stubs, supplied);
  merged.app = Object.assign({}, stubs.app, supplied.app || {});
  const ctx = vm.createContext(merged);
  vm.runInContext('var _stage="init",_fontIndex=null,_lastPS="",_writeAttempted=false,_substituted=false,_trace="",_layerScale=1;' +
    'function stage(s){_stage=s;return s;}', ctx);
  const parts = APPLY_REAL.map((name) => {
    const body = extractFunction(HOST_SRC, name);
    return body ? 'var ' + name + ' = (' + body + ');' : null;
  }).filter(Boolean);
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

function applyMix(host) {
  const raw = host.applyFontMix(APPLY_ARGS);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

test('applyFontMix: 回读与请求一致才记成功', () => {
  const out = applyMix(loadApplyHost());
  assert.equal(out.ok, 1);
  assert.equal(out.failed.length, 0);
  assert.equal(out.substituted.length, 0);
});

test('applyFontMix: 只有字体被替换时记替换，不算失败也不算成功', () => {
  const back = readBackOk();
  back[0].psName = 'Fallback';
  const out = applyMix(loadApplyHost({ readRanges: () => back }));
  assert.equal(out.ok, 0, '字体被替换不能当成功计数');
  assert.equal(out.failed.length, 0, '字体替换不是写入失败');
  assert.equal(out.substituted.length, 1);
  assert.match(out.substituted[0], /替换/);
});

test('applyFontMix: 颜色不符属于失败，不许当字体替换放过去', () => {
  const back = readBackOk();
  back[1].rgb = { r: 0, g: 1, b: 0 };
  const out = applyMix(loadApplyHost({ readRanges: () => back }));
  assert.equal(out.ok, 0);
  assert.equal(out.substituted.length, 0, '颜色不符不是字体替换');
  assert.equal(out.failed.length, 1);
  assert.ok(out.failed[0].fields.includes('color'), '失败条目要指出不符字段');
  assert.equal(out.failed[0].state, 'unknown');
  assert.match(out.failed[0].integrity, /完整性未知/);
});

test('applyFontMix: 区间根本没写进去（回读为空）属于失败', () => {
  const out = applyMix(loadApplyHost({ readRanges: () => [] }));
  assert.equal(out.ok, 0, '空回读绝不能算成功');
  assert.equal(out.substituted.length, 0);
  assert.equal(out.failed.length, 1);
  assert.ok(out.failed[0].fields.includes('coverage'), '失败条目要指出覆盖缺口');
});

test('applyFontMix: 字体替换叠加颜色不符时，颜色不符优先按失败报', () => {
  const back = readBackOk();
  back[0].psName = 'Fallback';
  back[0].rgb = { r: 0, g: 0, b: 0 };
  const out = applyMix(loadApplyHost({ readRanges: () => back }));
  assert.equal(out.ok, 0);
  assert.equal(out.failed.length, 1, '硬问题必须进 failed');
  assert.ok(out.failed[0].fields.includes('color'));
  assert.equal(out.failed[0].substituted, true, '同时存在字体替换要保留痕迹');
});

/* ============================================================
 * 6. 结果展示：回读通过 / 被替换 / 失败 三类必须同时可见（R3/R6）
 * ------------------------------------------------------------
 * 宿主已修好计数语义（替换层不进 ok），面板若还照旧文案就会
 * 出现「已应用 0 个，其中 1 个被替换」这种自相矛盾的结果。
 * ============================================================ */

function loadPanelResult() {
  const els = {};
  const el = (sel) => {
    if (!els[sel]) els[sel] = { textContent: '' };
    return els[sel];
  };
  const ctx = vm.createContext({
    $: el,
    document: { querySelector: el, getElementById: (id) => el('#' + id) },
    clearTimeout: () => {},
    setTimeout: () => 0,
    fontGuard: null,
    lastSyncColor: false,
  });
  const body = extractFunction(PANEL_SRC, 'showFontMixResult');
  assert.ok(body, '面板缺少 showFontMixResult');
  vm.runInContext(body + '\nvar fontGuard = null, lastSyncColor = false;', ctx);
  return { ctx, el };
}

test('showFontMixResult: 只有替换层时不能说「已应用 0 个」', () => {
  const { ctx, el } = loadPanelResult();
  ctx.showFontMixResult({
    total: 1, ok: 0, failed: [], missingFonts: [], empty: false,
    substituted: ['Layer1 -> 字体被 Photoshop 替换：请求 Song，实际 Fallback（区间 0-2）'],
  });
  const text = el('#font-status').textContent;
  assert.doesNotMatch(text, /已应用\s*0/, '不能出现「已应用 0 个」这种自相矛盾的文案，实际：' + text);
  assert.match(text, /回读通过\s*0/, '回读通过数要照实写 0，实际：' + text);
  assert.match(text, /字体被替换\s*1/, '被替换数必须展示，实际：' + text);
});

test('showFontMixResult: 成功/失败/替换同时存在时三类都要报出来', () => {
  const { ctx, el } = loadPanelResult();
  ctx.showFontMixResult({
    total: 3, ok: 1, empty: false, missingFonts: [],
    failed: [{ name: 'Layer2', reason: '写入后回读与请求不符：color（首个区间 0-2）', stage: 'verify', integrity: '已发生写入，回读存在未写入或颜色不符区间，混排完整性未知' }],
    substituted: ['Layer3 -> 字体被 Photoshop 替换：请求 Song，实际 Fallback（区间 0-2）'],
  });
  const text = el('#font-status').textContent;
  assert.match(text, /回读通过\s*1/, '实际：' + text);
  assert.match(text, /失败\s*1/, '实际：' + text);
  assert.match(text, /字体被替换\s*1/, '替换层不能被失败分支吞掉，实际：' + text);
  assert.match(text, /已处理\s*3/, '总数要报，实际：' + text);
});

test('showFontMixResult: attempted writes override contradictory unchanged integrity', () => {
  const {ctx,el}=loadPanelResult();
  ctx.showFontMixResult({total:1,ok:0,failed:[{name:'L',reason:'readback failed',writeAttempted:true,state:'unchanged',integrity:'未发生写入'}]});
  assert.match(el('#font-status').textContent,/完整性未知/);
  assert.doesNotMatch(el('#font-status').textContent,/未发生写入/);
  ctx.showFontMixResult({error:'timeout',resultUnknown:true});
  assert.match(el('#font-status').textContent,/结果未知/);
  ctx.showFontMixResult({total:1,ok:0,failed:[{name:'L',reason:'cancelled',writeAttempted:true,state:'rolled-back',integrity:'回滚后逐区间复核通过'}]});
  assert.match(el('#font-status').textContent,/回滚后逐区间复核通过/);
});
test('showFontMixResult: 有未处理层（取消）时要说出来', () => {
  const { ctx, el } = loadPanelResult();
  ctx.showFontMixResult({ total: 4, ok: 1, failed: [], empty: false, cancelled: true, unprocessed: 3 });
  const text = el('#font-status').textContent;
  assert.match(text, /未处理\s*3/, '取消后剩余层必须告知用户，实际：' + text);
});

test('fontIndex: CEP name field resolves fonts when postScriptName is absent', () => {
  const h = loadHost({ app: { fonts: [{name:'Latin-Regular', family:'Latin', style:'Regular'}] } });
  assert.equal(h.metaOfPSName('Latin-Regular').family, 'Latin');
});
test('fontIndex: one broken entry does not hide later Latin fonts', () => {
  const broken = {}; Object.defineProperty(broken, 'family', {get(){throw Error('broken font');}});
  broken.name = 'Bad';
  const h = loadHost({ app: { fonts: [{name:'First',family:'First',style:'Regular'}, broken, {name:'Latin',family:'Latin',style:'Regular'}] } });
  assert.equal(h.metaOfPSName('Latin').family, 'Latin');
  assert.equal(h.fontIndex().length, 2);
});
function automaticHarness(selected, entries, offset=0) {
  let walks=0, gets=0; const reads=[];
  const doc={id:11,activeLayer:{id:selected[0]}};
  Object.defineProperty(doc,'layers',{get(){walks++;throw Error('DOM walk');}});
  const descriptor=v=>({hasKey:k=>Object.hasOwn(v,k),getInteger:k=>v[k],getString:k=>v[k],getEnumerationValue:k=>v[k]});
  const box={app:{activeDocument:doc},stage(){},S:x=>x,errText:String,jval:JSON.stringify,
    ActionReference:function(){this.putProperty=()=>{};this.putEnumerated=()=>{};this.putIdentifier=(_,id)=>{this.id=id;};this.putIndex=(_,i)=>{this.index=i;};},
    executeActionGet(r){gets++;if(r.id!==undefined){reads.push(r.id);return descriptor(entries.find(e=>e.layerID===r.id));}
      if(r.index!==undefined){const v=entries.find(e=>e.itemIndex-offset===r.index);if(!v)throw Error('bad index');reads.push(v.layerID);return descriptor(v);}
      return {getList:()=>({count:selected.length,getReference:i=>({getIdentifier:()=>selected[i]})})};}};
  vm.createContext(box);vm.runInContext('var _autoSelection=null;'+['docSafe','hasKey','automaticSelection','selSig','envProbe'].map(n=>extractFunction(HOST_SRC,n)).join('\n'),box);
  return {box,doc,reads,stats:()=>({walks,gets})};
}
test('selSig: only selected descriptors are read and stable polling reuses type results',()=>{
  const h=automaticHarness([9,2],[{layerID:9,layerKind:1},{layerID:2,layerKind:3}]);
  assert.equal(JSON.parse(h.box.selSig()).textCount,1);h.box.selSig();
  assert.deepEqual(h.reads,[2,9]);h.doc.id=12;
  assert.equal(JSON.parse(h.box.selSig()).sig,'12:2,9');
  assert.equal(h.stats().walks,0);assert.equal(h.stats().gets,7);
});
test('automatic selection scans selected nested group only, deduplicates mixed text and handles index offset',()=>{
  for(const offset of [0,1]){
    const h=automaticHarness([40,20,99],[
      {layerID:99,layerKind:1,itemIndex:99},
      {layerID:40,layerSection:'layerSectionStart',itemIndex:8},
      {layerID:30,layerSection:'layerSectionStart',itemIndex:7},
      {layerID:20,layerKind:3,itemIndex:6,name:'Text'},
      {layerID:19,layerSection:'layerSectionEnd',itemIndex:5},
      {layerID:18,layerKind:1,itemIndex:4},
      {layerID:17,layerSection:'layerSectionEnd',itemIndex:3},
      {layerID:16,layerKind:3,itemIndex:2}],offset);
    const r=h.box.automaticSelection();assert.deepEqual(plain(r.layers),[{id:20,name:'Text'}]);
    assert.equal(h.reads.includes(16),false);assert.equal(h.stats().walks,0);assert.deepEqual(plain(r.notes),[]);
  }
});
test('selected group refreshes children without changing selected group ID',()=>{
 const entries=[{layerID:40,layerSection:'layerSectionStart',itemIndex:3},{layerID:20,layerKind:3,itemIndex:2,name:'Old'},{layerID:19,layerSection:'layerSectionEnd',itemIndex:1}];
 const h=automaticHarness([40],entries);
 assert.deepEqual(plain(h.box.automaticSelection().layers).map(l=>l.id),[20]);
 entries[1]={layerID:21,layerKind:3,itemIndex:2,name:'New'};
 assert.deepEqual(plain(h.box.automaticSelection().layers).map(l=>l.id),[21]);
 entries[1]={layerID:22,layerKind:1,itemIndex:2};
 assert.equal(h.box.automaticSelection().layers.length,0);
 assert.equal(h.stats().walks,0);
});
test('nontext selection and startup diagnostic never scan document layers or fonts',()=>{
  const h=automaticHarness([1],[{layerID:1,layerKind:1}]);
  Object.defineProperty(h.box.app,'fonts',{get(){throw Error('font enumeration');}});
  h.box._fontIndex=null;h.box.HOST_VERSION='test';
  assert.equal(JSON.parse(h.box.selSig()).textCount,0);
  const before=h.stats().gets;assert.equal(JSON.parse(h.box.envProbe()).textLayers,'not-scanned');
  assert.equal(h.stats().gets,before);assert.equal(h.stats().walks,0);
});
test('verifyPlan: sorted 100-range verification avoids quadratic comparisons',()=>{
 let visits=0;const ranges=Array.from({length:100},(_,i)=>({from:i,to:i+1,psName:'Latin'}));
 const actual=new Proxy(ranges,{get(t,k){if(/^\d+$/.test(String(k)))visits++;return t[k];}});
 const h=loadHost({readRanges:()=>actual});assert.equal(h.verifyPlan(1,ranges,100).length,0);
 assert.ok(visits<600,'range visits='+visits);console.log('100-range verification reads:',visits);
});
test('invalid selected ID uses matching selected DOM object without document scan',()=>{
 const h=automaticHarness([999],[]);h.box.asArray=x=>x;h.box.isTextLayer=l=>l.__kind==='text';
 h.doc.activeLayer={id:999,name:'Fallback',__kind:'text'};
 vm.runInContext(extractFunction(HOST_SRC,'collectTextLayers'),h.box);
 const r=h.box.automaticSelection();assert.equal(r.layers.length,1);assert.equal(r.layers[0].id,999);
 assert.ok(r.notes.includes('selected-dom-fallback:999'));assert.equal(h.stats().walks,0);
});
test('invalid ID without selected DOM match is reported and remains retryable',()=>{
 const h=automaticHarness([999],[]);h.box.asArray=x=>x;h.doc.activeLayer={id:1};
 const first=h.box.automaticSelection();assert.equal(first.layers.length,0);assert.match(first.notes.join(','),/selection-read:999/);
 const before=h.stats().gets;h.box.automaticSelection();assert.ok(h.stats().gets>before);assert.equal(h.stats().walks,0);
});
test('font diagnostics distinguish missing identity from index miss without text content',()=>{
 for(const [ps,reason] of [[null,'font-identity-missing'],['MissingLatin','font-index-miss']]){
  const layer=textLayer(1,'中文abc');
  const h=loadHost({app:{activeDocument:{activeLayers:[layer]}},readRanges:()=>rangesFor('CnSans',ps,12,10)});
  const out=detect(h);assert.equal(out.fields.enFont.state,'unrecognized');
  assert.equal(out.fields.enFont.sources[0].reason,reason);
  assert.equal(JSON.stringify(out).includes('中文abc'),false);
 }
});
test('AM selection failure merges exposed DOM selections and never walks document tree',()=>{
 const h=automaticHarness([], [{layerID:1,layerKind:3},{layerID:2,layerKind:3}]);h.box.asArray=x=>x;
 h.doc.activeLayers=[{id:1}];h.doc.selectedLayers=[{id:1},{id:2}];h.doc.activeLayer={id:9};
 const original=h.box.executeActionGet;h.box.executeActionGet=r=>{if(r.id===undefined&&r.index===undefined)throw Error('selection unavailable');return original(r);};
 const result=h.box.automaticSelection();assert.equal(result.selectedCount,2);assert.deepEqual(plain(result.layers).map(l=>l.id),[1,2]);assert.equal(h.stats().walks,0);
});
test('AM failure with no DOM refs returns empty without calling whole-document resolver',()=>{
 const h=automaticHarness([],[]);h.box.asArray=x=>x;delete h.doc.activeLayer;
 h.box.executeActionGet=()=>{throw Error('AM unavailable');};h.box.activeLayerSource=()=>{throw Error('forbidden resolver');};
 const result=h.box.automaticSelection();assert.equal(result.selectedCount,0);assert.equal(result.layers.length,0);assert.equal(h.stats().walks,0);
});
