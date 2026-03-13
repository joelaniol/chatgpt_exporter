const startBtn = document.getElementById("startBtn");
const scopeSelect = document.getElementById("scopeSelect");
const formatSelect = document.getElementById("formatSelect");
const metadataToggle = document.getElementById("metadataToggle");
const metadataToggleRow = document.getElementById("metadataToggleRow");
const selectionHelp = document.getElementById("selectionHelp");
const batchOptionsPanel = document.getElementById("batchOptionsPanel");
const runActions = document.getElementById("runActions");
const resumeBatchBtn = document.getElementById("resumeBatchBtn");
const cancelBatchBtn = document.getElementById("cancelBatchBtn");
const yearFolderToggle = document.getElementById("yearFolderToggle");
const debugLogToggle = document.getElementById("debugLogToggle");
const hint = document.getElementById("hint");

const RUNTIME_STATE_STORAGE_KEY = "__chatgpt_export_runtime_state_by_tab__";
const STATE_POLL_INTERVAL_MS = 1400;
const TAB_MESSAGE_TIMEOUT_MS = 1400;
const RUNTIME_STATE_STALE_MS = 90000;
const ATTACH_READY_WAIT_MS = 5000;
const ATTACH_READY_POLL_MS = 250;
const POPUP_CLOSE_DELAY_MS = 120;
const OPEN_CHAT_HINT = "Open one chat if you want to save only the current chat.";
const BATCH_FOREGROUND_WARNING = "Keep this ChatGPT tab open and visible until the save is finished. Large chat libraries can take a while.";

let activeTabId = null;
let activeTabUrl = "";
let stateReady = false;
let pollTimer = null;
let refreshInFlight = false;
let latestState = null;
let scopeTouchedByUser = false;
let formatTouchedByUser = false;
let metadataTouchedByUser = false;
let installAttachRecoveryTriggered = false;
let installAttachRecoveryAt = 0;
let initialStateRefreshPending = true;
let lastSeenBatchResumeFormat = "";
let lastSeenBatchResumeDetailedMetadata = null;
let attachRecoveryPromise = null;

init().catch((error) => {
  setHint("Could not open the extension: " + (error?.message || String(error)), "error");
  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false,
    isBusy: false
  });
});

scopeSelect.addEventListener("change", () => {
  scopeTouchedByUser = true;
  updateSelectionUi();
  if (latestState) {
    applyUiFromState(latestState, { fromSelection: true });
  }
});

formatSelect.addEventListener("change", () => {
  formatTouchedByUser = true;
  updateSelectionUi();
  if (latestState) {
    applyUiFromState(latestState, { fromSelection: true });
  }
});

metadataToggle.addEventListener("change", () => {
  metadataTouchedByUser = true;
  updateSelectionUi();
  if (latestState) {
    applyUiFromState(latestState, { fromSelection: true });
  }
});

startBtn.addEventListener("click", async () => {
  if (!stateReady || activeTabId == null || startBtn.disabled) {
    return;
  }

  scopeTouchedByUser = true;
  const scope = getSelectedScope();
  const format = getSelectedFormat();
  const detailedMetadata = getSelectedDetailedMetadata();
  if (scope === "batch") {
    const startFresh = Boolean(latestState?.hasBatchResume);
    if (!confirmBatchForegroundWarning({
      mode: startFresh ? "start-fresh" : "start-batch",
      format,
      detailedMetadata
    })) {
      setHint("Saving many chats was cancelled.", "");
      return;
    }

    await startAction(
      "chatgpt-export-batch-trigger",
      getBatchExportStartedHint(format, detailedMetadata),
      {
        options: {
          yearOnlyFolder: yearFolderToggle.checked,
          debugLogEnabled: debugLogToggle.checked,
          format,
          detailedMetadata,
          startFresh
        }
      }
    );
    return;
  }

  await startAction(
    "chatgpt-export-trigger",
    getSingleExportStartedHint(format, detailedMetadata),
    { format, detailedMetadata },
    { closeOnSuccess: true }
  );
});

resumeBatchBtn.addEventListener("click", async () => {
  if (!confirmBatchForegroundWarning({
    mode: "resume-batch",
    format: latestState?.batchExportFormat || "html",
    detailedMetadata: Boolean(latestState?.batchDetailedMetadata)
  })) {
    setHint("Continue was cancelled.", "");
    return;
  }
  await startAction("chatgpt-export-batch-resume-trigger", "Continuing your multi-chat save. " + BATCH_FOREGROUND_WARNING);
});

cancelBatchBtn.addEventListener("click", async () => {
  await startAction("chatgpt-export-cancel-trigger", "Stop requested.");
});

