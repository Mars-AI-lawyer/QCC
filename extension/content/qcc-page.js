'use strict';
/*
 * 查询页自愈（pro-plugin.qcc.com，主框架）
 *
 * 移植自 qcc-fast/login-heal.js 的核心判定，改为「随页面加载自动运行」：
 *  1. 检测查询页真实渲染（搜索框选择器组）与登录失效提示；
 *  2. 主动会话探针：页面被动渲染时不校验会话，必须模拟一次点击+输入「测」
 *     触发鉴权，暴露"看着正常、一点就失效"的假就绪（顺带预热懒加载）；
 *  3. 探针通过 → 页面顶部 toast「✅ 已就绪」；
 *  4. 会话失效 → 请求 background 跳 IMS t=1 换新票（节流/上限在 background）；
 *  5. 就绪后进入慢速守望（10s），使用中途过期也能自动修复。
 */

const SEARCH_INPUT_SELS = [
  '.search-box input', '#searchInput',
  'input[placeholder*="企业"]', 'input[placeholder*="公司"]',
  'input[placeholder*="统一社会信用"]', 'input[placeholder*="查"]',
];
const LOGIN_HINT_RE = /请先登录|未登录|登录.{0,6}(失效|过期)|会话.{0,6}(失效|过期)|重新登录|重新进入/;

const POLL_MS = 400;
const DETECT_BUDGET_MS = 25_000;
const PROBE_OBSERVE_MS = 2_500;
const PROBE_STABLE_MS = 1_500;
const WATCH_MS = 10_000;

function findSearchInput() {
  for (const s of SEARCH_INPUT_SELS) {
    const el = document.querySelector(s);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

function detect() {
  try {
    let bt = '';
    try { bt = document.body ? document.body.innerText : ''; } catch (e) {}
    return {
      box: !!findSearchInput(),
      promptLogin: LOGIN_HINT_RE.test(bt),
      ready: document.readyState,
    };
  } catch (e) {
    return { box: false, promptLogin: false, ready: 'unknown', err: String(e) };
  }
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

function setInputValue(el, v) {
  nativeValueSetter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function probeTrigger() {
  try {
    const el = findSearchInput();
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    setInputValue(el, '测');
    el.dispatchEvent(new KeyboardEvent('keyup', { key: '测', bubbles: true }));
    return true;
  } catch (e) { return false; }
}

function probeClear() {
  try {
    const el = findSearchInput();
    if (!el) return;
    setInputValue(el, '');
    el.blur();
  } catch (e) {}
}

function toast(msg, bg) {
  try {
    const old = document.getElementById('__qcc_toast');
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = '__qcc_toast';
    d.textContent = msg;
    d.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + `background:${bg || 'rgba(28,100,242,.95)'};color:#fff;padding:10px 26px;border-radius:24px;font-size:15px;`
      + 'font-family:system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;'
      + 'transition:opacity .3s;pointer-events:none;white-space:nowrap;';
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = '1'; });
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 4500);
  } catch (e) {}
}

function requestHeal() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'HEAL_NEEDED' }, (r) => {
        void chrome.runtime.lastError;
        resolve(!!(r && r.ok));
      });
    } catch (e) { resolve(false); }
  });
}

function reportReady() {
  try {
    chrome.runtime.sendMessage({ type: 'READY_REPORTED' }, () => void chrome.runtime.lastError);
  } catch (e) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/\/plugin-search/.test(location.pathname)) return; // plugin-login 等中间页自动跳走，不处理

  // 等待基本 DOM
  for (let i = 0; i < 40 && !document.body; i++) await sleep(100);

  let healedRecently = false;
  const detectDeadline = Date.now() + DETECT_BUDGET_MS;

  // ---- 阶段一：检测 + 探针 + 就绪 ----
  while (Date.now() < detectDeadline) {
    const v = detect();

    if (v.promptLogin) {
      const ok = await requestHeal();
      if (!ok) {
        toast('⚠️ 企查查会话已失效，请点击页面上的登录入口手动登录', 'rgba(200,60,60,.95)');
        return;
      }
      healedRecently = true;
      await sleep(1_000); // 已发起跳转，等页面离开
      continue;
    }

    if (v.box) {
      // 主动探针：触发 → 观察 → 清理 → 稳定确认
      probeTrigger();
      await sleep(PROBE_OBSERVE_MS);
      const after = detect();
      if (after.promptLogin) {
        const ok = await requestHeal();
        if (!ok) {
          toast('⚠️ 企查查会话已失效，请手动登录', 'rgba(200,60,60,.95)');
          return;
        }
        healedRecently = true;
        await sleep(1_000);
        continue;
      }
      probeClear();
      await sleep(PROBE_STABLE_MS);
      if (!detect().promptLogin) {
        toast('✅ 企查查已就绪，可以直接查询');
        reportReady();
        break;
      }
      healedRecently = false;
    }

    await sleep(POLL_MS);
  }

  // ---- 阶段二：守望——使用中途会话过期自动修复 ----
  if (healedRecently) return; // 刚修复完的页面随跳转重建，本实例不留守望
  setInterval(() => {
    const v = detect();
    if (v.promptLogin) {
      requestHeal().then((ok) => {
        if (!ok) toast('⚠️ 企查查会话已失效，请手动登录', 'rgba(200,60,60,.95)');
      });
    }
  }, WATCH_MS);
}

main();
