#!/bin/zsh
# 企查查查询 .app 启动器 v6
# 核心修复：
#   1) 调试端口不再写死 9222 —— 用户日常 Chrome 长期占用 9222 导致 v5 的 CDP 守护进程
#      永远连不上（日志 FATAL: CDP not ready），这是"点了没反应"的主因。改为每次启动选一个空闲端口。
#   2) 修复同步 bug：v5 把 Resources/auto-login.js 当目录检查，安装包里的脚本从未被同步，
#      ~/.qcc/ 里一直跑的是旧文件。现在逐个候选路径按文件复制。
#   3) 启动 URL 直接指向 sysAuth/plugin.aspx?t=1（实测：有会话→302 直达企查查票据登录；
#      无会话→302 到 login.aspx?rurl=...，登录成功后服务器自动弹回 t=1 链路）。
#      不再依赖"点企查查 → 点点击访问"的模拟点击。

set -e

QCC_DIR="$HOME/.qcc"
PROFILE_DIR="$QCC_DIR/profile"
AUTO_JS="$QCC_DIR/auto-login.js"
SCRIPT_PATH="$0"
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"

# === 定位 auto-login.js（打包安装模式 / 源码目录模式都兼容）===
SRC_AUTO=""
for cand in "$BIN_DIR/../Resources/auto-login.js" \
            "$HOME/Documents/ai_agent/QCC/qcc-app/auto-login.js"; do
  if [ -f "$cand" ]; then SRC_AUTO="$cand"; break; fi
done
if [ -n "$SRC_AUTO" ]; then
  mkdir -p "$QCC_DIR"
  cp -f "$SRC_AUTO" "$AUTO_JS"
fi
if [ ! -f "$AUTO_JS" ]; then
  osascript -e 'display dialog "自动登录脚本缺失，请重新安装本应用。" buttons {"好"} default button "好"' >/dev/null 2>&1 || true
  exit 1
fi

# === Node ===
NODE_BIN=""
for cand in "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
            "$(command -v node 2>/dev/null)" \
            "/opt/homebrew/bin/node" \
            "/usr/local/bin/node"; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  osascript -e 'display dialog "未找到 node，无法启动自动登录。" buttons {"好"} default button "好"' >/dev/null 2>&1 || true
  exit 1
fi

# === profile：全新会话外观（cookie 保留，方便二次秒进）===
mkdir -p "$PROFILE_DIR/Default"
rm -f "$PROFILE_DIR/Default/Current Session" \
      "$PROFILE_DIR/Default/Current Tabs" \
      "$PROFILE_DIR/Default/Last Session" \
      "$PROFILE_DIR/Default/Last Tabs" \
      "$PROFILE_DIR/Default/Secure Preferences" \
      "$PROFILE_DIR/Default/Network Action Predictor" 2>/dev/null || true
rm -rf "$PROFILE_DIR/Default/Sessions" 2>/dev/null || true

cat > "$PROFILE_DIR/Default/Preferences" << 'PREFEOF'
{
  "browser": {
    "has_seen_welcome_page": true,
    "check_default_browser": false
  },
  "session": {
    "restore_on_startup": 4,
    "exit_type": "Normal",
    "crashed": false
  },
  "startup": {
    "restore_on_startup": 4,
    "urls": ["https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1"]
  },
  "bookmark": {
    "show_bookmark_bar": false
  },
  "distribution": {
    "import_existing_bookmarks": false,
    "skip_first_run_ui": true,
    "show_welcome_page": false,
    "suppress_first_run_default_browser_prompt": true
  }
}
PREFEOF

# === 杀掉旧实例（同 profile 的 Chrome + 旧守护进程）===
pkill -f "$PROFILE_DIR" 2>/dev/null || true
pkill -f ".qcc/auto-login.js" 2>/dev/null || true
sleep 0.4

# === 选一个空闲调试端口（关键修复）===
CDP_PORT=""
for i in {1..30}; do
  P=$((RANDOM % 20000 + 30000))
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:$P -sTCP:LISTEN >/dev/null 2>&1 || { CDP_PORT=$P; break; }
  else
    CDP_PORT=$P; break
  fi
done
[ -z "$CDP_PORT" ] && CDP_PORT=9333
echo "$CDP_PORT" > "$QCC_DIR/cdp.port"

# === 先起 node 守护（它自己轮询等 CDP 就绪），再 exec Chrome ===
export QCC_CDP_PORT="$CDP_PORT"
nohup "$NODE_BIN" "$AUTO_JS" >> /tmp/qcc-auto.log 2>&1 &
disown

# === Chrome ===
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  CHROME_FOUND=$(mdfind "kMDItemFSName == 'Google Chrome.app'" 2>/dev/null | head -1)
  [ -n "$CHROME_FOUND" ] && CHROME="$CHROME_FOUND/Contents/MacOS/Google Chrome"
fi
if [ ! -x "$CHROME" ]; then
  osascript -e 'display dialog "未找到 Google Chrome，请先安装。" buttons {"好"} default button "好"' >/dev/null 2>&1 || true
  exit 1
fi

exec "$CHROME" \
  --app="https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI \
  --disable-session-crashed-bubble \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  "$@"
