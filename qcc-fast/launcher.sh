#!/bin/bash
# 企查查速查 · Mac Dock 入口（v3：内置 Node + 自动登录 + 单窗口守卫）
# 双击后：定位内置/系统 Node → exec login-heal.js（单实例锁、日志在其内部管理）
set -u

APP_NAME="企查查速查"
LOG="$HOME/Library/Logs/qcc-fast.log"

mkdir -p "$HOME/.qcc" "$HOME/Library/Logs"

# ---- 定位程序文件：优先打包内 Resources，其次源码目录 ----
RES="$(cd "$(dirname "$0")/../Resources" 2>/dev/null && pwd)"
HEAL=""
[ -n "$RES" ] && [ -f "$RES/login-heal.js" ] && HEAL="$RES/login-heal.js"
[ -z "$HEAL" ] && [ -f "$HOME/Documents/ai_agent/QCC/qcc-fast/login-heal.js" ] && \
  HEAL="$HOME/Documents/ai_agent/QCC/qcc-fast/login-heal.js"
if [ -z "$HEAL" ]; then
  /usr/bin/osascript -e 'display dialog "找不到程序文件，请重新运行安装包" with title "企查查速查"' >/dev/null 2>&1
  exit 1
fi

# ---- 定位 Node：优先内置（按芯片架构），回落系统 node ----
ARCH="$(uname -m)"
NODE=""
if [ "$ARCH" = "arm64" ] && [ -n "$RES" ] && [ -x "$RES/bin/node-arm64" ]; then
  NODE="$RES/bin/node-arm64"
elif [ "$ARCH" = "x86_64" ] && [ -n "$RES" ] && [ -x "$RES/bin/node-x64" ]; then
  NODE="$RES/bin/node-x64"
fi
[ -z "$NODE" ] && NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  /usr/bin/osascript -e 'display dialog "未找到内置 Node 运行时，安装包可能不完整，请重新安装" with title "企查查速查"' >/dev/null 2>&1
  exit 1
fi

echo "==== ${APP_NAME} 启动 $(date) ====" >"$LOG"
exec "$NODE" "$HEAL" >>"$LOG" 2>&1
