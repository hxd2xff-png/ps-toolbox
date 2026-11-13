# Photoshop CEP 与 UXP 字体混排插件需求

日期：2026-11-12  
状态：用户已确认设计；实现进行中（真机验证未完成）

## 1. 目标与边界

维护两套可独立识别、安装和运行的 Photoshop 字体混排插件：修复现有 CEP 版，同时新增独立 UXP 版。CEP 保留现有产品标识、目录和 PS 2020（21.x）适配目标；UXP 首版目标为 Photoshop 2024+，manifest `host.minVersion` 使用 `25.0`。两套产品不共享运行时入口，不覆盖对方安装目录。

首阶段仅定需求、设计与任务，不改实现。只有用户审阅并确认文档后才进入实现。禁止提交/推送；不自动启动 Photoshop、服务或浏览器，不执行安装器、不写实际安装目录或注册表。用户配合 Photoshop 真机验收。

## 2. 现状与依据

- CEP 清单为 `com.figmatoolbox.ps/CSXS/manifest.xml`；当前入口 `index.html` + `jsx/host.jsx`。本地核对记录见 [UXP_API_VERIFICATION.md](UXP_API_VERIFICATION.md) §0；实际安装副本四个关键文件 SHA256 与工作区一致（前序命令核对记录）。
- CEP 选区读取在 `com.figmatoolbox.ps/jsx/host.jsx:165-201`，尝试合并 `activeLayers`/`selectedLayers`，否则回退 `activeLayer`；`detectFontMix()` 在 `:757-820` 只分析第一文本层。
- 检测回填在 `com.figmatoolbox.ps/index.html:1080-1092`：字体仅在返回值 truthy 时覆盖，空结果可能留下旧字体；识别结果 `empty` 时直接返回，状态字段也不统一清空。
- CEP 应用逐层处理，按字符生成区间并写入/校验；描述符写入异常时 `wholeLayerFallback()` 会使用整层 DOM 字体回退。若分段写入已产生部分结果后异常，整层回退可能抹掉部分混排。字体被替换的回读不进入该异常回退分支。实现证据：`com.figmatoolbox.ps/jsx/host.jsx:683-752`；用户文档现状说明 `docs/PHOTOSHOP_FONT_MIXER.md:32-66`。
- 字符分类沿用现有规则，不扩展：`docs/font-mixer-character-classification.md:7-19, 21-67, 80-106, 128-162`。该文档同时包含 Figma 规则；Photoshop 仅复用其中字符归属与连续区间原则，不照搬 Figma API/偏移单位结论。
- 已存在日志为历史记录，不代表当前故障现场；实现及验收报告必须区分静态/离线证据与 Photoshop 真机证据。

## 3. 功能需求

### R1 选择集处理

CEP 和 UXP 均应收集当前 Photoshop 选中的全部文本图层，递归处理已选组中的文本图层，对非文本层跳过；层 ID 去重。无文档、无选择、选择内无文本层时返回明确空态，不把活动层冒充为完整多选。

UXP 使用 `document.activeLayers` 作为多选来源；不依赖 CEP ExtendScript 行为。对于 CEP 若宿主仅暴露活动层，结果须明确标示“当前只能确认活动层”，不得宣称已处理完整多选。

### R2 多层识别显示

“识别选中图层”遍历全部选中文本图层。按既有字符分类为中文侧/英文侧，分别采集有效字符对应的字体、字号、颜色。

- 每一侧跨所有被识别层及其字符区间只有一个共同有效值时，回填该值。
- 同一侧出现多个字体值时，字体控件清空，状态显示“多层/多区间字体不一致”；不得取首层值伪装为全选区共同值。
- 字体值无法映射到本机可选字体时，清空该侧控件并显示“未识别字体”，保留诊断中的 PostScript 名。
- 某侧在文本中不存在时，沿用当前产品已有的另一侧回填行为，但 UI 明确标记这是便利回填，不代表选区存在该类字符。
- 字号遵循已有混合字号语义：值一致则填入，不一致则清空并标记混合；颜色不一致则清空并标记混合。
- 无文本层、空文本、读取/映射错误等每种识别失败都要清理未被用户主动编辑且未被方案保护的旧识别值，绝不能残留旧字体造成误导。
- 用户刚手动编辑字段或已选方案的现有保护语义保持有效；失败清理不得覆盖受保护值，状态区要说明该字段显示的是用户/方案值而非本次识别结果。

### R3 字体混排应用

- 默认沿用既有字符分类和配置。后续已批准的 CEP 专属变更：提供“符号使用中文 / 符号使用英文”互斥按钮，再点当前按钮关闭，两者关闭时恢复原分类；仅 Unicode 标点/符号的字体归属切换，原字号、颜色及字母、汉字、数字、空白规则保持。该模式随 CEP 方案保存，旧方案默认关闭。UXP 当前不包含此符号功能。
- 对每个选中文本层独立生成完整文本的连续字符区间；各区间按配置应用中文/英文字体及既有可选字号、颜色、tracking 字距功能；UXP 版字距按数值 tracking 实现，不等同于 CEP 的 Photoshop「视觉字距微调」命令。
- 目标字体不可用、文本读取失败、锁定/不可写、描述符写入失败、回读不符均按层/区间汇总；单层失败不得中止后续层。
- 成功必须以实际写入并回读核验为依据；部分失败、替换和使用回退路径分别报告，不得合并成全成功。

### R4 整层回退与混排保护

