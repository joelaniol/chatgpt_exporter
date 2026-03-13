const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_CLOSE_DELAY_MS = 30000;
const OFFSCREEN_PENDING_DOWNLOADS_STORAGE_KEY = "__chatgpt_export_pending_offscreen_downloads__";
const RUNTIME_STATE_BY_TAB_STORAGE_KEY = "__chatgpt_export_runtime_state_by_tab__";

let offscreenCreatePromise = null;
let offscreenCloseTimer = null;
const offscreenRequestIdByDownloadId = new Map();
let activeOffscreenOperationCount = 0;
let offscreenTrackingLock = Promise.resolve();
let runtimeStateTrackingLock = Promise.resolve();

void bootstrapOffscreenCleanup();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = String(message?.type || "").trim();
  if (!type) {
    return false;
  }

  if (type === "chatgpt-export-download") {
    void handleRuntimeDownload(message)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Download failed"
        });
      });

    return true;
  }

  if (type === "chatgpt-export-runtime-state-update") {
    void handleRuntimeStateUpdate(message, sender)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Runtime state update failed"
        });
      });
    return true;
  }

  if (type === "chatgpt-export-runtime-state-clear") {
    void handleRuntimeStateClear(sender)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Runtime state clear failed"
        });
      });
    return true;
  }

  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  void handleOffscreenDownloadChanged(delta);
});

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearRuntimeStateForTab(tabId);
  });
}

async function handleOffscreenDownloadChanged(delta) {
  const downloadId = Number(delta?.id);
  if (!Number.isFinite(downloadId)) {
    return;
  }

  const nextState = String(delta?.state?.current || "").trim().toLowerCase();
  if (nextState !== "complete" && nextState !== "interrupted") {
    return;
  }

  const requestId = await untrackOffscreenDownload(downloadId);

  if (requestId) {
    void releaseOffscreenBlobUrl(requestId);
  }
  scheduleOffscreenCloseIfIdle();
}

async function handleRuntimeDownload(message) {
  const content = typeof message.content === "string"
    ? message.content
    : String(message.html || "");
  const filename = String(message.filename || "chatgpt_dialog.html");
  const mimeType = normalizeMimeType(message.mimeType);
  const conflictAction = normalizeConflictAction(message.conflictAction);

  if (!content) {
    return { ok: false, error: "Empty export content." };
  }

  try {
    return await downloadViaOffscreenBlobUrl({
      content,
      filename,
      mimeType,
      conflictAction
    });
  } catch (error) {
    console.warn("[ChatGPT Export] Offscreen blob download failed, falling back to data URL:", error);
    return await downloadViaDataUrl({
      content,
      filename,
      mimeType,
      conflictAction
    });
  }
}

async function handleRuntimeStateUpdate(message, sender) {
  const tabIdKey = normalizeRuntimeStateTabId(sender?.tab?.id);
  if (!tabIdKey) {
    return;
  }

  const snapshot = normalizeRuntimeStateSnapshot(message?.snapshot, sender?.tab?.url);
  await runWithRuntimeStateTrackingLock(async () => {
    const runtimeStates = await getPersistedRuntimeStatesByTab();
    runtimeStates[tabIdKey] = snapshot;
    await setPersistedRuntimeStatesByTab(runtimeStates);
  });
}

async function handleRuntimeStateClear(sender) {
  await clearRuntimeStateForTab(sender?.tab?.id);
}

async function clearRuntimeStateForTab(tabId) {
  const tabIdKey = normalizeRuntimeStateTabId(tabId);
  if (!tabIdKey) {
    return;
  }

  await runWithRuntimeStateTrackingLock(async () => {
    const runtimeStates = await getPersistedRuntimeStatesByTab();
    if (!Object.prototype.hasOwnProperty.call(runtimeStates, tabIdKey)) {
      return;
    }

    delete runtimeStates[tabIdKey];
    await setPersistedRuntimeStatesByTab(runtimeStates);
  });
}

