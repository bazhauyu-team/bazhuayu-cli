import type { Page } from 'puppeteer-core';
import type {
  LoginInterventionResult,
  ManualStartDecision,
  SuppressedRuntimeConsole
} from './page-detector-shared.js';

import { defaultSessionNameForUrl } from '../browser-session.js';
import { captureAgentScreenshot } from './agent-visual-artifacts.js';
import { detectKnownApiListCandidates } from './api-list-detector.js';
import { detectApiListCandidatesFromResourceTimings, startApiResponseCapture, type ApiResponseCapture } from './api-list-response-detector.js';

import { attachAgentDiagnostics } from './candidate-diagnostics.js';
import { attachCandidateVisualElements, detectPageVisualElements } from './candidate-visual-elements.js';
import {
  applyGoalScores,
  hasUsablePrimaryCandidate,
  inferPageTarget,
  rankCandidates
} from './candidate-ranking.js';

import type {
  PageDetectionResult,
  DetectedApiListCandidate,
  DetectedCandidate,
  DetectedPopupDismissal,
  DetectedSearchPlan,
  DetectOptions
} from './types.js';

export {
  showManualOverlayForTesting,
  readManualOverlaySelectionForTesting,
  hasManualOverlayHostForTesting,
  isInjectableBrowserPageUrlForTesting,
  resetManualOverlayHintKeysForTesting,
  writeManualOverlayHintOnceForTesting
} from './page-detector-overlay.js';
export {
  detectPageObstructionsForTesting,
  dismissPageObstructionsForTesting,
  confirmManualPopupDismissalForTesting
} from './page-detector-popup.js';
export {
  refineCandidateFieldsForTesting,
  augmentAdjacentMetadataFieldsForTesting
} from './page-detector-fields.js';
export {
  detectPaginationForCandidatesForTesting,
  sanitizeCandidatePaginationByLayoutForTesting,
  detectInteractivePaginationOptionsForTesting,
  isPlausiblePaginationOptionForTesting,
  preferredPaginationForTesting
} from './page-detector-pagination.js';
export {
  detectSemanticFeedCandidatesForTesting,
  detectSearchResultBlocksForTesting,
  detectSemanticBusinessCardsForTesting
} from './page-detector-candidates.js';
export {
  findSearchInputCandidatesForTesting,
  resolveSearchSubmitButtonForTesting,
  resolveSearchSubmitButtonByGeometryForTesting
} from './page-detector-search.js';
export {
  selectDetailUrlFieldForTesting
} from './page-detector-manual-ui.js';
export {
  scoreSearchResultPageForTesting,
  pageLooksLikeSearchResultForTesting
} from './page-detector-page-scoring.js';
export {
  DetectionLoginRequiredError,
  shouldPromptForLoginInterventionForTesting
} from './page-detector-login.js';
export {
  DetectionPageAccessError,
  classifyPageAccessSnapshotForTesting,
  detectPageAccessIssueForTesting
} from './page-access.js';

import { DetectionPageAccessError, detectPageAccessIssue } from './page-access.js';
import { confirmManualPopupDismissal, dedupePopupDismissals, dismissPageObstructions } from './page-detector-popup.js';
import { autoScroll, waitForPageSettled } from './page-detector-scroll.js';
import { detectCandidates, buildLlmRankInput } from './page-detector-candidates.js';
import { chooseCandidateInteractively, chooseDetailPlanInteractively } from './page-detector-manual-ui.js';
import { ExtensionDetectorHost } from './page-detector-host.js';
import { adoptBestPageForSearchInput, pageLooksLikeSearchResult } from './page-detector-page-scoring.js';
import {
  handleLoginInterventionIfNeeded,
  mergeLoginIntervention,
  chooseSaveSessionInBrowser,
  chooseSaveSessionInteractively,
  saveSessionForPage
} from './page-detector-login.js';
import {
  submitInputs,
  submitInputsManually,
  retrySearchWithEnter,
  confirmSearchInputsInteractively
} from './page-detector-search-flow.js';
import { choosePaginationInteractively } from './page-detector-pagination-ui.js';

export { dedupeEquivalentCandidates, filterDetectedBoilerplateCandidates } from './candidate-ranking.js';

export function applyGoalScoresForTesting(candidates: DetectedCandidate[], goal: string): DetectedCandidate[] {
  return applyGoalScores(candidates, goal);
}
export function rankCandidatesForTesting(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return rankCandidates(candidates);
}
export { assessPrimaryCandidateQuality } from './candidate-ranking.js';
export function hasUsablePrimaryCandidateForTesting(candidates: DetectedCandidate[], goal?: string): boolean {
  return hasUsablePrimaryCandidate(candidates, goal);
}
export function inferPageTargetForTesting(goal?: string) {
  return inferPageTarget(goal);
}

