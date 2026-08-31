'use strict';
/*
 * MAIN world ↔ 扩展 API 的消息桥。
 * guard-main.js 运行在页面世界（无法访问 chrome.*），通过 window.postMessage
 * 把 OPEN_TAB 请求递到这里，再转发给 background 落成同窗口新标签。
 */
(() => {
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__qcc !== 1 || d.type !== 'OPEN_TAB') return;
    if (typeof d.url !== 'string' || !/^https?:/i.test(d.url)) return;
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: d.url }, () => void chrome.runtime.lastError);
    } catch (e) {}
  });
})();