function normalizeRuntimeStateTabId(tabId) {
  const normalized = Number(tabId);
  if (!Number.isInteger(normalized) || normalized < 0) {
    return "";
  }
  return String(normalized);
}

function normalizeRuntimeStateSnapshot(snapshot, senderUrl) {
  const normalized = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
  normalized.pageUrl = typeof normalized.pageUrl === "string" && normalized.pageUrl
    ? normalized.pageUrl
    : String(senderUrl || "");
  normalized.updatedAt = Date.now();
  return normalized;
}

async function getPersistedRuntimeStatesByTab() {
  const storageArea = getRuntimeStateStorageArea();
  if (!storageArea?.get) {
    return {};
  }

  return await new Promise((resolve) => {
    storageArea.get([RUNTIME_STATE_BY_TAB_STORAGE_KEY], (data) => {
      if (chrome.runtime?.lastError) {
        resolve({});
        return;
      }

      resolve(normalizePersistedRuntimeStatesByTab(data ? data[RUNTIME_STATE_BY_TAB_STORAGE_KEY] : null));
    });
  });
}

async function setPersistedRuntimeStatesByTab(runtimeStates) {
  const storageArea = getRuntimeStateStorageArea();
  if (!storageArea?.set) {
    return;
  }

  const normalized = normalizePersistedRuntimeStatesByTab(runtimeStates);
  if (Object.keys(normalized).length === 0 && storageArea.remove) {
    await new Promise((resolve) => {
      storageArea.remove([RUNTIME_STATE_BY_TAB_STORAGE_KEY], () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    });
    return;
  }

  await new Promise((resolve) => {
    storageArea.set(
      {
        [RUNTIME_STATE_BY_TAB_STORAGE_KEY]: normalized
      },
      () => {
        void chrome.runtime?.lastError;
        resolve();
      }
    );
  });
}

function normalizePersistedRuntimeStatesByTab(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized = {};
  Object.entries(value).forEach(([tabId, snapshot]) => {
    const normalizedTabId = normalizeRuntimeStateTabId(tabId);
    if (!normalizedTabId || !snapshot || typeof snapshot !== "object") {
      return;
    }
    normalized[normalizedTabId] = { ...snapshot };
  });
  return normalized;
}

function getRuntimeStateStorageArea() {
  return chrome?.storage?.session || chrome?.storage?.local || null;
}

async function runWithRuntimeStateTrackingLock(task) {
  const next = runtimeStateTrackingLock.then(task, task);
  runtimeStateTrackingLock = next.catch(() => {});
  return await next;
}

async function downloadViaOffscreenBlobUrl({ content, filename, mimeType, conflictAction }) {
  return await runWithOffscreenOperation(async () => {
    await ensureOffscreenDocument();

    const requestId = createDownloadRequestId();
    const offscreenResponse = await sendRuntimeMessage({
      type: "chatgpt-export-offscreen-create-blob-url",
      requestId,
      content,
      mimeType
    });

    if (!offscreenResponse?.ok || typeof offscreenResponse.url !== "string" || !offscreenResponse.url) {
      throw new Error(offscreenResponse?.error || "Offscreen document did not return a blob URL");
    }

    try {
      const downloadId = await startChromeDownload({
        url: offscreenResponse.url,
        filename,
        conflictAction
      });
      await trackOffscreenDownload(downloadId, requestId);
      await finalizeTrackedDownloadIfAlreadyTerminal(downloadId);
      scheduleOffscreenCloseIfIdle();
      return { ok: true, downloadId, transport: "offscreen-blob" };
    } catch (error) {
      await releaseOffscreenBlobUrl(requestId);
      scheduleOffscreenCloseIfIdle();
      throw error;
    }
  });
}

async function downloadViaDataUrl({ content, filename, mimeType, conflictAction }) {
  const dataUrl = "data:" + mimeType + "," + encodeURIComponent(content);
  const downloadId = await startChromeDownload({
    url: dataUrl,
    filename,
    conflictAction
  });
  return { ok: true, downloadId, transport: "data-url" };
}

async function startChromeDownload({ url, filename, conflictAction }) {
  return await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction
      },
      (downloadId) => {
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Download failed"));
          return;
        }
        if (typeof downloadId !== "number") {
          reject(new Error("Download could not be started"));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("chrome.offscreen API is unavailable");
  }

  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["BLOBS"],
      justification: "Create blob URLs for ChatGPT export downloads without using data URLs."
    });
  }

  try {
    await offscreenCreatePromise;
  } catch (error) {
    if (!(await shouldIgnoreOffscreenCreateError(error))) {
      throw error;
    }
  } finally {
    offscreenCreatePromise = null;
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime?.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return Array.isArray(contexts) && contexts.length > 0;
  }

  if (self.clients?.matchAll) {
    const matchedClients = await self.clients.matchAll();
    return matchedClients.some((client) => client.url === offscreenUrl);
  }

  return false;
}

