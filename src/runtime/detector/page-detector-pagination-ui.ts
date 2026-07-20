import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedPagination } from './types.js';
import type { ManualOverlayAction, ScrollProbeSummary, SuppressedRuntimeConsole } from './page-detector-shared.js';
import {
  clearManualOverlayAction,
  readManualOverlaySelection,
  removeManualOverlay,
  runLiveSelectMenu,
  showManualOverlay,
  writeManualOverlayHintOnce
} from './page-detector-overlay.js';
import {
  capturePaginationDiagnostics,
  clearPaginationOverlaySelection,
  detectInteractivePaginationOptions,
  formatSelectedPagination,
  installPaginationOverlay,
  paginationKey,
  preparePaginationDetectionViewport,
  readPaginationOverlaySelection,
  removePaginationOverlay
} from './page-detector-pagination.js';
import { delay } from './page-detector-utils.js';
import { showManualProgressOverlay } from './page-detector-manual-ui.js';

export async function choosePaginationInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole, scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination | undefined> {
  const restoreViewport = await preparePaginationDetectionViewport(page, candidates).catch(() => undefined);
  const detectedOptions = await detectInteractivePaginationOptions(page, candidates, scrollProbe);
  const manualScroll = manualScrollPaginationOption(candidates);
  const options = manualScroll && !detectedOptions.some((option) => option.type === 'scroll')
    ? [...detectedOptions, manualScroll]
    : detectedOptions;
  if (!options.length) {
    await restoreViewport?.().catch(() => undefined);
    await showManualProgressOverlay(page, {
      title: '未检测到翻页设置',
      message: '没有检测到可用的下一页或加载更多控件，本任务将按单页采集继续。',
      status: '正在继续生成任务，请稍候。'
    }).catch(() => undefined);
    runtimeConsole.writeStderr('\n没有检测到可用的下一页/加载更多控件，本任务按单页采集生成。\n');
    return undefined;
  }
  await restoreViewport?.().catch(() => undefined);
  if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
    const diagnostics = await capturePaginationDiagnostics(page).catch(() => []);
    runtimeConsole.writeStderr(`\n[detect-debug] pagination options: ${JSON.stringify(options.map((option) => ({
      type: option.type,
      text: option.text,
      confidence: option.confidence,
      xpath: option.xpath,
      reasons: option.reasons
    })), null, 2)}\n`);
    runtimeConsole.writeStderr(`[detect-debug] bottom clickable/text candidates: ${JSON.stringify(diagnostics, null, 2)}\n`);
  }

  await installPaginationOverlay(page, options);
  let keepManualOverlayForNextStep = false;
  try {
    const recommended = options[0];
    lastPaginationSelection = await readPaginationOverlaySelection(page).catch(() => undefined) || paginationKey(recommended);
    const browserOverlayReady = await showPaginationChoiceInBrowser(page, options, lastPaginationSelection, runtimeConsole)
      .then(() => true)
      .catch(() => false);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\n已在浏览器中标出可能的翻页控件；未交互输入时采用推荐翻页: ${formatSelectedPagination(paginationKey(recommended), options)}。\n`);
      await runtimeConsole.question('');
      const selected = await readPaginationOverlaySelection(page);
      return selected ? options.find((option) => paginationKey(option) === selected) : recommended;
    }

    while (true) {
      const action = browserOverlayReady
        ? await waitForPaginationManualAction(page, options, lastPaginationSelection, runtimeConsole)
        : await runLiveSelectMenu({
          write: (value) => runtimeConsole.writeStderr(value),
          title: () => [
            '在浏览器里点击橙色 PAGE/MORE 标记来切换翻页控件。',
            `当前翻页: ${formatSelectedPagination(lastPaginationSelection, options)}`
          ].join('\n'),
          readState: async () => {
            lastPaginationSelection = await readPaginationOverlaySelection(page);
          },
          choices: () => [
            { title: lastPaginationSelection ? '确认推荐翻页设置' : '等待浏览器点选', value: lastPaginationSelection ? 'confirm' : 'wait' },
            { title: '按单页采集，不设置翻页', value: 'single-page' },
            { title: '取消手动检测', value: 'cancel' }
          ]
        });
      await clearManualOverlayAction(page).catch(() => undefined);

      if (action === 'wait') continue;
      if (action === 'single-page') {
        await clearPaginationOverlaySelection(page).catch(() => undefined);
        lastPaginationSelection = undefined;
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: '正在继续生成任务',
            message: '已选择按单页采集，正在准备下一步。',
            status: '正在处理，请稍候。'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return undefined;
      }
      if (action === 'confirm') {
        const latest = await readPaginationOverlaySelection(page);
        const selected = latest || lastPaginationSelection || paginationKey(recommended);
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: '正在继续生成任务',
            message: '已确认翻页设置，正在准备详情采集或生成任务。',
            status: '正在处理，请稍候。'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return selected ? options.find((option) => paginationKey(option) === selected) : recommended;
      }
      throw new Error('用户取消了手动检测');
    }
  } finally {
    if (!keepManualOverlayForNextStep) await removeManualOverlay(page).catch(() => undefined);
    await removePaginationOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

export function manualScrollPaginationOption(candidates: DetectedCandidate[]): DetectedPagination | undefined {
  const candidate = candidates.find((item) => (
    item.type !== 'detail'
    && item.type !== 'form'
    && item.itemCount >= 3
    && item.fields.length >= 2
    && item.fields.some((field) => field.kind === 'href' || field.kind === 'src')
  ));
  if (!candidate) return undefined;
  return {
    type: 'scroll',
    xpath: '',
    text: 'Scroll page',
    confidence: 0.35,
    isAjax: true,
    scope: 'global',
    reasons: ['Manual scroll option for the selected record list']
  };
}

export async function showPaginationChoiceInBrowser(
  page: Page,
  options: DetectedPagination[],
  selectedKey: string | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'pagination', '\n请在浏览器悬浮框中确认翻页设置。\n');
  await showManualOverlay(page, {
    title: '确认翻页设置',
    message: '点击页面上的橙色 PAGE/MORE/SCROLL 标记切换翻页控件。',
    status: `当前翻页: ${formatSelectedPagination(selectedKey, options)}`,
    choices: [
      { title: selectedKey ? '确认当前翻页设置' : '等待浏览器点选', value: selectedKey ? 'confirm' : 'wait', primary: Boolean(selectedKey) },
      { title: '按单页采集', value: 'single-page' },
      { title: '取消手动检测', value: 'cancel' }
    ]
  });
}

export async function waitForPaginationManualAction(
  page: Page,
  options: DetectedPagination[],
  selectedKey: string | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readPaginationOverlaySelection(page).catch(() => selectedKey);
    if (latest !== selectedKey) {
      selectedKey = latest;
      lastPaginationSelection = latest;
      await showPaginationChoiceInBrowser(page, options, selectedKey, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

let lastPaginationSelection: string | undefined;
