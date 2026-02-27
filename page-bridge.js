(function initChatGptExportPageBridge() {
  if (window.__chatgptExportPageBridgeInstalled__) {
    return;
  }
  window.__chatgptExportPageBridgeInstalled__ = true;

  const script = document.currentScript;
  const token = script?.dataset?.token || "";
  const requestType = script?.dataset?.requestType || "chatgpt-export-bridge-request";
  const responseType = script?.dataset?.responseType || "chatgpt-export-bridge-response";
  const payloadType = script?.dataset?.payloadType || "chatgpt-export-bridge-conversation-payload";
  const MAX_CAPTURED_JSON_BYTES = 14 * 1024 * 1024;
  const conversationPathPattern = /^\/backend-api\/conversations?\/([0-9a-zA-Z_-]{8,})\/?$/i;

  installConversationFetchTap();

  window.addEventListener("message", async (event) => {
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
        error: "ungueltige bridge request daten"
      }, "*");
      return;
    }

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        credentials: options.credentials || "include",
        headers: options.headers || {},
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
  });

  function installConversationFetchTap() {
    if (window.__chatgptExportConversationTapInstalled__) {
      return;
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }
    window.__chatgptExportConversationTapInstalled__ = true;

    window.fetch = function patchedChatgptExportFetch(input, init) {
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

      const id = String(message.id || node.id || "").trim();
      if (!id) {
        continue;
      }

      const createTime = message.create_time;
      const updateTime = message.update_time;
      if (createTime == null && updateTime == null) {
        continue;
      }

      timestamps.push({
        id,
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
})();
