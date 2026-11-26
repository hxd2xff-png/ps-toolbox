# UXP 版 API 与版本要求核对（DS 独立核查）

核查对象：为 Photoshop 插件新增独立 UXP 版本（CEP 版保留并单独修复）。
核查方式：Adobe 官方文档逐条对照 + 本机环境实测（只读）。
核查时间：2026-11-12。

---

## 0. 本机实测环境（不是推断，是命令输出）

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| 已装 Photoshop | `C:\Program Files\Adobe\Adobe Photoshop 2026` → **27.4**；`Adobe Photoshop 2020` → **21.0** | 读 exe VersionInfo |
| UXP 插件存储（说明本机 PS 版本确实跑过 UXP） | `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\` 存在（另有 PHSPBETA\27、ILST\28、ILST\29） | 目录枚举 |
| 系统级 UXP 插件目录 | `C:\Program Files\Common Files\Adobe\UXP\extensions\` 已存在，内含 `com.adobe.ccx.start-10.16.4`、`com.adobe.substance-3d.viewer.ps` | 目录枚举 |
| CEP 现装副本 | `%APPDATA%\Adobe\CEP\extensions\com.figmatoolbox.ps` | 目录枚举 |
| 现有 CEP 清单 | `ExtensionBundleId=com.figmatoolbox.ps`、`Version 9.0` 清单、`CSXS 9.0`、宿主 `[20.0,99.9]`、入口 `index.html` + `jsx/host.jsx` | `com.figmatoolbox.ps/CSXS/manifest.xml` |

结论：本机 PS 27.4 满足「UXP 首版只面向 PS 2024+」的门槛，UXP 版可直接在本机真机验收；PS 21.0 只继续服务 CEP 版。

---

## 1. 版本门槛（核对通过）

| 要求 | 官方口径 | 与「PS 2024+」是否冲突 |
| --- | --- | --- |
| UXP 插件最早支持 | PS 22.0（UXP 插件从 2021 起） | 不冲突 |
| manifest v5 | 完整 v5 能力需 **PS 23.3.0 / UXP 6.0 以上** | 不冲突 |
| `host.minVersion` | 至少两段，如 `22.0`、`25.0` | 写成 `25.0` 即锁定 PS 2024+ |
| `apiVersion` 默认值 | `minVersion >= 23.0.0` 时默认 **2**（模态 JS 作用域模型） | 不冲突，但**必须按 apiVersion 2 写代码** |
| TextItem 类属性 | 文档标注 Min Version **24.1** | 不冲突 |
| **`Layer.textItem` 属性本身** | **24.2** | 不冲突，但**实际 floor 因此是 24.2 而非 24.1** |
| TextItem 是否有区间读 API | **没有**：只有 `contents`（整段文本 R/W, 24.1）、`characterStyle`、`paragraphStyle`、`warpStyle`，无 `textStyleRanges` 之类 | 见 §4.1 修订 |
| `document.activeLayers` 读 | Min Version 22.5 | 不冲突 |
| `document.activeLayers` **写**（设置选区） | **仅 26.9 起**（changelog 26.9：can set by providing an array of Layer objects） | **PS 25.0 不可用，设计不得依赖写选区** |
| `action.batchPlay` | **23.0**（文档注明 subject to change） | 不冲突 |
| `core.executeAsModal` options.timeOut | **25.10** | PS 25.0 上没有排队重试，模态冲突直接抛错 |
| `app.fonts`（TextFonts） | 23.0 | 不冲突，检索字体走这条 |
| `TextFont`（family/style/postScriptName） | Min Version 23.0 | 不冲突 |
| `document.zoom` | 25.1 | 不冲突（仅当 UI 要读缩放） |

来源：
- [Manifest v5](https://adobedocs.github.io/uxp-photoshop/guides/uxp_guide/uxp-misc/manifest-v5/)
- [Photoshop specific manifest properties（apiVersion/loadEvent）](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v4/photoshop-manifest/)
- [Manifest v4（id / host / entrypoints 字段定义）](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v4/)
- [Document 类](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document/)
- [Layer 类（textItem = 24.2）](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/layer/)
- [Photoshop 类（batchPlay 23.0、app.fonts 23.0）](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/photoshop/)
- [API Changelog（26.9 activeLayers 可写）](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/changelog/)
- [TextItem 类](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textitem/)
- [TextFont 类](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textfont/)

---

## 2. 清单骨架（v5，独立于 CEP 的 manifest.xml）

CEP 侧是 XML（`CSXS/manifest.xml`），UXP 侧是 JSON（`manifest.json`），两套互不识别，天然独立；安装目录也不同，不会互相覆盖。

```json
{
  "manifestVersion": 5,
  "id": "com.figmatoolbox.ps.uxp",
  "name": "盗版PS的工具箱 UXP",
  "version": "1.0.0",
  "main": "index.html",
  "host": {
    "app": "PS",
    "minVersion": "25.0",
    "data": { "apiVersion": 2, "loadEvent": "use" }
  },
  "entrypoints": [
    {
      "type": "panel",
      "id": "fontToolboxPanel",
      "label": { "default": "盗版PS的工具箱（UXP）" },
      "minimumSize": { "width": 300, "height": 320 },
      "maximumSize": { "width": 1200, "height": 2160 },
      "preferredDockedSize": { "width": 400, "height": 920 },
      "preferredFloatingSize": { "width": 400, "height": 920 },
      "icons": [
        { "width": 23, "height": 23, "path": "icons/panel-dark.png", "scale": [1, 2], "theme": ["darkest", "dark", "medium"] },
        { "width": 23, "height": 23, "path": "icons/panel-light.png", "scale": [1, 2], "theme": ["lightest", "light"] }
      ]
    }
  ],
  "requiredPermissions": {
    "localFileSystem": "fullAccess",
    "network": { "domains": [] }
  }
}
```

要点：
- `id` 必须与 CEP 的 `com.figmatoolbox.ps` **不同**；上 Marketplace 前需到 [Developer Distribution 门户](https://developer.adobe.com/developer-distribution/creative-cloud/docs/guides/plugin-id/) 申请正式 ID，本地开发用自定值即可。
- 面板标签里显式带「UXP」，与 CEP 版区分（CEF 面板标题无法与 UXP 面板同名时靠这个分辨）。
- 不声明 = 不授权：v5 起未声明的权限一律不生效（network / clipboard / localFileSystem / launchProcess 等）。
- 方案导入用了 `localFileSystem.getFileForOpening`：必须声明 `fullAccess`；写 `plugin` 只给插件私有目录，选择器会报 “Plugin is not permitted to access the file picker”。

---

## 3. CEP → UXP 调用对照（现存代码怎么搬）

| 现有 CEP 实现 | UXP 对应 | 说明 |
| --- | --- | --- |
| `csInterface.evalScript("fn(args)")` | 直接 `require("photoshop")` 后调函数 | **没有 evalScript，也没有宿主 jsx 文件**；`jsx/host.jsx` 的逻辑要重写成 panel 里的 JS 模块 |
| `executeActionGet(ref)` 读 `textKey` | `action.batchPlay([{_obj:"get", _target:[{_property:"textKey"},{_ref:"layer",_id:layerId}]}], {synchronousExecution:false})` | UXP 无 `executeActionGet`，但描述符结构相同，读回 `textKey` 的字段名一致（`textKey`/`textStyleRange`/`from`/`to`/`fontPostScriptName`/`size`…） |
| `executeAction(desc, DialogModes.NO)` 写字体 | `core.executeAsModal(async () => { await action.batchPlay([...]) })` | apiVersion 2 下**改文档状态必须在 executeAsModal 里**，否则报错；这是最容易第一版就踩的坑 |
| `app.fonts[i].postScriptName / family / style` | `app.fonts`（`TextFonts` 集合）→ `TextFont.family/style/postScriptName` | 语义一致，字段名一致；字体缺失时同样要自己兜底映射 |
| `app.activeDocument.activeLayers` / `selectedLayers` | `app.activeDocument.activeLayers`（`Layers` 集合，可读写） | UXP **没有** `selectedLayers`；多选统一走 `activeLayers` |
| `layer.kind === LayerKind.TEXT`、`layer.textItem` | 同名 API 存在 | `characterStyle`/`paragraphStyle` 均在 `textItem` 下 |
| `$.writeln` / `File` 写 `diag.log` | `require("uxp").storage.localFileSystem` | 见第 4 节第 4 条，写入位置变了 |

---

## 4. 五个必须先定掉的坑（每条都有文档或实测依据）

### 4.1 混排字体不能靠 DOM 的 `characterStyle` 做

`textItem.characterStyle.font` 是**整层**字符属性对象，没有 `from/to` 之类的区间参数；`TextItem.properties` 里也没有区间选择 API。也就是说：用 DOM 的 `characterStyle.font = cnPS` 会把**整层**字体刷成一个，正好毁掉中英混排。

→ 结论：**混排写入必须走 batchPlay 重建 `textKey`（`textStyleRange` 带 `from`/`to`）**，和现有 `host.jsx` 第 422 行附近的 `style.putString(S('fontPostScriptName'), seg.psName)` 那套描述符是同一思路，可以复用偏移计算（`from`/`to` 由 `host.jsx:483` 的 `segs` 结构算出）。

**读侧同理（补充修订）**：TextItem 页列出的成员只有 `characterStyle`、`paragraphStyle`、`warpStyle`、`contents`（整段文本，R/W，24.1）、`isPointText`/`isParagraphText`、`orientation`、`textClickPoint`、`parent`、`typename` 及 4 个转换方法——**没有任何区间级读接口**。所以「识别已有混排」在 UXP 里也拿不到逐字符字体的 DOM 读法，必须同样靠 batchPlay `get textKey` 取回 `textStyleRange` 数组。也就是说读和写两条路都离不开 descriptor，这不是「写才要 batchPlay」。
来源：[TextItem](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textitem/)、[CharacterStyle](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/characterstyle/)。

### 4.2 apiVersion 2 = 写操作全部要在模态作用域里

`minVersion >= 23.0.0` 默认 apiVersion 2；v2 下任何修改文档的调用都要包在 `core.executeAsModal(async (ctx, descriptor) => {...}, {commandName: "..."})` 里，读操作不必。写 `textKey`、改选区、切活动图层都在此列。

原文（executeAsModal 页首段）：「a modal state is required when a plugin wants to make modifications to the Photoshop state… Operations requiring a modal state include creating or modifying documents, or even updating UI or preference state.」

补充两条与「最低目标 PS 25.0」直接相关的事实：
- `batchPlay` 文档标注 **Min Version 23.0**（页面注明 *subject to change*），不是在所有 UXP 版本都可用——**修正本文早前「从最早 UXP 版就有」的说法**。
- `executeAsModal` 的 `options.timeOut` 标注 **Min Version 25.10**。25.10 之前遇到别的插件占着模态，`executeAsModal` **立刻抛 "host is in a modal state"**，不排队等待。所以在 PS 25.0 上必须把模态碰撞当成一种需要显式捕获并报告给用户的失败，不能假定会自动重试。
来源：[executeAsModal](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)、[batchPlay](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/batchplay/)。

### 4.3 面板 UI 以 CEP 为唯一来源（2026-11-26 修订）

现行实现不再维护第二套 UXP 视觉规范。`scripts/sync-uxp-ui.mjs` 直接提取 CEP 的
`<body>`、`<style>` 和唯一内联脚本，生成 UXP 的 `index.html`、`panel.css`、`cep-ui.js`。
生成时只把带 class 的静态 `<button>` 降级为 `div[role=button]`，避免 UXP 原生按钮
把文字居中、让子元素脱离 flex 布局；无 class 的诊断按钮保持原生。
UXP 只允许在独立兼容层处理引擎差异：

- `uxp-bootstrap.js`：补齐 Event/Option/NodeList/按钮控件/CSInterface。
- `uxp-adapt.js`：文件选择、保存、UXP 诊断和弹层层级。
- `uxp-compat.css`：仅补 grid、flex gap、原生输入外观、滚动容器等 UXP 缺失能力。
  其中输入框按 CEP 实测盒模型固定为 36px 高（UXP 的 `input` 不认 `line-height`，不补
  内距时占位文字会贴顶），并用同色 1px 描边遮住 UXP 对纯背景填充圆角的锯齿。
  字号/字色行以 CEP 400px 面板实测的 163/171 作为两列 `flex-grow` 权重：UXP 会忽略
  非 grow 字段的 `flex-basis`，只写 171px 时仍会被原生 input 的固有宽度撑到 223px。

任何新的视觉值都必须先进 CEP，再由同步脚本生成到 UXP。守卫见
`tests/photoshop-uxp-ui-sync.test.cjs`。
来源：[Unsupported Elements](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-html/general/unsupported-elements/)、[CSS Reference](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-css/)。

### 4.4 写日志的位置和权限变了

CEP 版把 `diag.log` 写在插件目录（`com.figmatoolbox.ps\diag.log`，实测 20207 字节）。UXP 里本地文件系统访问由 `requiredPermissions.localFileSystem` 控制，未声明时只有 `plugin://`、`plugin-temp://`、`plugin-data://`；要写任意路径得 `fullAccess`（安装时弹用户授权）。
→ 建议：UXP 版日志默认写 `plugin-data://`（免授权、可读回），需要落到用户指定路径时才要 `fullAccess`。**这一条按文档推断，真机第一版落地时验证一次 `plugin-data://` 能否直接 append。**
来源：[Manifest v5 · Plugin Permissions](https://adobedocs.github.io/uxp-photoshop/guides/uxp_guide/uxp-misc/manifest-v5/#plugin-permissions)。

### 4.5 安装方式不同：不能照抄 `install-photoshop-plugin.bat`

现状：CEP 靠「复制到 `%APPDATA%\Adobe\CEP\extensions\` + 写 `HKCU\Software\Adobe\CSXS.9\PlayerDebugMode=1`」，全用户级、无需管理员。

UXP 的机制不同，但可以做到全用户级、免管理员：
- **分发形态**是 `.ccx`（zip 包），双击交由 Creative Cloud Desktop 安装。本机实测（PS 27.x）安装结果是
  `%APPDATA%\Adobe\UXP\Plugins\External\com.figmatoolbox.ps.uxp_0.2.6`，同时写入
  `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json` 的 `plugins[]`（`path` 为
  `$localPlugins\External\...`、`status: enabled`、`type: uxp`）。这两处都是用户级，**不需要管理员权限**。
- `C:\Program Files\Common Files\Adobe\UXP\extensions\` 放的是随宿主分发的系统级插件（如
  `com.adobe.ccx.start-*`），写它才需要管理员权限；用户插件不走这里。
- `PS.json` 是 Photoshop 的已安装 UXP 插件清单。直接把目录复制进 `External` 而不写
  `PS.json`，新版 Photoshop 不保证列出该插件（这也是「启用开发人员模式」能兜底的原因）。
- **开发形态**是 UXP Developer Tool（UDT）加载源码目录；UDT 只是开发期工具，分发不需要它。

因此安装脚本可以做「复制目录 + 合并 `PS.json` 条目」，效果等同 CCX 安装，且不依赖
Creative Cloud Desktop；CEP/UXP 两个 `.bat` 仍然各自独立，互不覆盖。

来源：[Packaging Your Plugin](https://developer.adobe.com/photoshop/uxp/2022/guides/distribution/packaging-your-plugin/)、[UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/)。

### 4.6 逐层原子性有官方抓手：`hostControl.suspendHistory` / `resumeHistory`

「部分写入后失败，混排完整性未知」这个状态，在 UXP 里不一定要认命。`executeAsModal` 的执行上下文提供 `hostControl.suspendHistory({documentID, name})` 与 `hostControl.resumeHistory({suspensionID, commit})`：

- 挂起期间的改动会被合并成**一条**历史状态（名字可自定义）；
- `resumeHistory({commit: false})` 会把文档**回滚到挂起点**；
- 并且「if the target function exits via an exception, then all unsuspended history states are cancelled」——目标函数抛异常时，未提交的挂起历史会自动取消。

对实现的意义：每层写入包一层 `suspendHistory` → 写 → 回读校验 → 成功 `commit: true`，失败 `commit: false` 回滚该层改动。这样失败层的语义从「可能部分修改」升级为「该层已回滚、未改动」，比 CEP 那边的 `wholeLayerFallback()` 干净得多。

注意三点（都在真机验证项里）：
1. **粒度是文档级挂起**，不是层级。逐层要原子，就得每层一个独立的挂起/恢复窗口，不能让两层的写入落在同一窗口内。
2. 回滚是否完整恢复文本层的 `textKey`（含混合样式）**官方只保证「回滚文档状态」，未逐字说明文本属性恢复细节** —— 必须真机验证。
3. 用户中途取消（Esc / 进度条取消）时 `isCancelled` 为真，此时应立刻 return，让自动取消逻辑生效，不要继续写。

来源：[executeAsModal · History state suspension](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal#history-state-suspension)

### 4.7 阴影与按压效果要开 `CSSNextSupport`（UXP 8.0.1+）

UXP 默认不绘制 CEP 依赖的 `box-shadow`，也不应用 `transform`，所以切到 UXP 后卡片
投影、按钮悬停高亮、按下位移会全部消失。UXP 8.0.1 起提供 manifest 级开关：

```json
"featureFlags": { "CSSNextSupport": true }
```

也可只开 `["boxShadow", "transformFunctions", "transformProperties"]`。开关打开后
`box-shadow` 与 `transform` 生效；但 UXP 仍**不支持 CSS transition/animation**
（见 known issues），所以悬停/按下是即时变化，没有 CEP 的缓动过程。`filter` 也不在
支持列表里，主按钮的 `brightness(1.05)` 由兼容层用等效亮度的渐变替代。

来源：[UXP Changelog · UXP v8.0.1](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/changelog/)、
[Known Issues · CSS](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/known-issues/)。

### 4.8 变量字体必须清掉旧 `fontDesignAxes`（PS 27.4 实测）

Photoshop 27.4 在写 `textStyleRange` 时，会优先沿用克隆样式里的 `fontDesignAxes`。
旧 Light 样式带 `fontDesignAxes: [{ fontDesignAxesVectors: 300 }]`；即使同时写
`fontPostScriptName: "NotoSansSC-Medium"`、`fontName: "Noto Sans SC"`、
`fontStyleName: "Medium"`，回读仍是 `NotoSansSC-Light`。

在内存临时文档中逐项对照：保留旧轴仍为 Light；删除 `fontDesignAxes` 后立即回读为
`NotoSansSC-Medium / Medium / [500]`。因此 `buildTextKey` 改字体时必须同时删除
`fontPostScriptName`、`fontName`、`fontStyleName`、`fontScript`、`fontTechnology`、
`fontAvailable` 和 `fontDesignAxes`，再写新的字体三元组。不要重建 `baseParentStyle`，
它不是本问题的原因。

写后校验同时接受 PostScript 名匹配，或 family/style 匹配；诊断会同时显示实际
family/style，避免把 Photoshop 的规范化回读误报成替换。

### 4.9 Windows UXP 的圆角/文字抗锯齿限制

UXP Windows 对纯背景填充的圆角不做可靠抗锯齿，对描边的渲染明显更好。兼容层因此给
无边框的圆角输入框、浅色提示条补同色 1px 描边，并相应减 1px 内距，保持 CEP 的盒尺寸
和文字落点。没有可靠的 CSS 级文字抗锯齿开关：官方 CSS 支持表没有
`font-smoothing`/`text-rendering`，也不能用 `filter`、`translateZ()` 或
`border-image` 代替。文字边缘由 UXP/Windows 字体后端决定，只能保证字号、字重、颜色和
位置一致，不能承诺与 CEP 像素级相同。

### 4.10 视觉字距必须写 `CharacterStyle.autoKerning`

UXP 的公开 DOM 把字距微调放在 `TextItem.characterStyle.autoKerning`，类型为
`AutoKernType`，不是 `TextItem.autoKerning`。旧实现用 batchPlay 写入
`{_obj:'textLayer', autoKerning:...}`，随后通过 `_property:'textKey'` 回读；但
`autoKerning` 是文本层属性，不属于 `textKey` 描述符，因此真实 Photoshop 的每次回读都
缺少该字段，14 个图层会被全部误报成「视觉字距未生效」。

当前实现改为对每个选中文本层：

```js
layer.textItem.characterStyle.autoKerning = ps.constants.AutoKernType.OPTICAL;
const back = layer.textItem.characterStyle.autoKerning;
```

再按枚举值回读校验。本机 Photoshop 2026 的 `AutoKernType.OPTICAL` 实际字符串是
`"opticalKern"`；兼容层同时接受 CEP 写法 `"optical"` 和描述符
`{_enum:'autoKernType',_value:'opticalKern'}`，避免把合法回读误判为失败。与 CEP 的
`TextItem.autoKerning = AutoKernType.OPTICAL` 语义一致，也不依赖 `textKey` 的附加字段。

来源：[UXP CharacterStyle](https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/characterstyle/)、
[UXP TextItem](https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/textitem/)。

### 4.11 弹层互斥与原生输入遮挡

方案选择器和字体/格式通用下拉共用全局弹层状态：打开任意一个之前先调用
`closeAllPickers()`，保证同一时刻只有一个下拉菜单展开。不能只依赖各自的
`document.click` 监听，否则两个菜单可以同时保留 `.open`。

UXP 的原生文本输入永远绘制在 HTML 之上，`z-index` 无效。兼容层不能再用
`body.popup-open` 隐藏整个面板的输入：这会让弹层之外的字号、字色等字段一起消失。
现在由 `uxp-adapt.js` 读取所有展开弹层的 `getBoundingClientRect()`，只给矩形实际相交
的输入加 `.uxp-popup-under`；弹层之外（包括弹层下方的字号/字色）保持可见。弹层自身
的搜索框不参与遮罩。

### 4.12 字色可以调 Photoshop 官方拾色器，但不能用 `app.showColorPicker`

CEP 的 `app.showColorPicker()` 是 ExtendScript 接口。Photoshop UXP 的公开 `app` 文档里
没有同名方法；当前 `host.js` 的 `ps.app.showColorPicker(true)` 不能作为可靠实现。正确
路径是 `core.executeAsModal()` 内执行 batchPlay：

```js
const openPicker = {
  _target: { _ref: 'application' },
  _obj: 'showColorPicker',
  context: '选择字色',
  color: { _obj: 'RGBColor', red: r, green: g, blue: b },
};

const result = await require('photoshop').action.batchPlay([openPicker], {});
const rgb = result[0].RGBFloatColor;
// rgb.red / rgb.grain / rgb.blue 通常为 0..255 浮点
```

必须在 `executeAsModal` 中调用；本机 Adobe 自带 UXP 插件
`com.adobe.photoshop-material-filters/index.js:1555` 就是这种写法。返回颜色不能用
`app.foregroundColor` 读取，32 位/高精度文档可能报
`RGB in 32 bits per channel precisions is currently not supported`。

兼容注意事项：

- 用户取消时返回 `result[0].value === false`，且没有 `RGBFloatColor`；此时必须保留原字色。
- 绿色通道的宿主键名是 `grain`（遗留命名），不是 `green`。Lab 显示模式下还可能出现
  `greenFloat`（0..1），需乘 255；所有通道最终夹紧到 0..255。
- 已知 2026 年论坛 bug：在 `dialog.uxpShowModal` 外层弹窗中调用拾色器，约 1/20 概率会
  取消外层 UXP 弹窗；普通面板调用不涉及该外层弹窗，风险较低。
- 面板的两个字色字段现在是「文本框 + 右侧 30×36px 色块」。文本框保留十六进制手输，
  色块统一触发 Photoshop 官方拾色器；CEP 和 UXP 共用同一份 HTML，因此入口行为一致。
- 色块必须与输入框 flex 并排，不能绝对定位覆盖在输入框内部：UXP 的原生 input 始终
  绘制在 HTML 之上，覆盖层会被输入框挡住。
- `host.js` 的 `pickColor()` 返回 `{ok:true,r,g,b}`、`{ok:false,canceled:true}` 或
  `{ok:false,busy:true}`。取消或重复点击不能改写面板现有字色。

来源：本机 Adobe 自带实现
`C:\Program Files\Adobe\Adobe Photoshop 2026\Required\UXP\com.adobe.photoshop-material-filters\index.js`、
[Unable to show the color picker](https://forums.creativeclouddeveloper.com/t/unable-to-show-the-color-picker/5007)、
[取消返回值](https://forums.creativeclouddeveloper.com/t/uxp-get-user-adjustments-from-displayed-dialog/2372)、
[`grain` / `greenFloat`](https://forums.creativeclouddeveloper.com/t/color-picker-return-error-rgbfloatcolor-uses-grain-label-instead-of-green/4853)、
[32 位限制](https://forums.creativeclouddeveloper.com/t/color-picker-domerror-rgb-in-32-bits-per-channel-precisions-is-currently-not-supported/7470)、
[UXP 弹窗取消 bug](https://forums.creativeclouddeveloper.com/t/12184)。

### 4.13 交互卡顿：先消掉周期性布局读取，不要给所有控件上 rAF

UXP 官方 known issues 明确不支持 CSS transition/animation；论坛也建议用
`requestAnimationFrame` 代替，但同时提醒持续 rAF 会明显增加 CPU 占用。因此本轮没有做
全量补间，只处理会实际造成掉帧的路径：

1. `uxp-adapt.js` 原实现每 100ms 无条件扫描所有输入并调用 `getBoundingClientRect()`；
   现在改为点击/输入/滚动/resize 后合并到一次 16ms 调度，无弹层时直接返回，class
   不变时不重复 toggle。
2. 选区轮询改为 700ms，并在滚动、点击、输入聚焦、弹层打开期间暂停；避免滚动时跨进程
   遍历 `activeLayers`。
3. 字体搜索和方案搜索加 90ms 防抖；列表高度变化后 120ms 再校准一次遮挡区域。
4. 只对弹层展开和标签页切换做 150~180ms 的 `opacity`/`transform` 补间，并保证结束后
   清除 inline style；其他交互保持即时切换。

Chromium DOM 级验证结果：空闲 1 秒的布局读取从约 80 次降到 0；弹层打开/关闭、输入
遮挡 class、滚动暂停和补间清理均通过。真正的 UXP Windows 帧率仍需在 Photoshop 真机
验收。

来源：[UXP Known Issues · CSS](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/known-issues/)、
[CSS Animations 论坛回复](https://forums.creativeclouddeveloper.com/t/css-animations/1103)、
[rAF CPU 提醒](https://forums.creativeclouddeveloper.com/t/indeterminate-progress-bar/3152)。

---

## 5. 交给实现方的验收点（我方核对用）

1. 清单：`manifestVersion 5`、`host.minVersion >= 25.0`、`data.apiVersion 2`、`id` 与 CEP 的 `ExtensionBundleId` 不同、面板标签带 UXP。
2. 写操作 100% 在 `executeAsModal` 内；无一处 `characterStyle.font =` 直接刷整层。
3. 多选图层走 `activeLayers`，单层回退逻辑保留（对应 CEP 版 `activeLayerSource()` 的合并策略）。
4. 中英混排按 `textStyleRange` 的 `from`/`to` 分段写入，写后回读核验（对应 `host.jsx:452` 之后的回读段）。
5. 字体映射不到时返回 `null` 并**提示用户**，不允许控件保留旧值（对应 `host.jsx:757` `detectFontMix()` 的 `cnFont:null` 现象）。
6. 日志落在 `plugin-data://`（或明确声明的 `fullAccess` 路径），不写插件包目录。
7. 两套安装脚本：CEP 走 APPDATA 复制，UXP 走「External 目录复制 + `PS.json` 注册」或 `.ccx` 解包，互不触碰对方目录。

---

## 6. 未验证项（不得当成结论用）

- `plugin-data://` 的 append 行为、以及它在本机 PS 27.4 上的实际落盘路径：**未实测**。
- UXP 面板在 PS 27.4 上的最小/最大尺寸是否与清单声明一致：**未实测**。
- 本机通过 Creative Cloud Desktop 安装 `.ccx` 已实测（落到用户级 `External\<id>_<version>` 并写入 `PS.json`）；脚本直接复制并写 `PS.json` 的等价流程已通过批处理测试，但**未在未安装 CC Desktop 的干净机器上实测**。
- `suspendHistory` / `resumeHistory({commit:false})` 能否完整回滚文本层的 `textKey`（含混合区间样式）：**官方只保证回滚文档状态，未逐字说明文本属性恢复；必须真机验证**。
- PS 25.0 上 `executeAsModal` 模态碰撞的实际抛错文本与恢复行为：**未实测**（文档称 25.10 之前立即抛错）。
- `document.activeLayers` 写入（26.9+）在 PS 27.4 上设置选区是否影响用户当前选择状态：**未实测；首版设计不使用写选区**。