export { detectApiListCandidatesForTesting } from './api-list-response-detector.js';
export { detectKnownApiListCandidates as detectKnownApiListCandidatesForTesting } from './api-list-detector.js';

function updateSearchPlanFinalUrl(searchPlan: DetectedSearchPlan | undefined, page: Page): DetectedSearchPlan | undefined {
  return searchPlan ? { ...searchPlan, finalUrl: page.url() } : undefined;
}

export async function detectPage(options: DetectOptions): Promise<PageDetectionResult> {
  const runtimeConsole = suppressDetectorRuntimeConsole();
  let host: ExtensionDetectorHost | null = null;
  const phaseTimings: Record<string, number> = {};
  const timed = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await action();
    } finally {
      phaseTimings[key] = (phaseTimings[key] ?? 0) + Date.now() - startedAt;
    }
  };
  const recordPhaseTiming = (key: string, ms: number): void => {
    phaseTimings[key] = (phaseTimings[key] ?? 0) + ms;
  };
  const assertPageAccess = async (page: Page): Promise<void> => {
    const issue = await timed('pageAccessCheckMs', () => detectPageAccessIssue(page));
    if (issue) throw new DetectionPageAccessError(issue);
  };
  let apiCapture: ApiResponseCapture | null = null;
  try {
    options = { ...options, onPhaseTiming: recordPhaseTiming };
    host = await timed('hostStartMs', () => ExtensionDetectorHost.start(options, {
      onTargetPageReady(page) {
        apiCapture = startApiResponseCapture(page);
      }
    }));
    const capturedApiCandidates: DetectedApiListCandidate[] = [];
    const restartApiCapture = (page: Page): void => {
      if (apiCapture) {
        capturedApiCandidates.push(...apiCapture.candidates());
        apiCapture.stop();
      }
      apiCapture = startApiResponseCapture(page);
    };
    let ignoreLoginInterventionPrompts = false;
    const handleLoginIntervention = async (reason: string): Promise<LoginInterventionResult> => {
      if (ignoreLoginInterventionPrompts) return { handled: false, allowSessionSave: false, ignoreFuturePrompts: true };
      const result = await handleLoginInterventionIfNeeded(host!, options, runtimeConsole, reason);
      if (result.ignoreFuturePrompts) ignoreLoginInterventionPrompts = true;
      return result;
    };
    let page = host.page;
    if (!apiCapture) apiCapture = startApiResponseCapture(page);
    page.setDefaultTimeout(options.timeoutMs);
    await timed('initialSettleMs', () => waitForPageSettled(page, options.waitMs));
    await assertPageAccess(page);
    const popupDismissals: DetectedPopupDismissal[] = [];
    const manualPopupPromptKeys = new Set<string>();
    let loginIntervention = await handleLoginIntervention('打开页面后检测到登录要求');
    popupDismissals.push(...loginIntervention.popupDismissals ?? []);
    page = host.page;
    restartApiCapture(page);
    if (options.dismissPopups && !options.manual) {
      popupDismissals.push(...await timed('popupDismissalMs', () => dismissPageObstructions(page)));
      if (popupDismissals.length) await timed('popupSettleMs', () => waitForPageSettled(page, Math.min(options.waitMs, 800)));
    }
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    let searchPlan: DetectedSearchPlan | undefined;
    if (options.input && Object.keys(options.input).length) {
      await adoptBestPageForSearchInput(host, options).catch(() => undefined);
      page = host.page;
      restartApiCapture(page);
      const searchInputOverrides = options.manual ? await confirmSearchInputsInteractively(host, options, runtimeConsole) : undefined;
      if (options.manual) {
        searchPlan = await submitInputsManually(host, options, runtimeConsole, searchInputOverrides);
        page = host.page;
        restartApiCapture(page);
      } else {
        searchPlan = await submitInputs(host, options, searchInputOverrides);
        page = host.page;
        restartApiCapture(page);
        await waitForPageSettled(page, options.waitMs);
        await assertPageAccess(page);
        let afterSearchLogin = await handleLoginIntervention('搜索后检测到登录要求');
        popupDismissals.push(...afterSearchLogin.popupDismissals ?? []);
        page = host.page;
        loginIntervention = mergeLoginIntervention(loginIntervention, afterSearchLogin);
        searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
        if (!await pageLooksLikeSearchResult(page, options).catch(() => false)) {
          searchPlan = await retrySearchWithEnter(host, options, searchPlan);
          page = host.page;
          await waitForPageSettled(page, options.waitMs);
          await assertPageAccess(page);
          const retryLogin = await handleLoginIntervention('重试搜索后检测到登录要求');
          popupDismissals.push(...retryLogin.popupDismissals ?? []);
          page = host.page;
          loginIntervention = mergeLoginIntervention(loginIntervention, retryLogin);
          afterSearchLogin = mergeLoginIntervention(afterSearchLogin, retryLogin);
          searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
        }
        if (afterSearchLogin.handled) {
          if (!await pageLooksLikeSearchResult(host.page, options)) {
            await host.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs }).catch(() => undefined);
            await waitForPageSettled(host.page, options.waitMs);
            searchPlan = await submitInputs(host, options, searchInputOverrides);
            page = host.page;
            restartApiCapture(page);
            await waitForPageSettled(host.page, options.waitMs);
            await assertPageAccess(page);
            const replayLogin = await handleLoginIntervention('登录后重放搜索仍检测到登录要求');
            popupDismissals.push(...replayLogin.popupDismissals ?? []);
            page = host.page;
            loginIntervention = mergeLoginIntervention(loginIntervention, replayLogin);
            searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
          }
        }
        if (!await pageLooksLikeSearchResult(page, options).catch(() => false)) {
          throw new Error('搜索后没有进入当前关键词的结果页。请确认搜索是否成功打开结果页，或直接传入搜索结果页 URL 后重试。');
        }
      }
      await assertPageAccess(page);
      const preDetectionLogin = await handleLoginIntervention('采集检测前检测到登录/验证要求');
      popupDismissals.push(...preDetectionLogin.popupDismissals ?? []);
      page = host.page;
      loginIntervention = mergeLoginIntervention(loginIntervention, preDetectionLogin);
      searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
      if (options.dismissPopups && !options.manual) popupDismissals.push(...await dismissPageObstructions(page));
    }
    let manualStartDecision: ManualStartDecision = { dismissPopups: false, allowSessionSave: true };
    const allowPopupDismissal = options.dismissPopups && (!options.manual || manualStartDecision.dismissPopups);
    if (allowPopupDismissal) popupDismissals.push(...await timed('popupDismissalMs', () => dismissPageObstructions(page)));
    const scrollProbe = await timed('autoScrollMs', () => autoScroll(page, options.scrolls));
    await timed('postScrollSettleMs', () => waitForPageSettled(page, Math.min(options.waitMs, 1000)));
    await assertPageAccess(page);
    if (allowPopupDismissal) popupDismissals.push(...await timed('popupDismissalMs', () => dismissPageObstructions(page)));
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    const effectiveOptions = { ...options, interactive: options.interactive || options.manual };
    let candidates = await timed('detectCandidatesMs', () => detectCandidates(page, effectiveOptions, scrollProbe));
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) {
        await waitForPageSettled(page, Math.min(options.waitMs, 800));
        candidates = await detectCandidates(page, effectiveOptions, scrollProbe);
      }
    }
    if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
      runtimeConsole.writeStderr(`[detect-debug] candidate summaries: ${JSON.stringify(candidates.map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        confidence: candidate.confidence,
        xpath: candidate.xpath,
        itemXPath: candidate.itemXPath,
        itemCount: candidate.itemCount,
        fields: candidate.fields.map((field) => field.name),
        layout: candidate.layout,
        reasons: candidate.reasons
      })), null, 2)}\n`);
    }
    const llmRankInput = options.llmRank ? buildLlmRankInput(candidates, options.goal) : undefined;
    let selectedCandidateIds: string[] = [];
    if (effectiveOptions.interactive && candidates.length) {
      selectedCandidateIds = await chooseCandidateInteractively(page, candidates, runtimeConsole);
      if (selectedCandidateIds.length) {
        const selectedSet = new Set(selectedCandidateIds);
        candidates = [
          ...candidates.filter((candidate) => selectedSet.has(candidate.id)),
          ...candidates.filter((candidate) => !selectedSet.has(candidate.id))
        ];
        const selectedPagination = await choosePaginationInteractively(page, candidates.filter((candidate) => selectedSet.has(candidate.id)), runtimeConsole, scrollProbe);
        candidates = candidates.map((candidate) => selectedSet.has(candidate.id)
          ? { ...candidate, pagination: selectedPagination }
          : candidate);
        const detailPlans = await chooseDetailPlanInteractively(page, candidates.filter((candidate) => selectedSet.has(candidate.id)), runtimeConsole, options.timeoutMs);
        if (detailPlans.size) {
          candidates = candidates.map((candidate) => {
            const detailPlan = detailPlans.get(candidate.id);
            return detailPlan ? { ...candidate, detailPlan } : candidate;
          });
        }
      }
    }
    candidates = await timed('attachDiagnosticsMs', () => attachAgentDiagnostics(page, candidates).catch(() => candidates));
    if (options.agentScreenshotPath) {
      candidates = await attachCandidateVisualElements(page, candidates).catch(() => candidates);
    }
    const agentScreenshot = options.agentScreenshotPath
      ? await captureAgentScreenshot(page, options.agentScreenshotPath, candidates).catch(() => undefined)
      : undefined;
    const pageVisualElements = options.agentScreenshotPath
      ? await detectPageVisualElements(page).catch(() => [])
      : [];
    const canOfferSessionSave = loginIntervention.handled && loginIntervention.allowSessionSave;
    const apiCandidates = dedupeApiListCandidates([
      ...detectKnownApiListCandidates(page.url()),
      ...capturedApiCandidates,
      ...apiCapture.candidates(),
      ...await timed('apiCandidateDetectionMs', () => detectApiListCandidatesFromResourceTimings(page).catch(() => []))
    ]);
    const shouldSaveSession = options.saveSession || (canOfferSessionSave && await chooseSaveSessionInBrowser(page, runtimeConsole)
        .catch(() => chooseSaveSessionInteractively(runtimeConsole)));
    const savedSession = shouldSaveSession
      ? await saveSessionForPage(page, options.sessionName || defaultSessionNameForUrl(options.url), options.url)
      : undefined;
    return {
      url: options.url,
      finalUrl: page.url(),
      title: await page.title(),
      capturedAt: new Date().toISOString(),
      phaseTimings,
      candidates,
      ...(apiCandidates.length ? { apiCandidates } : {}),
      ...(searchPlan ? { searchPlan: { ...searchPlan, finalUrl: page.url() } } : {}),
      ...(savedSession ? { savedSession } : {}),
      selectedCandidateId: selectedCandidateIds[0],
      selectedCandidateIds,
      ...(llmRankInput ? { llmRankInput } : {}),
      ...(agentScreenshot ? { agentScreenshot } : {}),
      ...(pageVisualElements.length ? { pageVisualElements } : {}),
      ...(popupDismissals.length ? { popupDismissals: dedupePopupDismissals(popupDismissals) } : {})
    };
  } finally {
    apiCapture?.stop();
    try {
      await host?.close();
    } finally {
      runtimeConsole.restoreOriginal();
    }
  }
}

