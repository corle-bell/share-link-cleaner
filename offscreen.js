chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'read-clipboard') return undefined;

  (async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendResponse({ text, ok: true, method: 'clipboard-api' });
          return;
        }
      }
    } catch {
      // Fall through to execCommand; offscreen documents often lack focus.
    }

    const textarea = document.getElementById('clipboard');
    textarea.value = '';
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('paste');
    sendResponse({ text: textarea.value || '', ok: Boolean(ok), method: 'execCommand' });
  })();

  return true;
});
