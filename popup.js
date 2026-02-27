const exportBtn = document.getElementById("exportBtn");
const batchBtn = document.getElementById("batchBtn");
const resumeBatchBtn = document.getElementById("resumeBatchBtn");
const cancelBatchBtn = document.getElementById("cancelBatchBtn");
const yearFolderToggle = document.getElementById("yearFolderToggle");
const debugLogToggle = document.getElementById("debugLogToggle");
const hint = document.getElementById("hint");

const RUNTIME_STATE_STORAGE_KEY = "__chatgpt_export_runtime_state__";
const STATE_POLL_INTERVAL_MS = 1400;
const TAB_MESSAGE_TIMEOUT_MS = 1400;
const RUNTIME_STATE_STALE_MS = 90000;
const BATCH_FOREGROUND_WARNING = "Hold this tab in foreground. Do nothing while batch export is running. It can take a long, long time.";

let activeTabId = null;
let stateReady = false;
let pollTimer = null;
let refreshInFlight = false;

init().catch((error) => {
  setHint("Fehler beim Laden: " + (error?.message || String(error)), "error");
  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false
  });
});

exportBtn.addEventListener("click", async () => {
  await startAction("chatgpt-export-trigger", "Export gestartet. Fortschritt im Tab sichtbar.");
});

batchBtn.addEventListener("click", async () => {
  if (!confirmBatchForegroundWarning()) {
    setHint("Batch start cancelled.", "");
    return;
  }
  await startAction(
    "chatgpt-export-batch-trigger",
    "Batch export started. " + BATCH_FOREGROUND_WARNING,
    {
      options: {
        yearOnlyFolder: yearFolderToggle.checked,
        debugLogEnabled: debugLogToggle.checked
      }
    }
  );
});

resumeBatchBtn.addEventListener("click", async () => {
  if (!confirmBatchForegroundWarning()) {
    setHint("Batch resume cancelled.", "");
    return;
  }
  await startAction("chatgpt-export-batch-resume-trigger", "Batch resume started. " + BATCH_FOREGROUND_WARNING);
});

cancelBatchBtn.addEventListener("click", async () => {
  await startAction("chatgpt-export-cancel-trigger", "Stopp angefordert.");
});

yearFolderToggle.addEventListener("change", async () => {
  if (!stateReady || activeTabId == null) {
    yearFolderToggle.checked = !yearFolderToggle.checked;
    return;
  }

  const yearOnly = yearFolderToggle.checked;
  try {
    const response = await sendToActiveTabWithTimeout({
      type: "chatgpt-export-batch-set-folder-mode",
      yearOnly
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Ordner-Modus konnte nicht gespeichert werden.");
    }
    setHint(yearOnly ? "Batch-Ordner: nur Jahr." : "Batch-Ordner: Jahr und Monat.", "success");
  } catch (error) {
    yearFolderToggle.checked = !yearOnly;
    setHint("Ordner-Modus fehlgeschlagen: " + (error?.message || String(error)), "error");
  }
});

debugLogToggle.addEventListener("change", async () => {
  if (!stateReady || activeTabId == null) {
    debugLogToggle.checked = !debugLogToggle.checked;
    return;
  }

  const enabled = debugLogToggle.checked;
  try {
    const response = await sendToActiveTabWithTimeout({
      type: "chatgpt-export-batch-set-debug-log-mode",
      enabled
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Debug-Log-Modus konnte nicht gespeichert werden.");
    }
    setHint(enabled ? "Batch-Debug-Log aktiv." : "Batch-Debug-Log deaktiviert.", "success");
  } catch (error) {
    debugLogToggle.checked = !enabled;
    setHint("Debug-Log-Modus fehlgeschlagen: " + (error?.message || String(error)), "error");
  }
});

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

async function init() {
  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false
  });

  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    setHint("Kein aktiver Tab gefunden.", "error");
    return;
  }

  activeTabId = tab.id;
  if (!isChatgptUrl(tab.url)) {
    setHint("Bitte einen Tab auf chatgpt.com oeffnen.", "error");
    return;
  }

  stateReady = true;
  await refreshState();
  startStatePolling();
}

function startStatePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(() => {
    void refreshState({ fromPoll: true });
  }, STATE_POLL_INTERVAL_MS);
}

async function startAction(type, successText, extraPayload = null) {
  if (!stateReady || activeTabId == null) {
    setHint("Tab ist nicht bereit.", "error");
    return;
  }

  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false
  });
  setHint("Starte...", "");

  try {
    const message = { type };
    if (extraPayload && typeof extraPayload === "object") {
      Object.assign(message, extraPayload);
    }

    const response = await sendToActiveTabWithTimeout(message, TAB_MESSAGE_TIMEOUT_MS + 800);
    if (!response?.ok) {
      throw new Error(response?.error || "Aktion konnte nicht gestartet werden.");
    }

    setHint(successText, "success");
  } catch (error) {
    setHint("Fehler: " + (error?.message || String(error)), "error");
  } finally {
    await refreshState();
  }
}

