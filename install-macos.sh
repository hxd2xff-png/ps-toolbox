#!/usr/bin/env bash
# ============================================================
#  「盗版PS的工具箱」macOS 一键安装 / 卸载脚本（CEP 扩展，Photoshop 2019+）
#  ------------------------------------------------------------
#  1. 把 com.figmatoolbox.ps 复制到用户级 CEP 扩展目录
#  2. 写入用户域 com.adobe.CSXS.9~14 的 PlayerDebugMode = 1
#  全程只写当前用户（~/Library 与用户 defaults 域），不需要 sudo。
#
#  用法：
#    bash install-macos.sh            # 安装
#    bash install-macos.sh --uninstall
#    bash install-macos.sh --dry-run  # 演练：只打印动作，不实际修改
# ============================================================
set -euo pipefail

EXT_ID="com.figmatoolbox.ps"
BRAND="盗版PS的工具箱"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/$EXT_ID"
TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
CSXS_MIN=9
CSXS_MAX=14

MODE="install"
case "${1:-}" in
  --uninstall) MODE="uninstall" ;;
  --dry-run)   MODE="dryrun" ;;
  "") ;;
  *) echo "用法: bash install-macos.sh [--uninstall] [--dry-run]"; exit 1 ;;
esac

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

echo
cyan "=============================================="
cyan " $BRAND · macOS 一键安装脚本"
cyan "=============================================="
echo

# ---------- 前置检查 ----------
if [ ! -f "$SRC_DIR/CSXS/manifest.xml" ]; then
  red "[错误] 未找到插件目录：$SRC_DIR"
  red "       请保持本脚本与 com.figmatoolbox.ps 目录在同一父目录下再运行。"
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  yellow "[提示] 当前不是 macOS 系统本脚本也能运行（只是 defaults 命令可能不存在），"
  yellow "       如果你在 Windows 上误运行，请改用 install-windows.ps1。"
fi

RUN() {  # dry-run 时只打印命令
  if [ "$MODE" = "dryrun" ]; then
    echo "  [演练] $*"
  else
    "$@"
  fi
}

OK() {  # 成功提示：dry-run 时标注，避免误导
  if [ "$MODE" = "dryrun" ]; then
    echo "  [演练] $*"
  else
    green "  $*"
  fi
}

# ---------- 卸载 ----------
if [ "$MODE" = "uninstall" ]; then
  cyan "[卸载] $BRAND"
  if [ -d "$TARGET_DIR" ]; then
    RUN rm -rf "$TARGET_DIR"
    OK "已删除 $TARGET_DIR"
  else
    yellow "  扩展目录不存在（可能已卸载）"
  fi
  for v in $(seq $CSXS_MIN $CSXS_MAX); do
    key="com.adobe.CSXS.$v"
    # 只删等于 1 的值（兼容字符串 "1"），避免误删用户其他设置
    cur="$(defaults read "$key" PlayerDebugMode 2>/dev/null || true)"
    if [ "$cur" = "1" ]; then
      RUN defaults delete "$key" PlayerDebugMode
      OK "已清除 $key -> PlayerDebugMode"
    fi
  done
  echo
  green "[完成] 卸载完成。若 Photoshop 正在运行，请重启它。"
  exit 0
fi

# ---------- 安装 ----------
cyan "[安装] $BRAND -> $TARGET_DIR"

# 1) 复制扩展（先删旧目录，保证全新副本）
if [ -d "$TARGET_DIR" ]; then
  if [ "$MODE" != "dryrun" ]; then
    yellow "  检测到旧版本，先移除 $TARGET_DIR"
  fi
  RUN rm -rf "$TARGET_DIR"
fi
RUN mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
RUN cp -R "$SRC_DIR" "$TARGET_DIR"
OK "扩展已复制到 $TARGET_DIR"

# 2) 写入 PlayerDebugMode（用户域，无需 sudo）
for v in $(seq $CSXS_MIN $CSXS_MAX); do
  key="com.adobe.CSXS.$v"
  RUN defaults write "$key" PlayerDebugMode -string "1"
  OK "PlayerDebugMode=1 -> $key"
done

# ---------- 完成提示 ----------
echo
green "[完成] 安装完成！"
echo "  下一步："
echo "  1. 重启 Photoshop（若正在运行，请完全退出再打开）"
echo "  2. 菜单「窗口 -> 扩展功能(Extensions) -> $BRAND」打开面板"
echo
