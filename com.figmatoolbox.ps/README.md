# 盗版PS的工具箱 · Photoshop CEP 插件

Figma「FIGMA工具箱」的 Photoshop 移植版（字体混排 + 自动字距 + 方案预设；Photoshop 2019 及以上可用）。
面板 UI 视觉与 Figma 版完全一致（暖橙卡片风格），仅把通信层从 Figma postMessage 换成 CEP `evalScript` 桥接。

**兼容版本**：Photoshop 2019（v20.0）及以上（CEP 9~12）。

---

## 宿主加载与故障自检（v1.2.0 起）

CEP 的 `<ScriptPath>` 自动加载并不总是把宿主函数暴露成全局，面板一旦找不到宿主，
所有功能（字体库、识别、应用、拾色器）都会回一个 `EvalScript error.`。v1.2.0 起面板
**不再依赖自动加载**：

1. 打开面板即探测 `typeof cephostDispatch`；
2. 探测不到就自己把 `jsx/host.jsx` 读入并 eval，然后显式挂到 ExtendScript 的 `$.global`；
3. 成功后自动重试原有调用；面板顶部状态条会显示结果：
   - 绿色「宿主已连接（通信正常）」= 一切就绪；
   - 红色「宿主加载失败：…」= 带真实行号与出错行原文，**点状态条可原地重试**（改完 jsx 后无需重启 PS）；
4. 全过程写入 **`<扩展目录>/diag.log`**，随时可查看。

离线自检（无需 Photoshop）：

```bash
npm run test:ps      # 宿主 ES3 lint + 冒烟 + 视觉字距/拾色器 + 加载器（无需 Photoshop）
node ps-plugin/audit/verify-all.js    # 全量核查：安装一致性 / manifest / ES3 / 协议对账 / 字段级契约 / 签名
```

---

## 文本读写：textKey 描述符（v1.4.0 起，PS 21.0.2 真机验证）

v1.3.0 之前的写法是「按索引引用 + `Ordn:Styl` 目标 + `T   ` 列表」：

```
null -> ActionReference.putIndex(TxLr, itemIndex)
'T   ' = Ordn:Styl
'T   ' = [ {From, Tckn, TxtS:{...}} ]
```

真机（PS 21.0.2）上这种形状**一律被拒**：字体写入报「非法参数 - 参数 1 - 应为数值」，
整层写法报「命令“设置”当前不可用」；同时按 `Lyr ` 标识符直接读文本描述符也拿不到
`TxtS`，于是识别静默返回空值。

v1.4.0 换成 Photoshop 自己录制的形状（也是本机另一个可用混排插件的写法）：

```
读 : ref.putProperty('property','textKey'); ref.putIdentifier('layer', id)
     executeActionGet(ref).getObjectValue('textKey')
写 : ref.putIdentifier('textLayer', id)
     desc.putReference('null', ref)
     desc.putObject('to','textLayer', 整份 textKey 描述符)
     executeAction('set', desc, DialogModes.NO)
```

要点：

1. 写入前先**读回整份 `textKey`**，重建全部 `textStyleRange`（区间必须无缝覆盖全文），
   只覆盖目标字段，其余样式原样继承；
2. 丢弃 `engineData`——它是旧版式的快照，写回去会把刚改的字体顶掉；
3. 换字体前清掉 `fontName/fontStyleName/fontScript/fontTechnology/fontAvailable`，
   避免把上一族的元数据带给新字体；
4. 写完后**回读校验**：请求的字体没生效（被 Photoshop 替换）就报「字体被替换」；
5. 描述符路径整体被拒时才退化为整层 DOM 写入（`textItem.font`），并如实说明用了哪条路径；
6. 文本区间读取失败**不再静默**：`detect-font` 直接回包错误，界面显示真实原因。

面板启动后会自动做一次 **`selftest`**：在一个临时文档里用生产路径把两个不同字体写进两段并回读，
再用 4 种候选键/单位试写入字号（12 / 30）并回读，结果写进 `diag.log` 并显示在状态条上
（临时文档用完即删，不碰你的稿子；点状态条可重跑）。判定语义：

