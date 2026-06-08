'use strict';

const STORAGE_KEY = 'vps-auto-login-mappings';
const BACKGROUND_TARGET = 'kuniao-vps-background';
const CONTENT_TARGET = 'kuniao-vps-content';
const VPS_HOSTS = ['home.kuniaovps.com', 'home.geliyun.com'];
const TEMP_MAPPING_ID = '__extension-current-unsaved__';
const SORT_MODE_STORAGE_KEY = 'vps-auto-login-popup-sort-mode';
const elements = {};
const numberDrafts = new Map();
const editingNumberIds = new Set();
const passwordDrafts = new Map();
const editingPasswordIds = new Set();
let mappings = [];
let activeTab = null;
let manualOpen = false;
let pendingDeleteId = '';
let currentPageState = null;
let sortMode = 'createdAt';
let searchKeyword = '';
let selectedItemId = '';

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? '')
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

function normalizeHostName(host) {
  return String(host || '').split(':')[0];
}

function isVpsHost(host) {
  return VPS_HOSTS.includes(normalizeHostName(host));
}

function getActiveUrl() {
  return activeTab?.url || '';
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
    const url = new URL(raw);
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
    const url = new URL(normalized);
    const ipAddressEntry = getSearchParamEntry(url, isIpAddressParam);
    const remoteTimestampEntry = getSearchParamEntry(url, isRemoteTimestampParam);
    return ipAddressEntry.value || remoteTimestampEntry.value ? url.toString() : '';
  } catch (error) {
    return '';
  }
}

function getMappingMatchKey(input) {
  try {
    const url = new URL(normalizeUrl(input));
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

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (result) => {
      const error = chrome.runtime.lastError;
      resolve(error ? defaults : (result || defaults));
    });
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({
      active: true,
      currentWindow: true,
    }, (tabs) => {
      resolve(chrome.runtime.lastError ? null : (tabs?.[0] || null));
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response || {
        ok: true,
      });
    });
  });
}

function sendMessageToActiveTab(message) {
  return new Promise((resolve) => {
    if (!activeTab?.id) {
      resolve(null);
      return;
    }

    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve(null);
        return;
      }

      resolve(response || null);
    });
  });
}

async function requestCurrentPageState() {
  const response = await sendMessageToActiveTab({
    target: CONTENT_TARGET,
    type: 'get-page-state',
  });
  if (!response || response.ok === false) {
    return null;
  }

  return {
    pageType: String(response.pageType || 'other'),
    currentUrl: String(response.currentUrl || getActiveUrl()),
    normalizedUrl: normalizeUrl(response.normalizedUrl || response.currentUrl || getActiveUrl()),
    matchedMappingId: String(response.matchedMappingId || ''),
    associatedMappingIds: Array.isArray(response.associatedMappingIds)
      ? response.associatedMappingIds.map((id) => String(id || '')).filter(Boolean)
      : [],
  };
}

async function loadState() {
  const [tab, result] = await Promise.all([
    queryActiveTab(),
    storageGet({
      [STORAGE_KEY]: [],
      [SORT_MODE_STORAGE_KEY]: 'createdAt',
    }),
  ]);
  activeTab = tab;
  mappings = normalizeMappings(result[STORAGE_KEY]);
  sortMode = result[SORT_MODE_STORAGE_KEY] === 'number' ? 'number' : 'createdAt';
  currentPageState = await requestCurrentPageState();
}

async function writeMappings(nextMappings) {
  mappings = normalizeMappings(nextMappings);
  await storageSet({
    [STORAGE_KEY]: mappings,
  });
  currentPageState = await requestCurrentPageState();
}

async function writeSortMode(nextSortMode) {
  sortMode = nextSortMode === 'number' ? 'number' : 'createdAt';
  await storageSet({
    [SORT_MODE_STORAGE_KEY]: sortMode,
  });
}

function setNotice(message) {
  elements.notice.hidden = !message;
  elements.notice.textContent = message || '';
}

function getActiveHost() {
  try {
    return normalizeHostName(new URL(getActiveUrl()).host);
  } catch (error) {
    return '';
  }
}

