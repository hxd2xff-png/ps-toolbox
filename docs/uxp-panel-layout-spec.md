# UXP 面板 UI 规范

## 当前口径（2026-11-26）

UXP 面板以 CEP 为唯一 UI 源，不单独定义布局规范。

- `com.figmatoolbox.ps.uxp/index.html` 的 `<body>` 来自
  `com.figmatoolbox.ps/index.html`；只做两类引擎适配：
  - 把带 class 的静态 `<button>` 降级为 `div[role=button]`（保留 id/class/子节点/事件），
    避免 UXP 原生按钮把内容居中、子元素不参与 flex，导致标题行和双列字段错位；
  - 把 CEP 脚本替换为 UXP 三段入口脚本。
- `com.figmatoolbox.ps.uxp/panel.css` 与 CEP 的 `<style>` 全文逐字一致。
- `com.figmatoolbox.ps.uxp/cep-ui.js` 是 CEP 内联脚本原文，只允许以下引擎替换：
  - `new Event` → `window.__uxpEvent`
  - `new Option` → `window.__uxpOption`
  - `.append(` → `.appendChild(`
  - `createElement('button')` → `window.__uxpButton()`
  - `localStorage` → `window.localStorage`
  - 搜索框自动聚焦关闭
  - `selectedOptions` 增加 `options + value` 回退
  - 默认方案行 `innerHTML` 改用 `appendChild`
  - 宿主期望版本替换为 manifest 版本
- 视觉差异只允许出现在 `uxp-compat.css`，且仅限 UXP 引擎能力缺口：
  - body 滚动容器
  - `display:grid` → flex
  - 多层渐变网格 → SVG 平铺
  - 原生输入框外观复位
  - 无 flex gap 时的等效外边距
  - UXP 只稳定支持 flex longhand：`flex:1` / `flex:none` 展开为
    `flex-grow` / `flex-shrink` / `flex-basis`
  - 原生输入框 `margin:0`，避免标签与输入框之间出现默认大间距
  - 静态按钮转成 div 后补回 `inline-flex` / `text-align:center` 盒模型
  - 弹层打开时隐藏会被 UXP 画在上层的面板输入框
  - opacity 不可靠时的 visibility 显隐

## 同步

```powershell
node scripts/sync-uxp-ui.mjs
```

## 守卫

`tests/photoshop-uxp-ui-sync.test.cjs` 逐字校验：

1. UXP `<body>` = CEP `<body>` + 白名单按钮降级；
2. `panel.css` = CEP `<style>`；
3. `cep-ui.js` = CEP 内联脚本 + 白名单替换；
4. 入口脚本顺序固定；
5. 旧 `main.js` / `panel.js` / `boot-diagnostics.js` 不再存在。

这些是源码一致性守卫，不代表 UXP 真机渲染已经通过。