async function refreshState(options = {}) {
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = true;

  try {
    const [contentState, runtimeState] = await Promise.all([
      getContentStateSafely(),
      getRuntimeStateFromStorage()
    ]);

    const merged = mergeState(contentState, runtimeState);
    applyUiFromState(merged, options);
  } finally {
    refreshInFlight = false;
  }
}

async function getContentStateSafely() {
  if (activeTabId == null) {
    return null;
  }
  try {
    const response = await sendToActiveTabWithTimeout({ type: "chatgpt-export-get-state" });
    if (!response?.ok) {
      return null;
    }
    return response;
  } catch (_error) {
    return null;
  }
}

async function getRuntimeStateFromStorage() {
  if (!chrome?.storage?.local) {
    return null;
  }
  return await new Promise((resolve) => {
    chrome.storage.local.get([RUNTIME_STATE_STORAGE_KEY], (data) => {
      if (chrome.runtime?.lastError) {
        resolve(null);
        return;
      }
      resolve(data ? data[RUNTIME_STATE_STORAGE_KEY] || null : null);
    });
  });
}

function mergeState(contentState, runtimeState) {
  if (contentState) {
    return {
      source: "content",
      isConversationPage: Boolean(contentState.isConversationPage),
      isExporting: Boolean(contentState.isExporting),
      batchYearFolderOnly: Boolean(contentState.batchYearFolderOnly),
      batchDebugLogEnabled: Boolean(contentState.batchDebugLogEnabled),
      hasBatchResume: Boolean(contentState.hasBatchResume),
      isBatchRunning: Boolean(contentState.isBatchRunning),
      runtimeStatusMessage: String(contentState.runtimeStatusMessage || ""),
      runtimeStatusKind: String(contentState.runtimeStatusKind || ""),
      runtimeStatusUpdatedAt: Number(contentState.runtimeStatusUpdatedAt) || 0,
      runtimeOperation: String(contentState.runtimeOperation || ""),
      runtimeStartedAt: Number(contentState.runtimeStartedAt) || 0,
      batchTotalCount: Math.max(0, Number(contentState.batchTotalCount) || 0),
      batchDoneCount: Math.max(0, Number(contentState.batchDoneCount) || 0),
      batchSuccessCount: Math.max(0, Number(contentState.batchSuccessCount) || 0),
      batchFailureCount: Math.max(0, Number(contentState.batchFailureCount) || 0),
      batchSkippedCount: Math.max(0, Number(contentState.batchSkippedCount) || 0)
    };
  }

  const freshRuntime = isFreshRuntimeState(runtimeState) ? runtimeState : null;
  if (freshRuntime) {
    return {
      source: "storage",
      isConversationPage: false,
      isExporting: Boolean(freshRuntime.isExporting),
      batchYearFolderOnly: Boolean(freshRuntime.batchYearFolderOnly),
      batchDebugLogEnabled: Boolean(freshRuntime.batchDebugLogEnabled),
      hasBatchResume: Boolean(freshRuntime.hasBatchResume),
      isBatchRunning: Boolean(freshRuntime.isBatchRunning),
      runtimeStatusMessage: String(freshRuntime.statusMessage || ""),
      runtimeStatusKind: String(freshRuntime.statusKind || ""),
      runtimeStatusUpdatedAt: Number(freshRuntime.statusUpdatedAt) || 0,
      runtimeOperation: String(freshRuntime.operation || ""),
      runtimeStartedAt: Number(freshRuntime.startedAt) || 0,
      batchTotalCount: Math.max(0, Number(freshRuntime.batchTotalCount) || 0),
      batchDoneCount: Math.max(0, Number(freshRuntime.batchDoneCount) || 0),
      batchSuccessCount: Math.max(0, Number(freshRuntime.batchSuccessCount) || 0),
      batchFailureCount: Math.max(0, Number(freshRuntime.batchFailureCount) || 0),
      batchSkippedCount: Math.max(0, Number(freshRuntime.batchSkippedCount) || 0)
    };
  }

  return null;
}

