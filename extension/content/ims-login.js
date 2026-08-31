'use strict';
/*
 * IMS 登录页自动处理（ims.allbrightlaw.com）
 *
 * - 会话有效时本页只是 t=1 换票的中间跳板（快速 302），检测不到表单即静默退出；
 * - 出现登录表单：
 *    · 已存凭据 → 自动切「账户登录」、原生 setter 填值、提交（选择器沿用 v9/v10 实测）；
 *    · 未存凭据 → 弹出首次登录浮层：输入账号密码，仅保存到本机 chrome.storage.local；
 *    · 连续 3 次自动登录失败 → 清除已存密码、停止自动填写，提示手动登录或重新录入。
 */

const FORM_WAIT_MS = 10_000;
const FORM_POLL_MS = 300;
const FAIL_GIVE_UP = 3;
const FAIL_WINDOW_MS = 20_000;   // 距上次提交超过该时长则失败计数作废（新会话）
const CRED_FAIL_KEY = 'ims_fail';
const CRED_USER_KEY = 'ims_user';
const CRED_PASS_KEY = 'ims_pass';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPairs() {
  const nu = document.querySelector('input[name="userid"]');
  const np = document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]');
  return { nu, np };
}

function switchToAccountTab() {
  const tabBtn = document.querySelector('li[lay-id="ims"]');
  if (tabBtn) tabBtn.click();
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

function setInputValue(el, v) {
  nativeValueSetter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitForm() {
  setTimeout(() => {
    const btn = document.querySelector('.legal_click[data-click="login"]');
    if (btn) { btn.click(); return; }
    const f = document.querySelector('#frmMain');
    if (f) f.submit();
  }, 500);
}

function fillAndSubmit(user, pass) {
  switchToAccountTab();
  const { nu, np } = getPairs();
  if (!nu || !np) return false;
  setInputValue(nu, user);
  setInputValue(np, pass);
  const flag = document.querySelector('input[name="login"]');
  if (flag) setInputValue(flag, 'Y');
  submitForm();
  return true;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(keys, (r) => resolve(r || {})); } catch (e) { resolve({}); }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set(obj, () => resolve()); } catch (e) { resolve(); }
  });
}
function storageRemove(keys) {
  return new Promise((resolve) => {
    try { chrome.storage.local.remove(keys, () => resolve()); } catch (e) { resolve(); }
  });
}

