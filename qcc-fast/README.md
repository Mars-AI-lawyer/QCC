# 企查查速查（Mac Dock App · v3 同事分发版）

双击 Dock 图标 → 日常 Chrome 打开查询页【普通标签页】→ 自动换票/登录 → 就绪后进入
30 分钟守护（单窗口守卫 + 中途会话失效自动续期）。**给 Mac 同事的分发包由 `make-dist.sh` 构建。**

## 功能（v3）

- **普通标签页入口**：不再使用 Chrome「应用快捷方式」的 app 独立窗口——那会让每次点击
  都弹新窗口。普通窗口里 `_blank` 链接原生就是"同窗口新标签"。
- **单窗口守卫**：就绪后向页面注入守卫脚本，把"带尺寸参数的弹窗式 window.open"拦下入队，
  由 AppleScript 落成同窗口真标签页（守护期 30 分钟，之后由 Chrome 原生行为接管）。
- **自动登录/续期**：IMS t=1 换票 + 主动会话探针 + 自动填表（沿用 v9/v10 实测选择器）。
- **内置 Node 运行时**（arm64/x64 双架构官方 v22 LTS）：同事电脑无需安装任何依赖。
- **首次使用引导**：首跑弹窗完整告知两个一次性权限（macOS 自动化控制 + Chrome
  「允许 Apple 事件中的 JavaScript」），TCC 拒绝（-1743）也有专门指引。

## 给同事构建分发包

```bash
./make-dist.sh
```

产物：仓库根目录 `企查查速查-Mac安装包.zip`（约 77MB）。同事：解压 → 双击
「安装企查查速查」（首次需右键→打开）→ 选「添加到 Dock」→ 完事。

## 自用安装（开发者本机）

```bash
./install.sh          # 无 .dist-node 时会打包本机 node（仅当前架构）
```

## 文件

| 文件 | 说明 |
|---|---|
| `launcher.sh` | .app 可执行入口：选内置/系统 Node、日志 |
| `login-heal.js` | 状态机：就绪阶段（换票/填表/探针）+ 守护阶段（守卫注入/弹窗排空/续期） |
| `runner.applescript` | AppleScript 桥：LIST / EVAL_FILE / NAV / **OPEN_TAB** / CLOSE_TAB |
| `install.sh` | 组装安装到指定路径（默认 `~/Applications/企查查速查.app`） |
| `get-node.sh` | 获取指定架构官方 Node（本机优先，否则下载 v22 LTS） |
| `make-dist.sh` | 构建同事分发包 zip（含安装器 App 与说明） |

- 日志：`~/Library/Logs/qcc-fast.log`
- 凭据：`~/.qcc/ims-account.json`（0600，仅本机，不在仓库内）

## 注意

- **与浏览器扩展二选一**：同一台电脑不要同时用「企查查速查助手」扩展和本 App，
  两套自动登录会互相抢。已装扩展的机器（如 Mars 本机）无需再装本 App。
- 想回退历史版本：git 历史 `4e2611b` 前后有 v7~v10 全部源码。
