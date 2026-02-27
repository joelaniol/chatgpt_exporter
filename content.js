(function initChatGptThreadExporter() {
  if (window.top !== window) {
    return;
  }

  const INSTALL_FLAG = "__chatgpt_thread_exporter_installed__";
  if (window[INSTALL_FLAG]) {
    return;
  }
  window[INSTALL_FLAG] = true;

  const STYLE_ID = "chatgpt-thread-export-style";
  const STATUS_ID = "chatgpt-thread-export-status";
  const INLINE_TS_CLASS = "chatgpt-inline-timestamp";
  const INLINE_TS_MARKER_ATTR = "data-chatgpt-export-inline-ts";
  const INLINE_TS_STORAGE_KEY = "__chatgpt_export_inline_timestamps__";
  const PAGE_BRIDGE_SCRIPT_ID = "chatgpt-export-page-bridge-script";
  const PAGE_BRIDGE_REQUEST_TYPE = "chatgpt-export-bridge-request";
  const PAGE_BRIDGE_RESPONSE_TYPE = "chatgpt-export-bridge-response";
  const PAGE_BRIDGE_PAYLOAD_TYPE = "chatgpt-export-bridge-conversation-payload";
  const PAGE_BRIDGE_TOKEN = "tok_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const CAPTURED_CONVERSATION_CACHE_MAX = 8;

  const API_TIMEOUT_MS = 240000;
  const API_MAX_RETRIES = 4;
  const API_RETRY_BASE_DELAY_MS = 1200;
  const BATCH_LIST_PAGE_LIMIT = 28;
  const BATCH_LIST_TIMEOUT_MS = 120000;
  const BATCH_LIST_MAX_RETRIES = 4;
  const BATCH_ITEM_TIMEOUT_MS = 600000;
  const BATCH_ITEM_MAX_RETRIES = 4;
  const BATCH_DOWNLOAD_DELAY_MS = 600;
  const BATCH_MAX_PAGES = 400;
  const EXPORT_BASE_FOLDER_NAME = "Chat GPT";
  const RUNTIME_STATE_STORAGE_KEY = "__chatgpt_export_runtime_state__";
  const RUNTIME_STATE_WRITE_THROTTLE_MS = 450;
  const RUNTIME_STATE_HEARTBEAT_MS = 3000;
  const BATCH_STATE_STORAGE_KEY = "__chatgpt_export_batch_state__";
  const BATCH_STATE_VERSION = 1;
  const BATCH_STATE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
  const BATCH_AUTO_RESUME_DELAY_MS = 1800;
  const BATCH_DOM_FALLBACK_ENABLED = true;
  const MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
  const MAX_PLAUSIBLE_THREAD_FUTURE_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
  const BATCH_YEAR_FOLDER_ONLY_STORAGE_KEY = "__chatgpt_export_batch_year_only__";
  const BATCH_LAST_ACCOUNT_NAME_STORAGE_KEY = "__chatgpt_export_batch_last_account__";
  const BATCH_DEBUG_LOG_STORAGE_KEY = "__chatgpt_export_batch_debug_log__";
  const BATCH_DEBUG_LOG_MAX_EVENTS = 1200;
  const BATCH_DEBUG_LOG_MIN_FLUSH_MS = 45000;
  const BATCH_DEBUG_LOG_PROGRESS_FLUSH_EVERY = 20;
  const BATCH_HIDDEN_WAIT_MAX_MS = 180000;
  const BATCH_HIDDEN_NOTICE_MS = 6000;
  const DOM_SCROLL_MAX_PASSES = 240;
  const DOM_SCROLL_MAX_PASSES_CAP = 2200;
  const DOM_SCROLL_STEP_MIN = 500;
  const DOM_SCROLL_SETTLE_MS = 220;
  const DOM_SCROLL_IDLE_LIMIT = 4;
  const DOM_BOTTOM_STABLE_PASSES = 2;
  const DOM_TOP_STABLE_PASSES = 2;
  const DOM_LONG_WAIT_MAX_MS = 420000;
  const DOM_LONG_WAIT_IDLE_MS = 12000;
  const DOM_LONG_WAIT_POLL_MS = 800;
  const DOM_LONG_WAIT_RESCAN_LIMIT = 2;
  const DOM_LONG_WAIT_NO_ACTIVITY_EXIT_MS = 7000;
  const SIDEBAR_SWEEP_MAX_PASSES = 220;
  const SIDEBAR_SWEEP_MAX_PASSES_CAP = 5000;
  const SIDEBAR_SWEEP_SETTLE_MS = 260;
  const SIDEBAR_SWEEP_IDLE_LIMIT = 4;
  const SIDEBAR_SWEEP_WAIT_MS = 9000;
  const SIDEBAR_SWEEP_POLL_MS = 450;
  const SIDEBAR_SWEEP_END_VERIFY_ROUNDS = 3;
  const SIDEBAR_SWEEP_NUDGE_UP_RATIO = 0.38;
  const SIDEBAR_SWEEP_NUDGE_WAIT_MS = 260;
  const SIDEBAR_SWEEP_HIDDEN_WAIT_MAX_MS = 180000;
  const SIDEBAR_SWEEP_HIDDEN_NOTICE_MS = 6000;
  const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 45000;
  // Backup-first default: embed full-resolution source images without size/count caps.
  const EXPORT_IMAGE_MAX_BYTES_PER_FILE = Number.POSITIVE_INFINITY;
  const EXPORT_IMAGE_MAX_TOTAL_BYTES = Number.POSITIVE_INFINITY;
  const EXPORT_IMAGE_MAX_COUNT = Number.MAX_SAFE_INTEGER;

  let isExporting = false;
  let statusTimer = null;
  let observer = null;
  let showInlineTimestamps = false;
  let inlineRefreshScheduled = false;
  let inlineRefreshShowStatus = false;
  let capturedTimestampMapsByConversation = new Map();
  let capturedTitlesByConversation = new Map();
  let pagePayloadListenerInstalled = false;
  let pageBridgeReadyPromise = null;
  let batchRunContext = null;
  let batchAutoResumeScheduled = false;
  let batchYearFolderOnly = loadBatchYearFolderOnlyState();
  let batchDebugLogEnabled = loadBatchDebugLogState();
  let exportCancelRequested = false;
  let runtimeStatusMessage = "";
  let runtimeStatusKind = "";
  let runtimeStatusUpdatedAt = 0;
  let runtimeOperation = "";
  let runtimeStartedAt = 0;
  let runtimeHeartbeatTimer = null;
  let runtimeStateFlushTimer = null;

  boot();

  function boot() {
    injectStyles();
    installPagePayloadListener();
    installRuntimeListener();
    void ensurePageBridge().catch((error) => {
      console.warn("[ChatGPT Export] Page bridge init failed:", error);
    });
    removeInlineTimestampBadges();
    scheduleBatchAutoResume();
    persistRuntimeState(true);
  }

  function installRouteObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      if (showInlineTimestamps) {
        scheduleInlineTimestampRefresh(false, false);
      } else if (!isConversationPage()) {
        removeInlineTimestampBadges();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("popstate", () => {
      if (showInlineTimestamps) {
        scheduleInlineTimestampRefresh(true, false);
      } else {
        removeInlineTimestampBadges();
      }
    });
    window.addEventListener("hashchange", () => {
      if (showInlineTimestamps) {
        scheduleInlineTimestampRefresh(true, false);
      } else {
        removeInlineTimestampBadges();
      }
    });
  }

  function scheduleInlineTimestampRefresh(_forceApi = false, showStatus = false) {
    void _forceApi;
    if (!showInlineTimestamps) {
      return;
    }

    if (showStatus) {
      inlineRefreshShowStatus = true;
    }

    if (inlineRefreshScheduled) {
      return;
    }

    inlineRefreshScheduled = true;
    setTimeout(() => {
      inlineRefreshScheduled = false;
      const wantsStatus = inlineRefreshShowStatus;
      inlineRefreshShowStatus = false;
      void refreshInlineTimestamps(wantsStatus).catch((error) => {
        console.error("[ChatGPT Export] Inline refresh crashed:", error);
        if (wantsStatus) {
          setStatus("Inline timestamp error, please reload.", "error", 4200);
        }
      });
    }, 50);
  }

  async function refreshInlineTimestamps(showStatus = false) {
    if (!showInlineTimestamps || !isConversationPage()) {
      removeInlineTimestampBadges();
      return;
    }

    renderInlineTimestampBadges();
    if (showStatus) {
      setStatus("Inline timestamps refreshed.", "success", 2600);
    }
  }

  function installPagePayloadListener() {
    if (pagePayloadListenerInstalled) {
      return;
    }
    pagePayloadListenerInstalled = true;

    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;
      if (!data || data.type !== PAGE_BRIDGE_PAYLOAD_TYPE) {
        return;
      }
      if (data.token !== PAGE_BRIDGE_TOKEN) {
        return;
      }

      const conversationId = String(data.conversationId || "").trim();
      if (!conversationId) {
        return;
      }

      const map = buildTimestampMapFromCapturedSummary(data.timestamps);
      const title = sanitizeConversationTitle(data.title || "");
      rememberCapturedConversationData(conversationId, map, title);
    });
  }

  function buildTimestampMapFromCapturedSummary(rawTimestamps) {
    const out = new Map();
    if (!Array.isArray(rawTimestamps)) {
      return out;
    }

    rawTimestamps.forEach((item, index) => {
      const rawId = item?.id ?? item?.message_id ?? item?.messageId ?? "";
      const messageId = String(rawId || "").trim() || ("msg-" + index);
      if (!messageId) {
        return;
      }

      const timestamp = normalizeTimestamp(item?.create_time ?? item?.update_time ?? item?.timestamp);
      if (!timestamp) {
        return;
      }

      out.set(messageId, {
        iso: timestamp.toISOString(),
        display: formatTimestamp(timestamp)
      });
    });

    return out;
  }

  function rememberCapturedConversationData(conversationId, timestampMap, title) {
    if (!conversationId) {
      return;
    }

    const hasMap = timestampMap instanceof Map;
    const hasTitle = Boolean(String(title || "").trim());
    if (!hasMap && !hasTitle) {
      return;
    }

    if (capturedTimestampMapsByConversation.has(conversationId)) {
      capturedTimestampMapsByConversation.delete(conversationId);
    }
    if (hasMap) {
      capturedTimestampMapsByConversation.set(conversationId, timestampMap);
    }

    if (capturedTitlesByConversation.has(conversationId)) {
      capturedTitlesByConversation.delete(conversationId);
    }
    if (hasTitle) {
      capturedTitlesByConversation.set(conversationId, title);
    }

    trimCapturedConversationCache();
  }

  function trimCapturedConversationCache() {
    while (capturedTimestampMapsByConversation.size > CAPTURED_CONVERSATION_CACHE_MAX) {
      const oldestConversationId = capturedTimestampMapsByConversation.keys().next().value;
      capturedTimestampMapsByConversation.delete(oldestConversationId);
      capturedTitlesByConversation.delete(oldestConversationId);
    }

    while (capturedTitlesByConversation.size > CAPTURED_CONVERSATION_CACHE_MAX) {
      const oldestConversationId = capturedTitlesByConversation.keys().next().value;
      capturedTitlesByConversation.delete(oldestConversationId);
      if (capturedTimestampMapsByConversation.has(oldestConversationId)) {
        capturedTimestampMapsByConversation.delete(oldestConversationId);
      }
    }
  }

  function getCapturedTimestampMap(conversationId) {
    if (!conversationId) {
      return null;
    }
    return capturedTimestampMapsByConversation.get(conversationId) || null;
  }

  function getCapturedConversationTitle(conversationId) {
    if (!conversationId) {
      return "";
    }
    return capturedTitlesByConversation.get(conversationId) || "";
  }

  function installRuntimeListener() {
    if (!chrome?.runtime?.onMessage) {
      return;
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const type = message?.type;

      if (type === "chatgpt-export-get-state") {
        const savedBatchState = loadBatchState();
        const runtimeState = buildRuntimeStateSnapshot();
        sendResponse({
          ok: true,
          isConversationPage: isConversationPage(),
          isExporting,
          showInlineTimestamps: false,
          batchYearFolderOnly,
          batchDebugLogEnabled,
          hasBatchResume: hasResumableBatchState(savedBatchState),
          isBatchRunning: Boolean(batchRunContext && batchRunContext.running),
          runtimeStatusMessage: runtimeState.statusMessage,
          runtimeStatusKind: runtimeState.statusKind,
          runtimeStatusUpdatedAt: runtimeState.statusUpdatedAt,
          runtimeOperation: runtimeState.operation,
          runtimeStartedAt: runtimeState.startedAt,
          batchTotalCount: runtimeState.batchTotalCount,
          batchDoneCount: runtimeState.batchDoneCount,
          batchSuccessCount: runtimeState.batchSuccessCount,
          batchFailureCount: runtimeState.batchFailureCount,
          batchSkippedCount: runtimeState.batchSkippedCount
        });
        return false;
      }

      if (type === "chatgpt-export-set-inline-toggle") {
        showInlineTimestamps = false;
        removeInlineTimestampBadges();
        sendResponse({
          ok: false,
          showInlineTimestamps: false,
          error: "Real-time inline timestamps in thread are disabled."
        });
        return false;
      }

      if (type === "chatgpt-export-trigger") {
        if (isExporting) {
          sendResponse({ ok: false, error: "Export is already running." });
          return false;
        }
        if (!isConversationPage()) {
          sendResponse({ ok: false, error: "Please open a chat thread (/c/...)." });
          return false;
        }
        void startExport("action").catch((error) => {
          console.error("[ChatGPT Export] Action export failed:", error);
        });
        sendResponse({ ok: true, started: true });
        return false;
      }

      if (type === "chatgpt-export-batch-trigger") {
        if (isExporting) {
          sendResponse({ ok: false, error: "Export is already running." });
          return false;
        }
        void startBatchExport("action", message?.options || {}).catch((error) => {
          console.error("[ChatGPT Export] Batch export failed:", error);
        });
        sendResponse({ ok: true, started: true });
        return false;
      }

      if (type === "chatgpt-export-batch-resume-trigger") {
        if (isExporting) {
          sendResponse({ ok: false, error: "Export is already running." });
          return false;
        }
        void resumeBatchExport("action").catch((error) => {
          console.error("[ChatGPT Export] Batch resume failed:", error);
        });
        sendResponse({ ok: true, started: true });
        return false;
      }

      if (type === "chatgpt-export-batch-cancel-trigger") {
        const cancelled = requestExportCancel();
        sendResponse({ ok: cancelled, cancelled });
        return false;
      }

      if (type === "chatgpt-export-cancel-trigger") {
        const cancelled = requestExportCancel();
        sendResponse({ ok: cancelled, cancelled });
        return false;
      }

      if (type === "chatgpt-export-batch-set-folder-mode") {
        const yearOnly = Boolean(message?.yearOnly);
        batchYearFolderOnly = yearOnly;
        persistBatchYearFolderOnlyState(yearOnly);
        const savedState = loadBatchState();
        if (savedState?.options && !isExporting) {
          savedState.options.yearOnlyFolder = yearOnly;
          saveBatchState(savedState);
        }
        persistRuntimeState(true);
        sendResponse({ ok: true, batchYearFolderOnly: yearOnly });
        return false;
      }

      if (type === "chatgpt-export-batch-set-debug-log-mode") {
        const enabled = Boolean(message?.enabled);
        batchDebugLogEnabled = enabled;
        persistBatchDebugLogState(enabled);
        const savedState = loadBatchState();
        if (savedState?.options && !isExporting) {
          savedState.options.debugLogEnabled = enabled;
          if (!savedState.options.debugLogFileName) {
            savedState.options.debugLogFileName = buildBatchDebugLogFileName(
              new Date(savedState.createdAt || Date.now())
            );
          }
          saveBatchState(savedState);
        }
        persistRuntimeState(true);
        sendResponse({ ok: true, batchDebugLogEnabled: enabled });
        return false;
      }

      return false;
    });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${STATUS_ID} {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        border-radius: 10px;
        max-width: min(460px, 78vw);
        padding: 7px 10px;
        font: 500 12px/1.35 "Segoe UI", Arial, sans-serif;
        color: #e2e8f0;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(100, 116, 139, 0.5);
        white-space: normal;
        box-shadow: 0 6px 20px rgba(2, 6, 23, 0.28);
        pointer-events: none;
      }

      #${STATUS_ID}.busy {
        border-color: rgba(56, 189, 248, 0.65);
      }

      #${STATUS_ID}.success {
        border-color: rgba(34, 197, 94, 0.7);
      }

      #${STATUS_ID}.error {
        border-color: rgba(248, 113, 113, 0.75);
      }

      .${INLINE_TS_CLASS} {
        margin: 0 0 6px;
        padding: 4px 8px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 7px;
        background: rgba(226, 232, 240, 0.14);
        color: #94a3b8;
        font: 600 11px/1.2 "Segoe UI", Arial, sans-serif;
        letter-spacing: 0.01em;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function ensureStatusToast() {
    if (!document.body) {
      return null;
    }

    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement("div");
      status.id = STATUS_ID;
      status.style.display = "none";
      document.body.appendChild(status);
    }

    return status;
  }

  function setStatus(message, kind = "busy", hideAfterMs = 0) {
    const status = ensureStatusToast();
    runtimeStatusMessage = String(message || "");
    runtimeStatusKind = String(kind || "busy");
    runtimeStatusUpdatedAt = Date.now();
    persistRuntimeState(false);

    if (status) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }

      status.className = kind;
      status.textContent = message;
      status.style.display = "block";

      if (hideAfterMs > 0) {
        statusTimer = setTimeout(() => {
          status.style.display = "none";
        }, hideAfterMs);
      }
    }
  }

  async function startExport(triggerSource) {
    if (isExporting) {
      setStatus("Export is already running...", "busy", 2400);
      return;
    }

    if (!isConversationPage()) {
      setStatus("Please open a chat thread first.", "error", 7000);
      return;
    }

    isExporting = true;
    exportCancelRequested = false;
    setExportLifecycleActive("single");

    try {
      setStatus("Starting export...", "busy");

      const fallbackTitle = getConversationTitleFromPage();
      const exportResult = await collectMessages(setStatus, {
        allowExtendedWait: true,
        isCancelled: () => exportCancelRequested
      });

      if (!Array.isArray(exportResult.messages) || exportResult.messages.length === 0) {
        throw new Error("No exportable messages found.");
      }

      const finalTitle = exportResult.conversationTitle || fallbackTitle;
      const exportedAt = new Date();
      const preparedMessages = await prepareMessagesForHtmlExport(exportResult.messages);
      assertExportableConversationMessages(preparedMessages);
      const threadStartedAt = resolveConversationStartedAt(preparedMessages);
      const html = buildHtmlDocument({
        title: finalTitle,
        source: exportResult.source,
        messages: preparedMessages,
        exportedAt,
        threadStartedAt,
        pageUrl: window.location.href
      });

      const fileName = buildFileName(finalTitle, threadStartedAt);

      setStatus("Downloading file...", "busy");
      await triggerBrowserDownload(html, fileName, {
        subdirectory: EXPORT_BASE_FOLDER_NAME
      });

      const sourceLabel = "DOM";
      setStatus(
        "Saved: " + fileName + " (" + sourceLabel + ", " + preparedMessages.length + " Messages)",
        "success",
        9000
      );
    } catch (error) {
      if (isExportCancelledError(error)) {
        setStatus("Export stopped.", "success", 5000);
        return;
      }
      console.error("[ChatGPT Export] Export failed:", error);
      setStatus("Export error: " + (error?.message || String(error)), "error", 12000);
      throw error;
    } finally {
      isExporting = false;
      exportCancelRequested = false;
      setExportLifecycleIdle();
    }

    if (triggerSource === "action") {
      return;
    }
  }

  async function startBatchExport(triggerSource, options = {}) {
    void triggerSource;
    if (isExporting) {
      setStatus("Export is already running...", "busy", 2400);
      return;
    }

    const savedBatchState = loadBatchState();
    if (hasResumableBatchState(savedBatchState)) {
      const shouldResume = window.confirm(
        "A paused batch was found.\nOK = resume\nCancel = start new"
      );
      if (shouldResume) {
        await startBatchExportFromState(savedBatchState, "resume");
        return;
      }
      clearBatchState();
    }

    const batchOptions = normalizeBatchExportOptions(options);
    batchYearFolderOnly = batchOptions.yearOnlyFolder;
    batchDebugLogEnabled = batchOptions.debugLogEnabled;
    persistBatchYearFolderOnlyState(batchYearFolderOnly);
    persistBatchDebugLogState(batchDebugLogEnabled);

    const reportStatus = (message, kind = "busy", hideAfterMs = 0) => {
      setStatus(message, kind, hideAfterMs);
    };

    try {
      reportStatus("Batch: Loading thread list...", "busy");

      const firstPayload = await fetchConversationListPage(0, BATCH_LIST_PAGE_LIMIT, reportStatus);
      let firstPage = normalizeConversationListPage(firstPayload, 0, BATCH_LIST_PAGE_LIMIT);
      if (!firstPage.items || firstPage.items.length === 0) {
        const domFallbackItems = collectConversationMetasFromVisibleLinks();
        if (domFallbackItems.length > 0) {
          reportStatus("Batch: API list empty, using visible thread links...", "busy");
          firstPage = {
            items: domFallbackItems,
            total: domFallbackItems.length,
            hasMore: false,
            nextOffset: domFallbackItems.length
          };
        } else {
          const topLevelKeys = (firstPayload && typeof firstPayload === "object")
            ? Object.keys(firstPayload).slice(0, 12)
            : [];
          console.warn("[ChatGPT Export] Thread list empty or unknown API format.", {
            payloadType: typeof firstPayload,
            topLevelKeys
          });
          throw new Error("No threads found.");
        }
      }

      let requestedCount;
      try {
        const totalLikelyReliable = isConversationTotalLikelyReliable(firstPage);
        requestedCount = askBatchExportCount(firstPage.total, { totalLikelyReliable });
      } catch (error) {
        reportStatus(error?.message || String(error), "error", 7000);
        return;
      }

      if (requestedCount == null) {
        reportStatus("Batch cancelled.", "success", 3200);
        return;
      }

      reportStatus("Batch: Collecting thread list...", "busy");
      const metaResult = await collectConversationMetasForBatch(requestedCount, firstPage, reportStatus);
      const items = Array.isArray(metaResult?.items) ? metaResult.items : [];
      if (items.length === 0) {
        throw new Error("No threads found for batch export.");
      }

      const state = initializeBatchState(items, batchOptions);
      saveBatchState(state);

      await runBatchExportState(state);
    } catch (error) {
      console.error("[ChatGPT Export] Batch start crashed:", error);
      if (error?.code === "sidebar_hidden_timeout") {
        setStatus(
          "Batch start paused: sidebar could not reliably load in background. Keep the ChatGPT tab in the foreground and start again.",
          "error",
          14000
        );
        return;
      }
      setStatus("Batch export error: " + (error?.message || String(error)), "error", 12000);
    }
  }

  async function resumeBatchExport(triggerSource) {
    void triggerSource;
    if (isExporting) {
      setStatus("Export is already running...", "busy", 2400);
      return;
    }
    const savedState = loadBatchState();
    if (!hasResumableBatchState(savedState)) {
      setStatus("No paused batch found.", "error", 5000);
      return;
    }
    await startBatchExportFromState(savedState, "resume");
  }

  async function startBatchExportFromState(savedState, source) {
    void source;
    const normalizedState = normalizeStoredBatchState(savedState);
    if (!hasResumableBatchState(normalizedState)) {
      setStatus("No resumable batch available.", "error", 5000);
      return;
    }
    await runBatchExportState(normalizedState);
  }

  async function runBatchExportState(state) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      throw new Error("Invalid batch state.");
    }
    if (isExporting) {
      setStatus("Export is already running...", "busy", 2400);
      return;
    }

    isExporting = true;
    exportCancelRequested = false;
    batchDebugLogEnabled = Boolean(state?.options?.debugLogEnabled);
    persistBatchDebugLogState(batchDebugLogEnabled);
    setExportLifecycleActive("batch");

    const totalCount = state.items.length;
    const usedFileNames = new Set(Array.isArray(state.usedFileNames) ? state.usedFileNames : []);
    const context = {
      running: true,
      cancelRequested: false,
      pauseReason: "",
      state,
      usedFileNames,
      debugLogger: createBatchDebugLogger(state, totalCount)
    };
    batchRunContext = context;

    try {
      state.status = "running";
      state.updatedAt = Date.now();
      saveBatchState(state);
      appendBatchDebugEvent(context, {
        level: "info",
        code: "batch_started",
        message: "Batch started.",
        position: Math.max(1, Number(state.nextIndex) + 1 || 1),
        extra: {
          totalCount,
          accountName: state?.options?.accountName || "",
          yearOnlyFolder: Boolean(state?.options?.yearOnlyFolder)
        }
      });
      await maybeFlushBatchDebugLog(context, {
        force: true,
        trigger: "batch_started"
      });

      for (let index = Math.max(0, Number(state.nextIndex) || 0); index < totalCount; index += 1) {
        if (context.cancelRequested || exportCancelRequested) {
          context.cancelRequested = true;
          break;
        }

        const meta = state.items[index];
        const position = index + 1;
        const indexLabel = position + "/" + totalCount;
        const visibleReady = await waitForBatchVisibility({
          maxWaitMs: BATCH_HIDDEN_WAIT_MAX_MS,
          isCancelled: () => Boolean(context.cancelRequested || exportCancelRequested),
          progressCallback: setStatus,
          indexLabel,
          completedLabel: getBatchCompletedCount(state, totalCount) + "/" + totalCount
        });
        if (!visibleReady) {
          context.cancelRequested = true;
          context.pauseReason = "hidden_tab_timeout";
          appendBatchDebugEvent(context, {
            level: "warn",
            code: "batch_paused_hidden_tab",
            message: "Batch paused: ChatGPT tab stayed in background too long.",
            position,
            meta
          });
          await maybeFlushBatchDebugLog(context, {
            force: true,
            trigger: "batch_paused_hidden_tab"
          });
          break;
        }
        try {
          const doneBefore = getBatchCompletedCount(state, totalCount);
          const safeTitle = sanitizeConversationTitle(meta?.title || "") || "Untitled";
          appendBatchDebugEvent(context, {
            level: "info",
            code: "thread_started",
            message: "Exporting thread.",
            position,
            meta
          });
          setStatus(
            "Batch " + indexLabel + " | " + doneBefore + "/" + totalCount +
            " completed: Loading \"" + shortenTitle(safeTitle, 52) + "\"...",
            "busy"
          );
          let abortedCurrentItem = false;
          let failureKind = "";

          try {
            const exportResult = await exportConversationForBatch(meta, position, totalCount, context);
            state.successCount += 1;
            appendBatchDebugEvent(context, {
              level: "info",
              code: "thread_exported",
              message: "Thread saved.",
              position,
              meta,
              extra: {
                source: exportResult?.source || "",
                fileName: exportResult?.fileName || ""
              }
            });
            const doneAfter = getBatchCompletedCount(state, totalCount);
            setStatus(
              "Batch " + indexLabel + " | " + doneAfter + "/" + totalCount +
              " completed: Saved \"" + shortenTitle(exportResult.fileName, 56) + "\" (" + exportResult.source + ")",
              "success"
            );
          } catch (error) {
            if (isExportCancelledError(error)) {
              context.cancelRequested = true;
              abortedCurrentItem = true;
              setStatus("Stop requested. Export will pause...", "busy");
            } else if (isConversationNotFoundError(error)) {
              failureKind = "not_found";
              state.skippedCount += 1;
              const doneAfter = getBatchCompletedCount(state, totalCount);
              setStatus(
                "Batch " + indexLabel + " | " + doneAfter + "/" + totalCount +
                " completed: Thread not found (404).",
                "error"
              );
            } else {
              failureKind = "error";
              state.failureCount += 1;
              const doneAfter = getBatchCompletedCount(state, totalCount);
              setStatus(
                "Batch " + indexLabel + " | " + doneAfter + "/" + totalCount +
                " completed: Error: " + (error?.message || String(error)),
                "error"
              );
            }

            if (!abortedCurrentItem) {
              const failureEntry = buildBatchFailureEntry({
                meta,
                position,
                kind: failureKind || "error",
                error
              });
              state.failures.push(failureEntry);
              appendBatchDebugEvent(context, {
                level: "error",
                code: "thread_failed",
                message: "Thread failed.",
                position,
                meta,
                failure: failureEntry
              });
              await maybeFlushBatchDebugLog(context, {
                force: true,
                trigger: "thread_failed"
              });
            }
          }

          if (abortedCurrentItem) {
            state.updatedAt = Date.now();
            state.usedFileNames = Array.from(usedFileNames);
            saveBatchState(state);
            break;
          }

          state.nextIndex = position;
          state.updatedAt = Date.now();
          state.usedFileNames = Array.from(usedFileNames);
          saveBatchState(state);
          await maybeFlushBatchDebugLog(context, {
            force: false,
            trigger: "progress_tick"
          });

          if (context.cancelRequested || exportCancelRequested) {
            context.cancelRequested = true;
            break;
          }

          if (position < totalCount) {
            await sleep(BATCH_DOWNLOAD_DELAY_MS);
          }
        } catch (iterationError) {
          if (isExportCancelledError(iterationError)) {
            context.cancelRequested = true;
            state.updatedAt = Date.now();
            state.usedFileNames = Array.from(usedFileNames);
            saveBatchState(state);
            break;
          }

          state.failureCount += 1;
          const doneAfter = getBatchCompletedCount(state, totalCount);
          const errorMessage = iterationError?.message || String(iterationError);
          const failureEntry = buildBatchFailureEntry({
            meta,
            position,
            kind: "internal_iteration_error",
            error: "[internal-batch-step] " + errorMessage
          });
          state.failures.push(failureEntry);
          appendBatchDebugEvent(context, {
            level: "error",
            code: "internal_iteration_error",
            message: "Internal batch step failed.",
            position,
            meta,
            failure: failureEntry
          });
          setStatus(
            "Batch " + indexLabel + " | " + doneAfter + "/" + totalCount +
            " completed: Internal error, continuing with next thread: " + errorMessage,
            "error"
          );

          state.nextIndex = position;
          state.updatedAt = Date.now();
          state.usedFileNames = Array.from(usedFileNames);
          saveBatchState(state);
          await maybeFlushBatchDebugLog(context, {
            force: true,
            trigger: "internal_iteration_error"
          });
          continue;
        }
      }

      if (context.cancelRequested && state.nextIndex < totalCount) {
        state.status = "paused";
        state.updatedAt = Date.now();
        saveBatchState(state);
        const pausedByHiddenTab = context.pauseReason === "hidden_tab_timeout";
        const pauseMessage = pausedByHiddenTab
          ? (
            "Batch paused at " + state.nextIndex + "/" + totalCount +
            ": ChatGPT tab stayed in the background too long. Make the tab visible and continue with 'Resume Batch'."
          )
          : (
            "Batch paused at " + state.nextIndex + "/" + totalCount + ". Continue with 'Resume Batch'."
          );
        appendBatchDebugEvent(context, {
          level: "warn",
          code: "batch_paused",
          message: pausedByHiddenTab
            ? "Batch paused (tab too long in background)."
            : "Batch paused (stop requested).",
          position: Math.max(0, Number(state.nextIndex) || 0)
        });
        await maybeFlushBatchDebugLog(context, {
          force: true,
          trigger: pausedByHiddenTab ? "batch_paused_hidden_tab" : "batch_paused"
        });
        setStatus(
          pauseMessage,
          "success",
          10000
        );
        return;
      }

      state.status = "completed";
      state.updatedAt = Date.now();
      saveBatchState(state);

      let finalMessage =
        "Batch finished: " +
        state.successCount +
        " saved, " +
        state.failureCount +
        " errors, " +
        state.skippedCount +
        " skipped.";
      let failureReportFileName = "";

      if (state.failures.length > 0) {
        console.warn("[ChatGPT Export] Batch failures:", state.failures);
        try {
          failureReportFileName = await createAndDownloadBatchFailureReport({
            state,
            totalCount,
            options: state.options || {},
            usedFileNames
          });
        } catch (reportError) {
          console.error("[ChatGPT Export] Failure report could not be saved:", reportError);
        }
      }

      appendBatchDebugEvent(context, {
        level: state.failureCount > 0 ? "warn" : "info",
        code: "batch_completed",
        message: "Batch completed.",
        position: totalCount,
        extra: {
          successCount: state.successCount,
          failureCount: state.failureCount,
          skippedCount: state.skippedCount,
          failureReportFileName: failureReportFileName || ""
        }
      });
      await maybeFlushBatchDebugLog(context, {
        force: true,
        trigger: "batch_completed"
      });

      if (failureReportFileName) {
        finalMessage += " Failure report: " + failureReportFileName + ".";
      }

      setStatus(finalMessage, state.failureCount > 0 ? "error" : "success", 16000);

      clearBatchState();
    } catch (error) {
      if (isExportCancelledError(error)) {
        state.status = "paused";
        state.updatedAt = Date.now();
        saveBatchState(state);
        appendBatchDebugEvent(context, {
          level: "warn",
          code: "batch_paused",
          message: "Batch paused (cancel exception).",
          position: Math.max(0, Number(state.nextIndex) || 0)
        });
        await maybeFlushBatchDebugLog(context, {
          force: true,
          trigger: "batch_paused_cancel_error"
        });
        setStatus(
          "Batch paused at " + state.nextIndex + "/" + totalCount + ". Continue with 'Resume Batch'.",
          "success",
          10000
        );
        return;
      }
      console.error("[ChatGPT Export] Batch export crashed:", error);
      state.status = "paused";
      state.updatedAt = Date.now();
      saveBatchState(state);
      appendBatchDebugEvent(context, {
        level: "error",
        code: "batch_crashed",
        message: "Batch export crashed.",
        position: Math.max(0, Number(state.nextIndex) || 0),
        extra: {
          error: error?.message || String(error)
        }
      });
      await maybeFlushBatchDebugLog(context, {
        force: true,
        trigger: "batch_crashed"
      });
      setStatus("Batch export error: " + (error?.message || String(error)), "error", 12000);
    } finally {
      context.running = false;
      if (batchRunContext === context) {
        batchRunContext = null;
      }
      isExporting = false;
      exportCancelRequested = false;
      setExportLifecycleIdle();
    }
  }

  async function exportConversationForBatch(meta, position, totalCount, context) {
    const indexLabel = position + "/" + totalCount;
    const doneBefore = getBatchCompletedCount(context?.state, totalCount);
    const progressLabel = doneBefore + "/" + totalCount + " completed";
    const options = context?.state?.options || {};

    try {
      const payload = await fetchConversationPayload(meta.id, setStatus, {
        timeoutMs: BATCH_ITEM_TIMEOUT_MS,
        maxRetries: BATCH_ITEM_MAX_RETRIES,
        contextLabel: "Batch " + indexLabel + " | " + progressLabel
      });

      const messages = extractMessagesFromApiPayload(payload);
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("No messages in thread.");
      }

      return await createAndDownloadBatchHtml({
        meta,
        title: sanitizeConversationTitle(payload?.title || meta?.title || "chatgpt_dialog"),
        source: "api",
        messages,
        position,
        totalCount,
        options,
        usedFileNames: context.usedFileNames
      });
    } catch (error) {
      if (!BATCH_DOM_FALLBACK_ENABLED) {
        throw error;
      }

      const domFallbackCurrent = await tryExportConversationViaDomFallback(meta, position, totalCount, context);
      if (domFallbackCurrent) {
        return domFallbackCurrent;
      }

      const domFallbackByNavigation = await tryExportConversationViaNavigationFallback(meta, position, totalCount, context);
      if (domFallbackByNavigation) {
        return domFallbackByNavigation;
      }
      throw error;
    }
  }

  async function tryExportConversationViaDomFallback(meta, position, totalCount, context) {
    const currentConversationId = getConversationIdFromPath() || "";
    if (!currentConversationId || currentConversationId !== String(meta?.id || "")) {
      return null;
    }

    const doneBefore = getBatchCompletedCount(context?.state, totalCount);
    setStatus(
      "Batch " + position + "/" + totalCount + " | " + doneBefore + "/" + totalCount +
      " completed: API is slow, using DOM fallback...",
      "busy"
    );

    const messages = await collectMessagesFromDom(setStatus, {
      allowExtendedWait: true,
      isCancelled: () => Boolean(context?.cancelRequested)
    });

    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    return await createAndDownloadBatchHtml({
      meta,
      title: sanitizeConversationTitle(getConversationTitleFromPage() || meta?.title || "chatgpt_dialog"),
      source: "dom",
      messages,
      position,
      totalCount,
      options: context?.state?.options || {},
      usedFileNames: context.usedFileNames
    });
  }

  async function tryExportConversationViaNavigationFallback(meta, position, totalCount, context) {
    const conversationId = String(meta?.id || "").trim();
    if (!conversationId) {
      return null;
    }

    const doneBefore = getBatchCompletedCount(context?.state, totalCount);
    setStatus(
      "Batch " + position + "/" + totalCount + " | " + doneBefore + "/" + totalCount +
      " completed: opening thread for DOM export...",
      "busy"
    );

    const opened = await openConversationForBatchFallback(conversationId, setStatus, {
      timeoutMs: Math.max(28000, Math.floor(BATCH_ITEM_TIMEOUT_MS * 0.28)),
      isCancelled: () => Boolean(context?.cancelRequested)
    });
    if (!opened) {
      return null;
    }

    await waitForCapturedConversationData(conversationId, 1600);
    const messages = await collectMessagesFromDom(setStatus, {
      allowExtendedWait: true,
      isCancelled: () => Boolean(context?.cancelRequested)
    });
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    return await createAndDownloadBatchHtml({
      meta,
      title: sanitizeConversationTitle(getConversationTitleFromPage() || meta?.title || "chatgpt_dialog"),
      source: "dom-nav",
      messages,
      position,
      totalCount,
      options: context?.state?.options || {},
      usedFileNames: context.usedFileNames
    });
  }

  async function openConversationForBatchFallback(conversationId, progressCallback, options = {}) {
    const targetId = String(conversationId || "").trim();
    if (!targetId) {
      return false;
    }

    if (getConversationIdFromPath() === targetId) {
      return true;
    }

    const timeoutMs = Math.max(5000, Number(options?.timeoutMs) || 35000);
    const isCancelled = typeof options?.isCancelled === "function" ? options.isCancelled : () => false;
    const startedAt = Date.now();
    let attempt = 0;
    let lastPath = String(window.location.pathname || "");

    while ((Date.now() - startedAt) < timeoutMs) {
      if (isCancelled()) {
        throw createExportCancelledError();
      }

      attempt += 1;

      const clickedExisting = clickConversationLinkInPage(targetId);
      if (!clickedExisting) {
        clickSyntheticConversationLink(targetId);
      }

      const routeReached = await waitForConversationRouteReady(targetId, Math.min(9000, timeoutMs), isCancelled);
      if (routeReached) {
        return true;
      }

      const currentPath = String(window.location.pathname || "");
      if (currentPath !== lastPath) {
        lastPath = currentPath;
        continue;
      }

      if (typeof progressCallback === "function") {
        progressCallback("Batch: thread route is not active yet, retrying navigation...", "busy");
      }
      await sleep(220 + Math.floor(Math.random() * 180));
    }

    return false;
  }

  function clickConversationLinkInPage(conversationId) {
    const targetId = String(conversationId || "").trim();
    if (!targetId) {
      return false;
    }

    const anchors = Array.from(document.querySelectorAll("a[href*='/c/']"));
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index];
      const href = String(anchor.getAttribute("href") || anchor.href || "");
      const idFromHref = extractConversationIdFromHrefish(href);
      if (idFromHref !== targetId) {
        continue;
      }
      dispatchConversationAnchorClick(anchor);
      return true;
    }
    return false;
  }

  function clickSyntheticConversationLink(conversationId) {
    const href = buildConversationPageUrl(conversationId);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.setAttribute("aria-hidden", "true");
    anchor.style.position = "fixed";
    anchor.style.left = "-9999px";
    anchor.style.top = "-9999px";
    anchor.style.width = "1px";
    anchor.style.height = "1px";
    anchor.style.opacity = "0";
    (document.body || document.documentElement).appendChild(anchor);
    dispatchConversationAnchorClick(anchor);
    setTimeout(() => {
      anchor.remove();
    }, 0);
  }

  function dispatchConversationAnchorClick(anchor) {
    if (!anchor || typeof anchor.dispatchEvent !== "function") {
      return;
    }
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0
    });
    anchor.dispatchEvent(event);
    if (!event.defaultPrevented && typeof anchor.click === "function") {
      anchor.click();
    }
  }

  async function waitForConversationRouteReady(conversationId, timeoutMs, isCancelled) {
    const targetId = String(conversationId || "").trim();
    const endAt = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    let matchedAt = 0;

    while (Date.now() < endAt) {
      if (typeof isCancelled === "function" && isCancelled()) {
        throw createExportCancelledError();
      }

      const currentId = getConversationIdFromPath() || "";
      if (currentId === targetId) {
        if (matchedAt === 0) {
          matchedAt = Date.now();
        }

        const messageCount = countDomMessages();
        const scroller = findConversationScroller();
        const loading = hasActiveThreadLoadingIndicators(scroller);
        if (messageCount > 0 && !loading) {
          return true;
        }
        if (messageCount > 0 && (Date.now() - matchedAt) > 2200) {
          return true;
        }
      }

      await sleep(160);
    }

    return false;
  }

  async function createAndDownloadBatchHtml({
    meta,
    title,
    source,
    messages,
    position,
    totalCount,
    options,
    usedFileNames
  }) {
    const exportedAt = new Date();
    const exportMessages = await prepareMessagesForHtmlExport(messages, {
      position,
      totalCount
    });
    assertExportableConversationMessages(exportMessages);
    const threadStartedAt = resolveConversationStartedAt(exportMessages, [
      meta?.create_time,
      meta?.createTime,
      meta?.update_time,
      meta?.updateTime
    ]);
    const html = buildHtmlDocument({
      title,
      source,
      messages: exportMessages,
      exportedAt,
      threadStartedAt,
      pageUrl: buildConversationPageUrl(meta?.id || "")
    });

    const rawFileName = buildBatchFileName(title, threadStartedAt, position, totalCount);
    const fileName = uniquifyFileName(rawFileName, usedFileNames);
    const folderPath = buildBatchFolderPath({
      accountName: options?.accountName || "",
      yearOnlyFolder: Boolean(options?.yearOnlyFolder),
      date: threadStartedAt
    });

    await triggerBrowserDownload(html, fileName, { subdirectory: folderPath });
    return { fileName, source };
  }

  async function createAndDownloadBatchFailureReport({
    state,
    totalCount,
    options,
    usedFileNames
  }) {
    const failures = Array.isArray(state?.failures) ? state.failures : [];
    if (failures.length === 0) {
      return "";
    }

    const exportedAt = new Date();
    const reportHtml = buildBatchFailureReportHtml({
      state,
      totalCount,
      failures,
      exportedAt
    });
    const reportFileName = uniquifyFileName(
      "Batch_Failure_Report_" + formatDateForFileName(exportedAt) + ".html",
      usedFileNames instanceof Set ? usedFileNames : new Set()
    );
    const folderPath = buildBatchFolderPath({
      accountName: options?.accountName || "",
      yearOnlyFolder: Boolean(options?.yearOnlyFolder),
      date: exportedAt
    });

    await triggerBrowserDownload(reportHtml, reportFileName, { subdirectory: folderPath });
    return reportFileName;
  }

  function buildBatchFailureReportHtml({ state, totalCount, failures, exportedAt }) {
    const safeExportedAt = exportedAt instanceof Date ? exportedAt : new Date();
    const exportedIso = safeExportedAt.toISOString();
    const exportedLabel = formatTimestamp(safeExportedAt);
    const total = Math.max(0, Number(totalCount) || 0);
    const success = Math.max(0, Number(state?.successCount) || 0);
    const failure = Math.max(0, Number(state?.failureCount) || 0);
    const skipped = Math.max(0, Number(state?.skippedCount) || 0);
    const baseUrl = window.location.origin;

    const normalizedFailures = failures.map((item, idx) => {
      const id = String(item?.id || "").trim();
      const title = sanitizeConversationTitle(item?.title || "") || "Untitled";
      const error = String(item?.error || "").trim() || "Unknown error";
      const position = Number(item?.position);
      const positionLabel = Number.isFinite(position) && position > 0
        ? (String(position) + "/" + (total > 0 ? String(total) : "?"))
        : "-";
      const kind = formatBatchFailureKindLabel(item?.kind);
      const fallbackReason = classifyBatchFailureReason(item?.kind, error);
      const reasonCode = String(item?.reasonCode || "").trim() || fallbackReason.code;
      const reasonDetail = String(item?.reasonDetail || "").trim() || fallbackReason.detail;
      const atMs = Number(item?.at);
      const atLabel = Number.isFinite(atMs) && atMs > 0
        ? formatTimestamp(new Date(atMs))
        : "Unknown time";
      const threadUrl = id ? (baseUrl + "/c/" + encodeURIComponent(id)) : "";

      return {
        index: idx + 1,
        id,
        title,
        error,
        positionLabel,
        kind,
        reasonCode,
        reasonDetail,
        atLabel,
        threadUrl
      };
    });

    const rows = normalizedFailures.map((item) => {
      const threadCell = item.threadUrl
        ? ('<a href="' + escapeHtml(item.threadUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.id) + "</a>")
        : "-";

      return (
        "<tr>" +
        "<td>" + String(item.index) + "</td>" +
        "<td>" + escapeHtml(item.positionLabel) + "</td>" +
        "<td>" + escapeHtml(item.kind) + "</td>" +
        "<td><code>" + escapeHtml(item.reasonCode) + "</code></td>" +
        "<td>" + escapeHtml(item.reasonDetail) + "</td>" +
        "<td>" + threadCell + "</td>" +
        "<td>" + escapeHtml(item.title) + "</td>" +
        "<td><pre>" + escapeHtml(item.error) + "</pre></td>" +
        "</tr>"
      );
    }).join("\n");

    const reasonCounts = new Map();
    normalizedFailures.forEach((item) => {
      const key = String(item.reasonCode || "unknown_error").trim() || "unknown_error";
      reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
    });
    const reasonRows = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => (
        "<tr><td><code>" + escapeHtml(code) + "</code></td><td>" + String(count) + "</td></tr>"
      ))
      .join("\n");

    const diagnosticRows = normalizedFailures.map((item) => {
      const threadLink = item.threadUrl
        ? ('<a href="' + escapeHtml(item.threadUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.threadUrl) + "</a>")
        : "-";
      return (
        "<tr>" +
        "<td>" + String(item.index) + "</td>" +
        "<td>" + escapeHtml(item.atLabel) + "</td>" +
        "<td>" + escapeHtml(item.positionLabel) + "</td>" +
        "<td>" + escapeHtml(item.title) + "</td>" +
        "<td><code>" + escapeHtml(item.id || "-") + "</code></td>" +
        "<td><code>" + escapeHtml(item.reasonCode) + "</code></td>" +
        "<td>" + escapeHtml(item.reasonDetail) + "</td>" +
        "<td>" + threadLink + "</td>" +
        "<td><pre>" + escapeHtml(item.error) + "</pre></td>" +
        "</tr>"
      );
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Batch Failure Report</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 24px;
      font: 14px/1.5 "Segoe UI", Arial, sans-serif;
      color: #0f172a;
      background: #f3f7ff;
    }
    .card {
      max-width: 1400px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #dbe6f7;
      border-radius: 12px;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
      overflow: hidden;
    }
    .head {
      padding: 18px 20px;
      border-bottom: 1px solid #e5edf9;
      background: linear-gradient(180deg, #f8fbff 0%, #f3f7ff 100%);
    }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 1.15rem; }
    h2 { font-size: 1rem; }
    p { margin: 4px 0; color: #334155; }
    section { padding: 14px 18px; border-top: 1px solid #eef3fc; }
    .table-wrap { overflow: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    .reason-table { min-width: 360px; max-width: 640px; }
    th, td {
      border: 1px solid #e3ebf7;
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #edf3ff;
      font-weight: 700;
      color: #1e3a5f;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) td { background: #fbfdff; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font: 12px/1.3 Consolas, "Courier New", monospace;
      color: #0f172a;
      background: #f1f5ff;
      border: 1px solid #dfe8fb;
      border-radius: 4px;
      padding: 1px 4px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      max-width: 760px;
      font: 12px/1.45 Consolas, "Courier New", monospace;
      color: #0f172a;
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="head">
      <h1>Batch Failure Report</h1>
      <p><strong>Exported:</strong> <time datetime="${escapeHtml(exportedIso)}">${escapeHtml(exportedLabel)}</time></p>
      <p><strong>Total:</strong> ${total} | <strong>Saved:</strong> ${success} | <strong>Errors:</strong> ${failure} | <strong>Skipped:</strong> ${skipped}</p>
      <p><strong>Entries in report:</strong> ${normalizedFailures.length}</p>
    </section>
    <section>
      <h2>Errors by reason</h2>
      <div class="table-wrap">
        <table class="reason-table">
          <thead>
            <tr>
              <th>Reason Code</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
${reasonRows}
          </tbody>
        </table>
      </div>
    </section>
    <section class="table-wrap">
      <h2>Overview</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Position</th>
            <th>Type</th>
            <th>Reason Code</th>
            <th>Reason</th>
            <th>Conversation ID</th>
            <th>Title</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </section>
    <section class="table-wrap">
      <h2>Diagnostic log</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Position</th>
            <th>Title</th>
            <th>Conversation ID</th>
            <th>Reason Code</th>
            <th>Reason</th>
            <th>Thread link</th>
            <th>Raw error</th>
          </tr>
        </thead>
        <tbody>
${diagnosticRows}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
  }

  function formatBatchFailureKindLabel(kind) {
    const value = String(kind || "").trim().toLowerCase();
    if (value === "not_found") {
      return "Thread not found (404)";
    }
    if (value === "internal_iteration_error") {
      return "Internal batch error";
    }
    return "Error";
  }

  function buildBatchFailureEntry({ meta, position, kind, error }) {
    const errorMessage = String(
      typeof error === "string"
        ? error
        : (error?.message || error || "")
    ).trim() || "Unknown error";
    const reasonInfo = classifyBatchFailureReason(kind, errorMessage);

    return {
      position: Number(position) || 0,
      kind: String(kind || "error"),
      reasonCode: reasonInfo.code,
      reasonDetail: reasonInfo.detail,
      id: String(meta?.id || "").trim(),
      title: sanitizeConversationTitle(meta?.title || ""),
      error: errorMessage,
      at: Date.now()
    };
  }

  function classifyBatchFailureReason(kind, errorMessage) {
    const rawKind = String(kind || "").toLowerCase();
    const text = String(errorMessage || "").toLowerCase();

    if (rawKind === "not_found" || /\b404\b/.test(text) || /not\s*found|nicht gefunden/.test(text)) {
      return {
        code: "thread_not_found",
        detail: "Conversation was not found by endpoint (404), ID invalid, or unavailable in the current context."
      };
    }

    if (/\b429\b/.test(text) || /rate.?limit|too many requests|drossel/.test(text)) {
      return {
        code: "rate_limited",
        detail: "Requests were rate-limited. Retry with backoff."
      };
    }

    if (/timeout|timed out|abgebrochen|abort|signal/.test(text)) {
      return {
        code: "timeout_or_abort",
        detail: "Response timed out or the request was aborted."
      };
    }

    if (/download|blob|runtime-download|speicher|quota|storage/.test(text)) {
      return {
        code: "download_or_storage_error",
        detail: "Error while creating/saving export file (download/storage)."
      };
    }

    if (/keine nachrichten|keine exportierbaren nachrichten|empty|0 verwertbare nachrichten|ohne exportierbaren inhalt/.test(text)) {
      return {
        code: "empty_or_unparsed_thread",
        detail: "Thread was read but contained no usable messages/bodies."
      };
    }

    if (/route wurde noch nicht aktiv|navigation|oeffne thread|dom-fallback/.test(text)) {
      return {
        code: "navigation_or_dom_fallback_error",
        detail: "Navigation to thread or DOM fallback was not stable enough."
      };
    }

    if (rawKind === "internal_iteration_error" || /\[interner-batch-schritt\]/.test(text)) {
      return {
        code: "internal_batch_iteration_error",
        detail: "Internal error during batch iteration."
      };
    }

    return {
      code: "unknown_error",
      detail: "Error could not be classified clearly."
    };
  }

  function createBatchDebugLogger(state, totalCount) {
    const enabled = Boolean(state?.options?.debugLogEnabled);
    if (!enabled) {
      return { enabled: false };
    }

    const createdAtMs = Number(state?.createdAt) || Date.now();
    const safeCreatedAt = new Date(createdAtMs);
    const fallbackFileName = buildBatchDebugLogFileName(safeCreatedAt);
    const currentFileName = sanitizeForFileName(state?.options?.debugLogFileName || fallbackFileName);
    const fileName = /\.html?$/i.test(currentFileName) ? currentFileName : (currentFileName + ".html");

    if (state?.options && !state.options.debugLogFileName) {
      state.options.debugLogFileName = fileName;
    }
    if (!Array.isArray(state.debugEvents)) {
      state.debugEvents = [];
    }

    const events = state.debugEvents.slice(-BATCH_DEBUG_LOG_MAX_EVENTS);
    return {
      enabled: true,
      createdAtMs,
      fileName,
      totalCount: Math.max(0, Number(totalCount) || 0),
      events,
      lastFlushAt: 0,
      lastFlushDoneCount: Math.max(0, Number(state?.nextIndex) || 0)
    };
  }

  function appendBatchDebugEvent(context, payload = {}) {
    const logger = context?.debugLogger;
    if (!logger?.enabled) {
      return;
    }

    const state = context?.state || null;
    const failure = payload?.failure && typeof payload.failure === "object" ? payload.failure : null;
    const meta = payload?.meta && typeof payload.meta === "object" ? payload.meta : null;
    const extra = payload?.extra && typeof payload.extra === "object" ? payload.extra : null;
    const atMs = Date.now();
    const event = {
      at: atMs,
      level: String(payload?.level || "info").trim().toLowerCase() || "info",
      code: String(payload?.code || "").trim() || "event",
      message: String(payload?.message || "").trim() || "Event",
      position: Math.max(0, Number(payload?.position) || 0),
      id: String(failure?.id || meta?.id || "").trim(),
      title: sanitizeConversationTitle(failure?.title || meta?.title || ""),
      reasonCode: String(failure?.reasonCode || extra?.reasonCode || "").trim(),
      reasonDetail: String(failure?.reasonDetail || "").trim(),
      error: String(failure?.error || extra?.error || "").trim(),
      trigger: String(payload?.trigger || "").trim()
    };

    logger.events.push(event);
    if (logger.events.length > BATCH_DEBUG_LOG_MAX_EVENTS) {
      logger.events.splice(0, logger.events.length - BATCH_DEBUG_LOG_MAX_EVENTS);
    }

    if (state) {
      if (!Array.isArray(state.debugEvents)) {
        state.debugEvents = [];
      }
      state.debugEvents.push(event);
      if (state.debugEvents.length > BATCH_DEBUG_LOG_MAX_EVENTS) {
        state.debugEvents.splice(0, state.debugEvents.length - BATCH_DEBUG_LOG_MAX_EVENTS);
      }
    }
  }

  async function maybeFlushBatchDebugLog(context, options = {}) {
    const logger = context?.debugLogger;
    const state = context?.state;
    if (!logger?.enabled || !state) {
      return;
    }

    const force = Boolean(options?.force);
    const nowMs = Date.now();
    const totalCount = Math.max(0, Number(logger.totalCount) || Number(state?.items?.length) || 0);
    const doneCount = getBatchCompletedCount(state, totalCount);
    const elapsedSinceFlush = nowMs - (Number(logger.lastFlushAt) || 0);
    const progressedSinceFlush = doneCount - (Number(logger.lastFlushDoneCount) || 0);

    const shouldFlush = force ||
      logger.lastFlushAt <= 0 ||
      elapsedSinceFlush >= BATCH_DEBUG_LOG_MIN_FLUSH_MS ||
      progressedSinceFlush >= BATCH_DEBUG_LOG_PROGRESS_FLUSH_EVERY;

    if (!shouldFlush) {
      return;
    }

    logger.lastFlushAt = nowMs;
    logger.lastFlushDoneCount = doneCount;

    const folderPath = buildBatchAccountRootFolderPath(state?.options?.accountName || "");
    const html = buildBatchDebugCheckpointHtml({
      state,
      totalCount,
      events: logger.events,
      trigger: String(options?.trigger || "").trim(),
      exportedAt: new Date(nowMs)
    });

    try {
      await triggerBrowserDownload(html, logger.fileName, {
        subdirectory: folderPath,
        conflictAction: "overwrite"
      });
    } catch (error) {
      console.warn("[ChatGPT Export] Debug log checkpoint failed:", error);
    }
  }

  function buildBatchDebugCheckpointHtml({ state, totalCount, events, trigger, exportedAt }) {
    const safeExportedAt = exportedAt instanceof Date ? exportedAt : new Date();
    const exportedIso = safeExportedAt.toISOString();
    const exportedLabel = formatTimestamp(safeExportedAt);
    const total = Math.max(0, Number(totalCount) || 0);
    const success = Math.max(0, Number(state?.successCount) || 0);
    const failure = Math.max(0, Number(state?.failureCount) || 0);
    const skipped = Math.max(0, Number(state?.skippedCount) || 0);
    const nextIndex = Math.max(0, Number(state?.nextIndex) || 0);
    const status = String(state?.status || "running");

    const failureRows = (Array.isArray(state?.failures) ? state.failures : []).map((item, idx) => {
      const id = String(item?.id || "").trim();
      const title = sanitizeConversationTitle(item?.title || "") || "Untitled";
      const reasonCode = String(item?.reasonCode || "").trim() || "unknown_error";
      const reasonDetail = String(item?.reasonDetail || "").trim() || "";
      const error = String(item?.error || "").trim() || "Unknown error";
      const position = Math.max(0, Number(item?.position) || 0);
      return (
        "<tr>" +
        "<td>" + String(idx + 1) + "</td>" +
        "<td>" + String(position > 0 ? position : "-") + "</td>" +
        "<td><code>" + escapeHtml(reasonCode) + "</code></td>" +
        "<td>" + escapeHtml(reasonDetail) + "</td>" +
        "<td><code>" + escapeHtml(id || "-") + "</code></td>" +
        "<td>" + escapeHtml(title) + "</td>" +
        "<td><pre>" + escapeHtml(error) + "</pre></td>" +
        "</tr>"
      );
    }).join("\n");

    const eventRows = (Array.isArray(events) ? events : []).map((item, idx) => {
      const atMs = Number(item?.at) || 0;
      const atLabel = atMs > 0 ? formatTimestamp(new Date(atMs)) : "Unknown time";
      const level = String(item?.level || "info").trim().toLowerCase() || "info";
      const code = String(item?.code || "event").trim() || "event";
      const position = Math.max(0, Number(item?.position) || 0);
      const id = String(item?.id || "").trim();
      const title = sanitizeConversationTitle(item?.title || "");
      const message = String(item?.message || "").trim() || "-";
      const reasonCode = String(item?.reasonCode || "").trim();
      const error = String(item?.error || "").trim();
      return (
        "<tr>" +
        "<td>" + String(idx + 1) + "</td>" +
        "<td>" + escapeHtml(atLabel) + "</td>" +
        "<td>" + escapeHtml(level) + "</td>" +
        "<td><code>" + escapeHtml(code) + "</code></td>" +
        "<td>" + String(position > 0 ? position : "-") + "</td>" +
        "<td><code>" + escapeHtml(id || "-") + "</code></td>" +
        "<td>" + escapeHtml(title || "-") + "</td>" +
        "<td>" + escapeHtml(message) + "</td>" +
        "<td><code>" + escapeHtml(reasonCode || "-") + "</code></td>" +
        "<td><pre>" + escapeHtml(error || "") + "</pre></td>" +
        "</tr>"
      );
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Batch Debug Log (Live)</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font: 13px/1.45 "Segoe UI", Arial, sans-serif;
      color: #0f172a;
      background: #f4f8ff;
    }
    .card {
      max-width: 1450px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #dbe6f7;
      border-radius: 10px;
      overflow: hidden;
    }
    .head {
      padding: 14px 16px;
      border-bottom: 1px solid #e5edf9;
      background: #f8fbff;
    }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 1.05rem; }
    h2 { font-size: 0.95rem; }
    p { margin: 4px 0; color: #334155; }
    section { padding: 12px 14px; border-top: 1px solid #eef3fc; }
    .table-wrap { overflow: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      border: 1px solid #e3ebf7;
      padding: 7px 9px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #edf3ff;
      font-weight: 700;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) td { background: #fbfdff; }
    code {
      font: 12px/1.3 Consolas, "Courier New", monospace;
      background: #f1f5ff;
      border: 1px solid #dfe8fb;
      border-radius: 4px;
      padding: 1px 4px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.4 Consolas, "Courier New", monospace;
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="head">
      <h1>Batch Debug Log (Live checkpoint)</h1>
      <p><strong>Checkpoint:</strong> <time datetime="${escapeHtml(exportedIso)}">${escapeHtml(exportedLabel)}</time></p>
      <p><strong>Trigger:</strong> ${escapeHtml(trigger || "auto")}</p>
      <p><strong>Status:</strong> ${escapeHtml(status)} | <strong>Progress:</strong> ${nextIndex}/${total} | <strong>Saved:</strong> ${success} | <strong>Errors:</strong> ${failure} | <strong>Skipped:</strong> ${skipped}</p>
      <p><strong>Events (in memory):</strong> ${(Array.isArray(events) ? events.length : 0)} | <strong>Error entries:</strong> ${(Array.isArray(state?.failures) ? state.failures.length : 0)}</p>
    </section>
    <section class="table-wrap">
      <h2>Error list</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Position</th>
            <th>Reason Code</th>
            <th>Reason</th>
            <th>Conversation ID</th>
            <th>Title</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
${failureRows}
        </tbody>
      </table>
    </section>
    <section class="table-wrap">
      <h2>Event-Log</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Level</th>
            <th>Code</th>
            <th>Position</th>
            <th>Conversation ID</th>
            <th>Title</th>
            <th>Message</th>
            <th>Reason Code</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
${eventRows}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
  }

  function buildBatchDebugLogFileName(date) {
    const ts = date instanceof Date ? date : new Date();
    return "Batch_Debug_Live_" + formatDateForFileName(ts) + ".html";
  }

  async function prepareMessagesForHtmlExport(messages, context = {}) {
    const sourceList = Array.isArray(messages) ? messages : [];
    const normalized = sourceList.map((message) => ({
      ...message,
      bodyHtml: resolveMessageBodyHtml(message)
    }));

    const uniqueImageSources = collectUniqueImageSourcesFromMessages(normalized);
    if (uniqueImageSources.length === 0) {
      return normalized;
    }

    const targetImageSources = uniqueImageSources.slice(0, EXPORT_IMAGE_MAX_COUNT);
    const skippedByCount = Math.max(0, uniqueImageSources.length - targetImageSources.length);

    const imageMap = new Map();
    let embeddedBytes = 0;
    let failedCount = 0;
    let skippedByBudget = 0;
    let skippedBySize = 0;

    for (let index = 0; index < targetImageSources.length; index += 1) {
      const src = targetImageSources[index];
      const remainingBudget = EXPORT_IMAGE_MAX_TOTAL_BYTES - embeddedBytes;
      if (remainingBudget <= 0) {
        skippedByBudget += (targetImageSources.length - index);
        break;
      }

      if (index === 0 || ((index + 1) % 3 === 0)) {
        const pos = Number(context?.position) || 0;
        const total = Number(context?.totalCount) || 0;
        const prefix = (pos > 0 && total > 0)
          ? ("Batch " + pos + "/" + total + " | ")
          : "";
        setStatus(
          prefix + "Embedding images " + (index + 1) + "/" + targetImageSources.length + "...",
          "busy"
        );
      }

      const fetched = await fetchImageAsDataUrlForExport(src, {
        timeoutMs: EXPORT_IMAGE_FETCH_TIMEOUT_MS,
        maxBytes: Math.min(EXPORT_IMAGE_MAX_BYTES_PER_FILE, remainingBudget)
      });

      if (!fetched?.ok) {
        if (fetched?.reason === "too_large") {
          skippedBySize += 1;
        } else if (fetched?.reason === "budget") {
          skippedByBudget += 1;
        } else {
          failedCount += 1;
        }
        continue;
      }

      imageMap.set(src, fetched.dataUrl);
      embeddedBytes += Math.max(0, Number(fetched.size) || 0);
    }

    if (imageMap.size > 0) {
      normalized.forEach((message) => {
        message.bodyHtml = replaceImageSourcesInHtml(message.bodyHtml, imageMap);
      });
    }

    if (failedCount > 0 || skippedBySize > 0 || skippedByBudget > 0 || skippedByCount > 0) {
      console.warn("[ChatGPT Export] Some images could not be embedded.", {
        totalFound: uniqueImageSources.length,
        embedded: imageMap.size,
        failed: failedCount,
        skippedBySize,
        skippedByBudget,
        skippedByCount
      });
    }

    return normalized;
  }

  function collectUniqueImageSourcesFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    const seen = new Set();
    const out = [];

    messages.forEach((message) => {
      const bodyHtml = String(message?.bodyHtml || "");
      const sources = extractImageSourcesFromHtml(bodyHtml);
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        if (!source || seen.has(source)) {
          continue;
        }
        seen.add(source);
        out.push(source);
      }
    });

    return out;
  }

  function extractImageSourcesFromHtml(rawHtml) {
    const source = String(rawHtml || "").trim();
    if (!source) {
      return [];
    }

    const template = document.createElement("template");
    template.innerHTML = source;
    const images = template.content.querySelectorAll("img[src]");
    const out = [];

    images.forEach((img) => {
      const src = sanitizeImageSrcForExport(img.getAttribute("src") || "");
      if (!src) {
        return;
      }
      if (/^data:image\//i.test(src)) {
        return;
      }
      out.push(src);
    });

    return out;
  }

  function replaceImageSourcesInHtml(rawHtml, imageMap) {
    const source = String(rawHtml || "");
    if (!source || !(imageMap instanceof Map) || imageMap.size === 0) {
      return source;
    }

    const template = document.createElement("template");
    template.innerHTML = source;
    const images = template.content.querySelectorAll("img[src]");

    images.forEach((img) => {
      const src = sanitizeImageSrcForExport(img.getAttribute("src") || "");
      if (!src) {
        return;
      }
      const embedded = imageMap.get(src);
      if (embedded) {
        img.setAttribute("data-export-original-src", src);
        img.setAttribute("src", embedded);
      }
      img.setAttribute("data-lightbox", "1");
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
    });

    return template.innerHTML.trim();
  }

  async function fetchImageAsDataUrlForExport(url, options = {}) {
    const sourceUrl = sanitizeImageSrcForExport(url);
    if (!sourceUrl) {
      return { ok: false, reason: "invalid_url" };
    }
    if (/^data:image\//i.test(sourceUrl)) {
      return { ok: true, dataUrl: sourceUrl, size: 0 };
    }

    const timeoutMs = Math.max(2000, Number(options?.timeoutMs) || EXPORT_IMAGE_FETCH_TIMEOUT_MS);
    const maxBytes = Math.max(2048, Number(options?.maxBytes) || EXPORT_IMAGE_MAX_BYTES_PER_FILE);
    if (maxBytes <= 0) {
      return { ok: false, reason: "budget" };
    }

    const attempts = [
      { credentials: "include" },
      { credentials: "omit" }
    ];

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const attempt = attempts[attemptIndex];
      const result = await tryFetchImageBlobForExport(sourceUrl, timeoutMs, attempt.credentials);
      if (!result?.ok || !result.blob) {
        continue;
      }

      const blob = result.blob;
      const blobSize = Number(blob.size) || 0;
      if (blobSize <= 0) {
        continue;
      }
      if (blobSize > maxBytes) {
        return { ok: false, reason: "too_large", size: blobSize };
      }

      const mimeFromBlob = String(blob.type || "").toLowerCase();
      const inferredMime = mimeFromBlob.startsWith("image/")
        ? mimeFromBlob
        : inferImageMimeTypeFromUrl(sourceUrl);
      if (!inferredMime || !/^image\//i.test(inferredMime)) {
        continue;
      }

      const dataUrl = await blobToDataUrl(blob, inferredMime);
      if (!/^data:image\//i.test(String(dataUrl || ""))) {
        continue;
      }

      return {
        ok: true,
        dataUrl,
        size: blobSize
      };
    }

    return { ok: false, reason: "fetch_failed" };
  }

  async function tryFetchImageBlobForExport(url, timeoutMs, credentials) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        credentials: credentials || "include",
        cache: "no-store"
      }, timeoutMs);
      if (!response || !response.ok) {
        return {
          ok: false,
          status: Number(response?.status) || 0
        };
      }
      const blob = await response.blob();
      return {
        ok: true,
        status: Number(response.status) || 200,
        blob
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  async function blobToDataUrl(blob, fallbackMimeType) {
    const fallback = String(fallbackMimeType || "").toLowerCase();
    const raw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Blob could not be read."));
      reader.readAsDataURL(blob);
    });

    if (!raw.startsWith("data:")) {
      return "";
    }

    if (/^data:image\//i.test(raw)) {
      return raw;
    }

    if (fallback && /^image\//i.test(fallback)) {
      return raw.replace(/^data:[^;,]*/i, "data:" + fallback);
    }
    return raw;
  }

  function inferImageMimeTypeFromUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) {
      return "";
    }
    let pathname = "";
    try {
      pathname = new URL(raw, window.location.origin).pathname || "";
    } catch (_error) {
      pathname = raw;
    }

    const lower = pathname.toLowerCase();
    if (lower.endsWith(".png")) {
      return "image/png";
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (lower.endsWith(".webp")) {
      return "image/webp";
    }
    if (lower.endsWith(".gif")) {
      return "image/gif";
    }
    if (lower.endsWith(".avif")) {
      return "image/avif";
    }
    if (lower.endsWith(".bmp")) {
      return "image/bmp";
    }
    if (lower.endsWith(".svg")) {
      return "image/svg+xml";
    }
    return "";
  }

  function requestExportCancel() {
    if (isExporting) {
      exportCancelRequested = true;
      if (batchRunContext && batchRunContext.running) {
        batchRunContext.cancelRequested = true;
      }
      setStatus("Stop requested. Current step will finish...", "busy", 9000);
      return true;
    }

    const savedState = loadBatchState();
    if (hasResumableBatchState(savedState)) {
      savedState.status = "paused";
      savedState.updatedAt = Date.now();
      saveBatchState(savedState);
      setStatus("Batch paused.", "success", 5000);
      return true;
    }

    return false;
  }

  function createExportCancelledError() {
    const error = new Error("Export was stopped by user.");
    error.code = "export_cancelled";
    return error;
  }

  function isExportCancelledError(error) {
    return error?.code === "export_cancelled";
  }

  function isConversationPage() {
    const path = window.location.pathname;
    return /^\/c\/[0-9a-zA-Z_-]+/.test(path) || Boolean(document.querySelector("article[data-testid^='conversation-turn-']"));
  }

  function getConversationTitleFromPage() {
    const rawTitle = (document.title || "").trim();
    const cleaned = rawTitle
      .replace(/\s*[-|:]\s*ChatGPT.*$/i, "")
      .replace(/\s*\|\s*OpenAI.*$/i, "")
      .trim();
    return cleaned || "chatgpt_dialog";
  }

  async function collectMessages(progressCallback, options = {}) {
    const conversationId = getConversationIdFromPath() || "";
    await waitForCapturedConversationData(conversationId, 1400);

    progressCallback("Collecting messages from DOM...", "busy");
    const domMessages = await collectMessagesFromDom(progressCallback, {
      allowExtendedWait: options?.allowExtendedWait !== false,
      isCancelled: typeof options?.isCancelled === "function" ? options.isCancelled : null
    });
    return {
      source: "dom",
      conversationTitle: getCapturedConversationTitle(conversationId) || getConversationTitleFromPage(),
      messages: domMessages
    };
  }

  async function waitForCapturedConversationData(conversationId, timeoutMs) {
    if (!conversationId) {
      return false;
    }

    const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() < end) {
      const map = getCapturedTimestampMap(conversationId);
      if (map && map.size > 0) {
        return true;
      }
      await sleep(90);
    }
    return false;
  }

  function getConversationIdFromPath() {
    const match = window.location.pathname.match(/\/c\/([0-9a-zA-Z_-]{8,})/);
    return match ? match[1] : null;
  }

  function buildConversationPageUrl(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) {
      return window.location.href;
    }
    return window.location.origin + "/c/" + encodeURIComponent(id);
  }

  function normalizeBatchExportOptions(rawOptions) {
    const yearOnlyFolder = typeof rawOptions?.yearOnlyFolder === "boolean"
      ? rawOptions.yearOnlyFolder
      : batchYearFolderOnly;
    const debugLogEnabled = typeof rawOptions?.debugLogEnabled === "boolean"
      ? rawOptions.debugLogEnabled
      : batchDebugLogEnabled;

    const providedAccountName = sanitizeConversationTitle(rawOptions?.accountName || "");
    const accountName = providedAccountName || resolveAccountNameForBatch();

    return {
      yearOnlyFolder,
      accountName,
      debugLogEnabled
    };
  }

  function initializeBatchState(items, options) {
    const now = Date.now();
    const normalizedItems = Array.isArray(items)
      ? items
        .map((item) => ({
          id: String(item?.id || "").trim(),
          title: sanitizeConversationTitle(item?.title || ""),
          create_time: item?.create_time ?? null,
          update_time: item?.update_time ?? null
        }))
        .filter((item) => item.id)
      : [];

    return {
      version: BATCH_STATE_VERSION,
      createdAt: now,
      updatedAt: now,
      status: "running",
      nextIndex: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      failures: [],
      debugEvents: [],
      usedFileNames: [],
      options: {
        yearOnlyFolder: Boolean(options?.yearOnlyFolder),
        accountName: sanitizeConversationTitle(options?.accountName || ""),
        debugLogEnabled: Boolean(options?.debugLogEnabled),
        debugLogFileName: buildBatchDebugLogFileName(new Date(now))
      },
      items: normalizedItems
    };
  }

  function normalizeStoredBatchState(rawState) {
    if (!rawState || typeof rawState !== "object") {
      return null;
    }

    const normalized = {
      version: Number(rawState.version) || BATCH_STATE_VERSION,
      createdAt: Number(rawState.createdAt) || Date.now(),
      updatedAt: Number(rawState.updatedAt) || Date.now(),
      status: String(rawState.status || "paused"),
      nextIndex: Math.max(0, Number(rawState.nextIndex) || 0),
      successCount: Math.max(0, Number(rawState.successCount) || 0),
      failureCount: Math.max(0, Number(rawState.failureCount) || 0),
      skippedCount: Math.max(0, Number(rawState.skippedCount) || 0),
      failures: Array.isArray(rawState.failures) ? rawState.failures.slice(0, 5000) : [],
      debugEvents: Array.isArray(rawState.debugEvents) ? rawState.debugEvents.slice(-BATCH_DEBUG_LOG_MAX_EVENTS) : [],
      usedFileNames: Array.isArray(rawState.usedFileNames) ? rawState.usedFileNames.slice(0, 20000) : [],
      options: {
        yearOnlyFolder: Boolean(rawState?.options?.yearOnlyFolder),
        accountName: sanitizeConversationTitle(rawState?.options?.accountName || ""),
        debugLogEnabled: Boolean(rawState?.options?.debugLogEnabled),
        debugLogFileName: sanitizeForFileName(rawState?.options?.debugLogFileName || "")
      },
      items: Array.isArray(rawState.items)
        ? rawState.items
          .map((item) => ({
            id: String(item?.id || "").trim(),
            title: sanitizeConversationTitle(item?.title || ""),
            create_time: item?.create_time ?? null,
            update_time: item?.update_time ?? null
          }))
          .filter((item) => item.id)
        : []
    };

    if (!normalized.options.accountName) {
      normalized.options.accountName = resolveAccountNameForBatch();
    }
    if (!normalized.options.debugLogFileName) {
      normalized.options.debugLogFileName = buildBatchDebugLogFileName(new Date(normalized.createdAt || Date.now()));
    }

    if (normalized.nextIndex > normalized.items.length) {
      normalized.nextIndex = normalized.items.length;
    }

    return normalized;
  }

  function hasResumableBatchState(state) {
    const normalized = normalizeStoredBatchState(state);
    if (!normalized) {
      return false;
    }
    const age = Date.now() - (Number(normalized.updatedAt) || 0);
    if (age > BATCH_STATE_EXPIRY_MS) {
      return false;
    }
    if (!Array.isArray(normalized.items) || normalized.items.length === 0) {
      return false;
    }
    return normalized.nextIndex < normalized.items.length && normalized.status !== "completed";
  }

  function getBatchCompletedCount(state, totalCount) {
    const total = Math.max(0, Number(totalCount) || 0);
    const successCount = Math.max(0, Number(state?.successCount) || 0);
    const failureCount = Math.max(0, Number(state?.failureCount) || 0);
    const skippedCount = Math.max(0, Number(state?.skippedCount) || 0);
    const nextIndex = Math.max(0, Number(state?.nextIndex) || 0);

    let done = Math.max(nextIndex, successCount + failureCount + skippedCount);
    if (total > 0) {
      done = Math.min(total, done);
    }
    return done;
  }

  function buildBatchProgressSnapshot(rawState) {
    let normalized = rawState;
    if (!normalized || typeof normalized !== "object" || !Array.isArray(normalized.items)) {
      normalized = normalizeStoredBatchState(rawState);
    }
    if (!normalized || !Array.isArray(normalized.items) || normalized.items.length === 0) {
      return null;
    }

    const totalCount = normalized.items.length;
    const successCount = Math.max(0, Number(normalized.successCount) || 0);
    const failureCount = Math.max(0, Number(normalized.failureCount) || 0);
    const skippedCount = Math.max(0, Number(normalized.skippedCount) || 0);
    const doneCount = getBatchCompletedCount(normalized, totalCount);

    return {
      totalCount,
      doneCount,
      successCount,
      failureCount,
      skippedCount
    };
  }

  function loadBatchState() {
    try {
      const raw = window.localStorage.getItem(BATCH_STATE_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      const normalized = normalizeStoredBatchState(parsed);
      if (!normalized) {
        return null;
      }
      const age = Date.now() - (Number(normalized.updatedAt) || 0);
      if (age > BATCH_STATE_EXPIRY_MS) {
        clearBatchState();
        return null;
      }
      return normalized;
    } catch (_error) {
      return null;
    }
  }

  function saveBatchState(state) {
    if (!state || typeof state !== "object") {
      return;
    }
    const normalized = normalizeStoredBatchState(state);
    if (!normalized) {
      return;
    }
    normalized.version = BATCH_STATE_VERSION;
    normalized.updatedAt = Date.now();
    try {
      window.localStorage.setItem(BATCH_STATE_STORAGE_KEY, JSON.stringify(normalized));
      persistRuntimeState(false);
    } catch (_error) {
      // Ignore storage quota failures and continue batch run.
    }
  }

  function clearBatchState() {
    try {
      window.localStorage.removeItem(BATCH_STATE_STORAGE_KEY);
      persistRuntimeState(false);
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function setExportLifecycleActive(operation) {
    runtimeOperation = String(operation || "");
    runtimeStartedAt = Date.now();
    startRuntimeHeartbeat();
    persistRuntimeState(true);
  }

  function setExportLifecycleIdle() {
    runtimeOperation = "";
    runtimeStartedAt = 0;
    stopRuntimeHeartbeat();
    persistRuntimeState(true);
  }

  function buildRuntimeStateSnapshot() {
    const savedBatchState = loadBatchState();
    const activeBatchState =
      (batchRunContext?.state && Array.isArray(batchRunContext.state.items) ? batchRunContext.state : null) ||
      (savedBatchState && Array.isArray(savedBatchState.items) ? savedBatchState : null);
    const batchProgress = buildBatchProgressSnapshot(activeBatchState);

    return {
      isExporting: Boolean(isExporting),
      isBatchRunning: Boolean(batchRunContext && batchRunContext.running),
      hasBatchResume: hasResumableBatchState(savedBatchState),
      operation: runtimeOperation,
      statusMessage: runtimeStatusMessage,
      statusKind: runtimeStatusKind,
      statusUpdatedAt: Number(runtimeStatusUpdatedAt) || 0,
      startedAt: Number(runtimeStartedAt) || 0,
      heartbeatAt: Date.now(),
      batchYearFolderOnly: Boolean(batchYearFolderOnly),
      batchDebugLogEnabled: Boolean(batchDebugLogEnabled),
      batchTotalCount: Number(batchProgress?.totalCount) || 0,
      batchDoneCount: Number(batchProgress?.doneCount) || 0,
      batchSuccessCount: Number(batchProgress?.successCount) || 0,
      batchFailureCount: Number(batchProgress?.failureCount) || 0,
      batchSkippedCount: Number(batchProgress?.skippedCount) || 0
    };
  }

  function startRuntimeHeartbeat() {
    if (runtimeHeartbeatTimer) {
      return;
    }

    runtimeHeartbeatTimer = setInterval(() => {
      persistRuntimeState(true);
    }, RUNTIME_STATE_HEARTBEAT_MS);
  }

  function stopRuntimeHeartbeat() {
    if (!runtimeHeartbeatTimer) {
      return;
    }
    clearInterval(runtimeHeartbeatTimer);
    runtimeHeartbeatTimer = null;
  }

  function persistRuntimeState(force = false) {
    if (!chrome?.storage?.local) {
      return;
    }

    if (force) {
      if (runtimeStateFlushTimer) {
        clearTimeout(runtimeStateFlushTimer);
        runtimeStateFlushTimer = null;
      }
      flushRuntimeStateNow();
      return;
    }

    if (runtimeStateFlushTimer) {
      return;
    }

    runtimeStateFlushTimer = setTimeout(() => {
      runtimeStateFlushTimer = null;
      flushRuntimeStateNow();
    }, RUNTIME_STATE_WRITE_THROTTLE_MS);
  }

  function flushRuntimeStateNow() {
    if (!chrome?.storage?.local) {
      return;
    }

    const snapshot = buildRuntimeStateSnapshot();
    try {
      chrome.storage.local.set(
        {
          [RUNTIME_STATE_STORAGE_KEY]: snapshot
        },
        () => {
          void chrome.runtime?.lastError;
        }
      );
    } catch (_error) {
      // Ignore storage write errors.
    }
  }

  function scheduleBatchAutoResume() {
    if (batchAutoResumeScheduled) {
      return;
    }
    batchAutoResumeScheduled = true;

    setTimeout(() => {
      batchAutoResumeScheduled = false;
      if (isExporting) {
        return;
      }
      const savedState = loadBatchState();
      if (!hasResumableBatchState(savedState)) {
        return;
      }
      if (String(savedState.status || "") !== "running") {
        return;
      }

      void startBatchExportFromState(savedState, "auto").catch((error) => {
        console.error("[ChatGPT Export] Auto-resume failed:", error);
      });
    }, BATCH_AUTO_RESUME_DELAY_MS);
  }

  function askBatchExportCount(totalKnown, options = {}) {
    const totalLikelyReliable = Boolean(options?.totalLikelyReliable);
    const label = Number.isFinite(totalKnown)
      ? (totalLikelyReliable
        ? String(totalKnown)
        : (String(totalKnown) + " (currently loaded, there may be more)"))
      : "unbekannt";
    const input = window.prompt(
      "Batch export started.\nTotal threads: " + label + ".\nHow many should be exported?\nLeave empty = all.",
      ""
    );

    if (input == null) {
      return null;
    }

    const trimmed = input.trim();
    if (trimmed === "") {
      return Number.POSITIVE_INFINITY;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("Please enter a positive number for batch export.");
    }

    return Math.floor(parsed);
  }

  function isConversationTotalLikelyReliable(page) {
    if (!page || !Array.isArray(page.items)) {
      return false;
    }

    if (!Number.isFinite(page.total)) {
      return false;
    }

    if (page.hasMore === true) {
      return true;
    }

    if (Number(page.total) > page.items.length) {
      return true;
    }

    if (page.items.length >= BATCH_LIST_PAGE_LIMIT) {
      return true;
    }

    return false;
  }

  async function collectConversationMetasForBatch(requestedCount, firstPage, progressCallback) {
    const targetCount = Number.isFinite(requestedCount)
      ? requestedCount
      : Number.POSITIVE_INFINITY;

    const seen = new Set();
    const collected = [];

    firstPage.items.forEach((item) => {
      if (!item.id || seen.has(item.id)) {
        return;
      }
      seen.add(item.id);
      collected.push(item);
    });

    let offset = firstPage.nextOffset;
    let hasMore = firstPage.hasMore;
    let totalKnown = firstPage.total;
    let pageNumber = 1;

    while (hasMore && collected.length < targetCount && pageNumber < BATCH_MAX_PAGES) {
      pageNumber += 1;
      progressCallback(
        "Batch: Loading thread list (" + collected.length + " collected, page " + pageNumber + ")...",
        "busy"
      );

      const payload = await fetchConversationListPage(offset, BATCH_LIST_PAGE_LIMIT, progressCallback);
      const page = normalizeConversationListPage(payload, offset, BATCH_LIST_PAGE_LIMIT);

      if (Number.isFinite(page.total)) {
        totalKnown = page.total;
      }

      if (page.items.length === 0) {
        break;
      }

      page.items.forEach((item) => {
        if (!item.id || seen.has(item.id)) {
          return;
        }
        seen.add(item.id);
        collected.push(item);
      });

      offset = page.nextOffset;
      hasMore = page.hasMore;

      if (Number.isFinite(totalKnown) && offset >= totalKnown) {
        hasMore = false;
      }
    }

    if (collected.length < targetCount) {
      progressCallback("Batch: Scanning sidebar to load more threads...", "busy");
      const sidebarItems = await collectConversationMetasFromSidebarSweep({
        knownIds: seen,
        targetCount,
        progressCallback
      });

      for (let index = 0; index < sidebarItems.length; index += 1) {
        const item = sidebarItems[index];
        if (!item?.id || seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        collected.push(item);
        if (collected.length >= targetCount) {
          break;
        }
      }
    }

    const limited = collected.slice(0, targetCount);
    return {
      total: totalKnown,
      items: limited
    };
  }

  async function fetchConversationListPage(offset, limit, progressCallback) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Number(limit) || BATCH_LIST_PAGE_LIMIT);
    const endpointCandidates = buildConversationListEndpointCandidates(safeOffset, safeLimit);
    let lastError = null;
    let lastSuccessfulBody = null;

    for (let attempt = 1; attempt <= BATCH_LIST_MAX_RETRIES; attempt += 1) {
      if (progressCallback && attempt > 1) {
        progressCallback("Batch: List retry " + attempt + "/" + BATCH_LIST_MAX_RETRIES + "...", "busy");
      }

      for (let endpointIndex = 0; endpointIndex < endpointCandidates.length; endpointIndex += 1) {
        const endpoint = endpointCandidates[endpointIndex];
        try {
          const response = await fetchJsonWithFallback(endpoint, {
            method: "GET",
            credentials: "include",
            headers: {
              Accept: "application/json"
            }
          }, BATCH_LIST_TIMEOUT_MS);

          if (!response.ok) {
            lastError = new Error("HTTP " + response.status + " while loading thread list");
            continue;
          }

          const normalized = normalizeConversationListPage(response.body, safeOffset, safeLimit);
          if (normalized.items.length > 0) {
            return response.body;
          }

          lastSuccessfulBody = response.body;
        } catch (error) {
          lastError = error;
        }
      }

      if (lastSuccessfulBody !== null) {
        break;
      }

      if (attempt >= BATCH_LIST_MAX_RETRIES) {
        break;
      }
      const delayMs = API_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 220);
      await sleep(delayMs);
    }

    if (lastSuccessfulBody !== null) {
      return lastSuccessfulBody;
    }

    throw lastError || new Error("Thread list could not be loaded.");
  }

  function buildConversationListEndpointCandidates(offset, limit) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Number(limit) || BATCH_LIST_PAGE_LIMIT);
    const endpointSet = new Set();
    const projectId = resolveActiveProjectId();

    const pushCandidate = (extraParams = {}) => {
      const params = new URLSearchParams();
      params.set("offset", String(safeOffset));
      params.set("limit", String(safeLimit));
      Object.keys(extraParams).forEach((key) => {
        const value = extraParams[key];
        if (value == null || value === "") {
          return;
        }
        params.set(key, String(value));
      });
      endpointSet.add("/backend-api/conversations?" + params.toString());
    };

    pushCandidate({ order: "updated" });
    pushCandidate({ order: "updated", is_archived: "false" });
    pushCandidate({});

    if (projectId) {
      pushCandidate({ order: "updated", project_id: projectId });
      pushCandidate({ project_id: projectId });
    }

    return Array.from(endpointSet);
  }

  function resolveActiveProjectId() {
    const search = new URLSearchParams(window.location.search || "");
    const fromQuery = String(search.get("project_id") || search.get("projectId") || "").trim();
    if (fromQuery) {
      return fromQuery;
    }

    const path = String(window.location.pathname || "");
    const pathMatch = path.match(/\/projects?\/([0-9a-zA-Z_-]{6,})/);
    if (pathMatch && pathMatch[1]) {
      return String(pathMatch[1]).trim();
    }

    const fromDom = String(
      document.documentElement?.getAttribute("data-project-id") ||
      document.body?.getAttribute("data-project-id") ||
      ""
    ).trim();
    return fromDom || "";
  }

  function normalizeConversationListPage(payload, offset, limit) {
    const rawItems = extractConversationListItems(payload);

    const items = rawItems
      .map((item) => normalizeConversationListItem(item))
      .filter((item) => item.id);

    const total = firstFiniteNumber([
      payload?.total,
      payload?.count,
      payload?.data?.total,
      payload?.data?.count,
      payload?.meta?.total,
      payload?.data?.conversations?.total
    ]);

    const hasMoreCandidate = firstBoolean([
      payload?.has_more,
      payload?.hasMore,
      payload?.data?.has_more,
      payload?.data?.hasMore,
      payload?.meta?.has_more,
      payload?.meta?.hasMore,
      payload?.data?.conversations?.has_more,
      payload?.data?.conversations?.hasMore
    ]);
    const hasMore = typeof hasMoreCandidate === "boolean"
      ? hasMoreCandidate
      : (Number.isFinite(total)
        ? (offset + rawItems.length) < total
        : rawItems.length >= limit);

    const nextOffsetCandidate = firstFiniteNumber([
      payload?.next_offset,
      payload?.nextOffset,
      payload?.data?.next_offset,
      payload?.data?.nextOffset,
      payload?.meta?.next_offset,
      payload?.meta?.nextOffset,
      payload?.data?.conversations?.next_offset,
      payload?.data?.conversations?.nextOffset
    ]);
    const nextOffset = Number.isFinite(nextOffsetCandidate)
      ? nextOffsetCandidate
      : offset + Math.max(rawItems.length, limit);

    return {
      items,
      total,
      hasMore,
      nextOffset
    };
  }

  function extractConversationListItems(payload) {
    const candidates = [
      payload?.items,
      payload?.conversations,
      payload?.results,
      payload?.data?.items,
      payload?.data?.conversations,
      payload?.data?.results,
      payload?.data?.conversations?.items,
      payload?.conversations?.items
    ];

    for (let index = 0; index < candidates.length; index += 1) {
      if (Array.isArray(candidates[index])) {
        return candidates[index];
      }
    }

    return Array.isArray(payload) ? payload : [];
  }

  function normalizeConversationListItem(item) {
    const conversation = item?.conversation && typeof item.conversation === "object"
      ? item.conversation
      : null;
    const node = item?.node && typeof item.node === "object" ? item.node : null;
    const record = item?.record && typeof item.record === "object" ? item.record : null;
    const linkId = extractConversationIdFromHrefish(firstNonEmptyString([
      item?.href,
      item?.url,
      item?.link,
      conversation?.href,
      conversation?.url,
      conversation?.link,
      node?.href,
      node?.url,
      node?.link,
      record?.href,
      record?.url,
      record?.link
    ]));

    const id = firstNonEmptyString([
      item?.conversation_id,
      item?.conversationId,
      conversation?.conversation_id,
      conversation?.conversationId,
      node?.conversation_id,
      node?.conversationId,
      record?.conversation_id,
      record?.conversationId,
      linkId,
      conversation?.id,
      item?.id,
      item?.thread_id,
      item?.threadId,
      item?.uuid,
      node?.id,
      record?.id,
      record?.thread_id,
      record?.threadId
    ]);

    const title = sanitizeConversationTitle(firstNonEmptyString([
      item?.title,
      item?.name,
      conversation?.title,
      conversation?.name,
      node?.title,
      record?.title
    ]));

    const createTime = firstDefined([
      item?.create_time,
      item?.createTime,
      conversation?.create_time,
      conversation?.createTime,
      node?.create_time,
      node?.createTime,
      record?.create_time,
      record?.createTime
    ]);

    const updateTime = firstDefined([
      item?.update_time,
      item?.updateTime,
      conversation?.update_time,
      conversation?.updateTime,
      node?.update_time,
      node?.updateTime,
      record?.update_time,
      record?.updateTime
    ]);

    return {
      id,
      title,
      create_time: createTime ?? null,
      update_time: updateTime ?? null
    };
  }

  function collectConversationMetasFromVisibleLinks() {
    const anchors = Array.from(document.querySelectorAll("a[href*='/c/']"));
    const seen = new Set();
    const items = [];

    anchors.forEach((anchor) => {
      const href = String(anchor.getAttribute("href") || anchor.href || "").trim();
      if (!href) {
        return;
      }

      let parsedUrl = null;
      try {
        parsedUrl = new URL(href, window.location.origin);
      } catch (_error) {
        return;
      }

      const match = String(parsedUrl.pathname || "").match(/^\/c\/([0-9a-zA-Z_-]{8,})\/?$/);
      if (!match || !match[1]) {
        return;
      }

      const id = String(match[1]).trim();
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);

      const rawTitle =
        String(anchor.getAttribute("title") || "").trim() ||
        String(anchor.getAttribute("aria-label") || "").trim() ||
        String(anchor.textContent || "").trim();

      items.push({
        id,
        title: sanitizeConversationTitle(rawTitle),
        create_time: null,
        update_time: null
      });
    });

    return items;
  }

  async function collectConversationMetasFromSidebarSweep({ knownIds, targetCount, progressCallback }) {
    const seen = new Set(knownIds instanceof Set ? Array.from(knownIds) : []);
    const collected = [];
    const passLimit = computeSidebarSweepPassLimit(targetCount);

    const collectVisible = () => {
      const visible = collectConversationMetasFromVisibleLinks();
      for (let i = 0; i < visible.length; i += 1) {
        const item = visible[i];
        if (!item?.id || seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        collected.push(item);
      }
    };

    collectVisible();
    if (collected.length >= targetCount) {
      return collected;
    }

    const scroller = findSidebarConversationScroller();
    if (!scroller) {
      return collected;
    }

    let stablePasses = 0;
    let previousCount = collected.length;
    let previousHeight = Number(scroller.scrollHeight) || 0;

    for (let pass = 1; pass <= passLimit; pass += 1) {
      const visibleReady = await waitForSidebarSweepVisibility(progressCallback, "Sidebar-Scan");
      if (!visibleReady) {
        throw createSidebarSweepHiddenTimeoutError();
      }

      setScrollerTop(scroller, getScrollerMaxTop(scroller));
      await sleep(SIDEBAR_SWEEP_SETTLE_MS);
      collectVisible();

      const currentCount = collected.length;
      const currentHeight = Number(scroller.scrollHeight) || 0;
      const grew = currentCount > previousCount || currentHeight > (previousHeight + 2);

      if (grew) {
        stablePasses = 0;
      } else {
        stablePasses += 1;
      }

      if (collected.length >= targetCount) {
        break;
      }

      if (pass % 10 === 0) {
        progressCallback(
          "Batch: Sidebar scan pass " + pass + " (" + collected.length + " additional threads found)...",
          "busy"
        );
      }

      if (stablePasses >= SIDEBAR_SWEEP_IDLE_LIMIT) {
        const sawGrowth = await waitForSidebarConversationGrowth(
          scroller,
          collectVisible,
          () => collected.length,
          progressCallback
        );
        if (!sawGrowth) {
          const recoveredByNudge = await verifySidebarEndByNudging(
            scroller,
            collectVisible,
            () => collected.length,
            progressCallback
          );
          if (!recoveredByNudge) {
            break;
          }
          stablePasses = 0;
          previousCount = collected.length;
          previousHeight = Number(scroller.scrollHeight) || previousHeight;
          continue;
        }
        stablePasses = 0;
        previousCount = collected.length;
        previousHeight = Number(scroller.scrollHeight) || previousHeight;
      }

      previousCount = currentCount;
      previousHeight = currentHeight;
    }

    return collected;
  }

  function computeSidebarSweepPassLimit(targetCount) {
    if (Number.isFinite(targetCount) && targetCount > 0) {
      const estimated = Math.ceil(Number(targetCount) * 5);
      return Math.max(
        SIDEBAR_SWEEP_MAX_PASSES,
        Math.min(SIDEBAR_SWEEP_MAX_PASSES_CAP, estimated)
      );
    }
    return SIDEBAR_SWEEP_MAX_PASSES_CAP;
  }

  async function waitForSidebarConversationGrowth(scroller, collectVisible, getAdditionalCount, progressCallback) {
    const startedAt = Date.now();
    const baselineCount = Math.max(0, Number(
      typeof getAdditionalCount === "function" ? getAdditionalCount() : 0
    ) || 0);
    const baselineHeight = Number(scroller?.scrollHeight) || 0;
    let lastPulseAt = 0;

    while ((Date.now() - startedAt) < SIDEBAR_SWEEP_WAIT_MS) {
      const visibleReady = await waitForSidebarSweepVisibility(progressCallback, "Sidebar reload");
      if (!visibleReady) {
        throw createSidebarSweepHiddenTimeoutError();
      }

      await sleep(SIDEBAR_SWEEP_POLL_MS);
      collectVisible();

      const currentHeight = Number(scroller?.scrollHeight) || 0;
      const currentCount = Math.max(0, Number(
        typeof getAdditionalCount === "function" ? getAdditionalCount() : 0
      ) || 0);
      if (currentCount > baselineCount || currentHeight > (baselineHeight + 2)) {
        return true;
      }

      const now = Date.now();
      if ((now - lastPulseAt) >= 2400) {
        progressCallback("Batch: waiting for sidebar threads to load...", "busy");
        lastPulseAt = now;
      }
    }

    return false;
  }

  async function verifySidebarEndByNudging(scroller, collectVisible, getAdditionalCount, progressCallback) {
    if (!scroller) {
      return false;
    }

    for (let round = 1; round <= SIDEBAR_SWEEP_END_VERIFY_ROUNDS; round += 1) {
      const visibleReady = await waitForSidebarSweepVisibility(progressCallback, "Sidebar-Ende-Pruefung");
      if (!visibleReady) {
        throw createSidebarSweepHiddenTimeoutError();
      }

      const beforeCount = Math.max(0, Number(
        typeof getAdditionalCount === "function" ? getAdditionalCount() : 0
      ) || 0);
      const beforeHeight = Number(scroller.scrollHeight) || 0;
      const currentTop = getScrollerTop(scroller);
      const nudgeUp = Math.max(
        120,
        Math.floor(getScrollerClientHeight(scroller) * SIDEBAR_SWEEP_NUDGE_UP_RATIO)
      );
      const upTop = Math.max(0, currentTop - nudgeUp);

      if (typeof progressCallback === "function") {
        progressCallback(
          "Batch: checking sidebar end (" + round + "/" + SIDEBAR_SWEEP_END_VERIFY_ROUNDS + ")...",
          "busy"
        );
      }

      setScrollerTop(scroller, upTop);
      await sleep(SIDEBAR_SWEEP_NUDGE_WAIT_MS);
      collectVisible();

      setScrollerTop(scroller, getScrollerMaxTop(scroller));
      await sleep(SIDEBAR_SWEEP_NUDGE_WAIT_MS + 80);
      collectVisible();

      const afterCount = Math.max(0, Number(
        typeof getAdditionalCount === "function" ? getAdditionalCount() : 0
      ) || 0);
      const afterHeight = Number(scroller.scrollHeight) || 0;
      if (afterCount > beforeCount || afterHeight > (beforeHeight + 2)) {
        return true;
      }

      const waitedGrowth = await waitForSidebarConversationGrowth(
        scroller,
        collectVisible,
        getAdditionalCount,
        progressCallback
      );
      if (waitedGrowth) {
        return true;
      }
    }

    return false;
  }

  function createSidebarSweepHiddenTimeoutError() {
    const error = new Error(
      "Sidebar scan paused: ChatGPT tab stayed in the background too long. Bring the tab to foreground and start batch again."
    );
    error.code = "sidebar_hidden_timeout";
    return error;
  }

  async function waitForSidebarSweepVisibility(progressCallback, phaseLabel) {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      return true;
    }

    const startedAt = Date.now();
    let lastNoticeAt = 0;
    const label = String(phaseLabel || "Sidebar-Scan").trim() || "Sidebar-Scan";

    while (document.visibilityState === "hidden") {
      const now = Date.now();
      if ((now - startedAt) >= SIDEBAR_SWEEP_HIDDEN_WAIT_MAX_MS) {
        return false;
      }

      if ((now - lastNoticeAt) >= SIDEBAR_SWEEP_HIDDEN_NOTICE_MS) {
        if (typeof progressCallback === "function") {
          progressCallback(
            "Batch: " + label + " waiting, keep the ChatGPT tab in foreground...",
            "busy"
          );
        }
        lastNoticeAt = now;
      }

      await sleep(1000);
    }

    return true;
  }

  function findSidebarConversationScroller() {
    const scored = new Map();
    const anchors = Array.from(document.querySelectorAll("a[href*='/c/']"));

    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
      let node = anchors[anchorIndex]?.parentElement || null;
      let depth = 0;

      while (node && node !== document.body && node !== document.documentElement && depth < 14) {
        if (isLikelyScrollContainer(node)) {
          const score = (scored.get(node) || 0) + 1;
          scored.set(node, score);
        }
        node = node.parentElement;
        depth += 1;
      }
    }

    const candidates = Array.from(scored.entries());
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      const scoreDelta = b[1] - a[1];
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return getScrollerMaxTop(b[0]) - getScrollerMaxTop(a[0]);
    });

    return candidates[0][0] || null;
  }

  function firstNonEmptyString(values) {
    if (!Array.isArray(values)) {
      return "";
    }
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value == null) {
        continue;
      }
      const text = String(value).trim();
      if (text) {
        return text;
      }
    }
    return "";
  }

  function extractConversationIdFromHrefish(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    try {
      const parsed = new URL(raw, window.location.origin);
      const match = String(parsed.pathname || "").match(/^\/c\/([0-9a-zA-Z_-]{8,})\/?$/);
      return match ? String(match[1] || "").trim() : "";
    } catch (_error) {
      return "";
    }
  }

  function firstDefined(values) {
    if (!Array.isArray(values)) {
      return null;
    }
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] != null) {
        return values[index];
      }
    }
    return null;
  }

  function firstFiniteNumber(values) {
    if (!Array.isArray(values)) {
      return null;
    }
    for (let index = 0; index < values.length; index += 1) {
      const raw = values[index];
      if (raw == null || raw === "") {
        continue;
      }
      const candidate = Number(raw);
      if (Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function firstBoolean(values) {
    if (!Array.isArray(values)) {
      return null;
    }
    for (let index = 0; index < values.length; index += 1) {
      const candidate = values[index];
      if (typeof candidate === "boolean") {
        return candidate;
      }
    }
    return null;
  }

  async function fetchConversationPayload(conversationId, progressCallback, options = {}) {
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || API_TIMEOUT_MS);
    const maxRetries = Math.max(1, Number(options?.maxRetries) || API_MAX_RETRIES);
    const contextLabel = String(options?.contextLabel || "API");
    const endpointCandidates = buildConversationEndpointCandidates(conversationId);
    let lastError = null;
    let sawOnlyNotFound = true;
    const attempted = [];

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      let attemptSawNon404 = false;
      let attemptHitRateLimit = false;
      try {
        if (typeof progressCallback === "function") {
          progressCallback(contextLabel + " Versuch " + attempt + "/" + maxRetries + "...", "busy");
        }

        for (let endpointIndex = 0; endpointIndex < endpointCandidates.length; endpointIndex += 1) {
          const endpointUrl = endpointCandidates[endpointIndex];
          const response = await fetchJsonWithFallback(endpointUrl, {
            method: "GET",
            credentials: "include",
            headers: {
              Accept: "application/json"
            }
          }, timeoutMs);

          if (response.ok) {
            return response.body;
          }

          attempted.push({
            endpoint: endpointUrl,
            status: Number(response.status) || 0
          });

          if (response.status === 429) {
            attemptHitRateLimit = true;
            attemptSawNon404 = true;
            sawOnlyNotFound = false;
            lastError = new Error("HTTP 429 (rate limit) while loading conversation");
            break;
          }

          if (response.status !== 404) {
            attemptSawNon404 = true;
            sawOnlyNotFound = false;
            lastError = new Error("HTTP " + response.status + " while loading conversation");
            break;
          }
        }
      } catch (error) {
        attemptSawNon404 = true;
        sawOnlyNotFound = false;
        lastError = error;
      }

      if (!attemptSawNon404) {
        // All known endpoints returned 404 in this attempt.
        continue;
      }

      if (attempt >= maxRetries) {
        break;
      }

      const baseDelayMs = attemptHitRateLimit
        ? Math.min(90000, 8000 * Math.pow(2, attempt - 1))
        : API_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const jitterMs = attemptHitRateLimit
        ? Math.floor(Math.random() * 2200)
        : Math.floor(Math.random() * 250);
      const waitMs = baseDelayMs + jitterMs;
      if (typeof progressCallback === "function") {
        progressCallback(
          contextLabel + " failed, retrying in " + Math.round(waitMs / 1000) + "s...",
          "busy"
        );
      }
      await sleep(waitMs);
    }

    if (sawOnlyNotFound) {
      if (attempted.length > 0) {
        console.warn("[ChatGPT Export] Conversation API returned only 404.", {
          conversationId: String(conversationId || ""),
          attempted
        });
      }
      const notFoundError = new Error("HTTP 404 while loading conversation");
      notFoundError.code = "conversation_not_found";
      throw notFoundError;
    }

    throw lastError || new Error("Conversation API unreachable");
  }

  function isConversationNotFoundError(error) {
    if (error?.code === "conversation_not_found") {
      return true;
    }
    const text = String(error?.message || error || "");
    return /\b404\b/.test(text);
  }

  function buildConversationEndpointCandidates(conversationId) {
    const id = encodeURIComponent(conversationId);
    const endpointSet = new Set([
      "/backend-api/conversation/" + id,
      "/backend-api/conversation/" + id + "/",
      "/backend-api/conversations/" + id,
      "/backend-api/conversations/" + id + "/",
      "/backend-api/conversation?conversation_id=" + id,
      "/backend-api/conversations?conversation_id=" + id
    ]);
    return [
      ...endpointSet
    ];
  }

  async function fetchJsonWithFallback(url, options, timeoutMs) {
    if (shouldPreferPageBridgeFirst(url)) {
      const pageResultFirst = await tryFetchJsonViaPage(url, options, timeoutMs);
      if (pageResultFirst.ok) {
        return pageResultFirst;
      }

      const directResultAfterPage = await tryFetchJsonDirect(url, options, timeoutMs);
      if (directResultAfterPage.ok) {
        return directResultAfterPage;
      }

      return resolveFailedFetchResults(directResultAfterPage, pageResultFirst);
    }

    const directResult = await tryFetchJsonDirect(url, options, timeoutMs);
    if (directResult.ok) {
      return directResult;
    }

    const shouldTryPageBridge = shouldTryPageBridgeAfterDirect(url, directResult);

    if (!shouldTryPageBridge) {
      if (directResult.error) {
        throw directResult.error;
      }
      return directResult;
    }

    const pageResult = await tryFetchJsonViaPage(url, options, timeoutMs);
    if (pageResult.ok) {
      return pageResult;
    }

    return resolveFailedFetchResults(directResult, pageResult);
  }

  function shouldTryPageBridgeAfterDirect(url, directResult) {
    if (Boolean(directResult?.error)) {
      return true;
    }

    if (isConversationApiUrl(url) && !directResult?.ok) {
      return true;
    }

    const status = Number(directResult?.status) || 0;
    return (
      status === 0 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 405 ||
      status === 422 ||
      status === 429
    );
  }

  function shouldPreferPageBridgeFirst(url) {
    const endpoint = normalizeEndpointUrl(url);
    return (
      endpoint.includes("/backend-api/conversation/") ||
      endpoint.includes("/backend-api/conversations?")
    );
  }

  function isConversationApiUrl(url) {
    const endpoint = normalizeEndpointUrl(url);
    return (
      endpoint.includes("/backend-api/conversation") ||
      endpoint.includes("/backend-api/conversations")
    );
  }

  function normalizeEndpointUrl(url) {
    const raw = String(url || "");
    try {
      const parsed = new URL(raw, window.location.origin);
      return parsed.pathname + parsed.search;
    } catch (_error) {
      return raw;
    }
  }

  function resolveFailedFetchResults(directResult, pageResult) {
    if (pageResult?.error && directResult?.error) {
      throw new Error("Direkt fehlgeschlagen: " + directResult.error.message + "; Seite fehlgeschlagen: " + pageResult.error.message);
    }
    if (pageResult?.error) {
      throw pageResult.error;
    }
    if (directResult?.error) {
      throw directResult.error;
    }

    if ((Number(pageResult?.status) || 0) > 0) {
      return pageResult;
    }
    return directResult;
  }

  async function tryFetchJsonDirect(url, options, timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      const status = Number(response.status) || 0;
      const statusText = String(response.statusText || "");

      const text = await response.text();
      let body = null;
      if (text && text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch (error) {
          if (response.ok) {
            return {
              ok: false,
              status,
              statusText,
              body: null,
              error: new Error("Antwort war kein JSON (direkt).")
            };
          }
        }
      }

      return {
        ok: Boolean(response.ok),
        status,
        statusText,
        body
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: "",
        body: null,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  async function tryFetchJsonViaPage(url, options, timeoutMs) {
    try {
      const response = await fetchJsonViaPage(url, options, timeoutMs);
      return response;
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: "",
        body: null,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  async function fetchJsonViaPage(url, options, timeoutMs) {
    await ensurePageBridge();
    const requestId = "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    const safeOptions = serializeFetchOptions(options);

    return await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Page-Bridge Timeout nach " + Math.round(timeoutMs / 1000) + "s"));
      }, timeoutMs);

      const onMessage = (event) => {
        if (event.source !== window) {
          return;
        }

        const data = event.data;
        if (!data || data.type !== PAGE_BRIDGE_RESPONSE_TYPE) {
          return;
        }
        if (data.token !== PAGE_BRIDGE_TOKEN || data.requestId !== requestId) {
          return;
        }

        cleanup();

        if (data.error) {
          reject(new Error(String(data.error)));
          return;
        }

        if (data.parseError && data.ok) {
          reject(new Error("Antwort war kein JSON (page bridge)."));
          return;
        }

        resolve({
          ok: Boolean(data.ok),
          status: Number(data.status) || 0,
          statusText: String(data.statusText || ""),
          body: data.body ?? null
        });
      };

      const cleanup = () => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);
      window.postMessage({
        type: PAGE_BRIDGE_REQUEST_TYPE,
        token: PAGE_BRIDGE_TOKEN,
        requestId,
        url,
        options: safeOptions
      }, "*");
    });
  }

  async function ensurePageBridge() {
    if (pageBridgeReadyPromise) {
      return pageBridgeReadyPromise;
    }

    pageBridgeReadyPromise = new Promise((resolve, reject) => {
      const existing = document.getElementById(PAGE_BRIDGE_SCRIPT_ID);
      if (existing) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.id = PAGE_BRIDGE_SCRIPT_ID;
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.dataset.token = PAGE_BRIDGE_TOKEN;
      script.dataset.requestType = PAGE_BRIDGE_REQUEST_TYPE;
      script.dataset.responseType = PAGE_BRIDGE_RESPONSE_TYPE;
      script.dataset.payloadType = PAGE_BRIDGE_PAYLOAD_TYPE;
      script.async = false;

      script.onload = () => {
        resolve();
        setTimeout(() => {
          script.remove();
        }, 0);
      };
      script.onerror = () => {
        reject(new Error("Page-bridge script could not be loaded."));
        script.remove();
      };

      (document.head || document.documentElement).appendChild(script);
    });

    return pageBridgeReadyPromise;
  }

  function serializeFetchOptions(options) {
    const method = String(options?.method || "GET").toUpperCase();
    const credentials = String(options?.credentials || "include");

    const headers = {};
    const sourceHeaders = options?.headers;
    if (sourceHeaders && typeof sourceHeaders === "object") {
      if (typeof Headers !== "undefined" && sourceHeaders instanceof Headers) {
        sourceHeaders.forEach((value, key) => {
          headers[key] = String(value);
        });
      } else {
        Object.keys(sourceHeaders).forEach((key) => {
          headers[key] = String(sourceHeaders[key]);
        });
      }
    }

    const serialized = {
      method,
      credentials,
      headers
    };

    if (typeof options?.body === "string") {
      serialized.body = options.body;
    }

    return serialized;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function extractMessagesFromApiPayload(payload) {
    const mapping = payload?.mapping;
    if (!mapping || typeof mapping !== "object") {
      return [];
    }

    const chainIds = resolveCurrentBranchIds(mapping, payload?.current_node);
    const rawNodes = chainIds.length > 0
      ? chainIds.map((id) => mapping[id]).filter(Boolean)
      : Object.values(mapping);

    const parsed = [];
    const seen = new Set();

    rawNodes.forEach((node, index) => {
      const message = node?.message;
      if (!message) {
        return;
      }

      const messageId = String(message.id || node.id || "msg-" + index);
      if (seen.has(messageId)) {
        return;
      }
      seen.add(messageId);

      const role = normalizeRole(message?.author?.role);
      const text = extractApiMessageText(message);
      const imageUrls = extractApiMessageImageUrls(message);
      if (!text && imageUrls.length === 0) {
        return;
      }
      const bodyHtml = buildApiMessageBodyHtml(text, imageUrls);

      const timestamp = normalizeTimestamp(message?.create_time || message?.update_time);

      parsed.push({
        id: messageId,
        role,
        label: roleLabel(role),
        text,
        bodyHtml,
        timestampIso: timestamp ? timestamp.toISOString() : "",
        timestampDisplay: formatTimestamp(timestamp)
      });
    });

    if (chainIds.length > 0) {
      return parsed;
    }

    return parsed.sort((a, b) => {
      const ta = a.timestampIso ? Date.parse(a.timestampIso) : Number.MAX_SAFE_INTEGER;
      const tb = b.timestampIso ? Date.parse(b.timestampIso) : Number.MAX_SAFE_INTEGER;
      if (ta === tb) {
        return 0;
      }
      return ta - tb;
    });
  }

  function extractTimestampMapFromApiPayload(payload) {
    const mapping = payload?.mapping;
    if (!mapping || typeof mapping !== "object") {
      return new Map();
    }

    const chainIds = resolveCurrentBranchIds(mapping, payload?.current_node);
    const rawNodes = chainIds.length > 0
      ? chainIds.map((id) => mapping[id]).filter(Boolean)
      : Object.values(mapping);

    const timestampMap = new Map();

    rawNodes.forEach((node, index) => {
      const message = node?.message;
      if (!message) {
        return;
      }

      const messageId = String(message.id || node.id || "msg-" + index);
      const timestamp = normalizeTimestamp(message?.create_time || message?.update_time);
      if (!timestamp) {
        return;
      }

      timestampMap.set(messageId, {
        iso: timestamp.toISOString(),
        display: formatTimestamp(timestamp)
      });
    });

    return timestampMap;
  }

  function renderInlineTimestampBadges() {
    if (!showInlineTimestamps || !isConversationPage()) {
      removeInlineTimestampBadges();
      return;
    }

    const messageNodes = document.querySelectorAll(
      "article[data-testid^='conversation-turn-'] [data-message-author-role], article[data-turn-id] [data-message-author-role]"
    );

    messageNodes.forEach((messageNode) => {
      const messageId = messageNode.getAttribute("data-message-id") || "";
      const current = getDirectChildByClass(messageNode, INLINE_TS_CLASS);
      const timestampInfo = resolveNodeTimestamp(messageNode, messageId);
      if (!timestampInfo) {
        if (current) {
          current.remove();
        }
        return;
      }

      if (current) {
        current.textContent = "Time: " + timestampInfo.display;
        if (timestampInfo.iso) {
          current.setAttribute("data-iso", timestampInfo.iso);
        }
        return;
      }

      const badge = document.createElement("div");
      badge.className = INLINE_TS_CLASS;
      badge.setAttribute(INLINE_TS_MARKER_ATTR, "1");
      if (timestampInfo.iso) {
        badge.setAttribute("data-iso", timestampInfo.iso);
      }
      badge.textContent = "Time: " + timestampInfo.display;
      messageNode.insertBefore(badge, messageNode.firstChild);
    });
  }

  function getDirectChildByClass(parent, className) {
    if (!parent || !parent.children) {
      return null;
    }

    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      if (child && child.classList && child.classList.contains(className)) {
        return child;
      }
    }

    return null;
  }

  function removeInlineTimestampBadges() {
    const nodes = document.querySelectorAll("[" + INLINE_TS_MARKER_ATTR + "='1']");
    nodes.forEach((node) => node.remove());
  }

  function resolveNodeTimestamp(messageNode, messageId) {
    const conversationId = getConversationIdFromPath() || "";
    const capturedMap = getCapturedTimestampMap(conversationId);
    if (messageId && capturedMap && capturedMap.has(messageId)) {
      return capturedMap.get(messageId);
    }

    const timeElement = messageNode.querySelector("time");
    if (timeElement) {
      const ts = normalizeTimestamp(timeElement.getAttribute("datetime") || timeElement.textContent || "");
      if (ts) {
        return {
          iso: ts.toISOString(),
          display: formatTimestamp(ts)
        };
      }
    }

    return null;
  }

  function resolveCurrentBranchIds(mapping, currentNodeId) {
    const branch = [];
    const visited = new Set();
    let cursor = currentNodeId;

    while (cursor && mapping[cursor] && !visited.has(cursor)) {
      visited.add(cursor);
      branch.push(cursor);
      cursor = mapping[cursor].parent;
    }

    branch.reverse();
    return branch;
  }

  function extractApiMessageText(message) {
    const content = message?.content;
    if (!content) {
      return "";
    }

    const pieces = [];

    if (Array.isArray(content.parts)) {
      content.parts.forEach((part) => {
        const normalized = flattenContentPart(part);
        if (normalized) {
          pieces.push(normalized);
        }
      });
    } else {
      const normalized = flattenContentPart(content);
      if (normalized) {
        pieces.push(normalized);
      }
    }

    if (pieces.length === 0 && typeof message?.text === "string") {
      pieces.push(message.text);
    }

    return pieces.join("\n\n").trim();
  }

  function flattenContentPart(part) {
    if (part == null) {
      return "";
    }

    if (typeof part === "string") {
      return part.trim();
    }

    if (Array.isArray(part)) {
      return part.map(flattenContentPart).filter(Boolean).join("\n").trim();
    }

    if (typeof part === "object") {
      if (typeof part.text === "string") {
        return part.text.trim();
      }

      if (typeof part.content === "string") {
        return part.content.trim();
      }

      if (Array.isArray(part.parts)) {
        return part.parts.map(flattenContentPart).filter(Boolean).join("\n").trim();
      }

      if (part.type === "image_url") {
        return "";
      }

      if (part.type === "audio" || part.type === "voice") {
        return "[Audio]";
      }

      return "";
    }

    return "";
  }

  function extractApiMessageImageUrls(message) {
    const content = message?.content;
    const out = [];
    const seen = new Set();

    const addUrl = (value) => {
      const safe = sanitizeImageSrcForExport(value);
      if (!safe || seen.has(safe)) {
        return;
      }
      seen.add(safe);
      out.push(safe);
    };

    const walk = (part) => {
      if (part == null) {
        return;
      }

      if (typeof part === "string") {
        return;
      }

      if (Array.isArray(part)) {
        part.forEach(walk);
        return;
      }

      if (typeof part !== "object") {
        return;
      }

      if (part.type === "image_url") {
        addUrl(part?.image_url?.url || part?.url || "");
      }

      if (part.image_url && typeof part.image_url === "object") {
        addUrl(part.image_url.url || "");
      }

      if (typeof part.url === "string") {
        const maybeType = String(part.type || "").toLowerCase();
        if (maybeType.includes("image")) {
          addUrl(part.url);
        }
      }

      if (Array.isArray(part.parts)) {
        part.parts.forEach(walk);
      }

      if (Array.isArray(part.content)) {
        part.content.forEach(walk);
      } else if (part.content && typeof part.content === "object") {
        walk(part.content);
      }
    };

    if (Array.isArray(content?.parts)) {
      content.parts.forEach(walk);
    } else {
      walk(content);
    }

    return out;
  }

  function buildApiMessageBodyHtml(text, imageUrls) {
    const safeText = String(text || "").trim();
    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
    const textHtml = safeText ? renderMarkdownLite(safeText) : "";
    if (urls.length === 0) {
      return textHtml || "<p></p>";
    }

    const imageHtml = urls.map((url, index) => {
      const src = escapeHtml(url);
      const alt = escapeHtml("Image " + (index + 1));
      return (
        '<figure class="export-image-figure">' +
        '<img src="' + src + '" alt="' + alt + '" loading="lazy" decoding="async" data-lightbox="1">' +
        "</figure>"
      );
    }).join("");

    if (!textHtml) {
      return imageHtml;
    }
    return textHtml + imageHtml;
  }

  async function collectMessagesFromDom(progressCallback, options = {}) {
    const conversationId = getConversationIdFromPath() || "";
    const allowExtendedWait = Boolean(options?.allowExtendedWait);
    const isCancelled = typeof options?.isCancelled === "function" ? options.isCancelled : () => false;
    const scroller = findConversationScroller();
    const startScrollTop = scroller ? getScrollerTop(scroller) : null;
    const collected = new Map();
    let orderCounter = 0;

    const collectNow = () => {
      const turns = document.querySelectorAll("article[data-testid^='conversation-turn-'], article[data-turn-id]");
      turns.forEach((turn, turnIndex) => {
        const messageNodes = turn.querySelectorAll("[data-message-author-role]");
        const turnMessageIds = [];
        messageNodes.forEach((messageNode, localIndex) => {
          const messageId = messageNode.getAttribute("data-message-id") ||
            turn.getAttribute("data-turn-id") ||
            "dom-" + turnIndex + "-" + localIndex;

          const roleRaw = messageNode.getAttribute("data-message-author-role") || turn.getAttribute("data-turn") || "unknown";
          const role = normalizeRole(roleRaw);
          const text = extractDomMessageText(messageNode);
          const richHtml = extractDomMessageRichHtml(messageNode);
          const bodyHtml = richHtml || renderMarkdownLite(text || "");
          if (!hasMeaningfulMessageCandidate(text, bodyHtml)) {
            return;
          }

          let timestampInfo = null;
          const capturedTimestamps = getCapturedTimestampMap(conversationId);
          if (capturedTimestamps && capturedTimestamps.has(messageId)) {
            timestampInfo = capturedTimestamps.get(messageId);
          }

          if (!timestampInfo) {
            const timeElement = messageNode.querySelector("time") || turn.querySelector("time");
            const timestamp = normalizeTimestamp(timeElement?.getAttribute("datetime") || timeElement?.textContent || "");
            if (timestamp) {
              timestampInfo = {
                iso: timestamp.toISOString(),
                display: formatTimestamp(timestamp)
              };
            }
          }

          const existing = collected.get(messageId);
          if (existing) {
            const nextText = chooseLongerText(existing.text, text);
            const nextBodyHtml = choosePreferredBodyHtml(existing.bodyHtml, bodyHtml);
            const hasExistingTimestamp = Boolean(existing.timestampIso);

            collected.set(messageId, {
              ...existing,
              text: nextText,
              bodyHtml: nextBodyHtml,
              timestampIso: hasExistingTimestamp ? existing.timestampIso : (timestampInfo?.iso || ""),
              timestampDisplay: hasExistingTimestamp ? existing.timestampDisplay : (timestampInfo?.display || "Unknown time")
            });
            turnMessageIds.push(messageId);
            return;
          }

          collected.set(messageId, {
            id: messageId,
            role,
            label: roleLabel(role),
            text: text || "",
            bodyHtml,
            timestampIso: timestampInfo?.iso || "",
            timestampDisplay: timestampInfo?.display || "Unknown time",
            order: orderCounter++
          });
          turnMessageIds.push(messageId);
        });

        const turnImageHtml = extractTurnLevelImagesHtml(turn, messageNodes);
        if (!turnImageHtml) {
          return;
        }

        const targetMessageId = chooseTurnImageTargetMessageId(turnMessageIds, collected);
        if (targetMessageId && collected.has(targetMessageId)) {
          const current = collected.get(targetMessageId);
          const mergedBodyHtml = mergeBodyHtmlWithExtraImages(current.bodyHtml, turnImageHtml);
          if (mergedBodyHtml !== current.bodyHtml) {
            collected.set(targetMessageId, {
              ...current,
              bodyHtml: mergedBodyHtml
            });
          }
          return;
        }

        const syntheticId = (turn.getAttribute("data-turn-id") || ("dom-turn-" + turnIndex)) + "-img";
        if (collected.has(syntheticId)) {
          return;
        }

        const role = normalizeRole(turn.getAttribute("data-turn") || "assistant");
        const timeElement = turn.querySelector("time");
        const timestamp = normalizeTimestamp(timeElement?.getAttribute("datetime") || timeElement?.textContent || "");
        collected.set(syntheticId, {
          id: syntheticId,
          role,
          label: roleLabel(role),
          text: "[Image]",
          bodyHtml: turnImageHtml,
          timestampIso: timestamp ? timestamp.toISOString() : "",
          timestampDisplay: timestamp ? formatTimestamp(timestamp) : "Unknown time",
          order: orderCounter++
        });
      });
    };

    collectNow();

    if (scroller) {
      const endSyncPassLimit = computeDomScrollPassLimit(scroller, {
        minPasses: DOM_BOTTOM_STABLE_PASSES * 12
      });
      await ensureThreadEndLoaded(scroller, collectNow, progressCallback, {
        allowExtendedWait,
        isCancelled,
        passLimit: endSyncPassLimit
      });
      collectNow();

      let stalePasses = 0;
      let longWaitAttempts = 0;
      let previousTop = getScrollerTop(scroller);
      let previousCount = collected.size;
      const historyPassLimit = computeDomScrollPassLimit(scroller, {
        minPasses: DOM_SCROLL_MAX_PASSES
      });

      for (let pass = 1; pass <= historyPassLimit; pass += 1) {
        if (isCancelled()) {
          throw createExportCancelledError();
        }

        const step = Math.max(DOM_SCROLL_STEP_MIN, Math.floor(getScrollerClientHeight(scroller) * 0.85));
        const nextTop = Math.max(0, getScrollerTop(scroller) - step);
        setScrollerTop(scroller, nextTop);
        await sleep(DOM_SCROLL_SETTLE_MS);
        collectNow();

        if (pass % 10 === 0) {
          progressCallback("DOM fallback: loading long history (pass " + pass + ")...", "busy");
        }

        const currentTop = getScrollerTop(scroller);
        const reachedTop = currentTop <= 1;
        const barelyMoved = Math.abs(previousTop - currentTop) < 3;
        const gotNewMessages = collected.size > previousCount;

        if (reachedTop) {
          stalePasses += 1;
        } else if (barelyMoved && !gotNewMessages) {
          stalePasses += 1;
        } else {
          stalePasses = 0;
          longWaitAttempts = 0;
        }

        if (allowExtendedWait && stalePasses > 0) {
          const reachedLimit = reachedTop
            ? stalePasses >= DOM_TOP_STABLE_PASSES
            : stalePasses >= DOM_SCROLL_IDLE_LIMIT;
          if (reachedLimit && longWaitAttempts < DOM_LONG_WAIT_RESCAN_LIMIT) {
            longWaitAttempts += 1;
            const sawGrowth = await waitForSlowDomGrowth({
              scroller,
              collectNow,
              collected,
              progressCallback,
              isCancelled,
              stageLabel: "Historie",
              passLabel: longWaitAttempts + "/" + DOM_LONG_WAIT_RESCAN_LIMIT
            });
            if (sawGrowth) {
              stalePasses = 0;
              previousTop = getScrollerTop(scroller);
              previousCount = collected.size;
              continue;
            }
          }
        }

        if (reachedTop && stalePasses >= DOM_TOP_STABLE_PASSES) {
          break;
        }
        if (!reachedTop && stalePasses >= DOM_SCROLL_IDLE_LIMIT) {
          break;
        }

        previousTop = currentTop;
        previousCount = collected.size;
      }

      if (startScrollTop != null) {
        setScrollerTop(scroller, startScrollTop);
      } else {
        setScrollerTop(scroller, getScrollerMaxTop(scroller));
      }
      await sleep(100);
      collectNow();
    }

    return Array.from(collected.values())
      .sort((a, b) => a.order - b.order)
      .map(({ order, ...message }) => message);
  }

  function findConversationScroller() {
    const firstTurn = document.querySelector("article[data-testid^='conversation-turn-']");
    if (!firstTurn) {
      return document.scrollingElement || document.documentElement;
    }

    const candidates = [];
    let node = firstTurn.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isLikelyScrollContainer(node)) {
        candidates.push(node);
      }
      node = node.parentElement;
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => getScrollerMaxTop(b) - getScrollerMaxTop(a));
      return candidates[0];
    }

    return document.scrollingElement || document.documentElement;
  }

  function isLikelyScrollContainer(node) {
    if (!node || node === document.body || node === document.documentElement) {
      return false;
    }

    const scrollRange = node.scrollHeight - node.clientHeight;
    if (scrollRange < 120) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const overflowY = (style?.overflowY || "").toLowerCase();
    return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  }

  async function ensureThreadEndLoaded(scroller, collectNow, progressCallback, options = {}) {
    const allowExtendedWait = Boolean(options?.allowExtendedWait);
    const isCancelled = typeof options?.isCancelled === "function" ? options.isCancelled : () => false;
    const passLimit = Math.max(
      DOM_BOTTOM_STABLE_PASSES * 4,
      Number(options?.passLimit) || DOM_SCROLL_MAX_PASSES
    );
    let stablePasses = 0;
    let longWaitAttempts = 0;
    let previousTop = getScrollerTop(scroller);

    for (let pass = 1; pass <= passLimit; pass += 1) {
      if (isCancelled()) {
        throw createExportCancelledError();
      }

      setScrollerTop(scroller, getScrollerMaxTop(scroller));
      await sleep(DOM_SCROLL_SETTLE_MS);
      collectNow();

      const currentTop = getScrollerTop(scroller);
      const atBottom = isNearBottom(scroller);
      const barelyMoved = Math.abs(currentTop - previousTop) < 3;

      if (atBottom || barelyMoved) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
        longWaitAttempts = 0;
      }

      if (allowExtendedWait && stablePasses >= DOM_BOTTOM_STABLE_PASSES && longWaitAttempts < DOM_LONG_WAIT_RESCAN_LIMIT) {
        longWaitAttempts += 1;
        const sawGrowth = await waitForSlowDomGrowth({
          scroller,
          collectNow,
          collected: null,
          progressCallback,
          isCancelled,
          stageLabel: "Conversation end",
          passLabel: longWaitAttempts + "/" + DOM_LONG_WAIT_RESCAN_LIMIT
        });
        if (sawGrowth) {
          stablePasses = 0;
          previousTop = getScrollerTop(scroller);
          continue;
        }
      }

      if (stablePasses >= DOM_BOTTOM_STABLE_PASSES) {
        break;
      }

      if (pass % 12 === 0) {
        progressCallback("DOM fallback: synchronizing conversation end...", "busy");
      }

      previousTop = currentTop;
    }
  }

  async function waitForSlowDomGrowth({
    scroller,
    collectNow,
    collected,
    progressCallback,
    isCancelled,
    stageLabel,
    passLabel
  }) {
    const startedAt = Date.now();
    let lastMessageCount = (collected instanceof Map && collected.size > 0) ? collected.size : countDomMessages();
    let lastScrollHeight = scroller ? Number(scroller.scrollHeight) || 0 : 0;
    let lastPulseAt = 0;
    let lastNoGrowthNoticeAt = Date.now();
    let lastLoadingSignalAt = Date.now();

    while ((Date.now() - startedAt) < DOM_LONG_WAIT_MAX_MS) {
      if (typeof isCancelled === "function" && isCancelled()) {
        throw createExportCancelledError();
      }

      await sleep(DOM_LONG_WAIT_POLL_MS);
      collectNow();

      const messageCount = (collected instanceof Map && collected.size > 0) ? collected.size : countDomMessages();
      const scrollHeight = scroller ? Number(scroller.scrollHeight) || 0 : 0;
      const changed = messageCount > lastMessageCount || scrollHeight > (lastScrollHeight + 2);
      const loadingActive = hasActiveThreadLoadingIndicators(scroller);

      if (changed) {
        return true;
      }

      const now = Date.now();
      if (loadingActive) {
        lastLoadingSignalAt = now;
      }

      if (!loadingActive && (now - lastLoadingSignalAt) >= DOM_LONG_WAIT_NO_ACTIVITY_EXIT_MS) {
        progressCallback(
          "DOM fallback: no further loading detected (" + stageLabel + "), continuing...",
          "busy"
        );
        return false;
      }

      if ((now - lastPulseAt) >= 6000) {
        progressCallback(
          "DOM fallback: waiting for very slow loading (" + stageLabel + ", " + passLabel + ")...",
          "busy"
        );
        lastPulseAt = now;
      }

      if ((now - lastNoGrowthNoticeAt) >= DOM_LONG_WAIT_IDLE_MS) {
        progressCallback(
          "DOM fallback: still no new elements (" + stageLabel + "), waiting...",
          "busy"
        );
        lastNoGrowthNoticeAt = now;
      }

      lastMessageCount = messageCount;
      lastScrollHeight = scrollHeight;
    }

    return false;
  }

  function countDomMessages() {
    return document.querySelectorAll(
      "article[data-testid^='conversation-turn-'] [data-message-author-role], article[data-turn-id] [data-message-author-role]"
    ).length;
  }

  function hasActiveThreadLoadingIndicators(scroller) {
    const root = scroller && scroller.querySelector ? scroller : document;
    const selectors = [
      "[aria-busy='true']",
      "[data-testid*='loading']",
      "[data-testid*='spinner']",
      ".result-streaming"
    ];
    for (let i = 0; i < selectors.length; i += 1) {
      const found = root.querySelector(selectors[i]);
      if (found) {
        return true;
      }
    }
    return false;
  }

  function getScrollerTop(scroller) {
    return scroller ? scroller.scrollTop : 0;
  }

  function setScrollerTop(scroller, value) {
    if (!scroller) {
      return;
    }
    scroller.scrollTop = Math.max(0, value);
  }

  function getScrollerClientHeight(scroller) {
    return scroller ? scroller.clientHeight : window.innerHeight;
  }

  function getScrollerMaxTop(scroller) {
    if (!scroller) {
      return 0;
    }
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function computeDomScrollPassLimit(scroller, options = {}) {
    const minPasses = Math.max(1, Number(options?.minPasses) || DOM_SCROLL_MAX_PASSES);
    if (!scroller) {
      return minPasses;
    }

    const maxTop = Math.max(0, getScrollerMaxTop(scroller));
    const viewport = Math.max(1, getScrollerClientHeight(scroller));
    const estimatedStep = Math.max(DOM_SCROLL_STEP_MIN, Math.floor(viewport * 0.85));
    const estimatedPasses = Math.ceil(maxTop / Math.max(1, estimatedStep)) + 24;

    return Math.max(
      minPasses,
      Math.min(DOM_SCROLL_MAX_PASSES_CAP, estimatedPasses)
    );
  }

  function isNearBottom(scroller) {
    if (!scroller) {
      return true;
    }
    const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    return remaining <= 8;
  }

  function extractDomMessageText(messageNode) {
    const markdown = messageNode.querySelector(".markdown");
    if (markdown) {
      return (markdown.innerText || "").trim();
    }

    const bubble = messageNode.querySelector(".whitespace-pre-wrap");
    if (bubble) {
      return (bubble.innerText || "").trim();
    }

    return (messageNode.innerText || "").trim();
  }

  function normalizeRole(role) {
    const normalized = String(role || "").toLowerCase().trim();
    if (normalized === "assistant") {
      return "assistant";
    }
    if (normalized === "user") {
      return "user";
    }
    if (normalized === "system") {
      return "system";
    }
    if (normalized === "tool") {
      return "tool";
    }
    return "unknown";
  }

  function roleLabel(role) {
    if (role === "assistant") {
      return "ChatGPT";
    }
    if (role === "user") {
      return "You";
    }
    if (role === "system") {
      return "System";
    }
    if (role === "tool") {
      return "Tool";
    }
    return "Unknown";
  }

  function normalizeTimestamp(value) {
    if (value == null || value === "") {
      return null;
    }

    if (typeof value === "number") {
      const millis = value > 1e12 ? value : value * 1000;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const asNumber = Number(value);
    if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
      const millis = asNumber > 1e12 ? asNumber : asNumber * 1000;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  function resolveConversationStartedAt(messages, fallbackCandidates = []) {
    const values = [];
    if (Array.isArray(messages)) {
      for (let index = 0; index < messages.length; index += 1) {
        const item = messages[index];
        values.push(
          item?.timestampIso,
          item?.timestamp,
          item?.create_time,
          item?.createTime,
          item?.update_time,
          item?.updateTime
        );
      }
    }
    if (Array.isArray(fallbackCandidates)) {
      values.push(...fallbackCandidates);
    }

    let bestMs = Number.POSITIVE_INFINITY;
    for (let index = 0; index < values.length; index += 1) {
      const ts = normalizeTimestamp(values[index]);
      if (!ts) {
        continue;
      }
      const ms = ts.getTime();
      if (!Number.isFinite(ms) || ms <= 0) {
        continue;
      }
      if (!isPlausibleThreadTimestamp(ms)) {
        continue;
      }
      if (ms < bestMs) {
        bestMs = ms;
      }
    }

    if (Number.isFinite(bestMs)) {
      return new Date(bestMs);
    }
    return new Date();
  }

  function isPlausibleThreadTimestamp(ms) {
    const nowMs = Date.now();
    if (ms < MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS) {
      return false;
    }
    if (ms > (nowMs + MAX_PLAUSIBLE_THREAD_FUTURE_SKEW_MS)) {
      return false;
    }
    return true;
  }

  function formatTimestamp(date) {
    if (!date) {
      return "Unknown time";
    }

    try {
      return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(date);
    } catch (_error) {
      return date.toISOString();
    }
  }

  function sanitizeConversationTitle(title) {
    const clean = String(title || "")
      .replace(/\s+/g, " ")
      .trim();
    return clean || "";
  }

  function chooseLongerText(currentText, nextText) {
    const current = String(currentText || "");
    const next = String(nextText || "");
    if (next.length > current.length) {
      return next;
    }
    return current;
  }

  function choosePreferredBodyHtml(currentBodyHtml, nextBodyHtml) {
    const current = String(currentBodyHtml || "").trim();
    const next = String(nextBodyHtml || "").trim();
    if (!current) {
      return next;
    }
    if (!next) {
      return current;
    }
    const currentMeaningful = hasMeaningfulBodyHtml(current);
    const nextMeaningful = hasMeaningfulBodyHtml(next);
    if (currentMeaningful && !nextMeaningful) {
      return current;
    }
    if (!currentMeaningful && nextMeaningful) {
      return next;
    }
    if (next.length > current.length) {
      return next;
    }
    return current;
  }

  function hasMeaningfulPlainText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().length > 0;
  }

  function hasMeaningfulBodyHtml(bodyHtml) {
    const raw = String(bodyHtml || "").trim();
    if (!raw) {
      return false;
    }
    if (/<(?:img|video|audio|svg|iframe)\b/i.test(raw)) {
      return true;
    }
    const text = raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 0;
  }

  function hasMeaningfulMessageCandidate(text, bodyHtml) {
    if (hasMeaningfulPlainText(text)) {
      return true;
    }
    return hasMeaningfulBodyHtml(bodyHtml);
  }

  function hasMeaningfulExportMessage(message) {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (hasMeaningfulPlainText(message.text || "")) {
      return true;
    }
    return hasMeaningfulBodyHtml(resolveMessageBodyHtml(message));
  }

  function assertExportableConversationMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) {
      throw new Error("No messages in thread.");
    }
    const meaningfulCount = list.reduce((acc, message) => (
      acc + (hasMeaningfulExportMessage(message) ? 1 : 0)
    ), 0);
    if (meaningfulCount <= 0) {
      throw new Error("Conversation without exportable content (0 usable messages).");
    }
  }

  function chooseTurnImageTargetMessageId(turnMessageIds, collected) {
    const ids = Array.isArray(turnMessageIds) ? turnMessageIds.filter(Boolean) : [];
    if (ids.length === 0 || !(collected instanceof Map)) {
      return "";
    }

    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const id = ids[index];
      const message = collected.get(id);
      if (message?.role === "assistant") {
        return id;
      }
    }

    return ids[ids.length - 1] || "";
  }

  function extractTurnLevelImagesHtml(turn, messageNodes) {
    if (!turn || typeof turn.querySelectorAll !== "function") {
      return "";
    }

    const containers = Array.isArray(messageNodes) ? messageNodes : Array.from(messageNodes || []);
    const figures = [];
    const seenSources = new Set();
    const images = Array.from(turn.querySelectorAll("img[src]"));

    images.forEach((img) => {
      if (!img) {
        return;
      }

      const insideMessageNode = containers.some((container) => {
        try {
          return Boolean(container && container.contains && container.contains(img));
        } catch (_error) {
          return false;
        }
      });
      if (insideMessageNode) {
        return;
      }

      if (img.closest("button, [role='button'], [aria-hidden='true']")) {
        return;
      }

      const src = sanitizeImageSrcForExport(img.getAttribute("src") || "");
      if (!src || seenSources.has(src)) {
        return;
      }
      seenSources.add(src);

      const altRaw = String(img.getAttribute("alt") || "").trim();
      const alt = escapeHtml(altRaw || ("Image " + (figures.length + 1)));
      figures.push(
        '<figure class="export-image-figure">' +
        '<img src="' + escapeHtml(src) + '" alt="' + alt + '" loading="lazy" decoding="async" data-lightbox="1">' +
        "</figure>"
      );
    });

    return figures.join("");
  }

  function mergeBodyHtmlWithExtraImages(currentBodyHtml, extraImageHtml) {
    const current = String(currentBodyHtml || "").trim();
    const extra = String(extraImageHtml || "").trim();
    if (!extra) {
      return current;
    }
    if (!current) {
      return extra;
    }

    const currentTemplate = document.createElement("template");
    currentTemplate.innerHTML = current;

    const extraTemplate = document.createElement("template");
    extraTemplate.innerHTML = extra;

    const knownSources = new Set(extractImageSourcesFromHtml(current));
    const extraNodes = Array.from(extraTemplate.content.childNodes || []);

    extraNodes.forEach((node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const element = node;
      const imageNodes = [];
      if (String(element.tagName || "").toLowerCase() === "img") {
        imageNodes.push(element);
      }
      imageNodes.push(...Array.from(element.querySelectorAll("img[src]")));

      if (imageNodes.length === 0) {
        return;
      }

      const sources = imageNodes
        .map((img) => sanitizeImageSrcForExport(img.getAttribute("src") || ""))
        .filter(Boolean);
      const hasNew = sources.some((src) => !knownSources.has(src));
      if (!hasNew) {
        return;
      }

      sources.forEach((src) => knownSources.add(src));
      currentTemplate.content.appendChild(element.cloneNode(true));
    });

    return currentTemplate.innerHTML.trim();
  }

  function resolveMessageBodyHtml(message) {
    const direct = String(message?.bodyHtml || "").trim();
    if (direct) {
      return enhanceRichBodyHtml(direct);
    }

    const text = String(message?.text || "");
    if (!text) {
      return "<p></p>";
    }
    return enhanceRichBodyHtml(renderMarkdownLite(text));
  }

  function enhanceRichBodyHtml(rawHtml) {
    const source = String(rawHtml || "").trim();
    if (!source) {
      return "";
    }

    const template = document.createElement("template");
    template.innerHTML = source;

    const taskInputs = template.content.querySelectorAll("li > input[type='checkbox']");
    taskInputs.forEach((input) => {
      input.setAttribute("class", "task-checkbox");
      input.setAttribute("disabled", "");
    });

    const standaloneCodes = template.content.querySelectorAll("code");
    standaloneCodes.forEach((code) => {
      if (code.closest("pre")) {
        return;
      }
      if (code.closest("table")) {
        return;
      }
      if (code.closest(".math-inline, .math-block")) {
        return;
      }

      const className = String(code.getAttribute("class") || "");
      const rawText = String(code.textContent || "");
      const isLanguageTagged = /(?:^|\s)(?:language|lang)-/i.test(className);
      const isMultiline = rawText.includes("\n");
      if (!isLanguageTagged && !isMultiline) {
        return;
      }

      const pre = document.createElement("pre");
      pre.appendChild(code.cloneNode(true));
      if (code.parentNode) {
        code.parentNode.replaceChild(pre, code);
      }
    });

    const tables = template.content.querySelectorAll("table");
    tables.forEach((table) => {
      if (table.parentElement && table.parentElement.classList.contains("table-wrap")) {
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    const pres = template.content.querySelectorAll("pre");
    pres.forEach((pre) => {
      if (pre.closest(".code-block")) {
        return;
      }

      const code = pre.querySelector("code");
      const className = String(code?.getAttribute("class") || "");
      const lang = normalizeCodeLanguageFromClass(className);

      const block = document.createElement("div");
      block.className = "code-block";

      const head = document.createElement("div");
      head.className = "code-head";
      head.textContent = lang || "code";
      block.appendChild(head);

      pre.parentNode.insertBefore(block, pre);
      block.appendChild(pre);
    });

    return template.innerHTML.trim();
  }

  function normalizeCodeLanguageFromClass(className) {
    const raw = String(className || "");
    if (!raw) {
      return "";
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const languageMatch = part.match(/^(?:language|lang)-([a-z0-9_+-]+)$/i);
      if (languageMatch) {
        return languageMatch[1].toLowerCase();
      }
    }
    return "";
  }

  function hasClassToken(node, token) {
    if (!node || !token || typeof node.getAttribute !== "function") {
      return false;
    }
    const className = String(node.getAttribute("class") || "").trim();
    if (!className) {
      return false;
    }
    const pattern = new RegExp("(^|\\s)" + escapeRegex(String(token)) + "(\\s|$)", "i");
    return pattern.test(className);
  }

  function extractKatexFormulaText(node) {
    if (!node || typeof node.querySelector !== "function") {
      return "";
    }

    const annotation = node.querySelector("annotation");
    if (annotation) {
      const annotationText = String(annotation.textContent || "").trim();
      if (annotationText) {
        return annotationText;
      }
    }

    const ariaLabel = String(node.getAttribute("aria-label") || "").trim();
    if (ariaLabel) {
      return ariaLabel;
    }

    return String(node.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizePositiveIntegerAttribute(value, maxValue) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) {
      return "";
    }
    if (!/^\d+$/.test(raw)) {
      return "";
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return "";
    }
    const max = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 1000000;
    return String(Math.min(Math.floor(parsed), max));
  }

  function extractDomMessageRichHtml(messageNode) {
    if (!messageNode) {
      return "";
    }

    const richCandidates = messageNode.querySelectorAll(
      ".markdown, [data-message-content], [data-testid='message-content'], .prose"
    );
    for (let i = 0; i < richCandidates.length; i += 1) {
      const richNode = richCandidates[i];
      const rawRichHtml = String(richNode?.innerHTML || "");
      if (rawRichHtml.trim()) {
        return sanitizeRichHtml(rawRichHtml);
      }
    }

    const hasStructuredContent = Boolean(
      messageNode.querySelector("pre, code, ul, ol, table, blockquote, details, img, figure, .katex")
    );
    if (!hasStructuredContent) {
      return "";
    }

    const cloned = messageNode.cloneNode(true);
    const inlineBadges = cloned.querySelectorAll("[" + INLINE_TS_MARKER_ATTR + "='1']");
    inlineBadges.forEach((node) => node.remove());
    return sanitizeRichHtml(String(cloned.innerHTML || ""));
  }

  function sanitizeRichHtml(rawHtml) {
    const source = String(rawHtml || "").trim();
    if (!source) {
      return "";
    }

    const allowedTags = new Set([
      "p", "br", "ul", "ol", "li", "strong", "em", "b", "i", "code", "pre",
      "blockquote", "table", "thead", "tbody", "tr", "th", "td", "a",
      "h1", "h2", "h3", "h4", "h5", "h6", "hr", "span", "div",
      "img", "details", "summary", "kbd", "sup", "sub", "del", "mark",
      "figure", "figcaption", "aside", "input",
      "dl", "dt", "dd", "s", "small", "u", "abbr", "time", "cite", "q", "var", "samp"
    ]);
    const blockedTags = new Set([
      "script", "style", "iframe", "object", "embed", "svg", "path",
      "button", "textarea", "select", "option", "form", "label"
    ]);

    const template = document.createElement("template");
    template.innerHTML = source;
    const out = document.createElement("div");

    const sanitizeNode = (node, parent) => {
      if (!node) {
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.textContent || ""));
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const tag = String(node.tagName || "").toLowerCase();
      if (blockedTags.has(tag)) {
        return;
      }
      if (node.hasAttribute && node.hasAttribute(INLINE_TS_MARKER_ATTR)) {
        return;
      }

      const nodeIsKatex = hasClassToken(node, "katex") || hasClassToken(node, "katex-display");
      if (nodeIsKatex) {
        const formulaText = extractKatexFormulaText(node);
        if (formulaText) {
          const isBlock = hasClassToken(node, "katex-display");
          const wrapper = document.createElement(isBlock ? "div" : "span");
          wrapper.setAttribute("class", isBlock ? "math-block" : "math-inline");
          const formulaCode = document.createElement("code");
          formulaCode.textContent = formulaText;
          wrapper.appendChild(formulaCode);
          parent.appendChild(wrapper);
        }
        return;
      }

      if (String(node.getAttribute("aria-hidden") || "").toLowerCase() === "true") {
        return;
      }

      if (!allowedTags.has(tag)) {
        Array.from(node.childNodes || []).forEach((child) => sanitizeNode(child, parent));
        return;
      }

      const clean = document.createElement(tag);

      if (tag === "a") {
        const href = sanitizeHrefForExport(node.getAttribute("href") || "");
        if (href) {
          clean.setAttribute("href", href);
          clean.setAttribute("target", "_blank");
          clean.setAttribute("rel", "noopener noreferrer");
        }
      }

      if (tag === "img") {
        const src = sanitizeImageSrcForExport(node.getAttribute("src") || "");
        if (!src) {
          return;
        }
        clean.setAttribute("src", src);
        const alt = String(node.getAttribute("alt") || "").slice(0, 500);
        if (alt) {
          clean.setAttribute("alt", alt);
        }
        clean.setAttribute("loading", "lazy");
        clean.setAttribute("decoding", "async");
        clean.setAttribute("data-lightbox", "1");
      }

      if (tag === "input") {
        const inputType = String(node.getAttribute("type") || "").toLowerCase().trim();
        if (inputType !== "checkbox") {
          return;
        }
        clean.setAttribute("type", "checkbox");
        clean.setAttribute("disabled", "");
        clean.setAttribute("class", "task-checkbox");
        if (node.hasAttribute("checked")) {
          clean.setAttribute("checked", "");
        }
        parent.appendChild(clean);
        return;
      }

      if (tag === "details" && node.hasAttribute("open")) {
        clean.setAttribute("open", "");
      }

      if (tag === "ol") {
        const start = sanitizePositiveIntegerAttribute(node.getAttribute("start"), 100000);
        if (start) {
          clean.setAttribute("start", start);
        }
      }

      if (tag === "li") {
        const value = sanitizePositiveIntegerAttribute(node.getAttribute("value"), 100000);
        if (value) {
          clean.setAttribute("value", value);
        }
      }

      if (tag === "th" || tag === "td") {
        const colspan = sanitizePositiveIntegerAttribute(node.getAttribute("colspan"), 12);
        if (colspan) {
          clean.setAttribute("colspan", colspan);
        }
        const rowspan = sanitizePositiveIntegerAttribute(node.getAttribute("rowspan"), 40);
        if (rowspan) {
          clean.setAttribute("rowspan", rowspan);
        }
      }

      if (tag === "abbr") {
        const title = String(node.getAttribute("title") || "").slice(0, 200);
        if (title) {
          clean.setAttribute("title", title);
        }
      }

      if (tag === "time") {
        const datetime = String(node.getAttribute("datetime") || "").slice(0, 60);
        if (datetime) {
          clean.setAttribute("datetime", datetime);
        }
      }

      if (tag === "code" || tag === "pre" || tag === "span" || tag === "div" || tag === "aside") {
        const rawClass = String(node.getAttribute("class") || "").trim();
        if (rawClass && /^[a-zA-Z0-9_:+\-\s]+$/.test(rawClass)) {
          clean.setAttribute("class", rawClass);
        }
      }

      Array.from(node.childNodes || []).forEach((child) => sanitizeNode(child, clean));
      parent.appendChild(clean);
    };

    Array.from(template.content.childNodes || []).forEach((child) => sanitizeNode(child, out));
    return out.innerHTML.trim();
  }

  function sanitizeHrefForExport(href) {
    const raw = String(href || "").trim();
    if (!raw) {
      return "";
    }

    try {
      const parsed = new URL(raw, window.location.origin);
      const protocol = String(parsed.protocol || "").toLowerCase();
      if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
        return parsed.href;
      }
      return "";
    } catch (_error) {
      return "";
    }
  }

  function sanitizeImageSrcForExport(src) {
    const raw = String(src || "").trim();
    if (!raw) {
      return "";
    }

    if (/^data:image\//i.test(raw)) {
      return raw;
    }

    try {
      const parsed = new URL(raw, window.location.origin);
      const protocol = String(parsed.protocol || "").toLowerCase();
      if (protocol === "http:" || protocol === "https:") {
        return parsed.href;
      }
      return "";
    } catch (_error) {
      return "";
    }
  }

  function renderMarkdownLite(inputText) {
    const text = String(inputText || "").replace(/\r\n?/g, "\n");
    if (!text.trim()) {
      return "<p></p>";
    }

    const lines = text.split("\n");
    const out = [];
    let paragraph = [];
    let listStack = [];
    let inCodeFence = false;
    let codeLang = "";
    let codeFenceMarker = "```";
    let codeLines = [];
    let quoteLines = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) {
        return;
      }
      out.push("<p>" + renderInlineMarkdown(paragraph.join("\n")) + "</p>");
      paragraph = [];
    };

    const flushList = () => {
      while (listStack.length > 0) {
        const entry = listStack.pop();
        out.push("</li></" + entry.type + ">");
      }
    };

    const pushListItem = (itemType, indent, content, startNum) => {
      flushParagraph();

      while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
        const entry = listStack.pop();
        out.push("</li></" + entry.type + ">");
      }

      if (listStack.length === 0) {
        const tag = itemType === "ol" && startNum > 1
          ? '<ol start="' + startNum + '">' : "<" + itemType + ">";
        out.push(tag);
        listStack.push({ type: itemType, indent: indent });
        out.push("<li>" + renderMarkdownListItem(content));
      } else {
        const top = listStack[listStack.length - 1];
        if (indent > top.indent) {
          const tag = itemType === "ol" && startNum > 1
            ? '<ol start="' + startNum + '">' : "<" + itemType + ">";
          out.push(tag);
          listStack.push({ type: itemType, indent: indent });
          out.push("<li>" + renderMarkdownListItem(content));
        } else if (top.type === itemType) {
          out.push("</li><li>" + renderMarkdownListItem(content));
        } else {
          const entry = listStack.pop();
          out.push("</li></" + entry.type + ">");
          const tag = itemType === "ol" && startNum > 1
            ? '<ol start="' + startNum + '">' : "<" + itemType + ">";
          out.push(tag);
          listStack.push({ type: itemType, indent: indent });
          out.push("<li>" + renderMarkdownListItem(content));
        }
      }
    };

    const flushQuote = () => {
      if (quoteLines.length === 0) {
        return;
      }
      const quoteText = quoteLines.join("\n").trim();
      if (quoteText) {
        out.push("<blockquote>" + renderMarkdownLite(quoteText) + "</blockquote>");
      }
      quoteLines = [];
    };

    const flushCodeFence = () => {
      const escaped = escapeHtml(codeLines.join("\n"));
      const lang = sanitizeForClassName(codeLang);
      const classAttr = lang ? ' class="language-' + lang + '"' : "";
      out.push(
        '<div class="code-block"><div class="code-head">' +
        escapeHtml(lang || "code") +
        '</div><pre><code' + classAttr + ">" + escaped + "</code></pre></div>"
      );
      inCodeFence = false;
      codeLang = "";
      codeFenceMarker = "```";
      codeLines = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (inCodeFence) {
        const closePattern = new RegExp("^" + escapeRegex(codeFenceMarker) + "\\s*$");
        if (closePattern.test(trimmed)) {
          flushCodeFence();
        } else {
          codeLines.push(line);
        }
        continue;
      }

      const fenceMatch = trimmed.match(/^(```|~~~)\s*([\w-]+)?\s*$/);
      if (fenceMatch) {
        flushQuote();
        flushParagraph();
        flushList();
        inCodeFence = true;
        codeFenceMarker = String(fenceMatch[1] || "```");
        codeLang = String(fenceMatch[2] || "").trim();
        codeLines = [];
        continue;
      }

      if (!trimmed) {
        flushQuote();
        flushParagraph();
        flushList();
        continue;
      }

      const quoteMatch = line.match(/^\s*>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quoteLines.push(quoteMatch[1] || "");
        continue;
      } else {
        flushQuote();
      }

      if (line.includes("|") && i + 1 < lines.length && isMarkdownTableDivider(lines[i + 1])) {
        flushQuote();
        flushParagraph();
        flushList();

        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length) {
          const row = lines[i];
          if (!row.trim()) {
            i -= 1;
            break;
          }
          if (!row.includes("|")) {
            i -= 1;
            break;
          }
          tableLines.push(row);
          i += 1;
        }

        out.push(renderMarkdownTable(tableLines));
        continue;
      }

      const calloutMatch = line.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (calloutMatch) {
        flushQuote();
        flushParagraph();
        flushList();

        const calloutType = String(calloutMatch[1] || "note").toLowerCase();
        const calloutText = String(calloutMatch[2] || "").trim();
        const labelMap = {
          note: "Note",
          tip: "Tip",
          important: "Important",
          warning: "Warning",
          caution: "Caution"
        };
        const calloutLabel = labelMap[calloutType] || "Note";
        const body = calloutText ? "<p>" + renderInlineMarkdown(calloutText) + "</p>" : "";
        out.push(
          '<aside class="callout callout-' + escapeHtml(calloutType) + '">' +
          '<div class="callout-title">' + escapeHtml(calloutLabel) + "</div>" +
          body +
          "</aside>"
        );
        continue;
      }

      const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = Math.max(1, Math.min(6, headingMatch[1].length));
        out.push("<h" + level + ">" + renderInlineMarkdown(headingMatch[2]) + "</h" + level + ">");
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushParagraph();
        flushList();
        out.push("<hr>");
        continue;
      }

      const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
      if (orderedMatch) {
        const indent = orderedMatch[1].length;
        const startNum = Math.max(1, Number(orderedMatch[2]) || 1);
        pushListItem("ol", indent, orderedMatch[3], startNum);
        continue;
      }

      const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (unorderedMatch) {
        const indent = unorderedMatch[1].length;
        pushListItem("ul", indent, unorderedMatch[2], 1);
        continue;
      }

      flushList();
      paragraph.push(trimmed);
    }

    if (inCodeFence) {
      flushCodeFence();
    }
    flushQuote();
    flushParagraph();
    flushList();

    return out.join("\n");
  }

  function renderMarkdownListItem(itemText) {
    const raw = String(itemText || "");
    const task = raw.match(/^\[( |x|X)\]\s+(.+)$/);
    if (!task) {
      return renderInlineMarkdown(raw);
    }

    const done = /x/i.test(task[1] || "");
    const label = renderInlineMarkdown(task[2] || "");
    return (
      '<span class="task-item">' +
      '<span class="task-box' + (done ? " done" : "") + '"></span>' +
      '<span class="task-label">' + label + "</span>" +
      "</span>"
    );
  }

  function isMarkdownTableDivider(line) {
    const raw = String(line || "").trim();
    if (!raw.includes("-")) {
      return false;
    }
    const sanitized = raw.replace(/\|/g, "").trim();
    return /^:?-{2,}:?(?:\s*:?-{2,}:?)*$/.test(sanitized.replace(/\s+/g, " "));
  }

  function renderMarkdownTable(tableLines) {
    if (!Array.isArray(tableLines) || tableLines.length < 2) {
      return "<p>" + renderInlineMarkdown(String(tableLines?.[0] || "")) + "</p>";
    }

    const headerCells = splitMarkdownTableRow(tableLines[0]);
    const alignCells = splitMarkdownTableRow(tableLines[1]);
    const bodyRows = tableLines.slice(2).map(splitMarkdownTableRow);

    const aligns = alignCells.map((cell) => {
      const value = String(cell || "").trim();
      const left = value.startsWith(":");
      const right = value.endsWith(":");
      if (left && right) {
        return "center";
      }
      if (right) {
        return "right";
      }
      return "left";
    });

    const header = "<tr>" + headerCells.map((cell, index) => {
      const align = aligns[index] || "left";
      return '<th style="text-align:' + align + ';">' + renderInlineMarkdown(cell) + "</th>";
    }).join("") + "</tr>";

    const body = bodyRows.map((row) => {
      return "<tr>" + headerCells.map((_, index) => {
        const align = aligns[index] || "left";
        const value = row[index] || "";
        return '<td style="text-align:' + align + ';">' + renderInlineMarkdown(value) + "</td>";
      }).join("") + "</tr>";
    }).join("");

    return '<div class="table-wrap"><table><thead>' + header + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function splitMarkdownTableRow(line) {
    const raw = String(line || "").trim();
    const trimmed = raw.replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  }

  function renderInlineMarkdown(input) {
    const raw = escapeHtml(String(input || ""));
    const codeSpans = [];
    const imageSpans = [];
    const linkSpans = [];
    let text = raw.replace(/`([^`\n]+)`/g, (_m, code) => {
      const token = "@@CODE_" + codeSpans.length + "@@";
      codeSpans.push("<code>" + code + "</code>");
      return token;
    });

    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
      const safeSrc = sanitizeImageSrcForExport(src);
      if (!safeSrc) {
        return alt;
      }
      const token = "@@IMG_" + imageSpans.length + "@@";
      imageSpans.push('<img src="' + escapeHtml(safeSrc) + '" alt="' + alt + '" loading="lazy" decoding="async" data-lightbox="1">');
      return token;
    });

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
      const safeHref = sanitizeHrefForExport(href);
      if (!safeHref) {
        return label;
      }
      const token = "@@LINK_" + linkSpans.length + "@@";
      linkSpans.push('<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>");
      return token;
    });

    text = text.replace(/(https?:\/\/[^\s<)"']*[^\s<).,!?;:"'])/g, (url) => {
      const safeHref = sanitizeHrefForExport(url);
      if (!safeHref) {
        return url;
      }
      return '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + "</a>";
    });

    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    text = text.replace(/(^|[\s(])\*([^*\n][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
    text = text.replace(/(^|[\s(])_([^_\n][^_\n]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
    text = text.replace(/\n/g, "<br>");

    codeSpans.forEach((snippet, index) => {
      const token = "@@CODE_" + index + "@@";
      text = text.split(token).join(snippet);
    });

    imageSpans.forEach((snippet, index) => {
      const token = "@@IMG_" + index + "@@";
      text = text.split(token).join(snippet);
    });

    linkSpans.forEach((snippet, index) => {
      const token = "@@LINK_" + index + "@@";
      text = text.split(token).join(snippet);
    });

    return text;
  }

  function sanitizeForClassName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 30);
  }

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildHtmlDocument({ title, source, messages, exportedAt, threadStartedAt, pageUrl }) {
    const safeTitle = escapeHtml(title || "ChatGPT Dialog");
    const safeUrl = escapeHtml(pageUrl || "");
    const exportedLabel = formatTimestamp(exportedAt);
    const exportIso = exportedAt.toISOString();
    const startedAt = threadStartedAt instanceof Date && !Number.isNaN(threadStartedAt.getTime())
      ? threadStartedAt
      : null;
    const startedIso = startedAt ? startedAt.toISOString() : "";
    const startedLabel = startedAt ? formatTimestamp(startedAt) : "Unknown time";

    const items = messages
      .map((message, index) => {
        const roleClass = "role-" + escapeHtml(message.role || "unknown");
        const label = escapeHtml(message.label || "Unknown");
        const timestampDisplay = escapeHtml(message.timestampDisplay || "Unknown time");
        const timestampIso = escapeHtml(message.timestampIso || "");
        const bodyHtml = resolveMessageBodyHtml(message);
        const count = index + 1;
        return `
          <article class="message ${roleClass}">
            <div class="message-head">
              <span class="role-pill">${label}</span>
              <span class="meta">
                <span class="count">#${count}</span>
                <time datetime="${timestampIso}">${timestampDisplay}</time>
              </span>
            </div>
            <div class="body">
              <div class="rich-body">${bodyHtml}</div>
            </div>
          </article>
        `;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f0f4fa;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --line: #d7e2f1;
      --accent: #2563eb;
      --user-bg: #dbeafe;
      --user-border: #7cb8f0;
      --assistant-bg: #ffffff;
      --assistant-border: #d7e2f1;
      --system-bg: #fef9ee;
      --system-border: #e8d5a3;
      --tool-bg: #f3f0ff;
      --tool-border: #c4b5fd;
      --unknown-bg: #eef4ff;
      --shadow-sm: 0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04);
      --shadow: 0 4px 16px rgba(15,23,42,0.08), 0 1px 3px rgba(15,23,42,0.06);
      --shadow-lg: 0 10px 30px rgba(15,23,42,0.10), 0 4px 8px rgba(15,23,42,0.05);
      --radius: 14px;
      --radius-sm: 10px;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      background: var(--bg);
      background-image:
        radial-gradient(ellipse at 15% 0%, #dde8ff 0%, transparent 50%),
        radial-gradient(ellipse at 85% 0%, #d0f0ff 0%, transparent 45%);
      background-attachment: fixed;
      line-height: 1.6;
      font-size: 15px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    /* === Page layout === */
    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 28px 20px 56px;
    }

    /* === Header card === */
    .header {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 20px 24px;
      box-shadow: var(--shadow);
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 1.4rem;
      font-weight: 700;
      line-height: 1.3;
      word-break: break-word;
      color: #0c1b33;
    }
    .header p {
      margin: 5px 0;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.5;
    }
    .header p strong {
      color: #334155;
      font-weight: 600;
    }
    .header a {
      color: var(--accent);
      text-decoration: none;
      word-break: break-all;
    }
    .header a:hover {
      text-decoration: underline;
    }

    /* === Thread === */
    .thread {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    /* === Message bubbles === */
    .message {
      border: 1px solid var(--line);
      border-left: 4px solid #94a3b8;
      border-radius: var(--radius);
      padding: 14px 18px 16px;
      box-shadow: var(--shadow-sm);
      background: var(--unknown-bg);
      width: min(100%, 880px);
      transition: box-shadow 0.15s ease;
    }
    .message:hover {
      box-shadow: var(--shadow);
    }
    .message.role-user {
      align-self: flex-end;
      background: var(--user-bg);
      border-color: var(--user-border);
      border-left-color: #2563eb;
    }
    .message.role-assistant {
      align-self: flex-start;
      background: var(--assistant-bg);
      border-color: var(--assistant-border);
      border-left-color: #059669;
    }
    .message.role-system {
      align-self: flex-start;
      background: var(--system-bg);
      border-color: var(--system-border);
      border-left-color: #d97706;
    }
    .message.role-tool {
      align-self: flex-start;
      background: var(--tool-bg);
      border-color: var(--tool-border);
      border-left-color: #7c3aed;
    }

    /* === Message header === */
    .message-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .role-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 12px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .role-user .role-pill {
      background: #2563eb;
      color: #ffffff;
      border: 1px solid #1d4ed8;
    }
    .role-assistant .role-pill {
      background: #059669;
      color: #ffffff;
      border: 1px solid #047857;
    }
    .role-system .role-pill {
      background: #d97706;
      color: #ffffff;
      border: 1px solid #b45309;
    }
    .role-tool .role-pill {
      background: #7c3aed;
      color: #ffffff;
      border: 1px solid #6d28d9;
    }
    .role-unknown .role-pill {
      background: rgba(255,255,255,0.92);
      color: #334155;
      border: 1px solid var(--line);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .count {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 9px;
      background: rgba(255,255,255,0.85);
      color: #475569;
      font-weight: 600;
      font-size: 0.75rem;
    }

    /* === Body === */
    .body {
      padding-top: 4px;
    }
    .rich-body {
      color: #1a2332;
      font: 400 0.95rem/1.7 "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .rich-body > *:first-child { margin-top: 0; }
    .rich-body > *:last-child { margin-bottom: 0; }

    /* === Paragraphs === */
    .rich-body p {
      margin: 0 0 0.75em;
      white-space: pre-wrap;
    }

    /* === Horizontal rule === */
    .rich-body hr {
      border: 0;
      height: 1px;
      background: linear-gradient(to right, transparent, #c1d0e4, transparent);
      margin: 1.2em 0;
    }

    /* === Headings === */
    .rich-body h1,
    .rich-body h2,
    .rich-body h3,
    .rich-body h4,
    .rich-body h5,
    .rich-body h6 {
      line-height: 1.35;
      color: #0c1b33;
      font-weight: 700;
    }
    .rich-body h1 {
      font-size: 1.45em;
      margin: 1.2em 0 0.5em;
      padding-bottom: 0.3em;
      border-bottom: 2px solid #e2e8f0;
    }
    .rich-body h2 {
      font-size: 1.28em;
      margin: 1.1em 0 0.45em;
      padding-bottom: 0.25em;
      border-bottom: 1px solid #e2e8f0;
    }
    .rich-body h3 {
      font-size: 1.14em;
      margin: 1em 0 0.4em;
    }
    .rich-body h4 {
      font-size: 1.05em;
      margin: 0.9em 0 0.35em;
      color: #1e3a5f;
    }
    .rich-body h5 {
      font-size: 0.95em;
      margin: 0.8em 0 0.3em;
      color: #334155;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .rich-body h6 {
      font-size: 0.88em;
      margin: 0.7em 0 0.25em;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    /* === Lists === */
    .rich-body ul,
    .rich-body ol {
      margin: 0.4em 0 0.9em;
      padding-left: 1.8em;
    }
    .rich-body ul { list-style-type: disc; }
    .rich-body ul ul { list-style-type: circle; }
    .rich-body ul ul ul { list-style-type: square; }
    .rich-body ul ul ul ul { list-style-type: disc; }
    .rich-body ol { list-style-type: decimal; }
    .rich-body ol ol { list-style-type: lower-alpha; }
    .rich-body ol ol ol { list-style-type: lower-roman; }
    .rich-body ol ol ol ol { list-style-type: decimal; }
    .rich-body ul ul,
    .rich-body ul ol,
    .rich-body ol ul,
    .rich-body ol ol {
      margin-top: 0.15em;
      margin-bottom: 0.15em;
    }
    .rich-body li {
      margin: 0.3em 0;
      padding-left: 0.2em;
      line-height: 1.6;
    }
    .rich-body li > p {
      margin: 0.15em 0;
    }
    .rich-body li > p + p {
      margin-top: 0.45em;
    }
    .rich-body li::marker {
      color: #64748b;
    }
    .rich-body ol > li::marker {
      color: var(--accent);
      font-weight: 700;
    }
    .rich-body li > strong:first-child,
    .rich-body li > p:first-child > strong:first-child {
      color: #1e3a5f;
    }
    .rich-body li > .code-block,
    .rich-body li > blockquote,
    .rich-body li > .table-wrap {
      margin-top: 0.4em;
      margin-bottom: 0.4em;
    }

    /* === Definition lists === */
    .rich-body dl {
      margin: 0.6em 0 0.9em;
      padding: 0;
    }
    .rich-body dt {
      font-weight: 700;
      color: #1e3a5f;
      margin: 0.6em 0 0.15em;
      padding-bottom: 0.1em;
      border-bottom: 1px dashed #d7e2f1;
    }
    .rich-body dt:first-child {
      margin-top: 0;
    }
    .rich-body dd {
      margin: 0 0 0.4em 1.4em;
      padding-left: 0.6em;
      border-left: 2px solid #e2e8f0;
      color: #334155;
    }

    /* === Inline text styles === */
    .rich-body strong, .rich-body b {
      font-weight: 700;
      color: #0c1b33;
    }
    .rich-body em, .rich-body i {
      font-style: italic;
    }
    .rich-body del, .rich-body s {
      text-decoration: line-through;
      color: #94a3b8;
    }
    .rich-body mark {
      background: linear-gradient(120deg, #fef08a 0%, #fde68a 100%);
      padding: 0.1em 0.3em;
      border-radius: 3px;
      color: #1a1a1a;
    }
    .rich-body sup {
      font-size: 0.75em;
      vertical-align: super;
      line-height: 0;
    }
    .rich-body sub {
      font-size: 0.75em;
      vertical-align: sub;
      line-height: 0;
    }
    .rich-body abbr[title] {
      text-decoration: underline dotted;
      text-decoration-color: #94a3b8;
      cursor: help;
    }
    .rich-body u {
      text-decoration: underline;
      text-decoration-color: #3b82f6;
      text-underline-offset: 2px;
    }
    .rich-body small {
      font-size: 0.85em;
      color: #64748b;
    }
    .rich-body cite {
      font-style: italic;
      color: #475569;
    }
    .rich-body q {
      quotes: "\\201E" "\\201C" "\\201A" "\\2018";
    }
    .rich-body q::before { content: open-quote; color: #94a3b8; }
    .rich-body q::after { content: close-quote; color: #94a3b8; }
    .rich-body var {
      font-style: italic;
      font-family: "Cambria Math", Cambria, Georgia, serif;
      color: #7c3aed;
    }
    .rich-body samp {
      font-family: Consolas, "Fira Code", "Courier New", monospace;
      font-size: 0.9em;
      padding: 1px 5px;
      border-radius: 4px;
      background: #1e293b;
      color: #22d3ee;
    }

    /* === Code blocks === */
    .rich-body .code-block {
      margin: 0.9em 0;
      border: 1px solid #1e293b;
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: #0f172a;
      box-shadow: var(--shadow-sm);
    }
    .rich-body .code-head {
      display: flex;
      align-items: center;
      padding: 7px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      background: #1e293b;
      color: #94a3b8;
      font: 600 0.72rem/1.3 Consolas, "Courier New", monospace;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .rich-body pre {
      margin: 0.8em 0;
      padding: 14px 16px;
      background: #0f172a;
      color: #e2e8f0;
      overflow-x: auto;
      white-space: pre;
      font: 400 0.88rem/1.6 Consolas, "Fira Code", "Courier New", monospace;
      border-radius: var(--radius-sm);
      border: 1px solid #1e293b;
      -webkit-overflow-scrolling: touch;
    }
    .rich-body .code-block pre {
      margin: 0;
      border: 0;
      border-radius: 0;
    }
    .rich-body code {
      font-family: Consolas, "Fira Code", "Courier New", monospace;
      font-size: 0.9em;
    }
    .rich-body :not(pre) > code {
      padding: 2px 6px;
      border-radius: 5px;
      border: 1px solid #d2deef;
      background: #eef3fb;
      color: #1e40af;
      font-size: 0.87em;
      white-space: nowrap;
    }

    /* === Blockquote === */
    .rich-body blockquote {
      margin: 0.8em 0;
      padding: 0.6em 1em;
      border-left: 4px solid #3b82f6;
      color: #334155;
      background: #f1f5f9;
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      font-style: italic;
    }
    .rich-body blockquote p:last-child {
      margin-bottom: 0;
    }
    .rich-body blockquote blockquote {
      margin: 0.5em 0;
      border-left-color: #93c5fd;
      background: #e8f0fe;
    }

    /* === Tables === */
    .rich-body .table-wrap {
      margin: 0.9em 0;
      overflow-x: auto;
      border: 1px solid #c6d4e8;
      border-radius: var(--radius-sm);
      background: #ffffff;
      box-shadow: var(--shadow-sm);
      -webkit-overflow-scrolling: touch;
    }
    .rich-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 0;
      font-size: 0.9rem;
      min-width: 300px;
    }
    .rich-body th,
    .rich-body td {
      border: 1px solid #dde5f0;
      padding: 8px 12px;
      vertical-align: top;
      text-align: left;
    }
    .rich-body th {
      background: #edf2fc;
      font-weight: 700;
      color: #1e3a5f;
      font-size: 0.85rem;
      text-transform: none;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .rich-body tr:nth-child(even) td {
      background: #f8fafd;
    }
    .rich-body tr:hover td {
      background: #edf2fb;
    }
    .rich-body td code {
      font-size: 0.85em;
    }

    /* === Figures / Images === */
    .rich-body figure {
      margin: 1em 0;
      text-align: center;
    }
    .rich-body figcaption {
      margin-top: 0.4em;
      color: #64748b;
      font-size: 0.84rem;
      font-style: italic;
      line-height: 1.4;
    }
    .rich-body img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 0.8em auto;
      border-radius: var(--radius-sm);
      border: 1px solid #d7e2f1;
      box-shadow: var(--shadow-sm);
      cursor: zoom-in;
      transition: transform 0.16s ease, box-shadow 0.16s ease;
    }
    .rich-body img:hover {
      transform: translateY(-1px);
      box-shadow: var(--shadow);
    }

    /* === Image lightbox === */
    .image-lightbox {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(8, 15, 30, 0.88);
      backdrop-filter: blur(2px);
      z-index: 99999;
      padding: 18px;
    }
    .image-lightbox.open {
      display: flex;
    }
    .image-lightbox img {
      max-width: min(96vw, 1600px);
      max-height: calc(100vh - 120px);
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.35);
      box-shadow: 0 14px 46px rgba(0,0,0,0.5);
      background: rgba(255,255,255,0.04);
      cursor: zoom-out;
      margin: 0;
      transform: none !important;
    }
    .image-lightbox .lightbox-close {
      position: fixed;
      top: 14px;
      right: 14px;
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255,255,255,0.45);
      border-radius: 999px;
      background: rgba(0,0,0,0.36);
      color: #ffffff;
      font-size: 28px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .image-lightbox .lightbox-close:hover {
      background: rgba(0,0,0,0.55);
    }
    .image-lightbox .lightbox-caption {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 16px;
      max-width: min(92vw, 1120px);
      color: rgba(255,255,255,0.94);
      text-align: center;
      font-size: 0.86rem;
      line-height: 1.45;
      text-shadow: 0 1px 2px rgba(0,0,0,0.45);
      overflow-wrap: anywhere;
      word-break: break-word;
      padding: 6px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.28);
    }

    /* === Math === */
    .rich-body .math-inline {
      display: inline-flex;
      align-items: center;
      padding: 1px 0.3em;
      border-radius: 5px;
      border: 1px solid #d8e2f1;
      background: #f0f4ff;
      color: #1e3a5f;
      font: 500 0.92em/1.4 "Cambria Math", Cambria, "Times New Roman", serif;
    }
    .rich-body .math-inline code {
      font: inherit;
      white-space: nowrap;
      border: 0;
      background: transparent;
      padding: 0;
      color: inherit;
    }
    .rich-body .math-block {
      margin: 0.9em 0;
      padding: 0.7em 1em;
      border-radius: var(--radius-sm);
      border: 1px solid #d6e1f2;
      background: #f4f8ff;
      overflow-x: auto;
      font: 500 0.96rem/1.5 "Cambria Math", Cambria, "Times New Roman", serif;
      color: #1e3a5f;
      text-align: center;
    }
    .rich-body .math-block code {
      font: inherit;
      white-space: pre-wrap;
      border: 0;
      background: transparent;
      padding: 0;
      color: inherit;
    }

    /* === Details / Summary === */
    .rich-body details {
      margin: 0.8em 0;
      border: 1px solid #d3deef;
      border-radius: var(--radius-sm);
      background: rgba(255,255,255,0.85);
      padding: 0;
      overflow: hidden;
    }
    .rich-body summary {
      cursor: pointer;
      font-weight: 600;
      color: #1e3a5f;
      padding: 10px 14px;
      background: #f5f8fc;
      border-bottom: 1px solid transparent;
      user-select: none;
      list-style: none;
    }
    .rich-body summary::-webkit-details-marker { display: none; }
    .rich-body summary::before {
      content: "\\25B6";
      display: inline-block;
      margin-right: 8px;
      font-size: 0.7em;
      transition: transform 0.15s ease;
      color: #64748b;
    }
    .rich-body details[open] > summary::before {
      transform: rotate(90deg);
    }
    .rich-body details[open] > summary {
      border-bottom-color: #e2e8f0;
    }
    .rich-body details > *:not(summary) {
      padding: 0 14px;
    }
    .rich-body details > *:last-child {
      padding-bottom: 10px;
    }

    /* === Keyboard keys === */
    .rich-body kbd {
      display: inline-block;
      min-width: 1.5em;
      padding: 2px 6px;
      border: 1px solid #b8c9de;
      border-bottom-width: 3px;
      border-radius: 5px;
      background: linear-gradient(180deg, #f8faff 0%, #eef2f9 100%);
      color: #1e3a5f;
      font: 600 0.82em/1.5 Consolas, "Courier New", monospace;
      text-align: center;
      white-space: nowrap;
      box-shadow: 0 1px 1px rgba(0,0,0,0.08);
    }

    /* === Task items === */
    .rich-body .task-item {
      display: inline-flex;
      align-items: flex-start;
      gap: 0.45rem;
    }
    .rich-body .task-box {
      margin-top: 0.2rem;
      width: 1rem;
      height: 1rem;
      border: 2px solid #94a3b8;
      border-radius: 4px;
      background: #ffffff;
      flex: 0 0 auto;
      position: relative;
    }
    .rich-body .task-box.done {
      background: #2563eb;
      border-color: #2563eb;
    }
    .rich-body .task-box.done::after {
      content: "";
      position: absolute;
      left: 0.2rem;
      top: 0.02rem;
      width: 0.3rem;
      height: 0.56rem;
      border: solid #ffffff;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .rich-body .task-label {
      display: inline-block;
    }
    .rich-body input.task-checkbox {
      width: 1rem;
      height: 1rem;
      margin: 0 0.45rem 0 0;
      accent-color: #2563eb;
      vertical-align: text-top;
      pointer-events: none;
    }

    /* === Callouts === */
    .rich-body .callout {
      margin: 0.9em 0;
      border: 1px solid #bfd0e9;
      border-left-width: 4px;
      border-radius: var(--radius-sm);
      padding: 0.65em 0.9em;
      background: #f8fbff;
    }
    .rich-body .callout-title {
      margin: 0 0 0.3em;
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .rich-body .callout p {
      margin: 0.2em 0 0;
    }
    .rich-body .callout-note {
      border-left-color: #3b82f6;
      background: #eff6ff;
    }
    .rich-body .callout-note .callout-title { color: #1d4ed8; }
    .rich-body .callout-tip {
      border-left-color: #10b981;
      background: #ecfdf5;
    }
    .rich-body .callout-tip .callout-title { color: #059669; }
    .rich-body .callout-important {
      border-left-color: #7c3aed;
      background: #f5f3ff;
    }
    .rich-body .callout-important .callout-title { color: #6d28d9; }
    .rich-body .callout-warning {
      border-left-color: #f59e0b;
      background: #fffbeb;
    }
    .rich-body .callout-warning .callout-title { color: #b45309; }
    .rich-body .callout-caution {
      border-left-color: #ef4444;
      background: #fef2f2;
    }
    .rich-body .callout-caution .callout-title { color: #dc2626; }

    /* === Links === */
    .rich-body a {
      color: #2563eb;
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.1s ease;
    }
    .rich-body a:hover {
      border-bottom-color: #2563eb;
    }
    .rich-body a:visited {
      color: #6d28d9;
    }

    /* === Responsive === */
    @media (max-width: 720px) {
      body { font-size: 14px; }
      .page {
        padding: 12px 10px 28px;
      }
      .header {
        border-radius: 12px;
        padding: 14px 16px;
      }
      h1 { font-size: 1.15rem; }
      .message {
        border-radius: 12px;
        border-left-width: 3px;
        padding: 12px 14px;
        width: 100%;
      }
      .rich-body {
        font-size: 0.92rem;
      }
      .rich-body h1 { font-size: 1.25em; }
      .rich-body h2 { font-size: 1.15em; }
      .rich-body h3 { font-size: 1.05em; }
      .rich-body ul,
      .rich-body ol {
        padding-left: 1.4em;
      }
      .rich-body table {
        min-width: 260px;
        font-size: 0.85rem;
      }
      .rich-body th,
      .rich-body td {
        padding: 6px 8px;
      }
      .rich-body .code-head {
        padding: 5px 10px;
      }
      .rich-body pre {
        padding: 10px 12px;
        font-size: 0.82rem;
      }
      .rich-body blockquote {
        padding: 0.4em 0.7em;
        margin-left: 0;
        margin-right: 0;
      }
      .rich-body dd {
        margin-left: 0.8em;
      }
      .footer {
        flex-direction: column;
        gap: 6px;
        text-align: center;
      }
    }

    /* === Print === */
    @media print {
      body {
        background: #ffffff;
        background-image: none;
        font-size: 11pt;
        color: #000000;
      }
      .page {
        max-width: 100%;
        padding: 0;
      }
      .header {
        box-shadow: none;
        border: 1px solid #ccc;
        break-after: avoid;
      }
      .message {
        box-shadow: none;
        border: 1px solid #ccc;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .message:hover {
        box-shadow: none;
      }
      .rich-body a {
        color: #000;
        border-bottom: 0;
      }
      .rich-body a::after {
        content: " (" attr(href) ")";
        font-size: 0.8em;
        color: #666;
        word-break: break-all;
      }
      .rich-body .code-block,
      .rich-body pre {
        background: #f5f5f5 !important;
        color: #1a1a1a !important;
        border: 1px solid #ccc;
      }
      .rich-body .code-head {
        background: #e5e5e5 !important;
        color: #333 !important;
      }
      .rich-body img {
        max-width: 80%;
      }
      .image-lightbox {
        display: none !important;
      }
    }

    /* === Selection === */
    ::selection {
      background: #bfdbfe;
      color: #0c1b33;
    }

    /* === Focus === */
    a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 3px;
    }

    /* === Content spacing between different blocks === */
    .rich-body h1 + p,
    .rich-body h2 + p,
    .rich-body h3 + p {
      margin-top: 0.2em;
    }
    .rich-body p + .code-block,
    .rich-body p + .table-wrap,
    .rich-body p + blockquote {
      margin-top: 0.6em;
    }
    .rich-body .code-block + p,
    .rich-body .table-wrap + p,
    .rich-body blockquote + p {
      margin-top: 0.7em;
    }
    .rich-body h1 + .code-block,
    .rich-body h2 + .code-block,
    .rich-body h3 + .code-block,
    .rich-body h1 + ul,
    .rich-body h2 + ul,
    .rich-body h3 + ul,
    .rich-body h1 + ol,
    .rich-body h2 + ol,
    .rich-body h3 + ol {
      margin-top: 0.3em;
    }
    .rich-body blockquote + blockquote {
      margin-top: 0.4em;
    }
    .rich-body ul + p,
    .rich-body ol + p {
      margin-top: 0.5em;
    }

    /* === Footer === */
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 28px;
      padding: 14px 20px;
      border-top: 1px solid var(--line);
      color: #94a3b8;
      font-size: 0.78rem;
    }
    .footer a {
      color: #64748b;
      text-decoration: none;
      font-weight: 500;
    }
    .footer a:hover {
      color: var(--accent);
    }

    /* === Scrollbar (Webkit) === */
    .rich-body pre::-webkit-scrollbar,
    .rich-body .table-wrap::-webkit-scrollbar {
      height: 6px;
    }
    .rich-body pre::-webkit-scrollbar-track,
    .rich-body .table-wrap::-webkit-scrollbar-track {
      background: transparent;
    }
    .rich-body pre::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.18);
      border-radius: 3px;
    }
    .rich-body .table-wrap::-webkit-scrollbar-thumb {
      background: #c1d0e4;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <main class="page" id="top">
    <section class="header">
      <h1>${safeTitle}</h1>
      <p><strong>Exported:</strong> <time datetime="${escapeHtml(exportIso)}">${escapeHtml(exportedLabel)}</time></p>
      <p><strong>Thread start:</strong> ${startedAt ? ('<time datetime="' + escapeHtml(startedIso) + '">' + escapeHtml(startedLabel) + "</time>") : escapeHtml(startedLabel)}</p>
      <p><strong>Source:</strong> ${escapeHtml(source)}</p>
      <p><strong>Messages:</strong> ${messages.length}</p>
      <p><strong>URL:</strong> ${safeUrl ? '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + safeUrl + '</a>' : '-'}</p>
    </section>
    <section class="thread">
${items}
    </section>
    <footer class="footer">
      <a href="#top">Back to top</a>
      <span>${messages.length} Messages &middot; Exported ${escapeHtml(exportedLabel)}</span>
    </footer>
  </main>
  <div class="image-lightbox" id="image-lightbox" aria-hidden="true">
    <button type="button" class="lightbox-close" id="image-lightbox-close" aria-label="Close image">&times;</button>
    <img id="image-lightbox-img" alt="">
    <div class="lightbox-caption" id="image-lightbox-caption"></div>
  </div>
  <script>
    (function setupImageLightbox() {
      var lightbox = document.getElementById("image-lightbox");
      var lightboxImg = document.getElementById("image-lightbox-img");
      var lightboxCaption = document.getElementById("image-lightbox-caption");
      var closeBtn = document.getElementById("image-lightbox-close");
      if (!lightbox || !lightboxImg || !lightboxCaption || !closeBtn) {
        return;
      }

      function closeLightbox() {
        lightbox.classList.remove("open");
        lightbox.setAttribute("aria-hidden", "true");
        lightboxImg.setAttribute("src", "");
        lightboxImg.setAttribute("alt", "");
        lightboxCaption.textContent = "";
        if (document.body) {
          document.body.style.overflow = "";
        }
      }

      function openLightbox(img) {
        if (!img) {
          return;
        }
        var src = String(img.getAttribute("src") || "").trim();
        if (!src) {
          return;
        }
        var alt = String(img.getAttribute("alt") || "").trim();
        var original = String(img.getAttribute("data-export-original-src") || "").trim();
        lightboxImg.setAttribute("src", src);
        lightboxImg.setAttribute("alt", alt || "Image");
        lightboxCaption.textContent = original || alt || "";
        lightbox.classList.add("open");
        lightbox.setAttribute("aria-hidden", "false");
        if (document.body) {
          document.body.style.overflow = "hidden";
        }
      }

      document.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        if (target.closest(".lightbox-close")) {
          event.preventDefault();
          closeLightbox();
          return;
        }

        if (target === lightbox) {
          closeLightbox();
          return;
        }

        var img = target.closest(".rich-body img");
        if (!img) {
          return;
        }
        event.preventDefault();
        openLightbox(img);
      }, true);

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && lightbox.classList.contains("open")) {
          event.preventDefault();
          closeLightbox();
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  async function triggerBrowserDownload(html, filename, options = {}) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const safeFilename = String(filename || "chatgpt_dialog.html");
    const downloadFilename = buildDownloadFilenameWithSubdirectory(safeFilename, options?.subdirectory || "");
    const conflictAction = normalizeDownloadConflictAction(options?.conflictAction);

    try {
      const runtimeDownload = await triggerDownloadViaRuntime(html, downloadFilename, conflictAction);
      if (runtimeDownload && runtimeDownload.ok) {
        return;
      }
    } catch (error) {
      console.warn("[ChatGPT Export] Runtime download failed, trying direct API:", error);
    }

    if (chrome?.downloads?.download) {
      const extensionUrl = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url: extensionUrl,
              filename: downloadFilename,
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
        return;
      } catch (error) {
        console.warn("[ChatGPT Export] downloads API failed, fallback to anchor:", error);
      } finally {
        setTimeout(() => {
          URL.revokeObjectURL(extensionUrl);
        }, 45000);
      }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFilename;
    anchor.rel = "noopener";
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 30000);
  }

  async function triggerDownloadViaRuntime(html, filename, conflictAction) {
    if (!chrome?.runtime?.sendMessage) {
      throw new Error("runtime messaging not available");
    }

    const payload = {
      type: "chatgpt-export-download",
      html: String(html || ""),
      filename: String(filename || "chatgpt_dialog.html"),
      conflictAction: normalizeDownloadConflictAction(conflictAction)
    };

    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Runtime download communication failed"));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Runtime-Download failed"));
          return;
        }
        resolve(response);
      });
    });
  }

  function normalizeDownloadConflictAction(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "overwrite" || normalized === "prompt") {
      return normalized;
    }
    return "uniquify";
  }

  function buildFileName(title, date) {
    const safeTitle = sanitizeForFileName(title || "chatgpt_dialog");
    const datePart = formatDateForFileName(date);
    return safeTitle + "_" + datePart + ".html";
  }

  function buildBatchFileName(title, timestamp, index, totalCount) {
    const safeTitle = sanitizeForFileName(title || "chatgpt_dialog");
    const datePart = formatDateForFileName(timestamp || new Date());
    const width = String(Math.max(1, totalCount)).length;
    const ordinal = String(index).padStart(width, "0");
    return datePart + "_" + ordinal + "_" + safeTitle + ".html";
  }

  function buildBatchFolderPath({ accountName, yearOnlyFolder, date }) {
    const ts = date instanceof Date ? date : new Date();
    const year = String(ts.getFullYear());
    const month = String(ts.getMonth() + 1).padStart(2, "0");
    const safeAccount = resolveAccountNameForPath(accountName);
    const parts = [EXPORT_BASE_FOLDER_NAME, safeAccount, year];
    if (!yearOnlyFolder) {
      parts.push(month);
    }
    return parts.join("/");
  }

  function buildBatchAccountRootFolderPath(accountName) {
    const safeAccount = resolveAccountNameForPath(accountName);
    return [EXPORT_BASE_FOLDER_NAME, safeAccount].join("/");
  }

  function resolveAccountNameForPath(accountName) {
    const normalized = normalizeAccountNameCandidate(accountName || "");
    if (normalized && !/^unknown_account$/i.test(normalized)) {
      return sanitizePathSegment(normalized);
    }
    const resolved = resolveAccountNameForBatch();
    const safeResolved = sanitizePathSegment(resolved || "");
    if (safeResolved && !/^unknown_account$/i.test(safeResolved)) {
      return safeResolved;
    }
    return "Unknown_Account";
  }

  function buildDownloadFilenameWithSubdirectory(fileName, subdirectory) {
    const safeBase = sanitizeForFileName(fileName || "chatgpt_dialog");
    const safeFile = /\.html?$/i.test(safeBase) ? safeBase : (safeBase + ".html");
    const cleanDir = sanitizeDownloadSubdirectory(subdirectory || "");
    if (!cleanDir) {
      return safeFile;
    }
    return cleanDir + "/" + safeFile;
  }

  function sanitizeDownloadSubdirectory(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    const parts = raw
      .split(/[\\/]+/)
      .map((part) => sanitizePathSegment(part))
      .filter(Boolean);
    return parts.join("/");
  }

  function sanitizePathSegment(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/_+/g, "_")
      .replace(/^[\s_.-]+|[\s_.-]+$/g, "")
      .slice(0, 80);
    return cleaned || "Unknown_Account";
  }

  function uniquifyFileName(fileName, usedSet) {
    if (!usedSet.has(fileName)) {
      usedSet.add(fileName);
      return fileName;
    }

    const dotIndex = fileName.lastIndexOf(".");
    const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const ext = dotIndex > 0 ? fileName.slice(dotIndex) : "";
    let counter = 2;
    while (true) {
      const candidate = base + "_" + counter + ext;
      if (!usedSet.has(candidate)) {
        usedSet.add(candidate);
        return candidate;
      }
      counter += 1;
    }
  }

  function shortenTitle(value, maxChars) {
    const text = String(value || "").trim();
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "...";
  }

  function sanitizeForFileName(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_\s.]+|[_\s.]+$/g, "")
      .slice(0, 100);
    return cleaned || "chatgpt_dialog";
  }

  function formatDateForFileName(date) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return year + "-" + month + "-" + day + "_" + hours + "-" + minutes + "-" + seconds;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resolveAccountNameForBatch() {
    const fromDom = findAccountNameFromDom();
    if (fromDom) {
      persistLastAccountName(fromDom);
      return fromDom;
    }

    const cached = loadLastAccountName();
    if (cached) {
      return cached;
    }

    return "Unknown_Account";
  }

  function findAccountNameFromDom() {
    const selectorCandidates = [
      "[data-testid='accounts-profile-button']",
      "[data-testid='profile-button']",
      "[data-testid*='profile-button']",
      "[aria-label*='Profil'][data-testid*='profile']",
      "[aria-label*='Profile menu'][data-testid*='profile']",
      "[aria-label*='Account menu'][data-testid*='profile']",
      "[aria-label*='Profil-Menü öffnen']",
      "[aria-label*='Profil menu'][data-testid*='profile']",
      "[aria-label*='Open profile menu']",
      "[aria-label*='Open account menu']"
    ];

    const collected = [];
    selectorCandidates.forEach((selector) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      nodes.forEach((node) => {
        if (!node || isConversationOptionsButton(node)) {
          return;
        }
        const candidates = collectAccountNameTextCandidates(node);
        candidates.forEach((candidate) => {
          collected.push(candidate);
        });
      });
    });

    const ranked = collected
      .slice()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

    for (let i = 0; i < ranked.length; i += 1) {
      const candidate = normalizeAccountNameCandidate(ranked[i]?.text || "");
      if (candidate) {
        return candidate;
      }
    }

    return "";
  }

  function collectAccountNameTextCandidates(node) {
    const ordered = [];
    const seenScores = new Map();

    const pushCandidate = (value, baseScore) => {
      const text = sanitizeConversationTitle(value || "");
      if (!text) {
        return;
      }
      const key = text.toLowerCase();
      const score = scoreAccountNameCandidateText(text, baseScore);
      const previousIndex = ordered.findIndex((entry) => entry?.key === key);
      if (previousIndex >= 0) {
        if (score > Number(seenScores.get(key) || 0)) {
          seenScores.set(key, score);
          ordered[previousIndex] = { key, text, score };
        }
        return;
      }
      seenScores.set(key, score);
      ordered.push({ key, text, score });
    };

    Array.from(node.querySelectorAll("span,div,p,strong,b")).forEach((part) => {
      if (!part || part.children.length > 0) {
        return;
      }
      const text = sanitizeConversationTitle(part.textContent || "");
      if (!text || text.length > 120) {
        return;
      }
      pushCandidate(text, 90);
    });

    const innerText = sanitizeConversationTitle(node.innerText || "");
    if (innerText) {
      innerText.split(/\r?\n+/).forEach((line) => {
        pushCandidate(line, 70);
      });
      pushCandidate(innerText, 55);
    }

    pushCandidate(node.textContent || "", 45);
    pushCandidate(node.getAttribute("aria-label") || "", 20);
    pushCandidate(node.getAttribute("title") || "", 20);

    return ordered.map((entry) => ({
      text: entry.text,
      score: entry.score
    }));
  }

  function scoreAccountNameCandidateText(text, baseScore) {
    const normalized = sanitizeConversationTitle(text || "");
    if (!normalized) {
      return -999;
    }
    let score = Number(baseScore || 0);
    if (/@/.test(normalized)) {
      score += 20;
    }
    if (/\s/.test(normalized)) {
      score += 12;
    }
    if (/[a-z]/.test(normalized)) {
      score += 6;
    }
    if (normalized.length >= 4 && normalized.length <= 64) {
      score += 8;
    }
    if (/^[A-Z0-9]{1,3}$/.test(normalized)) {
      score -= 35;
    }
    if (/^(?:pro|plus|free|team|enterprise|business)$/i.test(normalized)) {
      score -= 45;
    }
    if (isBlockedAccountNameLabel(normalized)) {
      score -= 60;
    }
    return score;
  }

  function isConversationOptionsButton(node) {
    const testId = String(node.getAttribute("data-testid") || "").toLowerCase();
    if (/history-item-\d+-options/.test(testId)) {
      return true;
    }
    if (testId.includes("conversation-options-button")) {
      return true;
    }
    const className = String(node.className || "");
    if (className.includes("__menu-item-trailing-btn")) {
      return true;
    }
    const label = String(node.getAttribute("aria-label") || "");
    if (/gespr(?:\u00e4|ae)chsoptionen\s+\u00f6ffnen/i.test(label)) {
      return true;
    }
    if (/conversation\s+options/i.test(label)) {
      return true;
    }
    return false;
  }

  function isBlockedAccountNameLabel(value) {
    const label = sanitizeConversationTitle(value || "");
    if (!label) {
      return true;
    }
    const blockedPatterns = [
      /\bgespr(?:\u00e4|ae)chsoptionen\s+\u00f6ffnen\b/i,
      /\bconversation\s+options\b/i,
      /\bprofil(?:[-\s]*(?:men(?:\u00fc|ue)|menu))?\s+(?:\u00f6ffnen|oeffnen)\b/i,
      /\bopen\s+(?:profile|account)\s+menu\b/i,
      /\bmodellauswahl\b/i,
      /\bmodel\s+selection\b/i,
      /\bnew\s+chat\b/i,
      /\bneuer\s+chat\b/i
    ];
    return blockedPatterns.some((pattern) => pattern.test(label));
  }

  function normalizeAccountNameCandidate(value) {
    const raw = sanitizeConversationTitle(value || "");
    if (!raw) {
      return "";
    }
    if (isBlockedAccountNameLabel(raw)) {
      return "";
    }

    const cleaned = raw
      .replace(/\b(chatgpt|konto|account|menu|men(?:\u00fc|ue))\b/gi, "")
      .replace(/\b(profil|profile)\b/gi, "")
      .replace(/\b((?:\u00f6ffnen|oeffnen)|open)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned || cleaned.length < 2) {
      return "";
    }
    if (isBlockedAccountNameLabel(cleaned)) {
      return "";
    }
    if (/^[A-Z0-9]{1,3}$/.test(cleaned)) {
      return "";
    }
    if (/^(?:pro|plus|free|team|enterprise|business)$/i.test(cleaned)) {
      return "";
    }

    return sanitizePathSegment(cleaned);
  }

  function persistLastAccountName(name) {
    const normalized = normalizeAccountNameCandidate(name || "");
    if (!normalized || /^unknown_account$/i.test(normalized)) {
      return;
    }
    try {
      window.localStorage.setItem(BATCH_LAST_ACCOUNT_NAME_STORAGE_KEY, normalized);
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function loadLastAccountName() {
    try {
      const value = window.localStorage.getItem(BATCH_LAST_ACCOUNT_NAME_STORAGE_KEY);
      const normalized = normalizeAccountNameCandidate(value || "");
      if (!normalized || /^unknown_account$/i.test(normalized)) {
        return "";
      }
      return normalized;
    } catch (_error) {
      return "";
    }
  }

  function loadBatchYearFolderOnlyState() {
    try {
      return window.localStorage.getItem(BATCH_YEAR_FOLDER_ONLY_STORAGE_KEY) === "1";
    } catch (_error) {
      return false;
    }
  }

  function persistBatchYearFolderOnlyState(enabled) {
    try {
      if (enabled) {
        window.localStorage.setItem(BATCH_YEAR_FOLDER_ONLY_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(BATCH_YEAR_FOLDER_ONLY_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function loadBatchDebugLogState() {
    try {
      return window.localStorage.getItem(BATCH_DEBUG_LOG_STORAGE_KEY) === "1";
    } catch (_error) {
      return false;
    }
  }

  function persistBatchDebugLogState(enabled) {
    try {
      if (enabled) {
        window.localStorage.setItem(BATCH_DEBUG_LOG_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(BATCH_DEBUG_LOG_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function loadInlineToggleState() {
    try {
      return window.localStorage.getItem(INLINE_TS_STORAGE_KEY) === "1";
    } catch (_error) {
      return false;
    }
  }

  function persistInlineToggleState(enabled) {
    try {
      if (enabled) {
        window.localStorage.setItem(INLINE_TS_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(INLINE_TS_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage errors in private modes.
    }
  }

  async function waitForBatchVisibility({
    maxWaitMs,
    isCancelled,
    progressCallback,
    indexLabel,
    completedLabel
  }) {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      return true;
    }

    const startedAt = Date.now();
    let lastNoticeAt = 0;

    while (document.visibilityState === "hidden") {
      if (typeof isCancelled === "function" && isCancelled()) {
        throw createExportCancelledError();
      }

      const now = Date.now();
      if ((now - startedAt) >= Math.max(1000, Number(maxWaitMs) || BATCH_HIDDEN_WAIT_MAX_MS)) {
        return false;
      }

      if ((now - lastNoticeAt) >= BATCH_HIDDEN_NOTICE_MS) {
        const doneText = String(completedLabel || "").trim();
        const batchPart = indexLabel ? ("Batch " + indexLabel + " | ") : "Batch | ";
        const donePart = doneText ? (doneText + " completed: ") : "";
        if (typeof progressCallback === "function") {
          progressCallback(
            batchPart + donePart + "waiting: Keep the ChatGPT tab in the foreground...",
            "busy"
          );
        }
        lastNoticeAt = now;
      }

      await sleep(1000);
    }

    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();


