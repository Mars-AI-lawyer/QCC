# 企查查速查（方案A：复用日常 Chrome）

双击入口 → 日常 Chrome 秒开「企业信息查询平台」应用窗口；会话过期时**同一窗口内自动补登录**，全程无感。

## 使用

1. 安装（仅需一次 / 代码更新后重跑）：

   ```bash
   ./install.sh
   ```

2. 开启一次性权限（脚本首次运行也会以系统通知引导）：

   > Chrome 菜单 **查看 ▸ 开发者 ▸ 允许 Apple 事件中的 JavaScript**
   > (与 Chrome 官方提示一致)

3. 把 `~/Applications/企查查速查.app` 拖入 Dock。之后每天点它即可。

## 流程

```
双击入口
 └─ open -a 「企业信息查询平台.app」（你的 Chrome shim，秒开应用窗口）
     └─ 统一跳转 ims plugin.aspx?t=1 换取【新会话票据】
         （插件会话存活期短、直连旧会话"一点就失效"，故每次启动都换新票；
          IMS Cookie 长命——它有效则直接换票成功，无需登录）
     ├─ IMS Cookie 有效 → 链路自动落回查询页 → 主动探针（模拟点击/输入触发鉴权）
     │   → 稳定后通知"已就绪"（全程约 10 秒）
     └─ IMS Cookie 失效 → 自动切"账户登录"填账密提交 → 回查询页 → 探针 → 就绪
         （密码错最多试 3 次，随后删除 ~/.qcc/ims-account.json 弹窗重录）
```

## 文件

| 文件 | 说明 |
|---|---|
| `launcher.sh` | .app 可执行入口：找 Node、单实例锁、日志 |
| `login-heal.js` | 状态机：350ms 轮询检测 tab 状态，按需导航/填表 |
| `runner.applescript` | AppleScript→Chrome 桥：枚举标签页 / 注入 JS / 导航 / 关页 |
| `install.sh` | 组装安装到 `~/Applications/企查查速查.app` |

- 日志：`~/Library/Logs/qcc-fast.log`（每次启动重建）
- 凭据：`~/.qcc/ims-account.json`（0600，本机保存，App 内不含密码；与旧版 qcc-app 格式互通）

## 排障

- **通知提示开启权限**：按上面第 2 步勾选后重试。
- **多次输错密码**：凭据文件会被自动删除并弹窗重录。
- **想回退旧版**：旧 qcc-app 已从仓库删除，git 历史里仍可找回（v7 提交）。

## 与旧版方案的差异

不再每次冷启动独立 Chrome 实例 + CDP 守护进程（那是打开慢的根因），也无需调试端口；
日常 Chrome 主 profile 缓存热、窗口秒开，自动化改走 macOS AppleScript 事件通道。
