import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedDetailMode, DetectedDetailPlan, DetectedField, DetectedFieldDiagnostics } from './types.js';
import type { ManualOverlayAction, SuppressedRuntimeConsole } from './page-detector-shared.js';
import {
  clearManualOverlayAction,
  readManualOverlaySelection,
  removeManualOverlay,
  runLiveSelectMenu,
  showManualOverlay,
  waitForManualOverlayAction,
  writeManualOverlayHintOnce
} from './page-detector-overlay.js';
import { detectDetails, contentCleanupOperations } from './page-detector-candidates.js';
import { waitForPageSettled } from './page-detector-scroll.js';
import { delay, detectorCandidateTypeLabel, truncateText } from './page-detector-utils.js';
import {
  installCandidateOverlay,
  readOverlaySelection,
  installDetailFieldOverlay,
  readDetailFieldSelection,
  readDetailFieldObjects,
  clearDetailFieldSelection,
  removeDetailFieldOverlay,
  removeCandidateOverlay
} from './page-detector-browser-overlays.js';
export {
  installCandidateOverlay,
  readOverlaySelection,
  installDetailFieldOverlay,
  readDetailFieldSelection,
  readDetailFieldObjects,
  clearDetailFieldSelection,
  removeDetailFieldOverlay,
  removeCandidateOverlay
} from './page-detector-browser-overlays.js';


let lastCandidateSelection: string[] = [];
let lastDetailFieldSelection: string[] = [];

export async function showManualProgressOverlay(page: Page, options: {
  title: string;
  message?: string;
  status?: string;
}): Promise<void> {
  await showManualOverlay(page, {
    title: options.title,
    message: options.message,
    status: options.status,
    choices: []
  });
}

