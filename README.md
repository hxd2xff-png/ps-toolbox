### v1.7.3（字符分类对齐识别规范 MD · 防卡死 · 自修复）

- **字符分类全面对齐规范**（`font-mixer-character-classification.md`）：
  - Unicode 罗马数字仅 **I..XII**（U+2160–216B / U+2170–217B）归中文字体；更大的（ⅬⅭⅮⅯ、ↀ 等）归英文；
  - **ASCII 罗马数字（I/II/IV/XIV…XXV）**：格式合法、数值 ≤25、不嵌入编码（SKU-IV-A、MIX123、IV_CODE 保持英文）、单字母需紧邻中文；
  - **罗马数字判定优先于「符号用中/英」开关**（与规范 §6 一致）；
  - **空格/换行跟随前一字符**归属（规范 §7），多行/混排不再被空白切碎；
  - 识别（回填表单）与应用使用**同一套分类**，识别遍历全部选中文本层；
- **修「请求 Light 实际 Medium」**：所选字重缺失时，在同字体族内按字重就近回退，不再跨族乱换；同族字重规范化不再误报「被替换」；
- **替换自修复**：某区间被 Photoshop 换成别的字体时，自动用中文字体重写该区间并回读校验；修不了才如实上报；
- **防卡死**：
  - 面板打开不再自动建临时文档自检（标签页不再闪一下），自检只在点击状态条时手动运行；
  - PS 处于模态状态（原生拾色器等）时选区轮询完全暂停；有在飞调用时不叠发，轮询放宽至 800ms；
  - 失败探针只在真实失败后运行一次；
- Multi-selection now also resolves PS 20/21 index-form targetLayers references (previously only the active layer was applied)
- Symbols (incl. halfwidth punctuation) default to the Chinese font in auto mode; CJK fonts carry both glyph sets so Photoshop no longer substitutes ranges
- Optical kerning snapshots per-character fonts and restores them if the DOM write rolls mixed fonts back
- Line breaks ride with the previous character side: multi-line layers get fonts/sizes/colours on every line without pointless splits
- Panel: user-picked fonts are no longer overwritten by selection-change auto detection (preset load still wins)

# 盗版PS的工具箱 · Photoshop 字体混排插件

一个 Photoshop CEP 面板插件：**中英文一键混排**（中文字符用中文字体、拉丁字符用英文字体）、
**符号自动微调**（视觉字距 + 可选行距自动）、**方案预设**管理。UI 为暖橙卡片风格。

**兼容**：Photoshop 2019（v20.0）及以上 · Windows / macOS · 用户级安装，**全程不需要管理员权限**。

> 前身是 Figma 插件「FIGMA工具箱」，本仓库为 Photoshop 移植版：UI 视觉与 Figma 版一致，
> 通信层从 Figma postMessage 换成 CEP `evalScript` 桥接。

---

## 主要功能

### 1. 字体混排（核心功能）
- 选中文本图层，分别指定**中文字体**与**英文字体**，一键应用；
- 分区算法逐字符判定归属：汉字、假名、CJK 标点、**全角符号（（）、「」、￥等）**用中文字体；拉丁字母、数字、半角标点用英文字体；
- **罗马数字/带圈数字默认归中文字体**（Ⅰ、Ⅱ、①等——中文展示字体都有这些字形，避免被 Photoshop 替换）；
- **符号归属可调**：中/英卡片上各有一个「符号用中文 / 符号用英文」开关——
  - 默认**自动**：所有标点符号（含半角）都归中文字体——中文字体同时携带全/半角字形，纯拉丁展示字体常缺全角字形（这正是被 Photoshop 整段替换的根源）；
  - 开关对**所有**符号类字符生效（全角+半角标点、罗马数字、带圈数字），不会被默认规则覆盖；
  - 点「符号用中文」：所有符号（含半角标点）都用中文字体；
  - 点「符号用英文」：所有符号（含全角标点）都用英文字体；
  - 再点一次激活的按钮恢复自动；汉字假名与拉丁字母数字的归属不受开关影响；
  - 状态持久化，并可随方案保存/载入（旧方案按自动处理）；