yearFolderToggle.addEventListener("change", async () => {
  if (!stateReady || activeTabId == null) {
    yearFolderToggle.checked = !yearFolderToggle.checked;
    return;
  }

  const yearOnly = yearFolderToggle.checked;
  try {
    const response = await sendToActiveTabWithTimeout(
      {
        type: "chatgpt-export-batch-set-folder-mode",
        yearOnly
      },
      TAB_MESSAGE_TIMEOUT_MS,
      { allowRecover: true, recoveryReason: "action", allowReloadFallback: true }
    );
    if (!response?.ok) {
      throw new Error(response?.error || "Folder setting could not be saved.");
    }
    setHint(yearOnly ? "Chats will be grouped by year only." : "Chats will be grouped by year and month.", "success");
  } catch (error) {
    yearFolderToggle.checked = !yearOnly;
    setHint("Could not save folder setting: " + (error?.message || String(error)), "error");
  }
});

debugLogToggle.addEventListener("change", async () => {
  if (!stateReady || activeTabId == null) {
    debugLogToggle.checked = !debugLogToggle.checked;
    return;
  }

  const enabled = debugLogToggle.checked;
  try {
    const response = await sendToActiveTabWithTimeout(
      {
        type: "chatgpt-export-batch-set-debug-log-mode",
        enabled
      },
      TAB_MESSAGE_TIMEOUT_MS,
      { allowRecover: true, recoveryReason: "action", allowReloadFallback: true }
    );
    if (!response?.ok) {
      throw new Error(response?.error || "Help file setting could not be saved.");
    }
    setHint(enabled ? "An extra help file will be saved during long multi-chat runs." : "The extra help file is turned off.", "success");
  } catch (error) {
    debugLogToggle.checked = !enabled;
    setHint("Could not save help file setting: " + (error?.message || String(error)), "error");
  }
});

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

async function init() {
  updateSelectionUi();
  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false,
    isBusy: false
  });

  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    setHint("No active Chrome tab was found.", "error");
    return;
  }

  activeTabId = tab.id;
  activeTabUrl = String(tab.url || "");
  if (!isChatgptUrl(tab.url)) {
    setHint("Open ChatGPT in this tab first.", "error");
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

async function startAction(type, successText, extraPayload = null, options = {}) {
  if (!stateReady || activeTabId == null) {
    setHint("This tab is not ready yet.", "error");
    return;
  }

  const closeOnSuccess = Boolean(options?.closeOnSuccess);
  let closeRequested = false;

  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false,
    isBusy: true
  });
  setHint("Getting things ready...", "");

  try {
    const message = { type };
    if (extraPayload && typeof extraPayload === "object") {
      Object.assign(message, extraPayload);
    }

    const response = await sendToActiveTabWithTimeout(
      message,
      TAB_MESSAGE_TIMEOUT_MS + 800,
      { allowRecover: true, recoveryReason: "action", allowReloadFallback: true }
    );
    if (!response?.ok) {
      throw new Error(response?.error || "The action could not be started.");
    }

    setHint(successText, "success");
    if (closeOnSuccess) {
      closeRequested = true;
      window.setTimeout(() => {
        window.close();
      }, POPUP_CLOSE_DELAY_MS);
    }
  } catch (error) {
    setHint("Could not start: " + (error?.message || String(error)), "error");
  } finally {
    if (!closeRequested) {
      await refreshState();
    }
  }
}

