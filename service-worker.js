// ViiTor Free - service worker (cleaned)
// Manages tab audio capture lifecycle and content script injection.

const MSG = {
  startCapture: 'START_CAPTURE',
  stopCapture: 'STOP_CAPTURE',
  captureReady: 'CAPTURE_READY',
  captureError: 'CAPTURE_ERROR',
  captureEnded: 'CAPTURE_ENDED',
  stopDone: 'STOP_DONE',
  opusChunk: 'OPUS_CHUNK',
};

const CAPTURE_STATES = {
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
};

const OFFSCREEN_DOC = 'offscreen.html';
const sessions = new Map();

// ── Content Script Injection ──────────────────────────────────
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  }).catch(() => {});
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['fullscreen-bridge.js'],
    world: 'MAIN',
  }).catch(() => {});
}

// ── Tab Session Management ──────────────────────────────────
function getSession(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { state: CAPTURE_STATES.idle, pendingStart: false, requestId: 0 };
    sessions.set(tabId, s);
  }
  return s;
}

function hasActiveSession() {
  for (const s of sessions.values()) {
    if (s.state !== CAPTURE_STATES.idle || s.pendingStart) return true;
  }
  return false;
}

function cleanupTabSession(tabId) {
  const s = sessions.get(tabId);
  if (s && s.state === CAPTURE_STATES.idle && !s.pendingStart) {
    sessions.delete(tabId);
  }
}

async function sendToTab(tabId, msg) {
  if (tabId == null) return;
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ── Offscreen Document Management ──────────────────────────────
async function ensureOffscreen() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOC,
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio for real-time transcription',
    });
  }
}

async function maybeCloseOffscreen() {
  if (!hasActiveSession()) {
    try {
      if (await chrome.offscreen.hasDocument()) {
        if (!hasActiveSession()) {
          await chrome.offscreen.closeDocument();
        }
      }
    } catch (e) {
      console.warn('[sw] close offscreen failed', e);
    }
  }
}

// ── Audio Capture Lifecycle ──────────────────────────────────
function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(streamId);
    });
  });
}

async function startCapture(tabId) {
  const s = getSession(tabId);

  if (s.state === CAPTURE_STATES.starting) return;
  if (s.state === CAPTURE_STATES.running) {
    await sendToTab(tabId, { type: MSG.captureReady });
    return;
  }
  if (s.state === CAPTURE_STATES.stopping) {
    s.pendingStart = true;
    return;
  }

  s.state = CAPTURE_STATES.starting;
  s.pendingStart = false;
  const reqId = ++s.requestId;

  try {
    const streamId = await getStreamId(tabId);
    if (s.state !== CAPTURE_STATES.starting || s.requestId !== reqId) return;
    await ensureOffscreen();
    if (s.state !== CAPTURE_STATES.starting || s.requestId !== reqId) return;

    chrome.runtime.sendMessage({
      type: MSG.startCapture,
      streamId,
      tabId,
    }).catch(() => {});
  } catch (err) {
    if (s.requestId !== reqId) return;
    s.state = CAPTURE_STATES.idle;
    s.pendingStart = false;
    cleanupTabSession(tabId);
    await sendToTab(tabId, {
      type: MSG.captureError,
      error: err?.message || String(err || 'capture failed'),
    });
  }
}

async function stopCapture(tabId) {
  const s = getSession(tabId);
  s.pendingStart = false;
  s.requestId++;

  if (s.state === CAPTURE_STATES.idle) {
    try {
      if (await chrome.offscreen.hasDocument()) {
        s.state = CAPTURE_STATES.stopping;
        chrome.runtime.sendMessage({ type: MSG.stopCapture, tabId }).catch(() => {});
        return;
      }
    } catch {}
    s.state = CAPTURE_STATES.idle;
    cleanupTabSession(tabId);
    await sendToTab(tabId, { type: MSG.stopDone });
    return;
  }

  if (s.state !== CAPTURE_STATES.stopping) {
    s.state = CAPTURE_STATES.stopping;
    try {
      chrome.runtime.sendMessage({ type: MSG.stopCapture, tabId }).catch(() => {});
    } catch {
      s.state = CAPTURE_STATES.idle;
      cleanupTabSession(tabId);
      await sendToTab(tabId, { type: MSG.stopDone });
    }
  }
}

