#!/usr/bin/env node
// QCC 自动登录守护进程 v8 —— 白屏自愈 + 单窗口版
//
// v8 变更（修复两个用户反馈的问题）：
//   问题 1：登录后长期白屏，查询输入框（"聊天框"）不出来。
//     根因：v7 只要 URL 到达 pro-plugin.qcc.com 就判定成功、注入绿条并退出，
//           但查询页是 SPA（index-*.js），首屏资源没渲染完（或票据换票异常）时
//           页面一直白屏，守护进程却已宣告胜利，无人兜底。
//     修复：成功判定改为「搜索输入框真实可见」（getBoundingClientRect 校验），
//           并加自愈链：等待 25s → location.reload() 重载 → 再等 25s →
//           重走 sysAuth/plugin.aspx?t=1 换新票据 → 再等 35s → 仍白屏则显示
//           红色提示条（可手动 Cmd+R）。
//   问题 2：登录过程中会新开一个 Chrome 窗口。
//     根因：IMS / 企查查跳转链路里存在 window.open() 式弹窗（票据回传常用），
//           查询页被弹到新窗口，原 app 窗口被晾在一边。
//     修复：对每个页面注入「弹窗拦截器」（立即注入当前文档 + 注册为新文档
//           初始化脚本，跨导航持续生效）：window.open 改为本页 location.assign；
//           a[target=_blank]/form[target=_blank] 强制改 _self。整条链路锁死在
//           唯一的 app 窗口里；若仍出现遗留 IMS/空白页，成功后自动关闭。
//
// v7 要点（保留）：凭据存本机 ~/.qcc/ims-account.json（600），App 包内不含密码；
//   首次使用/失效时在登录页弹输入面板；连续失败自动清凭据重问。
//
// 链路事实（2026-08 实测）：
//   sysAuth/plugin.aspx?t=1
//     有会话   → 302 pro-plugin.qcc.com/plugin-login?key=..&token=..&returnUrl=/plugin-search
//     无会话   → 302 system/login.aspx?rurl=base64(t=1) ；登录 POST 后服务器自动弹回 t=1

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.QCC_CDP_PORT || '9222', 10);
const HOST = '127.0.0.1';
const LOG_FILE = '/tmp/qcc-auto.log';
const ACCOUNT_FILE = path.join(os.homedir(), '.qcc', 'ims-account.json');
const MAX_RUN_MS = 300000;          // 总看门狗：5 分钟
const LOOP_MS = 800;
const LOGIN_MAX_ATTEMPTS = 4;
const LOGIN_RETRY_GAP_MS = 6000;

// 白屏自愈节奏
const RENDER_WAIT_MS = 25000;       // 阶段0：初次等 SPA 渲染
const RELOAD_WAIT_MS = 25000;       // 阶段1：reload 后再等
const REROUTE_WAIT_MS = 35000;      // 阶段2：重走 t=1 换新票据后等

function log(...args) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' +
    args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);   // launch.sh 已把 stdout 重定向到 LOG_FILE
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 凭据存取（本机文件，App 包内不含任何凭据）----
function loadAccount() {
  try {
    const c = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (c && typeof c.user === 'string' && c.user && typeof c.pass === 'string' && c.pass) {
      return { user: c.user, pass: c.pass };
    }
  } catch (e) {}
  return null;
}

function saveAccount(user, pass) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ user, pass }, null, 2) + '\n', { mode: 0o600 });
    log('凭据已保存到本机:', ACCOUNT_FILE);
  } catch (e) { log('保存凭据失败:', e.message); }
}

function deleteAccount() {
  try { fs.unlinkSync(ACCOUNT_FILE); log('已清除本机保存的凭据'); } catch (e) {}
}

function httpGet(path_) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: path_, timeout: 2500 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    req.on('error', reject);
  });
}

function evalOn(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    const to = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('eval timeout')); }
    }, 12000);
    ws.onopen = () => ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false }
    }));
    ws.onmessage = ev => {
      if (settled) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          settled = true; clearTimeout(to);
          try { ws.close(); } catch (e) {}
          if (msg.error) return reject(new Error(msg.error.message));
          resolve(msg.result || {});
        }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = () => { if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('ws error')); } };
  });
}