function setStatus() {
  const host = getActiveHost();
  const pageType = currentPageState?.pageType || '';
  const pageStateText = pageType === 'vps'
    ? 'VPS 页面'
    : pageType === 'external'
      ? 'TBA 页面'
      : host;
  elements.pageStatus.textContent = pageStateText
    ? `${mappings.length} 条已保存 · ${pageStateText}`
    : `${mappings.length} 条已保存`;
  const statusClass = pageType === 'external'
    ? 'external'
    : isVpsHost(host)
      ? 'logged'
      : 'ready';
  elements.pageStatus.className = `page-status ${statusClass}`;
}

function findMappingForCurrentPage() {
  const matchedId = currentPageState?.matchedMappingId || '';
  if (matchedId) {
    return mappings.find((item) => item.id === matchedId) || null;
  }

  const activeUrl = currentPageState?.normalizedUrl || getActiveUrl();
  if (!activeUrl) {
    return null;
  }

  const currentKey = getMappingMatchKey(activeUrl);
  return mappings.find((item) => (
    getMappingMatchKey(item.url) === currentKey ||
    (item.successUrl && getMappingMatchKey(item.successUrl) === currentKey)
  )) || null;
}

function getAssociatedMappingIdSet() {
  return new Set(currentPageState?.associatedMappingIds || []);
}

function getItemDisplayState(item) {
  const matched = findMappingForCurrentPage();
  if (matched?.id === item.id) {
    return 'matched';
  }

  if (getAssociatedMappingIdSet().has(item.id)) {
    return 'associated';
  }

  return 'default';
}

function getPreferredMappingUrl(item) {
  if (!item) {
    return '';
  }

  return normalizeSuccessUrl(item.successUrl || '') || normalizeUrl(item.url || '');
}

function getComparableNumber(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.replace(/\s+/g, '').toLowerCase() : '';
}

function matchesSearch(item) {
  const keyword = searchKeyword.trim().toLowerCase();
  if (!keyword) {
    return true;
  }

  return [
    item.number,
    item.url,
    item.successUrl,
  ]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(keyword));
}

function compareMappings(a, b) {
  if (sortMode === 'number') {
    const numberA = getComparableNumber(a.number);
    const numberB = getComparableNumber(b.number);
    if (numberA && numberB) {
      const compared = numberA.localeCompare(numberB, 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
      });
      if (compared !== 0) {
        return compared;
      }
    } else if (numberA || numberB) {
      return numberA ? -1 : 1;
    }
  }

  return 0;
}

function getTemporaryMapping() {
  return {
    id: TEMP_MAPPING_ID,
    number: String(numberDrafts.get(TEMP_MAPPING_ID) || ''),
    url: currentPageState?.pageType === 'vps'
      ? normalizeUrl(currentPageState?.normalizedUrl || getActiveUrl())
      : normalizeUrl(getActiveUrl()),
    successUrl: currentPageState?.pageType === 'vps'
      ? normalizeSuccessUrl(currentPageState?.currentUrl || getActiveUrl())
      : '',
    password: '',
    unsaved: true,
  };
}

function isTemporaryMappingId(id) {
  return id === TEMP_MAPPING_ID;
}