| 自检步骤 | 含义 |
| --- | --- |
| `verify=ok` | 你选的那对字体真的写进去了 |
| `verify=substituted` | 你选的字体在样例字符上缺字形，被 PS 替换（真机踩过一次：自检一度挑到纯 emoji 字体而误报） |
| `verify=ok-secondary` | 换成稳健字体对后验证通过 → 算通过，但会注明 |
| `verify=mismatch` | 两种都对不上 → 真失败 |
| `size=ok` / `size=FAIL` | 字号能否写入；失败时 `sizeSteps` 列出每种候选的回读值 |

字号是唯一会被 Photoshop **静默忽略**的字段（不报错但值不变），所以写入后一律回读校验：
不对就换下一种候选键/单位（`size/pointsUnit` → `size/pixelsUnit` → `size+implied` → `Sz  `），
全部不行才退化为「只应用字体」并明确告知。面板侧另外有一道闸门：你手动改过的字号/颜色
**不再被识别回填覆盖**（识别由选区变化触发，否则刚输入的数值会被下一次识别冲掉）。

### 可选的颜色同步（v1.6.0 起）

「应用字体混排」按钮拆分为左右两半（中间用 | 分隔）：

- **左半（应用字体混排与颜色）**：按字体混排页里的左/右侧字色同步调整文字颜色；
- **右半（应用字体混排）**：只改字体与字号，完全保留原文字颜色（默认推荐，不碰颜色）；
- 方案保存时记录「最近一次应用所用的半边」；载入方案仅回填界面提示，实际是否同步颜色始终由当次点的那一半决定；
- 旧方案（无记录）被视为「不同步颜色」；
- 整层 DOM 兜底路径同样遵守开关：关闭时连 `textItem.color` 都不会被碰。

### 跨环境健壮性（v1.5.3 起）

#### 全角标点分区修复（v1.5.3）

#### 变换图层字号校验修复（v1.5.3）

- 带自由变换（缩放）的文本图层：Photoshop 把 AM 写入值当作面板尺寸、在 textKey 里
  存变换前基础值（base = 面板值 / K）。旧校验拿基础值与请求值直接比较，误报
  「字号未能写入」并把字号剥掉；现读回后乘以 K 再比对（与字符面板一致），
  识别回填的字号同样报告面板值。写入端保持原值不变。

- 分区表补全 FF00-FFEF（全角括号/标点/字母/数字/￥）与谚文区：全角括号曾划给英文字体，
  无对应字形的字体会被 Photoshop 替换，进而触发错误的整层覆盖；
- 字体被替换时保留已写入结果并如实上报（substituted），不再用整层 DOM 覆盖冲掉已生效的分段；
- 回归测试覆盖真实故障文案（含全角括号 + 拉丁混排）。

面板在不同分辨率、不同显示器、不同 Photoshop 窗口大小下都要能用，针对下列几点做了加固：

| 环境差异 | 风险 | 处理 |
| --- | --- | --- |
| 面板被拖得很矮（manifest 允许 300×320） | 弹层固定向下展开 → 列表被视口裁掉，看不到也选不了 | 打开与 `resize` 时按真实可用空间计算：下方放不下完整高度且上方更宽裕时**向上翻**，并把 `max-height` 收紧到可用空间（不低于 96px）；空间真的不够时保留可滚动的最小高度 |
| 面板被拖得很窄 | 固定宽度元素被 `overflow-x: hidden` 静默裁掉 | 实测：300px 宽下 23 个交互控件最右边界 286px，无溢出 |
| 面板拉得很宽（到 1200px） | 弹层左右铺满卡片，很宽的字段使弹层无限宽 | 字段比弹层窄时启用 `align-right`（此前是**从未生效的死 CSS**） |
| 系统深色模式 / 高对比主题 | 未声明的原生控件（勾选框、数字框）被浏览器画成深色，看不清 | `:root { color-scheme: light }` 强制浅色表单控件 |
| 非英语键盘（小数分隔符为 `,`） | `parseFloat('1,5')` → `1`，得到错误字号 | `numInput()` 统一把 `,` 归一为 `.` 再解析（空值仍视为「不改」） |