- 可选**同步字号**（中英文分别设置或统一设置）与**同步颜色**：应用按钮分为左右两半——
  - 左半「**应用字体混排与颜色**」：按面板设置的字色一并调整；
  - 右半「**应用字体混排**」：只改字体和字号，**完全保留原文字颜色**（默认推荐）；
- 字体清单来自本机 `app.fonts`，按字体族聚合、支持搜索；
- 自动识别选中文本的当前字体/字号/颜色并回填（选中非文本层时给出明确提示，不再沉默）。

### 2. 自动微调（符号间距）
- 对成对符号（括号、引号等）应用 Photoshop「视觉字距微调」（tracking -450，即 PS 单位下 -45）；
- **可选行距自动**：勾选后同时把行间距设为 Photoshop 的「自动」（`useAutoLeading`），不勾选则完全不碰行间距。

### 3. 原生拾色器调色
- 纯色：直接调起 **Photoshop 原生拾色器**（`app.showColorPicker`），确认后写入；
- 渐变：调起 Photoshop 渐变编辑流程；
- 不重复造轮子，颜色体验与 PS 原生一致。

### 4. 方案预设
- 字体混排方案：保存 / 更新 / 重命名 / 删除 / 搜索 / 导入 / 导出 JSON；
- 是否同步颜色随最近一次应用记录保存；旧方案一律按「不同步颜色」处理；
- 持久化在面板 localStorage，随用户配置保留。

### 5. 工程级可靠性（这个插件踩过的坑都变成了测试）
- **宿主自检**：面板启动时在临时文档里走一遍生产写入路径（写完即删，不碰你的稿子），状态条实时显示宿主连接与自检结果；
- **写入回读校验**：字体、字号、行距写入后一律回读确认，被 Photoshop 静默替换的字符如实上报（绝不用整层覆盖冲掉已生效的分段）；
- **变换图层适配**：自由变换缩放过的文本图层，字号按「字符面板显示值」读写（内部自动处理变换系数）；
- **弹层自适应**：面板拖到 300×320 的极小尺寸时下拉自动上翻并收紧高度（5182 组几何组合的属性测试保障）；
- **诊断日志**：全过程写入扩展目录 `diag.log`，出问题时看日志定位，不靠猜。

---

## 安装

### 方式 A：一键安装脚本（推荐）

| 平台 | 操作 |
| --- | --- |
| **Windows** | 双击 `安装-Windows双击运行.cmd`，按提示完成后**重启 Photoshop** |
| **macOS** | 终端运行 `bash install-macos.sh`，完成后**重启 Photoshop** |

脚本做的事：把 `com.figmatoolbox.ps` 复制到用户级 CEP 扩展目录 + 写入 CSXS.9~14 的
`PlayerDebugMode=1`（只写当前用户，无需管理员/sudo）。

卸载：Windows 重跑 cmd 后按提示选择卸载（或执行 `powershell -File install-windows.ps1 -Uninstall`）；
macOS 执行 `bash install-macos.sh --uninstall`。都支持 `--dry-run` 演练。

### 方式 B：装好后弹「未经正确签名」？一键修复

这是自签名扩展在其他机器上最常见的报错（扩展目录已就位，只是这台机器的调试加载开关没生效）。
**双击 `一键修复签名警告-Windows.cmd`** 即可：

- 纯 cmd 批处理，不依赖 PowerShell，无视执行策略；
- 写入 `HKCU\Software\Adobe\CSXS.9` ~ `CSXS.14` 的 `PlayerDebugMode = 1`
  （**REG_SZ 字符串型**——CEP 只认这个类型，教程里常见的 DWORD 型写了也无效）；
- **每个键写完立即回读校验**，当场给出 `[OK] / [WARN] / [FAIL]` 结论；
- 自动检测 Photoshop 是否在运行并提醒：CEP 只在 PS 启动时读这些键，写完必须**完全退出并重启 Photoshop**。

