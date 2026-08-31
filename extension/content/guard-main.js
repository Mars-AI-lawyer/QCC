'use strict';
/*
 * 弹窗拦截器（MAIN world，document_start，先于页面脚本执行）
 *
 * 背景：企查查/IMS 链路大量使用 window.open() 和 target="_blank"，在普通窗口里
 * target="_blank" 天然开成同窗口新标签，但 window.open 带尺寸参数时会强制弹出
 * 新窗口——这正是"点一下多一个窗口"的根源（旧 qcc-app v9 的 POPUP_GUARD）。
 *
 * 策略：全部改写为「同一窗口、当前标签右侧的新标签页」，由 bridge.js 转发给
 * background 的 tabs.create 落地。
 */
(() => {
  if (window.__qccGuardInstalled) return;
  window.__qccGuardInstalled = true;

  const send = (url) => {
    try {
      window.postMessage({ __qcc: 1, type: 'OPEN_TAB', url: String(url) }, window.location.origin);
    } catch (e) {}
  };

  const toAbs = (u) => {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  };

  // 占位窗口：个别脚本会调用 window.open() 的返回值（focus/close 等），给个哑对象避免报错
  const stub = () => ({
    closed: false,
    opener: null,
    focus() {}, blur() {}, close() {}, print() {},
    postMessage() {},
    moveTo() {}, resizeTo() {},
  });

  // 1) 覆写 window.open：所有真实地址 → 同窗口新标签
  const nativeOpen = window.open.bind(window);
  window.open = function (url, name, features) {
    try {
      const raw = url == null ? '' : String(url);
      // 空参/脚本协议的调用放行，交还原生行为
      if (raw === '' || /^javascript:/i.test(raw.trim())) return nativeOpen(url, name, features);
      const abs = toAbs(raw.trim());
      if (!abs) return nativeOpen(url, name, features);
      send(abs);
      return stub();
    } catch (e) {
      return nativeOpen(url, name, features);
    }
  };

  // 2) 捕获阶段拦截 target="_blank" 的链接/表单普通左键点击（统一走 OPEN_TAB，
  //    在 app 式窗口等非标准环境下也能保持单窗口；Ctrl/中键等用户主动行为不拦截）
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    const el = ev.target && ev.target.closest
      ? ev.target.closest('a[target="_blank"], form[target="_blank"]')
      : null;
    if (!el) return;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      if (!href || href === '#' || /^javascript:/i.test(href.trim())) return;
      const abs = toAbs(href.trim());
      if (!abs) return;
      ev.preventDefault();
      ev.stopPropagation();
      send(abs);
    } else {
      // form[target=_blank]：改为当前页提交等价于旧版行为
      el.removeAttribute('target');
    }
  }, true);
})();