function scheduleOffscreenCloseIfIdle() {
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
  }

  offscreenCloseTimer = setTimeout(() => {
    offscreenCloseTimer = null;
    void runOffscreenCloseCheck();
  }, OFFSCREEN_CLOSE_DELAY_MS);
}

async function runOffscreenCloseCheck() {
  if (await hasPendingOffscreenDownloads()) {
    scheduleOffscreenCloseIfIdle();
    return;
  }
  await closeOffscreenDocumentIfPresent();
}

async function closeOffscreenDocumentIfPresent() {
  if (!chrome.offscreen?.closeDocument) {
    return;
  }
  if (activeOffscreenOperationCount > 0) {
    return;
  }
  if (await hasPendingOffscreenDownloads()) {
    return;
  }
  if (activeOffscreenOperationCount > 0) {
    return;
  }
  if (!(await hasOffscreenDocument())) {
    return;
  }
  if (activeOffscreenOperationCount > 0) {
    return;
  }
  if (await hasPendingOffscreenDownloads()) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn("[ChatGPT Export] Failed to close offscreen document:", error);
  }
}

async function bootstrapOffscreenCleanup() {
  try {
    if (await hasPendingOffscreenDownloads()) {
      scheduleOffscreenCloseIfIdle();
      return;
    }
    await closeOffscreenDocumentIfPresent();
  } catch (error) {
    console.warn("[ChatGPT Export] Offscreen cleanup bootstrap failed:", error);
  }
}

async function runWithOffscreenOperation(task) {
  activeOffscreenOperationCount += 1;
  try {
    return await task();
  } finally {
    activeOffscreenOperationCount = Math.max(0, activeOffscreenOperationCount - 1);
  }
}

function createDownloadRequestId() {
  return "chatgpt-export-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

async function sendRuntimeMessage(message) {
  return await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Runtime messaging failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function releaseOffscreenBlobUrl(requestId) {
  try {
    await sendRuntimeMessage({
      type: "chatgpt-export-offscreen-revoke-blob-url",
      requestId
    });
  } catch (error) {
    console.warn("[ChatGPT Export] Failed to revoke offscreen blob URL:", error);
  }
}

async function releaseOffscreenBlobUrls(requestIds) {
  const list = Array.isArray(requestIds) ? requestIds : [];
  for (const requestId of list) {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      continue;
    }
    await releaseOffscreenBlobUrl(normalizedRequestId);
  }
}

async function trackOffscreenDownload(downloadId, requestId) {
  const normalizedDownloadId = normalizeDownloadTrackingId(downloadId);
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedDownloadId || !normalizedRequestId) {
    return;
  }

  await runWithOffscreenTrackingLock(async () => {
    offscreenRequestIdByDownloadId.set(Number(normalizedDownloadId), normalizedRequestId);

    const pending = await getPersistedPendingOffscreenDownloads();
    pending[normalizedDownloadId] = normalizedRequestId;
    await setPersistedPendingOffscreenDownloads(pending);
  });
}