- CEP 的 `textItem.font` 整层 DOM 回退不得作为混排失败后的静默自动补救。整层回退会把全层统一成单一字体，破坏中英混排及已有分区字体。
- 首版默认关闭整层回退。若描述符写入在文档已部分修改后失败，停止该层后续写入，标记“部分修改，混排完整性未知”，提供图层名、错误阶段、可用行号及是否已发生写入；继续其他层。
- 若确认该层尚未写入任何区间且用户明确启用整层回退，可执行回退；结果必须显式标成“整层单字体回退，混排已丢失”，不得记为混排成功。首版界面不提供该开关，故默认不触发。
- UXP 不实现整层 DOM 回退。失败时优先使用每层独立的 `suspendHistory`/`resumeHistory({commit:false})` 回滚；必须回滚后逐区间确认混排样式已恢复，才可报告“该层已回滚、未修改”。此机制以文档为挂起单位，逐层原子性和 textKey 混排恢复能力列为真机验证门；验证前仍按“可能部分修改，混排完整性未知”报告。用户取消操作时立即退出 modal 函数。PS 25.0 模态冲突须捕获并提示；不得依赖 25.10 才提供的 `timeOut` 自动排队。
- UXP 区间级样式读取和写入均通过 batchPlay `textKey`/`textStyleRange`；DOM 无区间级读接口。首版只读取 `document.activeLayers`，不依赖 26.9 才支持的 `document.activeLayers` 赋值。

### R5 两套包与安装边界

- CEP 维持既有目录 `com.figmatoolbox.ps/`、CEP Extension Bundle ID `com.figmatoolbox.ps`、`CSXS/manifest.xml`、`index.html` 和 ExtendScript host；CEP 安装脚本只操作 CEP 用户级目录与其现存开发加载配置，不触碰 UXP。
- UXP 新增独立目录 `com.figmatoolbox.ps.uxp/`（若实现阶段仓库约定需调整，先更新文档并审阅）、独立 `manifest.json`、独立 panel 入口/模块、插件 ID `com.figmatoolbox.ps.uxp`，面板标签标明 UXP；UXP 安装/开发指引采用 `.ccx`/UXP Developer Tool，不复用 CEP 安装器。
- UXP manifest v5，`host.minVersion: "25.0"`，`apiVersion: 2`。CEP 与 UXP 可分别构建、安装、停用和升级。

### R6 可观察性与验收证据

每次识别/应用回包包含操作类型、文档/图层可识别名称或 ID、层数、识别来源、各侧取值状态、错误阶段、错误文本；写入结果还包含成功/失败层数、失败区间、替换、回退/部分写入状态。不得记录文档文本全文。

离线静态检查、自动化单元/契约测试和 Photoshop 真机结果分栏记录。任何未在对应 Photoshop 版本上执行的场景都标为“待真机验证”。

## 4. Photoshop API 版本依据

UXP 官方参考中 `TextItem` / `CharacterStyle` 相关 API 标注 24.1；`TextFont` 家族/样式/PostScript 字段和 `TextFonts` 标注 23.0；`Layer.textItem` 标注 24.2；`document.activeLayers` 读取标注 22.5，而赋值从 26.9 才支持；`batchPlay` 标注 23.0 且文档注明 subject to change；manifest v5 完整能力要求 PS 23.3 / UXP 6.0。由于本设计使用 `Layer.textItem`，实用 API floor 采用 PS 24.2；manifest `25.0` 将运行目标锁在 PS 2024+，高于 API floor。

UXP apiVersion 2 下写文档状态需使用 `core.executeAsModal`；在 PS 25.0，遇到其他插件占用 modal 时必须捕获并提示，不能依赖 `options.timeOut`（该选项自 25.10 起提供）。区间文字样式的读取与写入都通过 `action.batchPlay` 操作 Photoshop Action Descriptor；DOM 没有 textStyleRange 区间读 API。Adobe 官方未公开本项目所需完整 `textKey`/`textStyleRange` descriptor schema；必须从现有 CEP 可运行实现迁移并在 PS 2024+ 真机验证，不把字段结构记为官方已保证。

UXP 可用 `hostControl.suspendHistory`/`resumeHistory` 提供失败回滚路径，但挂起粒度是文档级，且官方没有逐字保证文本层混排样式复原。每层独立挂起、失败回滚后逐区间回读确认均通过真机验证前，不将其描述为逐层原子事务。

官方来源与逐项依据见 [UXP_API_VERIFICATION.md](UXP_API_VERIFICATION.md) §1-6。

## 5. 非目标

不修改 Figma 插件，不重写字符分类产品规则，不新增字体下载/安装能力，不要求两套插件共享源代码，不修改另一份 CEP 副本，不做 UXP 全盘文件权限或网络权限扩张，不在本阶段实现或安装任何插件。

## 6. 验收摘要

1. 每套插件可独立识别，ID/清单/入口/安装说明不冲突。
2. 单层及多层识别符合 R2 一致值、混合值、空态、错误清除规则。
3. 两套插件中英区间分类与既有规则一致，多行文本全覆盖。
4. 应用结果具备逐层隔离、写后回读、失败/替换准确报告。
5. CEP 不会因区间写入异常自动以单字体整层覆盖混排。
6. UXP 所有文档修改进入 modal，混排通过 batchPlay range descriptors，不调用 CEP/ExtendScript 接口。
7. 离线检查与对应 Photoshop 真机验证分别记录；PS 21.0 CEP 与 PS 2024+ UXP 分别验收。
