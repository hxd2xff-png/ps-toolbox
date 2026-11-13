# Photoshop CEP 与 UXP 双插件设计

日期：2026-11-12  
状态：用户已确认设计；实现进行中（真机验证未完成）

## 1. 架构概览

保留两套隔离插件：CEP 沿用 `com.figmatoolbox.ps/` 与 CEP/ExtendScript 通信；UXP 新建 `com.figmatoolbox.ps.uxp/`，由 UXP panel JS 直接 `require("photoshop")` 调用 Photoshop API。两边不共用入口、manifest、安装脚本或运行时宿主；功能契约和测试案例保持一致。

UXP 清单采用 manifest v5、ID `com.figmatoolbox.ps.uxp`、`host.minVersion: "25.0"`、`apiVersion: 2`。UXP 面板独立标识“UXP”。本机存在 PS 27.4 和 UXP 插件存储，属于 DS 只读环境检查记录，详见 [UXP_API_VERIFICATION.md](UXP_API_VERIFICATION.md) §0；这不是本阶段运行插件的真机验收。

## 2. 组件边界

| 组件 | 负责内容 | 明确不做 |
| --- | --- | --- |
| CEP Panel | 当前 UI、字段保护、状态/错误显示、evalScript 请求/响应 | 不改成 UXP 通信层 |
| CEP Host | 多层枚举、字体/样式读取与映射、分段计划、Action Manager 写入/回读、逐层结果 | 不在区间写入异常后自动整层刷字体 |
| UXP Panel | UXP 独立 UI、表单/方案/日志、Photoshop API 调用与错误提示 | 不加载 CSInterface、window.cep、evalScript 或 JSX |
| UXP Host adapter modules | 通过 `require("photoshop")` 使用 DOM 读取文档/图层/字体库等整层属性；区间级 textStyleRange 读取和写入都通过 batchPlay；文档修改进入 modal 并校验结果 | 不依赖 CEP JSX 或未经验证的 DOM 区间读写 API；首版只读取 activeLayers，不写入选区 |
| Shared behavior contract | 两边共同遵循字符分类、区间连续性、状态语义和测试样例 | 首版不抽出跨 runtime 通用包，避免共享运行依赖耦合 |
| Packaging | CEP 用户级复制安装；UXP `.ccx` 分发/UDT 开发流程 | 不让任一脚本写入或删除另一平台目录 |

## 3. 数据流

### 3.1 识别

1. Panel 发起 `detect-font`，携带请求 ID。
2. 宿主获取当前选择的全部图层并展开组，筛选文本层、按 layer ID 去重。
3. 每层读取完整文本。UXP 的区间样式读取必须通过 batchPlay `get textKey` 获取 `textStyleRange`；TextItem DOM 没有区间级读接口。UXP 使用 `document.activeLayers` 读取当前选择（读 API 标 22.5），首版不得设置 `document.activeLayers`，该写 API 标 26.9。没有选择返回 empty，不静默将活动层当成全部多选。CEP 沿用兼容收集策略，但回包暴露来源和确定性。
4. 每个 range 的字体/字号/颜色按原文区间对字符分类；汇总时以层与区间的共同值为准，而非只取首层。
5. Panel 对每一字段应用保护规则：方案选中/用户刚改字段时保留受保护值；否则写入一致值，混合/未知/错误则清空并显示原因。识别回包须显式包含字段状态，不依赖“字段缺省”表示未变化。

多层字体示例：Layer A 中文字体 X、Layer B 中文字体 X 时回填 X；任一目标中文区间为字体 Y 或无法识别则清空中文字体并显示“混合/未识别”，同时列出来源层数与原因。英文侧同理。若所选内容没有中文或英文字符，沿用现有另一侧回填方便编辑，但标注为“依据另一侧回填”。

### 3.2 应用

1. 校验选择、配置和字体目标；逐层读取文本及现有 textKey/ranges。
2. 使用既有字符分类生成覆盖全文的连续 range plan；偏移单位和补充字符边界沿用 `host.jsx` 已验证实现，禁止照搬 Figma 文档中 UTF-16 断言作为 Photoshop 事实。
3. CEP 用现有 Action Manager descriptor 重建目标 textStyleRange；UXP 用 `action.batchPlay` 发等价 textKey descriptor。UXP 每一组文档修改都在 `core.executeAsModal` 内。PS 25.0 上 modal 冲突必须捕获并明确报告；`timeOut` 选项仅 25.10+ 可用，不能依赖它排队重试。
4. 写后重新通过 batchPlay 读取并逐区间比较字体及已请求字段；Photoshop 替换字体、尺寸或属性回读不一致都作为非完全成功的明确结果。
5. UXP 评估 `hostControl.suspendHistory`/`resumeHistory`：尝试逐层独立挂起，校验成功后提交；失败请求 `commit:false` 回滚。它是文档级历史机制，首版不得宣称逐层原子回滚已成立，除非真机证实混排 textKey 完整恢复。若实现证明无法对同文档的层分别开关挂起，则该能力不作为逐层回滚保证，保留未知状态报告。取消时检查 `isCancelled` 并立即退出 modal 函数。CEP 逐层隔离异常；回包区分成功、部分区间失败、字体被替换、未写入、已验证回滚、可能部分修改且状态不确定、回退路径。

## 4. 失败、旧值与回退

