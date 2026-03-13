const blobUrlByRequestId = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "chatgpt-export-offscreen-create-blob-url") {
    try {
      const requestId = String(message.requestId || "").trim();
      const content = typeof message.content === "string"
        ? message.content
        : String(message.html || "");
      const mimeType = normalizeMimeType(message.mimeType);

      if (!requestId) {
        sendResponse({ ok: false, error: "Missing request id." });
        return false;
      }
      if (!content) {
        sendResponse({ ok: false, error: "Empty export content." });
        return false;
      }

      revokeBlobUrl(requestId);

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      blobUrlByRequestId.set(requestId, url);
      sendResponse({ ok: true, requestId, url });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || "Could not create blob URL."
      });
    }
    return false;
  }

  if (message.type === "chatgpt-export-offscreen-revoke-blob-url") {
    const requestId = String(message.requestId || "").trim();
    if (!requestId) {
      sendResponse({ ok: false, error: "Missing request id." });
      return false;
    }

    revokeBlobUrl(requestId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

window.addEventListener("pagehide", () => {
  revokeAllBlobUrls();
});

function revokeBlobUrl(requestId) {
  const existingUrl = blobUrlByRequestId.get(requestId);
  if (!existingUrl) {
    return;
  }
  URL.revokeObjectURL(existingUrl);
  blobUrlByRequestId.delete(requestId);
}

function revokeAllBlobUrls() {
  for (const requestId of blobUrlByRequestId.keys()) {
    revokeBlobUrl(requestId);
  }
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
