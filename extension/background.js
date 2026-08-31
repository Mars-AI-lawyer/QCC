'use strict';
/*
 * 企查查速查助手 · background service worker
 *
 * 职责：
 *  - 工具栏按钮：聚焦/新建查询页标签（普通标签页，天然支持单窗口多标签）
 *  - OPEN_TAB：把页面里被拦截的 window.open / _blank 链接落到同一窗口的相邻标签
 *  - HEAL_NEEDED：会话失效时跳 IMS t=1 换新票（带冷却与次数上限，移植 qcc-fast 参数）
 *  - 首次安装自动打开引导页
 */

const PLUGIN_SEARCH_URL = 'https://pro-plugin.qcc.com/plugin-search';
const IMS_T1_URL = 'https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1';

// 与 login-heal.js 保持一致的自愈节流参数
const HEAL_MAX_NAVS = 4;
const HEAL_NAV_COOLDOWN_MS = 4500;
const HEAL_WINDOW_MS = 90_000; // 计数窗口，超时自动归零

// ---------- 安装引导 ----------
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// ---------- 工具栏按钮 ----------
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const tabs = await chrome.tabs.query({ url: PLUGIN_SEARCH_URL + '*' });
    if (tabs && tabs.length) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      return;
    }
    // 没有查询页：优先在当前窗口开新标签
    const opts = { url: PLUGIN_SEARCH_URL };
    if (tab && tab.windowId != null && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      opts.windowId = tab.windowId;
    }
    await chrome.tabs.create(opts);
  } catch (e) {
    // 兜底：最简单的方式打开
    try { await chrome.tabs.create({ url: PLUGIN_SEARCH_URL }); } catch (e2) {}
  }
});

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'OPEN_TAB') {
    openAsAdjacentTab(msg.url, sender.tab);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'HEAL_NEEDED') {
    healIfNeeded(sender.tab).then((ok) => sendResponse({ ok }));
    return true; // 异步
  }

  if (msg.type === 'READY_REPORTED') {
    // 就绪后清空自愈计数，下一轮失效重新计
    chrome.storage.session.remove(['healNavs', 'healLastNavAt']).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

async function openAsAdjacentTab(url, senderTab) {
  let u;
  try { u = new URL(url); } catch (e) { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const opts = { url: u.href, active: true };
  if (senderTab && senderTab.windowId != null && senderTab.index != null) {
    opts.windowId = senderTab.windowId;
    opts.index = senderTab.index + 1;
  }
  try { await chrome.tabs.create(opts); } catch (e) {
    try { await chrome.tabs.create({ url: u.href, active: true }); } catch (e2) {}
  }
}

async function healIfNeeded(tab) {
  if (!tab || tab.id == null) return false;
  let st = {};
  try { st = await chrome.storage.session.get(['healNavs', 'healLastNavAt']); } catch (e) {}
  const now = Date.now();
  let navs = Number(st.healNavs) || 0;
  const last = Number(st.healLastNavAt) || 0;
  if (now - last > HEAL_WINDOW_MS) navs = 0;           // 窗口过期，重新计
  if (navs >= HEAL_MAX_NAVS) return false;             // 次数耗尽，交给页面提示手动登录
  if (now - last < HEAL_NAV_COOLDOWN_MS) return false; // 冷却中

  try {
    await chrome.storage.session.set({ healNavs: navs + 1, healLastNavAt: now });
    await chrome.tabs.update(tab.id, { url: IMS_T1_URL });
    return true;
  } catch (e) {
    return false;
  }
}
