# Photoshop 字体混排 UXP

独立于现有 CEP 插件，支持 Photoshop 2024（25.0）及以上。插件 ID：`com.figmatoolbox.ps.uxp`；面板名称：`字体混排 UXP`。UXP 文件均留在本目录，不调用 CEP JSX、安装器或注册表配置。

## 开发加载

1. 安装并启动 Adobe UXP Developer Tool（UDT）。
2. 选择 Add Plugin，指向本目录中的 `manifest.json`，再加载 `字体混排 UXP` 面板。
3. 在 Photoshop 中打开 `Plugins > 字体混排 UXP`。CEP 版可并行保留，二者有不同 ID 和面板名。

## `.ccx` 分发

使用 Adobe UXP Developer Tool 的 Pack 功能，选择本目录作为插件根目录并生成 `.ccx`。将包交由 Creative Cloud 桌面应用安装；本项目不提供会写入系统插件目录的安装脚本。安装/卸载由 Adobe 的插件管理界面完成。打包或加载前不要把该目录复制到 CEP extensions 目录。

## 当前功能与边界

- 从 `document.activeLayers` 读取选择，展开组并筛选文本层；不会写入选区。区间级样式读取和写入均使用 batchPlay，DOM 仅用于文档、图层和字体库信息。
- 区间样式通过 batchPlay 读取/写入 `textKey.textStyleRange`；文档修改使用 `executeAsModal`。支持按中英字符区间分别设置字体、字号、tracking 字距与可选颜色。
- 写入后逐区间回读。失败时尝试 `suspendHistory` 回滚，并仅在读回样式与原始样式一致时报告回滚成功。
- 字体方案只保存在 UXP 插件本地数据存储；不写完整文本或诊断日志。

## 离线检查

从仓库根目录运行：

```powershell
node tests/photoshop-font-mixer.test.cjs
node tests/photoshop-uxp-core.test.cjs
```

这些测试覆盖纯逻辑和包静态边界，不模拟 Photoshop descriptor 引擎。textKey descriptor 兼容性、PS 25.0 activeLayers 多选、modal 冲突、实际区间写入/回读以及 suspendHistory 对混排样式的恢复，仍须在 Photoshop 25.0 和 27.4 真机验收；离线通过不代表已加载、安装或真机通过。
