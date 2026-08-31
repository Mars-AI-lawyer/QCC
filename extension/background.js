'use strict';
/*
 * 企查查速查助手 · background service worker
 *
 * 职责：
 *  - 工具栏按钮：聚焦/新建查询页标签（普通标签页，天然支持单窗口多标签）
 *  - OPEN_TAB：把页面里被拦截的 window.open / _blank 链接落到同一窗口的相邻标签；
 *              若拦截到的是 IMS 登录/换票类地址，转交后台换票，不亮出新标签
 *  - 后台换票：会话失效时开一个【不抢焦点】的临时标签走 IMS t=1：
 *      · 落回查询页 → 关临时标签并刷新原查询页（全程无感）；
 *      · 落到登录页 → ims-login 内容脚本自动填表（凭据存本机）；
 *      · 无凭据/多次失败 → 收到 SURFACE_LOGIN 后才把登录页亮给用户
 *  - 首次安装自动打开引导页
 */

const PLUGIN_SEARCH_URL = 'https://pro-plugin.qcc.com/plugin-search';
const IMS_T1_URL = 'https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1';
const IMS_LOGIN_RE = /^https:\/\/ims\.allbrightlaw\.com\/(sysAuth|system)\//;

// 与 login-heal.js 保持一致的自愈节流参数
const HEAL_MAX_NAVS = 4;
const HEAL_NAV_COOLDOWN_MS = 4500;
const HEAL_WINDOW_MS = 90_000; // 计数窗口，超时自动归零

// 进行中的后台换票任务：bgTabId -> originTabId
const healJobs = new Map();

// ---------- 安装引导 ----------
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// ---------- 后台换票任务监听：临时标签落回查询页即收尾 ----------
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const job = healJobs.get(tabId);
  if (!job) return;
  if (/pro-plugin\.qcc\.com\/plugin-search/.test(info.url)) {
    healJobs.delete(tabId);
    (async () => {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
      try { await chrome.tabs.reload(job.originId); } catch (e) {}
    })();
  }
});

// 进行中的任务在 SW 重启后失联：标签自己会走完登录链，但收尾逻辑丢失。
// 兜底：SW 冷启动时把孤立的换票标签记回来（按 URL 特征识别）。
chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: IMS_T1_URL + '*' });
  for (const t of tabs) healJobs.set(t.id, { originId: null });
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
    const opts = { url: PLUGIN_SEARCH_URL };
    if (tab && tab.windowId != null && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      opts.windowId = tab.windowId;
    }
    await chrome.tabs.create(opts);
  } catch (e) {
    try { await chrome.tabs.create({ url: PLUGIN_SEARCH_URL }); } catch (e2) {}
  }
});

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'OPEN_TAB') {
    if (IMS_LOGIN_RE.test(msg.url || '')) {
      // 登录/换票类弹窗 → 后台处理
      healIfNeeded(sender.tab).then((ok) => {
        if (!ok) openAsAdjacentTab(msg.url, sender.tab); // 冷却被拦时兜底亮出
        sendResponse({ ok: true });
      });
      return true;
    }
    openAsAdjacentTab(msg.url, sender.tab);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'HEAL_NEEDED') {
    healIfNeeded(sender.tab).then((ok) => sendResponse({ ok }));
    return true; // 异步
  }

  if (msg.type === 'READY_REPORTED') {
    chrome.storage.session.remove(['healNavs', 'healLastNavAt']).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'SURFACE_LOGIN') {
    // 登录页需要用户手动处理：把它激活到前台
    (async () => {
      try {
        const t = sender.tab;
        if (t && t.id != null) await chrome.tabs.update(t.id, { active: true });
        if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
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
  if (now - last > HEAL_WINDOW_MS) navs = 0;
  if (navs >= HEAL_MAX_NAVS) return false;
  if (now - last < HEAL_NAV_COOLDOWN_MS) return false;

  try {
    await chrome.storage.session.set({ healNavs: navs + 1, healLastNavAt: now });
    // 后台临时标签：不抢焦点，落在当前标签右侧
    const bg = await chrome.tabs.create({
      url: IMS_T1_URL,
      active: false,
      index: (tab.index != null ? tab.index : 0) + 1,
    });
    healJobs.set(bg.id, { originId: tab.id });
    return true;
  } catch (e) {
    return false;
  }
}
