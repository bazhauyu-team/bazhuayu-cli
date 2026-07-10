import prompts from 'prompts';
import type { Browser, Page } from 'puppeteer-core';
import type { DetectedSearchPlan, DetectOptions } from './types.js';
import type {
  ManualOverlayAction,
  ManualOverlayChoice,
  SearchInputCandidate,
  SearchSubmitButton,
  SearchSubmitInputRef,
  SuppressedRuntimeConsole,
  ExtensionCommandResponse
} from './page-detector-shared.js';
import {
  clearManualOverlayAction,
  installSearchSubmitPickerOverlay,
  readManualOverlaySelection,
  readSearchSubmitPickerSelection,
  removeManualOverlay,
  removeSearchSubmitPickerOverlay,
  runLiveSelectMenu,
  showManualOverlay,
  waitForManualOverlayAction,
  writeManualOverlayHintOnce
} from './page-detector-overlay.js';
import { delay, truncateText } from './page-detector-utils.js';
import { waitForPageSettled } from './page-detector-scroll.js';
import {
  findInputXPath,
  searchInputNeedsDomEntry,
  setSearchInputValueByDom,
  findSearchInputCandidates,
  searchInputCandidateLabel,
  clickSubmit,
  clickRecordedSearchSubmit,
  debugSearchSubmitDecision,
  clickSearchSubmitByGeometry,
  pageHasSearchLoginGate,
  searchSubmitSnapshot
} from './page-detector-search.js';
import {
  adoptBestPageForSearchInput,
  adoptBestPageAfterSearch,
  adoptNewSearchPage,
  watchNewPage,
  pageLooksLikeSearchResult,
  scoreSearchResultPage
} from './page-detector-page-scoring.js';

/** Host surface for search submit / multi-tab adoption. */
export interface SearchFlowHost {
  page: Page;
  browser(): Browser | undefined;
  usePage(page: Page): Promise<void>;
  refreshTabId(): Promise<number>;
  command(command: Record<string, unknown>): Promise<ExtensionCommandResponse>;
}

