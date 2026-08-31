'use strict';

const USER_KEY = 'ims_user';
const PASS_KEY = 'ims_pass';

function $(id) { return document.getElementById(id); }

function setStatus(msg, ok) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = ok === false ? '#ed4014' : '#19be6b';
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get([USER_KEY], (r) => {
    if (r && r[USER_KEY]) {
      $('user').value = r[USER_KEY];
      $('pass').placeholder = '已保存（输入新值可覆盖）';
    }
  });

  $('save').addEventListener('click', () => {
    const user = $('user').value.trim();
    const pass = $('pass').value;
    if (!user) { setStatus('请填写 IMS 账号', false); return; }
    const obj = { [USER_KEY]: user };
    if (pass) obj[PASS_KEY] = pass;
    chrome.storage.local.get([PASS_KEY], (r) => {
      if (!pass && !(r && r[PASS_KEY])) {
        setStatus('尚未保存过密码，请填写密码', false);
        return;
      }
      chrome.storage.local.set(obj, () => {
        $('pass').value = '';
        $('pass').placeholder = '已保存（输入新值可覆盖）';
        setStatus('✅ 已保存');
      });
    });
  });

  $('clear').addEventListener('click', () => {
    chrome.storage.local.remove([USER_KEY, PASS_KEY, 'ims_fail'], () => {
      $('user').value = '';
      $('pass').value = '';
      $('pass').placeholder = '';
      setStatus('已清除。下次打开查询页时会重新要求输入账号密码');
    });
  });
});
