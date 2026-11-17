import { extractUrl } from './extract.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const BADGE_CLEAR_MS = 4000;
const TARGET_TTL_MS = 60_000;
const LOG_PREFIX = '[分享链接清理]';
const TARGET_STORAGE_KEY = 'pendingTarget';

const RESTRICTED_URL_RE =
  /^(chrome|chrome-extension|chrome-search|chrome-untrusted|chrome-devtools|devtools|edge|about|view-source|data|blob):/i;
const WEBSTORE_RE =
  /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;

let badgeTimer = null;
let creatingOffscreen = null;
let pendingTarget = null;
let resetPopupTimer = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logWarn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_RE.test(url) || WEBSTORE_RE.test(url);
}

function isExtensionTab(tab) {
  const url = tab?.url || tab?.pendingUrl || '';
  return url.startsWith('chrome-extension://');
}

function toTarget(tab, windowId) {
  if (!tab?.id) return null;
  return {
    tabId: tab.id,
    windowId: windowId || tab.windowId || null,
    url: tab.url || tab.pendingUrl || ''
  };
}

async function getLastFocusedNormalTarget() {
  try {
    const win = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ['normal']
    });
    if (win) {
      const tab = (win.tabs || []).find((item) => item.active) || null;
      const target = toTarget(tab, win.id);
      if (target && !isExtensionTab(tab)) {
        log('last-focused normal window target', target);
        return target;
      }
    }
  } catch (error) {
    logWarn('windows.getLastFocused(normal) failed', String(error && error.message ? error.message : error));
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id && !isExtensionTab(tab)) {
      const win = tab.windowId ? await chrome.windows.get(tab.windowId) : null;
      if (!win || win.type === 'normal') {
        const target = toTarget(tab, tab.windowId);
        log('lastFocusedWindow query target', target);
        return target;
      }
      log('lastFocusedWindow was not a normal window', { type: win?.type, tabId: tab.id, url: tab.url });
    }
  } catch (error) {
    logWarn('tabs.query(lastFocusedWindow) failed', String(error && error.message ? error.message : error));
  }

  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const win = windows.find((item) => item.focused) || windows[0];
    const tab = win ? (win.tabs || []).find((item) => item.active) : null;
    const target = toTarget(tab, win?.id);
    if (target) {
      log('fallback normal-window target', target);
      return target;
    }
  } catch (error) {
    logWarn('windows.getAll(normal) failed', String(error && error.message ? error.message : error));
  }

  logWarn('could not find a normal browser tab to navigate');
  return { tabId: null, windowId: null, url: '' };
}

async function persistTarget(target, autoOpen) {
  pendingTarget = {
    tabId: target?.tabId || null,
    windowId: target?.windowId || null,
    url: target?.url || '',
    autoOpen: Boolean(autoOpen),
    createdAt: Date.now()
  };
  try {
    await chrome.storage.session.set({ [TARGET_STORAGE_KEY]: pendingTarget });
    log('persisted target', pendingTarget);
  } catch (error) {
    logWarn('storage.session.set failed, using in-memory target only', error);
  }
}

function isFreshTarget(data) {
  return Boolean(data) && Date.now() - (data.createdAt || 0) < TARGET_TTL_MS;
}

async function loadPersistedTarget() {
  let data = isFreshTarget(pendingTarget) ? pendingTarget : null;
  try {
    const stored = await chrome.storage.session.get(TARGET_STORAGE_KEY);
    if (isFreshTarget(stored?.[TARGET_STORAGE_KEY])) {
      data = stored[TARGET_STORAGE_KEY];
    }
  } catch (error) {
    logWarn('storage.session.get failed', error);
  }
  return data;
}