function applyUiFromState(state, options = {}) {
  if (!state) {
    setControlsEnabled({
      canExport: false,
      canBatch: false,
      canResumeBatch: false,
      canCancelBatch: false,
      canYearToggle: false,
      canDebugToggle: false
    });
    if (!options.fromPoll) {
      setHint("Status konnte nicht gelesen werden.", "error");
    }
    return;
  }

  yearFolderToggle.checked = Boolean(state.batchYearFolderOnly);
  debugLogToggle.checked = Boolean(state.batchDebugLogEnabled);

  const isBusy = Boolean(state.isExporting);
  const canExport = Boolean(state.isConversationPage) && !isBusy;
  const canBatch = !isBusy;
  const canResumeBatch = Boolean(state.hasBatchResume) && !isBusy;
  const canCancelBatch = isBusy;
  const canYearToggle = !isBusy;
  const canDebugToggle = !isBusy;

  setControlsEnabled({
    canExport,
    canBatch,
    canResumeBatch,
    canCancelBatch,
    canYearToggle,
    canDebugToggle
  });

  if (isBusy) {
    const progress = buildBusyHint(state);
    setHint(progress, "");
    return;
  }

  if (!state.isConversationPage) {
    if (state.source === "storage") {
      setHint("Tab reagiert langsam. Letzter Lauf ist nicht mehr aktiv.", "error");
      return;
    }
    setHint("Batch verfuegbar. Einzel-Export nur in /c/...", "success");
    return;
  }

  setHint("Bereit.", "success");
}

function buildBusyHint(state) {
  const rawMessage = String(state.runtimeStatusMessage || "").trim();
  const started = Number(state.runtimeStartedAt) || 0;
  const since = started > 0 ? " (seit " + formatDuration(Date.now() - started) + ")" : "";
  const mode = state.runtimeOperation === "batch" ? "Batch" : "Export";
  const progressText = buildBatchProgressText(state);
  const detailText = rawMessage || (mode + " laeuft...");
  const text = progressText ? (progressText + " | " + detailText) : detailText;

  if (state.source === "storage") {
    return mode + " laeuft, Tab antwortet langsam: " + text + since;
  }
  return mode + " laeuft: " + text + since;
}

function buildBatchProgressText(state) {
  if (state.runtimeOperation !== "batch") {
    return "";
  }

  const total = Math.max(0, Number(state.batchTotalCount) || 0);
  if (total <= 0) {
    return "";
  }

  const done = Math.min(total, Math.max(0, Number(state.batchDoneCount) || 0));
  const success = Math.min(total, Math.max(0, Number(state.batchSuccessCount) || 0));
  const failure = Math.min(total, Math.max(0, Number(state.batchFailureCount) || 0));
  const skipped = Math.min(total, Math.max(0, Number(state.batchSkippedCount) || 0));
  const current = done < total ? ", aktuell " + (done + 1) + "/" + total : "";

  return (
    done +
    "/" + total +
    " abgeschlossen (" +
    success + " gespeichert, " +
    failure + " Fehler, " +
    skipped + " uebersprungen" +
    current +
    ")"
  );
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const hours = Math.floor(min / 60);
    const remMin = min % 60;
    return hours + "h " + String(remMin).padStart(2, "0") + "m";
  }
  return min + "m " + String(sec).padStart(2, "0") + "s";
}

function isFreshRuntimeState(runtimeState) {
  if (!runtimeState || typeof runtimeState !== "object") {
    return false;
  }
  const heartbeatAt = Number(runtimeState.heartbeatAt) || 0;
  if (heartbeatAt <= 0) {
    return false;
  }
  return (Date.now() - heartbeatAt) <= RUNTIME_STATE_STALE_MS;
}

function setControlsEnabled(state) {
  const nextState = state || {};
  exportBtn.disabled = !nextState.canExport;
  batchBtn.disabled = !nextState.canBatch;
  resumeBatchBtn.disabled = !nextState.canResumeBatch;
  cancelBatchBtn.disabled = !nextState.canCancelBatch;
  yearFolderToggle.disabled = !nextState.canYearToggle;
  debugLogToggle.disabled = !nextState.canDebugToggle;
}

function setHint(text, kind) {
  hint.textContent = text;
  hint.className = "hint" + (kind ? " " + kind : "");
}

function confirmBatchForegroundWarning() {
  return window.confirm(
    "Batch export warning:\n\n" +
    BATCH_FOREGROUND_WARNING +
    "\n\nContinue?"
  );
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return Array.isArray(tabs) ? tabs[0] : null;
}

function isChatgptUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }
    return /(^|\.)chatgpt\.com$/i.test(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

async function sendToActiveTabWithTimeout(message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
  return await Promise.race([
    sendToActiveTab(message),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Zeitueberschreitung bei Tab-Kommunikation."));
      }, timeoutMs);
    })
  ]);
}

function sendToActiveTab(message) {
  if (activeTabId == null) {
    return Promise.reject(new Error("Kein aktiver Tab."));
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Kommunikation fehlgeschlagen."));
        return;
      }
      resolve(response);
    });
  });
}