async function listPages() {
  const ts = await httpGet('/json/list');
  return (ts || []).filter(t => t.type === 'page');
}

async function findPage(pred) {
  return (await listPages()).find(t => pred(t.url || '')) || null;
}

async function waitCdpReady() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const v = await httpGet('/json/version');
      if (v && v.webSocketDebuggerUrl) return;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('CDP 90 秒内未就绪 (port ' + PORT + ')');
}

// ---- 弹窗拦截器：window.open → 本页跳转；_blank → _self ----
// 返回 body 内容同页跳转，防止链路把查询页弹到新窗口。
const POPUP_GUARD = `
  (function(){
    if (window.__qccNoPopup) return 'ALREADY';
    window.__qccNoPopup = true;
    try {
      window.open = function(u){
        try { if (u) { location.assign(u); return null; } } catch (e) {}
        return null;
      };
    } catch (e) {}
    try {
      document.addEventListener('click', function(e){
        try {
          var t = e.target;
          var a = t && t.closest && t.closest('a[target="_blank"]');
          if (a) a.target = '_self';
        } catch (err) {}
      }, true);
      document.addEventListener('submit', function(e){
        try { if (e.target && e.target.target === '_blank') e.target.target = '_self'; } catch (err) {}
      }, true);
    } catch (e) {}
    return 'OK';
  })();
`;

// 对某个页面装拦截器：a) 立即注入当前文档  b) 注册为后续导航的初始化脚本。
// 注意：初始化脚本可能随 DevTools 会话断开被清除，所以会话保持到守护进程退出。
const guardSessions = new Map();   // targetId -> WebSocket
async function installPopupGuard(target) {
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) return;
  // a) 立即生效（当前正在加载的文档收不到初始化脚本，只能直接注入）
  try { await evalOn(wsUrl, POPUP_GUARD); } catch (e) {}
  // b) 对该 target 的所有后续文档生效（会话保持不断开）
  await new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; resolve(ok); };
    const ws = new WebSocket(wsUrl);
    const id1 = Math.floor(Math.random() * 1e9), id2 = id1 + 1;
    const to = setTimeout(() => finish(false), 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: id1, method: 'Page.enable' }));
      ws.send(JSON.stringify({ id: id2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: POPUP_GUARD } }));
    };
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id === id2) { clearTimeout(to); guardSessions.set(target.id, ws); finish(true); }
      } catch (e) {}
    };
    ws.onerror = () => { clearTimeout(to); finish(false); };
    ws.onclose = () => { clearTimeout(to); guardSessions.delete(target.id); };
  });
}

// 成功后清理遗留页面（IMS / 空白页），只保留查询页 —— 兜底多窗口问题
async function closeLeftoverPages(keepTargetId) {
  try {
    const pages = await listPages();
    for (const t of pages) {
      if (t.id === keepTargetId) continue;
      const u = (t.url || '').toLowerCase();
      if (u.includes('ims.allbrightlaw.com') || u === '' || u === 'about:blank' || u.startsWith('chrome://')) {
        try { await httpGet('/json/close/' + t.id); log('已关闭遗留页面:', t.url || '(blank)'); } catch (e) {}
      }
    }
  } catch (e) {}
}

// ---- 哨兵模式：登录成功后不再退出，守到所有窗口关闭 ----
// 背景：macOS 上 Chrome 关掉最后一个窗口后进程仍驻留。若放任不管，之后双击
// App 时系统会认为「应用已在运行」，启动脚本不执行 → 表现为「点了没反应」。
// 所以：检测到连续多次没有任何页面（= 所有窗口已关）→ 主动 Browser.close
// 让 Chrome 干净退出，下次点击 App 即可正常全新启动。
function browserClose() {
  return new Promise(resolve => {
    httpGet('/json/version').then(v => {
      if (!v || !v.webSocketDebuggerUrl) return resolve(false);
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      const to = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(false); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onclose = () => { clearTimeout(to); resolve(true); };
      ws.onerror = () => { clearTimeout(to); resolve(false); };
    }).catch(() => resolve(false));
  });
}