弹层定位逻辑是纯函数 `popupFitPlan`，离线属性测试（`audit/test-panel-fit.js`）
在 5182 个「面板高度 × 触发条位置 × 设计上限」组合上验证三条不变量：
高度始终在 [96, 设计上限] 内；空间够时一定能装进视口；下方放得下完整高度时绝不上翻。

### 「自动微调」的行间距选项（v1.5.0 起）

「自动微调」除视觉字距外，还能把行间距设为 Photoshop 的「自动」（`TextItem.useAutoLeading`，
字符面板「行距：自动」）：

- 面板上是一个勾选框（**行距自动**），**勾选才改，不勾选就完全不碰行间距**；勾选状态记住；
- 写法：先 DOM `textItem.useAutoLeading = true` 并回读校验；被拒就退到描述符路径，
  在区间样式里写 `autoLeading: true`，同样回读确认；
- 回报里分开统计：`leading`（成功）/ `leadingFailed` / `leadingMode`（`dom` / `descriptor` / `off`），
  界面会直说「行间距已设为自动」/「未勾选行距自动，行间距保持不变」/「行间距未能设为自动（原因）」。

---

## 安装方式（四选一）

打包产物：`ps-plugin/dist/盗版PS的工具箱-1.6.0.ccx`（已用自签证书签名）。

### 方式 A：一键安装脚本（推荐，免装任何工具）

| 平台 | 操作 |
| --- | --- |
| **Windows** | 双击 `安装-Windows双击运行.cmd`，按提示完成后重启 Photoshop |
| **macOS** | 终端运行 `bash install-macos.sh`，完成后重启 Photoshop |

脚本做的事：把扩展复制到用户级 CEP 目录 + 写入 CSXS.9~14 的 PlayerDebugMode=1（只写当前用户，**全程不需要管理员/sudo**）。卸载：Windows 重跑 cmd 后在 PowerShell 窗口执行 `install-windows.ps1 -Uninstall`，macOS 执行 `bash install-macos.sh --uninstall`；不想动系统可先 `--dry-run` 演练。

### 方式 B：ZXP 安装工具

