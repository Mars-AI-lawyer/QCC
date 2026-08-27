#!/bin/bash
# 企查查速查 · .app 入口（双击即执行）
# 职责：定位 Node 与脚本、日志管理，然后启动 login-heal.js（单实例锁由其内部管理）
set -u

APP_NAME="企查查速查"
LOG="$HOME/Library/Logs/qcc-fast.log"

mkdir -p "$HOME/.qcc" "$HOME/Library/Logs"

# ---- 定位 login-heal.js：优先打包内 Resources，其次源码目录 ----
HEAL=""
if [ -f "$(cd "$(dirname "$0")/../Resources" 2>/dev/null && pwd)/login-heal.js" ]; then
  HEAL="$(cd "$(dirname "$0")/../Resources" && pwd)/login-heal.js"
elif [ -f "$HOME/Documents/ai_agent/QCC/qcc-fast/login-heal.js" ]; then
  HEAL="$HOME/Documents/ai_agent/QCC/qcc-fast/login-heal.js"
fi
if [ -z "$HEAL" ]; then
  /usr/bin/osascript -e 'display dialog "找不到 login-heal.js，请重新运行 install.sh" with title "企查查速查"' >/dev/null 2>&1
  exit 1
fi

# ---- 定位 Node ----
NODE=""
for c in "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
         /opt/homebrew/bin/node \
         /usr/local/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "未找到 node $(date)" >>"$LOG"
  /usr/bin/osascript -e 'display dialog "未找到 Node.js，请安装或更新 launch 配置" with title "企查查速查"' >/dev/null 2>&1
  exit 1
fi

echo "==== ${APP_NAME} 启动 $(date) ====" >"$LOG"
exec "$NODE" "$HEAL" >>"$LOG" 2>&1
