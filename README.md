# ChatGPT Thread Exporter

Chrome Extension (Manifest V3) that exports ChatGPT conversations to standalone HTML files for long-term backup and offline reading.

## Maintainer
- Author: Joel Aniol
- Contact: https://www.linkedin.com/in/joelaniol/

Note:
- Chrome MV3 does not use an `author` key in `manifest.json`, so maintainer metadata is documented here.

## What This Extension Does
- Exports the currently open ChatGPT thread as HTML.
- Supports batch export for many or all conversations.
- Keeps running even if individual conversations fail.
- Produces a failure report with reason code, title, conversation ID, and error details.
- Optionally writes a live debug checkpoint file while batch export is running.
- Embeds images in full source resolution for backup-grade exports.
- Adds click-to-open lightbox for images inside exported HTML.
- Handles slow/lazy sidebar loading with robust multi-pass scanning.

## Folder Layout
- Single export:
  - `Chat GPT/<filename>.html`
- Batch export (default):
  - `Chat GPT/<Account>/<Year>/<Month>/<filename>.html`
- Batch export (year-only toggle enabled):
  - `Chat GPT/<Account>/<Year>/<filename>.html`
- Live debug checkpoint (if enabled):
  - `Chat GPT/<Account>/Batch_Debug_Live_YYYY-MM-DD_HH-mm-ss.html`

## Popup Actions
- `Save`
- `Save Batch`
- `Resume Batch`
- `Stop Export`
- `Batch: year folders only`
- `Batch: live debug log (file)`

## How to Install
1. Download this project (ZIP) from GitHub.
2. Extract it to a local folder.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the extracted folder.

## Usage
1. Pin the extension in the Chrome toolbar.
2. Open a ChatGPT thread at `https://chatgpt.com/c/...`.
3. Refresh the page once after loading the extension.
4. Open the extension popup and run `Save` or `Save Batch`.
5. During batch export, keep the ChatGPT window/tab in the foreground.
6. Do not click, scroll, or switch tabs while batch export is running.

## Important Batch Note
Batch export can run for a long time, especially with large histories.
- Keep the tab visible (foreground).
- Avoid switching away, scrolling manually, or interacting during export.

## Privacy and Data Handling
- The extension runs locally in your browser.
- It reads conversation data from ChatGPT page/API responses and writes HTML to your Downloads folder.
- It does not include any external backend service in this repository.

## Failure Handling
- A single failed conversation does not stop the batch.
- Failures are collected and summarized.
- Reason classification helps diagnose common issues such as:
  - thread not found
  - empty/no-content captures
  - download/storage failures
  - API/network timeouts

## Troubleshooting
- `Unknown_Account` folder:
  - Reload extension and ChatGPT tab, then start batch again.
  - Ensure you are logged in and the sidebar profile block is visible.
- Batch appears to stop early:
  - Keep tab in foreground and wait; lazy loading may take time.
- One thread exports manually but not in batch:
  - Check final failure report and live debug checkpoint for `reasonCode` and error text.

## Project Structure
- `manifest.json` - MV3 manifest and permissions
- `content.js` - page logic, export pipeline, batch orchestration
- `background.js` - download bridge/service worker
- `popup.html`, `popup.css`, `popup.js` - extension UI
- `page-bridge.js` - bridge for capturing page-level payloads
- `icons/` - extension icons

## Versioning (Chrome Requirements)
- `manifest_version` remains `3`.
- `version` must be numeric and dot-separated (`1` to `4` parts).
- Each numeric part must be `0..65535`.
- Do not use suffixes in `version` (`-beta`, `+build`, `rc1`, etc.).
- Optional: use `version_name` for human-readable labels.

## Recommended Release Strategy
- Patch (`x.y.Z`): bug fixes only.
- Minor (`x.Y.0`): backward-compatible features.
- Major (`X.0.0`): breaking changes.

## Release Checklist
1. Bump `version` in `manifest.json` (and `version_name` if used).
2. Update README/changelog.
3. Reload extension and run smoke tests:
   - single export
   - batch start/resume/stop
   - failure report + live debug checkpoint
   - image embedding + lightbox in exported HTML
4. Package for release.
