/*
 * QCC 企查查快速登录 —— 内容脚本 v3
 * v3 改进：全链路可见调试 + 双路提交（按钮 + 直接 form.submit 兜底）
 *
 * 真实表单结构（curl 抓取确认）：
 *   - 账户登录标签：li[lay-id="ims"]（layui tab，默认在"扫描登录"上）
 *   - 用户名：input[name="userid"]
 *   - 密码：#userpwd / input[name="userpwd"]
 *   - 登录按钮：input.legal_click[data-click="login"]（jQuery 委托，value="登录"）
 *   - 登录标志：input[name="login"] 设为 "Y"
 *   - 表单：#frmMain，POST 到 ./login.aspx
 *   - 密码不加密（jsencrypt 已注释）
 */
(function () {
  'use strict';

  // 注意：v6 起 App 已改用 CDP 守护进程（auto-login.js）自动登录，
  // 凭据保存在各用户本机 ~/.qcc/ims-account.json，本扩展方案已弃用且不含任何凭据。
  var CONFIG = {
    username: '',
    password: '',
    imsLogin: 'https://ims.allbrightlaw.com/system/login.aspx',
    qccHost: 'qcc.com',
    imsHost: 'ims.allbrightlaw.com'
  };

  function log() {
    var a = ['[QCC-AUTO v3]'].concat(Array.prototype.slice.call(arguments));
    try { console.log.apply(console, a); } catch (e) {}
  }

  // 可见状态条（固定右上角，每一步都更新）
  var statusEl = null;
  function showStatus(text, bg) {
    try {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'qcc-auto-status';
        statusEl.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 14px;background:rgba(0,0,0,0.85);color:#fff;font-size:14px;border-radius:6px;font-family:-apple-system,"PingFang SC",sans-serif;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,0.4);max-width:360px;line-height:1.5';
        (document.body || document.documentElement).appendChild(statusEl);
      }
      statusEl.textContent = '⚡ ' + text;
      statusEl.style.background = bg || 'rgba(0,0,0,0.85)';
      statusEl.style.opacity = '1';
    } catch (e) { log('showStatus error:', e.message); }
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.type === 'hidden') return true;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      var s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    } catch (e) { return true; }
  }

  function findByText(text, tags) {
    tags = tags || 'a,button,span,div,li,td,th,label,input';
    var norm = text.replace(/\s+/g, '').toLowerCase();
    var all = document.querySelectorAll(tags);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isVisible(el)) continue;
      var t = (el.textContent || el.value || '').trim().replace(/\s+/g, '').toLowerCase();
      if (t === norm) return el;
    }
    for (var j = 0; j < all.length; j++) {
      var el2 = all[j];
      if (!isVisible(el2)) continue;
      var t2 = (el2.textContent || el2.value || '').trim().replace(/\s+/g, '').toLowerCase();
      if (t2.indexOf(norm) !== -1) return el2;
    }
    return null;
  }

  // === IMS 登录页 ===
  function tryLogin() {
    log('=== tryLogin START ===');
    showStatus('脚本已启动，准备登录...', 'rgba(0,100,200,0.9)');

    // 等 layui 完全初始化（layui.use 回调可能延迟）
    setTimeout(function () {
      log('checking form fields...');

      // 精确选择器（基于真实 HTML）
      var user = document.querySelector('input[name="userid"]');
      var pass = document.querySelector('#userpwd') || document.querySelector('input[name="userpwd"]');

      // 调试：如果找不到字段，列出所有 input 帮助定位
      if (!user || !pass) {
        var inputs = document.querySelectorAll('input');
        var info = [];
        for (var i = 0; i < inputs.length; i++) {
          info.push(inputs[i].name + '/' + inputs[i].id + '/' + inputs[i].type);
        }
        log('all inputs:', info.join(', '));
        showStatus('⚠ 字段未找到\nuserid=' + !!user + ' pwd=' + !!pass + '\ninputs: ' + info.join(', '), 'rgba(200,50,50,0.95)');
        return;
      }

      log('fields found: userid + userpwd');
      showStatus('正在填写账号密码...', 'rgba(0,100,200,0.9)');

      // 填字段
      user.value = CONFIG.username;
      user.dispatchEvent(new Event('input', { bubbles: true }));
      user.dispatchEvent(new Event('change', { bubbles: true }));

      pass.value = CONFIG.password;
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      pass.dispatchEvent(new Event('change', { bubbles: true }));

      // 设置登录标志
      var loginFlag = document.querySelector('input[name="login"]');
      if (loginFlag) {
        loginFlag.value = 'Y';
        log('login flag set to Y');
      }

      // 路径 A：尝试点击登录按钮（走 jQuery 委托事件）
      var btn = document.querySelector('.legal_click[data-click="login"]');
      log('login button found:', !!btn);

      if (btn) {
        showStatus('正在点击登录按钮...', 'rgba(180,50,50,0.9)');
        btn.click();
        log('button clicked, waiting for navigation...');

        // 3 秒后检查是否还在登录页（没跳走 = 按钮没生效）
        setTimeout(function () {
          if (location.href.toLowerCase().indexOf('login.aspx') !== -1) {
            log('button click did NOT navigate, fallback to direct form.submit()');
            showStatus('按钮未生效，直接提交表单...', 'rgba(200,100,50,0.95)');

            // 路径 B：兜底，直接提交表单（模拟 login.js 的 pageEvent.login）
            // 重新填值（防止被 layui.use 回调清空）
            user.value = CONFIG.username;
            pass.value = CONFIG.password;
            if (loginFlag) loginFlag.value = 'Y';

            var form = document.getElementById('frmMain') || document.querySelector('form');
            if (form) {
              log('form.submit() called');
              form.submit();
            } else {
              log('form not found!');
              showStatus('⚠ 表单未找到', 'rgba(200,50,50,0.95)');
            }
          } else {
            log('navigation happened after button click ✓');
          }
        }, 3000);

      } else {
        // 没有按钮，直接提交
        log('no button, direct form.submit()');
        showStatus('直接提交表单...', 'rgba(180,50,50,0.9)');
        var form2 = document.getElementById('frmMain') || document.querySelector('form');
        if (form2) form2.submit();
      }

    }, 800); // 等 layui 初始化
  }

  // === IMS 门户 / QCC 应用页 ===
  function navigateIms() {
    // 找「点击访问」
    var access = findByText('点击访问', 'a,button,input,span,div');
    if (access) {
      log('click: 点击访问');
      showStatus('正在进入企业信息查询...', 'rgba(50,120,200,0.9)');
      if (access.tagName === 'A') {
        access.target = '_self';
        access.removeAttribute('target');
      }
      access.click();
      return true;
    }

    // 找导航「企查查」
    var nav = findByText('企查查', 'a');
    if (nav) {
      log('click nav: 企查查 ->', nav.href || '(no href)');
      showStatus('正在打开企查查...', 'rgba(50,120,200,0.9)');
      if (nav.tagName === 'A') {
        nav.target = '_self';
        nav.removeAttribute('target');
      }
      nav.click();
      return true;
    }

    return false;
  }

  // === 企查查终页 ===
  function onQcc() {
    var searchInput = document.querySelector('#searchInput') ||
                      document.querySelector('input[placeholder*="企业" i]') ||
                      document.querySelector('input[placeholder*="公司" i]') ||
                      document.querySelector('input[placeholder*="统一社会信用" i]') ||
                      document.querySelector('input[placeholder*="查" i]');

    var bodyText = (document.body && document.body.innerText) || '';
    var hasLoginPrompt = /请先登录|请登录|未登录|未登入|登录后|sign\s*in/i.test(bodyText);

    if (searchInput && !hasLoginPrompt) {
      log('QCC 已登录 ✓');
      showStatus('✓ 已登录企查查', 'rgba(40,160,60,0.9)');
      try { sessionStorage.removeItem('qcc_retries'); } catch (e) {}
      return;
    }

    var tries = 0;
    try { tries = parseInt(sessionStorage.getItem('qcc_retries') || '0', 10); } catch (e) {}
    if (tries >= 3) {
      showStatus('⚠ 自动登录失败，请手动操作', 'rgba(200,50,50,0.9)');
      return;
    }
    try { sessionStorage.setItem('qcc_retries', String(tries + 1)); } catch (e) {}
    log('QCC 未登录, retry ' + (tries + 1));
    showStatus('QCC 会话失效，正在重新登录...', 'rgba(200,150,50,0.9)');
    try { window.top.location.href = CONFIG.imsLogin; }
    catch (e) { window.location.href = CONFIG.imsLogin; }
  }

  // === 入口 ===
  function main() {
    var host = location.hostname.toLowerCase();
    log('main() host=' + host + ' url=' + location.href);

    // 立即改标题，证明脚本已加载
    try { document.title = '⚡ ' + document.title; } catch (e) {}

    if (host.indexOf(CONFIG.qccHost) !== -1) {
      setTimeout(onQcc, 600);
    } else if (host.indexOf(CONFIG.imsHost) !== -1) {
      var href = location.href.toLowerCase();
      if (href.indexOf('login.aspx') !== -1) {
        log('on IMS login page -> tryLogin');
        tryLogin();
      } else {
        log('on IMS portal -> navigateIms');
        setTimeout(function () {
          if (!navigateIms()) {
            setTimeout(function () {
              if (!navigateIms()) {
                log('navigation: nothing found to click');
                showStatus('⚠ 未找到企查查入口', 'rgba(200,50,50,0.9)');
              }
            }, 1000);
          }
        }, 400);
      }
    }
  }

  // 全局错误兜底：任何异常都在页面顶部显示红色条
  function showError(e) {
    try {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c00;color:#fff;padding:10px;font-size:14px;font-family:sans-serif;text-align:center';
      d.textContent = 'QCC-AUTO 错误: ' + (e && e.message ? e.message : String(e));
      (document.body || document.documentElement).appendChild(d);
    } catch (ex) {}
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        try { main(); } catch (e) { log('FATAL:', e); showError(e); }
      });
    } else {
      main();
    }
  } catch (e) {
    log('FATAL:', e);
    showError(e);
  }
})();