export async function chooseCandidateInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole): Promise<string[]> {
  const selectable = candidates.filter((candidate) => candidate.type === 'table' || candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection');
  if (!selectable.length) return [];
  let currentIndex = 0;
  let currentCandidate = selectable[currentIndex];
  let keepManualOverlayForNextStep = false;
  await installCandidateOverlay(page, [currentCandidate]);
  const browserOverlayReady = await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole)
    .then(() => true)
    .catch(() => false);
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\n已在浏览器中标出推荐检测结果 1/${selectable.length}: ${formatCandidateSummary(currentCandidate)}。\n`);
      runtimeConsole.writeStderr('回到终端继续后将采用当前推荐结果。\n');
      await runtimeConsole.question('');
      return [currentCandidate.id];
    }

    lastCandidateSelection = await readOverlaySelection(page).catch(() => []);
    while (true) {
      const action = browserOverlayReady
        ? await waitForCandidateManualAction(page, selectable, currentIndex, currentCandidate, runtimeConsole)
        : await runLiveSelectMenu({
          write: (value) => runtimeConsole.writeStderr(value),
          title: () => [
            `当前检测结果: ${currentIndex + 1}/${selectable.length}`,
            formatCandidateSummary(currentCandidate),
            '浏览器中只高亮当前结果；可切换结果，确认后再单独设置翻页。'
          ].filter(Boolean).join('\n'),
          readState: async () => {
            lastCandidateSelection = await readOverlaySelection(page);
          },
          choices: () => [
            { title: '确认当前检测结果，继续设置翻页', value: 'confirm' },
            { title: `切换到下一个检测结果 (${((currentIndex + 1) % selectable.length) + 1}/${selectable.length})`, value: 'next' },
            { title: `切换到上一个检测结果 (${((currentIndex - 1 + selectable.length) % selectable.length) + 1}/${selectable.length})`, value: 'prev' },
            { title: '取消手动检测', value: 'cancel' }
          ]
        });
      await clearManualOverlayAction(page).catch(() => undefined);

      if (action === 'next' || action === 'prev') {
        currentIndex = action === 'next'
          ? (currentIndex + 1) % selectable.length
          : (currentIndex - 1 + selectable.length) % selectable.length;
        currentCandidate = selectable[currentIndex];
        lastCandidateSelection = [];
        await installCandidateOverlay(page, [currentCandidate]);
        if (browserOverlayReady) await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole);
        continue;
      }
      if (action === 'confirm') {
        const latest = await readOverlaySelection(page);
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: '正在分析翻页设置',
            message: '已确认检测结果，正在检测下一页、加载更多或滚动翻页。',
            status: '正在处理，请稍候。'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return latest.length ? latest : [currentCandidate.id];
      }
      throw new Error('用户取消了手动检测');
    }
  } finally {
    if (!keepManualOverlayForNextStep) await removeManualOverlay(page).catch(() => undefined);
    await removeCandidateOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

export async function showCandidateChoiceInBrowser(
  page: Page,
  selectable: DetectedCandidate[],
  currentIndex: number,
  currentCandidate: DetectedCandidate,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'candidate', '\n请在浏览器悬浮框中确认检测结果。\n');
  const selected = await readOverlaySelection(page).catch(() => []);
  await showManualOverlay(page, {
    title: `检测结果 ${currentIndex + 1}/${selectable.length}`,
    message: [
      formatCandidateSummary(currentCandidate),
      '浏览器中只高亮当前结果；可以切换结果，确认后继续设置翻页。'
    ].join('\n'),
    status: selected.length ? `当前已选: ${selected.join(', ')}` : `当前已选: ${currentCandidate.id}`,
    choices: [
      { title: '确认当前检测结果', value: 'confirm', primary: true },
      { title: `下一个 (${((currentIndex + 1) % selectable.length) + 1}/${selectable.length})`, value: 'next' },
      { title: `上一个 (${((currentIndex - 1 + selectable.length) % selectable.length) + 1}/${selectable.length})`, value: 'prev' },
      { title: '取消手动检测', value: 'cancel' }
    ]
  });
}

export async function waitForCandidateManualAction(
  page: Page,
  selectable: DetectedCandidate[],
  currentIndex: number,
  currentCandidate: DetectedCandidate,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  let selected = await readOverlaySelection(page).catch(() => []);
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readOverlaySelection(page).catch(() => selected);
    if (latest.join('\n') !== selected.join('\n')) {
      selected = latest;
      lastCandidateSelection = latest;
      await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

export function formatCandidateSummary(candidate: DetectedCandidate): string {
  const fields = candidate.fields.slice(0, 8).map((field) => field.name).join(', ');
  return `${detectorCandidateTypeLabel(candidate.type)}，${candidate.itemCount}条数据${fields ? `，字段: ${fields}` : ''}`;
}

export function formatSelectedCandidates(ids: string[], candidates: DetectedCandidate[]): string {
  if (!ids.length) return '未选择';
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return ids.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) return id;
    const fields = candidate.fields.slice(0, 4).map((field) => field.name).join(',');
    return `${id} ${detectorCandidateTypeLabel(candidate.type)} ${candidate.itemCount}条${fields ? ` [${fields}]` : ''}`;
  }).join('；');
}

export async function chooseDetailPlanInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole, timeoutMs: number): Promise<Map<string, DetectedDetailPlan>> {
  const output = new Map<string, DetectedDetailPlan>();
  for (const candidate of candidates) {
    const urlField = selectDetailUrlField(candidate);
    if (!urlField) continue;
    const sampleUrls = Array.from(new Set([
      ...candidate.sampleRows.map((row) => row[urlField.name]),
      ...urlField.samples
    ].filter(isHttpUrl))).slice(0, 3);
    if (!sampleUrls.length) continue;
    const mode = await chooseDetailModeInteractively(page, candidate, urlField.name, sampleUrls, runtimeConsole);
    if (mode === 'list_only') continue;
    const detail = await inspectDetailSampleManually(page, sampleUrls[0], runtimeConsole, timeoutMs).catch((error) => ({
      fields: [],
      sampleRows: [],
      reasons: [`详情页样例检测失败: ${error instanceof Error ? error.message : String(error)}`]
    }));
    output.set(candidate.id, {
      mode,
      urlField: urlField.name,
      sampleUrls: sampleUrls.slice(0, 1),
      fields: detail.fields,
      sampleRows: detail.sampleRows,
      templateCount: detail.fields.length ? 1 : 0,
      status: 'planned',
      reasons: [
        '已手动选择详情页字段；生成任务时会逐条打开新标签页采集详情',
        ...detail.reasons
      ]
    });
  }
  return output;
}

export function selectDetailUrlField(candidate: DetectedCandidate): DetectedField | undefined {
  const hrefFields = candidate.fields.filter((field) => field.kind === 'href' && fieldHasHttpSample(candidate, field));
  return hrefFields.find((field) => field.name === 'url') ?? hrefFields[0];
}

export function fieldHasHttpSample(candidate: DetectedCandidate, field: DetectedField): boolean {
  return field.samples.some(isHttpUrl) || candidate.sampleRows.some((row) => isHttpUrl(row[field.name]));
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export async function chooseDetailModeInteractively(page: Page, candidate: DetectedCandidate, urlFieldName: string, sampleUrls: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<DetectedDetailMode> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'list_only';
  try {
    return await chooseDetailModeInBrowser(page, candidate, urlFieldName, sampleUrls, runtimeConsole).catch(() => runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => [
        `候选区 ${candidate.id} 包含详情链接字段 ${urlFieldName}。`,
        `样例: ${truncateText(sampleUrls[0] || '', 90)}`,
        '请选择采集方式：'
      ].join('\n'),
      readState: async () => undefined,
      choices: () => [
        { title: '只采列表字段', value: 'list_only' },
        { title: '列表 + 详情页内容', value: 'list_with_detail' },
        { title: '只用列表 URL 采详情页', value: 'detail_only' }
      ]
    }));
  } finally {
    await removeManualOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

export async function chooseDetailModeInBrowser(
  page: Page,
  candidate: DetectedCandidate,
  urlFieldName: string,
  sampleUrls: string[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<DetectedDetailMode> {
  writeManualOverlayHintOnce(runtimeConsole, page, `detail-mode:${candidate.id}`, '\n请在浏览器悬浮框中确认详情页采集方式。\n');
  await showManualOverlay(page, {
    title: '详情页采集方式',
    message: [
      `候选区 ${candidate.id} 包含详情链接字段 ${urlFieldName}。`,
      `样例: ${truncateText(sampleUrls[0] || '', 90)}`
    ].join('\n'),
    choices: [
      { title: '只采列表字段', value: 'list_only', primary: true },
      { title: '列表 + 详情页内容', value: 'list_with_detail' },
      { title: '只用列表 URL 采详情页', value: 'detail_only' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  if (selection?.action === 'list_with_detail' || selection?.action === 'detail_only') return selection.action;
  return 'list_only';
}

export async function inspectDetailSamples(page: Page, urls: string[], timeoutMs: number): Promise<{ fields: DetectedField[]; sampleRows: Record<string, string>[]; reasons: string[] }> {
  const browser = page.browser();
  const currentUrl = page.url();
  const sampled = urls.slice(0, 3);
  const rows: Record<string, string>[] = [];
  let templateFields: DetectedField[] = [];
  const reasons: string[] = [];
  for (const url of sampled) {
    const detailPage = await browser.newPage();
    try {
      detailPage.setDefaultTimeout(timeoutMs);
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForPageSettled(detailPage, 1200);
      const candidates = await detectDetails(detailPage);
      const detail = candidates[0];
      if (!detail) {
        reasons.push(`未检测到详情字段: ${url}`);
        continue;
      }
      if (!templateFields.length) {
        templateFields = detail.fields.map((field) => ({
          ...field,
          name: `detail_${field.name}`
        }));
      }
      rows.push(Object.fromEntries(detail.fields.map((field) => [`detail_${field.name}`, field.samples[0] || ''])));
    } finally {
      await detailPage.close().catch(() => undefined);
    }
  }
  await page.bringToFront().catch(() => undefined);
  if (page.url() !== currentUrl) {
    await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
  }
  if (templateFields.length) reasons.push(`已从 ${rows.length} 个详情页样例检测字段: ${templateFields.map((field) => field.name).join(', ')}`);
  return { fields: templateFields, sampleRows: rows, reasons };
}

export async function inspectDetailSampleManually(page: Page, url: string, runtimeConsole: SuppressedRuntimeConsole, timeoutMs: number): Promise<{ fields: DetectedField[]; sampleRows: Record<string, string>[]; reasons: string[] }> {
  const browser = page.browser();
  const detailPage = await browser.newPage();
  try {
    detailPage.setDefaultTimeout(timeoutMs);
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForPageSettled(detailPage, 1200);
    await detailPage.bringToFront().catch(() => undefined);
    await installDetailFieldOverlay(detailPage);
    try {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        runtimeConsole.writeStderr('\n已打开 1 个详情页样例。请在浏览器里点击要采集的详情字段或区域，选好后回到终端继续。\n');
        await runtimeConsole.question('');
      } else {
        lastDetailFieldSelection = await readDetailFieldSelection(detailPage).catch(() => []);
        const browserOverlayReady = await showDetailFieldChoiceInBrowser(detailPage, lastDetailFieldSelection, runtimeConsole)
          .then(() => true)
          .catch(() => false);
        while (true) {
          const action = browserOverlayReady
            ? await waitForDetailFieldManualAction(detailPage, lastDetailFieldSelection, runtimeConsole)
            : await runLiveSelectMenu({
              write: (value) => runtimeConsole.writeStderr(value),
              title: () => [
                '已打开 1 个详情页样例。',
                '在浏览器里点击要采集的详情字段或区域；正文建议点击正文容器，图片直接点图片。',
                `当前已选: ${formatSelectedDetailFields(lastDetailFieldSelection)}`
              ].join('\n'),
              readState: async () => {
                lastDetailFieldSelection = await readDetailFieldSelection(detailPage);
              },
              choices: () => [
                { title: lastDetailFieldSelection.length ? '确认当前详情字段' : '等待浏览器点选', value: lastDetailFieldSelection.length ? 'confirm' : 'wait' },
                { title: '清空详情字段，重新点选', value: 'clear' },
                { title: '取消手动检测', value: 'cancel' }
              ]
            });
          await clearManualOverlayAction(detailPage).catch(() => undefined);

          if (action === 'wait') continue;
          if (action === 'clear') {
            await clearDetailFieldSelection(detailPage).catch(() => undefined);
            lastDetailFieldSelection = [];
            if (browserOverlayReady) await showDetailFieldChoiceInBrowser(detailPage, lastDetailFieldSelection, runtimeConsole);
            continue;
          }
          if (action === 'confirm') break;
          throw new Error('用户取消了手动检测');
        }
      }

      const selected = await readDetailFieldObjects(detailPage);
      if (!selected.length) return { fields: [], sampleRows: [], reasons: ['用户没有选择详情页字段'] };
      const fields = selectedDetailFields(selected);
      const row = Object.fromEntries(fields.map((field) => [field.name, field.samples[0] || '']));
      return {
        fields,
        sampleRows: [row],
        reasons: [`已从 1 个详情页样例手动选择字段: ${fields.map((field) => field.name).join(', ')}`]
      };
    } finally {
      await removeManualOverlay(detailPage).catch(() => undefined);
      await removeDetailFieldOverlay(detailPage).catch(() => undefined);
    }
  } finally {
    await detailPage.close().catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }
}

export async function showDetailFieldChoiceInBrowser(page: Page, selectedFields: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'detail-fields', '\n请在浏览器悬浮框中确认详情字段。\n');
  await showManualOverlay(page, {
    title: '确认详情字段',
    message: '在页面上点击要采集的详情字段或区域；正文建议点击正文容器，图片直接点图片。',
    status: `当前已选: ${formatSelectedDetailFields(selectedFields)}`,
    choices: [
      { title: selectedFields.length ? '确认当前详情字段' : '等待浏览器点选', value: selectedFields.length ? 'confirm' : 'wait', primary: Boolean(selectedFields.length) },
      { title: '清空详情字段', value: 'clear' },
      { title: '取消手动检测', value: 'cancel' }
    ]
  });
}

export async function waitForDetailFieldManualAction(page: Page, selectedFields: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<ManualOverlayAction> {
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readDetailFieldSelection(page).catch(() => selectedFields);
    if (latest.join('\n') !== selectedFields.join('\n')) {
      selectedFields = latest;
      lastDetailFieldSelection = latest;
      await showDetailFieldChoiceInBrowser(page, selectedFields, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

export function formatSelectedDetailFields(fields: string[]): string {
  return fields.length ? fields.join(', ') : '未选择';
}

export function selectedDetailFields(selected: Array<{
  suggestedName: string;
  kind: 'text' | 'href' | 'src';
  xpath: string;
  selector: string;
  sample: string;
  diagnostics?: DetectedFieldDiagnostics;
}>): DetectedField[] {
  const counts = new Map<string, number>();
  return selected
    .filter((field) => field.xpath && field.sample)
    .map((field) => {
      const baseName = sanitizeDetailFieldName(field.suggestedName);
      const count = (counts.get(baseName) ?? 0) + 1;
      counts.set(baseName, count);
      const name = count === 1 ? `detail_${baseName}` : `detail_${baseName}_${count}`;
      return {
        name,
        kind: field.kind,
        selector: field.selector,
        xpath: field.xpath,
        relativeSelector: field.selector,
        relativeXPath: field.xpath,
        ...(baseName === 'content' ? { operations: contentCleanupOperations() } : {}),
        ...(field.diagnostics ? { diagnostics: field.diagnostics } : {}),
        samples: [field.sample]
      };
    });
}

export function sanitizeDetailFieldName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'field';
}

export function selectDetailUrlFieldForTesting(candidate: DetectedCandidate): DetectedField | undefined {
  return selectDetailUrlField(candidate);
}