1. 下载 [Anastasiy's Extension Manager](https://install.extensionmanager.com/) 或 [ZXPInstaller](https://zxpinstaller.com/)；
2. 把 `盗版PS的工具箱-1.5.3.ccx` 拖进安装工具窗口（或双击 .ccx 关联打开）；
3. **重启 Photoshop**，菜单「**窗口 → 扩展功能（Extensions）→ 盗版PS的工具箱**」即可打开面板。

### 方式 C：手动复制 + PlayerDebugMode（最稳，可核查每一步）

1. 把整个 `com.figmatoolbox.ps` 目录复制到 CEP 扩展目录：
   - **Windows**：`C:\Users\<用户名>\AppData\Roaming\Adobe\CEP\extensions\com.figmatoolbox.ps`
   - **macOS**：`~/Library/Application Support/Adobe/CEP/extensions/com.figmatoolbox.ps`
2. 开启 PlayerDebugMode（自签面板需要，每项都是字符串值 `1`）：
   - **Windows**（普通 PowerShell 即可，HKCU 无需管理员；一次覆盖 2019~最新版）：
     ```powershell
     foreach ($v in 9,10,11,12) {
       New-Item -Path "HKCU:\Software\Adobe\CSXS.$v" -Force | Out-Null
       Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.$v" -Name PlayerDebugMode -Value "1"
     }
     ```
   - **macOS**（终端）：
     ```bash
     for v in 9 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
     ```
3. **重启 Photoshop** → 「窗口 → 扩展功能 → 盗版PS的工具箱」。

### 方式 D：开发调试加载

用 Adobe 官方 CEP 资源里的方式直接加载本目录：把 `com.figmatoolbox.ps` 放入 extensions 目录（同方式 B 第 1 步）即可，改代码后重开面板生效。远程调试：用 Chrome 打开 `http://localhost:8092`（`.debug` 文件已配置）。

---

## 功能对照（与 Figma 版的差异）

| 功能 | 行为 | PS 版实现说明 |
| --- | --- | --- |
| 字体混排 | 一致 | 走 Action Manager `textStyleRange`，中文字符（含 CJK 标点/假名）用中文字体，其余用英文字体；字号、颜色按区间写入 |
| 自动字距 | 一致 | 符号 tracking -300、配对外括号外缘值可调；PS 的 tracking 单位正好是 Figma 的 10 倍，默认 -45 → -450 |
| 字色选择 | PS 增强 | 所有颜色块点击直接调起 Photoshop 原生拾色器（`app.showColorPicker`），确认后同步写入前景色 |
| 方案预设 | 一致 | 字体混排方案支持保存/更新/重命名/删除/搜索/导入/导出 JSON；持久化改用面板 localStorage（CEP 有真实 origin） |

已知差异（由 Photoshop 能力决定）：

- **字体清单**：来自本机 `app.fonts`，按 family 聚合、打开下拉时按需渲染（与 Figma 版同构）。
- **识别回填轮询**：CEP 无选区变化推送，面板以 500ms 轮询选区签名替代，行为与 Figma 版 selection-changed 等效。

---

## 开发者：重新打包

签名工具已就位（`ps-plugin/tools/ZXPSignCmd.exe`，Adobe 官方 4.1.103）。

```bash
# 1. 生成自签证书（已有 cert/ps-toolbox-v2.p12 可跳过）
./tools/ZXPSignCmd.exe -selfSignedCert US California "PS Toolbox" "PS Toolbox Developer" "PSToolbox2026!" cert/ps-toolbox-v2.p12 -locality "San Jose" -orgUnit "Design Tools" -email ps-toolbox@example.com -validityDays 3650

# 2. 签名打包 .ccx（= 签名 ZXP，双击可装）
./tools/ZXPSignCmd.exe -sign com.figmatoolbox.ps "dist/盗版PS的工具箱-1.5.3.ccx" cert/ps-toolbox-v2.p12 PSToolbox2026

# 3. 校验签名
./tools/ZXPSignCmd.exe -verify "dist/盗版PS的工具箱-1.5.3.ccx" -certInfo -skipOnlineRevocationChecks
```

- 证书密码：`PSToolbox2026`（注册名 `PSToolbox2026!`；p12 在 `cert/ps-toolbox-v2.p12`，有效期 10 年，请勿提交到公开仓库）
- 分发正式版建议：换用受信任 CA 签发的代码签名证书（去掉「发布者未知」提示），并加 `-tsa` 时间戳。

## 目录结构

```
ps-plugin/
├─ com.figmatoolbox.ps/          # 插件本体（CEP 扩展根目录）
│  ├─ CSXS/manifest.xml          # 扩展清单：PHSP/PHXS [20.0,99.9]、CEP 9.0+、面板尺寸
│  ├─ .debug                     # Chrome 远程调试端口 8092
│  ├─ index.html                 # 面板 UI（与 Figma 版同源，消息层换成 CEP 桥接）
│  ├─ js/CSInterface.js          # Adobe 官方 CEP 接口库
│  └─ jsx/host.jsx               # ExtendScript 宿主：全部文档操作（ES3 方言，手写 JSON 序列化）
├─ cert/ps-toolbox-v2.p12           # 自签证书（勿外传）
├─ dist/盗版PS的工具箱-1.5.3.ccx       # 签名打包产物
└─ tools/ZXPSignCmd.exe          # Adobe 官方签名工具
```

## 架构要点（给后续维护者）

- **UI ↔ 宿主协议**：UI 侧 `send(msg)` 语义与 Figma 版完全一致；`callHost(type, args, cb)` 把消息编码为 `cephpostDispatch("type", "encodeURIComponent(JSON)")` 调用宿主，回包是 JSON 字符串（host.jsx 内手写 ES3 序列化器拼装）。
- **文本区间**：读写都走 `textKey`（`property/textKey` + `layer`/`textLayer` 标识符），写入用 `set` 动作替换整份描述符并丢弃 `engineData`，随后回读校验字体是否被替换（详见上节）。区间必须无缝覆盖全文——Photoshop 要求 `from/to` 连续，缺口会让写入被拒。
- **颜色模型**：UI 全程 `{r,g,b}(+a)` 0~1 浮点；host.jsx 在 AM 描述符（0~255）边界换算，UI 代码零改动。
- **选区识别**：`sel-sig` 返回选中图层 id 签名，UI 每 500ms 轮询一次，变化才触发 `detect-font/style/skew`。