function getMappingById(id) {
  if (isTemporaryMappingId(id)) {
    return getTemporaryMapping();
  }

  return mappings.find((item) => item.id === id) || null;
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

function renderManualForm() {
  elements.manualForm.hidden = !manualOpen;
  elements.toggleManualButton.hidden = manualOpen;
  if (!manualOpen) {
    elements.manualUrl.value = '';
    elements.manualNumber.value = '';
    elements.manualPassword.value = '';
  }
}

function getSavedItemMarkup(item, displayState, selected) {
  const matched = displayState === 'matched';
  const associated = displayState === 'associated';
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
    <article class="item ${matched ? 'active' : ''} ${associated ? 'associated' : ''} ${selected ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="number-row">
        ${numberEditing ? `
          <span class="field-label">编号</span>
          <input class="inline-input number-input" type="text" value="${escapeHtml(draftNumber)}" placeholder="未设置" data-id="${escapeHtml(item.id)}" />
          <button class="save-inline" type="button" data-action="save-number" data-id="${escapeHtml(item.id)}" ${numberChanged ? '' : 'hidden'}>${numberActionText}</button>
        ` : `
          <span class="field-label">编号：</span>
          <button class="editable-value number-value" type="button" data-action="edit-number" data-id="${escapeHtml(item.id)}" title="点击编辑编号">${escapeHtml(savedNumber || '未设置')}</button>
          ${matched ? '<span class="tag">当前</span>' : ''}
          ${associated ? '<span class="tag">关联</span>' : ''}
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
      <div class="item-actions">
        ${matched ? '' : `<button class="chip-button" data-action="jump" data-id="${escapeHtml(item.id)}" data-shortcut="Enter" type="button">跳转</button>`}
        ${matched ? '' : `<button class="chip-button success" data-action="open-tab" data-id="${escapeHtml(item.id)}" data-shortcut="⌘Command+Enter" type="button">新Tab</button>`}
        <button class="chip-button danger-soft" data-action="delete" data-id="${escapeHtml(item.id)}" type="button">删除</button>
      </div>
    </article>
  `;
}

function getUnsavedItemMarkup(item, selected) {
  const passwordDraft = passwordDrafts.has(item.id) ? passwordDrafts.get(item.id) : '';
  const passwordChanged = passwordDraft.trim() !== '';
  const savedNumber = item.number || '';
  const numberEditing = editingNumberIds.has(item.id);
  const draftNumber = numberDrafts.has(item.id) ? numberDrafts.get(item.id) : savedNumber;
  const numberChanged = draftNumber.trim() !== savedNumber;

  return `
    <article class="item active unsaved ${selected ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
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

function getSortedItems() {
  const matched = findMappingForCurrentPage();
  const associatedIdSet = getAssociatedMappingIdSet();
  const sortedMappings = mappings
    .filter((item) => !matched || item.id !== matched.id)
    .filter((item) => matchesSearch(item))
    .sort(compareMappings);
  const associatedItems = sortedMappings.filter((item) => associatedIdSet.has(item.id));
  const normalItems = sortedMappings.filter((item) => !associatedIdSet.has(item.id));
  const items = [];

  if (matched && matchesSearch(matched)) {
    items.push(matched);
  }
  items.push(...associatedItems, ...normalItems);

  const activeUrl = currentPageState?.normalizedUrl || getActiveUrl();
  if (matched) {
    return {
      matched,
      items,
    };
  }

  if (activeUrl && currentPageState?.pageType === 'vps') {
    const temporaryMapping = getTemporaryMapping();
    const includeTemporary = matchesSearch(temporaryMapping);
    return {
      matched: null,
      items: includeTemporary ? [temporaryMapping, ...items] : items,
    };
  }

  return {
    matched: null,
    items,
  };
}

function updateSelectedItem(items, { resetSelection = false } = {}) {
  if (!items.length) {
    selectedItemId = '';
    return;
  }

  if (resetSelection || !items.some((item) => item.id === selectedItemId)) {
    selectedItemId = items[0].id;
  }
}

function getSelectedItem(items) {
  if (!items.length) {
    return null;
  }

  updateSelectedItem(items);
  return items.find((item) => item.id === selectedItemId) || items[0] || null;
}

function scrollSelectedItemIntoView() {
  const selectedItem = elements.list?.querySelector('.item.selected');
  if (selectedItem instanceof HTMLElement) {
    selectedItem.scrollIntoView({
      block: 'nearest',
    });
  }
}

function renderList({ resetSelection = false, scrollSelection = false } = {}) {
  const { items } = getSortedItems();
  updateSelectedItem(items, {
    resetSelection,
  });
  if (items.length === 0) {
    elements.list.innerHTML = searchKeyword.trim()
      ? '<div class="empty">没有匹配到符合搜索条件的 VPS 信息。</div>'
      : '<div class="empty">还没有保存任何 VPS 信息。</div>';
    return;
  }

  elements.list.innerHTML = items.map((item) => (
    item.unsaved
      ? getUnsavedItemMarkup(item, item.id === selectedItemId)
      : getSavedItemMarkup(item, getItemDisplayState(item), item.id === selectedItemId)
  )).join('');

  if (resetSelection || scrollSelection) {
    scrollSelectedItemIntoView();
  }
}

function renderConfirm() {
  const item = pendingDeleteId ? getMappingById(pendingDeleteId) : null;
  elements.confirmOverlay.hidden = !item || isTemporaryMappingId(item.id);
  elements.confirmMeta.textContent = item
    ? `${item.number ? `编号：${item.number} · ` : ''}${item.url}`
    : '';
}

function render(options = {}) {
  setStatus();
  renderManualForm();
  renderList(options);
  renderConfirm();
}

async function saveManualMapping() {
  const nextUrl = normalizeUrl(elements.manualUrl.value);
  const nextPassword = elements.manualPassword.value.trim();
  if (!nextUrl || !nextPassword) {
    setNotice('链接和密码不能为空。');
    return;
  }

  const previous = mappings.find((item) => normalizeUrl(item.url) === nextUrl);
  const next = mappings.filter((item) => normalizeUrl(item.url) !== nextUrl);
  next.unshift({
    id: previous?.id || createMappingId(),
    number: elements.manualNumber.value.trim() || previous?.number || '',
    url: nextUrl,
    successUrl: previous?.successUrl || '',
    password: nextPassword,
  });
  await writeMappings(next);
  manualOpen = false;
  setNotice('');
  render();
}

async function updateNumber(id, sourceElement) {
  const current = getMappingById(id);
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
    render();
    return;
  }

  await writeMappings(mappings.map((item) => (
    item.id === id ? { ...item, number: nextNumber } : item
  )));
  numberDrafts.delete(id);
  editingNumberIds.delete(id);
  render();
}

async function updatePassword(id, sourceElement) {
  const current = getMappingById(id);
  if (!current) {
    return;
  }

  const itemElement = sourceElement?.closest('.item');
  const input = itemElement?.querySelector('.password-input');
  const nextPassword = input instanceof HTMLInputElement
    ? input.value.trim()
    : String(passwordDrafts.get(id) || '').trim();

  if (!nextPassword) {
    setNotice('密码不能为空。');
    return;
  }

  if (isTemporaryMappingId(id)) {
    const currentUrl = normalizeUrl(current.url);
    const next = mappings.filter((item) => normalizeUrl(item.url) !== currentUrl);
    next.unshift({
      id: createMappingId(),
      number: String(numberDrafts.get(id) || '').trim(),
      url: currentUrl,
      successUrl: normalizeSuccessUrl(current.successUrl || current.url || ''),
      password: nextPassword,
    });
    await writeMappings(next);
    numberDrafts.delete(id);
    editingNumberIds.delete(id);
    passwordDrafts.delete(id);
    editingPasswordIds.delete(id);
    setNotice('');
    render();
    return;
  }

  await writeMappings(mappings.map((item) => (
    item.id === id ? { ...item, password: nextPassword } : item
  )));
  passwordDrafts.delete(id);
  editingPasswordIds.delete(id);
  setNotice('');
  render();
}

function getExportFileName() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `kuniao-vps-mappings-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

function exportMappings() {
  const data = JSON.stringify(mappings, null, 2);
  const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = getExportFileName();
  link.rel = 'noopener';
  document.documentElement.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  await writeMappings(nextMappings);
  numberDrafts.clear();
  editingNumberIds.clear();
  passwordDrafts.clear();
  editingPasswordIds.clear();
  setNotice(`已导入 ${nextMappings.length} 条 VPS 信息。`);
  render();
}

async function openNewTab(url) {
  const response = await sendRuntimeMessage({
    target: BACKGROUND_TARGET,
    type: 'open-tab',
    url,
    active: true,
  });

  if (!response || response.ok === false) {
    throw new Error(response?.error || '新 Tab 打开失败');
  }
}

async function jumpCurrentTab(url) {
  if (!activeTab?.id) {
    await openNewTab(url);
    return;
  }

  chrome.tabs.update(activeTab.id, {
    url,
    active: true,
  });
}

function getNavigationTargetUrl(item) {
  return getPreferredMappingUrl(item);
}

async function activateSelectedItem({ openInNewTab = false } = {}) {
  const { items } = getSortedItems();
  const selectedItem = getSelectedItem(items);
  const url = getNavigationTargetUrl(selectedItem);
  if (!selectedItem || !url) {
    return;
  }

  if (openInNewTab) {
    await openNewTab(url);
  } else {
    await jumpCurrentTab(url);
  }

  window.close();
}

function moveSelectedItem(step) {
  const { items } = getSortedItems();
  if (!items.length) {
    selectedItemId = '';
    return;
  }

  updateSelectedItem(items);
  const currentIndex = items.findIndex((item) => item.id === selectedItemId);
  const safeCurrentIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = Math.min(items.length - 1, Math.max(0, safeCurrentIndex + step));
  if (nextIndex === safeCurrentIndex) {
    return;
  }

  selectedItemId = items[nextIndex].id;
  renderList({
    scrollSelection: true,
  });
}

function focusNumberInput(id) {
  setTimeout(() => {
    const input = $(`.number-input[data-id="${cssEscape(id)}"]`);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, 0);
}

function focusPasswordInput(id) {
  setTimeout(() => {
    const input = $(`.password-input[data-id="${cssEscape(id)}"]`);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, 0);
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', async () => {
    await loadState();
    if (elements.sortSelect instanceof HTMLSelectElement) {
      elements.sortSelect.value = sortMode;
    }
    if (elements.searchInput instanceof HTMLInputElement) {
      elements.searchInput.value = searchKeyword;
    }
    setNotice('');
    render({
      resetSelection: true,
    });
  });

  elements.sortSelect.addEventListener('change', async () => {
    await writeSortMode(elements.sortSelect.value);
    renderList({
      resetSelection: true,
    });
  });

  elements.searchInput.addEventListener('input', () => {
    searchKeyword = elements.searchInput.value || '';
    renderList({
      resetSelection: true,
    });
  });

  elements.searchInput.addEventListener('keydown', async (event) => {
    if (event.isComposing || pendingDeleteId) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelectedItem(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelectedItem(-1);
      return;
    }

    if (event.key !== 'Enter' || event.altKey || event.ctrlKey) {
      return;
    }

    event.preventDefault();
    try {
      await activateSelectedItem({
        openInNewTab: event.metaKey,
      });
    } catch (error) {
      setNotice(error.message || String(error));
    }
  });

  elements.toggleManualButton.addEventListener('click', () => {
    manualOpen = true;
    renderManualForm();
    elements.manualUrl.focus();
  });

  elements.cancelManualButton.addEventListener('click', () => {
    manualOpen = false;
    renderManualForm();
  });

  elements.manualForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveManualMapping();
  });

  elements.importButton.addEventListener('click', () => {
    elements.importFile.value = '';
    elements.importFile.click();
  });

  elements.exportButton.addEventListener('click', exportMappings);

  elements.importFile.addEventListener('change', async () => {
    try {
      await importMappingsFromFile(elements.importFile.files?.[0] || null);
    } catch (error) {
      setNotice(`导入失败：${error.message || error}`);
    } finally {
      elements.importFile.value = '';
    }
  });

  elements.list.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) ||
      (!target.classList.contains('number-input') && !target.classList.contains('password-input'))) {
      return;
    }

    const id = target.dataset.id;
    if (!id) {
      return;
    }

    const current = getMappingById(id);
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

  elements.list.addEventListener('keydown', async (event) => {
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
      await updatePassword(id, target);
    } else {
      await updateNumber(id, target);
    }
  });

  elements.list.addEventListener('focusout', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) ||
      (!target.classList.contains('number-input') && !target.classList.contains('password-input'))) {
      return;
    }

    const id = target.dataset.id;
    if (!id) {
      return;
    }

    setTimeout(() => {
      const active = document.activeElement;
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
      render();
    }, 0);
  });

  elements.list.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) ||
      (target.dataset.action !== 'save-number' && target.dataset.action !== 'save-password')) {
      return;
    }

    event.preventDefault();
  });

  elements.list.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.dataset.action;
    const id = target.dataset.id || '';
    const item = getMappingById(id);
    if (!action || !id || !item) {
      return;
    }

    try {
      target.setAttribute('disabled', 'true');
      if (action === 'edit-number') {
        editingNumberIds.add(id);
        numberDrafts.set(id, item.number || '');
        render();
        focusNumberInput(id);
      } else if (action === 'edit-password') {
        editingPasswordIds.add(id);
        passwordDrafts.set(id, item.password || '');
        render();
        focusPasswordInput(id);
      } else if (action === 'save-number') {
        await updateNumber(id, target);
      } else if (action === 'save-password') {
        await updatePassword(id, target);
      } else if (action === 'jump') {
        await jumpCurrentTab(getNavigationTargetUrl(item));
        window.close();
      } else if (action === 'open-tab') {
        await openNewTab(getNavigationTargetUrl(item));
        window.close();
      } else if (action === 'delete') {
        pendingDeleteId = id;
        renderConfirm();
      }
    } catch (error) {
      setNotice(error.message || String(error));
    } finally {
      target.removeAttribute('disabled');
    }
  });

  elements.cancelDeleteButton.addEventListener('click', () => {
    pendingDeleteId = '';
    renderConfirm();
  });

  elements.confirmOverlay.addEventListener('click', (event) => {
    if (event.target === elements.confirmOverlay) {
      pendingDeleteId = '';
      renderConfirm();
    }
  });

  elements.confirmDeleteButton.addEventListener('click', async () => {
    if (!pendingDeleteId) {
      return;
    }

    await writeMappings(mappings.filter((item) => item.id !== pendingDeleteId));
    numberDrafts.delete(pendingDeleteId);
    editingNumberIds.delete(pendingDeleteId);
    passwordDrafts.delete(pendingDeleteId);
    editingPasswordIds.delete(pendingDeleteId);
    pendingDeleteId = '';
    setNotice('');
    render();
  });
}