export async function submitInputsManually(
  host: SearchFlowHost,
  options: DetectOptions,
  runtimeConsole: SuppressedRuntimeConsole,
  inputOverrides?: Map<string, SearchInputCandidate>
): Promise<DetectedSearchPlan | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return submitInputs(host, options, inputOverrides);
  runtimeConsole.restore();
  try {
    await showManualOverlay(host.page, {
      title: '正在填写搜索关键词',
      message: '已确认页面状态，正在把关键词输入到搜索框。',
      status: Object.entries(options.input ?? {}).map(([name, value]) => `${name}: ${value}`).join('  '),
      choices: [
        { title: '正在处理...', value: 'wait', primary: true }
      ]
    }).catch(() => undefined);
    const replayed = await inputSearchFieldsOnly(host, options, inputOverrides);
    if (!replayed?.inputs.length) return undefined;
    const selected = await chooseSearchSubmitButtonInBrowserOrCli(host.page, replayed.inputs, runtimeConsole);
    if (!selected?.xpath) throw new Error('用户取消了搜索按钮确认');
    await showManualOverlay(host.page, {
      title: '正在提交搜索',
      message: '已记录搜索按钮，正在执行搜索并等待结果页。',
      status: selected.text ? `按钮: ${truncateText(selected.text, 24)}` : `按钮: ${selected.xpath}`,
      choices: [
        { title: '正在处理...', value: 'wait', primary: true }
      ],
      selectedXPath: selected.xpath,
      selectedText: selected.text,
      highlightXPaths: replayed.inputs.map((input) => input.xpath)
    }).catch(() => undefined);
    const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
    const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
    const clicked = await clickRecordedSearchSubmit(host, selected, options.timeoutMs, replayed.inputs).catch(() => selected);
    await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
    await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
    await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
    await waitForPageSettled(host.page, options.waitMs);
    await removeManualOverlay(host.page).catch(() => undefined);
    if (!await pageLooksLikeSearchResult(host.page, options).catch(() => false) && !await pageHasSearchLoginGate(host.page).catch(() => false)) {
      throw new Error('搜索后没有进入当前关键词的结果页。请确认搜索按钮是否正确，或直接传入搜索结果页 URL 后重试。');
    }
    return {
      ...replayed,
      finalUrl: host.page.url(),
      submit: { mode: 'click', xpath: clicked?.xpath || selected.xpath, ...(clicked?.text || selected.text ? { text: clicked?.text || selected.text } : {}) }
    };
  } finally {
    await removeManualOverlay(host.page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

export async function chooseSearchSubmitButtonInBrowserOrCli(
  page: Page,
  inputs: SearchSubmitInputRef[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<SearchSubmitButton | undefined> {
  const browserOverlayReady = await showSearchSubmitPickerInBrowser(page, inputs, undefined, runtimeConsole)
    .then(() => true)
    .catch(() => false);
  let selected: SearchSubmitButton | undefined;
  while (true) {
    const overlay = browserOverlayReady
      ? await waitForSearchSubmitOverlayAction(page, inputs, selected, runtimeConsole).catch(() => undefined)
      : undefined;
    const cli = overlay ? undefined : await chooseSearchSubmitInCli(page, inputs, selected, runtimeConsole).catch(() => undefined);
    const action = overlay?.action ?? cli?.action;
    selected = overlay?.selected ?? cli?.selected ?? selected ?? await searchSubmitButtonFromManualOverlay(page).catch(() => undefined);
    if (action === 'wait') {
      if (browserOverlayReady) await showSearchSubmitPickerInBrowser(page, inputs, selected, runtimeConsole);
      continue;
    }
    if (action === 'cancel' || !action) return undefined;
    if (selected?.xpath) return selected;
  }
}

export async function showSearchSubmitPickerInBrowser(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'search-submit', '\n请在浏览器悬浮框中点击并确认搜索按钮。\n');
  await showManualOverlay(page, {
    title: '点击搜索按钮',
    message: [
      '关键词已输入。请点击页面上的搜索按钮；本次点击只记录按钮，不会立即跳转。',
      '选中后点击“确认并执行搜索”。'
    ].join('\n'),
    status: selected?.xpath ? `当前已选: ${selected.xpath}${selected.text ? ` (${truncateText(selected.text, 24)})` : ''}` : '当前已选: 未选择',
    choices: [
      { title: selected?.xpath ? '确认并执行搜索' : '等待点选搜索按钮', value: selected?.xpath ? 'confirm' : 'wait', primary: Boolean(selected?.xpath) },
      { title: '继续点选页面上的搜索按钮', value: 'wait' },
      { title: '取消搜索检测', value: 'cancel' }
    ],
    selectedXPath: selected?.xpath,
    selectedText: selected?.text,
    highlightXPaths: inputs.map((input) => input.xpath),
    mode: 'pick-search-submit',
    inputXPaths: inputs.map((input) => input.xpath)
  });
}

export async function waitForSearchSubmitOverlayAction(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<{ action: ManualOverlayAction; selected?: SearchSubmitButton } | undefined> {
  while (true) {
    if (page.isClosed()) return undefined;
    const state = await readManualOverlaySelection(page);
    const latest = await searchSubmitButtonFromManualOverlay(page).catch(() => selected);
    if (latest?.xpath && latest.xpath !== selected?.xpath) {
      await showSearchSubmitPickerInBrowser(page, inputs, latest, runtimeConsole);
      await clearManualOverlayAction(page);
      selected = latest;
      continue;
    }
    if (state?.action) {
      await clearManualOverlayAction(page);
      return { action: state.action, selected: latest };
    }
    await delay(150);
  }
}

export async function searchSubmitButtonFromManualOverlay(page: Page): Promise<SearchSubmitButton | undefined> {
  const state = await readManualOverlaySelection(page);
  if (!state?.selectedXPath) return undefined;
  return {
    xpath: state.selectedXPath,
    ...(state.selectedText ? { text: state.selectedText } : {}),
    score: 2,
    reasons: ['manual picked search submit']
  };
}

export async function chooseSearchSubmitInCli(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<{ action: ManualOverlayAction; selected?: SearchSubmitButton }> {
  await installSearchSubmitPickerOverlay(page, inputs.map((input) => input.xpath));
  try {
    let current = selected;
    const action = await runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => [
        '请在浏览器里点击搜索按钮；这次点击会被拦截，只记录按钮 XPath，确认后会自动执行并写入任务。',
        `当前已选: ${current?.xpath ? `${current.xpath}${current.text ? ` (${truncateText(current.text, 24)})` : ''}` : '未选择'}`
      ].join('\n'),
      readState: async () => {
        current = await readSearchSubmitPickerSelection(page).catch(() => current);
      },
      choices: () => [
        { title: current?.xpath ? '确认该搜索按钮并执行搜索' : '等待浏览器点选搜索按钮', value: current?.xpath ? 'confirm' : 'wait' },
        { title: '取消搜索检测', value: 'cancel' }
      ]
    });
    return { action, selected: current };
  } finally {
    await removeSearchSubmitPickerOverlay(page).catch(() => undefined);
  }
}

export async function inputSearchFieldsOnly(
  host: SearchFlowHost,
  options: DetectOptions,
  inputOverrides?: Map<string, Pick<SearchInputCandidate, 'xpath'>>
): Promise<DetectedSearchPlan | undefined> {
  const entries = Object.entries(options.input ?? {});
  const inputs: DetectedSearchPlan['inputs'] = [];
  for (const [name, value] of entries) {
    const inputXPath = inputOverrides?.get(name)?.xpath || await findInputXPath(host.page, name);
    if (!inputXPath) continue;
    inputs.push({ name, value, xpath: inputXPath });
    await host.command({
      action: 'input',
      frame: { isIframe: false },
      target: { type: 'xpath', xpath: inputXPath },
      timeoutMs: options.timeoutMs,
      payload: {
        text: value,
        mode: 'type',
        clearBeforeInput: true,
        submit: 'none',
        dispatchEvents: ['input', 'change']
      }
    }).catch((error) => {
      if (!options.manual) throw error;
    });
    if (await searchInputNeedsDomEntry(host.page, inputXPath).catch(() => false)) {
      await setSearchInputValueByDom(host.page, inputXPath, value).catch(() => undefined);
    }
  }
  if (!inputs.length) return undefined;
  return {
    startUrl: options.url,
    finalUrl: host.page.url(),
    inputs
  };
}

export async function submitInputs(host: SearchFlowHost, options: DetectOptions, inputOverrides?: Map<string, SearchInputCandidate>): Promise<DetectedSearchPlan | undefined> {
  const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
  await debugSearchTabs('before-submit', host, options, beforePages).catch(() => undefined);
  const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
  const entries = Object.entries(options.input ?? {});
  debugSearchSubmitDecision('submit-inputs-start', undefined, { entries: entries.map(([name, value]) => ({ name, value })) });
  const resolvedInputOverrides = await resolveSearchInputOverrides(host.page, entries.map(([name]) => name), inputOverrides);
  const inputOnlyPlan = await inputSearchFieldsOnly(host, options, resolvedInputOverrides);
  const inputs = inputOnlyPlan?.inputs ?? [];
  const lastInputXPath = inputs[inputs.length - 1]?.xpath || '';
  const preferredSubmitButtons: SearchSubmitButton[] = [];
  for (const [name] of entries) {
    const override = resolvedInputOverrides.get(name);
    debugSearchSubmitDecision('input-resolved', undefined, {
      name,
      inputXPath: inputs.find((input) => input.name === name)?.xpath,
      override: override ? {
        xpath: override.xpath,
        score: override.score,
        buttonXPath: override.buttonXPath,
        reasons: override.reasons
      } : undefined
    });
    if (override?.buttonXPath) preferredSubmitButtons.push({ xpath: override.buttonXPath, ...(override.buttonText ? { text: override.buttonText } : {}) });
  }

  debugSearchSubmitDecision('before-click-submit', undefined, { inputs, preferredSubmitButtons });
  let effectiveSubmit = await clickSubmit(host, options.submit, options.timeoutMs, inputs, preferredSubmitButtons).catch((_error) => {
    debugSearchSubmitDecision('click-submit-error', undefined, { error: String(_error?.message || _error) });
    return undefined;
  });
  let submit: DetectedSearchPlan['submit'] | undefined = effectiveSubmit
    ? { mode: 'click', xpath: effectiveSubmit.xpath, ...(effectiveSubmit.text ? { text: effectiveSubmit.text } : {}) }
    : undefined;
  if (!effectiveSubmit && lastInputXPath) {
    debugSearchSubmitDecision('geometry-fallback-start', undefined, { lastInputXPath });
    effectiveSubmit = await clickSearchSubmitByGeometry(host, lastInputXPath, options.timeoutMs).catch(() => undefined);
    if (effectiveSubmit) submit = { mode: 'click', xpath: effectiveSubmit.xpath, ...(effectiveSubmit.text ? { text: effectiveSubmit.text } : {}) };
  }
  if (!effectiveSubmit && lastInputXPath) {
    debugSearchSubmitDecision('enter-fallback-start', undefined, { lastInputXPath });
    const value = entries[entries.length - 1]?.[1] ?? '';
    await host.command({
      action: 'input',
      frame: { isIframe: false },
      target: { type: 'xpath', xpath: lastInputXPath },
      timeoutMs: options.timeoutMs,
      payload: {
        text: value,
        mode: 'native-setter',
        clearBeforeInput: false,
        submit: 'enter',
        dispatchEvents: ['input', 'change']
      }
    }).catch((error) => {
      if (!options.manual) throw error;
    });
    submit = { mode: 'enter' };
  }
  await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
  await debugSearchTabs('after-submit-wait', host, options, beforePages).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    if (!inputs.length) return undefined;
    return {
      startUrl: options.url,
      finalUrl: host.page.url(),
      inputs,
      ...(submit ? { submit } : {})
    };
  }
  await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
  await debugSearchTabs('after-new-page-adopt', host, options, beforePages).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    if (!inputs.length) return undefined;
    return {
      startUrl: options.url,
      finalUrl: host.page.url(),
      inputs,
      ...(submit ? { submit } : {})
    };
  }
  await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
  await debugSearchTabs('after-best-page-adopt', host, options, beforePages).catch(() => undefined);
  await host.refreshTabId().catch(() => undefined);
  if (!inputs.length) return undefined;
  return {
    startUrl: options.url,
    finalUrl: host.page.url(),
    inputs,
    ...(submit ? { submit } : {})
  };
}

export async function resolveSearchInputOverrides(page: Page, names: string[], existing?: Map<string, SearchInputCandidate>): Promise<Map<string, SearchInputCandidate>> {
  const resolved = new Map(existing ?? []);
  for (const name of names) {
    if (resolved.has(name)) continue;
    const candidate = (await findSearchInputCandidates(page, name).catch(() => []))[0];
    if (candidate) resolved.set(name, candidate);
  }
  return resolved;
}

export async function retrySearchWithEnter(host: SearchFlowHost, options: DetectOptions, existingPlan: DetectedSearchPlan | undefined): Promise<DetectedSearchPlan | undefined> {
  const entries = Object.entries(options.input ?? {});
  const last = entries[entries.length - 1];
  const lastInput = existingPlan?.inputs[existingPlan.inputs.length - 1];
  if (!last || !lastInput?.xpath) return existingPlan;
  const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
  const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
  await host.command({
    action: 'input',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: lastInput.xpath },
    timeoutMs: options.timeoutMs,
    payload: {
      text: last[1],
      mode: 'native-setter',
      clearBeforeInput: false,
      submit: 'enter',
      dispatchEvents: ['input', 'change']
    }
  }).catch((error) => {
    if (!options.manual) throw error;
  });
  await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    return existingPlan
      ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
      : undefined;
  }
  await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    return existingPlan
      ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
      : undefined;
  }
  await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
  await host.refreshTabId().catch(() => undefined);
  return existingPlan
    ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
    : undefined;
}