async function refreshState(options = {}) {
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = true;

  try {
    const [runtimeState, tabUrl] = await Promise.all([
      getRuntimeStateFromStorage(),
      getTrackedTabUrlSafely()
    ]);
    const isInitialRefresh = initialStateRefreshPending;
    initialStateRefreshPending = false;
    if (typeof tabUrl === "string" && tabUrl) {
      activeTabUrl = tabUrl;
    }

    let contentState = await getContentStateSafely();
    if (!contentState && shouldTriggerInstallAttachRecovery(contentState, { isInitialRefresh, fromPoll: Boolean(options?.fromPoll) })) {
      const recovered = await ensureActiveTabReceiverReady({
        reason: "open",
        allowReloadFallback: true
      });
      if (recovered) {
        contentState = await getContentStateSafely();
      }
    }

    if (contentState) {
      installAttachRecoveryTriggered = false;
      installAttachRecoveryAt = 0;
    }

    if (shouldShowInstallAttachRecoveryPending(contentState)) {
      applyInstallAttachRecoveryUi(
        "Checking this ChatGPT tab...",
        ""
      );
      return;
    }

    if (shouldShowInstallAttachRecoveryFailed(contentState)) {
      applyInstallAttachRecoveryUi(
        "Please reload this ChatGPT tab once. The extension could not attach automatically yet.",
        "error"
      );
      return;
    }

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
  if (activeTabId == null) {
    return null;
  }
  const storageArea = chrome?.storage?.session || chrome?.storage?.local || null;
  if (!storageArea?.get) {
    return null;
  }
  return await new Promise((resolve) => {
    storageArea.get([RUNTIME_STATE_STORAGE_KEY], (data) => {
      if (chrome.runtime?.lastError) {
        resolve(null);
        return;
      }
      const runtimeStatesByTab = data && typeof data[RUNTIME_STATE_STORAGE_KEY] === "object"
        ? data[RUNTIME_STATE_STORAGE_KEY]
        : null;
      const tabState = runtimeStatesByTab ? runtimeStatesByTab[String(activeTabId)] : null;
      resolve(tabState && typeof tabState === "object" ? tabState : null);
    });
  });
}

async function getTrackedTabUrlSafely() {
  if (activeTabId == null || !chrome?.tabs?.get) {
    return "";
  }
  try {
    const tab = await chrome.tabs.get(activeTabId);
    return String(tab?.url || "");
  } catch (_error) {
    return "";
  }
}

function shouldTriggerInstallAttachRecovery(contentState, options = {}) {
  return (
    Boolean(options?.isInitialRefresh) &&
    !Boolean(options?.fromPoll) &&
    !contentState &&
    isChatgptUrl(activeTabUrl) &&
    !installAttachRecoveryTriggered
  );
}

function shouldShowInstallAttachRecoveryPending(contentState) {
  return (
    installAttachRecoveryTriggered &&
    !contentState &&
    (Date.now() - installAttachRecoveryAt) < 9000
  );
}

function shouldShowInstallAttachRecoveryFailed(contentState) {
  return (
    installAttachRecoveryTriggered &&
    !contentState &&
    (Date.now() - installAttachRecoveryAt) >= 9000
  );
}

function applyInstallAttachRecoveryUi(message, kind) {
  latestState = null;
  setControlsEnabled({
    canExport: false,
    canBatch: false,
    canResumeBatch: false,
    canCancelBatch: false,
    canYearToggle: false,
    canDebugToggle: false,
    isBusy: false
  });
  updateSelectionUi();
  setHint(message, kind);
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
      runtimeExportFormat: String(contentState.runtimeExportFormat || "html"),
      runtimeDetailedMetadata: Boolean(contentState.runtimeDetailedMetadata),
      runtimeStartedAt: Number(contentState.runtimeStartedAt) || 0,
      batchTotalCount: Math.max(0, Number(contentState.batchTotalCount) || 0),
      batchDoneCount: Math.max(0, Number(contentState.batchDoneCount) || 0),
      batchSuccessCount: Math.max(0, Number(contentState.batchSuccessCount) || 0),
      batchFailureCount: Math.max(0, Number(contentState.batchFailureCount) || 0),
      batchSkippedCount: Math.max(0, Number(contentState.batchSkippedCount) || 0),
      batchExportFormat: String(contentState.batchExportFormat || "html"),
      batchDetailedMetadata: Boolean(contentState.batchDetailedMetadata)
    };
  }

  const freshRuntime = shouldUseStorageFallback(runtimeState) ? runtimeState : null;
  if (freshRuntime) {
    return {
      source: "storage",
      isConversationPage: isConversationTabUrl(activeTabUrl),
      isExporting: Boolean(freshRuntime.isExporting),
      batchYearFolderOnly: Boolean(freshRuntime.batchYearFolderOnly),
      batchDebugLogEnabled: Boolean(freshRuntime.batchDebugLogEnabled),
      hasBatchResume: Boolean(freshRuntime.hasBatchResume),
      isBatchRunning: Boolean(freshRuntime.isBatchRunning),
      runtimeStatusMessage: String(freshRuntime.statusMessage || ""),
      runtimeStatusKind: String(freshRuntime.statusKind || ""),
      runtimeStatusUpdatedAt: Number(freshRuntime.statusUpdatedAt) || 0,
      runtimeOperation: String(freshRuntime.operation || ""),
      runtimeExportFormat: String(freshRuntime.exportFormat || "html"),
      runtimeDetailedMetadata: Boolean(freshRuntime.detailedMetadata),
      runtimeStartedAt: Number(freshRuntime.startedAt) || 0,
      batchTotalCount: Math.max(0, Number(freshRuntime.batchTotalCount) || 0),
      batchDoneCount: Math.max(0, Number(freshRuntime.batchDoneCount) || 0),
      batchSuccessCount: Math.max(0, Number(freshRuntime.batchSuccessCount) || 0),
      batchFailureCount: Math.max(0, Number(freshRuntime.batchFailureCount) || 0),
      batchSkippedCount: Math.max(0, Number(freshRuntime.batchSkippedCount) || 0),
      batchExportFormat: String(freshRuntime.batchExportFormat || "html"),
      batchDetailedMetadata: Boolean(freshRuntime.batchDetailedMetadata)
    };
  }

  return null;
}