async function untrackOffscreenDownload(downloadId) {
  const normalizedDownloadId = normalizeDownloadTrackingId(downloadId);
  if (!normalizedDownloadId) {
    return "";
  }

  return await runWithOffscreenTrackingLock(async () => {
    const numericDownloadId = Number(normalizedDownloadId);
    const pending = await getPersistedPendingOffscreenDownloads();
    const requestId = offscreenRequestIdByDownloadId.get(numericDownloadId) || String(pending[normalizedDownloadId] || "");

    offscreenRequestIdByDownloadId.delete(numericDownloadId);
    if (Object.prototype.hasOwnProperty.call(pending, normalizedDownloadId)) {
      delete pending[normalizedDownloadId];
      await setPersistedPendingOffscreenDownloads(pending);
    }

    return requestId;
  });
}

async function hasPendingOffscreenDownloads() {
  const pending = await reconcilePersistedPendingOffscreenDownloads();
  const inMemoryPendingCount = await reconcileInMemoryPendingOffscreenDownloads();
  return Object.keys(pending).length > 0 || inMemoryPendingCount > 0;
}

async function getPersistedPendingOffscreenDownloads() {
  const storageArea = getOffscreenTrackingStorageArea();
  if (!storageArea?.get) {
    return {};
  }

  return await new Promise((resolve) => {
    storageArea.get([OFFSCREEN_PENDING_DOWNLOADS_STORAGE_KEY], (data) => {
      if (chrome.runtime?.lastError) {
        resolve({});
        return;
      }

      resolve(normalizePersistedPendingDownloads(data ? data[OFFSCREEN_PENDING_DOWNLOADS_STORAGE_KEY] : null));
    });
  });
}

async function reconcilePersistedPendingOffscreenDownloads() {
  const result = await runWithOffscreenTrackingLock(async () => {
    const pending = await getPersistedPendingOffscreenDownloads();
    const entries = Object.entries(pending);
    if (entries.length === 0 || !chrome?.downloads?.search) {
      return {
        pending,
        droppedRequestIds: [],
        droppedDownloadIds: []
      };
    }

    const reconciled = {};
    const droppedRequestIds = new Set();
    const droppedDownloadIds = [];
    for (const [downloadId, requestId] of entries) {
      const item = await findDownloadItemById(Number(downloadId));
      if (item && String(item.state || "").trim().toLowerCase() === "in_progress") {
        reconciled[downloadId] = requestId;
        continue;
      }

      const normalizedRequestId = String(requestId || "").trim();
      if (normalizedRequestId) {
        droppedRequestIds.add(normalizedRequestId);
      }
      droppedDownloadIds.push(downloadId);
    }

    if (Object.keys(reconciled).length !== entries.length) {
      droppedDownloadIds.forEach((downloadId) => {
        const numericDownloadId = Number(downloadId);
        if (Number.isFinite(numericDownloadId)) {
          offscreenRequestIdByDownloadId.delete(numericDownloadId);
        }
      });
      await setPersistedPendingOffscreenDownloads(reconciled);
    }

    return {
      pending: reconciled,
      droppedRequestIds: Array.from(droppedRequestIds),
      droppedDownloadIds
    };
  });

  if (result.droppedRequestIds.length > 0) {
    await releaseOffscreenBlobUrls(result.droppedRequestIds);
  }

  return result.pending;
}