// ── Message Routing ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // From offscreen document (no tab context) - audio data
  if (!tabId && msg.tabId != null) {
    const tid = msg.tabId;
    if (msg.type === MSG.captureReady) {
      const s = getSession(tid);
      if (s.state === CAPTURE_STATES.starting) {
        s.state = CAPTURE_STATES.running;
        sendToTab(tid, { type: MSG.captureReady });
      }
    } else if (msg.type === MSG.opusChunk) {
      sendToTab(tid, { type: MSG.opusChunk, data: msg.data, timestamp: msg.timestamp });
    } else if (msg.type === MSG.captureError) {
      const s = getSession(tid);
      s.state = CAPTURE_STATES.idle;
      s.pendingStart = false;
      cleanupTabSession(tid);
      sendToTab(tid, { type: MSG.captureError, error: msg.error });
      maybeCloseOffscreen();
    } else if (msg.type === MSG.captureEnded) {
      const s = getSession(tid);
      const wasPending = s.pendingStart;
      s.state = CAPTURE_STATES.idle;
      s.pendingStart = false;
      sendToTab(tid, { type: MSG.captureEnded });
      cleanupTabSession(tid);
      maybeCloseOffscreen();
      sendToTab(tid, { type: MSG.stopDone });
      if (wasPending) startCapture(tid);
    }
    return false;
  }

  // From content script (has tab context)
  if (tabId && msg?.type === MSG.startCapture) {
    startCapture(tabId);
    sendResponse({ ok: true });
    return true;
  }
  if (tabId && msg?.type === MSG.stopCapture) {
    stopCapture(tabId);
    sendResponse({ ok: true });
    return true;
  }
  // Login flow
  if (tabId && msg?.type === 'OPEN_TAB' && msg.url) {
    chrome.tabs.create({ url: msg.url }, () => {
      sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message });
    });
    return true;
  }
  if (tabId && msg?.type === 'OPEN_LOGIN_PAGE' && msg.url) {
    chrome.windows.create({ url: msg.url, type: 'popup', width: 550, height: 800 }, w => {
      if (w) chrome.windows.update(w.id, { width: 550, height: 800 });
    });
    sendResponse({ ok: true });
  }
  if (tabId && msg?.type === 'OPEN_MEMBER_PAGE') {
    const url = 'https://www.viitor.info/chrome/member?u=' + btoa(msg.uid || '') + '&l=' + (msg.source?.popup_id ? '&popup_id=' + msg.source.popup_id : '');
    chrome.windows.create({ url, width: 1280, height: 720, type: 'popup' }, () => {
      sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message });
    });
    return true;
  }

  return false;
});

// ── External messages (login from viitor.info) ──
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'LOGIN_SUCCESS' && msg.data) {
    chrome.storage.local.set({ vf_user: msg.data });
    sendResponse({ ok: true });
    // Close login window
    if (sender.tab?.windowId != null) {
      chrome.windows.remove(sender.tab.windowId).catch(() => {});
    }
    return true;
  }
  if (msg?.type === 'PAY_FINISH' && msg.data?.code === 0) {
    // Notify all tabs
    chrome.tabs.query({}, tabs => {
      for (const t of tabs) {
        if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'PAY_FINISH', data: msg.data }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    if (sender.tab?.windowId != null) {
      chrome.windows.remove(sender.tab.windowId).catch(() => {});
    }
    return true;
  }
  sendResponse({ ok: true });
  return false;
});

// ── Extension Icon Click ─────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  if (!/^https?:|^file:/.test(tab.url)) return;
  await injectContentScript(tab.id);
});

// ── Tab Cleanup ──────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  stopCapture(tabId);
});
