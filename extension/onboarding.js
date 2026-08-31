'use strict';

const PLUGIN_SEARCH_URL = 'https://pro-plugin.qcc.com/plugin-search';

document.getElementById('openOptions').addEventListener('click', () => {
  try { chrome.runtime.openOptionsPage(); } catch (e) {}
});

document.getElementById('openSearch').addEventListener('click', () => {
  try {
    chrome.tabs.query({ url: PLUGIN_SEARCH_URL + '*' }, (tabs) => {
      if (tabs && tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: PLUGIN_SEARCH_URL });
      }
    });
  } catch (e) {}
});
