'use strict';

const BACKGROUND_TARGET = 'kuniao-vps-background';
const SOURCE_TAB_CLOSE_DELAY_MS = 500;

function openTab(message, sender, sendResponse) {
  const url = String(message.url || message.payload?.url || '').trim();
  if (!url) {
    sendResponse({
      ok: false,
      error: 'missing-url',
    });
    return;
  }

  chrome.tabs.create({
    url,
    active: message.active !== false && message.payload?.active !== false,
  }, (tab) => {
    const error = chrome.runtime.lastError;
    if (error) {
      sendResponse({
        ok: false,
        error: error.message,
      });
      return;
    }

    const sourceTabId = sender.tab?.id;
    if ((message.closeSourceTab || message.payload?.closeSourceTab) &&
      typeof sourceTabId === 'number' &&
      sourceTabId !== tab.id) {
      const closeDelayMs = Math.max(
        SOURCE_TAB_CLOSE_DELAY_MS,
        Number(message.closeDelayMs || message.payload?.closeDelayMs || 0),
      );
      setTimeout(() => {
        chrome.tabs.remove(sourceTabId, () => {
          // The tab may already be gone; that is fine.
          void chrome.runtime.lastError;
        });
      }, closeDelayMs);
    }

    sendResponse({
      ok: true,
      tabId: tab.id,
      url: tab.url || url,
    });
  });
}

function closeCurrentTab(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    sendResponse({
      ok: false,
      error: 'missing-sender-tab',
    });
    return;
  }

  sendResponse({
    ok: true,
  });

  const delayMs = Math.max(0, Number(message.delayMs || message.payload?.delayMs || 0));
  setTimeout(() => {
    chrome.tabs.remove(tabId, () => {
      // The tab may already be gone; that is fine.
      void chrome.runtime.lastError;
    });
  }, delayMs);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== BACKGROUND_TARGET) {
    return false;
  }

  if (message.type === 'open-tab') {
    openTab(message, sender, sendResponse);
    return true;
  }

  if (message.type === 'close-current-tab') {
    closeCurrentTab(message, sender, sendResponse);
    return false;
  }

  sendResponse({
    ok: false,
    error: `unknown-message:${message.type || ''}`,
  });
  return false;
});
