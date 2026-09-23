# PS工具箱 · 逻辑与架构说明

> 对应版本：面板 1.7.0 / 宿主 4.4.0
> 本文所有描述均以 `jsx/host.jsx` 与 `index.html` 的实际代码为准，不包含设想中的行为。

---

## 目录

1. [三层结构与通信机制](#一三层结构与通信机制)
2. [字体索引：本机字体从哪来](#二字体索引)
3. [识别链路（detect-font）](#三识别链路detect-font)
4. [写入链路（font-mixer）](#四写入链路font-mixer)
5. [可选的同步颜色（左右两半按钮）](#五可选的同步颜色)
6. [自动微调（视觉字距 + 行距自动）](#六自动微调)
7. [拾色器](#七拾色器)
8. [字体混排方案（预设）](#八字体混排方案)
9. [宿主版本守卫与自检](#九宿主版本守卫与自检)
10. [诊断日志 diag.log](#十诊断日志)
11. [测试体系](#十一测试体系)
12. [真机踩坑记录（回归守卫）](#十二真机踩坑记录)

---

## 一、三层结构与通信机制

```
┌─ 面板 index.html（CEP 内嵌 Chromium）──────────────────┐
│  UI、状态、方案存储（localStorage，经 cep.storage 持久化）│
└──────────────┬────────────────────────────────────────┘
               │ cs.evalScript("cephpostDispatch('font-mixer', {...})")
               │ 入参 = JSON 字面量；返回值 = JSON 字符串
┌──────────────▼────────────────────────────────────────┐
│  jsx/host.jsx（ExtendScript，跑在 Photoshop 进程里）     │
│  启动即发布 $.global.cephpostDispatch(action, jsonStr)  │
│  真正读写文档 / 图层 / 字体                              │
└────────────────────────────────────────────────────────┘
```

关键约定：

- **ExtendScript 是 ES3 方言**：没有 `JSON`、箭头函数、`let/const`。宿主内部手写了极简 JSON 序列化（`jval`），所以消息形状两端一致；
- **消息协议**：面板发 `{type: 'font-mixer', config: {...}}`，主进程转发给宿主；宿主返回 JSON 后面板按 `msg.type === 'font-mixer-done'` 等分支处理。当前保留的动作：`ping` / `fonts` / `detect-font` / `font-mixer` / `auto-kerning` / `pick-color` / `selftest`；
- **失败不静默**：宿主每个动作都带 `stage`（阶段名）与出错行号；面板把 `msg.error` 原样展示；
- **等待守卫**：点击应用后面板启动 20 秒守卫（`onFontMixStart`），主进程无响应会明确提示，而不是永远停在「应用中…」。

---

## 二、字体索引

宿主首次需要字体时执行 `fontIndex()`（`host.jsx` 205 行附近）：

- 遍历 Photoshop 的 **`app.fonts`**，每项记三元组 `{family, style, postScriptName}`；
- **整会话缓存**（`_fontIndex`），避免反复遍历几千个字体；
- 面板字体下拉的每一项都来自它，全程不联网。

字体名翻译 `psNameOf(family, style)`：

1. 先精确匹配「族 + 样式」（如 `苹方-简 + Bold` → `PingFangSC-Bold`）；
2. 匹配不到则退化为同族任意样式；
3. 都没有 → 返回 `null`，调用方把该字体列入 `missingFonts` 并中止（面板提示「字体在本机不可用」）。

辅助判定 `isSymbolFont(psName)`：名字含 `Emoji / Symbol / Wingdings / Icons / Math / Music…` 的字体被视为符号字体，**只用于归属分区展示，绝不当作写入/自检的测试字体**（原因见第十二节坑 ③）。

---

## 三、识别链路（detect-font）

触发时机：切到字体混排页、文档选区变化时，面板发 `detect-font`（500ms 节流）。

### 1. 找图层

- 优先 `activeLayer`；不是文本层则扫 `activeLayers`（`walkLayers` 递归图层组），收集全部文本层；
- 识别只取**第一个**文本图层（`layers[0]`）；写入则处理选中的全部文本层。

### 2. 读文本与样式区间

Action Manager 形状（此形状为真机验证过的录制形状，见第十二节坑 ①）：

```
读：executeActionGet( ref: putProperty('property','textKey') + putIdentifier('layer', id) )
    → desc.getObjectValue('textKey')
    → textKey.getString('textKey')             // 文本内容
    → textKey.getList('textStyleRange')        // 每条 = [from, to) + 字体/字号/颜色
    → textKey.getObjectValue('transform')      // 图层自由变换矩阵
```

> 注意必须 `putProperty('property','textKey')`；只给 `Lyr ` 标识符是拿不到 textKey 的——这是历史上「识别全 null」的根因（坑 ①）。

### 3. 字号折算（图层变换系数 K）

`layerScaleOf(layerId)`（281 行附近）：

- 读 `textKey.transform.xx`，取绝对值作为缩放系数 K（默认 1）；
- **带自由变换的图层**，textKey 里存的是「变换前基础值」，字符面板显示「基础值 × K」；
- 识别与回读校验统一 ×K 后再报——面板里的字号与 PS 字符面板看到的完全一致（坑 ②，本机实测 K = 6.5625）。

### 4. 逐字符分区 `isCJK(ch)`

| 码位范围 | 含义 | 归属 |
|---|---|---|
| U+3000–303F | CJK 标点（顿号、句号、「」等） | 中文 |
| U+3040–30FF | 平/片假名 | 中文 |
| U+3400–4DBF | 汉字扩展 A | 中文 |
| U+4E00–9FFF | CJK 统一汉字 | 中文 |
| U+AC00–D7AF | 谚文 | 中文 |
| U+F900–FAFF | 兼容表意文字 | 中文 |
| U+FF00–FFEF | 全角形式（全角括号`（）`、全角字母数字、￥） | 中文 |
| 拉丁字母、数字 | A-Z a-z 0-9 | 英文 |
| 其余符号（v4.6 默认） | 含半角标点 — 中文字体同时携带全/半角字形，纯拉丁展示字体缺全角字形会被 PS 替换 | 中文 |

`segmentsOf(text)` 把全文切成连续段（同归属合并），例如：

```
光感「」无瑕 （24H）润贴
→ [中文 0-9][英文 9-13][中文 13-17]     （全角括号跟着中文走）
```

### 5. 汇总

对每个样式区间 × 每个分段：

- 每侧取**遇到的第一个**字体、颜色、字号；
- 某侧一段都没出现 → 复用另一侧的值（纯中文文案也会把英文字体框填上）；
- 同侧出现多个不同字号 → `cnSizeMixed / enSizeMixed = true`，面板输入框占位符显示「混合字号（留空保留）」。

### 6. 回填闸门（面板侧 `fillFontFromDetect`）

以下情形**不覆盖**你正在编辑的表单：

- 当前**选中了某个方案**（`currentScheme` 非空）→ 方案值优先；
- 某个输入框你**手动编辑过**（`userTouched` 记录）→ 不覆盖。这是「输入 30 后选区一变被冲回 12」事故的修复。

---

## 四、写入链路（font-mixer）

### 1. 构造计划

```
fontPerChar(text, cnPS, enPS, cnSize, enSize, cnColor, enColor)
```

- 逐字符按 `isCJK` 挂上「共享的」覆盖对象：中文段全部引用同一个 `cnO`，英文段引用 `enO`（`syncColor=false` 时 `cnO/enO.rgb = null`）；
- `planFromPerChar` 按**引用相同**合并相邻字符 → 得到最少的连续区间列表，保证无缝覆盖全文；
- 每条计划项：`{from, to, psName, size, rgb, trck, autoLeading}`。

### 2. 分段写入（canonical 路径）

Action Manager 形状（真机验证过的录制形状）：

```
写：executeAction('set',
      putIdentifier('textLayer', id)          // 目标图层
    + putObject('to', 'textLayer', 整份 textKey))   // 重建后的完整 textKey
```

要点：

- **写前先读回整份 textKey**，只改目标字段，其余样式原样继承；
- **换字体族时丢弃 `engineData`**（旧版式快照，写回去会把刚改的字体顶掉），同时清掉 `fontName / fontStyleName / fontScript / fontTechnology / fontAvailable` 防止元数据串族；
- 颜色在 textKey 里的键是 `red / grain / blue`（0–255 浮点）。

### 3. 字号写入：自发现 + 回读校验

Photoshop 对 textKey 里的 `size` 会**静默忽略**（不抛错、值不变）。因此：

1. 依次尝试 4 种候选（`size/pointsUnit` → `size/pixelsUnit` → `size+implied` → `Sz  `），全部**回读确认字号真的变了**才采用，并缓存胜出者（`_sizeMode`）整会话复用；
2. 4 种都不行 → 剥掉字号重写一次，只应用字体，并在 notes 里如实报「字号未能写入（…各候选实测值…），已只应用字体」；
3. 校验比对时读回值 ×K（与字符面板一致，容差 1%）——避免坑 ② 的误报。

### 4. 校验与三种结局

写完重读区间（`verifyPlan`），按结果分三路：

| 结局 | 条件 | 行为 |
|---|---|---|
| 成功 | 回读字体与计划一致 | `path: 'canonical'`，正常计数 |
| 字体被替换 | 部分区间的字体 ≠ 请求值 | **保留已写入结果**，`substituted[]` 报明「请求 X 实际 Y（区间 n-m）」，绝不整层覆盖（坑 ④） |
| 描述符被整体拒绝 | `set` 抛错 | 走整层 DOM 兜底（见下） |

### 5. 整层 DOM 兜底

分段写入被整体拒绝时的最后手段：

- `domWholeLayer`：`textItem.font = psName` → `textItem.size` →（若允许）`textItem.color`，逐项 try/catch；
- **取首段语言决定整层字体**（中文开头 → 中文字体糊满整层）；
- **遵守 syncColor 开关**：关闭时连 `textItem.color` 都不会被碰（有专项测试盯守）；
- 返回里 `path: 'dom-fallback'` + `layerFallback[]` 明确说明用了哪条路径与各子项结果。

---

## 五、可选的同步颜色

应用按钮从中间一分为二（`|` 分隔）：

```
┌─────────────────────┬──────────────────┐
│ 应用字体混排与颜色  │ 应用字体混排     │
└─────────────────────┴──────────────────┘
      左半 sendFontMix(true)   右半 sendFontMix(false)
```

| 行为 | 左半（带颜色） | 右半（不带颜色，默认推荐） |
|---|---|---|
| 字体 | ✅ 中英分段写入 | ✅ 中英分段写入 |
| 字号 | ✅ | ✅ |
| 颜色 | 按面板左/右侧字色写入 | **结构性不动**：计划里根本不建颜色键，原色靠「继承基准区间样式」保留 |
| 整层兜底时 | 写 `textItem.color` | 连 `textItem.color` 都不碰 |

方案（预设）联动：

- 保存方案时记录「最近一次应用用的哪半边」（`syncColor` 字段）；
- 加载方案只回填提示，**实际是否同步颜色始终由本次点击的哪半决定**——不会出现「方案记了 A、应用却走了 B」；
- 旧方案没有 `syncColor` 字段 → 按关闭处理；
- 符号归属、分区算法不受该开关影响。

结果提示明确区分：`已按左右侧字色同步颜色` / `未调整颜色（保留原文字颜色）`。

---

## 六、自动微调

对选中的所有文本层执行两件事：

1. **视觉字距**：把字符间距微调设为 Photoshop 的「视觉」（`autoKerning` = optical，即字符面板「字距微调：视觉」）；
2. **行距自动（可勾选）**：面板有「行距自动」勾选框（默认勾选，状态持久化）：
   - 勾选 → 把行间距设为「自动」。写入是双路径 + 回读校验：
     1. DOM 优先：`layer.textItem.useAutoLeading = true` → 读回确认为 `true` 才计成功；
     2. 描述符回退：区间样式里写 `autoLeading: true` → 回读确认；
     3. 都不行 → 如实报失败原因；
   - 不勾选 → **完全不碰行间距**，返回 `leadingMode: 'off'`，界面提示「未勾选行距自动，行间距保持不变」。

---

## 七、拾色器

- 面板点色块 → 宿主 `pick-color` → `app.foregroundColor` 弹出 Photoshop 原生拾色器 → 返回选中 RGB（0–1 浮点）；
- 面板把返回值写回色块并同步到 `#cn-color / #en-color` 字段。

---

## 八、字体混排方案

- **存储**：`localStorage`（经 CEP `cep.storage` 持久化，跨面板重启），全程本地、不联网；
- **保存**：`readFormAsScheme` 读当前表单（字体取内存态 `fontSel` 避免空值 JSON.parse 抛错），含 `syncColor`；
- **加载**：回填表单并设为「当前方案」（此时识别回填闸门生效：不再覆盖表单）；再次点「当前」= 取消选择；
- **导入/导出**：JSON 文件，字段同上；
- **内置方案**：两条出厂预设（中英正文 / 中英混排标题），带 `syncColor: true` 与默认字色。

---

## 九、宿主版本守卫与自检

- 面板 `HOST_EXPECT` 与宿主 `HOST_VERSION` 核对；不一致 → 当场把 jsx 重新加载并挂到 `$.global`，**升级后只需关开面板，无需重启 Photoshop**；
- 面板启动即跑 `selftest`：在**临时文档**里用生产路径把两个不同字体写进两段并回读，结论显示在状态条、明细写入 `diag.log`；临时文档用完即删，不碰用户稿件；点击状态条可重跑。

---

## 十、诊断日志

`diag.log` 写在安装目录（CEP 扩展目录内），每次动作追加一行：

```
时间 [动作] -> {JSON 结果 + stage + 行号 + trace}
```

排障优先级：**先读 diag.log，再读代码**——历史上所有真机问题（见第十二节）都是从这里拿到的第一手证据。

---

## 十一、测试体系

全部离线可重跑（不需要打开 Photoshop）：

| 测试 | 内容 | 数量级 |
|---|---|---|
| `audit/host-lint.py` | 宿主纯 ASCII、无 BOM、无尾逗号、无 ES5 API、无保留字键名、入口发布到 `$.global` | 28 项 |
| `audit/test-host-smoke.js` | **带迷你 Photoshop 文本模型的桩**：textKey、样式区间、transform 缩放存储、set 被拒注入；覆盖识别、写入、字号自发现、颜色开关、兜底、字体替换等 | ~70 断言 |
| `audit/test-host-optical.js` | 视觉字距 + 拾色器专项，含旧失败形状回归守卫 | 35 项 |
| `audit/test-panel-fit.js` | 弹层自适应纯函数属性测试（面板 200–2160px 各种高宽 × 触发条位置） | 5182 组 |
| `audit/verify-all.js` | 静态核查：文件一致性、manifest、宿主 ES3、面板引用完整性、**UI ↔ 宿主字段级对账**（面板读的字段宿主必须真返回） | 93 项 |
| `npm run test:ps` | 串联以上全部 | — |

---

## 十二、真机踩坑记录

以下每一条都来自用户真机 `diag.log` 的证据，且已固化为回归测试或守卫：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| ① | 识别全返回 null | 读 textKey 时少了 `putProperty('property','textKey')`，只给 `Lyr ` 标识符拿不到文本描述符，异常被静默吞掉 | 改用录制形状；读取失败不再静默，直接上报 |
| ② | 字号「写不进」（实为误报） | 图层带自由变换 K=6.5625；textKey 存基础值（写入值÷K），校验拿基础值与请求值直接比 → 误判失败 | 校验与识别统一 ×K（与字符面板一致）；写入端保持原值（PS 把 AM 值当面板尺寸处理） |
| ③ | 自检红字「字体被替换」但真实写入成功 | 自检挑到了 `EmojiOneColor`（纯 emoji 字体，无拉丁字形）→ PS 替换 → 区间合并 → 回读不匹配 | 自检排除符号字体；第二字体强制换不同字族 |
| ④ | 英文字体「改不了」 | 文案含全角括号`（）`，旧分区表漏了 FF00–FFEF → 全角括号被划给纯拉丁字体 Druk → PS 替换 → 回读不匹配 → 旧代码抛异常触发整层覆盖，把已成功的分段冲掉 | 补全角/谚文区；替换改为「保留结果 + 如实上报」，永不整层覆盖 |
| ⑤ | 字号被静默忽略 | PS 对 textKey 的 `size` 不抛错、值不变 | 4 种候选自发现 + 回读校验，全部失败则明确降级 |
| ⑥ | 「字号改不了」（UI 侧） | 识别回填每 500ms 触发，把用户刚输入的值覆盖回识别值 | `userTouched` 闸门：手动编辑过的字段不被回填覆盖 |
| ⑦ | 矮面板里弹层被裁 | 弹层固定向下展开、无翻转逻辑 | `popupFitPlan()` 打开与 resize 时计算翻转 + 收紧 max-height（纯函数 5182 组属性测试） |
| ⑧ | 深色系统主题下控件看不清 | 未声明 `color-scheme` | `:root { color-scheme: light }` |
| ⑨ | 欧洲键盘输入 `12,5` 变成 12 | `parseFloat` 不识别逗号 | `numInput()` 统一把 `,` 归一为 `.` |

---

## 附：目录结构

```
ps-plugin/
├─ com.figmatoolbox.ps/          # 插件源码
│  ├─ CSXS/manifest.xml          # PS 2019+ (CEP 9+) 兼容声明
│  ├─ index.html                 # 面板（UI + 全部逻辑内联）
│  ├─ jsx/host.jsx               # ExtendScript 宿主
│  ├─ js/CSInterface.js          # Adobe 官方桥
│  └─ .debug                     # 远程调试端口声明
├─ audit/                        # 全部离线测试与核查器
├─ tools/ZXPSignCmd.exe          # 签名工具
├─ cert/ps-toolbox-v2.p12        # 自签证书（勿外传）
├─ dist/盗版PS的工具箱-<版本>.ccx # 签名产物
├─ install-windows.ps1 / 安装-Windows双击运行.cmd / install-macos.sh  # 一键安装
└─ README.md                     # 使用与打包说明
```
