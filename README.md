# 盗版PS的工具箱

Photoshop 字体混排插件，同时提供 CEP 与 UXP 两个版本。两套面板保持同一套
HTML/CSS/交互规范，UXP 侧只补运行时兼容层。

## 功能

- 中文、英文分别设置字体、字号与字色，一键混排；
- 中英文符号归属切换、视觉字距与行距自动；
- 方案预设保存、更新、导入和导出；
- 字色文本框右侧色块调用 Photoshop 官方拾色器；
- CEP 支持 Photoshop 2019（20.0）及以上，UXP 支持 25.0 及以上。

## 目录

| 路径 | 说明 |
| --- | --- |
| `com.figmatoolbox.ps/` | CEP 插件本体 |
| `com.figmatoolbox.ps.uxp/` | UXP 插件本体 |
| `install-photoshop-plugin.bat` | Windows CEP 安装 |
| `install-photoshop-uxp-plugin.bat` | Windows UXP 便携安装 |
| `install-photoshop-uxp-from-ccx.bat` | 从 CCX 安装 UXP |
| `scripts/build-uxp-package.mjs` | 生成 UXP CCX 与便携 ZIP |
| `tests/` | CEP/UXP 回归测试 |
| `docs/` | 安装、架构与 UXP API 验证文档 |

## 开发

UXP 的 `index.html`、`panel.css` 与 `cep-ui.js` 由 CEP 源文件生成：

```powershell
node scripts\sync-uxp-ui.mjs
node tests\photoshop-uxp-core.test.cjs
node tests\photoshop-uxp-ui-sync.test.cjs
node tests\photoshop-uxp-bridge.test.cjs
node tests\photoshop-uxp-install-scripts.test.cjs
node scripts\build-uxp-package.mjs
```

安装或更新插件前请完全退出 Photoshop。详细步骤见
`docs/PS_PLUGIN_INSTALL_TUTORIAL.md`、`com.figmatoolbox.ps/README.md` 和
`com.figmatoolbox.ps.uxp/README.md`。
