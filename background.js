chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "chatgpt-export-download") {
    return false;
  }

  const html = String(message.html || "");
  const filename = String(message.filename || "chatgpt_dialog.html");
  const conflictAction = normalizeConflictAction(message.conflictAction);

  if (!html) {
    sendResponse({ ok: false, error: "Leerer Export-Inhalt." });
    return false;
  }

  const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);

  chrome.downloads.download(
    {
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction
    },
    (downloadId) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        sendResponse({
          ok: false,
          error: runtimeError.message || "Download fehlgeschlagen"
        });
        return;
      }
      if (typeof downloadId !== "number") {
        sendResponse({ ok: false, error: "Download konnte nicht gestartet werden" });
        return;
      }
      sendResponse({ ok: true, downloadId });
    }
  );

  return true;
});

function normalizeConflictAction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "overwrite" || normalized === "prompt") {
    return normalized;
  }
  return "uniquify";
}
