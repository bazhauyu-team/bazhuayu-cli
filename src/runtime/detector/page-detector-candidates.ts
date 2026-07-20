import type { Page } from 'puppeteer-core';
import { attachAgentDiagnostics } from './candidate-diagnostics.js';
import { applyLayoutScores } from './candidate-layout.js';
import {
  applyGoalScores,
  assessPrimaryCandidateQuality,
  dedupeEquivalentCandidates,
  filterDetectedBoilerplateCandidates,
  hasUsablePrimaryCandidate,
  inferPageTarget,
  rankCandidates
} from './candidate-ranking.js';
import { detectProtectedSmartCandidates } from './protected-smart.js';
import type { DetectedCandidate, DetectedLlmRankInput, DetectOptions } from './types.js';
import type { RawCandidate, ScrollProbeSummary } from './page-detector-shared.js';
import { candidateTitle } from './page-detector-utils.js';
import { augmentAdjacentMetadataFields, refineCandidateFields } from './page-detector-fields.js';
import { detectPaginationForCandidates, sanitizeCandidatePaginationByLayout } from './page-detector-pagination.js';
import {
  detectTables,
  detectRepeatedCards,
  detectSemanticFeedCandidates,
  detectSearchResultBlocks,
  detectSemanticBusinessCards,
  detectInteractiveElementGroups,
  detectDeptaCandidates,
  detectDetails,
  detectForms,
  detectLinkCollections
} from './page-detector-candidate-strategies.js';

export {
  detectDetails,
  contentCleanupOperations,
  detectSemanticFeedCandidatesForTesting,
  detectSearchResultBlocksForTesting,
  detectSemanticBusinessCardsForTesting
} from './page-detector-candidate-strategies.js';

