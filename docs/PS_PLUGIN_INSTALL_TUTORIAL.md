# PS 插件安装 / 更新与字体方案迁移教程

> 适用：Windows 上的 Photoshop（PS 2019 及以上），插件名 **盗版PS的工具箱**
> 全程本地操作，不联网。

---

## 一、先看清安装包里有啥

解压 `PS-all-in-one.zip`，需要的文件/目录：

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `uninstall-photoshop-plugin.bat` | Windows 批处理 | **卸载**（清掉旧版插件目录，可选清注册表） |
| `install-photoshop-plugin.bat` | Windows 批处理 | **安装**（复制插件目录 + 开 CEP 调试加载） |
| `com.figmatoolbox.ps` | 文件夹 | 插件本体（CEP 面板） |

其他 `.md` 文件是开发记录，用不到，忽略即可。

---

## 二、标准三步走（截图里的流程）

### 第 1 步：先关掉 Photoshop

必须完全退出 PS（不是最小化）。任务栏右键退出，或任务管理器里确认没有 `Photoshop.exe` 残留。

> 原因：插件目录被占用时删不掉、也复制不进去，安装会失败。

### 第 2 步：运行**红色框**那个 —— 卸载

双击 `uninstall-photoshop-plugin.bat`。

它会做两件事：

1. 删除 `%APPDATA%\Adobe\CEP\extensions\com.figmatoolbox.ps`
   - 成功 → 打印 `Removed plugin: "..."`
   - 目录本来就不存在 → 打印 `Plugin directory not found; nothing to remove.`（正常，继续）
2. 弹出一句询问：

   ```
   Also remove CSXS.9 PlayerDebugMode=1? [Y/N]
   ```

   - **更新插件时按 `N`**（保留调试加载开关，省得重装时再开一次）
   - **彻底清理、不再用插件时按 `Y`**（会删掉 `HKCU\Software\Adobe\CSXS.9\PlayerDebugMode`）

看到 `Uninstall processing complete. Restart Photoshop.` 就算完成。

> 任何一步失败都会打印 `[ERROR] ...` 并停下，不会假装成功。看到 `[ERROR]` 就截图报出来，别继续往下走。

### 第 3 步：运行**绿色框**那个 —— 安装

双击 `install-photoshop-plugin.bat`。

它按顺序做：

1. 检查 `com.figmatoolbox.ps\CSXS\manifest.xml` 在不在（不在 → `[ERROR] Source plugin not found`）
2. 确保 `%APPDATA%\Adobe\CEP\extensions` 存在
3. 删掉旧的 `com.figmatoolbox.ps` 目录（删不掉 → `[ERROR] Could not remove previous plugin directory.`）
4. 用 `robocopy` 把插件整目录复制进去
5. 写入注册表：`HKCU\Software\Adobe\CSXS.9\PlayerDebugMode = 1`（CEP 允许加载未签名扩展）

成功时输出：

```
Photoshop plugin installed successfully.
Plugin: "C:\Users\<你的用户名>\AppData\Roaming\Adobe\CEP\extensions\com.figmatoolbox.ps"
Registry: HKCU\Software\Adobe\CSXS.9\PlayerDebugMode = 1
Restart Photoshop before opening the extension.
```

---

## 三、打开插件：菜单里会多出来的那个

**重启 Photoshop**（装完不重启，菜单里不会出现）。

然后：

```
窗口(W) → 扩展功能 → 盗版PS的工具箱
```

在这个子菜单下，除了已有的 `Adobe Color Themes`、`BBTools 阴影`、`MixType Classic Lab 0.2` 之类，会**多出「盗版PS的工具箱」**——就是截图红框圈的那一条。点它，面板就出来了。

> 名字来自插件清单 `<Menu>盗版PS的工具箱</Menu>`，装的是哪个包，这里就显示哪个名字。

---

## 四、把 Figma 的字体方案搬到 PS 插件里（通用）

方案文件是同一份结构，Figma 侧导出的 JSON 可以直接在 PS 插件里导入，不用重建。

### 1. Figma 侧：导出方案

在 Figma 插件的字体混排页，把已经调好的方案**导出**，得到一个 JSON 文件（形如 `font-presets.json`）。

### 2. PS 侧：导入方案

在 PS 插件面板 → 字体混排页 → 最下面 **「方案管理」** 卡片：

1. 点 **「导入方案」**
2. 选刚才那个 JSON 文件
3. 提示 `已导入 N 个方案（新增 M）` 即成功