- 检测结果采用明确字段状态：`consistent`、`mixed`、`unrecognized`、`empty`、`error`。Panel 在本次识别不确定时清空未受保护的旧值；受保护的用户/方案值不动，并标记来源。
- 混合值不是错误，但不可选作唯一代表值；字段显示为空和“混合”。映射不到字体时显示为空、“未识别字体”，诊断记录 PostScript 名和层/区间位置。
- CEP 当前 `wholeLayerFallback()` 以整层 DOM 属性回退；这种写入语义与混排目标冲突。新方案默认不自动调用整层回退。descriptor 写入失败若无法保证零写入，则标记“可能部分修改，混排完整性未知”，停止该层并继续其它层。
- UXP 不使用 DOM 单值字体回退。batchPlay/modal 失败时优先在该层独立的 suspendHistory 窗口内请求回滚；只有回滚后逐区间读取确认样式复原，才能报告“已回滚、未改动”。若挂起/恢复失败、过程取消或无法证明完全复原，报告状态未知并保留诊断，不将文档级挂起能力等同于逐层原子性。
- PS 25.0 缺少 `executeAsModal` 的 `timeOut` 选项；遇到 `host is in a modal state` 时当前操作失败并提示稍后重试，不自动再次执行写操作。
- 不通过临时文档自检验证生产行为；只对用户当前文档按命令修改并记录结果。测试夹具和真机验证方案须避免未授权自动创建/清理文档。

## 5. API 与版本

官方资料：

- [TextItem](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textitem)：相关文本对象 API 标注 24.1；Layer.textItem 单项在 [Layer](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/layer) 中标注 24.2，故实际使用下限取 PS 24.2。
- [CharacterStyle](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/characterstyle)：字体、字号、颜色、tracking 等字符属性 DOM；TextItem 也没有区间级样式读取成员，因此区间级混排的读与写都走 batchPlay，不通过 DOM 的单值属性获取或修改区间样式。
- [TextFont](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textfont) / [TextFonts](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textfonts)：字体族、样式、PostScript 名及按 PS 名查询，最低 23.0。
- [Document](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document)：`activeLayers` 多选集合最低 22.5；UXP 不使用 CEP 的 selectedLayers/activeLayerSource 实现。
- [Manifest v5](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp_guide/uxp-misc/manifest-v5/)：完整 v5 能力最低 PS 23.3 / UXP 6.0。
- [batchPlay](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/batchplay/)（API 标注 23.0，文档注明 subject to change）与 [executeAsModal](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)：UXP apiVersion 2 修改文档需在 executeAsModal。
- [History state suspension](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal#history-state-suspension)：提供挂起/恢复文档历史状态的能力；并非官方对文本混排逐层事务原子性的保证。
- 版本和清单核验及限制详见 [UXP_API_VERIFICATION.md](UXP_API_VERIFICATION.md)。

需要实机确认的关键接口不是“UXP 有无 batchPlay”，而是当前 textKey descriptor schema、重建 ranges 的接受形式、range offset 与 CEP 实证值的一致性、写后回读、suspendHistory 回滚是否恢复 textKey 混排，以及异常时的状态。Adobe 未发布所需 descriptor 完整 schema，因此这些属于 PS 2024+ 实测门槛。

## 6. 目录与文件职责

- `docs/photoshop-cep-uxp-requirements.md`：用户行为、非目标、验收口径。
- `docs/photoshop-cep-uxp-design.md`：运行时架构、数据流、错误和 API 选择。
- `docs/photoshop-cep-uxp-tasks.md`：用户确认后执行的分步任务、文件范围和测试。
- `com.figmatoolbox.ps/`：仅 CEP 修复；不可在本阶段改动。
- `com.figmatoolbox.ps.uxp/`：独立 manifest、UI、API 模块与安装说明。
- 根目录 CEP 安装/卸载脚本：保留现状，后续只按 CEP 需求调整。
- `scripts/` 下 UXP 打包/开发说明或脚本：实现阶段新增，严禁触碰 CEP 路径和注册表值。

## 7. 风险与未决验证

1. Descriptor schema 无官方保证；以 CEP 真机跑通记录作迁移依据，UXP PS 27.4 与目标最低 PS 25.0 都须验证。
2. `activeLayers` 26.9 有变更记录；PS 25.0 多选行为必须在目标最低版本真机覆盖，不因 API 初始版本 22.5 而跳过。
3. batchPlay 失败时 suspendHistory 回滚能否完整恢复混排 textKey，需构造可复现异常场景测定；通过逐区间回读确认前使用“状态未知/部分修改”语义。
4. UXP `plugin-data://` 日志 append、面板尺寸和 `.ccx` 本地安装尚未实测，见核验报告 §6；首版不把这些记为已验收。
5. CEP 不同版本的多选集合覆盖情况取决于宿主暴露属性；日志中必须记录实际来源、refs/text layer 数量。

## 8. 质量门

- 文档自洽：ID/目录/版本、状态枚举、回退规则及测试矩阵一致。
- 离线测试：字符分类契约、range 覆盖与偏移、聚合状态、清旧值、失败隔离、manifest/安装路径静态检查。
- CEP 真机：PS 21.0.2 与当前目标版本；含单层、多选、字体映射失败、分段写入中断及整层回退关闭验证。
- UXP 真机：PS 25.0（最低目标）和本机 PS 27.4；含 activeLayers 多选读取（不写选区）、batchPlay 区间读写、modal 冲突错误、逐区间回读、suspendHistory 回滚后的逐区间样式复核和插件隔离安装。
- 未真机运行的项均标记为未验证，不以文档/API 静态核对代替运行证据。
