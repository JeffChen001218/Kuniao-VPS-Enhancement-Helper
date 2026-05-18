// ==UserScript==
// @name         酷鸟云VPS增强助手 Kuniao VPS Enhancement Helper
// @namespace    https://home.kuniaovps.com/
// @version      1.2.0
// @description  一个用于酷鸟云VPS的增强脚本 An enhanced script for Kuniao VPS
// @author       Codex
// @license      MIT
// @match        https://home.kuniaovps.com/*
// @match        https://home.geliyun.com/*
// @match        *://ntba.gte666.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
  'use strict';

  const VPS_HOSTS = ['home.kuniaovps.com', 'home.geliyun.com'];
  const EXTERNAL_LINK_HOSTS = ['ntba.gte666.com'];
  const SUPPORTED_HOSTS = [...VPS_HOSTS, ...EXTERNAL_LINK_HOSTS];
  const STORAGE_KEY = 'vps-auto-login-mappings';
  const MAPPINGS_SYNC_CHANNEL = 'tm-vps-auto-login:mappings-sync';
  const PANEL_POSITION_KEY = 'vps-auto-login-panel-position';
  const SUBMIT_GUARD_MS = 60000;
  const REMOTE_CLICK_GUARD_MS = 15000;
  const REMOTE_CLICK_DELAY_MS = 500;
  const TAB_CLOSE_DELAY_MS = 500;
  const TAB_CLOSE_RETRY_INTERVAL_MS = 250;
  const TAB_CLOSE_MAX_RETRY_MS = 5000;
  const PANEL_ID = 'tm-vps-auto-login-root';
  const PERMISSION_BADGE_ID = 'tm-vps-popup-permission-status';
  const EXTERNAL_JUMP_BUTTON_CLASS = 'tm-vps-saved-link-jump';
  const RENDER_LABEL_CLASS = 'render-label';
  const AVATAR_CLASS = 'n-avatar';
  const REMOTE_TAB_MARK_KEY = 'tm-vps-auto-login:opened-remote-tab';
  const PANEL_EDGE_MARGIN = 12;
  const PANEL_BASE_WIDTH = 360;
  const PANEL_GAP = 10;
  const POPUP_PERMISSION_CHECK_INTERVAL_MS = 1200;
  const POPUP_PERMISSION_PROBE_COOLDOWN_MS = 2500;
  const POPUP_PERMISSION_ALLOWED_TTL_MS = 10000;
  const STATUS_LABEL_POLL_INTERVAL_MS = 1000;
  const INTERNAL_UI_PERMISSION_PROBE_SUPPRESS_MS = 1500;
  const EXTERNAL_JUMP_PERMISSION_TIMEOUT_MS = 10000;
  const EXTERNAL_JUMP_PERMISSION_POLL_INTERVAL_MS = 1000;
  const attemptCache = new Map();
  const observedPasswordInputs = new WeakSet();
  const tabInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let originalDocumentTitle = document.title;
  let appliedMappingTitle = '';
  let remoteClickTimer = 0;
  let closeTabTimer = 0;
  let closeTabRetryTimer = 0;
  let closeTabRetryStartedAt = 0;
  let pendingCloseUrl = '';
  let pendingCloseUntil = 0;
  let pendingRemoteEntryUrl = '';
  let closeArmedByRemoteClick = false;
  let popupPermissionState = 'idle';
  let popupPermissionDetail = '等待进入远程按钮';
  let popupPermissionLastCheckedAt = 0;
  let popupPermissionAllowedStreak = 0;
  let lastInternalUiInteractionAt = 0;
  let popupPermissionTimer = 0;
  let popupPermissionChecking = false;
  let popupPermissionShouldRecheckOnFocus = false;
  let popupPermissionProbeEventsBound = false;
  let statusLabelPollTimer = 0;
  let mappingsSyncChannel = null;
  let mappingsSyncBound = false;
  let mappingsValueSyncBound = false;
  let externalJumpPermissionTimer = 0;
  let externalJumpPermissionDeadline = 0;
  let pendingExternalJumpUrl = '';
  let pendingExternalJumpLabel = '';
  let externalJumpPermissionMode = 'idle';

  function normalizeHostName(host) {
    return String(host || '').split(':')[0];
  }

  if (!SUPPORTED_HOSTS.includes(normalizeHostName(location.host))) {
    return;
  }

  function isVpsHost(host = location.host) {
    return VPS_HOSTS.includes(normalizeHostName(host));
  }

  function isExternalSavedLinkHost(host = location.host) {
    return EXTERNAL_LINK_HOSTS.includes(normalizeHostName(host));
  }

  const storage = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          return GM_getValue(key, fallback);
        }
      } catch (error) {
        console.warn('[VPS Auto Login] GM_getValue failed, fallback to localStorage.', error);
      }

      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (error) {
        console.warn('[VPS Auto Login] localStorage read failed.', error);
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, value);
          return;
        }
      } catch (error) {
        console.warn('[VPS Auto Login] GM_setValue failed, fallback to localStorage.', error);
      }

      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.warn('[VPS Auto Login] localStorage write failed.', error);
      }
    },
  };

  function normalizeUrl(input) {
    try {
      const url = new URL(input, location.origin);
      const type = url.searchParams.get('type');
      const key = url.searchParams.get('key');

      if (isVpsHost(url.host)) {
        url.protocol = 'https:';
      }

      url.pathname = url.pathname.replace(/\/{2,}/g, '/');
      if (url.pathname.length > 1) {
        url.pathname = url.pathname.replace(/\/+$/, '');
      }

      url.hash = '';
      url.search = '';
      if (type != null && key != null) {
        url.searchParams.set('type', type);
        url.searchParams.set('key', key);
      }

      return url.toString();
    } catch (error) {
      return String(input || '').trim();
    }
  }

  function getMappingMatchKey(input) {
    try {
      const url = new URL(normalizeUrl(input), location.origin);
      if (isVpsHost(url.host)) {
        url.host = 'supported-vps-host.invalid';
      }

      return url.toString();
    } catch (error) {
      return normalizeUrl(input);
    }
  }

  function readMappings() {
    const data = storage.get(STORAGE_KEY, []);
    if (!Array.isArray(data)) {
      return [];
    }

    const normalizedMappings = data
      .map((item) => ({
        id: String(item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        number: item.number == null ? '' : String(item.number),
        url: normalizeUrl(item.url || ''),
        password: String(item.password || ''),
      }))
      .filter((item) => item.url && item.password);

    const seenUrls = new Set();
    return normalizedMappings.filter((item) => {
      if (seenUrls.has(item.url)) {
        return false;
      }

      seenUrls.add(item.url);
      return true;
    });
  }

  function writeMappings(mappings) {
    storage.set(STORAGE_KEY, mappings);
    notifyMappingsUpdated(mappings);
    syncExternalSavedLinkButtons(mappings);
  }

  function notifyMappingsUpdated(mappings) {
    if (typeof BroadcastChannel !== 'function' ||
      !(mappingsSyncChannel instanceof BroadcastChannel)) {
      return;
    }

    try {
      mappingsSyncChannel.postMessage({
        type: 'mappings-updated',
        mappings: Array.isArray(mappings) ? mappings : readMappings(),
        senderId: tabInstanceId,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.warn('[VPS Auto Login] broadcast mappings update failed.', error);
    }
  }

  function refreshMappingsFromExternalUpdate(nextMappings = readMappings()) {
    if (isVpsHost()) {
      syncDocumentTitle(nextMappings);
    }
    syncExternalSavedLinkButtons(nextMappings);

    const panelHost = document.getElementById(PANEL_ID);
    if (typeof panelHost?.__refreshMappings === 'function') {
      panelHost.__refreshMappings(nextMappings);
    }

    if (isVpsHost()) {
      tryAutoLogin(nextMappings);
    }
  }

  function bindMappingsSync() {
    if (!mappingsSyncBound && typeof BroadcastChannel === 'function') {
      mappingsSyncBound = true;
      mappingsSyncChannel = new BroadcastChannel(MAPPINGS_SYNC_CHANNEL);
      mappingsSyncChannel.addEventListener('message', (event) => {
        const data = event?.data;
        if (!data ||
          data.type !== 'mappings-updated' ||
          data.senderId === tabInstanceId) {
          return;
        }

        const nextMappings = Array.isArray(data.mappings) ? data.mappings : readMappings();
        refreshMappingsFromExternalUpdate(nextMappings);
      });
    }

    if (mappingsValueSyncBound || typeof GM_addValueChangeListener !== 'function') {
      return;
    }

    mappingsValueSyncBound = true;
    GM_addValueChangeListener(STORAGE_KEY, (_key, _oldValue, newValue, remote) => {
      if (!remote) {
        return;
      }

      const nextMappings = Array.isArray(newValue) ? newValue : readMappings();
      refreshMappingsFromExternalUpdate(nextMappings);
    });
  }

  function findMappingForCurrentPage(mappings) {
    const currentKey = getMappingMatchKey(location.href);
    return mappings.find((item) => getMappingMatchKey(item.url) === currentKey) || null;
  }

  function syncDocumentTitle(mappings = readMappings()) {
    const matched = findMappingForCurrentPage(mappings);
    const matchedNumber = String(matched?.number || '').trim();

    if (!matchedNumber) {
      if (!appliedMappingTitle && document.title) {
        originalDocumentTitle = document.title;
      } else if (appliedMappingTitle && document.title !== appliedMappingTitle) {
        originalDocumentTitle = document.title;
      } else if (appliedMappingTitle && document.title === appliedMappingTitle) {
        document.title = originalDocumentTitle;
      }

      appliedMappingTitle = '';
      return;
    }

    if (!appliedMappingTitle && document.title) {
      originalDocumentTitle = document.title;
    }

    appliedMappingTitle = matchedNumber;
    if (document.title !== matchedNumber) {
      document.title = matchedNumber;
    }
  }

  function isRemoteTimestampParam(key) {
    return /remote\s*timestamp/i.test(String(key || '').replace(/[_-]/g, ''));
  }

  function hasRemoteTimestampInUrl(input = location.href) {
    try {
      const url = new URL(input, location.origin);
      return Array.from(url.searchParams.keys()).some((key) => isRemoteTimestampParam(key));
    } catch (error) {
      return false;
    }
  }

  function getPersistedMappingUrl(input = location.href) {
    return normalizeUrl(input);
  }

  function getPendingPasswordStorageKey(url) {
    return `tm-vps-auto-login:pending-password:${url}`;
  }

  function setPendingPassword(url, password) {
    if (!url) {
      return;
    }

    const storageKey = getPendingPasswordStorageKey(url);
    if (!password) {
      sessionStorage.removeItem(storageKey);
      return;
    }

    sessionStorage.setItem(storageKey, password);
  }

  function getPendingPassword(url) {
    if (!url) {
      return '';
    }

    return sessionStorage.getItem(getPendingPasswordStorageKey(url)) || '';
  }

  function clearPendingPassword(url) {
    if (!url) {
      return;
    }

    sessionStorage.removeItem(getPendingPasswordStorageKey(url));
  }

  function hasPendingClose(url) {
    return Boolean(url) && pendingCloseUrl === url && pendingCloseUntil > Date.now();
  }

  function clearPendingClose(url) {
    if (!url || pendingCloseUrl === url) {
      pendingCloseUrl = '';
      pendingCloseUntil = 0;
      closeArmedByRemoteClick = false;
    }
  }

  function setPendingClose(url) {
    if (!url) {
      return;
    }

    pendingCloseUrl = url;
    pendingCloseUntil = Date.now() + 30000;
  }

  function upsertMapping(url, password) {
    if (!url || !password) {
      return readMappings();
    }

    const normalizedUrl = normalizeUrl(url);
    const previous = readMappings().find((item) => normalizeUrl(item.url) === normalizedUrl);
    const next = readMappings().filter((item) => normalizeUrl(item.url) !== normalizedUrl);
    next.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      number: previous?.number || '',
      url: normalizedUrl,
      password,
    });
    writeMappings(next);
    return next;
  }

  function dispatchInputEvents(input) {
    if (hasEnteredRemoteSession()) {
      return;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillInputValue(input, value) {
    if (hasEnteredRemoteSession()) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    dispatchInputEvents(input);
  }

  function findLoginPasswordInput() {
    if (hasEnteredRemoteSession()) {
      return null;
    }

    const passwordSelectors = [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]',
      'input[placeholder*="密码"]',
      'input[placeholder*="password" i]',
    ];

    for (const selector of passwordSelectors) {
      const input = document.querySelector(selector);
      if (input instanceof HTMLInputElement && isVisible(input)) {
        return input;
      }
    }

    return null;
  }

  function observeManualPasswordInput(input, url) {
    if (hasEnteredRemoteSession() ||
      !(input instanceof HTMLInputElement) ||
      observedPasswordInputs.has(input)) {
      return;
    }

    observedPasswordInputs.add(input);

    const savePassword = (event) => {
      if (!event.isTrusted || hasEnteredRemoteSession()) {
        return;
      }

      setPendingPassword(url, input.value.trim());
    };

    input.addEventListener('input', savePassword);
    input.addEventListener('change', savePassword);
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function clickLoginButton(input) {
    if (hasEnteredRemoteSession()) {
      return false;
    }

    const form = input.form;
    const buttonSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:not([type])',
      'button[type="button"]',
    ];

    const candidates = [];
    const scope = form || document;

    for (const selector of buttonSelectors) {
      candidates.push(...scope.querySelectorAll(selector));
    }

    const keywords = ['login', 'log in', 'submit', 'connect', 'unlock', 'signin', 'sign in', '登录', '进入', '连接', '提交', '确认'];
    const found = candidates.find((button) => {
      if (!(button instanceof HTMLElement) || !isVisible(button) || button.hasAttribute('disabled')) {
        return false;
      }

      const text = `${button.innerText || ''} ${button.getAttribute('value') || ''}`.toLowerCase();
      return keywords.some((keyword) => text.includes(keyword));
    });

    if (found) {
      if (submitButtonLike(found)) {
        return true;
      }
      found.click();
      return true;
    }

    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }

    if (form) {
      form.submit();
      return true;
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return false;
  }

  function findEnterRemoteButton() {
    const btn = [...document.querySelectorAll('button')].find((el) => {
      return el instanceof HTMLButtonElement &&
        isVisible(el) &&
        !el.disabled &&
        el.textContent.replace(/\s+/g, '').includes('进入远程');
    });

    return btn instanceof HTMLButtonElement ? btn : null;
  }

  function hasEnteredRemoteSession() {
    return Array.from(document.querySelectorAll('div[class*="headerStatusBar_"]'))
      .some((element) => String(element.className || '')
        .split(/\s+/)
        .some((className) => /^headerStatusBar_/.test(className)));
  }

  function getSubmitForm(button) {
    if (button instanceof HTMLButtonElement && button.form) {
      return button.form;
    }

    if (button instanceof HTMLInputElement && button.form) {
      return button.form;
    }

    return button.closest('form');
  }

  function submitButtonLike(button) {
    const form = getSubmitForm(button);
    if (!form) {
      return false;
    }

    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit(button);
      return true;
    }

    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    const notCanceled = form.dispatchEvent(submitEvent);
    if (notCanceled) {
      form.submit();
    }

    return true;
  }

  function shouldSkipRecentAction(actionKey, guardMs) {
    const now = Date.now();
    const lastAttempt = attemptCache.get(actionKey) || 0;
    if (now - lastAttempt < guardMs) {
      return true;
    }

    attemptCache.set(actionKey, now);
    return false;
  }

  function clearRecentAction(actionKey) {
    attemptCache.delete(actionKey);
  }

  function shouldSkipRecentSubmit(url) {
    return shouldSkipRecentAction(`submit:${url}`, SUBMIT_GUARD_MS);
  }

  function createPopupPermissionBadge() {
    if (document.getElementById(PERMISSION_BADGE_ID)) {
      return;
    }

    const host = document.createElement('div');
    host.id = PERMISSION_BADGE_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '84px';
    host.style.zIndex = '2147483647';

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .badge {
          box-sizing: border-box;
          min-width: 168px;
          max-width: 280px;
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
          color: #334155;
          font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          transition: transform 160ms ease, opacity 160ms ease, box-shadow 160ms ease;
        }
        .badge.allowed {
          color: #065f46;
          border-color: rgba(16, 185, 129, 0.4);
          background: rgba(236, 253, 245, 0.98);
        }
        .badge.blocked {
          color: #991b1b;
          border-color: rgba(248, 113, 113, 0.45);
          background: rgba(254, 242, 242, 0.98);
        }
        .badge.checking {
          color: #92400e;
          border-color: rgba(245, 158, 11, 0.45);
          background: rgba(255, 251, 235, 0.98);
        }
        .detail {
          display: block;
          margin-top: 2px;
          font-weight: 500;
          color: inherit;
          opacity: 0.75;
        }
      </style>
      <div class="badge">
        <span class="label"></span>
        <span class="detail"></span>
      </div>
    `;

    document.documentElement.appendChild(host);
    renderPopupPermissionBadge();
  }

  function setPopupPermissionState(state, detail) {
    popupPermissionState = state;
    popupPermissionDetail = detail || '';
    renderPopupPermissionBadge();
  }

  function markInternalUiInteraction() {
    lastInternalUiInteractionAt = Date.now();
    popupPermissionAllowedStreak = 0;
  }

  function shouldSuppressPopupPermissionProbe() {
    return (Date.now() - lastInternalUiInteractionAt) < INTERNAL_UI_PERMISSION_PROBE_SUPPRESS_MS;
  }

  function getPopupPermissionProbeDelay() {
    if (!popupPermissionLastCheckedAt) {
      return 0;
    }

    const elapsed = Date.now() - popupPermissionLastCheckedAt;
    return Math.max(0, POPUP_PERMISSION_PROBE_COOLDOWN_MS - elapsed);
  }

  function queuePopupPermissionCheck(delay = 0) {
    if (popupPermissionTimer) {
      return;
    }

    popupPermissionTimer = window.setTimeout(() => {
      popupPermissionTimer = 0;
      checkPopupPermission();
    }, Math.max(0, delay));
  }

  function requestPopupPermissionRecheck() {
    if (!popupPermissionShouldRecheckOnFocus) {
      return;
    }

    startPopupPermissionPolling();
  }

  function bindPopupPermissionProbeEvents() {
    if (popupPermissionProbeEventsBound) {
      return;
    }

    popupPermissionProbeEventsBound = true;

    window.addEventListener('focus', requestPopupPermissionRecheck);
    window.addEventListener('pageshow', requestPopupPermissionRecheck);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        requestPopupPermissionRecheck();
      }
    });
  }

  function getPopupPermissionText() {
    if (isExternalSavedLinkHost()) {
      if (externalJumpPermissionMode === 'checking') {
        return {
          label: '等待跳转授权',
          detail: '',
          tone: 'checking',
        };
      }

      if (externalJumpPermissionMode === 'blocked') {
        return {
          label: '跳转失败',
          detail: '',
          tone: 'blocked',
        };
      }

      if (externalJumpPermissionMode === 'allowed') {
        return {
          label: '正在打开新Tab',
          detail: '',
          tone: 'allowed',
        };
      }
    }

    if (hasEnteredRemoteSession()) {
      return {
        label: '已连接',
        detail: '',
        tone: 'status-vps',
      };
    }

    if (findLoginPasswordInput()) {
      return {
        label: '等待登陆',
        detail: '',
        tone: 'status-login',
      };
    }

    return {
      label: '已登录',
      detail: '',
      tone: 'status-logged',
    };
  }

  function getPopupPermissionGuideText() {
    if (isExternalSavedLinkHost()) {
      if (externalJumpPermissionMode === 'checking') {
        return `请允许当前站点打开弹出窗口与重定向，脚本会在 ${Math.ceil(Math.max(0, externalJumpPermissionDeadline - Date.now()) / 1000)} 秒内自动重试跳转。`;
      }

      if (externalJumpPermissionMode === 'blocked') {
        return '跳转失败：浏览器仍阻止此站点打开新Tab，请手动允许弹出窗口与重定向后再点击按钮。';
      }

      return '';
    }

    if (!shouldProbePopupPermission()) {
      return '';
    }

    if (popupPermissionState !== 'checking' && popupPermissionState !== 'blocked') {
      return '';
    }

    return '请先手动允许当前站点的弹窗与重定向；若浏览器没有出现授权提示，请前往 chrome://settings/content/popups ，将 home.kuniaovps.com 和 home.geliyun.com 添加到允许列表。';
  }

  function renderPopupPermissionNode(root) {
    const text = getPopupPermissionText();
    root.querySelectorAll('.badge, .inline-status').forEach((badge) => {
      if (!(badge instanceof HTMLElement)) {
        return;
      }

      const label = badge.querySelector('.label');
      const detail = badge.querySelector('.detail');
      if (!(label instanceof HTMLElement) || !(detail instanceof HTMLElement)) {
        return;
      }

      const baseClass = badge.classList.contains('inline-status')
        ? 'inline-status'
        : 'badge';
      badge.className = `${baseClass} ${popupPermissionState} ${text.tone || ''}`;
      label.textContent = text.label;
      detail.textContent = badge.classList.contains('inline-status')
        ? ''
        : (popupPermissionDetail || text.detail);
    });

    const guide = root.querySelector('.js-permission-guide');
    const guideText = root.querySelector('.js-permission-guide-text');
    const guideContent = getPopupPermissionGuideText();
    if (guide instanceof HTMLElement) {
      guide.hidden = !guideContent;
      if (guideText instanceof HTMLElement) {
        guideText.textContent = guideContent;
      }
    }
  }

  function syncPopupPermissionBadgePlacement() {
    const badgeHost = document.getElementById(PERMISSION_BADGE_ID);
    const badgeShadowRoot = badgeHost?.shadowRoot;
    const badge = badgeShadowRoot?.querySelector('.badge');
    if (!(badgeHost instanceof HTMLElement) || !(badge instanceof HTMLElement)) {
      return;
    }

    const panelHost = document.getElementById(PANEL_ID);
    const panelShadowRoot = panelHost?.shadowRoot;
    if (panelHost instanceof HTMLElement && panelShadowRoot) {
      badgeHost.style.display = 'none';
      return;
    }

    const wrap = panelShadowRoot?.querySelector('.wrap');
    const toggle = panelShadowRoot?.querySelector('.toggle');
    const panelOpen = wrap instanceof HTMLElement && wrap.classList.contains('open');
    if (!(panelHost instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
      return;
    }

    if (panelOpen) {
      badgeHost.style.display = 'none';
      return;
    }

    badgeHost.style.display = '';
    badgeHost.style.position = 'fixed';
    badgeHost.style.right = '';
    badgeHost.style.bottom = '';

    const side = panelHost.dataset.side === 'left' ? 'left' : 'right';
    const toggleRect = toggle.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const top = toggleRect.top >= (badgeRect.height + PANEL_GAP + PANEL_EDGE_MARGIN)
      ? toggleRect.top - badgeRect.height - 8
      : toggleRect.bottom + 8;

    badgeHost.style.top = `${Math.round(top)}px`;
    if (side === 'left') {
      const left = Math.min(
        Math.max(PANEL_EDGE_MARGIN, toggleRect.left),
        Math.max(PANEL_EDGE_MARGIN, window.innerWidth - badgeRect.width - PANEL_EDGE_MARGIN),
      );
      badgeHost.style.left = `${Math.round(left)}px`;
    } else {
      const right = Math.min(
        Math.max(PANEL_EDGE_MARGIN, window.innerWidth - toggleRect.right),
        Math.max(PANEL_EDGE_MARGIN, window.innerWidth - badgeRect.width - PANEL_EDGE_MARGIN),
      );
      badgeHost.style.left = '';
      badgeHost.style.right = `${Math.round(right)}px`;
    }
  }

  function renderPopupPermissionBadge() {
    const host = document.getElementById(PERMISSION_BADGE_ID);
    const shadowRoot = host?.shadowRoot;
    if (!shadowRoot) {
      return;
    }

    renderPopupPermissionNode(shadowRoot);

    const panelHost = document.getElementById(PANEL_ID);
    const panelShadowRoot = panelHost?.shadowRoot;
    if (panelShadowRoot) {
      renderPopupPermissionNode(panelShadowRoot);
      if (typeof panelHost?.__syncPermissionGuidePlacement === 'function') {
        panelHost.__syncPermissionGuidePlacement();
      }
    }

    syncPopupPermissionBadgePlacement();
  }

  function startStatusLabelPolling() {
    if (statusLabelPollTimer) {
      return;
    }

    statusLabelPollTimer = window.setInterval(() => {
      renderPopupPermissionBadge();
    }, STATUS_LABEL_POLL_INTERVAL_MS);
  }

  function shouldProbePopupPermission() {
    return Boolean(findEnterRemoteButton()) && !findLoginPasswordInput() && !wasOpenedByRemoteButton();
  }

  function isPopupPermissionAllowed() {
    return popupPermissionState === 'allowed' &&
      (Date.now() - popupPermissionLastCheckedAt) <= POPUP_PERMISSION_ALLOWED_TTL_MS;
  }

  function probePopupPermissionOnce() {
    let probe = null;
    try {
      probe = window.open('about:blank', '_blank', 'width=1,height=1,left=-32000,top=-32000');
      if (!probe || probe.closed) {
        return false;
      }

      probe.close();
      return true;
    } catch (error) {
      console.warn('[VPS Auto Login] popup permission probe failed.', error);
      return false;
    } finally {
      try {
        if (probe && !probe.closed) {
          probe.close();
        }
      } catch (error) {
        console.warn('[VPS Auto Login] popup permission probe close failed.', error);
      }
    }
  }

  function checkPopupPermission() {
    if (popupPermissionChecking) {
      return;
    }

    if (!shouldProbePopupPermission()) {
      pendingRemoteEntryUrl = '';
      popupPermissionAllowedStreak = 0;
      popupPermissionShouldRecheckOnFocus = false;
      stopPopupPermissionPolling();
      if (wasOpenedByRemoteButton()) {
        setPopupPermissionState('opened', '远程页不会自动点击');
      } else {
        setPopupPermissionState('idle', '等待进入远程按钮');
      }
      return;
    }

    if (shouldSuppressPopupPermissionProbe()) {
      const suppressRemaining = Math.max(0, INTERNAL_UI_PERMISSION_PROBE_SUPPRESS_MS - (Date.now() - lastInternalUiInteractionAt));
      popupPermissionAllowedStreak = 0;
      popupPermissionShouldRecheckOnFocus = true;
      setPopupPermissionState('checking', '等待浏览器授权');
      queuePopupPermissionCheck(Math.max(suppressRemaining, getPopupPermissionProbeDelay()));
      return;
    }

    popupPermissionChecking = true;
    setPopupPermissionState('checking', '正在检测浏览器弹窗权限');

    const allowed = probePopupPermissionOnce();
    popupPermissionLastCheckedAt = Date.now();
    popupPermissionChecking = false;

    if (allowed) {
      popupPermissionAllowedStreak = 1;
      popupPermissionShouldRecheckOnFocus = false;
      setPopupPermissionState('allowed', '已允许，准备进入远程');
      if (pendingRemoteEntryUrl) {
        const nextRemoteEntryUrl = pendingRemoteEntryUrl;
        window.setTimeout(() => clickEnterRemoteButton(nextRemoteEntryUrl), 0);
      }
      return;
    }

    popupPermissionAllowedStreak = 0;
    popupPermissionShouldRecheckOnFocus = true;
    setPopupPermissionState('blocked', '请允许此站点打开新页面');
  }

  function startPopupPermissionPolling() {
    createPopupPermissionBadge();
    bindPopupPermissionProbeEvents();
    popupPermissionShouldRecheckOnFocus = true;
    queuePopupPermissionCheck(getPopupPermissionProbeDelay());
  }

  function stopPopupPermissionPolling() {
    if (popupPermissionTimer) {
      clearTimeout(popupPermissionTimer);
      popupPermissionTimer = 0;
    }
    popupPermissionShouldRecheckOnFocus = false;
  }

  function markNextOpenedRemoteTab() {
    try {
      sessionStorage.setItem(REMOTE_TAB_MARK_KEY, String(Date.now()));
      window.setTimeout(() => {
        sessionStorage.removeItem(REMOTE_TAB_MARK_KEY);
      }, REMOTE_CLICK_GUARD_MS);
    } catch (error) {
      console.warn('[VPS Auto Login] mark opened remote tab failed.', error);
    }
  }

  function clearOpenedRemoteTabMark() {
    try {
      sessionStorage.removeItem(REMOTE_TAB_MARK_KEY);
    } catch (error) {
      console.warn('[VPS Auto Login] clear opened remote tab mark failed.', error);
    }
  }

  function wasOpenedByRemoteButton() {
    try {
      const openedAt = Number(sessionStorage.getItem(REMOTE_TAB_MARK_KEY) || 0);
      if (!openedAt) {
        return false;
      }

      if ((Date.now() - openedAt) > REMOTE_CLICK_GUARD_MS) {
        clearOpenedRemoteTabMark();
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  function shouldCloseCurrentTab() {
    return closeArmedByRemoteClick && !findLoginPasswordInput();
  }

  function stopCloseCurrentTabRetry() {
    if (closeTabTimer) {
      clearTimeout(closeTabTimer);
      closeTabTimer = 0;
    }

    if (closeTabRetryTimer) {
      clearInterval(closeTabRetryTimer);
      closeTabRetryTimer = 0;
    }
  }

  function closeCurrentTabNow(url) {
    if (!shouldCloseCurrentTab()) {
      clearPendingClose(url);
      stopCloseCurrentTabRetry();
      return false;
    }

    try {
      window.close();
    } catch (error) {
      console.warn('[VPS Auto Login] window.close failed.', error);
    }

    window.setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        clearPendingClose(url);
        return;
      }

      try {
        window.open('', '_self');
      } catch (error) {
        console.warn('[VPS Auto Login] window.open(_self) failed.', error);
      }

      try {
        window.close();
      } catch (error) {
        console.warn('[VPS Auto Login] secondary window.close failed.', error);
      }
    }, 80);

    window.setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        clearPendingClose(url);
        return;
      }

      try {
        location.replace('about:blank');
      } catch (error) {
        console.warn('[VPS Auto Login] location.replace failed.', error);
      }

      try {
        window.close();
      } catch (error) {
        console.warn('[VPS Auto Login] final window.close failed.', error);
      }
    }, 180);

    return true;
  }

  function scheduleCloseCurrentTab(url) {
    if ((closeTabTimer || closeTabRetryTimer) || !shouldCloseCurrentTab()) {
      return false;
    }

    if (shouldSkipRecentAction(`close:${url}`, REMOTE_CLICK_GUARD_MS)) {
      return false;
    }

    setPendingClose(url);
    closeTabTimer = window.setTimeout(() => {
      closeTabTimer = 0;
      closeTabRetryStartedAt = Date.now();
      closeCurrentTabNow(url);

      closeTabRetryTimer = window.setInterval(() => {
        if (!hasPendingClose(url)) {
          stopCloseCurrentTabRetry();
          return;
        }

        if (document.visibilityState === 'hidden') {
          clearPendingClose(url);
          stopCloseCurrentTabRetry();
          return;
        }

        if ((Date.now() - closeTabRetryStartedAt) >= TAB_CLOSE_MAX_RETRY_MS) {
          clearPendingClose(url);
          stopCloseCurrentTabRetry();
          return;
        }

        closeCurrentTabNow(url);
      }, TAB_CLOSE_RETRY_INTERVAL_MS);
    }, TAB_CLOSE_DELAY_MS);

    return true;
  }

  function retryPendingClose(url) {
    if (!hasPendingClose(url) || closeTabTimer || closeTabRetryTimer || !shouldCloseCurrentTab()) {
      return false;
    }

    closeTabRetryStartedAt = Date.now();
    closeCurrentTabNow(url);

    closeTabRetryTimer = window.setInterval(() => {
      if (!hasPendingClose(url)) {
        stopCloseCurrentTabRetry();
        return;
      }

      if (document.visibilityState === 'hidden') {
        clearPendingClose(url);
        stopCloseCurrentTabRetry();
        return;
      }

      if ((Date.now() - closeTabRetryStartedAt) >= TAB_CLOSE_MAX_RETRY_MS) {
        clearPendingClose(url);
        stopCloseCurrentTabRetry();
        return;
      }

      closeCurrentTabNow(url);
    }, TAB_CLOSE_RETRY_INTERVAL_MS);

    return true;
  }

  function clickEnterRemoteButton(url) {
    const initialButton = findEnterRemoteButton();
    if (!initialButton) {
      pendingRemoteEntryUrl = '';
      return false;
    }

    if (!isPopupPermissionAllowed()) {
      pendingRemoteEntryUrl = normalizeUrl(url);
      setPopupPermissionState('checking', '等待浏览器允许打开新页面');
      startPopupPermissionPolling();
      return false;
    }

    if (remoteClickTimer) {
      return false;
    }

    remoteClickTimer = window.setTimeout(() => {
      remoteClickTimer = 0;

      const button = findEnterRemoteButton();
      if (!button || !isPopupPermissionAllowed() || shouldSkipRecentAction(`remote:${url}`, REMOTE_CLICK_GUARD_MS)) {
        if (!button) {
          pendingRemoteEntryUrl = '';
        }
        if (!isPopupPermissionAllowed()) {
          startPopupPermissionPolling();
        }
        return;
      }

      pendingRemoteEntryUrl = '';
      stopPopupPermissionPolling();
      setPopupPermissionState('allowed', '正在点击进入远程');
      button.scrollIntoView({ behavior: 'smooth', block: 'center' });
      button.style.outline = '2px solid red';
      markNextOpenedRemoteTab();
      button.click();
      closeArmedByRemoteClick = true;
      scheduleCloseCurrentTab(url);
    }, REMOTE_CLICK_DELAY_MS);

    return true;
  }

  function tryAutoLogin(mappings) {
    syncDocumentTitle(mappings);
    const matched = findMappingForCurrentPage(mappings);
    const persistedMappingUrl = getPersistedMappingUrl(location.href);

    retryPendingClose(persistedMappingUrl);

    if (hasEnteredRemoteSession()) {
      stopPopupPermissionPolling();
      pendingRemoteEntryUrl = '';
      return;
    }

    const passwordInput = findLoginPasswordInput();
    if (passwordInput) {
      observeManualPasswordInput(passwordInput, persistedMappingUrl);

      if (matched) {
        fillInputValue(passwordInput, matched.password);

        if (!shouldSkipRecentSubmit(matched.url)) {
          clickLoginButton(passwordInput);
        }
      }

      return;
    }

    if (wasOpenedByRemoteButton()) {
      stopPopupPermissionPolling();
      setPopupPermissionState('opened', '远程页不会自动点击');
      return;
    }

    if (findEnterRemoteButton()) {
      const pendingPassword = getPendingPassword(persistedMappingUrl);
      if (pendingPassword) {
        upsertMapping(persistedMappingUrl, pendingPassword);
        clearPendingPassword(persistedMappingUrl);
      }

      clickEnterRemoteButton(persistedMappingUrl);
    }
  }

  function isExactClassSpan(element, className) {
    return element instanceof HTMLSpanElement &&
      String(element.getAttribute('class') || '').trim() === className;
  }

  function getExactClassSpans(className, root = document) {
    return Array.from(root.querySelectorAll(`span.${className}`))
      .filter((element) => isExactClassSpan(element, className));
  }

  function getExternalJumpContainerFromAvatar(avatar) {
    const parent1 = avatar?.parentElement;
    const parent2 = parent1?.parentElement;
    const parent3 = parent2?.parentElement;
    return parent3 instanceof HTMLElement ? parent3 : null;
  }

  function getNumberedMappings(mappings = readMappings()) {
    return mappings
      .map((item) => ({
        ...item,
        number: String(item.number || '').trim(),
        normalizedNumber: String(item.number || '').replace(/\s+/g, ''),
      }))
      .filter((item) => item.number && item.normalizedNumber && item.url)
      .sort((a, b) => b.normalizedNumber.length - a.normalizedNumber.length);
  }

  function findMappingForExternalLabel(label, numberedMappings) {
    const labelText = String(label.textContent || '');
    const normalizedLabelText = labelText.replace(/\s+/g, '');
    return numberedMappings.find((item) => (
      labelText.includes(item.number) ||
      normalizedLabelText.includes(item.normalizedNumber)
    )) || null;
  }

  function applyExternalJumpButtonStyle(button) {
    button.style.all = 'initial';
    button.style.boxSizing = 'border-box';
    button.style.display = 'inline-flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.flex = '0 0 auto';
    button.style.order = '-999';
    button.style.height = '28px';
    button.style.minWidth = '48px';
    button.style.maxWidth = '180px';
    button.style.padding = '0 10px';
    button.style.margin = '2px 8px 2px 0';
    button.style.border = '1px solid rgba(37, 99, 235, 0.35)';
    button.style.borderRadius = '6px';
    button.style.background = '#2563eb';
    button.style.color = '#ffffff';
    button.style.font = '600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    button.style.whiteSpace = 'nowrap';
    button.style.overflow = 'hidden';
    button.style.textOverflow = 'ellipsis';
    button.style.cursor = 'pointer';
    button.style.userSelect = 'none';
    button.style.boxShadow = '0 4px 10px rgba(37, 99, 235, 0.18)';
    button.style.transition = 'background-color 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease';
  }

  function setExternalJumpButtonHover(button, hovering) {
    if (hovering) {
      button.style.background = '#1d4ed8';
      button.style.borderColor = 'rgba(29, 78, 216, 0.46)';
      button.style.transform = 'translateY(-1px)';
      button.style.boxShadow = '0 6px 14px rgba(37, 99, 235, 0.22)';
      return;
    }

    applyExternalJumpButtonStyle(button);
  }

  function removeDuplicateExternalJumpButtons(container, keeper) {
    Array.from(container.children).forEach((child) => {
      if (child !== keeper &&
        child instanceof HTMLElement &&
        child.classList.contains(EXTERNAL_JUMP_BUTTON_CLASS)) {
        child.remove();
      }
    });
  }

  function openExternalJumpTab(url) {
    try {
      const opened = window.open(url, '_blank');
      if (!opened || opened.closed) {
        return false;
      }

      try {
        opened.opener = null;
      } catch (error) {
        // Ignore browsers that disallow mutating opener on cross-origin tabs.
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  function clearExternalJumpPermissionWait(mode = 'idle', detail = '') {
    if (externalJumpPermissionTimer) {
      clearTimeout(externalJumpPermissionTimer);
      externalJumpPermissionTimer = 0;
    }

    pendingExternalJumpUrl = '';
    pendingExternalJumpLabel = '';
    externalJumpPermissionDeadline = 0;
    externalJumpPermissionMode = mode;
    if (detail || mode !== 'idle') {
      setPopupPermissionState(mode, detail);
    } else {
      const badgeHost = document.getElementById(PERMISSION_BADGE_ID);
      if (isExternalSavedLinkHost() && badgeHost instanceof HTMLElement) {
        badgeHost.remove();
        return;
      }

      renderPopupPermissionBadge();
    }
  }

  function scheduleExternalJumpPermissionProbe() {
    if (!pendingExternalJumpUrl || externalJumpPermissionTimer) {
      return;
    }

    externalJumpPermissionTimer = window.setTimeout(() => {
      externalJumpPermissionTimer = 0;
      pollExternalJumpPermission();
    }, EXTERNAL_JUMP_PERMISSION_POLL_INTERVAL_MS);
  }

  function pollExternalJumpPermission() {
    if (!pendingExternalJumpUrl) {
      clearExternalJumpPermissionWait();
      return;
    }

    if (Date.now() >= externalJumpPermissionDeadline) {
      clearExternalJumpPermissionWait('blocked', '跳转失败：浏览器仍阻止打开新Tab');
      return;
    }

    const remainingSeconds = Math.ceil(Math.max(0, externalJumpPermissionDeadline - Date.now()) / 1000);
    externalJumpPermissionMode = 'checking';
    setPopupPermissionState('checking', `等待浏览器允许打开新Tab（剩余${remainingSeconds}s）`);

    if (probePopupPermissionOnce() && openExternalJumpTab(pendingExternalJumpUrl)) {
      clearExternalJumpPermissionWait('allowed', `正在打开${pendingExternalJumpLabel || 'VPS'}`);
      window.setTimeout(() => {
        if (externalJumpPermissionMode === 'allowed') {
          clearExternalJumpPermissionWait();
        }
      }, 1800);
      return;
    }

    scheduleExternalJumpPermissionProbe();
  }

  function waitForExternalJumpPermission(url, label) {
    pendingExternalJumpUrl = url;
    pendingExternalJumpLabel = label;
    externalJumpPermissionDeadline = Date.now() + EXTERNAL_JUMP_PERMISSION_TIMEOUT_MS;
    externalJumpPermissionMode = 'checking';
    createPopupPermissionBadge();
    bindPopupPermissionProbeEvents();
    pollExternalJumpPermission();
  }

  function handleExternalJumpClick(url, label) {
    clearExternalJumpPermissionWait();
    if (openExternalJumpTab(url)) {
      return;
    }

    waitForExternalJumpPermission(url, label);
  }

  function upsertExternalJumpButton(container, mapping) {
    const targetUrl = normalizeUrl(mapping.url);
    if (!targetUrl) {
      return;
    }

    const existingButton = Array.from(container.children)
      .find((child) => child instanceof HTMLButtonElement &&
        child.classList.contains(EXTERNAL_JUMP_BUTTON_CLASS));
    const button = existingButton || document.createElement('button');
    const buttonText = `打开 [${mapping.number}] VPS`;
    const title = `${buttonText}：${targetUrl}`;

    if (!existingButton) {
      button.type = 'button';
      button.className = EXTERNAL_JUMP_BUTTON_CLASS;
    }

    button.dataset.tmVpsMappingId = mapping.id;
    button.dataset.tmVpsTargetUrl = targetUrl;
    button.setAttribute('aria-label', title);
    if (button.title !== title) {
      button.title = title;
    }
    if (button.textContent !== buttonText) {
      button.textContent = buttonText;
    }

    applyExternalJumpButtonStyle(button);
    button.onmouseenter = () => setExternalJumpButtonHover(button, true);
    button.onmouseleave = () => setExternalJumpButtonHover(button, false);
    button.onmousedown = () => {
      button.style.transform = 'translateY(0) scale(0.98)';
    };
    button.onmouseup = () => setExternalJumpButtonHover(button, true);
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleExternalJumpClick(targetUrl, buttonText);
    };

    removeDuplicateExternalJumpButtons(container, button);
    if (container.firstChild !== button) {
      container.insertBefore(button, container.firstChild);
    }
  }

  function removeExternalSavedLinkButtons() {
    document.querySelectorAll(`.${EXTERNAL_JUMP_BUTTON_CLASS}`).forEach((button) => {
      button.remove();
    });
  }

  function syncExternalSavedLinkButtons(mappings = readMappings()) {
    if (!isExternalSavedLinkHost()) {
      return;
    }

    const numberedMappings = getNumberedMappings(mappings);
    if (numberedMappings.length === 0) {
      removeExternalSavedLinkButtons();
      return;
    }

    const avatarContainers = Array.from(new Set(
      getExactClassSpans(AVATAR_CLASS)
        .map((avatar) => getExternalJumpContainerFromAvatar(avatar))
        .filter((container) => container instanceof HTMLElement),
    ));

    const activeContainers = new Set();
    getExactClassSpans(RENDER_LABEL_CLASS).forEach((label) => {
      const mapping = findMappingForExternalLabel(label, numberedMappings);
      if (!mapping) {
        return;
      }

      const container = avatarContainers[0] || null;
      if (!container) {
        return;
      }

      if (activeContainers.has(container)) {
        return;
      }

      activeContainers.add(container);
      upsertExternalJumpButton(container, mapping);
    });

    document.querySelectorAll(`.${EXTERNAL_JUMP_BUTTON_CLASS}`).forEach((button) => {
      if (button.parentElement && activeContainers.has(button.parentElement)) {
        return;
      }
      button.remove();
    });
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.zIndex = '2147483647';
    host.style.transition = 'left 180ms ease, top 180ms ease';
    host.dataset.side = 'right';

    const shadowRoot = host.attachShadow({ mode: 'open' });
    let mappings = readMappings();
    const TEMP_MAPPING_ID = '__tm-vps-current-unsaved__';
    const numberDrafts = new Map();
    const editingNumberIds = new Set();
    const passwordDrafts = new Map();
    const editingPasswordIds = new Set();
    const manualDraft = {
      url: '',
      number: '',
      password: '',
    };
    let manualCreatorOpen = false;

    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .wrap {
          position: relative;
          width: 52px;
          min-height: 52px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #1f2937;
          caret-color: transparent;
          transition: transform 160ms ease, opacity 160ms ease;
        }
        .wrap.side-right {
          transform-origin: right bottom;
        }
        .wrap.side-left {
          transform-origin: left bottom;
        }
        .wrap.open {
          width: var(--panel-width, min(360px, calc(100vw - 24px)));
        }
        .wrap.dragging {
          cursor: grabbing;
          opacity: 0.92;
          transform: scale(0.995);
        }
        .control-row {
          display: flex;
          align-items: center;
          gap: 10px;
          position: relative;
          z-index: 2;
          width: max-content;
          cursor: grab;
          user-select: none;
        }
        .wrap.side-left .control-row {
          flex-direction: row;
          justify-content: flex-start;
        }
        .wrap.side-right .control-row {
          flex-direction: row-reverse;
          justify-content: flex-start;
        }
        .wrap.side-right:not(.open) .control-row {
          transform: translateX(calc(52px - 100%));
        }
        .wrap.open .control-row {
          width: 100%;
        }
        .wrap.open.side-left .control-row {
          justify-content: flex-start;
        }
        .wrap.open.side-right .control-row {
          justify-content: flex-start;
        }
        .wrap.dragging .control-row {
          cursor: grabbing;
        }
        .toggle {
          position: relative;
          flex: 0 0 auto;
          width: 52px;
          height: 52px;
          border: none;
          border-radius: 999px;
          background: linear-gradient(135deg, #0f766e, #2563eb);
          color: #fff;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 12px 30px rgba(37, 99, 235, 0.22), 0 8px 20px rgba(15, 118, 110, 0.18);
          touch-action: none;
          transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
        }
        .wrap.open .toggle {
          color: transparent;
          background: linear-gradient(135deg, #0f172a, #334155);
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.28);
        }
        .wrap.open .toggle::before,
        .wrap.open .toggle::after {
          content: "";
          position: absolute;
          left: 50%;
          top: 50%;
          width: 18px;
          height: 2px;
          border-radius: 999px;
          background: #ffffff;
          transform-origin: center;
        }
        .wrap.open .toggle::before {
          transform: translate(-50%, -50%) rotate(45deg);
        }
        .wrap.open .toggle::after {
          transform: translate(-50%, -50%) rotate(-45deg);
        }
        .toggle:hover {
          transform: translateY(-1px);
          box-shadow: 0 14px 34px rgba(37, 99, 235, 0.26), 0 10px 24px rgba(15, 118, 110, 0.22);
          filter: saturate(1.05);
        }
        .toggle:active {
          transform: translateY(0) scale(0.98);
        }
        .inline-status {
          display: inline-flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          box-sizing: border-box;
          min-height: 52px;
          width: max-content;
          min-width: 0;
          max-width: min(250px, calc(100vw - 96px));
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.32);
          background: rgba(248, 250, 252, 0.96);
          box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
          color: #334155;
          font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          gap: 3px;
          animation: statusIn 160ms ease-out;
        }
        .inline-status .label,
        .inline-status .detail {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inline-status .label {
          font-size: 13px;
          font-weight: 700;
          line-height: 1.15;
        }
        .number-chip {
          display: none;
          flex: 0 0 auto;
          align-items: center;
          justify-content: center;
          max-width: 110px;
          min-height: 52px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 0 14px;
          border-radius: 999px;
          border: 1px solid rgba(37, 99, 235, 0.22);
          background: #eff6ff;
          color: #1d4ed8;
          font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 8px 22px rgba(15, 23, 42, 0.1);
        }
        .wrap.open .number-chip:not([hidden]) {
          display: inline-flex;
          animation: statusIn 180ms ease-out;
        }
        .inline-status.allowed {
          color: #0f766e;
          border-color: rgba(20, 184, 166, 0.28);
          background: rgba(240, 253, 250, 0.98);
        }
        .inline-status.blocked {
          color: #991b1b;
          border-color: rgba(248, 113, 113, 0.45);
          background: rgba(254, 242, 242, 0.98);
        }
        .inline-status.checking {
          color: #92400e;
          border-color: rgba(245, 158, 11, 0.45);
          background: rgba(255, 251, 235, 0.98);
        }
        .inline-status.status-login {
          color: #92400e;
          border-color: rgba(245, 158, 11, 0.34);
          background: rgba(255, 251, 235, 0.98);
        }
        .inline-status.status-logged {
          color: #166534;
          border-color: rgba(34, 197, 94, 0.3);
          background: rgba(240, 253, 244, 0.98);
        }
        .inline-status.status-vps {
          color: #0f766e;
          border-color: rgba(20, 184, 166, 0.32);
          background: rgba(240, 253, 250, 0.98);
        }
        .inline-status .detail {
          display: block;
          margin-top: 0;
          font-weight: 500;
          font-size: 11px;
          line-height: 1.15;
          color: inherit;
          opacity: 0.75;
        }
        .inline-status .detail:empty {
          display: none;
        }
        .panel {
          position: absolute;
          z-index: 1;
          display: none;
          box-sizing: border-box;
          width: var(--panel-width, min(360px, calc(100vw - 24px)));
          max-height: var(--panel-max-height, 70vh);
          margin-top: 0;
          padding: 14px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
          border: 1px solid rgba(148, 163, 184, 0.25);
          overflow-x: hidden;
          overflow-y: auto;
        }
        .wrap.side-left .panel {
          left: 0;
          right: auto;
        }
        .wrap.side-right .panel {
          left: auto;
          right: 0;
        }
        .panel.below {
          top: calc(100% + 10px + var(--panel-offset-extra, 0px));
          bottom: auto;
        }
        .panel.above {
          top: auto;
          bottom: calc(100% + 10px);
        }
        .panel.open {
          display: flex;
          flex-direction: column;
          animation: panelIn 180ms ease-out;
        }
        @keyframes panelIn {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.985);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes statusIn {
          from {
            opacity: 0;
            transform: translateX(-6px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .title {
          margin: 0 0 6px;
          font-size: 16px;
          font-weight: 700;
        }
        .desc {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
          color: #475569;
        }
        .panel-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .panel-copy {
          min-width: 0;
          flex: 1 1 auto;
        }
        .panel-action {
          flex: 0 0 auto;
          border: none;
          border-radius: 10px;
          padding: 8px 12px;
          background: linear-gradient(135deg, #0f766e, #2563eb);
          color: #fff;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(37, 99, 235, 0.16), 0 8px 18px rgba(15, 118, 110, 0.14);
          transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
        }
        .panel-action:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 28px rgba(37, 99, 235, 0.2), 0 10px 22px rgba(15, 118, 110, 0.18);
          filter: saturate(1.04);
        }
        .panel-action[hidden] {
          display: none;
        }
        .creator-card {
          margin-bottom: 12px;
          padding: 12px;
          border-radius: 14px;
          border: 1px solid rgba(37, 99, 235, 0.16);
          background: linear-gradient(180deg, rgba(239, 246, 255, 0.72), rgba(240, 253, 250, 0.96));
        }
        .creator-card[hidden] {
          display: none;
        }
        .permission-guide {
          padding: 12px 13px;
          border-radius: 14px;
          border: 1px solid rgba(245, 158, 11, 0.24);
          background: linear-gradient(180deg, rgba(255, 251, 235, 0.96), rgba(255, 247, 237, 0.98));
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
          animation: panelIn 180ms ease-out;
        }
        .permission-guide-floating {
          position: absolute;
          z-index: 1;
          width: min(320px, calc(100vw - 24px));
          max-width: min(320px, calc(100vw - 24px));
        }
        .permission-guide-floating.guide-above {
          top: auto;
          bottom: calc(100% + 10px);
        }
        .permission-guide-floating.guide-below {
          top: calc(100% + 10px);
          bottom: auto;
        }
        .permission-guide[hidden] {
          display: none;
        }
        .permission-guide-title {
          margin: 0 0 6px;
          font-size: 13px;
          font-weight: 700;
          line-height: 1.3;
          color: #9a3412;
        }
        .permission-guide-text {
          margin: 0;
          font-size: 12px;
          line-height: 1.55;
          color: #7c2d12;
          word-break: break-word;
        }
        .creator-title {
          margin: 0 0 8px;
          font-size: 13px;
          font-weight: 700;
          color: #0f172a;
        }
        .form {
          display: grid;
          gap: 8px;
          margin-bottom: 12px;
        }
        .input {
          box-sizing: border-box;
          width: 100%;
          padding: 9px 11px;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          font-size: 13px;
          color: #0f172a;
          background: #fff;
          caret-color: auto;
        }
        .input:focus {
          outline: none;
          border-color: #14b8a6;
          box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.12);
        }
        .actions {
          display: flex;
          gap: 8px;
        }
        .button {
          flex: 1;
          border: none;
          border-radius: 10px;
          padding: 9px 11px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .button.primary {
          background: #0f766e;
          color: #fff;
        }
        .button.secondary {
          background: #e2e8f0;
          color: #0f172a;
        }
        .button:disabled {
          opacity: 0.56;
          cursor: not-allowed;
        }
        .list {
          display: grid;
          flex: 1 1 auto;
          min-height: 0;
          grid-template-columns: repeat(var(--panel-columns, 1), minmax(0, 1fr));
          gap: 8px;
          align-content: start;
        }
        .empty {
          padding: 10px 12px;
          border-radius: 10px;
          background: #f8fafc;
          color: #64748b;
          font-size: 12px;
        }
        .item {
          position: relative;
          padding: 10px 12px;
          border-radius: 12px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
        }
        .item.active {
          border-color: rgba(20, 184, 166, 0.55);
          background: #f0fdfa;
        }
        .item.unsaved {
          border-style: dashed;
        }
        .unsaved-badge {
          flex: 0 0 auto;
          margin-left: auto;
          padding: 3px 7px;
          border-radius: 999px;
          background: #fef3c7;
          color: #92400e;
          font-size: 11px;
          font-weight: 700;
        }
        .item-url {
          display: block;
          margin-bottom: 6px;
          font-size: 12px;
          line-height: 1.45;
          color: #0f172a;
          word-break: break-all;
          user-select: text;
          cursor: default;
          caret-color: transparent;
        }
        .number-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .number-label {
          flex: 0 0 auto;
          font-size: 12px;
          color: #334155;
          font-weight: 600;
        }
        .number-value {
          min-width: 0;
          flex: 1;
          font-size: 12px;
          color: #334155;
          word-break: break-all;
          user-select: text;
          cursor: default;
          caret-color: transparent;
        }
        .number-value.editable {
          display: inline-flex;
          align-items: center;
          flex: 0 1 auto;
          max-width: 100%;
          padding: 4px 8px;
          border-radius: 999px;
          background: #eff6ff;
          color: #1d4ed8;
          cursor: pointer;
        }
        .number-input {
          box-sizing: border-box;
          width: 96px;
          flex: 0 0 96px;
          padding: 6px 8px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          background: #fff;
          color: #0f172a;
          font-size: 12px;
          caret-color: auto;
        }
        .number-input:focus {
          outline: none;
          border-color: #14b8a6;
          box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.12);
        }
        .save-number {
          flex: 0 0 auto;
          border: none;
          background: #dbeafe;
          color: #1d4ed8;
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .save-number[hidden] {
          display: none;
        }
        .item-password {
          display: inline-flex;
          align-items: center;
          max-width: 100%;
          border: none;
          padding: 0;
          background: transparent;
          font-size: 12px;
          color: #64748b;
          cursor: pointer;
          word-break: break-all;
          user-select: text;
          caret-color: transparent;
        }
        .password-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 6px;
        }
        .password-input {
          box-sizing: border-box;
          min-width: 0;
          flex: 1;
          padding: 6px 8px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          background: #fff;
          color: #0f172a;
          font-size: 12px;
          caret-color: auto;
        }
        .password-input:focus {
          outline: none;
          border-color: #14b8a6;
          box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.12);
        }
        .save-password {
          flex: 0 0 auto;
          border: none;
          background: #ccfbf1;
          color: #0f766e;
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .save-password[hidden] {
          display: none;
        }
        .item-actions {
          margin-top: 8px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .jump {
          border: none;
          background: #e2e8f0;
          color: #0f172a;
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .jump {
          background: #eff6ff;
          color: #1d4ed8;
        }
        .open-tab {
          border: none;
          background: #ccfbf1;
          color: #0f766e;
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .delete {
          border: none;
          background: #fee2e2;
          color: #b91c1c;
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .panel-confirm-overlay {
          position: absolute;
          inset: 0;
          z-index: 6;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
          border-radius: inherit;
          background: rgba(248, 250, 252, 0.72);
          backdrop-filter: blur(6px);
        }
        .panel-confirm-overlay[hidden] {
          display: none;
        }
        .panel-confirm-card {
          box-sizing: border-box;
          width: min(100%, 320px);
          padding: 16px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.98);
          border: 1px solid rgba(148, 163, 184, 0.26);
          box-shadow: 0 18px 40px rgba(15, 23, 42, 0.2);
        }
        .panel-confirm-title {
          margin: 0;
          font-size: 14px;
          line-height: 1.35;
          font-weight: 700;
          color: #0f172a;
        }
        .panel-confirm-desc {
          margin: 8px 0 0;
          font-size: 12px;
          line-height: 1.5;
          color: #475569;
        }
        .panel-confirm-meta {
          margin: 8px 0 0;
          padding: 8px 10px;
          border-radius: 10px;
          background: #f8fafc;
          color: #0f172a;
          font-size: 12px;
          line-height: 1.45;
          word-break: break-all;
        }
        .panel-confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 14px;
        }
        .panel-confirm-button {
          border: none;
          border-radius: 10px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .panel-confirm-button.cancel {
          background: #e2e8f0;
          color: #0f172a;
        }
        .panel-confirm-button.danger {
          background: #dc2626;
          color: #fff;
        }
      </style>
      <div class="wrap side-right">
        <div class="control-row">
          <button class="toggle" type="button">VPS</button>
          <div class="inline-status" aria-live="polite">
            <span class="label"></span>
            <span class="detail"></span>
          </div>
          <span class="number-chip" hidden></span>
        </div>
        <div class="permission-guide permission-guide-floating js-permission-guide" hidden>
          <p class="permission-guide-title">需要先允许浏览器弹窗</p>
          <p class="permission-guide-text js-permission-guide-text"></p>
        </div>
        <div class="panel">
          <div class="panel-header">
            <div class="panel-copy">
              <h3 class="title">VPS 登录信息</h3>
              <p class="desc">脚本会按当前链接识别 VPS；手动登录一次后会自动记住密码。</p>
            </div>
            <button class="panel-action js-add-mapping" type="button">新增 VPS</button>
          </div>
          <div class="creator-card js-manual-create" hidden>
            <p class="creator-title">手动新增 VPS</p>
            <div class="form">
              <input class="input js-manual-url" type="text" placeholder="链接 URL" />
              <input class="input js-manual-number" type="text" placeholder="编号（可选）" />
              <input class="input js-manual-password" type="text" placeholder="密码" />
              <div class="actions">
                <button class="button primary js-manual-save" type="button">保存新增</button>
                <button class="button secondary js-manual-cancel" type="button">取消</button>
              </div>
            </div>
          </div>
          <div class="list js-list"></div>
          <div class="panel-confirm-overlay js-delete-confirm-overlay" hidden>
            <div class="panel-confirm-card" role="dialog" aria-modal="true" aria-labelledby="tm-vps-delete-confirm-title">
              <h4 class="panel-confirm-title" id="tm-vps-delete-confirm-title">确认删除这条 VPS 信息？</h4>
              <p class="panel-confirm-desc">删除后将不会再自动填充这台 VPS 的登录信息。</p>
              <p class="panel-confirm-meta js-delete-confirm-meta"></p>
              <div class="panel-confirm-actions">
                <button class="panel-confirm-button cancel js-delete-confirm-cancel" type="button">取消</button>
                <button class="panel-confirm-button danger js-delete-confirm-submit" type="button">确认删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const toggle = shadowRoot.querySelector('.toggle');
    const panel = shadowRoot.querySelector('.panel');
    const wrap = shadowRoot.querySelector('.wrap');
    const controlRow = shadowRoot.querySelector('.control-row');
    const numberChip = shadowRoot.querySelector('.number-chip');
    const addMappingButton = shadowRoot.querySelector('.js-add-mapping');
    const manualCreator = shadowRoot.querySelector('.js-manual-create');
    const manualUrlInput = shadowRoot.querySelector('.js-manual-url');
    const manualNumberInput = shadowRoot.querySelector('.js-manual-number');
    const manualPasswordInput = shadowRoot.querySelector('.js-manual-password');
    const manualSaveButton = shadowRoot.querySelector('.js-manual-save');
    const manualCancelButton = shadowRoot.querySelector('.js-manual-cancel');
    const permissionGuide = shadowRoot.querySelector('.js-permission-guide');
    const list = shadowRoot.querySelector('.js-list');
    const deleteConfirmOverlay = shadowRoot.querySelector('.js-delete-confirm-overlay');
    const deleteConfirmMeta = shadowRoot.querySelector('.js-delete-confirm-meta');
    const deleteConfirmCancelButton = shadowRoot.querySelector('.js-delete-confirm-cancel');
    const deleteConfirmSubmitButton = shadowRoot.querySelector('.js-delete-confirm-submit');
    let dragState = null;
    let suppressNextToggleClick = false;
    let pendingDeleteId = '';

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function getSavedPanelPosition() {
      const position = storage.get(PANEL_POSITION_KEY, null);
      if (!position || typeof position !== 'object') {
        return null;
      }

      return {
        side: position.side === 'left' ? 'left' : 'right',
        horizontal: Number(position.horizontal),
        top: Number.isFinite(Number(position.top))
          ? Number(position.top)
          : window.innerHeight - Number(position.bottom || 20) - 52,
      };
    }

    function setPanelSide(side) {
      const nextSide = side === 'left' ? 'left' : 'right';
      host.dataset.side = nextSide;
      if (wrap instanceof HTMLElement) {
        wrap.classList.toggle('side-left', nextSide === 'left');
        wrap.classList.toggle('side-right', nextSide === 'right');
      }
    }

    function getAnchorTopBounds() {
      const minTop = PANEL_EDGE_MARGIN;
      const maxTop = Math.max(minTop, window.innerHeight - 52 - PANEL_EDGE_MARGIN);

      return { minTop, maxTop };
    }

    function getAnchorWidth() {
      const rect = wrap instanceof HTMLElement ? wrap.getBoundingClientRect() : null;
      return rect?.width || 52;
    }

    function applyPanelPosition(position = getSavedPanelPosition()) {
      const side = position?.side === 'left' ? 'left' : 'right';
      const anchorWidth = getAnchorWidth();
      const { minTop, maxTop } = getAnchorTopBounds();
      const top = Number.isFinite(position?.top)
        ? clamp(position.top, minTop, maxTop)
        : maxTop;
      const left = side === 'left'
        ? PANEL_EDGE_MARGIN
        : Math.max(PANEL_EDGE_MARGIN, window.innerWidth - anchorWidth - PANEL_EDGE_MARGIN);

      setPanelSide(side);
      host.style.left = `${Math.round(left)}px`;
      host.style.top = `${Math.round(top)}px`;
      host.style.right = '';
      host.style.bottom = '';

      syncPopupPermissionBadgePlacement();
    }

    function savePanelPositionFromRect() {
      const rect = host.getBoundingClientRect();
      const side = (rect.left + rect.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
      const { minTop, maxTop } = getAnchorTopBounds();
      const position = {
        side,
        top: clamp(rect.top, minTop, maxTop),
      };

      storage.set(PANEL_POSITION_KEY, position);
      applyPanelPosition(position);
    }

    function canStartPanelDrag(target) {
      if (!(target instanceof Element)) {
        return false;
      }

      if (target.closest('input, textarea, select, button:not(.toggle), [data-action], .item-url, .number-value, .item-password, .panel-confirm-overlay, .panel-confirm-card')) {
        return false;
      }

      return true;
    }

    function resetPanelLayout() {
      if (wrap instanceof HTMLElement) {
        wrap.style.removeProperty('--panel-width');
        wrap.style.removeProperty('--panel-columns');
      }
      if (panel instanceof HTMLElement) {
        panel.style.height = '';
        panel.style.overflowX = '';
        panel.style.overflowY = '';
        panel.style.removeProperty('--panel-max-height');
        panel.style.removeProperty('--panel-offset-extra');
        panel.classList.remove('above', 'below');
      }
    }

    function updatePanelLayout() {
      if (!(wrap instanceof HTMLElement) ||
        !(panel instanceof HTMLElement) ||
        !(controlRow instanceof HTMLElement) ||
        !panel.classList.contains('open')) {
        resetPanelLayout();
        syncPermissionGuidePlacement();
        return;
      }

      const maxPanelWidth = Math.max(260, window.innerWidth - PANEL_EDGE_MARGIN * 2);
      const baseWidth = Math.min(PANEL_BASE_WIDTH, maxPanelWidth);
      wrap.style.setProperty('--panel-width', `${baseWidth}px`);
      wrap.style.setProperty('--panel-columns', '1');
      panel.style.height = '';
      panel.style.overflowX = 'hidden';
      panel.style.overflowY = 'visible';
      panel.style.setProperty('--panel-max-height', `${window.innerHeight}px`);

      const controlRect = controlRow.getBoundingClientRect();
      const guideVisible = permissionGuide instanceof HTMLElement && !permissionGuide.hidden;
      const guideHeight = guideVisible
        ? Math.ceil(permissionGuide.getBoundingClientRect().height || permissionGuide.offsetHeight || 0)
        : 0;
      const panelOffsetExtra = guideVisible ? guideHeight + PANEL_GAP : 0;
      const spaceBelow = Math.max(120, window.innerHeight - controlRect.bottom - PANEL_GAP - PANEL_EDGE_MARGIN - panelOffsetExtra);
      const spaceAbove = Math.max(120, controlRect.top - PANEL_GAP - PANEL_EDGE_MARGIN);
      const naturalHeight = panel.scrollHeight;
      const placeBelow = spaceBelow >= Math.min(naturalHeight, 320) || spaceBelow >= spaceAbove;
      const availableHeight = Math.floor(placeBelow ? spaceBelow : spaceAbove);
      const listHeight = list instanceof HTMLElement ? list.scrollHeight : naturalHeight;
      const fixedHeight = Math.max(0, naturalHeight - listHeight);
      const availableListHeight = Math.max(80, availableHeight - fixedHeight);
      const needsConstraint = naturalHeight > availableHeight;
      const maxColumns = Math.max(1, Math.floor((maxPanelWidth + 8) / (baseWidth + 8)));
      const wantedColumns = needsConstraint ? Math.max(1, Math.ceil(listHeight / availableListHeight)) : 1;
      const columns = Math.min(wantedColumns, maxColumns);
      const nextWidth = Math.min(maxPanelWidth, (baseWidth * columns) + (8 * (columns - 1)));

      wrap.style.setProperty('--panel-width', `${Math.round(nextWidth)}px`);
      wrap.style.setProperty('--panel-columns', String(columns));
      if (placeBelow && panelOffsetExtra > 0) {
        panel.style.setProperty('--panel-offset-extra', `${panelOffsetExtra}px`);
      } else {
        panel.style.removeProperty('--panel-offset-extra');
      }
      const adjustedNaturalHeight = panel.scrollHeight;
      const adjustedNeedsConstraint = adjustedNaturalHeight > availableHeight;
      panel.style.setProperty('--panel-max-height', `${availableHeight}px`);
      panel.style.height = adjustedNeedsConstraint ? `${availableHeight}px` : '';
      panel.style.overflowX = 'hidden';
      panel.style.overflowY = adjustedNeedsConstraint ? 'auto' : 'visible';
      panel.classList.toggle('below', placeBelow);
      panel.classList.toggle('above', !placeBelow);

      applyPanelPosition({
        side: host.dataset.side === 'left' ? 'left' : 'right',
        top: host.getBoundingClientRect().top,
      });
      syncPermissionGuidePlacement();
    }

    function maskPassword(password) {
      if (!password) {
        return '';
      }
      if (password.length <= 2) {
        return '*'.repeat(password.length);
      }
      return `${password[0]}${'*'.repeat(password.length - 2)}${password[password.length - 1]}`;
    }

    function getCurrentPanelUrl() {
      return normalizeUrl(location.href);
    }

    function isTemporaryMappingId(id) {
      return id === TEMP_MAPPING_ID;
    }

    function getTemporaryMapping() {
      return {
        id: TEMP_MAPPING_ID,
        number: String(numberDrafts.get(TEMP_MAPPING_ID) || ''),
        url: getCurrentPanelUrl(),
        password: '',
        unsaved: true,
      };
    }

    function getPanelItemById(id) {
      if (isTemporaryMappingId(id)) {
        return getTemporaryMapping();
      }

      return readMappings().find((item) => item.id === id) || null;
    }

    function prepareManualJump(url) {
      const targetUrl = normalizeUrl(url);
      clearOpenedRemoteTabMark();
      clearPendingClose();
      stopCloseCurrentTabRetry();
      clearRecentAction(`remote:${targetUrl}`);
      clearRecentAction(`close:${targetUrl}`);
      return targetUrl;
    }

    function isPanelOpen() {
      return panel instanceof HTMLElement && panel.classList.contains('open');
    }

    function getCurrentControlNumber(matched) {
      if (matched?.number) {
        return matched.number;
      }

      if (!matched && numberDrafts.has(TEMP_MAPPING_ID)) {
        return String(numberDrafts.get(TEMP_MAPPING_ID) || '').trim();
      }

      return '';
    }

    function resetManualCreatorDraft() {
      manualDraft.url = '';
      manualDraft.number = '';
      manualDraft.password = '';
    }

    function syncManualCreatorButtonState() {
      if (manualSaveButton instanceof HTMLButtonElement) {
        manualSaveButton.disabled = !manualDraft.url.trim() || !manualDraft.password.trim();
      }
    }

    function renderManualCreator() {
      if (addMappingButton instanceof HTMLButtonElement) {
        addMappingButton.hidden = manualCreatorOpen;
      }

      if (manualCreator instanceof HTMLElement) {
        manualCreator.hidden = !manualCreatorOpen;
      }

      if (manualUrlInput instanceof HTMLInputElement && manualUrlInput.value !== manualDraft.url) {
        manualUrlInput.value = manualDraft.url;
      }
      if (manualNumberInput instanceof HTMLInputElement && manualNumberInput.value !== manualDraft.number) {
        manualNumberInput.value = manualDraft.number;
      }
      if (manualPasswordInput instanceof HTMLInputElement && manualPasswordInput.value !== manualDraft.password) {
        manualPasswordInput.value = manualDraft.password;
      }

      syncManualCreatorButtonState();
    }

    function syncPermissionGuidePlacement() {
      if (!(permissionGuide instanceof HTMLElement) ||
        permissionGuide.hidden ||
        !(controlRow instanceof HTMLElement) ||
        !(wrap instanceof HTMLElement)) {
        return;
      }

      permissionGuide.classList.remove('guide-above', 'guide-below');
      permissionGuide.classList.add('guide-below');

      const wrapRect = wrap.getBoundingClientRect();
      const controlRect = controlRow.getBoundingClientRect();
      const side = host.dataset.side === 'left' ? 'left' : 'right';

      permissionGuide.style.left = '';
      permissionGuide.style.right = '';
      if (side === 'left') {
        permissionGuide.style.left = `${Math.max(0, Math.round(controlRect.left - wrapRect.left))}px`;
      } else {
        permissionGuide.style.right = `${Math.max(0, Math.round(wrapRect.right - controlRect.right))}px`;
      }
    }

    function deleteMapping(id) {
      const next = readMappings().filter((item) => item.id !== id);
      writeMappings(next);
      numberDrafts.delete(id);
      editingNumberIds.delete(id);
      passwordDrafts.delete(id);
      editingPasswordIds.delete(id);
      mappings = next;
      renderList();
    }

    function renderDeleteConfirm() {
      const current = pendingDeleteId ? getPanelItemById(pendingDeleteId) : null;
      const isOpen = Boolean(current && !isTemporaryMappingId(current.id));

      if (!isOpen) {
        pendingDeleteId = '';
      }

      if (deleteConfirmOverlay instanceof HTMLElement) {
        deleteConfirmOverlay.hidden = !isOpen;
      }

      if (deleteConfirmMeta instanceof HTMLElement) {
        if (!isOpen || !current) {
          deleteConfirmMeta.textContent = '';
        } else if (current.number) {
          deleteConfirmMeta.textContent = `编号：${current.number} · ${current.url}`;
        } else {
          deleteConfirmMeta.textContent = current.url;
        }
      }
    }

    function closeDeleteConfirm() {
      if (!pendingDeleteId && deleteConfirmOverlay instanceof HTMLElement && deleteConfirmOverlay.hidden) {
        return;
      }

      pendingDeleteId = '';
      renderDeleteConfirm();
    }

    function openDeleteConfirm(id) {
      const current = getPanelItemById(id);
      if (!current || isTemporaryMappingId(id)) {
        return;
      }

      pendingDeleteId = id;
      renderDeleteConfirm();
      window.setTimeout(() => {
        if (deleteConfirmSubmitButton instanceof HTMLButtonElement) {
          deleteConfirmSubmitButton.focus();
        }
      }, 0);
    }

    function confirmDelete() {
      const id = pendingDeleteId;
      if (!id) {
        return;
      }

      closeDeleteConfirm();
      deleteMapping(id);
    }

    function focusManualCreatorUrl() {
      window.setTimeout(() => {
        if (manualUrlInput instanceof HTMLInputElement) {
          manualUrlInput.focus();
          manualUrlInput.select();
        }
      }, 0);
    }

    function openManualCreator() {
      manualCreatorOpen = true;
      renderManualCreator();
      window.setTimeout(updatePanelLayout, 0);
      focusManualCreatorUrl();
    }

    function closeManualCreator(shouldReset = true) {
      manualCreatorOpen = false;
      if (shouldReset) {
        resetManualCreatorDraft();
      }
      renderManualCreator();
      window.setTimeout(updatePanelLayout, 0);
    }

    function saveManualCreator() {
      const nextUrl = normalizeUrl(manualDraft.url);
      const nextPassword = manualDraft.password.trim();
      if (!nextUrl || !nextPassword) {
        syncManualCreatorButtonState();
        return;
      }

      const previous = readMappings().find((item) => normalizeUrl(item.url) === nextUrl);
      const next = readMappings().filter((item) => normalizeUrl(item.url) !== nextUrl);
      next.unshift({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        number: manualDraft.number.trim() || previous?.number || '',
        url: nextUrl,
        password: nextPassword,
      });
      writeMappings(next);
      mappings = next;
      closeManualCreator(true);
      renderList();
      tryAutoLogin(mappings);
    }

    function updateControlDisplay(number = '') {
      const trimmedNumber = String(number || '').trim();
      if (toggle instanceof HTMLButtonElement) {
        toggle.textContent = isPanelOpen() ? '×' : (trimmedNumber || 'VPS');
      }

      if (numberChip instanceof HTMLElement) {
        numberChip.textContent = trimmedNumber;
        numberChip.hidden = !isPanelOpen() || !trimmedNumber;
        numberChip.title = trimmedNumber;
      }
    }

    function getSavedItemMarkup(item, matched) {
      const passwordEditing = editingPasswordIds.has(item.id);
      const passwordDraft = passwordDrafts.has(item.id) ? passwordDrafts.get(item.id) : item.password;
      const passwordChanged = passwordDraft.trim() !== item.password;
      const passwordText = maskPassword(item.password);
      const savedNumber = item.number || '';
      const numberEditing = editingNumberIds.has(item.id);
      const draftNumber = numberDrafts.has(item.id) ? numberDrafts.get(item.id) : savedNumber;
      const numberChanged = draftNumber.trim() !== savedNumber;
      const numberActionText = savedNumber ? '更新' : '添加';

      return `
          <div class="item ${matched ? 'active' : ''}" data-id="${escapeHtml(item.id)}">
            <div class="number-row">
              ${numberEditing ? `
                <span class="number-label">编号</span>
                <input class="number-input" type="text" value="${escapeHtml(draftNumber)}" placeholder="未设置" data-id="${escapeHtml(item.id)}" />
                <button class="save-number" type="button" data-action="save-number" data-id="${escapeHtml(item.id)}" ${numberChanged ? '' : 'hidden'}>${numberActionText}</button>
              ` : `
                <span class="number-label">编号：</span>
                <span class="number-value editable" data-action="edit-number" data-id="${escapeHtml(item.id)}" title="点击编辑编号">${escapeHtml(savedNumber || '未设置')}</span>
              `}
            </div>
            <span class="item-url">${escapeHtml(item.url)}</span>
            ${passwordEditing ? `
              <div class="password-row">
                <span class="number-label">密码</span>
                <input class="password-input" type="text" value="${escapeHtml(passwordDraft)}" placeholder="输入密码" data-id="${escapeHtml(item.id)}" />
                <button class="save-password" type="button" data-action="save-password" data-id="${escapeHtml(item.id)}" ${passwordChanged ? '' : 'hidden'}>更新</button>
              </div>
            ` : `
              <button class="item-password" type="button" data-action="edit-password" data-id="${escapeHtml(item.id)}" title="点击编辑密码">
                密码：${escapeHtml(passwordText)}
              </button>
            `}
            <div class="item-actions">
              ${matched ? '' : `<button class="jump" type="button" data-action="jump" data-id="${escapeHtml(item.id)}">跳转</button>`}
              ${matched ? '' : `<button class="open-tab" type="button" data-action="open-tab" data-id="${escapeHtml(item.id)}">在新Tab打开</button>`}
              <button class="delete" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button>
            </div>
          </div>
        `;
    }

    function createListItemElement(markup) {
      const template = document.createElement('template');
      template.innerHTML = markup.trim();
      return template.content.firstElementChild;
    }

    function refreshSavedItems(nextMappings = readMappings()) {
      const previousMatched = findMappingForCurrentPage(mappings);
      const nextMatched = findMappingForCurrentPage(nextMappings);
      if (Boolean(previousMatched) !== Boolean(nextMatched) ||
        previousMatched?.id !== nextMatched?.id) {
        mappings = nextMappings;
        renderList();
        return;
      }

      mappings = nextMappings;
      syncDocumentTitle(nextMappings);
      updateControlDisplay(getCurrentControlNumber(nextMatched));
      renderManualCreator();
      renderDeleteConfirm();

      if (!list || !isPanelOpen()) {
        return;
      }

      const temporaryItem = list.querySelector('.item.unsaved');
      const nextSavedItems = nextMatched
        ? [nextMatched, ...nextMappings.filter((item) => item.id !== nextMatched.id)]
        : nextMappings.slice();
      const nextSavedIds = new Set(nextSavedItems.map((item) => item.id));

      list.querySelectorAll('.empty').forEach((element) => element.remove());
      list.querySelectorAll('.item:not(.unsaved)').forEach((element) => {
        const id = element instanceof HTMLElement ? element.dataset.id : '';
        if (id && !nextSavedIds.has(id)) {
          element.remove();
        }
      });

      const existingSavedItems = new Map(
        [...list.querySelectorAll('.item:not(.unsaved)')]
          .filter((element) => element instanceof HTMLElement)
          .map((element) => [element.dataset.id || '', element]),
      );

      let previousNode = temporaryItem instanceof HTMLElement ? temporaryItem : null;
      nextSavedItems.forEach((item) => {
        const matched = Boolean(nextMatched && nextMatched.id === item.id);
        const existing = existingSavedItems.get(item.id);
        const shouldPreserveEditing = editingNumberIds.has(item.id) || editingPasswordIds.has(item.id);
        let targetNode = existing;

        if (!targetNode) {
          targetNode = createListItemElement(getSavedItemMarkup(item, matched));
        } else if (!shouldPreserveEditing) {
          const nextMarkup = getSavedItemMarkup(item, matched).trim();
          if (targetNode.outerHTML !== nextMarkup) {
            const replacement = createListItemElement(nextMarkup);
            targetNode.replaceWith(replacement);
            targetNode = replacement;
          }
        }

        if (!(targetNode instanceof HTMLElement)) {
          return;
        }

        const referenceNode = previousNode ? previousNode.nextSibling : list.firstChild;
        if (targetNode !== referenceNode) {
          list.insertBefore(targetNode, referenceNode);
        }
        previousNode = targetNode;
      });

      if (!temporaryItem && nextSavedItems.length === 0) {
        list.innerHTML = '<div class="empty">还没有保存任何 VPS 信息。</div>';
      }

      window.setTimeout(updatePanelLayout, 0);
    }

    function renderList() {
      mappings = readMappings();
      const matched = findMappingForCurrentPage(mappings);
      const temporaryMapping = matched ? null : getTemporaryMapping();
      const sortedMappings = matched
        ? [matched, ...mappings.filter((item) => item.id !== matched.id)]
        : [temporaryMapping, ...mappings];

      syncDocumentTitle(mappings);
      updateControlDisplay(getCurrentControlNumber(matched));
      renderManualCreator();
      renderDeleteConfirm();

      if (!list) {
        return;
      }

      if (sortedMappings.length === 0) {
        list.innerHTML = '<div class="empty">还没有保存任何 VPS 信息。</div>';
        return;
      }

      list.innerHTML = sortedMappings
        .map((item) => {
          const unsavedItem = Boolean(item.unsaved);
          const matchedItem = Boolean((matched && matched.id === item.id) || unsavedItem);

          if (!unsavedItem) {
            return getSavedItemMarkup(item, matchedItem);
          }

          const passwordDraft = passwordDrafts.has(item.id) ? passwordDrafts.get(item.id) : item.password;
          const passwordChanged = passwordDraft.trim() !== '';
          const savedNumber = item.number || '';
          const numberEditing = editingNumberIds.has(item.id);
          const draftNumber = numberDrafts.has(item.id) ? numberDrafts.get(item.id) : savedNumber;
          const numberChanged = draftNumber.trim() !== savedNumber;
          return `
          <div class="item ${matchedItem ? 'active' : ''} ${unsavedItem ? 'unsaved' : ''}" data-id="${escapeHtml(item.id)}">
            <div class="number-row">
              ${numberEditing ? `
                <span class="number-label">编号</span>
                <input class="number-input" type="text" value="${escapeHtml(draftNumber)}" placeholder="未设置" data-id="${escapeHtml(item.id)}" />
                <button class="save-number" type="button" data-action="save-number" data-id="${escapeHtml(item.id)}" ${numberChanged ? '' : 'hidden'}>添加</button>
                ${unsavedItem ? '<span class="unsaved-badge">未保存</span>' : ''}
              ` : `
                <span class="number-label">编号：</span>
                <span class="number-value editable" data-action="edit-number" data-id="${escapeHtml(item.id)}" title="点击编辑编号">${escapeHtml(savedNumber || '未设置')}</span>
                ${unsavedItem ? '<span class="unsaved-badge">未保存</span>' : ''}
              `}
            </div>
            <span class="item-url">${escapeHtml(item.url)}</span>
            <div class="password-row">
              <span class="number-label">密码</span>
              <input class="password-input" type="text" value="${escapeHtml(passwordDraft)}" placeholder="输入密码" data-id="${escapeHtml(item.id)}" />
              <button class="save-password" type="button" data-action="save-password" data-id="${escapeHtml(item.id)}" ${passwordChanged ? '' : 'hidden'}>保存</button>
            </div>
            <div class="item-actions">
              ${matchedItem ? '' : `<button class="jump" type="button" data-action="jump" data-id="${escapeHtml(item.id)}">跳转</button>`}
              ${matchedItem ? '' : `<button class="open-tab" type="button" data-action="open-tab" data-id="${escapeHtml(item.id)}">在新Tab打开</button>`}
              ${unsavedItem ? '' : `<button class="delete" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button>`}
            </div>
          </div>
        `;
        })
        .join('');

      window.setTimeout(updatePanelLayout, 0);
    }

    function focusNumberInput(id) {
      window.setTimeout(() => {
        const input = [...shadowRoot.querySelectorAll('.number-input')]
          .find((element) => element instanceof HTMLInputElement && element.dataset.id === id);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      }, 0);
    }

    function focusPasswordInput(id) {
      window.setTimeout(() => {
        const input = [...shadowRoot.querySelectorAll('.password-input')]
          .find((element) => element instanceof HTMLInputElement && element.dataset.id === id);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      }, 0);
    }

    function saveNumber(id, sourceElement) {
      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      const itemElement = sourceElement?.closest('.item');
      const numberInput = itemElement?.querySelector('.number-input');
      const nextNumber = numberInput instanceof HTMLInputElement
        ? numberInput.value.trim()
        : String(numberDrafts.get(id) || '').trim();

      if (isTemporaryMappingId(id)) {
        numberDrafts.set(id, nextNumber);
        editingNumberIds.delete(id);
        renderList();
        return;
      }

      const next = readMappings().map((item) => (
        item.id === id ? { ...item, number: nextNumber } : item
      ));
      writeMappings(next);
      numberDrafts.delete(id);
      editingNumberIds.delete(id);
      mappings = next;
      renderList();
    }

    function savePassword(id, sourceElement) {
      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      const itemElement = sourceElement?.closest('.item');
      const passwordInput = itemElement?.querySelector('.password-input');
      const nextPassword = passwordInput instanceof HTMLInputElement
        ? passwordInput.value.trim()
        : String(passwordDrafts.get(id) || '').trim();

      if (!nextPassword) {
        return;
      }

      if (isTemporaryMappingId(id)) {
        const currentUrl = normalizeUrl(current.url);
        const next = readMappings().filter((item) => normalizeUrl(item.url) !== currentUrl);
        next.unshift({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          number: String(numberDrafts.get(id) || '').trim(),
          url: currentUrl,
          password: nextPassword,
        });
        writeMappings(next);
        numberDrafts.delete(id);
        editingNumberIds.delete(id);
        passwordDrafts.delete(id);
        editingPasswordIds.delete(id);
        mappings = next;
        renderList();
        tryAutoLogin(mappings);
        return;
      }

      const next = readMappings().map((item) => (
        item.id === id ? { ...item, password: nextPassword } : item
      ));
      writeMappings(next);
      passwordDrafts.delete(id);
      editingPasswordIds.delete(id);
      mappings = next;
      renderList();
      tryAutoLogin(mappings);
    }

    function movePanelDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 4) {
        return;
      }

      dragState.moved = true;
      const rect = host.getBoundingClientRect();
      const { minTop, maxTop } = getAnchorTopBounds();
      const maxLeft = Math.max(PANEL_EDGE_MARGIN, window.innerWidth - rect.width - PANEL_EDGE_MARGIN);
      const nextLeft = clamp(dragState.startLeft + dx, PANEL_EDGE_MARGIN, maxLeft);
      const nextTop = clamp(dragState.startTop + dy, minTop, maxTop);
      const nextSide = event.clientX < window.innerWidth / 2 ? 'left' : 'right';

      setPanelSide(nextSide);
      host.style.left = `${Math.round(nextLeft)}px`;
      host.style.top = `${Math.round(nextTop)}px`;
      host.style.right = '';
      host.style.bottom = '';
      syncPopupPermissionBadgePlacement();
      syncPermissionGuidePlacement();
      event.preventDefault();
    }

    function endPanelDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const moved = dragState.moved;
      dragState = null;
      if (wrap instanceof HTMLElement) {
        wrap.classList.remove('dragging');
      }

      document.removeEventListener('pointermove', movePanelDrag);
      document.removeEventListener('pointerup', endPanelDrag);
      document.removeEventListener('pointercancel', endPanelDrag);
      host.style.transition = 'left 180ms ease, top 180ms ease';

      if (moved) {
        suppressNextToggleClick = true;
        savePanelPositionFromRect();
        syncPermissionGuidePlacement();
        window.setTimeout(updatePanelLayout, 190);
        window.setTimeout(() => {
          suppressNextToggleClick = false;
        }, 0);
      }
    }

    function startPanelDrag(event, shouldCheckTarget = true) {
      if (event.button !== 0 ||
        typeof event.pointerId !== 'number' ||
        (shouldCheckTarget && !canStartPanelDrag(event.target))) {
        return;
      }

      const rect = host.getBoundingClientRect();
      host.style.transition = 'none';
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false,
      };

      if (wrap instanceof HTMLElement) {
        wrap.classList.add('dragging');
      }

      document.addEventListener('pointermove', movePanelDrag);
      document.addEventListener('pointerup', endPanelDrag);
      document.addEventListener('pointercancel', endPanelDrag);
    }

    wrap?.addEventListener('pointerdown', (event) => {
      markInternalUiInteraction();
      startPanelDrag(event, true);
    });

    const popupBadgeHost = document.getElementById(PERMISSION_BADGE_ID);
    popupBadgeHost?.addEventListener('pointerdown', (event) => {
      markInternalUiInteraction();
      startPanelDrag(event, false);
    });

    addMappingButton?.addEventListener('click', () => {
      if (!manualCreatorOpen) {
        openManualCreator();
      }
    });

    manualCancelButton?.addEventListener('click', () => {
      closeManualCreator(true);
    });

    manualSaveButton?.addEventListener('click', () => {
      saveManualCreator();
    });

    deleteConfirmCancelButton?.addEventListener('click', () => {
      closeDeleteConfirm();
    });

    deleteConfirmSubmitButton?.addEventListener('click', () => {
      confirmDelete();
    });

    deleteConfirmOverlay?.addEventListener('click', (event) => {
      if (event.target === deleteConfirmOverlay) {
        closeDeleteConfirm();
      }
    });

    [manualUrlInput, manualNumberInput, manualPasswordInput].forEach((input) => {
      input?.addEventListener('input', () => {
        manualDraft.url = manualUrlInput instanceof HTMLInputElement ? manualUrlInput.value : '';
        manualDraft.number = manualNumberInput instanceof HTMLInputElement ? manualNumberInput.value : '';
        manualDraft.password = manualPasswordInput instanceof HTMLInputElement ? manualPasswordInput.value : '';
        syncManualCreatorButtonState();
      });

      input?.addEventListener('keydown', (event) => {
        if (!(event instanceof KeyboardEvent)) {
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          closeManualCreator(true);
          return;
        }

        if (event.key !== 'Enter') {
          return;
        }

        event.preventDefault();
        saveManualCreator();
      });
    });

    toggle?.addEventListener('click', () => {
      if (suppressNextToggleClick) {
        suppressNextToggleClick = false;
        return;
      }

      panel?.classList.toggle('open');
      wrap?.classList.toggle('open', panel?.classList.contains('open'));
      if (panel?.classList.contains('open')) {
        renderList();
        updatePanelLayout();
      } else {
        closeDeleteConfirm();
        updateControlDisplay(getCurrentControlNumber(findMappingForCurrentPage(readMappings())));
        resetPanelLayout();
        applyPanelPosition();
        syncPermissionGuidePlacement();
      }
      renderPopupPermissionBadge();
      window.setTimeout(syncPopupPermissionBadgePlacement, 0);
    });

    list?.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) ||
        (!target.classList.contains('number-input') && !target.classList.contains('password-input'))) {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      if (target.classList.contains('password-input')) {
        const savedPassword = current.password || '';
        const draftPassword = target.value;
        passwordDrafts.set(id, draftPassword);

        const item = target.closest('.item');
        const savePasswordButton = item?.querySelector('.save-password');
        if (savePasswordButton instanceof HTMLButtonElement) {
          savePasswordButton.hidden = isTemporaryMappingId(id)
            ? draftPassword.trim() === ''
            : draftPassword.trim() === savedPassword;
          savePasswordButton.textContent = isTemporaryMappingId(id) ? '保存' : '更新';
        }
        return;
      }

      const savedNumber = current.number || '';
      const draftNumber = target.value;
      numberDrafts.set(id, draftNumber);

      const item = target.closest('.item');
      const saveNumberButton = item?.querySelector('.save-number');
      if (saveNumberButton instanceof HTMLButtonElement) {
        saveNumberButton.hidden = draftNumber.trim() === savedNumber;
        saveNumberButton.textContent = savedNumber ? '更新' : '添加';
      }
    });

    list?.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) ||
        (!target.classList.contains('number-input') && !target.classList.contains('password-input'))) {
        return;
      }

      if (event.key !== 'Enter') {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      event.preventDefault();
      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      if (target.classList.contains('password-input')) {
        if (!isTemporaryMappingId(id) && target.value.trim() === (current.password || '')) {
          passwordDrafts.delete(id);
          editingPasswordIds.delete(id);
          renderList();
          return;
        }

        savePassword(id, target);
        return;
      }

      if (isTemporaryMappingId(id)) {
        saveNumber(id, target);
        return;
      }

      if (target.value.trim() === (current.number || '')) {
        numberDrafts.delete(id);
        editingNumberIds.delete(id);
        renderList();
        return;
      }

      saveNumber(id, target);
    });

    list?.addEventListener('focusout', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) ||
        (!target.classList.contains('number-input') && !target.classList.contains('password-input'))) {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      window.setTimeout(() => {
        const active = shadowRoot.activeElement;
        const saveAction = target.classList.contains('password-input') ? 'save-password' : 'save-number';
        if (active instanceof HTMLElement &&
          active.dataset.action === saveAction &&
          active.dataset.id === id) {
          return;
        }

        if (target.classList.contains('password-input')) {
          if (!isTemporaryMappingId(id)) {
            passwordDrafts.delete(id);
            editingPasswordIds.delete(id);
          }
        } else {
          if (isTemporaryMappingId(id)) {
            numberDrafts.set(id, target.value.trim());
          } else {
            numberDrafts.delete(id);
          }
          editingNumberIds.delete(id);
        }
        renderList();
      }, 0);
    });

    list?.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) ||
        (target.dataset.action !== 'save-number' && target.dataset.action !== 'save-password')) {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      event.preventDefault();
    });

    list?.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.dataset.action;
      if (!action) {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      if (action === 'edit-number') {
        const current = getPanelItemById(id);
        if (!current) {
          return;
        }

        editingNumberIds.add(id);
        numberDrafts.set(id, current.number || '');
        renderList();
        focusNumberInput(id);
        return;
      }

      if (action === 'edit-password') {
        const current = getPanelItemById(id);
        if (!current) {
          return;
        }

        editingPasswordIds.add(id);
        passwordDrafts.set(id, current.password || '');
        renderList();
        focusPasswordInput(id);
        return;
      }

      if (action === 'save-number') {
        saveNumber(id, target);
        return;
      }

      if (action === 'save-password') {
        savePassword(id, target);
        return;
      }

      if (action === 'jump') {
        const current = getPanelItemById(id);
        if (current?.url) {
          const targetUrl = prepareManualJump(current.url);
          if (normalizeUrl(location.href) === targetUrl) {
            window.setTimeout(() => tryAutoLogin(readMappings()), 0);
          } else {
            location.href = targetUrl;
          }
        }
        return;
      }

      if (action === 'open-tab') {
        const current = getPanelItemById(id);
        if (current?.url) {
          window.open(normalizeUrl(current.url), '_blank', 'noopener');
        }
        return;
      }

      if (action !== 'delete') {
        return;
      }

      openDeleteConfirm(id);
    });

    renderList();
    document.documentElement.appendChild(host);
    host.__syncPermissionGuidePlacement = syncPermissionGuidePlacement;
    host.__refreshMappings = refreshSavedItems;
    renderPopupPermissionBadge();
    applyPanelPosition();
    window.addEventListener('resize', () => {
      updatePanelLayout();
      applyPanelPosition();
      syncPermissionGuidePlacement();
      window.setTimeout(syncPopupPermissionBadgePlacement, 0);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function boot() {
    const run = () => {
      const mappings = readMappings();
      bindMappingsSync();
      if (isVpsHost()) {
        createPopupPermissionBadge();
        createPanel();
        startStatusLabelPolling();
        tryAutoLogin(mappings);
      }
      syncExternalSavedLinkButtons(mappings);
    };

    run();

    const observer = new MutationObserver(() => {
      const mappings = readMappings();
      if (isVpsHost()) {
        tryAutoLogin(mappings);
      }
      syncExternalSavedLinkButtons(mappings);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
