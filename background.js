let activeTabId = null;
let offscreenReadyResolve = null;
let tabOpQueue = Promise.resolve();

function serialized(fn) {
  tabOpQueue = tabOpQueue.then(fn, fn);
  return tabOpQueue;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  const readyPromise = new Promise(resolve => { offscreenReadyResolve = resolve; });
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture and process tab audio with effects chain'
  });
  await readyPromise;
}

async function closeOffscreen() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function enableTab(tabId, settings) {
  if (activeTabId === tabId) return;

  if (activeTabId && activeTabId !== tabId) {
    await disableTab(activeTabId);
  }

  await chrome.tabs.update(tabId, { muted: true });
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreen();

  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    streamId,
    tabId,
    settings
  });

  activeTabId = tabId;
}

async function disableTab(tabId) {
  try { await chrome.tabs.update(tabId, { muted: false }); } catch {}

  if (await hasOffscreenDocument()) {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }); } catch {}
    await closeOffscreen();
  }

  if (activeTabId === tabId) activeTabId = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_READY') {
    if (offscreenReadyResolve) { offscreenReadyResolve(); offscreenReadyResolve = null; }
    return;
  }

  if (msg.type === 'ENABLE_TAB') {
    serialized(() => enableTab(msg.tabId, msg.settings))
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'DISABLE_TAB') {
    serialized(() => disableTab(msg.tabId))
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_UPDATE_SETTINGS', settings: msg.settings })
      .catch(() => {});
    sendResponse({ success: true });
  }
});

// Clean up when tab is closed or navigated
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === activeTabId) serialized(() => disableTab(tabId));
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId === activeTabId && info.status === 'loading') {
    serialized(() => disableTab(tabId));
  }

  if (info.status === 'complete') {
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return;
    const key = `tab_${tabId}`;
    const result = await chrome.storage.local.get(key);
    const saved = result[key];
    if (saved?.enabled) {
      serialized(() => enableTab(tabId, saved));
    }
  }
});