async function clearPersistedTarget() {
  pendingTarget = null;
  try {
    await chrome.storage.session.remove(TARGET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function resetDefaultPopup() {
  try {
    await chrome.action.setPopup({ popup: 'popup.html' });
    log('reset action popup to default');
  } catch (error) {
    logWarn('setPopup reset failed', error);
  }
}

/**
 * Runs in the page (serialized into the tab). Must be self-contained.
 */
async function readClipboardInPage() {
  const result = { text: '', method: '', error: '' };

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        result.text = text;
        result.method = 'clipboard-api';
        return result;
      }
    }
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }

  const previous = document.activeElement;
  const host = document.body || document.documentElement;
  if (!host) {
    result.method = 'no-document';
    result.error = result.error || 'document has no body';
    return result;
  }

  const ta = document.createElement('textarea');
  ta.setAttribute('aria-hidden', 'true');
  ta.value = '';
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;padding:0;border:0;z-index:2147483647;';
  host.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('paste');
    result.text = ta.value || '';
    result.method = 'execCommand';
    result.error = ok || result.text ? result.error : (result.error || 'execCommand paste returned empty');
  } catch (error) {
    result.method = 'execCommand';
    result.error = String(error && error.message ? error.message : error);
  } finally {
    ta.remove();
    if (previous && typeof previous.focus === 'function') {
      try {
        previous.focus();
      } catch {
        // ignore
      }
    }
  }
  return result;
}

async function readClipboardFromTab(tabId, tabUrl) {
  if (!tabId) {
    log('skip tab injection: no tab id');
    return null;
  }
  if (isRestrictedUrl(tabUrl)) {
    log('skip tab injection: restricted page', tabUrl || '(no url)');
    return null;
  }

  log('injecting clipboard reader into tab', tabId, tabUrl);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readClipboardInPage
    });
    const payload = results?.[0]?.result || null;
    log('tab clipboard result', {
      method: payload?.method,
      length: payload?.text ? payload.text.length : 0,
      error: payload?.error || ''
    });
    return payload;
  } catch (error) {
    logWarn('tab injection failed', tabUrl, String(error && error.message ? error.message : error));
    return null;
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL]
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: '读取剪贴板中的分享文案以提取真实链接'
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL]
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // Already closed or API unavailable.
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readClipboardFromOffscreen() {
  log('trying offscreen clipboard fallback');
  await ensureOffscreenDocument();
  try {
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'read-clipboard' });
        const text = response?.text ?? '';
        log('offscreen clipboard result', {
          ok: Boolean(response?.ok),
          method: response?.method || 'execCommand',
          length: text.length,
          attempt: attempt + 1
        });
        return { text, method: response?.method || 'offscreen', error: text ? '' : 'offscreen returned empty' };
      } catch (error) {
        lastError = error;
        logWarn('offscreen message failed, retrying', attempt + 1, String(error && error.message ? error.message : error));
        await sleep(40);
      }
    }
    throw lastError || new Error('无法通过 offscreen 读取剪贴板');
  } finally {
    await closeOffscreenDocument();
  }
}

async function readClipboardText(target) {
  const fromTab = await readClipboardFromTab(target?.tabId, target?.url);
  if (fromTab?.text) {
    return { text: fromTab.text, method: fromTab.method, source: 'tab' };
  }

  try {
    const fromOffscreen = await readClipboardFromOffscreen();
    if (fromOffscreen?.text) {
      return { text: fromOffscreen.text, method: fromOffscreen.method, source: 'offscreen' };
    }
  } catch (error) {
    logWarn('offscreen clipboard failed', String(error && error.message ? error.message : error));
  }

  return { text: '', method: '', source: 'none' };
}

async function resolveTarget(preferredTabId, preferredWindowId) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id && !isExtensionTab(tab)) {
        log('resolved stored tab', { tabId: tab.id, windowId: tab.windowId, url: tab.url });
        return { tabId: tab.id, windowId: tab.windowId || preferredWindowId || null };
      }
      logWarn('stored tab is not a safe navigation target', { tabId: preferredTabId, url: tab?.url });
    } catch (error) {
      logWarn('stored tab no longer exists', preferredTabId, String(error && error.message ? error.message : error));
    }
  }

  if (preferredWindowId) {
    try {
      const win = await chrome.windows.get(preferredWindowId, { populate: true });
      if (win?.type === 'normal') {
        const tab = (win.tabs || []).find((item) => item.active && !isExtensionTab(item));
        if (tab?.id) {
          log('resolved stored window active tab', { tabId: tab.id, windowId: win.id, url: tab.url });
          return { tabId: tab.id, windowId: win.id };
        }
      }
    } catch (error) {
      logWarn('stored window no longer exists', preferredWindowId, String(error && error.message ? error.message : error));
    }
  }

  return getLastFocusedNormalTarget();
}

