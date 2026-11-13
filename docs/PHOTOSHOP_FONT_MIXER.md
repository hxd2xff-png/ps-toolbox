# Photoshop 字体混排插件

`com.figmatoolbox.ps` 是独立的 CEP 插件，目标版本为 Photoshop 2019（20.x）及以上。

## 行为约束

- 插件只显示字体混排功能；项目中的 Figma 插件保持独立。
- 首次打开面板后异步枚举本机完整字体列表，字体下拉框按需渲染，避免面板首帧卡死。
- 不创建新文档、不打开新标签页、不运行临时文档自检。
- 对当前选区中的每一个文本图层分别应用；单层失败不会中断其它文本图层。
- 中英文颜色按钮通过 Photoshop 原生拾色器取色。
- “视觉字距微调”直接写入 Photoshop 字符设置的 `AutoKernType.OPTICAL`，不再写入自定义符号 tracking。

## 一键安装

双击项目根目录中的：

`install-photoshop-plugin.bat`

也可以在命令提示符中运行：

```cmd
install-photoshop-plugin.bat
```

脚本会完整替换用户级插件目录中的 `com.figmatoolbox.ps`，并自动创建：

`HKCU\\Software\\Adobe\\CSXS.9\\PlayerDebugMode = 1`

该配置用于允许 Photoshop CEP 9 加载未签名扩展，不需要管理员权限。

## 卸载

仅删除插件：

双击项目根目录中的 `uninstall-photoshop-plugin.bat`，然后按提示选择是否移除开发加载配置。

命令行运行：

```cmd
uninstall-photoshop-plugin.bat
```

删除插件并关闭未签名扩展加载：

如果需要无提示移除注册表值，也可以继续使用：

```powershell
.\scripts\uninstall-photoshop-plugin.ps1 -RemoveDebugMode
```

## 手动安装目录

将 `com.figmatoolbox.ps` 文件夹复制到用户级 CEP 扩展目录：

`%APPDATA%\\Adobe\\CEP\\extensions\\com.figmatoolbox.ps`

重启 Photoshop 后，在扩展菜单中打开面板。