// ---------- 首次登录浮层 ----------
function showPanel(opts) {
  if (document.getElementById('__qcc_cred_panel')) return;

  const wrap = document.createElement('div');
  wrap.id = '__qcc_cred_panel';
  wrap.innerHTML = `
    <style>
      #__qcc_cred_panel{position:fixed;top:0;left:0;right:0;z-index:2147483647;
        font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
      #__qcc_cred_panel .box{margin:56px auto 0;width:340px;background:#fff;border-radius:14px;
        box-shadow:0 12px 48px rgba(0,0,0,.28);padding:22px 24px 18px;}
      #__qcc_cred_panel h3{margin:0 0 4px;font-size:17px;color:#1c2438;}
      #__qcc_cred_panel .sub{margin:0 0 14px;font-size:12px;color:#808695;line-height:1.6;}
      #__qcc_cred_panel label{display:block;font-size:12px;color:#515a6e;margin:10px 0 4px;}
      #__qcc_cred_panel input{width:100%;box-sizing:border-box;height:34px;padding:0 10px;
        border:1px solid #dcdee2;border-radius:6px;font-size:14px;outline:none;}
      #__qcc_cred_panel input:focus{border-color:#2d8cf0;}
      #__qcc_cred_panel button{margin-top:16px;width:100%;height:36px;border:none;border-radius:6px;
        background:#2d8cf0;color:#fff;font-size:14px;cursor:pointer;}
      #__qcc_cred_panel button:hover{background:#3d9bf5;}
      #__qcc_cred_panel .err{margin:10px 0 0;font-size:12px;color:#ed4014;line-height:1.6;}
    </style>
    <div class="box">
      <h3>🔐 企查查速查 · 首次登录</h3>
      <p class="sub">请输入 IMS 账号密码，之后登录将自动完成、无需重复输入。<br>
        密码<b>只保存在本机浏览器</b>中，不会上传到任何服务器或代码仓库。</p>
      <label>IMS 账号</label>
      <input id="__qcc_user" type="text" autocomplete="off">
      <label>IMS 密码</label>
      <input id="__qcc_pass" type="password" autocomplete="new-password">
      ${opts && opts.error ? `<p class="err">⚠️ ${opts.error}</p>` : ''}
      <button id="__qcc_save">保存并登录</button>
    </div>`;
  document.documentElement.appendChild(wrap);

  const userInput = wrap.querySelector('#__qcc_user');
  const passInput = wrap.querySelector('#__qcc_pass');
  userInput.focus();

  const onSubmit = async () => {
    const user = userInput.value.trim();
    const pass = passInput.value;
    if (!user || !pass) {
      userInput.style.borderColor = (!user) ? '#ed4014' : '#dcdee2';
      passInput.style.borderColor = (!pass) ? '#ed4014' : '#dcdee2';
      return;
    }
    await storageSet({ [CRED_USER_KEY]: user, [CRED_PASS_KEY]: pass });
    // 本次手动录入视为重新开始：清空失败计数
    await storageRemove([CRED_FAIL_KEY]);
    if (!fillAndSubmit(user, pass)) {
      wrap.remove();
    }
  };
  wrap.querySelector('#__qcc_save').addEventListener('click', onSubmit);
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSubmit(); });
  userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput.focus(); });
}

async function handleForm() {
  const st = await storageGet([CRED_USER_KEY, CRED_PASS_KEY, CRED_FAIL_KEY]);
  const fail = st[CRED_FAIL_KEY] || { n: 0, ts: 0 };
  const recentFail = Date.now() - (fail.ts || 0) < FAIL_WINDOW_MS ? fail.n : 0;

  if (recentFail >= FAIL_GIVE_UP) {
    // 多次失败：清除密码，停止自动填写
    await storageRemove([CRED_PASS_KEY]);
    showPanel({ error: '自动登录多次未成功，已停止自动填写。请检查账号密码后重新输入（或直接在页面手动登录）。' });
    return;
  }

  const user = st[CRED_USER_KEY];
  const pass = st[CRED_PASS_KEY];
  if (user && pass) {
    // 记录一次尝试：若提交后表单再次出现（仍在时间窗内），计数即递增
    await storageSet({ [CRED_FAIL_KEY]: { n: recentFail + 1, ts: Date.now() } });
    if (!fillAndSubmit(user, pass)) {
      // 表单结构异常：退回手动浮层
      showPanel({ error: '登录表单结构有变化，请手动输入登录。' });
    }
  } else {
    showPanel();
  }
}

async function main() {
  // 等表单出现；等不到说明只是 t=1 换票中间跳，静默退出
  const deadline = Date.now() + FORM_WAIT_MS;
  while (Date.now() < deadline) {
    const { nu, np } = getPairs();
    if (nu && np) break;
    // 可能默认显示扫码 tab，账户输入框藏于 DOM —— 先点一下再找
    if (!document.querySelector('input[name="userid"]')) {
      const tabBtn = document.querySelector('li[lay-id="ims"]');
      if (tabBtn) tabBtn.click();
    }
    await sleep(FORM_POLL_MS);
    if (getPairs().nu && getPairs().np) break;
  }
  const { nu, np } = getPairs();
  if (!nu || !np) return;

  // 表单就绪后再稍等页面脚本初始化（lay-id 切换逻辑等）
  await sleep(600);
  if (!getPairs().nu || !getPairs().np) return;

  handleForm();
}

main();
