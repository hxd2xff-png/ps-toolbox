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
    "localFileSystem": "plugin",
    "network": { "domains": [] }
  }
}
```

要点：
- `id` 必须与 CEP 的 `com.figmatoolbox.ps` **不同**；上 Marketplace 前需到 [Developer Distribution 门户](https://developer.adobe.com/developer-distribution/creative-cloud/docs/guides/plugin-id/) 申请正式 ID，本地开发用自定值即可。
- 面板标签里显式带「UXP」，与 CEP 版区分（CEF 面板标题无法与 UXP 面板同名时靠这个分辨）。
- 不声明 = 不授权：v5 起未声明的权限一律不生效（network / clipboard / localFileSystem / launchProcess 等）。

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

### 4.3 面板 UI 要按 UXP 的 HTML/CSS 子集重做，不能指望 CEF 那套

UXP 只支持文档列出的元素，`<ul>/<li>/<ol>/<title>/<i>` 等按 `<div>` 处理；不存在浏览器般的完整 DOM 与 CSS 支持。现有 `index.html` 有 84 KB，CEP 专有对象（`window.cep`、`CSInterface`）在 UXP 里根本不存在。
→ 结论：UI 层按「同功能、重写结构和样式」估工，不做逐行移植。
来源：[Unsupported Elements](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-html/general/unsupported-elements/)、[CSS Reference](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-css/)。

### 4.4 写日志的位置和权限变了

CEP 版把 `diag.log` 写在插件目录（`com.figmatoolbox.ps\diag.log`，实测 20207 字节）。UXP 里本地文件系统访问由 `requiredPermissions.localFileSystem` 控制，未声明时只有 `plugin://`、`plugin-temp://`、`plugin-data://`；要写任意路径得 `fullAccess`（安装时弹用户授权）。
→ 建议：UXP 版日志默认写 `plugin-data://`（免授权、可读回），需要落到用户指定路径时才要 `fullAccess`。**这一条按文档推断，真机第一版落地时验证一次 `plugin-data://` 能否直接 append。**
来源：[Manifest v5 · Plugin Permissions](https://adobedocs.github.io/uxp-photoshop/guides/uxp_guide/uxp-misc/manifest-v5/#plugin-permissions)。

### 4.5 安装方式不同：不能照抄 `install-photoshop-plugin.bat`

现状：CEP 靠「复制到 `%APPDATA%\Adobe\CEP\extensions\` + 写 `HKCU\Software\Adobe\CSXS.9\PlayerDebugMode=1`」，全用户级、无需管理员。

UXP 没有等价机制：
- **分发形态**是 `.ccx`（zip 包），双击交由 Creative Cloud 安装，落到 `C:\Program Files\Common Files\Adobe\UXP\extensions\<id>`（本机该目录已有 `com.adobe.ccx.start-*` 等实例），**写这个目录要管理员权限**；
- **开发形态**是 UXP Developer Tool（UDT）加载源码目录，UDT 本身要求提权运行；
- Adobe 未提供「放文件夹即生效」的 UXP 安装法，因此**安装脚本必须重写**，且 CEP/UXP 两个 `.bat` 各自独立，互不覆盖。

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

---

## 5. 交给实现方的验收点（我方核对用）

1. 清单：`manifestVersion 5`、`host.minVersion >= 25.0`、`data.apiVersion 2`、`id` 与 CEP 的 `ExtensionBundleId` 不同、面板标签带 UXP。
2. 写操作 100% 在 `executeAsModal` 内；无一处 `characterStyle.font =` 直接刷整层。
3. 多选图层走 `activeLayers`，单层回退逻辑保留（对应 CEP 版 `activeLayerSource()` 的合并策略）。
4. 中英混排按 `textStyleRange` 的 `from`/`to` 分段写入，写后回读核验（对应 `host.jsx:452` 之后的回读段）。
5. 字体映射不到时返回 `null` 并**提示用户**，不允许控件保留旧值（对应 `host.jsx:757` `detectFontMix()` 的 `cnFont:null` 现象）。
6. 日志落在 `plugin-data://`（或明确声明的 `fullAccess` 路径），不写插件包目录。
7. 两套安装脚本：CEP 走 APPDATA 复制，UXP 走 `.ccx`／UDT，互不触碰对方目录。

---

## 6. 未验证项（不得当成结论用）

- `plugin-data://` 的 append 行为、以及它在本机 PS 27.4 上的实际落盘路径：**未实测**。
- UXP 面板在 PS 27.4 上的最小/最大尺寸是否与清单声明一致：**未实测**。
- `.ccx` 打包可否在无 Adobe 开发者账号的机器上本地安装（文档说会提示「未验证插件」并可选择 Install locally）：**未在本机实测**。
- `suspendHistory` / `resumeHistory({commit:false})` 能否完整回滚文本层的 `textKey`（含混合区间样式）：**官方只保证回滚文档状态，未逐字说明文本属性恢复；必须真机验证**。
- PS 25.0 上 `executeAsModal` 模态碰撞的实际抛错文本与恢复行为：**未实测**（文档称 25.10 之前立即抛错）。
- `document.activeLayers` 写入（26.9+）在 PS 27.4 上设置选区是否影响用户当前选择状态：**未实测；首版设计不使用写选区**。