function collectElements() {
  elements.pageStatus = $('#pageStatus');
  elements.refreshButton = $('#refreshButton');
  elements.notice = $('#notice');
  elements.currentSection = $('#currentSection');
  elements.currentSection.hidden = true;
  elements.sortSelect = $('#sortSelect');
  elements.searchInput = $('#searchInput');
  elements.toggleManualButton = $('#toggleManualButton');
  elements.importButton = $('#importButton');
  elements.exportButton = $('#exportButton');
  elements.importFile = $('#importFile');
  elements.manualForm = $('#manualForm');
  elements.manualUrl = $('#manualUrl');
  elements.manualNumber = $('#manualNumber');
  elements.manualPassword = $('#manualPassword');
  elements.cancelManualButton = $('#cancelManualButton');
  elements.list = $('#list');
  elements.confirmOverlay = $('#confirmOverlay');
  elements.confirmMeta = $('#confirmMeta');
  elements.cancelDeleteButton = $('#cancelDeleteButton');
  elements.confirmDeleteButton = $('#confirmDeleteButton');
}

function focusSearchInput() {
  if (!(elements.searchInput instanceof HTMLInputElement)) {
    return;
  }

  window.setTimeout(() => {
    elements.searchInput.focus();
    elements.searchInput.select();
  }, 0);
}

document.addEventListener('DOMContentLoaded', async () => {
  collectElements();
  bindEvents();
  await loadState();
  if (elements.sortSelect instanceof HTMLSelectElement) {
    elements.sortSelect.value = sortMode;
  }
  if (elements.searchInput instanceof HTMLInputElement) {
    elements.searchInput.value = searchKeyword;
  }
  render({
    resetSelection: true,
  });
  focusSearchInput();
});