function shouldUseStorageFallback(runtimeState) {
  if (!isFreshRuntimeState(runtimeState)) {
    return false;
  }
  if (!isChatgptUrl(activeTabUrl)) {
    return false;
  }
  if (!(
    runtimeState?.isExporting ||
    runtimeState?.isBatchRunning ||
    runtimeState?.hasBatchResume
  )) {
    return false;
  }

  const runtimePageUrl = normalizeTabUrlForComparison(runtimeState?.pageUrl || "");
  const activePageUrl = normalizeTabUrlForComparison(activeTabUrl);
  if (!runtimePageUrl || !activePageUrl) {
    return false;
  }

  const runtimeConversationId = getConversationIdFromTabUrl(runtimeState?.pageUrl || "");
  const activeConversationId = getConversationIdFromTabUrl(activeTabUrl);
  if (runtimeConversationId || activeConversationId) {
    return Boolean(runtimeConversationId) && runtimeConversationId === activeConversationId;
  }

  return runtimePageUrl === activePageUrl;
}

function applyUiFromState(state, options = {}) {
  latestState = state;

  if (!state) {
    setControlsEnabled({
      canExport: false,
      canBatch: false,
      canResumeBatch: false,
      canCancelBatch: false,
      canYearToggle: false,
      canDebugToggle: false,
      isBusy: false
    });
    updateSelectionUi();
    if (!options.fromPoll) {
      setHint("Status could not be loaded.", "error");
    }
    return;
  }

  syncResumeFormatTracking(state);
  autoSelectPreferredScope(state);
  syncSelectionFromActiveState(state);

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
    canDebugToggle,
    isBusy
  });
  updateSelectionUi();
  updateResumeButtonLabel(state);

  if (isBusy) {
    setHint(buildBusyHint(state), "");
    return;
  }

  const nextHint = buildIdleHint(state);
  if (!options.fromSelection || nextHint) {
    setHint(nextHint.text, nextHint.kind);
  }
}

function buildIdleHint(state) {
  const scope = getSelectedScope();
  const formatLabel = describeSelectedExportMode();
  const resumeFormatLabel = describeBatchResumeExportMode(state);
  const resumeOptionDiffers = doesBatchResumeOptionDifferFromSelection(state);

  if (scope === "single") {
    if (!state.isConversationPage) {
      if (state.hasBatchResume) {
        return {
          text: OPEN_CHAT_HINT + " A paused many-chat save is ready to continue (" + resumeFormatLabel + ").",
          kind: "success"
        };
      }
      return { text: OPEN_CHAT_HINT, kind: "error" };
    }

    if (state.hasBatchResume) {
      return {
        text: "Ready to save this chat as " + formatLabel + ". A paused many-chat save is also ready to continue.",
        kind: "success"
      };
    }

    return {
      text: "Ready to save this chat as " + formatLabel + ".",
      kind: "success"
    };
  }

  if (state.hasBatchResume) {
    if (resumeOptionDiffers) {
      return {
        text: "A paused many-chat save is ready to continue as " + describeBatchResumeExportMode(state) + ". Start a new many-chat save as " + describeSelectedExportMode() + " or use Continue Saving.",
        kind: "success"
      };
    }
    return {
      text: "Ready to save many chats as " + formatLabel + ". A paused many-chat save is also ready to continue (" + resumeFormatLabel + ").",
      kind: "success"
    };
  }

  return {
    text: "Ready to save many chats as " + formatLabel + ".",
    kind: "success"
  };
}

function buildBusyHint(state) {
  const rawMessage = String(state.runtimeStatusMessage || "").trim();
  const started = Number(state.runtimeStartedAt) || 0;
  const since = started > 0 ? " (" + formatDuration(Date.now() - started) + ")" : "";
  const activeFormat = getActiveFormatFromState(state) || getSelectedFormat();
  const activeDetailedMetadata = getActiveDetailedMetadataFromState(state);
  const formatLabel = describeSelectedExportMode({
    format: activeFormat,
    detailedMetadata: activeDetailedMetadata
  });
  const mode = state.runtimeOperation === "batch"
    ? "Saving many chats as " + formatLabel
    : state.runtimeOperation === "single-resume"
      ? "Trying to resume this chat save as " + formatLabel
      : "Saving this chat as " + formatLabel;
  const progressText = buildBatchProgressText(state);
  const detailText = rawMessage || "Please wait...";
  const text = progressText ? (progressText + " " + detailText) : detailText;

  if (state.source === "storage") {
    return mode + ". Last update: " + text + since;
  }
  return mode + ". " + text + since;
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
  let summary = done + " of " + total + " chats done.";
  summary += " " + success + " saved";
  if (failure > 0) {
    summary += ", " + failure + " issues";
  }
  if (skipped > 0) {
    summary += ", " + skipped + " skipped";
  }
  summary += ".";
  if (done < total) {
    summary += " Working on chat " + (done + 1) + ".";
  }
  return summary;
}