export async function detectCandidates(page: Page, options: DetectOptions, scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  const timed = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await action();
    } finally {
      options.onPhaseTiming?.(key, Date.now() - startedAt);
    }
  };
  if (!options.legacyDetector) {
    const outputLimit = options.interactive ? Math.max(options.maxCandidates, 24) : options.maxCandidates;
    const refinementLimit = candidateRefinementLimit(outputLimit);
    const protectedSmart = await timed('protectedSmartMs', () => detectProtectedSmartCandidates(page, { maxCandidates: refinementLimit, baseUrl: options.apiBaseUrl }));
    // Skip heavy fallback only when Protected Smart already produced a usable primary
    // candidate. A non-empty but low-quality Smart result (e.g. nav/header) must still
    // run fallback so the real list can enter the candidate set.
    // Detail goals always need the DOM detail detector (Smart is list-oriented).
    const pageTarget = inferPageTarget(options.goal);
    const smartUsable = hasUsablePrimaryCandidate(protectedSmart, options.goal);
    const smartDetailUsable = protectedSmart.some((candidate) =>
      candidate.type === 'detail' && assessPrimaryCandidateQuality(candidate, options.goal).usable
    );
    const smartHasDetail = protectedSmart.some((candidate) => candidate.type === 'detail');
    // Detail goals need a usable type=detail entity; a bare Smart list is never enough.
    const mustRunDetailFallback = pageTarget === 'detail' && !smartDetailUsable;
    const skipFallback = Boolean(
      protectedSmart.length
      && smartUsable
      && !mustRunDetailFallback
      && !options.interactive
    );
    const fallback = skipFallback
      ? []
      : await timed('fallbackCandidatesMs', () => detectFallbackListCandidates(page, refinementLimit, options.interactive, {
        // List fallback already runs detectRawCandidates (includes detail). Avoid double-running
        // detail inside that path when we will attach a dedicated detail pass below.
        includeDetail: pageTarget === 'auto' && !smartUsable
      }));
    if (!protectedSmart.length && !fallback.length) {
      // Still try dedicated detail pass before failing hard (detail-only pages).
      const earlyDetail = await timed('detailCandidatesMs', () => detectDetailCandidates(page));
      if (!earlyDetail.length) {
        throw new Error('No list candidates were detected. Use --legacy-detector only for debugging the old detector.');
      }
      const onlyDetail = await finalizeCandidates(page, earlyDetail, options, scrollProbe, outputLimit, timed);
      return onlyDetail;
    }
    const fallbackHasUsableDetail = fallback.some((candidate) =>
      candidate.type === 'detail' && assessPrimaryCandidateQuality(candidate, options.goal).usable
    );
    // Always attach a dedicated detail candidate for detail goals (and when Smart is weak).
    // This avoids depending on the heavy raw-list fallback pipeline to surface type=detail.
    // Re-run when existing detail shells fail quality (empty title/content) so wiki/docs recover.
    const needDetailPass = (pageTarget === 'detail' || !smartUsable)
      && !smartDetailUsable
      && !fallbackHasUsableDetail
      && !(pageTarget !== 'detail' && smartHasDetail);
    const detailCandidates = needDetailPass
      ? await timed('detailCandidatesMs', () => detectDetailCandidates(page))
      : [];
    const rawDetected = [...protectedSmart, ...fallback, ...detailCandidates];
    if (!rawDetected.length) {
      throw new Error('No list candidates were detected. Use --legacy-detector only for debugging the old detector.');
    }
    const merged = await timed('candidateDedupeMs', async () => dedupeEquivalentCandidates(rawDetected));
    const withAdjacentMetadata = await timed('adjacentMetadataMs', () => augmentAdjacentMetadataFields(page, merged).catch(() => merged));
    const withPagination = await timed('paginationDetectionMs', () => detectPaginationForCandidates(page, withAdjacentMetadata, scrollProbe));
    const withDiagnostics = await timed('candidateDiagnosticsMs', () => attachAgentDiagnostics(page, withPagination).catch(() => withPagination));
    const withLayoutScores = await timed('layoutScoringMs', () => applyLayoutScores(page, withDiagnostics));
    const sanitized = sanitizeCandidatePaginationByLayout(withLayoutScores);
    const filtered = filterDetectedBoilerplateCandidates(sanitized);
    const ranked = options.goal ? applyGoalScores(filtered, options.goal) : rankCandidates(filtered);
    return options.llmRank ? applyLlmRankPreparation(ranked.slice(0, outputLimit), options.goal) : ranked.slice(0, outputLimit);
  }

  const candidates = await timed('legacyRawCandidatesMs', () => detectRawCandidates(page, options.interactive));

  const seen = new Set<string>();
  const outputLimit = options.interactive ? Math.max(options.maxCandidates, 24) : options.maxCandidates;
  const refinementLimit = candidateRefinementLimit(outputLimit);
  const sorted = candidates
    .filter((candidate) => {
      const key = `${candidate.type}:${candidate.selector}:${candidate.itemSelector ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return candidate.itemCount > 0 && candidate.fields.length > 0;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, refinementLimit);

  const detected = sorted.map((candidate, index) => ({
    id: `${candidate.type}_${index + 1}`,
    title: candidateTitle(candidate),
    ...candidate
  }));
  const withPagination = await timed('paginationDetectionMs', () => detectPaginationForCandidates(page, detected, scrollProbe));
  const withRefinedFields = await timed('fieldRefinementMs', () => refineCandidateFields(page, withPagination));
  const withAdjacentMetadata = await timed('adjacentMetadataMs', () => augmentAdjacentMetadataFields(page, withRefinedFields).catch(() => withRefinedFields));
  const withLayoutScores = await timed('layoutScoringMs', () => applyLayoutScores(page, withAdjacentMetadata));
  const sanitized = sanitizeCandidatePaginationByLayout(withLayoutScores);
  const filtered = filterDetectedBoilerplateCandidates(sanitized);
  const deduped = dedupeEquivalentCandidates(filtered);
  const ranked = options.goal ? applyGoalScores(deduped, options.goal) : rankCandidates(deduped);
  const limited = ranked.slice(0, outputLimit);
  return options.llmRank ? applyLlmRankPreparation(limited, options.goal) : limited;
}

export function candidateRefinementLimit(outputLimit: number): number {
  return Math.max(outputLimit, Math.min(64, Math.max(32, outputLimit * 3)));
}

export async function detectRawCandidates(
  page: Page,
  interactive = false,
  options: { includeDetail?: boolean } = {}
): Promise<RawCandidate[]> {
  const includeDetail = options.includeDetail !== false;
  const candidates: RawCandidate[] = [];
  candidates.push(...await detectTables(page));
  candidates.push(...await detectSemanticFeedCandidates(page));
  candidates.push(...await detectRepeatedCards(page));
  candidates.push(...await detectSearchResultBlocks(page));
  candidates.push(...await detectSemanticBusinessCards(page));
  candidates.push(...await detectDeptaCandidates(page));
  if (interactive) {
    candidates.push(...await detectInteractiveElementGroups(page));
  }
  if (includeDetail) {
    candidates.push(...await detectDetails(page));
  }
  candidates.push(...await detectForms(page));
  candidates.push(...await detectLinkCollections(page));
  return candidates;
}

export async function detectFallbackListCandidates(
  page: Page,
  limit: number,
  interactive = false,
  options: { includeDetail?: boolean } = {}
): Promise<DetectedCandidate[]> {
  const raw = await detectRawCandidates(page, interactive, options);
  const seen = new Set<string>();
  const sorted = raw
    .filter((candidate) => (
      candidate.type === 'table'
      || candidate.type === 'repeated_card'
      || candidate.type === 'search_results'
      || candidate.type === 'link_collection'
      || (options.includeDetail !== false && candidate.type === 'detail')
    ))
    .filter((candidate) => {
      const key = `${candidate.type}:${candidate.selector}:${candidate.itemSelector ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return candidate.itemCount > 0 && candidate.fields.length > 0;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(limit, 12));
  if (!sorted.length) return [];
  const detected = sorted.map((candidate, index) => ({
    id: `fallback_${candidate.type}_${index + 1}`,
    title: `${candidateTitle(candidate)} (fallback)`,
    ...candidate,
    confidence: Number(Math.max(0.1, candidate.confidence - 0.06).toFixed(2)),
    reasons: [...candidate.reasons, 'Fallback detector candidate']
  }));
  const semanticFeedIds = new Set(detected
    .filter((candidate) => candidate.reasons.some((reason) => /semantic feed container/i.test(reason)))
    .map((candidate) => candidate.id));
  const refinable = detected.filter((candidate) => !semanticFeedIds.has(candidate.id));
  const refinedNonFeed = refinable.length ? await refineCandidateFields(page, refinable) : [];
  const refinedById = new Map(refinedNonFeed.map((candidate) => [candidate.id, candidate]));
  const refined = detected.map((candidate) => refinedById.get(candidate.id) ?? candidate);
  return rankCandidates(refined).slice(0, limit);
}

async function detectDetailCandidates(page: Page): Promise<DetectedCandidate[]> {
  try {
    const raw = await detectDetails(page);
    if (!raw.length) return [];
    return raw.map((candidate, index) => ({
      id: `detail_${index + 1}`,
      title: candidateTitle(candidate),
      ...candidate
    }));
  } catch {
    // Detail pass is best-effort; list detection should still return.
    return [];
  }
}

async function finalizeCandidates(
  page: Page,
  seed: DetectedCandidate[],
  options: DetectOptions,
  scrollProbe: ScrollProbeSummary | undefined,
  outputLimit: number,
  timed: <T>(key: string, action: () => Promise<T>) => Promise<T>
): Promise<DetectedCandidate[]> {
  const merged = await timed('candidateDedupeMs', async () => dedupeEquivalentCandidates(seed));
  const withAdjacentMetadata = await timed('adjacentMetadataMs', () => augmentAdjacentMetadataFields(page, merged).catch(() => merged));
  const withPagination = await timed('paginationDetectionMs', () => detectPaginationForCandidates(page, withAdjacentMetadata, scrollProbe));
  const withDiagnostics = await timed('candidateDiagnosticsMs', () => attachAgentDiagnostics(page, withPagination).catch(() => withPagination));
  const withLayoutScores = await timed('layoutScoringMs', () => applyLayoutScores(page, withDiagnostics));
  const sanitized = sanitizeCandidatePaginationByLayout(withLayoutScores);
  const filtered = filterDetectedBoilerplateCandidates(sanitized);
  const ranked = options.goal ? applyGoalScores(filtered, options.goal) : rankCandidates(filtered);
  return options.llmRank ? applyLlmRankPreparation(ranked.slice(0, outputLimit), options.goal) : ranked.slice(0, outputLimit);
}

export function applyLlmRankPreparation(candidates: DetectedCandidate[], goal?: string): DetectedCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    goalReasons: [
      ...(candidate.goalReasons ?? []),
      `LLM rank input prepared${goal ? ` for goal "${goal}"` : ''}; external ranker can use layout, fields, samples, and scores`
    ]
  }));
}

export function buildLlmRankInput(candidates: DetectedCandidate[], goal?: string): DetectedLlmRankInput {
  return {
    ...(goal ? { goal } : {}),
    instruction: 'Choose the candidate that best represents the primary user-intended data list. Prefer main content regions with rich repeated records. Penalize navigation, ads, sidebars, and boilerplate unless the goal explicitly asks for them. Return a candidate id and a short reason.',
    candidates: candidates
      .filter((candidate) => candidate.type !== 'form')
      .slice(0, 10)
      .map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        score: Number((candidate.goalScore ?? candidate.confidence).toFixed(2)),
        ...(candidate.layout ? { layout: candidate.layout } : {}),
        fields: candidate.fields.map((field) => field.name),
        sampleRows: candidate.sampleRows.slice(0, 2),
        reasons: candidate.reasons.slice(-8)
      }))
  };
}
