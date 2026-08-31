#!/bin/bash
# 企查查速查 · 打包安装：把源码组装成「企查查速查.app」
# 用法：./install.sh [目标路径]   （默认 ~/Applications/企查查速查.app）
#
# v3：同事分发版。App 内置 login-heal.js（自动登录+单窗口守卫）与官方 Node 运行时
#（arm64/x64，来自 .dist-node/，可先跑 make-dist.sh 准备；缺哪个架构就只打包哪个，
#  运行时对没有内置的架构回落系统 node）。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/Applications/企查查速查.app}"

for f in launcher.sh login-heal.js runner.applescript Info.plist AppIcon.icns; do
  [ -f "$SRC/$f" ] || { echo "缺少 $SRC/$f"; exit 1; }
done

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin"

cp "$SRC/Info.plist"          "$APP/Contents/"
cp "$SRC/AppIcon.icns"        "$APP/Contents/Resources/"
cp "$SRC/login-heal.js"       "$SRC/runner.applescript" "$APP/Contents/Resources/"
cp "$SRC/launcher.sh"         "$APP/Contents/MacOS/qcc-fast-launcher"
chmod +x "$APP/Contents/MacOS/qcc-fast-launcher"

# 内置 Node 运行时（有则打包）
NODE_COPIED=0
for a in arm64 x64; do
  bin="$SRC/.dist-node/node-$a"
  if [ -x "$bin" ]; then
    cp "$bin" "$APP/Contents/Resources/bin/node-$a"
    NODE_COPIED=$((NODE_COPIED + 1))
  fi
done
if [ "$NODE_COPIED" -eq 0 ]; then
  # 回落：打包本机 node（仅当前架构可用，适合自用；同事分发请先跑 make-dist.sh）
  if command -v node >/dev/null 2>&1; then
    MYARCH="$(uname -m)"; [ "$MYARCH" = "x86_64" ] && MYARCH=x64
    cp "$(command -v node)" "$APP/Contents/Resources/bin/node-$MYARCH"
    NODE_COPIED=1
    echo "提示：只打包了本机架构($MYARCH)的 node；给同事分发请先运行 make-dist.sh"
  else
    echo "警告：未找到任何 node，App 将只能依赖对方系统的 node"
  fi
fi

# 刷新 Finder/LaunchServices 缓存，让 .app 立即生效
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" >/dev/null 2>&1 || true

echo "已安装: $APP (内置 node×$NODE_COPIED)"
