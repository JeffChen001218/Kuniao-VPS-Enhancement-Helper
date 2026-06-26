'use strict';

(() => {
  const VPS_HOSTS = ['home.kuniaovps.com', 'home.geliyun.com'];
  const EXTERNAL_LINK_HOSTS = ['ntba.gte666.com'];
  const SUPPORTED_HOSTS = [...VPS_HOSTS, ...EXTERNAL_LINK_HOSTS];
  const STORAGE_KEY = 'vps-auto-login-mappings';
  const BACKGROUND_TARGET = 'kuniao-vps-background';
  const CONTENT_TARGET = 'kuniao-vps-content';
  const PANEL_ID = 'tm-vps-auto-login-root';
  const EXTERNAL_JUMP_BUTTON_CLASS = 'tm-vps-saved-link-jump';
  const RENDER_LABEL_CLASS = 'render-label';
  const AVATAR_CLASS = 'n-avatar';
  const PROJECT_NUMBER_PATTERN = /\d{3}[A-Z]/;
  const SUBMIT_GUARD_MS = 60000;
  const REMOTE_CLICK_GUARD_MS = 15000;
  const REMOTE_CLICK_DELAY_MS = 500;
  const REMOTE_SOURCE_CLOSE_DELAY_MS = 800;
  const attemptCache = new Map();
  const observedPasswordInputs = new WeakSet();
  let mappingsCache = [];
  let originalDocumentTitle = document.title;
  let appliedMappingTitle = '';
  let remoteClickTimer = 0;
  let refreshTimer = 0;

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

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({
            ok: false,
            error: error.message,
          });
          return;
        }

        resolve(response || {
          ok: true,
        });
      });
    });
  }

  function storageGet(defaults) {
    return new Promise((resolve) => {
      chrome.storage.local.get(defaults, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn('[VPS Extension] chrome.storage.local.get failed.', error);
          resolve(defaults);
          return;
        }

        resolve(result || defaults);
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn('[VPS Extension] chrome.storage.local.set failed.', error);
        }
        resolve(!error);
      });
    });
  }

  function isRemoteTimestampParam(key) {
    return /remote\s*timestamp/i.test(String(key || '').replace(/[_-]/g, ''));
  }

  function isIpAddressParam(key) {
    return /^ipaddress$/i.test(String(key || '').replace(/[_-]/g, ''));
  }

  function getSearchParamEntry(url, matcher) {
    const key = Array.from(url.searchParams.keys()).find((candidate) => matcher(candidate));
    return {
      key: key || '',
      value: key ? String(url.searchParams.get(key) || '') : '',
    };
  }

  function buildNormalizedUrl(input, { preserveConnectionParams = false } = {}) {
    const raw = String(input || '').trim();
    if (!raw) {
      return '';
    }

    try {
      const url = new URL(raw, location.origin);
      const typeEntry = getSearchParamEntry(url, (key) => String(key || '').toLowerCase() === 'type');
      const keyEntry = getSearchParamEntry(url, (key) => String(key || '').toLowerCase() === 'key');
      const ipAddressEntry = getSearchParamEntry(url, isIpAddressParam);
      const remoteTimestampEntry = getSearchParamEntry(url, isRemoteTimestampParam);

      if (isVpsHost(url.host)) {
        url.protocol = 'https:';
      }

      url.pathname = url.pathname.replace(/\/{2,}/g, '/');
      if (url.pathname.length > 1) {
        url.pathname = url.pathname.replace(/\/+$/, '');
      }

      url.hash = '';
      url.search = '';
      if (typeEntry.key) {
        url.searchParams.set(typeEntry.key, typeEntry.value);
      }
      if (keyEntry.key) {
        url.searchParams.set(keyEntry.key, keyEntry.value);
      }

      if (preserveConnectionParams) {
        if (ipAddressEntry.value) {
          url.searchParams.set(ipAddressEntry.key || 'ipAddress', ipAddressEntry.value);
        }
        if (remoteTimestampEntry.value) {
          url.searchParams.set(remoteTimestampEntry.key || 'remoteTimeStamp', remoteTimestampEntry.value);
        }
      }

      return url.toString();
    } catch (error) {
      return raw;
    }
  }

  function normalizeUrl(input) {
    return buildNormalizedUrl(input);
  }

  function normalizeSuccessUrl(input) {
    const normalized = buildNormalizedUrl(input, {
      preserveConnectionParams: true,
    });
    if (!normalized) {
      return '';
    }

    try {
      const url = new URL(normalized, location.origin);
      const ipAddressEntry = getSearchParamEntry(url, isIpAddressParam);
      const remoteTimestampEntry = getSearchParamEntry(url, isRemoteTimestampParam);
      return ipAddressEntry.value || remoteTimestampEntry.value ? url.toString() : '';
    } catch (error) {
      return '';
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

  function createMappingId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeMappings(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const seenUrls = new Set();
    return value
      .map((item) => {
        const normalizedUrl = normalizeUrl(item?.url || '');
        const normalizedSuccessUrl = normalizeSuccessUrl(item?.successUrl || '');
        return {
          id: String(item?.id || createMappingId()),
          number: item?.number == null ? '' : String(item.number),
          url: normalizedUrl,
          successUrl: normalizedSuccessUrl &&
            getMappingMatchKey(normalizedSuccessUrl) === getMappingMatchKey(normalizedUrl)
            ? normalizedSuccessUrl
            : '',
          password: String(item?.password || ''),
        };
      })
      .filter((item) => {
        if (!item.url || !item.password || seenUrls.has(item.url)) {
          return false;
        }

        seenUrls.add(item.url);
        return true;
      });
  }

  function readMappings() {
    return mappingsCache.slice();
  }

  async function writeMappings(mappings) {
    mappingsCache = normalizeMappings(mappings);
    await storageSet({
      [STORAGE_KEY]: mappingsCache,
    });
    refreshAfterMappingsChange();
  }

  async function loadMappings() {
    const result = await storageGet({
      [STORAGE_KEY]: [],
    });
    mappingsCache = normalizeMappings(result[STORAGE_KEY]);
  }

  function findMappingForCurrentPage(mappings = readMappings()) {
    const currentKey = getMappingMatchKey(location.href);
    return mappings.find((item) => getMappingMatchKey(item.url) === currentKey) || null;
  }

  function extractProjectNumber(value) {
    return String(value || '').match(PROJECT_NUMBER_PATTERN)?.[0] || '';
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

  function getPreferredMappingUrl(mapping) {
    if (!mapping) {
      return '';
    }

    return normalizeSuccessUrl(mapping.successUrl || '') || normalizeUrl(mapping.url || '');
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

  async function upsertMapping(url, password, options = {}) {
    if (!url || !password) {
      return readMappings();
    }

    const normalizedUrl = normalizeUrl(url);
    const normalizedSuccessUrl = normalizeSuccessUrl(options.successUrl || '');
    const previous = readMappings().find((item) => normalizeUrl(item.url) === normalizedUrl);
    const next = readMappings().filter((item) => normalizeUrl(item.url) !== normalizedUrl);
    next.unshift({
      id: previous?.id || createMappingId(),
      number: previous?.number || '',
      url: normalizedUrl,
      successUrl: normalizedSuccessUrl || previous?.successUrl || '',
      password,
    });
    await writeMappings(next);
    return next;
  }

  async function persistSuccessfulMapping(url, options = {}) {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return readMappings();
    }

    const nextPassword = String(options.password || '').trim();
    const nextSuccessUrl = normalizeSuccessUrl(options.successUrl || location.href);
    const currentMappings = readMappings();
    const existing = currentMappings.find((item) => normalizeUrl(item.url) === normalizedUrl) || null;

    if (!existing) {
      if (!nextPassword) {
        return currentMappings;
      }

      return upsertMapping(normalizedUrl, nextPassword, {
        successUrl: nextSuccessUrl,
      });
    }

    const patch = {};
    if (nextPassword && nextPassword !== existing.password) {
      patch.password = nextPassword;
    }
    if (nextSuccessUrl && nextSuccessUrl !== existing.successUrl) {
      patch.successUrl = nextSuccessUrl;
    }

    if (Object.keys(patch).length === 0) {
      return currentMappings;
    }

    const nextMappings = currentMappings.map((item) => (
      item.id === existing.id ? { ...item, ...patch } : item
    ));
    await writeMappings(nextMappings);
    return nextMappings;
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

  function closeCurrentTabAfterDelay(delayMs = REMOTE_SOURCE_CLOSE_DELAY_MS) {
    return sendRuntimeMessage({
      target: BACKGROUND_TARGET,
      type: 'close-current-tab',
      delayMs: Math.max(0, Number(delayMs || 0)),
    });
  }

  function getNormalizedCurrentPageSuccessUrl() {
    return normalizeSuccessUrl(location.href);
  }

  function clickEnterRemoteButton(url) {
    const initialButton = findEnterRemoteButton();
    if (!initialButton) {
      return false;
    }

    if (remoteClickTimer) {
      return false;
    }

    remoteClickTimer = window.setTimeout(() => {
      remoteClickTimer = 0;

      const normalizedUrl = normalizeUrl(url);
      const button = findEnterRemoteButton();
      if (!button || shouldSkipRecentAction(`remote:${normalizedUrl}`, REMOTE_CLICK_GUARD_MS)) {
        return;
      }

      button.scrollIntoView({ behavior: 'smooth', block: 'center' });
      button.click();
      closeCurrentTabAfterDelay();
    }, REMOTE_CLICK_DELAY_MS);

    return true;
  }

  async function tryAutoLogin(mappings = readMappings()) {
    if (!isVpsHost()) {
      return;
    }

    syncDocumentTitle(mappings);
    const matched = findMappingForCurrentPage(mappings);
    const persistedMappingUrl = getPersistedMappingUrl(location.href);
    const currentSuccessUrl = getNormalizedCurrentPageSuccessUrl();

    if (hasEnteredRemoteSession()) {
      return;
    }

    const passwordInput = findLoginPasswordInput();
    if (passwordInput) {
      observeManualPasswordInput(passwordInput, persistedMappingUrl);

      if (matched) {
        fillInputValue(passwordInput, matched.password);

        if (!shouldSkipRecentSubmit(getPreferredMappingUrl(matched))) {
          clickLoginButton(passwordInput);
        }
      }

      return;
    }

    if (findEnterRemoteButton()) {
      const pendingPassword = getPendingPassword(persistedMappingUrl);
      if (pendingPassword) {
        mappings = await upsertMapping(persistedMappingUrl, pendingPassword, {
          successUrl: currentSuccessUrl,
        });
        clearPendingPassword(persistedMappingUrl);
      } else if (matched) {
        mappings = await persistSuccessfulMapping(matched.url, {
          successUrl: currentSuccessUrl,
        });
      }

      const latestMatched = findMappingForCurrentPage(mappings) || matched;
      clickEnterRemoteButton(getPreferredMappingUrl(latestMatched) || persistedMappingUrl);
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

  function syncExternalProjectTitle() {
    if (!isExternalSavedLinkHost()) {
      return;
    }

    const projectNumber = getExactClassSpans(RENDER_LABEL_CLASS)
      .map((label) => extractProjectNumber(label.textContent))
      .find(Boolean);
    if (projectNumber && document.title !== projectNumber) {
      document.title = projectNumber;
    }
  }

  function getExternalMatchedMappings(mappings = readMappings()) {
    if (!isExternalSavedLinkHost()) {
      return [];
    }

    const numberedMappings = getNumberedMappings(mappings);
    if (numberedMappings.length === 0) {
      return [];
    }

    const matchedIds = new Set();
    getExactClassSpans(RENDER_LABEL_CLASS).forEach((label) => {
      const mapping = findMappingForExternalLabel(label, numberedMappings);
      if (mapping?.id) {
        matchedIds.add(mapping.id);
      }
    });

    return numberedMappings.filter((item) => matchedIds.has(item.id));
  }

  function getCurrentPageState(mappings = readMappings()) {
    if (isVpsHost()) {
      const matched = findMappingForCurrentPage(mappings);
      return {
        ok: true,
        pageType: 'vps',
        currentUrl: location.href,
        normalizedUrl: normalizeUrl(location.href),
        matchedMappingId: matched?.id || '',
        associatedMappingIds: matched?.id ? [matched.id] : [],
      };
    }

    if (isExternalSavedLinkHost()) {
      const matchedMappings = getExternalMatchedMappings(mappings);
      return {
        ok: true,
        pageType: 'external',
        currentUrl: location.href,
        normalizedUrl: normalizeUrl(location.href),
        matchedMappingId: '',
        associatedMappingIds: matchedMappings.map((item) => item.id),
      };
    }

    return {
      ok: true,
      pageType: 'other',
      currentUrl: location.href,
      normalizedUrl: normalizeUrl(location.href),
      matchedMappingId: '',
      associatedMappingIds: [],
    };
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

  function openTab(url, options = {}) {
    return sendRuntimeMessage({
      target: BACKGROUND_TARGET,
      type: 'open-tab',
      url: normalizeUrl(url),
      active: options.active !== false,
      closeSourceTab: Boolean(options.closeSourceTab),
      closeDelayMs: Math.max(0, Number(options.closeDelayMs || 0)),
    });
  }

  function removeInPagePanel() {
    document.getElementById(PANEL_ID)?.remove();
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
    button.title = title;
    button.textContent = buttonText;
    applyExternalJumpButtonStyle(button);
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTab(targetUrl, { active: true });
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
    syncExternalProjectTitle();
    void mappings;
    removeExternalSavedLinkButtons();
  }

  function getExportFileName() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `kuniao-vps-mappings-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
  }

  function exportMappings() {
    const data = JSON.stringify(readMappings(), null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = getExportFileName();
    link.rel = 'noopener';
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importMappingsFromFile(file) {
    if (!(file instanceof File)) {
      return;
    }

    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('JSON 内容必须是 VPS 信息数组。');
    }

    const nextMappings = normalizeMappings(parsed);
    if (!window.confirm(`将导入 ${nextMappings.length} 条 VPS 信息，并覆盖当前插件内已保存列表。是否继续？`)) {
      return;
    }

    await writeMappings(nextMappings);
    const panelHost = document.getElementById(PANEL_ID);
    if (typeof panelHost?.__clearDrafts === 'function') {
      panelHost.__clearDrafts();
    }
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

  function createPanel() {
    if (!isVpsHost() || document.getElementById(PANEL_ID)) {
      return;
    }

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.zIndex = '2147483647';

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: relative;
          width: 52px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #172033;
        }
        .wrap.open { width: min(390px, calc(100vw - 24px)); }
        .toggle {
          width: 52px;
          height: 52px;
          border: 0;
          border-radius: 999px;
          background: linear-gradient(135deg, #0f766e, #2563eb);
          color: #fff;
          font-size: 14px;
          font-weight: 750;
          cursor: pointer;
          box-shadow: 0 12px 30px rgba(37, 99, 235, 0.22);
        }
        .wrap.open .toggle {
          background: #172033;
        }
        .panel {
          position: absolute;
          right: 0;
          bottom: 62px;
          display: none;
          box-sizing: border-box;
          width: min(390px, calc(100vw - 24px));
          max-height: min(680px, calc(100vh - 90px));
          padding: 14px;
          border: 1px solid #dbe3ef;
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
          overflow: auto;
        }
        .panel.open {
          display: grid;
          gap: 12px;
        }
        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .title {
          margin: 0;
          color: #111827;
          font-size: 16px;
          line-height: 1.25;
          font-weight: 750;
        }
        .desc {
          margin: 4px 0 0;
          color: #5f6f86;
          font-size: 12px;
          line-height: 1.45;
        }
        .header-actions,
        .actions,
        .row-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        button {
          font: inherit;
        }
        .action,
        .button,
        .chip {
          min-height: 30px;
          border: 0;
          border-radius: 8px;
          padding: 0 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .action {
          background: #0f766e;
          color: #fff;
        }
        .action.secondary,
        .button.secondary,
        .chip {
          background: #e8edf5;
          color: #24324a;
        }
        .chip.primary {
          background: #eaf2ff;
          color: #1d4ed8;
        }
        .chip.success {
          background: #dcfce7;
          color: #15803d;
        }
        .chip.danger {
          background: #fee2e2;
          color: #b91c1c;
        }
        .form,
        .item {
          display: grid;
          gap: 8px;
          padding: 10px;
          border: 1px solid #dbe3ef;
          border-radius: 8px;
          background: #f8fafc;
        }
        .form[hidden] {
          display: none;
        }
        .input {
          box-sizing: border-box;
          width: 100%;
          min-height: 34px;
          padding: 8px 9px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          outline: none;
          background: #fff;
          color: #111827;
          font-size: 12px;
        }
        .input:focus {
          border-color: #14b8a6;
          box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.13);
        }
        .list {
          display: grid;
          gap: 8px;
        }
        .item.active {
          border-color: rgba(20, 184, 166, 0.55);
          background: #f0fdfa;
        }
        .item.unsaved {
          border-style: dashed;
        }
        .item-top,
        .number-row,
        .password-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .item-top .input,
        .password-row .input {
          min-width: 0;
          flex: 1 1 auto;
        }
        .field-label {
          flex: 0 0 auto;
          color: #334155;
          font-size: 12px;
          font-weight: 700;
        }
        .editable-value {
          min-width: 0;
          max-width: 185px;
          border: 0;
          border-radius: 999px;
          padding: 4px 8px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          background: #eff6ff;
          color: #1d4ed8;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          text-align: left;
        }
        .editable-value:hover {
          background: #dbeafe;
        }
        .inline-input {
          min-width: 0;
          height: 30px;
          padding: 6px 8px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          outline: none;
          background: #fff;
          color: #111827;
          font-size: 12px;
        }
        .number-input {
          width: 106px;
          flex: 0 1 120px;
        }
        .password-input {
          flex: 1 1 auto;
        }
        .item-password {
          display: inline-flex;
          align-items: center;
          justify-self: start;
          max-width: 100%;
          border: 0;
          padding: 0;
          overflow-wrap: anywhere;
          background: transparent;
          color: #64748b;
          cursor: pointer;
          font-size: 12px;
          text-align: left;
        }
        .item-password:hover {
          color: #1d4ed8;
        }
        .save-inline {
          flex: 0 0 auto;
          min-height: 30px;
          border: 0;
          border-radius: 8px;
          padding: 0 10px;
          background: #dbeafe;
          color: #1d4ed8;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
        }
        .save-inline.success {
          background: #ccfbf1;
          color: #0f766e;
        }
        .save-inline[hidden] {
          display: none;
        }
        .unsaved-badge {
          flex: 0 0 auto;
          margin-left: auto;
          padding: 4px 7px;
          border-radius: 999px;
          background: #fef3c7;
          color: #92400e;
          font-size: 11px;
          line-height: 1;
          font-weight: 750;
        }
        .url {
          color: #334155;
          font-size: 12px;
          line-height: 1.45;
          word-break: break-all;
        }
        .tag {
          flex: 0 0 auto;
          padding: 4px 7px;
          border-radius: 999px;
          background: #e0f2fe;
          color: #0369a1;
          font-size: 11px;
          font-weight: 750;
        }
        .empty {
          padding: 10px 12px;
          border-radius: 8px;
          background: #edf2f7;
          color: #64748b;
          font-size: 12px;
        }
        .file-input[hidden] {
          display: none;
        }
      </style>
      <div class="wrap">
        <button class="toggle" type="button">VPS</button>
        <section class="panel">
          <div class="header">
            <div>
              <h3 class="title">VPS 登录信息</h3>
              <p class="desc">Chrome 插件独立保存；导入 JSON 后即可自动登录。</p>
            </div>
            <div class="header-actions">
              <button class="action secondary js-import" type="button">导入</button>
              <button class="action secondary js-export" type="button">导出</button>
              <button class="action js-add" type="button">新增</button>
              <input class="file-input js-import-file" type="file" accept="application/json,.json" hidden />
            </div>
          </div>
          <div class="form js-manual" hidden>
            <input class="input js-manual-url" type="text" placeholder="链接 URL" />
            <input class="input js-manual-number" type="text" placeholder="编号（可选）" />
            <input class="input js-manual-password" type="password" placeholder="密码" />
            <div class="actions">
              <button class="button action js-manual-save" type="button">保存新增</button>
              <button class="button secondary js-manual-cancel" type="button">取消</button>
            </div>
          </div>
          <div class="list js-list"></div>
        </section>
      </div>
    `;

    const wrap = shadowRoot.querySelector('.wrap');
    const toggle = shadowRoot.querySelector('.toggle');
    const panel = shadowRoot.querySelector('.panel');
    const list = shadowRoot.querySelector('.js-list');
    const addButton = shadowRoot.querySelector('.js-add');
    const importButton = shadowRoot.querySelector('.js-import');
    const exportButton = shadowRoot.querySelector('.js-export');
    const importFileInput = shadowRoot.querySelector('.js-import-file');
    const manual = shadowRoot.querySelector('.js-manual');
    const manualUrl = shadowRoot.querySelector('.js-manual-url');
    const manualNumber = shadowRoot.querySelector('.js-manual-number');
    const manualPassword = shadowRoot.querySelector('.js-manual-password');
    const manualSave = shadowRoot.querySelector('.js-manual-save');
    const manualCancel = shadowRoot.querySelector('.js-manual-cancel');
    const numberDrafts = new Map();
    const editingNumberIds = new Set();
    const passwordDrafts = new Map();
    const editingPasswordIds = new Set();
    let manualOpen = false;

    function getCurrentPanelUrl() {
      return normalizeUrl(location.href);
    }

    function getPanelItemById(id) {
      if (id === '__current__') {
        return {
          id,
          number: '',
          url: getCurrentPanelUrl(),
          password: '',
          unsaved: true,
        };
      }

      return readMappings().find((item) => item.id === id) || null;
    }

    function isTemporaryMappingId(id) {
      return id === '__current__';
    }

    function renderManual() {
      if (manual instanceof HTMLElement) {
        manual.hidden = !manualOpen;
      }
      if (addButton instanceof HTMLButtonElement) {
        addButton.hidden = manualOpen;
      }
      if (!manualOpen) {
        if (manualUrl instanceof HTMLInputElement) {
          manualUrl.value = '';
        }
        if (manualNumber instanceof HTMLInputElement) {
          manualNumber.value = '';
        }
        if (manualPassword instanceof HTMLInputElement) {
          manualPassword.value = '';
        }
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
        <article class="item ${matched ? 'active' : ''}" data-id="${escapeHtml(item.id)}">
          <div class="number-row">
            ${numberEditing ? `
              <span class="field-label">编号</span>
              <input class="inline-input number-input" type="text" value="${escapeHtml(draftNumber)}" placeholder="未设置" data-id="${escapeHtml(item.id)}" />
              <button class="save-inline" type="button" data-action="save-number" data-id="${escapeHtml(item.id)}" ${numberChanged ? '' : 'hidden'}>${numberActionText}</button>
            ` : `
              <span class="field-label">编号：</span>
              <button class="editable-value number-value" type="button" data-action="edit-number" data-id="${escapeHtml(item.id)}" title="点击编辑编号">${escapeHtml(savedNumber || '未设置')}</button>
              ${matched ? '<span class="tag">当前</span>' : ''}
            `}
          </div>
          <div class="url">${escapeHtml(item.url)}</div>
          ${passwordEditing ? `
            <div class="password-row">
              <span class="field-label">密码</span>
              <input class="inline-input password-input" type="password" value="${escapeHtml(passwordDraft)}" placeholder="输入密码" data-id="${escapeHtml(item.id)}" />
              <button class="save-inline success" type="button" data-action="save-password" data-id="${escapeHtml(item.id)}" ${passwordChanged ? '' : 'hidden'}>更新</button>
            </div>
          ` : `
            <button class="item-password" type="button" data-action="edit-password" data-id="${escapeHtml(item.id)}" title="点击编辑密码">密码：${escapeHtml(passwordText)}</button>
          `}
          <div class="row-actions">
            ${matched ? '' : `<button class="chip primary" data-action="jump" data-id="${escapeHtml(item.id)}" type="button">跳转</button>`}
            ${matched ? '' : `<button class="chip success" data-action="open-tab" data-id="${escapeHtml(item.id)}" type="button">新Tab</button>`}
            <button class="chip danger" data-action="delete" data-id="${escapeHtml(item.id)}" type="button">删除</button>
          </div>
        </article>
      `;
    }

    function getUnsavedItemMarkup(item) {
      const passwordDraft = passwordDrafts.has(item.id) ? passwordDrafts.get(item.id) : '';
      const passwordChanged = passwordDraft.trim() !== '';
      const savedNumber = item.number || '';
      const numberEditing = editingNumberIds.has(item.id);
      const draftNumber = numberDrafts.has(item.id) ? numberDrafts.get(item.id) : savedNumber;
      const numberChanged = draftNumber.trim() !== savedNumber;

      return `
        <article class="item active unsaved" data-id="${escapeHtml(item.id)}">
          <div class="number-row">
            ${numberEditing ? `
              <span class="field-label">编号</span>
              <input class="inline-input number-input" type="text" value="${escapeHtml(draftNumber)}" placeholder="未设置" data-id="${escapeHtml(item.id)}" />
              <button class="save-inline" type="button" data-action="save-number" data-id="${escapeHtml(item.id)}" ${numberChanged ? '' : 'hidden'}>添加</button>
              <span class="unsaved-badge">未保存</span>
            ` : `
              <span class="field-label">编号：</span>
              <button class="editable-value number-value" type="button" data-action="edit-number" data-id="${escapeHtml(item.id)}" title="点击编辑编号">${escapeHtml(savedNumber || '未设置')}</button>
              <span class="unsaved-badge">未保存</span>
            `}
          </div>
          <div class="url">${escapeHtml(item.url)}</div>
          <div class="password-row">
            <span class="field-label">密码</span>
            <input class="inline-input password-input" type="password" value="${escapeHtml(passwordDraft)}" placeholder="输入密码" data-id="${escapeHtml(item.id)}" />
            <button class="save-inline success" type="button" data-action="save-password" data-id="${escapeHtml(item.id)}" ${passwordChanged ? '' : 'hidden'}>保存</button>
          </div>
        </article>
      `;
    }

    function renderList() {
      const mappings = readMappings();
      const matched = findMappingForCurrentPage(mappings);
      const temporaryItem = {
        id: '__current__',
        number: String(numberDrafts.get('__current__') || ''),
        url: getCurrentPanelUrl(),
        password: '',
        unsaved: true,
      };
      const items = matched
        ? [matched, ...mappings.filter((item) => item.id !== matched.id)]
        : [temporaryItem, ...mappings];

      if (!(list instanceof HTMLElement)) {
        return;
      }

      if (items.length === 0) {
        list.innerHTML = '<div class="empty">还没有保存任何 VPS 信息。</div>';
        return;
      }

      list.innerHTML = items.map((item) => (
        item.unsaved
          ? getUnsavedItemMarkup(item)
          : getSavedItemMarkup(item, Boolean(matched && matched.id === item.id))
      )).join('');
    }

    async function saveManual() {
      if (!(manualUrl instanceof HTMLInputElement) ||
        !(manualNumber instanceof HTMLInputElement) ||
        !(manualPassword instanceof HTMLInputElement)) {
        return;
      }

      const nextUrl = normalizeUrl(manualUrl.value);
      const nextPassword = manualPassword.value.trim();
      if (!nextUrl || !nextPassword) {
        return;
      }

      const previous = readMappings().find((item) => normalizeUrl(item.url) === nextUrl);
      const next = readMappings().filter((item) => normalizeUrl(item.url) !== nextUrl);
      next.unshift({
        id: previous?.id || createMappingId(),
        number: manualNumber.value.trim() || previous?.number || '',
        url: nextUrl,
        password: nextPassword,
      });
      await writeMappings(next);
      manualOpen = false;
      renderManual();
      renderList();
      tryAutoLogin(readMappings());
    }

    async function saveNumber(id, sourceElement) {
      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      const itemElement = sourceElement?.closest('.item');
      const input = itemElement?.querySelector('.number-input');
      const nextNumber = input instanceof HTMLInputElement
        ? input.value.trim()
        : String(numberDrafts.get(id) || '').trim();

      if (isTemporaryMappingId(id)) {
        numberDrafts.set(id, nextNumber);
        editingNumberIds.delete(id);
        renderList();
        return;
      }

      await writeMappings(readMappings().map((item) => (
        item.id === id ? { ...item, number: nextNumber } : item
      )));
      numberDrafts.delete(id);
      editingNumberIds.delete(id);
      renderList();
    }

    async function savePassword(id, sourceElement) {
      const current = getPanelItemById(id);
      if (!current) {
        return;
      }

      const itemElement = sourceElement?.closest('.item');
      const input = itemElement?.querySelector('.password-input');
      const nextPassword = input instanceof HTMLInputElement
        ? input.value.trim()
        : String(passwordDrafts.get(id) || '').trim();
      if (!nextPassword) {
        return;
      }

      if (isTemporaryMappingId(id)) {
        const next = readMappings().filter((item) => normalizeUrl(item.url) !== normalizeUrl(current.url));
        next.unshift({
          id: createMappingId(),
          number: String(numberDrafts.get(id) || '').trim(),
          url: normalizeUrl(current.url),
          password: nextPassword,
        });
        await writeMappings(next);
        numberDrafts.delete(id);
        editingNumberIds.delete(id);
        passwordDrafts.delete(id);
        editingPasswordIds.delete(id);
        renderList();
        tryAutoLogin(readMappings());
        return;
      }

      await writeMappings(readMappings().map((item) => (
        item.id === id ? { ...item, password: nextPassword } : item
      )));
      passwordDrafts.delete(id);
      editingPasswordIds.delete(id);
      renderList();
      tryAutoLogin(readMappings());
    }

    async function deleteMapping(id) {
      const current = getPanelItemById(id);
      if (!current || !window.confirm(`确认删除这条 VPS 信息？\n${current.number ? `${current.number} · ` : ''}${current.url}`)) {
        return;
      }

      await writeMappings(readMappings().filter((item) => item.id !== id));
      numberDrafts.delete(id);
      editingNumberIds.delete(id);
      passwordDrafts.delete(id);
      editingPasswordIds.delete(id);
      renderList();
    }

    function prepareManualJump(url) {
      const targetUrl = normalizeUrl(url);
      clearRecentAction(`remote:${targetUrl}`);
      return targetUrl;
    }

    toggle?.addEventListener('click', () => {
      panel?.classList.toggle('open');
      wrap?.classList.toggle('open', panel?.classList.contains('open'));
      if (panel?.classList.contains('open')) {
        renderList();
      }
    });

    addButton?.addEventListener('click', () => {
      manualOpen = true;
      renderManual();
      window.setTimeout(() => {
        if (manualUrl instanceof HTMLInputElement) {
          manualUrl.focus();
        }
      }, 0);
    });

    manualCancel?.addEventListener('click', () => {
      manualOpen = false;
      renderManual();
    });

    manualSave?.addEventListener('click', saveManual);

    exportButton?.addEventListener('click', exportMappings);

    importButton?.addEventListener('click', () => {
      if (importFileInput instanceof HTMLInputElement) {
        importFileInput.value = '';
        importFileInput.click();
      }
    });

    importFileInput?.addEventListener('change', async () => {
      if (!(importFileInput instanceof HTMLInputElement)) {
        return;
      }

      try {
        await importMappingsFromFile(importFileInput.files?.[0] || null);
      } catch (error) {
        window.alert(`导入失败：${error?.message || error}`);
      } finally {
        importFileInput.value = '';
      }
    });

    function focusNumberInput(id) {
      window.setTimeout(() => {
        const input = shadowRoot.querySelector(`.number-input[data-id="${cssEscape(id)}"]`);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      }, 0);
    }

    function focusPasswordInput(id) {
      window.setTimeout(() => {
        const input = shadowRoot.querySelector(`.password-input[data-id="${cssEscape(id)}"]`);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      }, 0);
    }

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
        const saveButton = item?.querySelector('.save-inline[data-action="save-password"]');
        if (saveButton instanceof HTMLButtonElement) {
          saveButton.hidden = isTemporaryMappingId(id)
            ? draftPassword.trim() === ''
            : draftPassword.trim() === savedPassword;
        }
        return;
      }

      const savedNumber = current.number || '';
      const draftNumber = target.value;
      numberDrafts.set(id, draftNumber);

      const item = target.closest('.item');
      const saveButton = item?.querySelector('.save-inline[data-action="save-number"]');
      if (saveButton instanceof HTMLButtonElement) {
        saveButton.hidden = draftNumber.trim() === savedNumber;
        saveButton.textContent = savedNumber ? '更新' : '添加';
      }
    });

    list?.addEventListener('keydown', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) ||
        (!target.classList.contains('number-input') && !target.classList.contains('password-input')) ||
        event.key !== 'Enter') {
        return;
      }

      const id = target.dataset.id;
      if (!id) {
        return;
      }

      event.preventDefault();
      if (target.classList.contains('password-input')) {
        await savePassword(id, target);
      } else {
        await saveNumber(id, target);
      }
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

      event.preventDefault();
    });

    list?.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.dataset.action;
      const id = target.dataset.id || '';
      const current = getPanelItemById(id);
      if (!action || !id) {
        return;
      }

      if (action === 'edit-number' && current) {
        editingNumberIds.add(id);
        numberDrafts.set(id, current.number || '');
        renderList();
        focusNumberInput(id);
      } else if (action === 'edit-password' && current) {
        editingPasswordIds.add(id);
        passwordDrafts.set(id, current.password || '');
        renderList();
        focusPasswordInput(id);
      } else if (action === 'save-number') {
        await saveNumber(id, target);
      } else if (action === 'save-password') {
        await savePassword(id, target);
      } else if (action === 'jump' && current?.url) {
        const targetUrl = prepareManualJump(current.url);
        if (normalizeUrl(location.href) === targetUrl) {
          window.setTimeout(() => tryAutoLogin(readMappings()), 0);
        } else {
          location.href = targetUrl;
        }
      } else if (action === 'open-tab' && current?.url) {
        openTab(current.url, { active: true });
      } else if (action === 'delete') {
        await deleteMapping(id);
      }

      renderList();
    });

    host.__clearDrafts = () => {
      numberDrafts.clear();
      editingNumberIds.clear();
      passwordDrafts.clear();
      editingPasswordIds.clear();
      renderList();
    };
    host.__refreshMappings = renderList;
    renderManual();
    renderList();
    document.documentElement.appendChild(host);
  }

  function refreshAfterMappingsChange() {
    if (isVpsHost()) {
      syncDocumentTitle(readMappings());
      tryAutoLogin(readMappings());
    }

    syncExternalSavedLinkButtons(readMappings());
    const panelHost = document.getElementById(PANEL_ID);
    if (typeof panelHost?.__refreshMappings === 'function') {
      panelHost.__refreshMappings();
    }
  }

  function queueRefresh() {
    if (refreshTimer) {
      return;
    }

    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refreshAfterMappingsChange();
    }, 150);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }

    return String(value).replaceAll('"', '\\"');
  }

  async function boot() {
    await loadMappings();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[STORAGE_KEY]) {
        return;
      }

      mappingsCache = normalizeMappings(changes[STORAGE_KEY].newValue);
      refreshAfterMappingsChange();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.target !== CONTENT_TARGET) {
        return false;
      }

      if (message.type === 'get-page-state') {
        storageGet({
          [STORAGE_KEY]: [],
        }).then((result) => {
          const latestMappings = normalizeMappings(result[STORAGE_KEY]);
          sendResponse(getCurrentPageState(latestMappings));
        });
        return true;
      }

      sendResponse({
        ok: false,
        error: `unknown-message:${message.type || ''}`,
      });
      return false;
    });

    removeInPagePanel();

    if (isVpsHost()) {
      tryAutoLogin(readMappings());
    }

    syncExternalSavedLinkButtons(readMappings());

    const observer = new MutationObserver(() => {
      queueRefresh();
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