function updateSelectionUi() {
  const scope = getSelectedScope();
  const format = getSelectedFormat();
  const metadataOptionVisible = shouldShowDetailedMetadataOption(format);
  if (batchOptionsPanel) {
    batchOptionsPanel.hidden = scope !== "batch";
  }
  if (metadataToggleRow) {
    metadataToggleRow.hidden = !metadataOptionVisible;
  }
  if (selectionHelp) {
    selectionHelp.textContent = buildSelectionHelp(scope, format);
  }
  updateStartButtonLabel(latestState);
}

function buildSelectionHelp(scope, format) {
  const state = latestState;
  if (
    scope === "batch" &&
    !state?.isExporting &&
    state?.hasBatchResume &&
    doesBatchResumeOptionDifferFromSelection(state)
  ) {
    return (
      "Continue Saving will keep using " +
      describeBatchResumeExportMode(state) +
      ". The options above only change a new many-chat save."
    );
  }

  if (scope === "batch") {
    if (format === "txt") {
      if (getSelectedDetailedMetadata()) {
        return "This saves many chats as plain text files with detailed metadata for later parsing. Keep this ChatGPT tab visible while the save runs.";
      }
      return "This saves many chats as plain text files. Keep this ChatGPT tab visible while the save runs.";
    }
    if (format === "md") {
      if (getSelectedDetailedMetadata()) {
        return "This saves many chats as Markdown with detailed metadata for later parsing. Keep this ChatGPT tab visible while the save runs.";
      }
      return "This saves many chats as Markdown files. Keep this ChatGPT tab visible while the save runs.";
    }
    return "Web Page is best for most people. Keep this ChatGPT tab visible while the save runs.";
  }

  if (format === "txt") {
    if (getSelectedDetailedMetadata()) {
      return "Text File with detailed metadata adds extra technical fields for later processing.";
    }
    return "Text File saves simple plain text. Good if you want something easy to process later.";
  }
  if (format === "md") {
    if (getSelectedDetailedMetadata()) {
      return "Markdown with detailed metadata adds extra technical fields for later processing.";
    }
    return "Markdown is good for note apps, docs, and later processing.";
  }
  return "Web Page is the easiest option for most people and looks closest to ChatGPT.";
}

function getSelectedScope() {
  const raw = String(scopeSelect?.value || "").trim().toLowerCase();
  return raw === "batch" ? "batch" : "single";
}

function getSelectedFormat() {
  const raw = String(formatSelect?.value || "").trim().toLowerCase();
  if (raw === "txt" || raw === "md") {
    return raw;
  }
  return "html";
}

function getSelectedDetailedMetadata() {
  if (!shouldShowDetailedMetadataOption(getSelectedFormat())) {
    return false;
  }
  return Boolean(metadataToggle?.checked);
}

function shouldShowDetailedMetadataOption(format) {
  const normalized = normalizeFormatValue(format);
  return normalized === "txt" || normalized === "md";
}

function autoSelectPreferredScope(state) {
  if (!state) {
    return;
  }

  const activeScope = getActiveScopeFromState(state);
  if (activeScope) {
    if (getSelectedScope() !== activeScope) {
      scopeSelect.value = activeScope;
    }
    return;
  }

  if (scopeTouchedByUser) {
    return;
  }

  const preferredScope = state.isConversationPage ? "single" : "batch";
  if (getSelectedScope() === preferredScope) {
    return;
  }

  scopeSelect.value = preferredScope;
}

function getActiveScopeFromState(state) {
  const operation = String(state?.runtimeOperation || "").trim().toLowerCase();
  if (operation === "batch") {
    return "batch";
  }
  if (operation === "single" || operation === "single-resume") {
    return "single";
  }
  return "";
}

function getActiveFormatFromState(state) {
  const operation = String(state?.runtimeOperation || "").trim().toLowerCase();
  if (operation === "batch") {
    return normalizeFormatValue(state?.batchExportFormat || state?.runtimeExportFormat || "html");
  }
  if (operation === "single" || operation === "single-resume") {
    return normalizeFormatValue(state?.runtimeExportFormat || "html");
  }
  return "";
}

