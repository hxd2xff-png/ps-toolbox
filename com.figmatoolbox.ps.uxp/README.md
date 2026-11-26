# Photoshop UXP 适配层

插件 ID：`com.figmatoolbox.ps.uxp`。支持 Photoshop 2024（25.0）及以上。

## UI 唯一来源

UXP 不再维护第二套界面。`index.html` 的 `<body>`、`panel.css` 和交互脚本均从
`com.figmatoolbox.ps/index.html` 生成：

- `index.html`：CEP `<body>` 原文，去掉 CEP 脚本后换成 UXP 三段入口脚本；
  带 class 的静态按钮在生成时降级为同 `id` / `class` 的 `div[role=button]`。
- `panel.css`：CEP `<style>` 全文，逐字一致。
- `cep-ui.js`：CEP 唯一内联脚本原文，仅替换 UXP 缺失的 DOM/JS 能力。
- `uxp-compat.css`：只处理 UXP 不支持的 CSS 能力，不定义新的视觉规范。

同步命令：

```powershell
node scripts/sync-uxp-ui.mjs
```

不要手改 `index.html`、`panel.css`、`cep-ui.js`。`tests/photoshop-uxp-ui-sync.test.cjs`
会逐字校验它们与 CEP 的对应关系。

## 引擎适配

- `uxp-bootstrap.js`
  - 补齐 `Event` / `Option` / `Element.append` / `NodeList.forEach` / `closest` 等运行时差异。
  - 提供 `CSInterface` 兼容层，把 CEP 的 `evalScript(hostCallExpr)` 转成 `host.js` 的 `dispatch`。
  - 静态 `<button>` 在业务脚本绑定事件前换成同 `id` / `class` 的 `div[role=button]`，避免 UXP 原生按钮吞掉子元素布局和点击。
  - `localStorage` 不可用时退化为会话内存。
- `uxp-adapt.js`
  - 导入方案：`localFileSystem.getFileForOpening`。
  - 导出方案：`localFileSystem.getFileForSaving`。
  - 诊断按钮：直接读取 UXP 宿主诊断，不进入 CEP ExtendScript 路径，不弹 Photoshop 原生警告。
  - 弹层同步改为事件驱动：只在点击、输入、滚动、resize 后执行，不再每 100ms 查询全部输入并读取布局。
  - 只隐藏与展开弹层实际重叠的原生输入；弹层关闭时一次性恢复，不重复切换 class。
  - 选区轮询在滚动、点击、输入、弹层打开期间暂停；CEP 原来的 500ms 轮询在 UXP 副本中降为 700ms。
  - 字体搜索和方案搜索加 90ms 防抖，避免每个按键都清空并重建最多 40~120 行 DOM。
  - UXP 不支持 CSS transition/animation；仅对弹层展开和标签页切换用 `requestAnimationFrame` 做 150~180ms 的
    `opacity`/`transform` 短补间，不逐帧改布局，也不给所有控件加持续动画。
- `uxp-compat.css`
  - 只补滚动容器、grid→flex、SVG 网格背景、原生输入外观、无 flex-gap 时的等效间距和勾选/删除显隐。
  - flex 简写展开为 longhand；原生输入框清零默认 margin，按 CEP 的 36px 盒高做垂直居中，
    并用同色 1px 描边遮住 UXP 对纯背景填充圆角的锯齿（描边内侧距等效为 8px 10px）。
  - 字号/字色行以 CEP 400px 面板实测的 163/171 作为两列 `flex-grow` 权重。UXP 会忽略
    非 grow 字段的 `flex-basis`，只写 171px 仍会被原生 input 的固有宽度撑成 223px。
  - UXP 对文字边缘没有可靠的 CSS 抗锯齿开关；`-webkit-font-smoothing` 只保留为最佳努力。
  - 按钮 div 补回 CEP 的盒模型和文字对齐；主按钮悬停用等效亮度渐变替代 UXP 不支持的 `filter`。
  - 方案选择器和字体/格式通用下拉共用全局状态，打开任意一个先收起其余弹层。
  - UXP 原生输入框只在它与展开弹层实际重叠时隐藏；弹层之外的字号/字色等字段保持可见。
  - 字色是「文本框 + 30×36px 色块」横向组合。色块不能覆盖在 input 上（UXP 原生输入
    始终画在 HTML 之上），所以用 flex 并排，并保留 CEP 的 36px 盒高与圆角。
