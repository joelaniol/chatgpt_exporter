(function initChatGptExportPageBridge() {
  const BRIDGE_STATE_KEY = "__chatgptExportPageBridgeState__";
  const previousState = window[BRIDGE_STATE_KEY];
  if (previousState && typeof previousState.cleanup === "function") {
    try {
      previousState.cleanup();
    } catch (_error) {
      // Best effort cleanup of a stale bridge instance.
    }
  }

  const script = document.currentScript;
  const token = script?.dataset?.token || "";
  const requestType = script?.dataset?.requestType || "chatgpt-export-bridge-request";
  const responseType = script?.dataset?.responseType || "chatgpt-export-bridge-response";
  const payloadType = script?.dataset?.payloadType || "chatgpt-export-bridge-conversation-payload";
  const MAX_CAPTURED_JSON_BYTES = 14 * 1024 * 1024;
  const conversationPathPattern = /^\/backend-api\/conversations?\/([0-9a-zA-Z_-]{8,})\/?$/i;
  const backendApiPattern = /^\/backend-api\//;
  const state = {
    token,
    requestType,
    responseType,
    payloadType,
    originalFetch: null,
    patchedFetch: null,
    messageHandler: null,
    cleanup: null
  };

  window.__chatgptExportPageBridgeInstalled__ = true;
  window[BRIDGE_STATE_KEY] = state;

  installConversationFetchTap();

  state.messageHandler = async (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.type !== requestType) {
      return;
    }
    if (data.token !== token) {
      return;
    }

    const requestId = String(data.requestId || "");
    const url = String(data.url || "");
    const options = data.options && typeof data.options === "object" ? data.options : {};

    if (!requestId || !url) {
      window.postMessage({
        type: responseType,
        token,
        requestId,
        ok: false,
        status: 0,
        statusText: "",
        error: "Invalid bridge request data"
      }, "*");
      return;
    }

    try {
      const mergedHeaders = Object.assign({}, options.headers || {});
      if (isBackendApiUrl(url) && !mergedHeaders["Authorization"] && !mergedHeaders["authorization"]) {
        const bearerToken = resolveAccessToken();
        if (bearerToken) {
          mergedHeaders["Authorization"] = "Bearer " + bearerToken;
        }
      }

      const response = await fetch(url, {
        method: options.method || "GET",
        credentials: options.credentials || "include",
        headers: mergedHeaders,
        body: typeof options.body === "string" ? options.body : undefined
      });

      const rawText = await response.text();
      let body = null;
      let parseError = false;

      if (rawText && rawText.trim() !== "") {
        try {
          body = JSON.parse(rawText);
        } catch (_error) {
          parseError = true;
        }
      }

      window.postMessage({
        type: responseType,
        token,
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body,
        parseError
      }, "*");
    } catch (error) {
      window.postMessage({
        type: responseType,
        token,
        requestId,
        ok: false,
        status: 0,
        statusText: "",
        error: String(error?.message || error)
      }, "*");
    }
  };

  window.addEventListener("message", state.messageHandler);

  state.cleanup = () => {
    if (state.messageHandler) {
      window.removeEventListener("message", state.messageHandler);
    }

    if (state.patchedFetch && state.originalFetch && window.fetch === state.patchedFetch) {
      window.fetch = state.originalFetch;
    }

    if (window[BRIDGE_STATE_KEY] === state) {
      delete window[BRIDGE_STATE_KEY];
    }
    window.__chatgptExportPageBridgeInstalled__ = false;
    window.__chatgptExportConversationTapInstalled__ = false;
  };

  function installConversationFetchTap() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }
    state.originalFetch = originalFetch;
    window.__chatgptExportConversationTapInstalled__ = true;

    state.patchedFetch = function patchedChatgptExportFetch(input, init) {
      const requestedUrl = resolveRequestUrl(input);
      const fetchPromise = originalFetch.call(this, input, init);

      if (isConversationPayloadRequestUrl(requestedUrl)) {
        fetchPromise
          .then((response) => {
            void captureConversationPayloadFromResponse(response, requestedUrl);
          })
          .catch(() => {});
      }

      return fetchPromise;
    };

    window.fetch = state.patchedFetch;
  }

  function resolveRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.url === "string") {
      return input.url;
    }
    return "";
  }

  function isConversationPayloadRequestUrl(url) {
    const absolute = toAbsoluteUrl(url);
    if (!absolute) {
      return false;
    }
    return conversationPathPattern.test(absolute.pathname);
  }

  function extractConversationIdFromRequestUrl(url) {
    const absolute = toAbsoluteUrl(url);
    if (!absolute) {
      return "";
    }
    const match = absolute.pathname.match(conversationPathPattern);
    return match ? String(match[1] || "") : "";
  }

  function toAbsoluteUrl(url) {
    if (!url) {
      return null;
    }
    try {
      return new URL(url, window.location.origin);
    } catch (_error) {
      return null;
    }
  }

  async function captureConversationPayloadFromResponse(response, requestedUrl) {
    if (!response || !response.ok) {
      return;
    }

    const conversationId = extractConversationIdFromRequestUrl(requestedUrl);
    if (!conversationId) {
      return;
    }

    try {
      const cloned = response.clone();
      const text = await cloned.text();
      if (!text || text.length > MAX_CAPTURED_JSON_BYTES) {
        return;
      }

      let body = null;
      try {
        body = JSON.parse(text);
      } catch (_error) {
        return;
      }

      const summary = buildTimestampSummaryFromConversationPayload(body, conversationId);
      if (!summary || summary.timestamps.length === 0) {
        return;
      }

      window.postMessage({
        type: payloadType,
        token,
        conversationId: summary.conversationId,
        title: summary.title,
        timestamps: summary.timestamps
      }, "*");
    } catch (_error) {
      // Ignore capture issues; bridge fetch flow must remain unaffected.
    }
  }

  function buildTimestampSummaryFromConversationPayload(payload, fallbackConversationId) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const mapping = payload.mapping;
    if (!mapping || typeof mapping !== "object") {
      return null;
    }

    const timestamps = [];
    const nodes = Object.values(mapping);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const message = node?.message;
      if (!message || typeof message !== "object") {
        continue;
      }

      const ids = collectTimestampAliasKeys([
        message?.id,
        node?.id
      ]);
      if (ids.length === 0) {
        continue;
      }

      const createTime = message.create_time;
      const updateTime = message.update_time;
      if (createTime == null && updateTime == null) {
        continue;
      }

      timestamps.push({
        ids,
        create_time: createTime,
        update_time: updateTime
      });
    }

    return {
      conversationId: String(payload.conversation_id || fallbackConversationId || "").trim(),
      title: String(payload.title || "").trim(),
      timestamps
    };
  }

  function isBackendApiUrl(url) {
    const absolute = toAbsoluteUrl(url);
    if (!absolute) {
      return false;
    }
    return backendApiPattern.test(absolute.pathname);
  }

  function resolveAccessToken() {
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (let i = 0; i < scripts.length; i += 1) {
        const text = scripts[i].textContent || "";
        if (!text.includes("accessToken")) {
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          const accessToken = parsed?.session?.accessToken;
          if (typeof accessToken === "string" && accessToken.length > 0) {
            return accessToken;
          }
        } catch (_parseError) {
          // Continue to next script.
        }
      }
    } catch (_error) {
      // Token extraction is best-effort.
    }
    return "";
  }

  function collectTimestampAliasKeys(rawCandidates) {
    const keys = [];
    const seen = new Set();
    const queue = Array.isArray(rawCandidates) ? rawCandidates : [rawCandidates];

    const pushKey = (value) => {
      const normalized = String(value || "").trim();
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      keys.push(normalized);
    };

    queue.forEach((candidate) => {
      if (Array.isArray(candidate)) {
        candidate.forEach(pushKey);
        return;
      }
      pushKey(candidate);
    });

    return keys;
  }
})();