function getActiveDetailedMetadataFromState(state) {
  const operation = String(state?.runtimeOperation || "").trim().toLowerCase();
  if (operation === "batch") {
    return Boolean(state?.batchDetailedMetadata);
  }
  if (operation === "single" || operation === "single-resume") {
    return Boolean(state?.runtimeDetailedMetadata);
  }
  return null;
}

function syncSelectionFromActiveState(state) {
  if (!state) {
    return;
  }

  const activeScope = getActiveScopeFromState(state);
  if (activeScope && getSelectedScope() !== activeScope) {
    scopeSelect.value = activeScope;
  }

  const activeFormat = getActiveFormatFromState(state);
  if (activeFormat && getSelectedFormat() !== activeFormat) {
    formatSelect.value = activeFormat;
  }

  const activeDetailedMetadata = getActiveDetailedMetadataFromState(state);
  if (
    activeDetailedMetadata != null &&
    shouldShowDetailedMetadataOption(getSelectedFormat()) &&
    Boolean(metadataToggle?.checked) !== Boolean(activeDetailedMetadata)
  ) {
    metadataToggle.checked = Boolean(activeDetailedMetadata);
  }

  if (
    !state.isExporting &&
    state.hasBatchResume &&
    getSelectedScope() === "batch" &&
    !formatTouchedByUser
  ) {
    const resumeFormat = normalizeFormatValue(state.batchExportFormat || "html");
    if (getSelectedFormat() !== resumeFormat) {
      formatSelect.value = resumeFormat;
    }
  }

  if (
    !state.isExporting &&
    state.hasBatchResume &&
    getSelectedScope() === "batch" &&
    !metadataTouchedByUser &&
    shouldShowDetailedMetadataOption(getSelectedFormat()) &&
    Boolean(metadataToggle?.checked) !== Boolean(state.batchDetailedMetadata)
  ) {
    metadataToggle.checked = Boolean(state.batchDetailedMetadata);
  }
}

function syncResumeFormatTracking(state) {
  const nextResumeFormat = state?.hasBatchResume
    ? normalizeFormatValue(state?.batchExportFormat || "html")
    : "";
  if (nextResumeFormat !== lastSeenBatchResumeFormat) {
    lastSeenBatchResumeFormat = nextResumeFormat;
    formatTouchedByUser = false;
  }
  const nextResumeDetailedMetadata = state?.hasBatchResume
    ? Boolean(state?.batchDetailedMetadata)
    : null;
  if (nextResumeDetailedMetadata !== lastSeenBatchResumeDetailedMetadata) {
    lastSeenBatchResumeDetailedMetadata = nextResumeDetailedMetadata;
    metadataTouchedByUser = false;
  }
}

function updateResumeButtonLabel(state) {
  if (!resumeBatchBtn) {
    return;
  }

  if (state?.hasBatchResume) {
    resumeBatchBtn.textContent = "Continue Saving (" + describeBatchResumeExportMode(state) + ")";
    return;
  }

  resumeBatchBtn.textContent = "Continue Saving";
}

function updateStartButtonLabel(state) {
  const scope = getSelectedScope();
  const isBusy = Boolean(state?.isExporting);
  const isConversationPage = Boolean(state?.isConversationPage);

  if (isBusy) {
    startBtn.textContent = state?.runtimeOperation === "single-resume" ? "Trying to Resume..." : "Processing...";
    return;
  }

  if (scope === "single" && state && !isConversationPage) {
    startBtn.textContent = "Open One Chat First";
    return;
  }

  if (scope === "batch" && state?.hasBatchResume) {
    startBtn.textContent = "Start New Many-Chat Save";
    return;
  }

  startBtn.textContent = scope === "batch" ? "Start Saving Many Chats" : "Start Saving This Chat";
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
  const scope = getSelectedScope();
  const hasAnyAction = Boolean(nextState.canExport || nextState.canBatch);
  const canStart = scope === "batch" ? Boolean(nextState.canBatch) : Boolean(nextState.canExport);

  startBtn.disabled = !canStart;
  scopeSelect.disabled = !hasAnyAction || Boolean(nextState.isBusy);
  formatSelect.disabled = !hasAnyAction || Boolean(nextState.isBusy);
  if (metadataToggle) {
    metadataToggle.disabled = !hasAnyAction || Boolean(nextState.isBusy) || !shouldShowDetailedMetadataOption(getSelectedFormat());
  }
  resumeBatchBtn.disabled = !nextState.canResumeBatch;
  cancelBatchBtn.disabled = !nextState.canCancelBatch;
  resumeBatchBtn.hidden = !nextState.canResumeBatch;
  cancelBatchBtn.hidden = !nextState.canCancelBatch;
  if (runActions) {
    runActions.hidden = !nextState.canResumeBatch && !nextState.canCancelBatch;
  }
  yearFolderToggle.disabled = !nextState.canYearToggle || getSelectedScope() !== "batch";
  debugLogToggle.disabled = !nextState.canDebugToggle || getSelectedScope() !== "batch";
}

