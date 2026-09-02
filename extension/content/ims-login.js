'use strict';
/*
 * IMS 登录页自动处理（ims.allbrightlaw.com）
 *
 * - 会话有效时本页只是 t=1 换票的中间跳板（快速 302），检测不到表单即静默退出；
 * - 出现登录表单：
 *    · 已存凭据 → 自动切「账户登录」、原生 setter 填值、提交（选择器沿用 v9/v10 实测）；
 *    · 未存凭据 → 弹出首次登录浮层：输入账号密码，仅保存到本机 chrome.storage.local；
 *    · 10 分钟内连续 3 次自动登录失败 → 暂停自动填写（保护期结束自动恢复），
 *      弹出确认浮层：密码留空沿用已存密码重试，也可输入新密码覆盖。
 *      已存密码【不会】被自动删除，保证「只需登录一次」，也避免误删正确密码。
 */

const FORM_WAIT_MS = 10_000;
const FORM_POLL_MS = 300;
const FAIL_GIVE_UP = 3;
const FAIL_WINDOW_MS = 10 * 60_000; // 失败统计窗口 = 保护期：窗口内满 3 次失败则暂停自动填写
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

// ---------- 登录浮层（首次录入 / 保护期确认，两用） ----------
function showPanel(opts) {
  opts = opts || {};
  if (document.getElementById('__qcc_cred_panel')) return;

  // 需要用户手动处理：请求 background 把本（后台）标签激活到前台
  try {
    chrome.runtime.sendMessage({ type: 'SURFACE_LOGIN' }, () => void chrome.runtime.lastError);
  } catch (e) {}

  const passPlaceholder = opts.user ? '留空则沿用已保存的密码' : '';
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
      <h3>${opts.user ? '🔐 企查查速查 · 登录 IMS' : '🔐 企查查速查 · 首次登录'}</h3>
      <p class="sub">请输入 IMS 账号密码，之后登录将自动完成、无需重复输入。<br>
        密码<b>只保存在本机浏览器</b>中，不会上传到任何服务器或代码仓库。</p>
      <label>IMS 账号</label>
      <input id="__qcc_user" type="text" autocomplete="off" value="${opts.user || ''}">
      <label>IMS 密码</label>
      <input id="__qcc_pass" type="password" autocomplete="new-password" placeholder="${passPlaceholder}">
      ${opts.error ? `<p class="err">⚠️ ${opts.error}</p>` : ''}
      <button id="__qcc_save">保存并登录</button>
    </div>`;
  document.documentElement.appendChild(wrap);

  const userInput = wrap.querySelector('#__qcc_user');
  const passInput = wrap.querySelector('#__qcc_pass');
  userInput.focus();

  const onSubmit = async () => {
    const user = userInput.value.trim();
    const typed = passInput.value;
    if (!user) {
      userInput.style.borderColor = '#ed4014';
      return;
    }
    // 密码留空 → 沿用已保存的密码（保护期重试场景）；两者皆无才拦截
    let pass = typed;
    if (!pass) {
      const st = await storageGet([CRED_PASS_KEY]);
      pass = st[CRED_PASS_KEY] || '';
      if (!pass) {
        passInput.style.borderColor = '#ed4014';
        return;
      }
    }
    const obj = { [CRED_USER_KEY]: user };
    if (typed) obj[CRED_PASS_KEY] = typed;
    await storageSet(obj);
    // 本次手动确认视为重新开始：清空失败计数
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
  const now = Date.now();
  const fail = st[CRED_FAIL_KEY] || { n: 0, ts: 0 };
  const n = now - (fail.ts || 0) < FAIL_WINDOW_MS ? fail.n : 0;
  const user = st[CRED_USER_KEY];
  const pass = st[CRED_PASS_KEY];

  if (user && pass) {
    if (n >= FAIL_GIVE_UP) {
      // 保护期：暂停自动填写，但不删除已存密码；用户可立即确认重试
      const mins = Math.max(1, Math.ceil((FAIL_WINDOW_MS - (now - fail.ts)) / 60_000));
      showPanel({
        user,
        error: `自动登录连续 ${n} 次未成功，已暂停自动填写（约 ${mins} 分钟后自动恢复）。`
          + '可直接点「保存并登录」重试：密码留空则沿用已保存的密码；密码已修改请输入新密码。',
      });
      return;
    }
    // 记录一次尝试：若提交后表单再次出现（仍在窗口内），计数即递增
    await storageSet({ [CRED_FAIL_KEY]: { n: n + 1, ts: Date.now() } });
    if (!fillAndSubmit(user, pass)) {
      // 表单结构异常：退回手动浮层
      showPanel({ user, error: '登录表单结构有变化，请手动输入登录。' });
    }
    return;
  }

  showPanel({ user });
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
