import { extractUrl } from './extract.js';

const LOG_PREFIX = '[分享链接清理]';

const sourceEl = document.getElementById('source');
const urlEl = document.getElementById('url');
const statusEl = document.getElementById('status');
const openBtn = document.getElementById('open');
const copyBtn = document.getElementById('copy');

const params = new URLSearchParams(location.search);
const queryAuto = params.get('auto') === '1';
const queryTabId = Number(params.get('tabId')) || null;
const queryWindowId = Number(params.get('windowId')) || null;

let currentUrl = null;
let autoOpen = queryAuto;
let targetTabId = queryTabId;
let targetWindowId = queryWindowId;
let autoHandled = false;
let senderWindowId = null;
let senderWindowType = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logWarn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function showStatus(message) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
}

function renderExtracted(text) {
  const url = extractUrl(text);
  currentUrl = url;
  if (url) {
    urlEl.textContent = url;
    urlEl.classList.remove('empty');
    openBtn.disabled = false;
    copyBtn.disabled = false;
    showStatus('');
  } else {
    urlEl.textContent = '尚未找到链接';
    urlEl.classList.add('empty');
    openBtn.disabled = true;
    copyBtn.disabled = true;
    if (text && text.trim()) {
      showStatus('这段文案里没有找到可用的 http(s) 链接。');
    } else {
      showStatus('');
    }
  }
  return url;
}

async function requestNavigation(url) {
  log('requesting navigation', {
    url,
    targetTabId,
    targetWindowId,
    senderWindowId,
    senderWindowType
  });
  const res = await chrome.runtime.sendMessage({
    type: 'open-extracted-url',
    url,
    tabId: targetTabId,
    windowId: targetWindowId,
    closeWindowId: senderWindowType === 'popup' ? senderWindowId : null
  });
  log('navigation response', res);
  return Boolean(res?.ok);
}

async function maybeAutoOpen(url) {
  if (!autoOpen || autoHandled || !url) return;
  autoHandled = true;
  try {
    const ok = await requestNavigation(url);
    if (ok) {
      try {
        window.close();
      } catch {
        // Service worker may already have closed a fallback window.
      }
      return;
    }
    showStatus('已提取到链接，但自动跳转失败，请点击「打开链接」。');
  } catch (error) {
    logWarn('auto-open failed', error);
    autoHandled = false;
    showStatus('已提取到链接，但自动跳转失败，请点击「打开链接」。');
  }
}

async function consumeAutoOpenFlag() {
  try {
    const current = await chrome.windows.getCurrent();
    senderWindowId = current?.id || null;
    senderWindowType = current?.type || null;
    log('popup window', { senderWindowId, senderWindowType });
  } catch (error) {
    logWarn('windows.getCurrent failed', error);
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'consume-auto-open' });
    log('consume-auto-open', res);
    if (res?.autoOpen) autoOpen = true;
    if (!targetTabId && res?.tabId) targetTabId = Number(res.tabId) || null;
    if (!targetWindowId && res?.windowId) targetWindowId = Number(res.windowId) || null;
  } catch (error) {
    logWarn('consume-auto-open message failed', error);
  }

  try {
    const stored = await chrome.storage.session.get('pendingTarget');
    const data = stored?.pendingTarget;
    if (data && Date.now() - (data.createdAt || 0) < 60_000) {
      log('loaded pendingTarget from session storage', data);
      if (data.autoOpen) autoOpen = true;
      if (!targetTabId && data.tabId) targetTabId = Number(data.tabId) || null;
      if (!targetWindowId && data.windowId) targetWindowId = Number(data.windowId) || null;
    }
  } catch (error) {
    logWarn('storage.session.get failed', error);
  }

  log('popup target ready', { autoOpen, targetTabId, targetWindowId, queryAuto, queryTabId, queryWindowId });
}

async function readClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      log('popup clipboard.readText', { length: text ? text.length : 0 });
      if (text) {
        sourceEl.value = text;
        const url = renderExtracted(text);
        log('extracted from popup clipboard', url);
        await maybeAutoOpen(url);
        if (!url && autoOpen) {
          showStatus('已经读到剪贴板内容，但没有找到可用的链接。也可以把文案粘贴到上面再试。');
        }
        return;
      }
    }
  } catch (error) {
    logWarn('clipboard.readText failed', error);
  }

  if (autoOpen) {
    sourceEl.placeholder = '请把分享文案粘贴到这里，提取后会自动打开';
    showStatus('当前页面无法自动读取剪贴板（例如新标签页或设置页）。请把分享文案粘贴到上面。');
  } else {
    sourceEl.placeholder = '无法自动读取剪贴板，请把分享文案粘贴到这里';
    showStatus('未能自动读取剪贴板，请手动粘贴分享文案。');
  }
}

sourceEl.addEventListener('input', () => {
  const url = renderExtracted(sourceEl.value);
  maybeAutoOpen(url);
});

sourceEl.addEventListener('paste', () => {
  setTimeout(() => {
    const url = renderExtracted(sourceEl.value);
    maybeAutoOpen(url);
  }, 0);
});

openBtn.addEventListener('click', async () => {
  if (!currentUrl) return;
  try {
    const ok = await requestNavigation(currentUrl);
    if (ok) {
      window.close();
      return;
    }
  } catch (error) {
    logWarn('open button message failed, creating tab', error);
  }
  try {
    if (targetTabId) {
      await chrome.tabs.update(targetTabId, { url: currentUrl, active: true });
      if (targetWindowId) {
        await chrome.windows.update(targetWindowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: currentUrl, active: true });
    }
    window.close();
  } catch (error) {
    logWarn('direct navigation failed', error);
    showStatus('跳转失败，请复制链接后手动打开。');
  }
});

copyBtn.addEventListener('click', async () => {
  if (!currentUrl) return;
  try {
    await navigator.clipboard.writeText(currentUrl);
    copyBtn.textContent = '已复制';
    setTimeout(() => {
      copyBtn.textContent = '复制链接';
    }, 1500);
  } catch {
    showStatus('复制失败，请手动选中上方链接。');
  }
});

await consumeAutoOpenFlag();
await readClipboard();