- `manifest.json` 的 `featureFlags.CSSNextSupport = true`
  - UXP 8.0.1+ 用它开启 `box-shadow`、`transform` 等 CSS 能力；不开时卡片投影、悬停高亮、按下位移都会消失。
  - UXP 仍不支持 CSS transition/animation；除上面两处有限 JS 补间外，其余状态仍是即时切换。

## 宿主行为

- 选区读取使用 `document.activeLayers`，展开组并筛选文本层；`LayerKind` 不可读时按结构判断。
- 区间样式通过 batchPlay 读写 `textKey.textStyleRange`，文档修改全部在 `executeAsModal` 内。
- 字号按 CEP 的方式写入面板值；Photoshop 回读的是变换前基准值，校验时再乘图层缩放。
- 写入后多次回读，允许 Photoshop 短暂延迟。
- 字体被 Photoshop 替换按「字体被替换」上报，不回滚、不算失败。
- 变量字体写完整 `fontPostScriptName`/`fontName`/`fontStyleName`，同时删除从旧区间继承的
  `fontDesignAxes`；否则 Light 的轴值 300 会覆盖 Medium 请求，回读仍是 Light。
- 视觉字距写 `layer.textItem.characterStyle.autoKerning = AutoKernType.OPTICAL`，再读回同一
  属性校验；Photoshop 2026 的枚举实际值是 `"opticalKern"`，校验同时接受 `"optical"`。
  `autoKerning` 不属于 batchPlay 的 `textKey`，不能从 `textKey` 判断成功。
- 字号被 Photoshop 静默拒绝时，自动退回只应用字体和颜色，并在状态栏说明。
- 字色调用 `executeAsModal()` 内的 `batchPlay({_obj:'showColorPicker'})`，读取
  `RGBFloatColor`；取消不改写原值，重复点击由宿主 busy 锁拦截。不会改写前景色。
- 真失败使用 `suspendHistory` / `resumeHistory` 回滚，并逐区间复核。

## 开发加载与分发

1. 安装 UXP Developer Tool。
2. Add Plugin 指向本目录的 `manifest.json`。
3. 分发包使用：

```powershell
node scripts/build-uxp-package.mjs
```

   一次产出 `output/*.ccx` 和 `output/*-portable-*.zip`，并重新生成
   `output/font-mixer-uxp-latest.ccx`。

## 不依赖 Creative Cloud Desktop 的安装

`.ccx` 本身是 zip，双击安装依赖 Creative Cloud Desktop。没有客户端时用仓库根目录的
脚本：

- `install-photoshop-uxp-plugin.bat`：把 `com.figmatoolbox.ps.uxp/` 复制到
  `%APPDATA%\Adobe\UXP\Plugins\External\com.figmatoolbox.ps.uxp`。
- `install-photoshop-uxp-from-ccx.bat`：把 `.ccx` 解包后走同一条安装流程，可把
  `font-mixer-uxp-latest.ccx` 直接拖到脚本上。

两个脚本都会：

1. 清理旧的 `com.figmatoolbox.ps.uxp_<version>` 目录，避免 Photoshop 继续加载旧 host；
2. 通过 `uxp-plugin-register.ps1` 写入
   `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json`。`PS.json` 是 Photoshop 记录“已安装
   UXP 插件”的清单，CCX 安装器会写它；不写的话新版 Photoshop 不一定会列出直接复制
   进 `External` 的目录；
3. 更新前备份为 `PS.json.bak`，`PS.json` 解析失败时拒绝覆盖并报错。

`uninstall-photoshop-uxp-plugin.bat` 会删除插件目录、旧版本目录和 `PS.json` 中对应的
条目。安装/卸载后都需要重启 Photoshop；安装前关闭 Photoshop 可以避免它用内存里的旧
插件列表覆盖 `PS.json`。

## 离线检查

```powershell
node tests/photoshop-uxp-core.test.cjs
node tests/photoshop-uxp-ui-sync.test.cjs
node tests/photoshop-uxp-bridge.test.cjs
node tests/photoshop-uxp-install-scripts.test.cjs
```

这些测试只证明源码边界、纯逻辑和生成关系。实际字体替换、缩放文本层、文件选择器权限、
transfer history 回滚仍需在 Photoshop 真机验收。
