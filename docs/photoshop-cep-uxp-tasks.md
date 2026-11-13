# Photoshop CEP 与 UXP 插件实现任务

日期：2026-11-12  
状态：用户已批准；阶段 B-D 执行中，真机验收待用户配合

## 执行原则

任务仅覆盖 CEP 现有插件修复与独立 UXP 插件新增。不可改动 Figma 部分或另一份 CEP 副本；不得提交/推送。不得自动启动 Photoshop、服务、浏览器或安装器，不得写真实安装目录/注册表。设备路径运行时动态解析。每一项须先检查任务匹配技能与技能目录；实现期间以文件、静态检查、单元测试和用户配合的真机测试为证。完成状态必须注明命令、输出及覆盖范围。

## 阶段 A：确认基线和隔离

- [x] A1 记录当前分支、工作树差异和所有目标文件现状；保留已有用户改动，不清理无关变更。
- [ ] A2 确认 CEP 主目录、现有安装/卸载脚本和相关测试；对比第二份 CEP 副本只读记录，不同步、不修改。
- [ ] A3 建立两套包边界检查：CEP `com.figmatoolbox.ps`；UXP `com.figmatoolbox.ps.uxp`。静态约束禁止 UXP 打包/卸载路径触及 CEP 路径，反向亦然。

## 阶段 B：CEP 修复

- [x] B1 选区收集：实现合并 DOM 多选集合和 Action Manager 目标层 ID，去重并展开已选组；按逐层结果报告覆盖数。CEP 宿主实际多选返回仍待 PS 21.x 真机确认。
- [x] B2 字体识别：扫描全部被收集文本层的目标字符 ranges；按一致值/混合/未识别聚合。离线契约测试覆盖聚合与诊断；PS 真机待验。
- [x] B3 UI 识别状态：结构化字段状态及清旧值/手动保护/方案保护由 CEP 契约测试覆盖；PS 真机待验。
- [x] B4 安全应用：关闭混排异常后的自动整层 DOM 回退，逐层隔离并按写入尝试状态报告完整性；PS 21.x 真机异常注入待验。
- [x] B5 回归测试：CEP 离线覆盖选择、聚合、清旧值及保护和无自动回退；UXP descriptor/modal 与真机状态仍列待验。

## 阶段 C：独立 UXP 首版

- [x] C1 包结构：新增独立 v5 manifest、面板 UI、API 模块及安装说明；ID `com.figmatoolbox.ps.uxp`、host `PS`、`minVersion: "25.0"`、`apiVersion: 2`，面板标签含 UXP。
- [x] C2 Selection/API adapter：仅读 `document.activeLayers`、展开组并筛选文本层；静态测试检查没有 CEP/ExtendScript API 和选区赋值。UXP 运行时选择行为待真机确认。
- [x] C3 字体与识别：实现 app.fonts 映射及一致/混合/未识别/空/错误状态，离线聚合测试通过；PS 字体库映射待真机确认。
- [x] C4 混排区间读写：实现 batchPlay textKey 区间读写、executeAsModal 与逐区间回读逻辑；静态/纯逻辑覆盖不构成 PS descriptor 真机验证。
- [ ] C5 Descriptor/回滚真机门：先在 PS 27.4 验证区间读、最小范围写、回读、模态碰撞捕获；每层独立 `suspendHistory`，失败 `resumeHistory({commit:false})` 后逐区间回读确认样式复原；验证取消信号时立即退出 modal 函数。再覆盖最低目标 PS 25.0。Adobe 未公开的 descriptor schema、逐层原子回滚和混排恢复在此门通过前不得标记实现完成或发布。
- [ ] C6 错误、日志与 UI：UXP 独立 UI 和错误处理；权限最小化；日志路径及 append 行为先验证。未验证的 plugin-data append 不写成已支持保证。
- [x] C7 安装资料：UXP README 单列 UDT 开发加载和 `.ccx` 分发；未执行安装或打包。

## 阶段 D：跨版本验证与交付

- [x] D1 离线测试：CEP 33 项与 UXP 14 项（含假宿主取消/回滚/模态/逐层隔离、applyFontMix 三类回读结果分流、结果文案渲染）离线测试通过；Photoshop descriptor、CEP 错误回读顺序及真机行为仍待验。
- [ ] D2 CEP 真机：用户在 PS 2020（21.x）验证选区收集、检测回填、混排应用、回读与故障报告；另覆盖工作区声明的最低 CEP 目标版本（若不是 21.x，应先修订需求）。
- [ ] D3 UXP 真机：用户在最低目标 PS 2024（25.0）与 PS 27.4 验证加载、activeLayers 多选读取、字体检测、modal 写入及模态碰撞提示、混排回读、suspendHistory 失败回滚后样式复原、取消响应和卸载隔离。
- [ ] D4 交付报告：逐项给出命令/输出、静态与单元测试结果、两平台真机证据、未验证项；不把测试通过等同于安装部署成功，用户未执行安装时明确标为未部署。

## 验收矩阵

| 能力 | CEP PS 21.x | UXP PS 25.0 | UXP PS 27.4 |
| --- | --- | --- | --- |
| 单层文本识别与回填 | 真机 | 真机 | 真机 |
| 多选文本层收集及组展开 | 真机；记录实际 CEP host 行为 | 真机 activeLayers | 真机 activeLayers |
| 跨层字体一致/冲突/未识别显示 | 真机 | 真机 | 真机 |
| 失败清理旧值与用户/方案保护 | UI 单测 + 真机 | UI 单测 + 真机 | UI 单测 + 真机 |
| 多行中英混排 range 应用/回读 | 真机 | batchPlay 真机 | batchPlay 真机 |
| 单层异常隔离及失败恢复 | 注入/可复现失败测试 + 真机 | suspendHistory 回滚 + 逐区间复核，未确认前标状态未知 | suspendHistory 回滚 + 逐区间复核，未确认前标状态未知 |
| 整层回退不会静默破坏混排 | 静态检查 + 真机异常场景 | 不适用，不提供该路径 | 不适用，不提供该路径 |
| 安装包/目录/ID 隔离 | 静态测试；用户自行安装验收 | manifest/包静态检查；用户选择安装方式验收 | manifest/包静态检查；UDT 或用户验收 |
| 日志路径/追加 | CEP 现有日志路径行为 | plugin-data 需实测 | plugin-data 需实测 |

## 未决项与阻塞门

- [ ] UXP `textKey` descriptor 的字段/单位需 PS 真机验证；Adobe 文档不提供该完整 schema。`suspendHistory` 回滚是否恢复 textKey 混排、逐层独立挂起是否可行也需真机验证；回读确认前保留“状态未知/可能部分修改”结果。
- [ ] CEP 不同版本对 activeLayers/selectedLayers 的暴露差异需日志与 PS 21.x 真机确认；不可用旧日志推断当前多选结果。
- [ ] `plugin-data://` append、UXP 面板尺寸、`.ccx` 本地安装尚未实测；详见 [UXP_API_VERIFICATION.md](UXP_API_VERIFICATION.md) §6。
- [ ] UXP 最低目标 PS 25.0 的可用安装/测试环境由用户提供；本机仅有 PS 27.4 的运行记录不代表已验证最低版本。PS 25.0 的 `executeAsModal` 模态碰撞抛错与提示恢复行为需实测；不使用 25.10 才有的 `timeOut` 选项。