导入规则（按代码实际行为）：

- 文件必须是**数组**，否则提示 `JSON 解析失败，请检查文件`
- 每条方案必须有 `name` 字段（字符串），没有的会被跳过
- **同名方案覆盖，不同名追加**，不会重复堆叠

### 3. 用方案

1. 面板顶部 **「方案」** 下拉（默认显示「未选择方案」）里挑一个
2. 选中后表单自动填入该方案的中/英文字体、字号、字色等
3. 需要微调就改
4. 点 **「应用字体混排与颜色」**（左半，连字色一起按设置改）或 **「应用字体混排」**（右半，只改字体字号，完全保留原文字色）

> 方案保存在插件本地存储，关掉 PS 再开还在；全程不联网。
> 同一份方案也能反向操作：PS 侧点「导出全部」得到 `font-presets.json`，再拿到 Figma 那边导入。

「方案管理」卡片里其他按钮：

| 按钮 | 作用 |
| --- | --- |
| 方案名输入框 + 「保存为方案」 | 把当前表单存成新方案；已选中方案时按钮变「更新当前方案」，改完直接覆盖 |
| 「导出全部」 | 下载 `font-presets.json`（全部方案） |
| 「导入方案」 | 选 JSON 文件，按名称去重合并 |

---

## 五、排错

### 扩展菜单里找不到「盗版PS的工具箱」

按顺序查：

1. **PS 重启了吗** —— 没重启一定不出现。
2. **窗口 → 扩展功能** 这个子菜单本身有没有 —— 没有说明你的 PS 不支持 CEP 扩展（版本太老）。
3. **插件目录在不在**：

   ```
   %APPDATA%\Adobe\CEP\extensions\com.figmatoolbox.ps\CSXS\manifest.xml
   ```

   在资源管理器地址栏粘贴上面这行（`%APPDATA%` 会自动展开）。
4. **注册表开关**：`HKCU\Software\Adobe\CSXS.9\PlayerDebugMode` 是不是 `1`。

### 装了但菜单还没有：CSXS 版本这个坑

`install-photoshop-plugin.bat` 只写 **`CSXS.9`** 这一个键。

- PS 2019 / 2020 用 CEP 9 —— 没问题
- PS 2021 及更新版本用 CEP 10 / 11 —— 只写 `CSXS.9` 可能不够

这种情况下改用仓库里的 PowerShell 版本，它把 **CSXS 9 到 19 全部写上**：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-photoshop-plugin.ps1
```

跑完同样重启 PS。

### 提示 `[ERROR] Could not remove previous plugin directory.`

旧目录被占用。关掉 PS（以及所有 Adobe 进程），再重跑一次安装脚本。

### 导入方案提示 `JSON 解析失败，请检查文件`

- 文件不是合法 JSON，或最外层不是数组 `[...]`
- 用记事本打开看一眼：第一条必须是 `{ "name": "...", ... }`

---

## 六、卸载干净

1. 关掉 PS
2. 双击 `uninstall-photoshop-plugin.bat`
3. 询问 `Also remove CSXS.9 PlayerDebugMode=1?` 时按 **`Y`**（连注册表开关一起清掉）
4. 看到 `Uninstall processing complete. Restart Photoshop.` 完成

---

## 附：方案 JSON 的字段结构

PS 插件导出的每条方案长这样（`com.figmatoolbox.ps/index.html` 里 `readFormAsScheme` 的字段）：

```json
{
  "name": "中文正文",
  "cnFont": { "family": "...", "style": "..." },
  "enFont": { "family": "...", "style": "..." },
  "cnSize": 12,
  "enSize": 10,
  "symbolFontSide": "en",
  "syncColor": false,
  "cnColor": { "r": 0, "g": 0, "b": 0 },
  "enColor": { "r": 0, "g": 0, "b": 0 }
}
```

- `cnFont` / `enFont`：`{ "family": "...", "style": "..." }`
- `symbolFontSide`：`"cn"` 或 `"en"`，未指定时为 `null`
- `cnColor` / `enColor`：`r` / `g` / `b` 都是 **0～1 的小数**（不是 0～255），例如纯白是 `{"r":1,"g":1,"b":1}`
- `name` 是唯一键：同名覆盖、异名追加

手工拼文件时至少要给 `name`、`cnFont`、`enFont`、`cnSize`、`enSize`；其余字段缺失按默认处理（例如旧方案没有 `syncColor`，按「不同步颜色」对待）。