function dedupeApiListCandidates<T extends { request: { method: string; url: string }; itemsPath: string; confidence: number; replayability?: 'context_free' | 'browser_context' }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => Number(b.replayability === 'context_free') - Number(a.replayability === 'context_free') || b.confidence - a.confidence)
    .filter((candidate) => {
      const key = `${candidate.request.method}:${candidate.request.url}:${candidate.itemsPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isDetectorRuntimeNoise(message: string): boolean {
  return /\[WorkflowAgent\].*target\s+销毁:\s*other/i.test(message)
    || /\[WorkflowAgent\].*target\s+destroyed:\s*other/i.test(message);
}

function suppressDetectorRuntimeConsole(): SuppressedRuntimeConsole {
  if (process.env.OCTOPUS_SHOW_RUNTIME_STDIO === '1') {
    return {
      suppress() {},
      restore() {},
      restoreOriginal() {},
      writeStderr(message: string) {
        process.stderr.write(message);
      },
      async question(prompt = '') {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(prompt);
        } finally {
          rl.close();
        }
      }
    };
  }
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const boundStdoutWrite = originalStdoutWrite.bind(process.stdout);
  const boundStderrWrite = originalStderrWrite.bind(process.stderr);
  let suppressed = false;
  const filteredStdoutWrite = ((chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
    if (text && isDetectorRuntimeNoise(text)) return true;
    return boundStdoutWrite(chunk as never, ...(args as []));
  }) as typeof process.stdout.write;
  const filteredStderrWrite = ((chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
    if (text && isDetectorRuntimeNoise(text)) return true;
    return boundStderrWrite(chunk as never, ...(args as []));
  }) as typeof process.stderr.write;
  const suppress = () => {
    if (suppressed) return;
    process.stdout.write = (((chunk: unknown, ...args: unknown[]) => {
      const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
      if (process.env.OCTOPARSE_TRACKING_DEBUG === '1' && text.startsWith('[detect-debug]')) {
        return filteredStdoutWrite(chunk as never, ...(args as []));
      }
      return true;
    }) as typeof process.stdout.write);
    process.stderr.write = (((chunk: unknown, ...args: unknown[]) => {
      const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
      if (process.env.OCTOPARSE_TRACKING_DEBUG === '1' && text.startsWith('[detect-debug]')) {
        return filteredStderrWrite(chunk as never, ...(args as []));
      }
      return true;
    }) as typeof process.stderr.write);
    suppressed = true;
  };
  const restore = () => {
    if (!suppressed) return;
    process.stdout.write = filteredStdoutWrite;
    process.stderr.write = filteredStderrWrite;
    suppressed = false;
  };
  const restoreOriginal = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    suppressed = false;
  };
  suppress();
  return {
    suppress,
    restore,
    restoreOriginal,
    writeStderr(message: string) {
      boundStderrWrite(message);
    },
    async question(prompt = '') {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: { write: boundStderrWrite } as NodeJS.WritableStream });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    }
  };
}