function enterSentinelMode() {
  let emptyRounds = 0;
  log('进入哨兵模式：所有窗口关闭后将自动退出 Chrome');
  const iv = setInterval(async () => {
    try {
      const pages = await listPages();
      if (pages.length === 0) {
        if (++emptyRounds >= 3) {
          clearInterval(iv);
          log('所有窗口已关闭，退出 Chrome（便于下次点击 App 正常启动）');
          await browserClose();
          setTimeout(() => process.exit(0), 3000);
        }
      } else {
        emptyRounds = 0;
      }
    } catch (e) {
      // CDP 无响应 = Chrome 已退出
      clearInterval(iv);
      process.exit(0);
    }
  }, 3000);
}

async function injectStatus(wsUrl, text, color) {
  const expr = `
    (function(){
      try {
        let el = document.getElementById('qcc-cdp-status');
        if (!el) {
          el = document.createElement('div');
          el.id = 'qcc-cdp-status';
          el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 14px;background:rgba(0,0,0,0.85);color:#fff;font-size:14px;border-radius:6px;font-family:-apple-system,"PingFang SC",sans-serif;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,0.4);max-width:380px;line-height:1.5;';
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = ${JSON.stringify(text)};
        el.style.background = ${JSON.stringify(color || 'rgba(0,100,200,0.9)')};
      } catch (e) {}
    })();
  `;
  return evalOn(wsUrl, expr).catch(() => {});
}

// ---- 注入片段：检测登录表单是否存在 ----
const DETECT_LOGIN = `
  (function(){
    var u = document.querySelector('input[name="userid"]');
    var p = document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]');
    return !!u && !!p;
  })();
`;

// ---- 注入片段：查询页真实渲染检测 ----
// OK=搜索框可见；BLANK=页面空白；RENDERED_NO_INPUT=有内容但没有搜索框；LOGIN_PROMPT=提示未登录
const CHECK_SEARCHBOX = `
  (function(){
    try {
      var sels = ['.search-box input', '#searchInput',
                  'input[placeholder*="企业"]', 'input[placeholder*="公司"]',
                  'input[placeholder*="统一社会信用"]', 'input[placeholder*="查"]'];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (!el) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 16) return 'OK';
      }
      var bodyText = (document.body && document.body.innerText) || '';
      if (/请先登录|未登录|登录失效|重新登录/.test(bodyText)) return 'LOGIN_PROMPT';
      if (document.readyState !== 'complete') return 'BLANK';
      if (bodyText.replace(/\\s/g, '').length > 20) return 'RENDERED_NO_INPUT';
      return 'BLANK';
    } catch (e) { return 'ERR ' + e.message; }
  })();
`;

const RELOAD_PAGE = `
  (function(){ try { location.reload(); return 'RELOADING'; } catch (e) { return 'ERR ' + e.message; } })();
`;

const NAV_T1 = `
  (function(){ try { location.assign('https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1'); return 'NAV_OK'; } catch (e) { return 'ERR ' + e.message; } })();
`;

// ---- 注入片段：填账号密码并提交（凭据由参数注入，不落盘到 App）----
function fillAndSubmit(creds) {
  return `
    (function(){
      try {
        var tab = document.querySelector('li[lay-id="ims"]');
        if (tab) tab.click();
      } catch (e) {}
      try {
        var u = document.querySelector('input[name="userid"]');
        var p = document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]');
        var lf = document.querySelector('input[name="login"]');
        var btn = document.querySelector('.legal_click[data-click="login"]');
        if (!u || !p) return 'FAIL missing fields';
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(u, ${JSON.stringify(creds.user)});
        u.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(p, ${JSON.stringify(creds.pass)});
        p.dispatchEvent(new Event('input', { bubbles: true }));
        if (lf) lf.value = 'Y';
        if (btn) { btn.click(); return 'CLICK_BTN'; }
        var f = document.getElementById('frmMain');
        if (f) { f.submit(); return 'FORM_SUBMIT'; }
        return 'FAIL no submit target';
      } catch (e) { return 'ERR ' + e.message; }
    })();
  `;
}