export async function debugSearchTabs(label: string, host: SearchFlowHost, options: DetectOptions, beforePages: Set<Page>): Promise<void> {
  if (process.env.OCTOPARSE_TRACKING_DEBUG !== '1') return;
  const browser = host.browser();
  if (!browser) return;
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  const tabs = await Promise.all(pages.map(async (page, index) => ({
    index,
    current: page === host.page,
    isNew: !beforePages.has(page),
    url: page.url(),
    title: await page.title().catch(() => ''),
    score: await scoreSearchResultPage(page, options, !beforePages.has(page), index, pages.length).catch(() => null)
  })));
  process.stderr.write(`[detect-debug] search tabs ${label}: ${JSON.stringify(tabs, null, 2)}\n`);
}

export async function waitAfterSearchSubmitOrLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(1200, timeoutMs);
  const pollMs = 300;
  const stableMs = 1200;
  let lastUrl = '';
  let lastTextLength = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const snapshot = await searchSubmitSnapshot(page).catch(() => undefined);
    if (!snapshot) {
      await delay(pollMs);
      continue;
    }
    if (snapshot.hasLoginGate || snapshot.hasResultContent) return;

    const textDelta = Math.abs(snapshot.textLength - lastTextLength);
    const stable = snapshot.url === lastUrl && textDelta < 80 && snapshot.readyState !== 'loading';
    if (!stable) {
      lastUrl = snapshot.url;
      lastTextLength = snapshot.textLength;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
    await delay(pollMs);
  }
}

