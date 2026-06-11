# Detect / Task Creation Handoff

Last updated: 2026-06-05

This document summarizes the current state of the `octopus detect` workstream. The immediate product goal is to let users create runnable local collection tasks from a webpage, especially search-result tasks, with a browser-first manual flow that feels close to the desktop client.

## Current Product Shape

There are three task-creation paths.

### 1. Manual Selection

Command:

```bash
octopus detect "https://www.csdn.net/" --manual --query openai --output task.json
```

Equivalent local dev command:

```bash
node dist/index.js detect "https://www.csdn.net/" --manual --query openai --output task.json
```

Behavior:

- Opens the extension browser.
- Uses protected SmartProxy detection by default.
- Uses browser overlay controls for the `--manual` workflow, with CLI menus retained as fallback.
- Lets the user confirm login/verification state in the browser.
- Lets the user confirm search input fields and manually pick the search submit button.
- Records the search submit click into the generated task.
- Shows one detected candidate region at a time, similar to the desktop client result switcher.
- Lets the user switch candidates and confirm the highlighted data region.
- Lets the user confirm pagination as next-page, load-more, scroll, or single-page.
- If a list item has a URL field, lets the user choose list-only, list + detail, or detail-only tasks.
- Can save browser session references for later runs.

Design decisions:

- Manual means the user controls final selection.
- `--manual` should use the protected detection result, not the old heuristic detector.
- `--legacy-detector` exists only for debugging the previous detector.
- Browser overlay is the primary UX for `--manual`; terminal prompts should only be fallback.

### 2. Deterministic Auto-Detection

Command:

```bash
octopus detect "https://news.qq.com/" --auto --output task.json
```

Optional goal:

```bash
octopus detect "https://news.qq.com/" --auto --goal "采集新闻标题、链接和详情正文" --output task.json
```

Behavior:

- Runs protected SmartProxy page detection.
- Ranks candidate regions.
- Chooses the recommended candidate and generates a task.
- Supports repeated cards, search/list results, tables, link collections, detail pages, forms, popup dismissal, search input/submit, next-page, load-more, scroll pagination, and list + detail runtime plans.

Current auto selection:

- `--auto` chooses the recommended candidate from detection output.
- The recommendation is based on protected SmartProxy candidate ordering plus CLI-side ranking/layout checks.
- It is not simply "choose the first DOM node"; it chooses the best detected candidate.

### 3. External LLM/Agent-Assisted Planning

The CLI does not embed an LLM. It exposes deterministic context for an external LLM/Agent to inspect and decide.

Preferred agent discovery:

```bash
octopus capabilities --json
```

The machine-readable contract is:

```text
machineContract.recipes.createTaskFromUrlWithAgent
```

The user should be able to say:

```text
请用 bazhuayu-cli 给这个网页创建一个采集任务: <url>
```

The agent should then discover and follow the workflow itself. The user should not need to explain `--prepare-agent`, `--preview-agent-plan`, or `--apply-agent-plan`.

Agent result validation should follow `context.resultValidationPolicy`: isolated missing fields in ads, sponsored cards, topic blocks, recommendation modules, or other heterogeneous list rows are normal partial data. Do not recreate tasks in a loop unless the evidence shows a systematic structural failure such as the wrong region, wrong search result page, wrong pagination, or core fields missing for most representative rows.

Low-level workflow:

```bash
octopus detect "<url>" --prepare-agent --json --goal "<user task description>" --output context.json
octopus detect --preview-agent-plan plan.json --agent-context context.json --json
octopus detect --apply-agent-plan plan.json --agent-context context.json --output task.json --json
octopus task validate <taskId> --task-file task.json --json
```

One-shot wrapper:

```bash
octopus detect "<url>" --agent --agent-command "<cmd>" --output task.json
```

Notes:

- The plan is an internal agent/CLI contract.
- Users should not hand-write the plan.
- `--agent-command` executes a local shell command; only pass a trusted agent runner.
- In one-shot `--agent` mode, temporary `context.json` and `plan.json` are cleaned up by default.
- Use `--keep-agent-files` only for debugging/audit.

## Latest Manual Search / Overlay Fixes