function setHint(text, kind) {
  hint.textContent = text;
  hint.className = "hint" + (kind ? " " + kind : "");
}

function confirmBatchForegroundWarning(options = {}) {
  const mode = String(options?.mode || "start-batch").trim().toLowerCase();
  const exportModeLabel = describeSelectedExportMode({
    format: options?.format || "html",
    detailedMetadata: Boolean(options?.detailedMetadata)
  });
  if (mode === "resume-batch") {
    return window.confirm(
      "Continue this paused many-chat save?\n\n" +
      "It will keep using " + exportModeLabel + ".\n\n" +
      BATCH_FOREGROUND_WARNING +
      "\n\nContinue?"
    );
  }
  if (mode === "start-fresh") {
    return window.confirm(
      "Start a new many-chat save?\n\n" +
      "This will start over as " + exportModeLabel + ".\n" +
      "Your paused save will not be continued.\n\n" +
      BATCH_FOREGROUND_WARNING +
      "\n\nStart new save?"
    );
  }
  return window.confirm(
    "Save many chats as " + exportModeLabel + "?\n\n" +
    BATCH_FOREGROUND_WARNING +
    "\n\nContinue?"
  );
}

function getSingleExportStartedHint(format, detailedMetadata = false) {
  return "Saving this chat as " + describeSelectedExportMode({ format, detailedMetadata }) + ". Progress will appear in the ChatGPT tab.";
}

function getBatchExportStartedHint(format, detailedMetadata = false) {
  return "Saving many chats as " + describeSelectedExportMode({ format, detailedMetadata }) + ". " + BATCH_FOREGROUND_WARNING;
}

function doesBatchResumeOptionDifferFromSelection(state) {
  if (!state?.hasBatchResume) {
    return false;
  }
  return (
    normalizeFormatValue(state?.batchExportFormat || "html") !== normalizeFormatValue(getSelectedFormat()) ||
    Boolean(state?.batchDetailedMetadata) !== getSelectedDetailedMetadata()
  );
}

function describeBatchResumeExportMode(state) {
  return describeSelectedExportMode({
    format: state?.batchExportFormat || "html",
    detailedMetadata: Boolean(state?.batchDetailedMetadata)
  });
}

function describeSelectedExportMode(options = {}) {
  const format = normalizeFormatValue(options?.format || getSelectedFormat());
  const detailedMetadata = shouldShowDetailedMetadataOption(format) && Boolean(options?.detailedMetadata);
  const baseLabel = getExportFormatLabel(format);
  if (!detailedMetadata) {
    return baseLabel;
  }
  return baseLabel + " with detailed metadata";
}

function getExportFormatLabel(format) {
  const normalized = normalizeFormatValue(format);
  if (normalized === "txt") {
    return "Text File (TXT)";
  }
  if (normalized === "md") {
    return "Markdown (MD)";
  }
  return "Web Page (HTML)";
}

function normalizeFormatValue(format) {
  const normalized = String(format || "").trim().toLowerCase();
  if (normalized === "txt") {
    return "txt";
  }
  if (normalized === "md") {
    return "md";
  }
  return "html";
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

function isConversationTabUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (!/(^|\.)chatgpt\.com$/i.test(parsed.hostname)) {
      return false;
    }
    return /^\/c\/[0-9a-zA-Z_-]+/.test(parsed.pathname || "");
  } catch (_error) {
    return false;
  }
}

function getConversationIdFromTabUrl(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (!/(^|\.)chatgpt\.com$/i.test(parsed.hostname)) {
      return "";
    }
    const match = /^\/c\/([0-9a-zA-Z_-]+)/.exec(parsed.pathname || "");
    return match ? String(match[1] || "") : "";
  } catch (_error) {
    return "";
  }
}

function normalizeTabUrlForComparison(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (!/(^|\.)chatgpt\.com$/i.test(parsed.hostname)) {
      return "";
    }
    return parsed.origin + (parsed.pathname || "");
  } catch (_error) {
    return "";
  }
}

async function sendToActiveTabWithTimeout(message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS, options = {}) {
  try {
    return await sendToActiveTabWithTimeoutOnce(message, timeoutMs);
  } catch (error) {
    if (!options.allowRecover || !isRecoverableAttachError(error)) {
      throw error;
    }

    const recovered = await ensureActiveTabReceiverReady({
      reason: options.recoveryReason || "action",
      allowReloadFallback: options.allowReloadFallback !== false
    });
    if (!recovered) {
      throw new Error("Please reload this ChatGPT tab once. The extension could not get ready yet.");
    }

    return await sendToActiveTabWithTimeoutOnce(message, timeoutMs);
  }
}