export async function confirmSearchInputsInteractively(host: SearchFlowHost, options: DetectOptions, runtimeConsole: SuppressedRuntimeConsole): Promise<Map<string, SearchInputCandidate> | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const entries = Object.entries(options.input ?? {});
  if (!entries.length) return undefined;
  const selected = new Map<string, SearchInputCandidate>();
  runtimeConsole.restore();
  try {
    for (const [name, value] of entries) {
      await adoptBestPageForSearchInput(host, options).catch(() => undefined);
      let candidates = await findSearchInputCandidates(host.page, name);
      while (!candidates.length) {
        const action = await chooseSearchInputRetryInBrowser(host.page, name, value, runtimeConsole)
          .catch(() => chooseSearchInputRetryInCli(name, value));
        if (action === 'retry') {
          await adoptBestPageForSearchInput(host, options).catch(() => undefined);
          candidates = await findSearchInputCandidates(host.page, name);
          continue;
        }
        throw new Error('用户取消了搜索输入框确认');
      }
      if (candidates.length <= 1 && (candidates[0]?.score ?? 0) >= 1.5) {
        selected.set(name, candidates[0]);
        continue;
      }
      const action = await chooseSearchInputCandidateInBrowser(host.page, name, value, candidates, runtimeConsole)
        .catch(() => chooseSearchInputCandidateInCli(name, value, candidates));
      if (action === 'cancel' || !action) throw new Error('用户取消了搜索输入框确认');
      const index = Number(String(action).replace('candidate:', ''));
      if (Number.isFinite(index) && candidates[index]) selected.set(name, candidates[index]);
    }
  } finally {
    await removeManualOverlay(host.page).catch(() => undefined);
    runtimeConsole.suppress();
  }
  return selected.size ? selected : undefined;
}

