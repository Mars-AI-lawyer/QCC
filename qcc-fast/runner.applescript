-- 企查查速查 · AppleScript 桥（静态脚本，任何敏感信息都不经过参数）
-- 用法（login-heal.js 经 osascript 调用，参数不足时以空串补齐）：
--   LIST                                → 输出每行 "窗口id|tab序号|URL"
--   EVAL_FILE <jsFile> <winId> <tabIdx> → 执行 jsFile 内容于指定 tab，返回其字符串结果
--   NAV <winId> <tabIdx> <url>          → 指定 tab 导航
--   OPEN_TAB <winId> <url>              → 同一窗口末尾开新标签并激活（单窗口守卫用）
--   BG_TAB <winId> <origIdx> <url>      → 末尾开新标签后立刻把焦点还原到 origIdx（后台换票用）
--   RELOAD <winId> <tabIdx>             → 重新加载指定 tab
--   ACTIVATE_TAB <winId> <tabIdx>       → 激活指定 tab（需要用户手动登录时才用）
--   CLOSE_TAB <winId> <tabIdx>          → 关闭指定 tab

on run argv
	-- 前缀命名避免与 Chrome 字典术语冲突；防御式取参防止 -1721
	set gMode to ""
	set gA to ""
	set gB to ""
	set gC to ""
	if (count of argv) > 0 then set gMode to item 1 of argv
	if (count of argv) > 1 then set gA to item 2 of argv
	if (count of argv) > 2 then set gB to item 3 of argv
	if (count of argv) > 3 then set gC to item 4 of argv

	-- 统一槽位语义：
	--   EVAL_FILE : p1=js文件路径  p2=窗口id  p3=tab序号
	--   NAV       : p1=窗口id      p2=tab序号 p3=目标URL
	--   CLOSE_TAB : p1=窗口id      p2=tab序号

	-- tell 之外读文件，避免 StandardAdditions 命令被路由到 Chrome
	set gJs to ""
	if gMode is "EVAL_FILE" then set gJs to read (POSIX file gA) as «class utf8»

	tell application "Google Chrome"
		if gMode is "LIST" then
			set outText to ""
			repeat with i from 1 to (count of windows)
				repeat with j from 1 to (count of tabs of window i)
					set outText to outText & ((id of window i) as text) & "|" & (j as text) & "|" & (URL of tab j of window i) & linefeed
				end repeat
			end repeat
			return outText

		else if gMode is "EVAL_FILE" then
			set gWin to (gB as integer)
			set gTab to (gC as integer)
			return execute (tab gTab of window id gWin) javascript gJs

		else if gMode is "NAV" then
			set gWin to (gA as integer)
			set gTab to (gB as integer)
			set URL of tab gTab of window id gWin to gC
			return "OK"

		else if gMode is "OPEN_TAB" then
			set gWin to (gA as integer)
			make new tab at end of tabs of window id gWin with properties {URL:gC}
			set active tab index of window id gWin to (count of tabs of window id gWin)
			return "OK"

		else if gMode is "BG_TAB" then
			set gWin to (gA as integer)
			set gOrig to (gB as integer)
			make new tab at end of tabs of window id gWin with properties {URL:gC}
			set active tab index of window id gWin to gOrig
			return "OK"

		else if gMode is "RELOAD" then
			set gWin to (gA as integer)
			set gTab to (gB as integer)
			reload tab gTab of window id gWin
			return "OK"

		else if gMode is "ACTIVATE_TAB" then
			set gWin to (gA as integer)
			set gTab to (gB as integer)
			set active tab index of window id gWin to gTab
			return "OK"

		else if gMode is "CLOSE_WIN" then
			set gWin to (gA as integer)
			close window id gWin
			return "OK"

		else if gMode is "CLOSE_TAB" then
			set gWin to (gA as integer)
			set gTab to (gB as integer)
			close tab gTab of window id gWin
			return "OK"

		else
			return "UNKNOWN"
		end if
	end tell
end run