async function closeFallbackWindow(closeWindowId, targetWindowId) {
  if (!closeWindowId || closeWindowId === targetWindowId) return;
  try {
    const win = await chrome.windows.get(closeWindowId, { populate: true });
    if (win.type !== 'popup' && win.type !== 'app') {
      logWarn('refusing to close non-popup window', { closeWindowId, type: win.type });
      return;
    }
    const ourPrefix = chrome.runtime.getURL('');
    const isOurs = (win.tabs || []).some((tab) => (tab.url || tab.pendingUrl || '').startsWith(ourPrefix));
    if (!isOurs) {
      logWarn('refusing to close window that is not the fallback UI', closeWindowId);
      return;
    }
    await chrome.windows.remove(closeWindowId);
    log('closed fallback window', closeWindowId);
  } catch (error) {
    logWarn('could not close fallback window', closeWindowId, error);
  }
}

async function navigateToUrl(url, preferredTabId = null, preferredWindowId = null, closeWindowId = null) {
  log('navigateToUrl start', { url, preferredTabId, preferredWindowId, closeWindowId });
  const target = await resolveTarget(preferredTabId, preferredWindowId);

  if (target?.tabId) {
    try {
      const updated = await chrome.tabs.update(target.tabId, { url, active: true });
      const windowId = updated?.windowId || target.windowId;
      log('tabs.update ok', {
        tabId: updated?.id || target.tabId,
        windowId,
        url: updated?.pendingUrl || updated?.url
      });
      if (windowId) {
        try {
          await chrome.windows.update(windowId, { focused: true });
          log('focused window', windowId);
        } catch (error) {
          logWarn('windows.update focus failed', windowId, error);
        }
      }
      await clearPersistedTarget();
      await closeFallbackWindow(closeWindowId, windowId);
      return { ok: true, tabId: updated?.id || target.tabId, windowId };
    } catch (error) {
      logError('tabs.update failed, will try tabs.create', target, error);
    }
  }

  try {
    const created = await chrome.tabs.create({
      url,
      active: true,
      windowId: target?.windowId || preferredWindowId || undefined
    });
    const windowId = created?.windowId || target?.windowId || null;
    log('tabs.create ok', { tabId: created?.id, windowId });
    if (windowId) {
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch {
        // ignore
      }
    }
    await clearPersistedTarget();
    await closeFallbackWindow(closeWindowId, windowId);
    return { ok: true, tabId: created?.id, windowId };
  } catch (error) {
    logError('tabs.create failed', error);
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function openClipboardFallbackUi(target) {
  await persistTarget(target, true);
  const tabId = target?.tabId || '';
  const windowId = target?.windowId || '';
  const popupUrl = `popup.html?auto=1&tabId=${encodeURIComponent(String(tabId))}&windowId=${encodeURIComponent(String(windowId))}`;
  log('opening fallback UI to read clipboard', { tabId, windowId, popupUrl });

  try {
    await chrome.action.setPopup({ popup: popupUrl });
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      log('opened action popup with target query params');
      if (resetPopupTimer) clearTimeout(resetPopupTimer);
      resetPopupTimer = setTimeout(() => {
        resetDefaultPopup();
        resetPopupTimer = null;
      }, 4000);
      return true;
    }
  } catch (error) {
    logWarn('openPopup failed', String(error && error.message ? error.message : error));
    await resetDefaultPopup();
  }

  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(popupUrl),
      type: 'popup',
      width: 400,
      height: 360,
      focused: true
    });
    log('opened fallback popup window with target query params');
    await resetDefaultPopup();
    return true;
  } catch (error) {
    logError('failed to open fallback window', error);
    await resetDefaultPopup();
    return false;
  }
}

async function setBadge(text, color) {
  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (text) {
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      badgeTimer = null;
    }, BADGE_CLEAR_MS);
  }
}

async function notify(id, title, message, badgeText, badgeColor) {
  await setBadge(badgeText, badgeColor);
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 0
    });
  } catch (error) {
    logWarn('notification failed', String(error && error.message ? error.message : error));
  }
}

async function notifyClipboardUnreadable() {
  await notify(
    'share-link-cleaner-clipboard',
    '分享链接清理',
    '无法读取剪贴板。请点击工具栏图标，把分享文案粘贴到弹窗中。当前页（如新标签页、设置页）可能不允许读取。',
    '?',
    '#d97706'
  );
}