async function reconcileInMemoryPendingOffscreenDownloads() {
  const result = await runWithOffscreenTrackingLock(async () => {
    const entries = Array.from(offscreenRequestIdByDownloadId.entries());
    if (entries.length === 0 || !chrome?.downloads?.search) {
      return {
        pendingCount: entries.length,
        droppedRequestIds: []
      };
    }

    const keptEntries = new Map();
    const droppedRequestIds = new Set();
    for (const [downloadId, requestId] of entries) {
      const item = await findDownloadItemById(downloadId);
      if (item && String(item.state || "").trim().toLowerCase() === "in_progress") {
        keptEntries.set(downloadId, requestId);
        continue;
      }

      const normalizedRequestId = String(requestId || "").trim();
      if (normalizedRequestId) {
        droppedRequestIds.add(normalizedRequestId);
      }
    }

    if (keptEntries.size !== entries.length) {
      offscreenRequestIdByDownloadId.clear();
      keptEntries.forEach((requestId, downloadId) => {
        offscreenRequestIdByDownloadId.set(downloadId, requestId);
      });
    }

    return {
      pendingCount: keptEntries.size,
      droppedRequestIds: Array.from(droppedRequestIds)
    };
  });

  if (result.droppedRequestIds.length > 0) {
    await releaseOffscreenBlobUrls(result.droppedRequestIds);
  }

  return result.pendingCount;
}

async function setPersistedPendingOffscreenDownloads(pending) {
  const storageArea = getOffscreenTrackingStorageArea();
  if (!storageArea?.set) {
    return;
  }

  const normalizedPending = normalizePersistedPendingDownloads(pending);
  if (Object.keys(normalizedPending).length === 0 && storageArea.remove) {
    await new Promise((resolve) => {
      storageArea.remove([OFFSCREEN_PENDING_DOWNLOADS_STORAGE_KEY], () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    });
    return;
  }

  await new Promise((resolve) => {
    storageArea.set(
      {
        [OFFSCREEN_PENDING_DOWNLOADS_STORAGE_KEY]: normalizedPending
      },
      () => {
        void chrome.runtime?.lastError;
        resolve();
      }
    );
  });
}

function getOffscreenTrackingStorageArea() {
  return chrome?.storage?.session || chrome?.storage?.local || null;
}

function normalizePersistedPendingDownloads(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized = {};
  Object.entries(value).forEach(([downloadId, requestId]) => {
    const normalizedDownloadId = normalizeDownloadTrackingId(downloadId);
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedDownloadId || !normalizedRequestId) {
      return;
    }
    normalized[normalizedDownloadId] = normalizedRequestId;
  });
  return normalized;
}

function normalizeDownloadTrackingId(value) {
  const numericId = Number(value);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return "";
  }
  return String(Math.trunc(numericId));
}

async function findDownloadItemById(downloadId) {
  if (!chrome?.downloads?.search || !Number.isFinite(downloadId) || downloadId <= 0) {
    return null;
  }

  return await new Promise((resolve) => {
    chrome.downloads.search({ id: Math.trunc(downloadId) }, (items) => {
      if (chrome.runtime?.lastError) {
        resolve(null);
        return;
      }
      resolve(Array.isArray(items) && items.length > 0 ? items[0] : null);
    });
  });
}

async function shouldIgnoreOffscreenCreateError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
  if (await hasOffscreenDocument()) {
    return true;
  }

  return (
    message.includes("already exists") ||
    message.includes("single offscreen document") ||
    message.includes("only a single offscreen document")
  );
}

async function finalizeTrackedDownloadIfAlreadyTerminal(downloadId) {
  const item = await findDownloadItemById(downloadId);
  const state = String(item?.state || "").trim().toLowerCase();
  if (state !== "complete" && state !== "interrupted") {
    return;
  }

  const requestId = await untrackOffscreenDownload(downloadId);
  if (!requestId) {
    return;
  }

  await releaseOffscreenBlobUrl(requestId);
}

async function runWithOffscreenTrackingLock(task) {
  const previousLock = offscreenTrackingLock;
  let releaseLock = null;
  offscreenTrackingLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousLock.catch(() => {});

  try {
    return await task();
  } finally {
    if (typeof releaseLock === "function") {
      releaseLock();
    }
  }
}

function normalizeConflictAction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "overwrite" || normalized === "prompt") {
    return normalized;
  }
  return "uniquify";
}

function normalizeMimeType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "text/plain;charset=utf-8";
  }
  if (/;\s*charset=/i.test(normalized)) {
    return normalized;
  }
  return normalized + ";charset=utf-8";
}