The most recent work focused on `src/runtime/detector/page-detector.ts`.

### Browser Overlay UX

Current overlay behavior:

- Default position is left-side, not centered over page content.
- Overlay is draggable by its header.
- Position is persisted in `window.__octopusManualOverlayPosition`.
- The overlay host uses `data-octopus-manual-overlay="true"`.
- The same host is reused with `shadowRoot.replaceChildren(...)` instead of remove/recreate on every render.
- Buttons switch immediately to disabled loading state, with visible status text such as `处理中...`.
- Overlay `z-index` is above detection/pagination/detail markings.
- Selection state (`selectedXPath`, `selectedText`) is preserved across overlay re-renders.
- CLI hints are deduped by workflow stage through `writeManualOverlayHintOnce(...)`.
- Overlay drag and button clicks stop propagation so page-level pickers do not treat them as page clicks.

Important bug fixes:

- Dragging the overlay no longer resets selected content.
- Dragging/clicking the overlay no longer causes repeated CLI lines such as `请在浏览器悬浮框中确认检测结果`.
- Clicking overlay buttons no longer leaks into the underlying search/pagination/detail pick layers.
- The overlay no longer disappears between "confirm candidate" and "confirm pagination". It now switches to a progress state.
- The overlay no longer disappears between "confirm pagination" and the next step. It switches to `正在继续生成任务`.
- Progress overlays with no buttons no longer render an empty actions area.

### Manual Search Creation Flow

The intended manual search flow is:

1. Confirm login/verification state if needed.
2. Confirm or pick the search input field.
3. Fill the query into the selected input field.
4. Ask the user to click the real search submit button in the browser overlay.
5. Record the clicked submit button XPath.
6. Replay the submit click for real.
7. Adopt the best search-result page or newly opened search-result tab.
8. Detect list data on the result page.
9. Generate a task that includes both search input and search submit actions before extraction.

Important fixes already made:

- `detectPage(...)` manual search now calls `submitInputsManually(...)`.
- Manual mode no longer uses the old auto-submit/geometry/Enter fallback before the user confirms the search button.
- Removed the earlier refresh-style fallback that could return to the original entry page and ask for the search button late.
- Search input filling is split into `inputSearchFieldsOnly(...)`.
- Search submit selection is handled by `chooseSearchSubmitButtonInBrowserOrCli(...)`.
- Search submit click is replayed through `clickRecordedSearchSubmit(...)`.
- Search result page adoption uses new/best page scoring so sites like CSDN can open search results in a new tab after login.
- Search result scoring should prefer `so.csdn.net/so/search?...` over entry pages and article pages.
- Tests cover that article suggestion links are ignored and the real search button is selected.

Known command used during debugging:

```bash
node dist/index.js detect "https://www.csdn.net/" --manual --query openai
```

If this regresses, inspect:

- `submitInputsManually(...)`
- `chooseSearchSubmitButtonInBrowserOrCli(...)`
- `showSearchSubmitPickerInBrowser(...)`
- `waitForSearchSubmitOverlayAction(...)`
- `clickRecordedSearchSubmit(...)`
- `adoptBestPageAfterSearch(...)`
- `scoreSearchResultPage(...)`

### Pagination Detection And Manual Pagination UX

The current pagination behavior combines page probing and manual confirmation.

Detection:

- `autoScroll(...)` probes the page before detection.
- The scroll probe records growth signals, content height, repeated item count, active load-more text, and active load-more XPath.
- `detectPaginationForCandidates(...)` uses the probe to distinguish scroll, load-more, and next-page options.
- If a load-more button only appears after scrolling, the chosen pagination can be `load_more` with `revealByScroll: true`.
- Card-internal next links and horizontal carousel/filter arrows should not be treated as page pagination.

Manual confirmation:

- `choosePaginationInteractively(...)` installs orange PAGE/MORE/SCROLL markers.
- Browser overlay asks the user to confirm the recommended pagination or choose single-page.
- SCROLL is a page mode, not a real button. It should not be cleared by arbitrary page clicks.

Important bug fixes:

- The SCROLL marker was previously attached to `documentElement` / `scrollingElement`; every page click had `html` in its composed path and could accidentally toggle scroll off. This caused the overlay to change from `滚动加载` to `单页采集` after clicking confirm.
- Pagination clicks now ignore any composed path that includes `data-octopus-manual-overlay="true"`.
- Clicking the same pagination option no longer clears selection. Explicit single-page selection must come from the overlay's `按单页采集` button.
- Confirming candidate selection now leaves a progress overlay visible while pagination is being detected.
- If no pagination option is detected, the overlay is updated to `未检测到翻页设置` and the workflow continues as single-page instead of going blank.

If pagination regresses, inspect:

- `autoScroll(...)`
- `captureScrollProbeSnapshot(...)`
- `scrollProbePaginationForCandidates(...)`
- `detectInteractivePaginationOptions(...)`
- `detectPaginationForCandidates(...)`
- `preferredPagination(...)`
- `choosePaginationInteractively(...)`
- `installPaginationOverlay(...)`
- `waitForPaginationManualAction(...)`

### Candidate / Detail Selection Overlay

Candidate selection:

- `installCandidateOverlay(...)` draws the current candidate region and field previews.
- `showCandidateChoiceInBrowser(...)` renders the manual overlay.
- `waitForCandidateManualAction(...)` watches both page selection and overlay buttons.
- After confirming a candidate, the overlay changes to `正在分析翻页设置` until pagination choices are ready.

Detail flow:

- If the selected list candidate has a URL field, `chooseDetailModeInteractively(...)` asks for list-only, list + detail, or detail-only.
- Manual detail sampling opens one detail page and installs a detail field overlay.
- `showDetailFieldChoiceInBrowser(...)` lets users confirm selected detail fields.
- Detail field overlay clicks also ignore the manual overlay host.

Known limitation:

- Real browser drag/click interactions are difficult to cover with the current fake DOM unit tests. Keep doing at least one real manual browser smoke test for CSDN and one scroll-feed site after touching overlay event code.

## Protected SmartProxy Runtime

Detection uses the protected desktop SmartProxy capability by default.

Runtime behavior:

- Fetches `/api/user/serverKey`.
- Uses the bundled private native module `@octopus/octopus-protect`.
- Fetches encrypted Smart resources:
  - `orz.g.zh.1.2.3`
  - `odc.f.zh.1.2.3`
- Decrypts resources in memory.
- Executes SmartProxy in the browser isolated realm.
- Does not write decrypted SmartProxy or ODC sources to disk.
- Does not write decrypted algorithm code into generated task files.

Security rules:

- Do not commit decrypted SmartProxy resources.
- Do not commit native protect package source/binaries under `vendor/`.
- Do not hardcode local development paths in runtime code.
- Keep protected detection behind authenticated API/resource access.

## Package / Publish Model

The project uses pack-time injection for the private protect package.

Source repository:

- Does not contain `vendor/octopus-protect`.
- Does not depend on a local file dependency for `@octopus/octopus-protect`.

Publish/pack flow:

```bash
OCTOPUS_PROTECT_SOURCE_DIR=/Users/rocosen/Documents/GitHub/octopus/src/shared/octopus-protect npm pack
```

or:

```bash
OCTOPUS_PROTECT_SOURCE_DIR=/Users/rocosen/Documents/GitHub/octopus/src/shared/octopus-protect npm publish
```

Scripts:

- `scripts/prepare-package-bundle.mjs`
- `scripts/restore-package-after-pack.mjs`

Behavior:

- `prepack` copies the private protect package into `node_modules/@octopus/octopus-protect`.
- `prepack` temporarily injects the dependency into the package manifest.
- `prepack` backs up root and nested package manifests plus nested dependency directories under `.package.prepack-backup/`.
- `postpack` restores the source `package.json`, nested package manifests, and any nested dependency directories removed for the tarball.
- Published tarballs bundle the protect native package.
- Git source remains free of committed private protect binaries.

## Files Of Interest

Detection command and contracts:

- `src/commands/detect.ts`
- `src/commands/capabilities.ts`
- `src/cli/help.ts`
- `src/index.ts`
- `src/types.ts`

Runtime:

- `src/runtime/detector/page-detector.ts`
- `src/runtime/detector/protected-smart.ts`
- `src/runtime/detector/xml.ts`
- `src/runtime/browser-session.ts`
- `src/runtime/task-definition-provider.ts`
- `src/runtime/api-client.ts`
- `src/commands/run.ts`

Package scripts:

- `scripts/prepare-package-bundle.mjs`
- `scripts/restore-package-after-pack.mjs`

Tests:

- `test/detector.test.mjs`
- `test/cli-contract.test.mjs`

## Verification Commands

Run these after touching detection behavior:

```bash
npm run typecheck
npm run build
node --test --test-concurrency=1 test/detector.test.mjs
```

Run this when command contract, help text, task provider, or CLI options change:

```bash
node --test --test-concurrency=1 test/cli-contract.test.mjs
```

Latest verification on 2026-06-05:

- `npm run typecheck`: passed
- `npm run build`: passed
- `node --test --test-concurrency=1 test/detector.test.mjs`: passed, 45 tests

Not rerun in the latest overlay pass:

- `node --test --test-concurrency=1 test/cli-contract.test.mjs`

Earlier status:

- `test/cli-contract.test.mjs` has passed previously, with one OAuth local-listen skip when the sandbox cannot bind a callback port.

## Debugging Checklist

If the search button is not clicked:

- Confirm manual mode uses `submitInputsManually(...)`.
- Confirm input is filled by `inputSearchFieldsOnly(...)`.
- Confirm `showSearchSubmitPickerInBrowser(...)` got a selected XPath.
- Confirm `clickRecordedSearchSubmit(...)` uses the selected XPath and records `searchPlan.submit`.
- Inspect generated task XML for input action followed by search click before extraction.

If CSDN opens an article instead of search results:

- Inspect search submit selection scoring.
- Confirm article suggestion links are not selected.
- Inspect `scoreSearchResultPage(...)` and `pageLooksLikeSearchResult(...)`.
- Confirm new tab adoption prefers search URL/title/content over article URL/title/content.

If detection runs on the original page after login:

- Inspect `watchNewPage(...)`, `adoptNewSearchPage(...)`, and `adoptBestPageAfterSearch(...)`.
- Confirm the result tab is brought to front and `host.page` is refreshed.
- Compare scores for entry page, article page, and result page.

If the overlay disappears after clicking a manual button:

- Check for a `finally { await removeManualOverlay(...) }` in the current workflow step.
- If the next step has expensive detection, show `showManualProgressOverlay(...)` before returning.
- Do not remove the overlay between candidate confirmation and pagination detection.
- Do not remove the overlay between pagination confirmation and the next step unless the workflow is actually done or canceled.

If CLI repeatedly prints overlay hints:

- Check `writeManualOverlayHintOnce(...)`.
- Hints are deduped by workflow stage key, not URL.
- Do not add direct `runtimeConsole.writeStderr(...)` calls for browser overlay prompts unless it is a true fallback path.

If SCROLL changes to single-page unexpectedly:

- Confirm `installPaginationOverlay(...)` ignores composed paths containing the manual overlay host.
- Confirm clicking the same pagination key does not clear `selectedKey`.
- Only the overlay `按单页采集` button should switch to single-page.

If dragging the overlay resets state:

- Confirm `showManualOverlay(...)` reuses the existing host.
- Confirm it preserves `__octopusManualOverlayState.selectedXPath` and `selectedText`.
- Confirm pointer/click events on the overlay stop propagation.

## Current Cleanup Note

Generated task/export artifacts should not be committed:

- `detected_*.json`
- `*-agent-plan.json`
- `*-task.json` generated during local testing
- `Detected *.xlsx`

`DETECT_HANDOFF.md` should stay in the workspace as the ongoing implementation handoff.

## Current Worktree Note

At the time of this handoff, the repository contains many existing modified and untracked files. Do not assume they are all from the current overlay fixes. In particular, detection-related files are still untracked in git status:

- `DETECT_HANDOFF.md`
- `src/commands/detect.ts`
- `src/runtime/browser-session.ts`
- `src/runtime/detector/`
- `test/detector.test.mjs`

Avoid reverting unrelated changes. Use focused diffs and tests.