// ---- 注入片段：凭据输入面板（首次使用 / 凭据失效时显示在登录页上）----
function injectCredPanel(wsUrl, errMsg) {
  const expr = `
    (function(){
      try {
        if (window.__qccPanelClosed) return 'CLOSED';
        if (document.getElementById('qcc-cred-panel')) return 'EXISTS';
        var panel = document.createElement('div');
        panel.id = 'qcc-cred-panel';
        panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;'
          + 'background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,0.35);padding:26px 30px;width:330px;'
          + 'font-family:-apple-system,"PingFang SC",sans-serif;';
        var title = document.createElement('div');
        title.textContent = '登录通力 IMS';
        title.style.cssText = 'font-size:17px;font-weight:600;color:#1a1a1a;';
        var sub = document.createElement('div');
        sub.textContent = '首次使用请输入你自己的 IMS 账号，保存后每次自动登录';
        sub.style.cssText = 'font-size:12px;color:#999;margin:6px 0 16px;';
        function mkInput(placeholder, isPwd) {
          var i = document.createElement('input');
          i.placeholder = placeholder;
          if (isPwd) i.type = 'password';
          i.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:10px;'
            + 'border:1px solid #ddd;border-radius:8px;font-size:14px;outline:none;';
          i.onfocus = function(){ i.style.borderColor = '#1e7de0'; };
          i.onblur = function(){ i.style.borderColor = '#ddd'; };
          return i;
        }
        var uIn = mkInput('IMS 账号', false);
        var pIn = mkInput('IMS 密码', true);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:2px 0 14px;';
        var lab = document.createElement('label');
        lab.style.cssText = 'font-size:12px;color:#666;display:flex;align-items:center;gap:5px;cursor:pointer;';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode('记住密码（保存在本机）'));
        var close = document.createElement('div');
        close.textContent = '✕';
        close.title = '关闭面板（手动登录，下次仍会询问）';
        close.style.cssText = 'font-size:13px;color:#bbb;cursor:pointer;padding:2px 6px;';
        close.onclick = function(){ panel.remove(); window.__qccPanelClosed = true; };
        row.appendChild(lab); row.appendChild(close);
        var btn = document.createElement('button');
        btn.textContent = '登录';
        btn.style.cssText = 'width:100%;padding:11px 0;border:none;border-radius:8px;background:#1e7de0;'
          + 'color:#fff;font-size:15px;cursor:pointer;';
        var err = document.createElement('div');
        err.style.cssText = 'font-size:12px;color:#e05050;margin-top:10px;min-height:16px;';
        var initErr = ${JSON.stringify(errMsg || '')};
        if (initErr) err.textContent = initErr;
        function submit() {
          var u = uIn.value.trim(), p = pIn.value;
          if (!u || !p) { err.textContent = '请填写账号和密码'; return; }
          window.__QCC_CRED__ = { user: u, pass: p, remember: cb.checked };
          btn.textContent = '登录中…'; btn.disabled = true;
        }
        btn.onclick = submit;
        pIn.onkeydown = function(e){ if (e.key === 'Enter') submit(); };
        panel.appendChild(title); panel.appendChild(sub);
        panel.appendChild(uIn); panel.appendChild(pIn);
        panel.appendChild(row); panel.appendChild(btn); panel.appendChild(err);
        (document.body || document.documentElement).appendChild(panel);
        uIn.focus();
        return 'OK';
      } catch (e) { return 'ERR ' + e.message; }
    })();
  `;
  return evalOn(wsUrl, expr).catch(() => null);
}

// ---- 注入片段：读取并取走用户在面板里填的凭据 ----
const READ_CRED = `
  (function(){
    try {
      var c = window.__QCC_CRED__;
      if (!c) return '';
      window.__QCC_CRED__ = null;
      return JSON.stringify(c);
    } catch (e) { return ''; }
  })();
`;

// ---- 注入片段：门户兜底 —— 直接导航到企查查入口链路 ----
const REROUTE_T1 = NAV_T1;

