#!/usr/bin/env node
'use strict';
/*
 * 企查查速查 · 登录自愈状态机（方案A：复用日常 Chrome）
 *
 * 与旧版 qcc-app（v7~v9，已删除）的差异：
 *  - 不再启动独立 Chrome 实例 + CDP 守护进程；
 *  - 通过 osascript（"允许 JavaScript from Apple Events"）操作日常 Chrome 的标签页；
 *  - 全程事件驱动轮询，无固定长 sleep；登录链路/选择器沿用 v9 实测结果：
 *      IMS 登录页: input[name=userid] / #userpwd|input[name=userpwd] / li[lay-id="ims"] 切账户登录
 *                  提交 .legal_click[data-click="login"]，兜底 #frmMain.submit()
 *      查询页:    pro-plugin.qcc.com/plugin-search，搜索框选择器组判定真实渲染
 *  - 凭据文件与旧版互通：~/.qcc/ims-account.json  { user, pass }（0600）
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 配置 ----------
const SHIM_APP = '/Users/mars/Applications/Chrome Apps.localized/企业信息查询平台.app';
const IMS_T1_URL = 'https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1';
const CRED_FILE = path.join(os.homedir(), '.qcc', 'ims-account.json');

const RUNNER = (() => {
  const bundled = path.join(__dirname, '..', 'Resources', 'runner.applescript');
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, 'runner.applescript');
})();

const POLL_MS = 350;
const TOTAL_BUDGET_MS = 25_000;   // 整体预算
const FILL_COOLDOWN_MS = 3_000;
const NAV_COOLDOWN_MS = 4_500;
const MAX_FILLS = 3;              // 每组凭据最多填表次数
const MAX_NAVS = 4;               // 跳 IMS t=1 换票最多次数
const CRED_ROUNDS = 2;            // 最多重录凭据轮数

const OSA = '/usr/bin/osascript';
const LOCK_DIR = path.join(os.homedir(), '.qcc', 'fast.lock');

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 单实例锁（在本进程内管理，exit 时必然释放） ----------
let ownsLock = false;
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.mkdirSync(LOCK_DIR); ownsLock = true; return true; } catch {}
    try {
      const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (age > 90_000) { fs.rmdirSync(LOCK_DIR); continue; } // 残留锁
    } catch {}
    break;
  }
  return false;
}
process.on('exit', () => {
  if (ownsLock) { try { fs.rmdirSync(LOCK_DIR); } catch {} }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ---------- osascript 基础 ----------
function osa(args, timeoutMs) {
  const r = spawnSync(OSA, args, { timeout: timeoutMs || 9000, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function isPermErr(stderr) {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return s.includes('javascript') && (
    s.includes('turn') || s.includes('off') || s.includes('关') || s.includes('不允许')
  );
}

function notify(msg) {
  spawnSync(OSA, ['-e', `display notification "${String(msg).replace(/"/g, '\\"')}" with title "企查查速查"`]);
}

function ask(text, hidden) {
  const esc = String(text).replace(/"/g, '\\"');
  const r = spawnSync(OSA, [
    '-e', `display dialog "${esc}：" default answer ""${hidden ? ' with hidden answer' : ''} with title "企查查速查"`,
    '-e', 'text returned of result',
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null; // 用户取消
  return (r.stdout || '').trim();
}

// ---------- 注入 JS 传递（临时文件 0600，凭据不进进程参数） ----------
const tmpDirs = [];
function writeTmpJs(js) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcc-heal-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'js.txt');
  fs.writeFileSync(file, js, { mode: 0o600 });
  return file;
}

// ---------- Chrome 操作 ----------
function listTabs() {
  const r = osa([RUNNER, 'LIST'], 6000);
  if (r.status !== 0) return null; // Chrome 未就绪 / 权限等
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length >= 3 && parts[1].match(/^\d+$/)) {
      out.push({ winId: parts[0], idx: parseInt(parts[1], 10), url: parts.slice(2).join('|') });
    }
  }
  return out;
}

function evalFile(file, winId, idx) {
  const r = osa([RUNNER, 'EVAL_FILE', file, String(winId), String(idx)], 10_000);
  if (r.status !== 0) return { err: r.stderr };
  try { return { val: JSON.parse(r.stdout) }; } catch { return { raw: r.stdout }; }
}

function nav(winId, idx, url) {
  return osa([RUNNER, 'NAV', String(winId), String(idx), url], 6000);
}

function closeTab(winId, idx) {
  return osa([RUNNER, 'CLOSE_TAB', String(winId), String(idx)], 6000);
}

// ---------- 页面检测 / 填表 JS ----------
const DETECT_JS = `(() => {
  try {
    const u = location.href;
    let bt = ''; try { bt = document.body ? document.body.innerText : ''; } catch (e) {}
    const sels = ['.search-box input','#searchInput','input[placeholder*="企业"]','input[placeholder*="公司"]','input[placeholder*="统一社会信用"]','input[placeholder*="查"]'];
    let box = false;
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { box = true; break; } }
    }
    const promptLogin = /请先登录|未登录|登录.{0,6}(失效|过期)|会话.{0,6}(失效|过期)|重新登录|重新进入/.test(bt);
    const hasUser = !!document.querySelector('input[name="userid"]');
    const hasPwd = !!(document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]'));
    return JSON.stringify({ u, bt0: bt.slice(0, 80), box, promptLogin, hasUser, hasPwd, rs: document.readyState });
  } catch (e) { return JSON.stringify({ err: String(e) }); }
})()`;

// 主动会话探针：该页面在被动渲染时不校验会话，直到用户点击输入框才发鉴权请求，
// 然后才切换"登录状态失效"占位页。因此就绪判定必须自己模拟一次点击+输入，
// 把假就绪当场暴露出来（顺带完成旧版 v9 的懒加载预热效果）。
const PROBE_TRIGGER_JS = `(() => {
  try {
    const sels = ['.search-box input','#searchInput','input[placeholder*="企业"]','input[placeholder*="公司"]','input[placeholder*="统一社会信用"]','input[placeholder*="查"]'];
    let el = null;
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el = e; break; } }
    }
    if (!el) return JSON.stringify({ ok: false, why: 'no-input' });
    el.focus();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '测');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: '测', bubbles: true }));
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ ok: false, why: String(e) }); }
})()`;

const PROBE_CLEAR_JS = `(() => {
  try {
    const sels = ['.search-box input','#searchInput','input[placeholder*="企业"]','input[placeholder*="公司"]','input[placeholder*="统一社会信用"]','input[placeholder*="查"]'];
    let el = null;
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el = e; break; } }
    }
    if (!el) return JSON.stringify({ ok: false });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ ok: false, why: String(e) }); }
})()`;

function buildFillJs(user, pass) {
  // JSON.stringify 处理转义，凭据安全进入 JS 字符串字面量
  const U = JSON.stringify(user);
  const P = JSON.stringify(pass);
  return `(() => {
  try {
    const U = ${U}, P = ${P};
    const tabBtn = document.querySelector('li[lay-id="ims"]');
    if (tabBtn) tabBtn.click();
    const nu = document.querySelector('input[name="userid"]');
    const np = document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]');
    if (!nu || !np) return JSON.stringify({ ok: false, why: 'no-input' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(nu, U); nu.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(np, P); np.dispatchEvent(new Event('input', { bubbles: true }));
    const flag = document.querySelector('input[name="login"]');
    if (flag) { setter.call(flag, 'Y'); flag.dispatchEvent(new Event('input', { bubbles: true })); }
    setTimeout(() => {
      const btn = document.querySelector('.legal_click[data-click="login"]');
      if (btn) { btn.click(); return; }
      const f = document.querySelector('#frmMain'); if (f) f.submit();
    }, 500);
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ ok: false, why: String(e) }); }
})()`;
}

// ---------- 状态分类 ----------
// READY            查询页搜索框已渲染且无登录提示
// IMS_FORM         IMS 登录表单在页面（可能默认显示扫码 tab，输入框藏于 DOM）
// QCC_LOGIN_NEEDED 查询域页面提示需登录
// WAIT             其他（加载中、换票中间页等）
function stateOf(url, v) {
  if (!v || v.err) return 'WAIT';
  const u = url || '';
  if (/pro-plugin\.qcc\.com\/plugin-search/.test(u)) {
    if (v.box && !v.promptLogin) return 'READY';
  }
  // 先判 IMS 表单页：登录页正文可能含"重新登录"等提示语，优先级须高于 QCC_LOGIN_NEEDED
  if ((v.hasUser && v.hasPwd) || /ims\.allbrightlaw\.com\/.*system\/login\.aspx/.test(u)) return 'IMS_FORM';
  if (v.promptLogin) return 'QCC_LOGIN_NEEDED';
  return 'WAIT';
}

function scoreOf(url) {
  if (/pro-plugin\.qcc\.com\/plugin-search/.test(url)) return 5;
  if (/pro-plugin\.qcc\.com\//.test(url)) return 4;
  if (/ims\.allbrightlaw\.com/.test(url)) return 3;
  if (/qcc\.com/.test(url)) return 2;
  if (/^about:blank$/.test(url)) return 1; // shim 刚打开的壳
  return 0;
}

// ---------- 凭据 ----------
function loadCred() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (j && j.user && j.pass) return j;
  } catch {}
  return null;
}
function saveCred(c) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify({ user: c.user, pass: c.pass }), { mode: 0o600 });
}
function deleteCred() { try { fs.rmSync(CRED_FILE, { force: true }); } catch {} }

function getCredentials(reasonNote) {
  let c = loadCred();
  if (c) return c;
  notify(reasonNote || '首次使用，请录入 IMS 账号密码');
  log('请求录入凭据…');
  const user = ask('请输入IMS登录账号', false);
  if (user == null || !user) return null;
  const pass = ask('请输入IMS登录密码', true);
  if (pass == null || !pass) return null;
  c = { user, pass };
  saveCred(c);
  log('凭据已保存到', CRED_FILE);
  return c;
}

// ---------- 主流程 ----------
async function preflightPerm() {
  // Chrome 未运行时无法探测，交给主流程自然处理
  const tabs = listTabs();
  if (!tabs || !tabs.length) return { unknown: true };
  const f = writeTmpJs('1'); // 无害探测
  const r = evalFile(f, tabs[0].winId, tabs[0].idx);
  if (r.err && isPermErr(r.err)) return { off: true };
  return { ok: true };
}

async function main() {
  if (!acquireLock()) {
    notify('上一个实例还在处理中，请稍候');
    log('已有实例运行，退出');
    process.exitCode = 0;
    return;
  }

  const pf = await preflightPerm();
  if (pf.off) {
    notify('请先开启权限：Chrome 查看菜单 > 开发者 > 允许 Apple 事件中的 JavaScript');
    log('==== 结束：缺少 AS-JS 权限（未打开任何窗口） ====');
    process.exitCode = 3;
    return;
  }

  log('==== 启动 · 打开入口 ====');
  spawnSync('/usr/bin/open', ['-a', SHIM_APP]);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let fills = 0, navs = 0, credRound = 0;
  let lastFillAt = 0, lastNavAt = 0;
  let permOff = false;
  let reopenAllowedAt = Date.now() + 6_000;
  let result = 'TIMEOUT';
  let chosen = null; // 命中 READY 的 tab {winId, idx, url}
  let readySince = 0;   // 就绪稳定计时起点
  let probeState = 0;   // 0=未探测 1=已触发探针(观察中) 2=探针通过并已清理
  let enteredViaT1 = false; // 本次启动是否已统一走 t=1 换新票

  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    let tabs = listTabs();

    // 一直没有可用标签页 → 中途再拉起一次 shim 兜底
    if (!tabs || !tabs.some((t) => scoreOf(t.url) > 0)) {
      if (tabs && Date.now() > reopenAllowedAt) {
        log('未发现企查查相关标签页，再次拉起入口');
        spawnSync('/usr/bin/open', ['-a', SHIM_APP]);
        reopenAllowedAt = Date.now() + 12_000;
      }
      continue;
    }

    // 关键设计：shim 直连的 plugin-search 用的是上次残留的旧会话（票据存活期短，
    // 经常"看着正常、一点就失效"）。因此每次启动看到查询页后，统一先跳 IMS t=1
    // 换一张新票——IMS Cookie 才是长命的，只要它有效就无需登录、直接换到新会话。
    if (!enteredViaT1) {
      const direct = tabs.find((t) => /^https?:\/\/pro-plugin\.qcc\.com\/plugin-search/.test(t.url));
      if (direct) {
        log('直连查询页 → 统一走 IMS t=1 换新票');
        nav(direct.winId, direct.idx, IMS_T1_URL);
        enteredViaT1 = true;
        lastNavAt = Date.now();
        continue;
      }
    }

    // 候选排序后逐个检测（最多评估前 2 个）
    const scored = tabs.map((t) => ({ t, s: scoreOf(t.url) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);

    let st = null;
    chosen = null;
    for (const cand of scored) {
      const f = writeTmpJs(DETECT_JS);
      const res = evalFile(f, cand.t.winId, cand.t.idx);
      if (res.err) {
        log('EVAL 错误:', res.err.slice(0, 200));
        if (isPermErr(res.err)) { permOff = true; break; }
        continue;
      }
      const cls = stateOf(cand.t.url, res.val);
      const snippet = res.val && res.val.bt0 ? ` | "${res.val.bt0.replace(/\s+/g, ' ').slice(0, 40)}"` : '';
      log(`tab [w${cand.t.winId}#${cand.t.idx}] ${cand.t.url.slice(0, 70)} → ${cls}${cls === 'READY' ? '' : snippet}`);
      if (cls !== 'WAIT' || !chosen) { st = cls; chosen = cand.t; }
      if (cls === 'READY') break;
    }
    if (permOff) break;

    if (st === 'READY' && chosen) {
      // 三阶段：触发探针 → 观察是否降级为失效页 → 清理探针字符并确认稳定
      if (probeState === 0) {
        probeState = 1;
        readySince = Date.now();
        const f = writeTmpJs(PROBE_TRIGGER_JS);
        const r = evalFile(f, chosen.winId, chosen.idx);
        log('会话探针: 模拟点击/输入搜索框 →', JSON.stringify(r.val || r.raw || r.err || {}).slice(0, 100));
        continue;
      }
      if (probeState === 1) {
        if (Date.now() - readySince < 2500) continue; // 探针观察期：等待鉴权结果暴露
        probeState = 2;
        readySince = Date.now();
        const f = writeTmpJs(PROBE_CLEAR_JS);
        evalFile(f, chosen.winId, chosen.idx);
        log('探针通过，清理输入并做最终确认');
        continue;
      }
      if (Date.now() - readySince >= 1500) { result = 'READY'; break; }
      continue;
    } else {
      // 页面降级（如出现失效提示）→ 回到修复流程，修复后需重新探针
      readySince = 0;
    }

    if (st === 'IMS_FORM' && chosen && Date.now() - lastFillAt > FILL_COOLDOWN_MS) {
      if (fills >= MAX_FILLS) {
        deleteCred();
        fills = 0;
        credRound += 1;
        if (credRound >= CRED_ROUNDS) { result = 'BAD_CRED'; break; }
        notify('自动登录未成功，请重新录入 IMS 密码');
        if (!getCredentials()) { result = 'NO_CRED'; break; }
        continue;
      }
      const c = getCredentials();
      if (!c) { result = 'NO_CRED'; break; }
      probeState = 0;
      const f = writeTmpJs(buildFillJs(c.user, c.pass));
      const r = evalFile(f, chosen.winId, chosen.idx);
      log('填写提交:', JSON.stringify(r.val || r.raw || r.err || {}).slice(0, 120));
      fills += 1;
      lastFillAt = Date.now();

    } else if (st === 'QCC_LOGIN_NEEDED' && chosen && Date.now() - lastNavAt > NAV_COOLDOWN_MS) {
      if (navs >= MAX_NAVS) { result = 'NAV_EXHAUSTED'; break; }
      log('会话失效 → 跳转 IMS 换票链路');
      probeState = 0;
      nav(chosen.winId, chosen.idx, IMS_T1_URL);
      navs += 1;
      lastNavAt = Date.now();
    }
  }

  // 收尾：成功则清理重复查询页并通知
  if (result === 'READY') {
    for (let i = 0; i < 5; i++) {
      const tabs = listTabs() || [];
      const dup = tabs.find((t) =>
        !(t.winId === chosen.winId && t.idx === chosen.idx) &&
        /^https?:\/\/pro-plugin\.qcc\.com\/plugin-(search|login)/.test(t.url));
      if (!dup) break;
      closeTab(dup.winId, dup.idx);
      await sleep(200);
    }
    notify('已就绪，可以直接查询');
    log('==== 完成：就绪 ====');
    process.exitCode = 0;
    return;
  }

  if (permOff) {
    notify('请先开启权限：Chrome 查看菜单 > 开发者 > 允许 Apple 事件中的 JavaScript');
    log('==== 结束：缺少 AS-JS 权限 ====');
    process.exitCode = 3;
    return;
  }

  const hints = {
    TIMEOUT: '等待超时，请在窗口中手动完成登录',
    BAD_CRED: '多次登录失败，请检查账号密码后重试',
    NO_CRED: '未提供账号密码，请手动登录',
    NAV_EXHAUSTED: '跳转换票未成功，请手动处理',
  };
  notify(hints[result] || '未能自动完成，请手动处理');
  log('==== 结束:', result, '====');
  process.exitCode = 2;
}

main().catch((e) => {
  log('异常退出:', e && e.stack || e);
  notify('脚本异常，请查看日志 ~/Library/Logs/qcc-fast.log');
  process.exitCode = 1;
});
