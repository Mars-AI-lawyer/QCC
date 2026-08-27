#!/bin/bash
# 企查查速查 · 打包安装：把源码组装成 ~/Applications/企查查速查.app
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/企查查速查.app"

for f in launcher.sh login-heal.js runner.applescript Info.plist AppIcon.icns; do
  [ -f "$SRC/$f" ] || { echo "缺少 $SRC/$f"; exit 1; }
done

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$SRC/Info.plist"     "$APP/Contents/"
cp "$SRC/AppIcon.icns"   "$APP/Contents/Resources/"
cp "$SRC/login-heal.js"  "$SRC/runner.applescript" "$APP/Contents/Resources/"
cp "$SRC/launcher.sh"    "$APP/Contents/MacOS/qcc-fast-launcher"
chmod +x "$APP/Contents/MacOS/qcc-fast-launcher"

# 刷新 Finder/LaunchServices 缓存，让改名后的 .app 立即生效
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" >/dev/null 2>&1 || true

echo "已安装: $APP"