> 手工等价操作：`regedit` 打开 `HKEY_CURRENT_USER\Software\Adobe\CSXS.9`（没有该项就新建），
> 新建**字符串值** `PlayerDebugMode`，值为 `1`。但 PS 2020 是 CSXS.10、2021 是 CSXS.11……
> 只写 CSXS.9 一项是很多机器失败的直接原因，脚本已全部覆盖。

macOS 等价操作：

```bash
for v in 9 10 11 12 13 14; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
```

### 方式 C：手动安装（最稳，每步可核查）

1. 把 `com.figmatoolbox.ps` 整个目录复制到：
   - **Windows**：`C:\Users\<用户名>\AppData\Roaming\Adobe\CEP\extensions\com.figmatoolbox.ps`
   - **macOS**：`~/Library/Application Support/Adobe/CEP/extensions/com.figmatoolbox.ps`
2. 按**方式 B** 开启 PlayerDebugMode；
3. **重启 Photoshop** → 菜单「**窗口 → 扩展功能 → 盗版PS的工具箱**」。

### 方式 D：ZXP 安装工具

用 [ZXPInstaller](https://zxpinstaller.com/) 或 [Anastasiy's Extension Manager](https://install.extensionmanager.com/)
拖入签名打包的 `.ccx`（即签名 ZXP）。打包方法见下文[开发者](#开发者)一节；
如果你的机器装过本插件的旧版签名包，直接双击 `.ccx` 也可以。

---

## 使用说明

### 字体混排
1. 打开面板（窗口 → 扩展功能 → 盗版PS的工具箱），切到**字体混排**页；
2. 选中文档里的**文本图层**——面板自动识别当前字体/字号/颜色并回填；
3. 左侧选**中文字体**、右侧选**英文字体**（可分别设置字号与字色）；
4. 点应用：
   - **左半** = 字体混排**并**按面板颜色同步文字颜色；
   - **右半** = 只混排字体字号，**保留原色**；
5. 满意的组合可**保存为方案**，下次一键载入；支持搜索、导入导出 JSON。

提示：
- 中英文某一侧没出现的字符自动沿用另一侧设置；
- 识别回填不会覆盖你手动输入过的值（手动优先）；
- 状态条会显示每次操作的真实结果，包括个别字符因目标字体缺字形而被 Photoshop 替换的情况。

### 自动微调
- 选中文本图层，点**自动微调**：成对符号按视觉字距处理（等同字符面板「字距微调：视觉」）；
- 勾选**行距自动**：同时把行间距设为「自动」；不勾选则不动行间距。

### 颜色
- 纯色/渐变色块点击即调起 **Photoshop 原生拾色器**，确认后写入选中图层；
- 也可以只在字体混排页设置左右字色，用左半应用按钮一并写入。

### 出问题了？
1. 看面板顶部**状态条**（绿色=宿主已连接；红色=点它可原地重试加载）；
2. 看扩展目录下的 **`diag.log`**——每次宿主调用都记录了完整回包；
3. Windows 弹「未经正确签名」→ 跑**方式 B** 的一键修复脚本后**完全重启 Photoshop**。

---

## 工作原理

```
┌─ 面板 index.html（CEP 内嵌 Chromium）──────────────┐
│  UI / 状态 / 方案存储（localStorage）              │
└──────────────┬─────────────────────────────────────┘
               │ cs.evalScript("cephostDispatch('font-mixer', {...})")
               │ 入参 JSON 字面量 / 出参 JSON 字符串
┌──────────────▼─────────────────────────────────────┐
│  jsx/host.jsx（ExtendScript，跑在 Photoshop 里）    │
│  字体索引 / 分区算法 / Action Manager 文本读写       │
└─────────────────────────────────────────────────────┘
```

- 宿主不依赖 CEP 自动加载：面板探测不到就自己读入 `jsx/host.jsx` 并显式挂到 `$.global`；
- 文本样式读写走 Action Manager 的 `textKey` / `textStyleRange` 描述符（Photoshop 自己录制的形状），
  写前读回整份 textKey、只覆盖目标字段、丢弃旧的 `engineData`，写后回读校验；
- 字号是唯一会被 Photoshop **静默忽略**的字段：四种候选键/单位逐个试、每种都回读确认才采用；
- 完整架构与真机踩坑记录见 **[docs/LOGIC.md](docs/LOGIC.md)**（分层结构、分区表、校验语义、
  9 个已修复问题的「现象 → 根因 → 修复」对照）。

---

## 开发者

### 目录结构

```
ps-plugin/
├─ com.figmatoolbox.ps/          # 插件本体（CEP 扩展根目录，直接复制安装的就是它）
│  ├─ CSXS/manifest.xml          # 扩展清单：PHSP/PHXS [20.0,99.9]、CEP 9.0+
│  ├─ .debug                     # Chrome 远程调试端口 8092
│  ├─ index.html                 # 面板 UI（与 Figma 版同源）
│  ├─ js/CSInterface.js          # Adobe 官方 CEP 接口库
│  └─ jsx/host.jsx               # ExtendScript 宿主（ES3 方言，纯 ASCII）
├─ audit/                        # 离线测试与核查器（无需 Photoshop）
│  ├─ host-lint.py               #   宿主 ES3 lint
│  ├─ test-host-smoke.js         #   冒烟测试（内置迷你 Photoshop 桩）
│  ├─ test-panel-fit.js          #   弹层几何属性测试（5182 组合）
│  └─ verify-all.js              #   全量静态核查（协议对账/安装一致性/manifest/ES3）
├─ docs/LOGIC.md                 # 架构与逻辑文档 + 真机踩坑记录
├─ install-windows.ps1 / 安装-Windows双击运行.cmd
├─ install-macos.sh
├─ 一键修复签名警告-Windows.cmd    # 「未经正确签名」一键修复
├─ cert/                         # 自签证书（不入库，见下）
├─ tools/                        # ZXPSignCmd（不入库，见下）
└─ dist/                         # 打包产物（不入库）
```

### 测试（全部离线，无需 Photoshop）

```bash
cd ps-plugin
npm run test:ps                 # host-lint + 冒烟 + 视觉字距/拾色器 + 弹层自适应 + 加载器
node audit/verify-all.js        # 全量静态核查（协议对账 / 字段级契约 / 安装一致性 / manifest / ES3）
```

### 打包签名 .ccx / .zxp

仓库不含证书与签名工具，自行准备：

```bash
# 1. 获取 Adobe 官方 ZXPSignCmd（Adobe CEP 资源页下载），放到 tools/
# 2. 生成自签证书（把 <你的密码> 换掉；密码不要提交进仓库）
./tools/ZXPSignCmd.exe -selfSignedCert US California "PS Toolbox" \
  "PS Toolbox Developer" "<你的密码>" cert/ps-toolbox-v2.p12 \
  -locality "San Jose" -orgUnit "Design Tools" -email you@example.com -validityDays 3650

# 2. 签名打包（.ccx = 签名 ZXP）
./tools/ZXPSignCmd.exe -sign com.figmatoolbox.ps "dist/盗版PS的工具箱.ccx" \
  cert/ps-toolbox-v2.p12 "<你的密码>"

# 4. 校验
./tools/ZXPSignCmd.exe -verify "dist/盗版PS的工具箱.ccx" -certInfo -skipOnlineRevocationChecks
```

> 自签名 + PlayerDebugMode 适合个人与小团队分发；正式分发建议换受信任 CA 的代码签名证书
> 并加 `-tsa` 时间戳，可去掉「发布者未知」提示。

### 远程调试

`.debug` 已配置端口 8092：Photoshop 开着面板时，用 Chrome 打开 `http://localhost:8092` 即可审查面板。

---

## 许可证

仅供学习交流使用。Photoshop 是 Adobe Inc. 的商标，本插件与 Adobe 无关。
