# 企查查速查 · 分发说明

![平台](https://img.shields.io/badge/平台-macOS%20%7C%20Windows-0969da)
![浏览器](https://img.shields.io/badge/浏览器-Chrome%20%7C%20Edge-2ea44f)
![系统权限](https://img.shields.io/badge/系统权限-无需开启-success)
![密码](https://img.shields.io/badge/密码-仅存本机-orange)
![Mac入口](https://img.shields.io/badge/Mac入口-Dock双击即用-8250df)
![版本](https://img.shields.io/badge/版本-Mac%20App%20v3.0%20%7C%20扩展%20v1.0-informational)

一键打开企查查插件查询页，自动完成 IMS 登录与续期；所有点击都收敛在**同一个窗口**里以新标签管理。
按同事的电脑类型二选一（**同一台电脑不要两个都装**，两套自动登录会互相抢）：

| 同事电脑 | 发给他 | 同事要做什么 |
|---|---|---|
| **Mac** | `企查查速查-Mac安装包.zip` | 解压 → 双击「安装企查查速查」（首次需右键→打开）→ 选「添加到 Dock」→ 完成。之后每天双击 Dock 图标。 |
| **Windows** | `qcc-extension.zip` | 解压 → 按自动弹出的图文引导装扩展（约 1 分钟）→ 点工具栏图标使用。 |

两个包都在本仓库根目录；都不会上传任何账号密码。

---

## Mac：Dock App（`企查查速查-Mac安装包.zip`）

- 零依赖：内置双架构（Apple Silicon / Intel）官方 Node 运行时，同事无需装任何东西。
- 自动登录：首次输入一次 IMS 账号密码（只存本机 `~/.qcc/ims-account.json`，0600），之后自动登录、自动续期。
- 首次使用的两个一次性权限，App 会弹窗全程引导：
  1. macOS 弹「“企查查速查”想要控制“Google Chrome”」→ 点【好】；
  2. Chrome 菜单栏【查看 ▸ 开发者 ▸ 勾选 允许 Apple 事件中的 JavaScript】。
- 单窗口：入口用普通标签页 + 页面内守卫，点击企业/详情都只在当前窗口开新标签。
- 日志：`~/Library/Logs/qcc-fast.log`；密码错了会自动弹窗重录。

## Windows：Chrome 扩展（`qcc-extension.zip`）

- Mac 的 Chrome/Edge 也能用同一份扩展（但 Mac 同事建议用上面的 Dock App，二选一）。
- 安装五步（扩展装好会**自动弹出图文引导页**，照着做即可）：
  解压 → 地址栏输入 `chrome://extensions` → 打开右上角「开发者模式」→
  「加载已解压的扩展程序」选 `extension` 文件夹 → 拼图图标里固定到工具栏。
- **不需要任何系统权限**（不需要辅助功能/自动化/屏幕录制）；扩展只访问
  `pro-plugin.qcc.com` 和 `ims.allbrightlaw.com` 两个网站。
- 密码只存本机浏览器扩展存储（`chrome.storage.local`），不上传、不同步；
  工具栏图标右键 →「选项」可修改/清除；连错 3 次自动停用已存密码。
- 注意：`extension` 文件夹解压后要一直留在电脑上，别删。

## 密码与代码安全

- 两个分发包、本仓库源码内**均不含任何账号密码**，可放心外发/推送 GitHub。
- 同事的密码分别只存在各自电脑（Mac：本机文件；Windows：浏览器本地存储），换电脑需重输一次。

## 开发者（Mars）备忘

```
extension/            Chrome 扩展源码（跨平台主体）
qcc-fast/             Mac Dock App 源码
  make-dist.sh        构建 Mac 分发包 zip（双架构 Node 自动就位）
  install.sh          自用安装到 ~/Applications/企查查速查.app
  get-node.sh         获取官方 Node 二进制（本机优先/下载 v22 LTS）
qcc-extension.zip     → 发 Windows 同事
企查查速查-Mac安装包.zip → 发 Mac 同事
```

- 已装扩展的机器（如本机）不要再跑 `install.sh` 装 Dock App，二选一。
- 代码更新后重新分发：Mac 跑 `./make-dist.sh` 重打包；Windows 重新打包 `extension/`，
  同事覆盖原文件夹后在扩展管理页点刷新 ↻（账号密码不丢）。

## 排障速查

| 现象 | 处理 |
|---|---|
| Mac 点 Dock 没反应 | 看 `~/Library/Logs/qcc-fast.log`；多数是权限 1/2 未开，App 弹窗有完整指引 |
| Mac 仍弹新窗口 | 确认是双击 Dock 图标打开（普通标签页），而不是旧的桌面「应用快捷方式」 |
| Win 点扩展没反应 | `chrome://extensions` 确认已启用；点「服务工作进程」看日志 |
| Win 提示「已被管理员停用」 | 企业管控版 Chrome 禁止未上架扩展，需 IT 放行或用个人版 Chrome/Edge |
