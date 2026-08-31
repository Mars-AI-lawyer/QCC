#!/bin/bash
# 企查查速查 · 构建同事分发包：QCC-Mac-Installer.zip
#
# 产物结构（解压后）：
#   企查查速查-Mac安装包/
#     !先看这里-安装说明.txt
#     安装企查查速查.app     ← 同事双击这个（右键→打开）
#     企查查速查.app          ← 主程序（安装器负责复制到 ~/Applications）
#
# 主 App 内置双架构官方 Node（arm64 本机取 / x64 下载），同事无需安装任何依赖。
# zip 文件名用 ASCII：GitHub Release 附件不支持中文文件名。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SRC")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
OUT_ZIP="$ROOT/QCC-Mac-Installer.zip"

# ---------- 1) 准备双架构内置 Node ----------
mkdir -p "$SRC/.dist-node"
for a in arm64 x64; do
  bin="$(bash "$SRC/get-node.sh" "$a")"
  cp "$bin" "$SRC/.dist-node/node-$a"
  echo "node-$a ← $bin"
done

# ---------- 2) 组装主 App 到暂存目录 ----------
bash "$SRC/install.sh" "$STAGE/企查查速查-Mac安装包/企查查速查.app"

# ---------- 3) 组装安装器 App ----------
IAPP="$STAGE/企查查速查-Mac安装包/安装企查查速查.app"
mkdir -p "$IAPP/Contents/MacOS"

cat >"$IAPP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>installer</string>
	<key>CFBundleName</key>
	<string>安装企查查速查</string>
	<key>CFBundleDisplayName</key>
	<string>安装企查查速查</string>
	<key>CFBundleIdentifier</key>
	<string>com.allbrightlaw.qccfast.installer</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>3.0</string>
	<key>CFBundleVersion</key>
	<string>3</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

cat >"$IAPP/Contents/MacOS/installer" <<'INSTALLER'
#!/bin/bash
# 安装器：复制主程序到 ~/Applications → 去隔离 → 可选自动加 Dock
set -u
QCC_SILENT="${QCC_SILENT:-}"

ME="$(cd "$(dirname "$0")/../../.." && pwd)"   # MacOS/installer → Contents → .app → 目录
APP_SRC="$ME/企查查速查.app"
DEST="$HOME/Applications/企查查速查.app"

say() { # 静默测试模式下不打对话框
  if [ -z "$QCC_SILENT" ]; then
    /usr/bin/osascript -e "display dialog \"$1\" with title \"企查查速查 安装\" buttons {\"好\"} default button \"好\"" >/dev/null 2>&1
  else
    echo "[dialog] $1"
  fi
}

if [ ! -d "$APP_SRC" ]; then
  say "安装包不完整（缺少主程序），请重新解压后再试"
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$APP_SRC" "$DEST"
# 去掉隔离属性：装好的 App 双击不再触发 Gatekeeper
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$DEST" >/dev/null 2>&1 || true

if [ -n "$QCC_SILENT" ]; then
  echo "installed: $DEST"
  exit 0
fi

ANS="$(/usr/bin/osascript -e 'display dialog "✅ 「企查查速查」已安装完成\n\n首次使用会引导你开两个一次性权限。\n\n是否把它自动添加到 Dock（程序坞）？" with title "企查查速查 安装" buttons {"不用了", "添加到 Dock"} default button "添加到 Dock"' -e 'button returned of result' 2>/dev/null || echo "")"

if [ "$ANS" = "添加到 Dock" ]; then
  URL="file://$DEST"
  /usr/bin/defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$URL</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
  /usr/bin/killall Dock 2>/dev/null || true
  say "已完成！点 Dock 上的「企查查速查」图标即可开始使用 🎉"
else
  say "已完成！\n\n打开「应用程序」文件夹，把「企查查速查」拖到 Dock 即可每天使用 🎉"
fi
INSTALLER
chmod +x "$IAPP/Contents/MacOS/installer"

# ---------- 4) 安装说明 ----------
cat >"$STAGE/企查查速查-Mac安装包/!先看这里-安装说明.txt" <<'README'
【企查查速查 · Mac 安装说明】（约 1 分钟）

1. 双击「安装企查查速查」。
   · 若提示"无法验证开发者"：在「安装企查查速查」上【右键 → 打开 → 再点打开】
   · 若右键也没有"打开"：系统设置 → 隐私与安全性 → 底部点【仍要打开】
2. 弹窗里选「添加到 Dock」，之后每天点 Dock 上的图标即可。
3. 首次使用会引导两个一次性设置（照着弹窗点就行）：
   · macOS 弹「想要控制 Google Chrome」→ 点【好】
   · Chrome 菜单栏【查看 ▸ 开发者 ▸ 勾选 允许 Apple 事件中的 JavaScript】
4. 首次登录输入一次 IMS 账号密码（只保存在你自己的电脑上），
   以后自动登录，点击企业都在同一个窗口里开新标签。

常见问题：
· 点图标没反应 → 看日志：~/Library/Logs/qcc-fast.log
· 密码错了 → 会自动弹窗让你重新输入
· 本工具与「企查查速查助手」浏览器扩展二选一即可，不要同时用
README

# ---------- 5) 打 zip ----------
rm -f "$OUT_ZIP"
(cd "$STAGE" && zip -qry "$OUT_ZIP" "企查查速查-Mac安装包")

echo
echo "✅ 分发包已生成: $OUT_ZIP"
ls -lh "$OUT_ZIP"
unzip -l "$OUT_ZIP"