export async function chooseSearchInputRetryInBrowser(
  page: Page,
  name: string,
  value: string,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<'retry' | 'cancel'> {
  writeManualOverlayHintOnce(runtimeConsole, page, `search-input-retry:${name}`, `\n请在浏览器悬浮框中继续: 没有检测到搜索输入框 ${name} = ${value}\n`);
  await showManualOverlay(page, {
    title: '没有检测到搜索输入框',
    message: `请在页面上打开或聚焦搜索框，然后重新检测。\n关键词: ${name} = ${value}`,
    choices: [
      { title: '重新检测', value: 'retry', primary: true },
      { title: '取消搜索检测', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  return selection?.action === 'retry' ? 'retry' : 'cancel';
}

export async function chooseSearchInputRetryInCli(name: string, value: string): Promise<'retry' | 'cancel'> {
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: `没有检测到可用搜索输入框: ${name} = ${value}`,
    choices: [
      { title: '我已在浏览器中打开/聚焦搜索框，重新检测', description: '适合站点把搜索框藏在弹窗、按钮或登录状态后面时使用。', value: 'retry' },
      { title: '取消搜索检测', description: '停止本次 detect，避免选错输入框。', value: 'cancel' }
    ],
    initial: 0
  });
  return response.action === 'retry' ? 'retry' : 'cancel';
}

export async function chooseSearchInputCandidateInBrowser(
  page: Page,
  name: string,
  value: string,
  candidates: SearchInputCandidate[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  const visibleCandidates = candidates.slice(0, 5);
  writeManualOverlayHintOnce(runtimeConsole, page, `search-input-candidate:${name}`, `\n请在浏览器悬浮框中确认搜索输入框: ${name} = ${value}\n`);
  await showManualOverlay(page, {
    title: '确认搜索输入框',
    message: `关键词: ${name} = ${value}`,
    status: `推荐: ${searchInputCandidateLabel(visibleCandidates[0])}`,
    highlightXPaths: visibleCandidates.map((candidate) => candidate.xpath),
    choices: [
      ...visibleCandidates.map((candidate, index): ManualOverlayChoice => ({
        title: `${index === 0 ? '使用推荐输入框' : `使用候选 ${index + 1}`}`,
        value: `candidate:${index}`,
        description: `${searchInputCandidateLabel(candidate)} | ${candidate.xpath}`,
        primary: index === 0
      })),
      { title: '取消搜索检测', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  return selection?.action || 'cancel';
}

export async function chooseSearchInputCandidateInCli(name: string, value: string, candidates: SearchInputCandidate[]): Promise<ManualOverlayAction> {
  const choices = candidates.slice(0, 5).map((candidate, index) => ({
    title: `${index === 0 ? '推荐: ' : ''}${searchInputCandidateLabel(candidate)}`,
    description: `XPath: ${candidate.xpath}${candidate.buttonXPath ? ` | submit: ${candidate.buttonText || candidate.buttonXPath}` : ' | submit: Enter fallback'}`,
    value: `candidate:${index}`
  }));
  choices.push({ title: '取消搜索检测', description: '停止本次 detect，避免选错输入框。', value: 'cancel' });
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: `确认搜索输入框: ${name} = ${value}`,
    choices,
    initial: 0
  });
  return response.action || 'cancel';
}

