#!/bin/bash
# 获取指定架构的官方 Node 二进制（macOS），输出其路径
# 用法: get-node.sh arm64|x64
# 优先取本机同架构 node，否则从 nodejs.org 下载官方 v22 LTS 到 ~/.cache/qcc-dist/
set -euo pipefail

ARCH="${1:?用法: get-node.sh arm64|x64}"

# 本机 node 架构匹配则直接复用（不下载）
if command -v node >/dev/null 2>&1; then
  MYARCH="$(uname -m)"; [ "$MYARCH" = "x86_64" ] && MYARCH=x64
  if [ "$MYARCH" = "$ARCH" ]; then
    command -v node
    exit 0
  fi
fi

VER_FILE="$HOME/.cache/qcc-dist/.node22ver"
mkdir -p "$(dirname "$VER_FILE")"
if [ ! -s "$VER_FILE" ]; then
  # 从官方 latest-v22.x 目录页解析实际版本号
  VER="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ \
    | grep -o 'node-v[0-9.]*-darwin-arm64.tar.gz' | head -1 \
    | sed -E 's/^node-v([0-9.]+)-.*/\1/')"
  [ -n "$VER" ] || { echo "无法解析 node 版本号" >&2; exit 1; }
  echo "$VER" >"$VER_FILE"
fi
VER="$(cat "$VER_FILE")"

CACHE="$HOME/.cache/qcc-dist/node-v$VER-darwin-$ARCH"
BIN="$CACHE/bin/node"
if [ ! -x "$BIN" ]; then
  URL="https://nodejs.org/dist/v$VER/node-v$VER-darwin-$ARCH.tar.gz"
  echo "下载 $URL" >&2
  mkdir -p "$CACHE"
  curl -fsSL "$URL" | tar -xz -C "$CACHE" --strip-components=1
fi
[ -x "$BIN" ] || { echo "下载后仍找不到 $BIN" >&2; exit 1; }
echo "$BIN"