async function main() {
  log('=== auto-login v8 启动, CDP 端口', PORT, '===');
  await waitCdpReady();
  log('CDP ready');

  let creds = loadAccount();
  let loginAttempts = 0;
  let lastLoginAt = 0;
  let rerouteDone = false;
  let panelMsg = '';
  if (creds) log('已读取本机保存的凭据:', ACCOUNT_FILE);

  // 弹窗拦截：guardSessions 里有活跃会话才算已保护（会话断开会自动从中移除，下轮重装）
  async function guardAll(pages) {
    for (const t of pages) {
      const u = (t.url || '').toLowerCase();
      if (u.includes('ims.allbrightlaw.com') || u.includes('.qcc.com')) {
        if (!guardSessions.has(t.id)) {
          await installPopupGuard(t);
        }
      }
    }
  }

  // 白屏自愈状态
  let qccBlankSince = 0;     // 第一次发现查询页未渲染的时间
  let healStep = 0;          // 0=等渲染 1=已reload 2=已重走t=1 3=放弃
  let lastToastStep = -1;

  const start = Date.now();

  while (Date.now() - start < MAX_RUN_MS) {
    try {
      const pages = await listPages();

      // 0) 给所有相关页面装弹窗拦截器（防止新开 Chrome 窗口）
      await guardAll(pages);

      // 1) 终态：企查查查询页 —— 必须搜索框真实可见才算成功
      const finalPage = pages.find(t => (t.url || '').includes('pro-plugin.qcc.com'));
      if (finalPage) {
        let st = 'ERR';
        try {
          const r = await evalOn(finalPage.webSocketDebuggerUrl, CHECK_SEARCHBOX);
          st = (r.result && r.result.value) || 'ERR';
        } catch (e) { /* 页面正在跳转/加载 */ }

        if (st === 'OK') {
          log('✓ 查询页搜索框已渲染，登录链路完成:', finalPage.url);
          await closeLeftoverPages(finalPage.id);
          await injectStatus(finalPage.webSocketDebuggerUrl,
            '✓ 已登录企查查，可直接输入企业名称查询', 'rgba(40,160,60,0.95)');
          enterSentinelMode();
          return;
        }

        // 未就绪 → 白屏自愈状态机
        if (!qccBlankSince) { qccBlankSince = Date.now(); log('查询页已到达，等待搜索框渲染… 状态:', st); }
        const waited = Date.now() - qccBlankSince;

        // 蓝色进度条（状态文案变化时才注入，避免闪烁）
        const toastStep = healStep === 0 ? 0 : healStep === 1 ? 1 : 2;
        if (toastStep !== lastToastStep) {
          lastToastStep = toastStep;
          const msgs = ['正在加载企查查查询页…', '查询页加载较慢，正在自动刷新…', '仍在加载，正在重新走登录链路换新票据…'];
          await injectStatus(finalPage.webSocketDebuggerUrl, msgs[toastStep], 'rgba(0,100,200,0.92)');
        }

        if (st === 'LOGIN_PROMPT' && healStep < 2) {
          // 会话失效：直接重走 t=1（比 reload 更对路）
          healStep = 2; qccBlankSince = Date.now(); lastToastStep = -1;
          log('查询页提示未登录，重走 t=1 换新票据');
          try { await evalOn(finalPage.webSocketDebuggerUrl, NAV_T1); } catch (e) {}
          await sleep(LOOP_MS);
          continue;
        }

        if (healStep === 0 && waited > RENDER_WAIT_MS) {
          healStep = 1; qccBlankSince = Date.now(); lastToastStep = -1;
          log('搜索框 ' + (RENDER_WAIT_MS / 1000) + 's 未渲染，自动 reload（状态:' + st + '）');
          try { await evalOn(finalPage.webSocketDebuggerUrl, RELOAD_PAGE); } catch (e) {}
          await sleep(2000);
          continue;
        }
        if (healStep === 1 && waited > RELOAD_WAIT_MS) {
          healStep = 2; qccBlankSince = Date.now(); lastToastStep = -1;
          log('reload 后仍未渲染，重走 t=1 换新票据（状态:' + st + '）');
          try { await evalOn(finalPage.webSocketDebuggerUrl, NAV_T1); } catch (e) {}
          await sleep(LOOP_MS);
          continue;
        }
        if (healStep === 2 && waited > REROUTE_WAIT_MS) {
          healStep = 3;
          log('多次自愈后查询页仍未渲染，放弃自动恢复（状态:' + st + '）');
          await injectStatus(finalPage.webSocketDebuggerUrl,
            '⚠ 查询页加载异常：请按 Cmd+R 刷新，或关闭应用后重新打开', 'rgba(200,50,50,0.95)');
          enterSentinelMode();
          return;
        }
        await sleep(LOOP_MS);
        continue;
      }

      // 查询页不在了（自愈跳转途中等）→ 重置渲染计时但保留 healStep
      if (qccBlankSince && healStep < 2) qccBlankSince = 0;

      // 2) qcc 中间页（plugin-login 换票中）：静等自跳
      const qccMid = pages.find(t => /\.qcc\.com/.test(t.url || ''));
      if (qccMid) { await sleep(LOOP_MS); continue; }

      // 3) IMS 页面
      const imsPage = pages.find(t => (t.url || '').includes('ims.allbrightlaw.com'));
      if (imsPage) {
        let isLogin = false;
        try {
          const r = await evalOn(imsPage.webSocketDebuggerUrl, DETECT_LOGIN);
          isLogin = !!(r.result && r.result.value);
        } catch (e) { /* 页面尚在加载 */ }
        // 登录页默认显示「扫描登录」标签，输入框存在但可能不可见；URL 判定兜底
        if (!isLogin && /system\/login\.aspx/.test(imsPage.url || '')) isLogin = true;

        if (isLogin) {
          const now = Date.now();

          // 没有凭据 → 弹输入面板，等用户填自己的账号密码
          if (!creds) {
            await injectCredPanel(imsPage.webSocketDebuggerUrl, panelMsg);
            panelMsg = '';
            const raw = await evalOn(imsPage.webSocketDebuggerUrl, READ_CRED)
              .then(r => (r && r.result && r.result.value) || '').catch(() => '');
            if (raw) {
              try { creds = JSON.parse(raw); } catch (e) { creds = null; }
              if (creds && creds.user && creds.pass) {
                if (creds.remember) saveAccount(creds.user, creds.pass);
                log('已获取用户输入的凭据', creds.remember ? '(记住)' : '(本次不保存)');
                await sleep(400);
              } else creds = null;
            }
          }

          // 有凭据 → 自动填表提交（限次限速）
          if (creds && loginAttempts < LOGIN_MAX_ATTEMPTS && now - lastLoginAt > LOGIN_RETRY_GAP_MS) {
            loginAttempts++;
            lastLoginAt = now;
            await injectStatus(imsPage.webSocketDebuggerUrl, '正在自动登录 IMS…', 'rgba(0,100,200,0.92)');
            await sleep(600);  // 等 layui 初始化
            const res = await evalOn(imsPage.webSocketDebuggerUrl, fillAndSubmit(creds));
            log('尝试第', loginAttempts, '次登录:', (res.result && res.result.value) || '(无返回)');
            await sleep(1500);
          }

          // 连续失败 → 清凭据，重新弹面板让用户重输
          if (creds && loginAttempts >= LOGIN_MAX_ATTEMPTS) {
            log('连续', loginAttempts, '次登录未成功，需要重新输入');
            deleteAccount();
            creds = null;
            loginAttempts = 0; lastLoginAt = 0;
            panelMsg = '自动登录未成功（账号或密码可能已变更），请重新输入';
          }

          await sleep(LOOP_MS);
          continue;
        }

        // 不是登录页 → 门户类页面，兜底走一次直达链接
        if (!rerouteDone) {
          rerouteDone = true;
          try {
            const rr = await evalOn(imsPage.webSocketDebuggerUrl, REROUTE_T1);
            log('门户兜底跳转 t=1:', (rr.result && rr.result.value) || '(无返回)');
          } catch (e) { /* ignore */ }
        }
        await sleep(LOOP_MS);
        continue;
      }

      await sleep(LOOP_MS);
    } catch (e) {
      await sleep(900);
    }
  }
  log('主循环超时，进入哨兵模式（窗口保留，可手动操作）');
  enterSentinelMode();
}

main().catch(e => {
  log('FATAL:', e.message);
  process.exit(1);
});

// Chrome 关闭后自动退出
let fails = 0;
setInterval(async () => {
  try { await httpGet('/json/version'); fails = 0; }
  catch (e) {
    if (++fails >= 4) { process.exit(0); }
  }
}, 3000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