async function sendToActiveTabWithTimeoutOnce(message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
  return await Promise.race([
    sendToActiveTab(message),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("The ChatGPT tab took too long to respond."));
      }, timeoutMs);
    })
  ]);
}

function isRecoverableAttachError(error) {
  const message = String(error?.message || "");
  return (
    /took too long to respond/i.test(message) ||
    /Receiving end does not exist/i.test(message) ||
    /Could not establish connection/i.test(message) ||
    /message port closed/i.test(message)
  );
}

async function ensureActiveTabReceiverReady(options = {}) {
  if (activeTabId == null || !isChatgptUrl(activeTabUrl)) {
    return false;
  }

  if (attachRecoveryPromise) {
    return await attachRecoveryPromise;
  }

  attachRecoveryPromise = (async () => {
    installAttachRecoveryTriggered = true;
    installAttachRecoveryAt = Date.now();
    applyInstallAttachRecoveryUi(
      options.reason === "action"
        ? "Checking this chat..."
        : "Checking this ChatGPT tab...",
      ""
    );

    const alreadyReady = await probeContentState();
    if (alreadyReady) {
      installAttachRecoveryTriggered = false;
      installAttachRecoveryAt = 0;
      return true;
    }

    await clearStaleInstallMarkersInActiveTab();

    const injected = await injectContentScriptIntoActiveTab();
    if (injected) {
      const readyAfterInject = await waitForContentStateReady(ATTACH_READY_WAIT_MS);
      if (readyAfterInject) {
        installAttachRecoveryTriggered = false;
        installAttachRecoveryAt = 0;
        return true;
      }
    }

    if (options.allowReloadFallback !== false) {
      const reloaded = await reloadActiveTabForAttachRecovery();
      if (reloaded) {
        const readyAfterReload = await waitForContentStateReady(9000);
        if (readyAfterReload) {
          installAttachRecoveryTriggered = false;
          installAttachRecoveryAt = 0;
          return true;
        }
      }
    }

    return false;
  })();

  try {
    return await attachRecoveryPromise;
  } finally {
    attachRecoveryPromise = null;
  }
}

async function clearStaleInstallMarkersInActiveTab() {
  if (activeTabId == null || !chrome?.scripting?.executeScript) {
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        try {
          delete window.__chatgpt_thread_exporter_installed__;
        } catch (_error) {}

        try {
          delete window.__chatgptExportPageBridgeInstalled__;
        } catch (_error) {}

        try {
          delete window.__chatgptExportConversationTapInstalled__;
        } catch (_error) {}

        const removableIds = [
          "chatgpt-thread-export-style",
          "chatgpt-thread-export-status",
          "chatgpt-thread-export-guard",
          "chatgpt-export-page-bridge-script"
        ];

        removableIds.forEach((id) => {
          const node = document.getElementById(id);
          if (node && typeof node.remove === "function") {
            node.remove();
          }
        });

        document.querySelectorAll("[data-chatgpt-export-inline-ts='1']").forEach((node) => {
          if (node && typeof node.remove === "function") {
            node.remove();
          }
        });
      }
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function probeContentState() {
  try {
    const response = await sendToActiveTabWithTimeoutOnce(
      { type: "chatgpt-export-get-state" },
      Math.min(900, TAB_MESSAGE_TIMEOUT_MS)
    );
    return response?.ok ? response : null;
  } catch (_error) {
    return null;
  }
}

async function waitForContentStateReady(timeoutMs = ATTACH_READY_WAIT_MS) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const response = await probeContentState();
    if (response) {
      return response;
    }
    await delay(ATTACH_READY_POLL_MS);
  }
  return null;
}

async function injectContentScriptIntoActiveTab() {
  if (activeTabId == null || !chrome?.scripting?.executeScript) {
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"]
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function reloadActiveTabForAttachRecovery() {
  if (activeTabId == null || !chrome?.tabs?.reload) {
    return false;
  }

  applyInstallAttachRecoveryUi(
    "Reloading this ChatGPT tab once so the extension can get ready...",
    ""
  );

  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.reload(activeTabId, {}, () => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "The ChatGPT tab could not be reloaded."));
          return;
        }
        resolve();
      });
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function sendToActiveTab(message) {
  if (activeTabId == null) {
    return Promise.reject(new Error("No ChatGPT tab is selected."));
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "The ChatGPT tab could not be reached."));
        return;
      }
      resolve(response);
    });
  });
}