async function notifyNoUrl() {
  await notify(
    'share-link-cleaner-no-url',
    '分享链接清理',
    '已经读到剪贴板内容，但没有找到可用的链接',
    '!',
    '#dc2626'
  );
}

async function notifyNavigationFailed(url) {
  await notify(
    'share-link-cleaner-nav-failed',
    '分享链接清理',
    `已提取到链接，但自动跳转失败：${url}`,
    '!',
    '#dc2626'
  );
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-cleaned-url') return;
  log('command received', command);

  const target = await getLastFocusedNormalTarget();
  log('command target', target);
  await persistTarget(target, true);

  let text = '';
  let source = 'none';
  try {
    const result = await readClipboardText(target);
    text = result.text || '';
    source = result.source;
    log('clipboard read finished', { source, method: result.method, length: text.length });
  } catch (error) {
    logError('clipboard read threw', error);
  }

  if (!text) {
    const openedUi = await openClipboardFallbackUi(target);
    // Do not fire a notification when the fallback UI opened: it can steal
    // focus and close the action popup before auto-navigation runs.
    if (!openedUi) {
      await notifyClipboardUnreadable();
    } else {
      await setBadge('…', '#0f766e');
      log('waiting for fallback UI to read clipboard and request navigation');
    }
    return;
  }

  const url = extractUrl(text);
  if (!url) {
    log('no URL found in clipboard text', { preview: text.slice(0, 160) });
    await notifyNoUrl();
    return;
  }

  log('extracted URL from', source, url);
  await setBadge('', '#000000');
  const nav = await navigateToUrl(url, target.tabId, target.windowId);
  if (!nav?.ok) {
    await notifyNavigationFailed(url);
  }
});

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({
    description: '粘贴分享文案，将提取其中的链接并打开'
  });
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const url = extractUrl(text);
  if (url) {
    const escaped = escapeXml(url);
    chrome.omnibox.setDefaultSuggestion({
      description: `打开 <url>${escaped}</url>`
    });
    suggest([
      {
        content: url,
        description: `<url>${escaped}</url> <dim>— 从分享文案提取</dim>`
      }
    ]);
  } else {
    chrome.omnibox.setDefaultSuggestion({
      description: text.trim()
        ? '未找到可用链接，请检查粘贴的分享文案'
        : '粘贴分享文案，将提取其中的链接并打开'
    });
    suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const url = extractUrl(text) || (isAlreadyUrl(text) ? text.trim() : null);
  if (!url) {
    await notifyNoUrl();
    return;
  }
  if (disposition === 'newForegroundTab' || disposition === 'newBackgroundTab') {
    await chrome.tabs.create({
      url,
      active: disposition === 'newForegroundTab'
    });
    return;
  }
  const target = await getLastFocusedNormalTarget();
  const nav = await navigateToUrl(url, target.tabId, target.windowId);
  if (!nav?.ok) {
    await notifyNavigationFailed(url);
  }
});

function isAlreadyUrl(text) {
  try {
    const parsed = new URL(text.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'consume-auto-open') {
    loadPersistedTarget()
      .then((data) => {
        const response = {
          autoOpen: Boolean(data?.autoOpen),
          tabId: data?.tabId || null,
          windowId: data?.windowId || null
        };
        log('consume-auto-open', response, 'sender=', sender?.url);
        sendResponse(response);
      })
      .catch((error) => {
        logWarn('consume-auto-open failed', error);
        sendResponse({ autoOpen: false, tabId: null, windowId: null });
      });
    return true;
  }

  if (message?.type === 'open-extracted-url' && message.url) {
    const tabId = Number(message.tabId) || null;
    const windowId = Number(message.windowId) || null;
    const closeWindowId = Number(message.closeWindowId) || sender?.tab?.windowId || null;
    log('popup requested navigation', {
      url: message.url,
      tabId,
      windowId,
      closeWindowId,
      senderUrl: sender?.url
    });
    navigateToUrl(message.url, tabId, windowId, closeWindowId)
      .then(async (result) => {
        await resetDefaultPopup();
        log('navigation from popup finished', result);
        sendResponse(result);
      })
      .catch((error) => {
        logError('popup navigation failed', error);
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      });
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  resetDefaultPopup();
  log('installed/updated', chrome.runtime.getManifest().version);
});
