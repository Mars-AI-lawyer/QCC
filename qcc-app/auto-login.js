#!/usr/bin/env node
// QCC 自动登录守护进程 v7 —— 凭据本机保存版（可安全分享）
//
// v7 变更：账号密码不再硬编码在 App 内（否则 App 分享即泄露密码）。
//   - 凭据存放：~/.qcc/ims-account.json（权限 600，仅本机当前用户可读）
//   - 首次使用 / 凭据失效：在 IMS 登录页上弹出输入面板，使用者填自己的账号密码
//   - 勾选「记住密码」→ 存本机，下次自动登录；不勾选 → 仅本次有效
//   - 连续多次登录失败 → 清除已保存凭据，重新弹出输入面板
//
// 链路事实（2026-08 实测）：
//   sysAuth/plugin.aspx?t=1
//     有会话   → 302 pro-plugin.qcc.com/plugin-login?key=..&token=..&returnUrl=/plugin-search → 查询页
//     无会话   → 302 system/login.aspx?rurl=base64(t=1) ；登录 POST 后服务器自动弹回 t=1
//   所以本进程只做三件事：
//     A) 看到 IMS 登录页 → 已有凭据则自动填表提交；没有则弹面板等用户输入
//     B) 罕见落到门户页(customer/index)时兜底重定向到 t=1
//     C) 其余时间静静等待终页出现。
//
// 端口来自环境变量 QCC_CDP_PORT（launch.sh 每次启动选空闲端口，避免和日常 Chrome 抢 9222）。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.QCC_CDP_PORT || '9222', 10);
const HOST = '127.0.0.1';
const LOG_FILE = '/tmp/qcc-auto.log';
const ACCOUNT_FILE = path.join(os.homedir(), '.qcc', 'ims-account.json');
const MAX_RUN_MS = 300000;          // 总看门狗：5 分钟（首次要等人输密码，比 v6 的 3 分钟放宽）
const LOOP_MS = 800;
const LOGIN_MAX_ATTEMPTS = 4;
const LOGIN_RETRY_GAP_MS = 6000;

function log(...args) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' +
    args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
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
const REROUTE_T1 = `
  (function(){
    try { location.assign('https://ims.allbrightlaw.com/sysAuth/plugin.aspx?t=1'); return 'NAV_OK'; }
    catch (e) { return 'ERR ' + e.message; }
  })();
`;

async function main() {
  log('=== auto-login v7 启动, CDP 端口', PORT, '===');
  await waitCdpReady();
  log('CDP ready');

  let creds = loadAccount();
  let loginAttempts = 0;
  let lastLoginAt = 0;
  let rerouteDone = false;
  let panelMsg = '';
  if (creds) log('已读取本机保存的凭据:', ACCOUNT_FILE);

  const start = Date.now();

  while (Date.now() - start < MAX_RUN_MS) {
    try {
      // 1) 终态：已到企查查企业信息查询页
      const finalPage = await findPage(u => u.includes('pro-plugin.qcc.com'));
      if (finalPage) {
        log('✓ 已到达企查查查询页:', finalPage.url);
        await sleep(1200);
        await injectStatus(finalPage.webSocketDebuggerUrl,
          '✓ 已登录企查查，可直接输入企业名称查询', 'rgba(40,160,60,0.95)');
        setTimeout(() => process.exit(0), 2000);
        return;
      }

      // 2) qcc 中间页（plugin-login 换票中）：静等自跳
      const qccMid = await findPage(u => /\.qcc\.com/.test(u));
      if (qccMid) { await sleep(LOOP_MS); continue; }

      // 3) IMS 页面
      const imsPage = await findPage(u => u.includes('ims.allbrightlaw.com'));
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
  log('超时退出（窗口保留，可手动操作）');
  process.exit(0);
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
