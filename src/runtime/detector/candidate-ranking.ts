import { isCookieConsentText, isLegalBoilerplateText, isStrongLegalBoilerplateText } from './candidate-boilerplate.js';
import type { DetectedCandidate } from './types.js';

/** Inferred extraction target for ranking / quality gates. */
export type PageTarget = 'detail' | 'list' | 'auto';

/**
 * Infer whether the user wants a single detail entity vs a repeated list.
 * Explicit detail goals beat generic "title/article" tokens that also appear on list pages.
 */
export function inferPageTarget(goal?: string): PageTarget {
  if (!goal?.trim()) return 'auto';
  const detail = goalAsksForDetailContent(goal);
  const list = goalAsksForListContent(goal);
  if (detail && !list) return 'detail';
  if (list && !detail) return 'list';
  if (detail && list) {
    // Mixed wording: prefer detail when the goal centers on one page/entity.
    if (goalPrefersSingleEntity(goal)) return 'detail';
    return 'list';
  }
  return 'auto';
}

export function applyGoalScores(candidates: DetectedCandidate[], goal: string): DetectedCandidate[] {
  const tokens = goalTokens(goal);
  const pageTarget = inferPageTarget(goal);
  return candidates
    .map((candidate) => {
      const haystack = [
        candidate.type,
        candidate.title,
        ...candidate.fields.map((field) => `${field.name} ${field.kind} ${field.samples.join(' ')}`),
        ...candidate.sampleRows.flatMap((row) => Object.values(row))
      ].join(' ').toLowerCase();
      let score = candidate.confidence;
      const reasons: string[] = [];
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 0.08;
          reasons.push(`matches "${token}"`);
        }
      }
      // List boost only when target is list (or auto without a detail preference).
      // Previously "标题|文章" also boosted lists on pure detail goals and buried detail candidates.
      if (
        pageTarget !== 'detail'
        && /标题|title|链接|url|文章|商品|列表|结果|价格|price/i.test(goal)
        && candidate.type !== 'form'
        && candidate.type !== 'link_collection'
        && candidate.type !== 'detail'
      ) {
        score += 0.12;
        reasons.push('goal asks for extractable list data');
      }
      if (pageTarget === 'detail' && candidate.type === 'detail') {
        score += 0.28;
        reasons.push('goal prefers single-page detail entity');
      }
      if (pageTarget === 'detail' && candidateLooksLikeRelatedOrSidebarList(candidate)) {
        score -= 0.32;
        reasons.push('related/sidebar list demoted for detail goal');
      }
      if (pageTarget === 'detail' && isListLikeCandidate(candidate) && !candidateLooksLikeRelatedOrSidebarList(candidate)) {
        // Secondary demotion for any multi-item list when user wants the page entity.
        score -= 0.1;
        reasons.push('list candidate demoted for detail goal');
      }
      if (pageTarget === 'list' && candidate.type === 'detail') {
        score -= 0.18;
        reasons.push('detail demoted for list goal');
      }
      if (/搜索|查询|关键词|input|search/i.test(goal) && candidate.type === 'form') {
        score += 0.16;
        reasons.push('goal asks for search/input');
      }
      if (goalAsksForBusinessRecords(goal) && candidateLooksLikeBusinessRecords(candidate)) {
        score += 0.2;
        reasons.push('goal asks for business/local listing records');
      }
      if (candidate.type === 'link_collection' && !/链接|url|导航|分类|link/i.test(goal)) {
        score -= 0.12;
      }
      // Store goalScore WITHOUT layoutRankingBoost so that candidateRankingScore
      // can add the *current* layout boost after applyLayoutScores updates candidate.layout.
      // Previously layoutRankingBoost was embedded here, making it stale after layout scoring.
      const rawGoalScore = score;
      return {
        candidate: {
          ...candidate,
          goalScore: Number(Math.max(0, Math.min(0.99, rawGoalScore)).toFixed(2)),
          goalReasons: reasons
        },
        rankingScore: rawGoalScore + layoutRankingBoost(candidate) + candidateDataQualityBoost(candidate)
      };
    })
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .map((item) => item.candidate);
}

export function rankCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates
    .slice()
    .sort((a, b) => candidateRankingScore(b) - candidateRankingScore(a));
}

export function candidateSelectionScore(candidate: DetectedCandidate): number {
  return candidateRankingScore(candidate);
}

export function dedupeEquivalentCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  const kept: DetectedCandidate[] = [];
  for (const candidate of rankCandidates(candidates)) {
    const duplicateIndex = kept.findIndex((item) => candidatesLikelySameDataset(item, candidate));
    if (duplicateIndex === -1) {
      kept.push(candidate);
      continue;
    }
    if (candidateDedupScore(candidate) > candidateDedupScore(kept[duplicateIndex])) {
      kept[duplicateIndex] = candidate;
    }
  }
  return rankCandidates(kept);
}

export function filterDetectedBoilerplateCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates.filter((candidate) => !candidateIsLegalBoilerplate(candidate) && !candidateIsCookieConsent(candidate) && !candidateLooksLikePaginationControls(candidate));
}

export interface PrimaryCandidateQuality {
  usable: boolean;
  reasons: string[];
}

/**
 * Preview / auto selection gate: true when the top non-form candidate is good enough
 * to skip expensive fallback scans and quality retries.
 */
export function hasUsablePrimaryCandidate(candidates: DetectedCandidate[], goal?: string): boolean {
  const ranked = goal ? applyGoalScores(candidates, goal) : rankCandidates(candidates);
  const primary = ranked.find((candidate) => candidate.type !== 'form');
  if (!primary) return false;
  return assessPrimaryCandidateQuality(primary, goal).usable;
}

export function assessPrimaryCandidateQuality(candidate: DetectedCandidate, goal?: string): PrimaryCandidateQuality {
  const reasons: string[] = [];
  const pageTarget = inferPageTarget(goal);
  const role = candidate.layout?.role;
  if (role === 'header' || role === 'nav' || role === 'footer' || role === 'ad') {
    reasons.push(`layout role is ${role}`);
  }
  if ((candidate.layout?.boilerplatePenalty ?? 0) >= 0.55) {
    reasons.push('high boilerplate penalty');
  }
  if ((candidate.layout?.sidebarPenalty ?? 0) >= 0.45 && role !== 'main') {
    reasons.push('high sidebar penalty');
  }

  // Detail candidates are single-entity: sampleRows=1 is normal, not a quality failure.
  if (candidate.type === 'detail') {
    return assessDetailCandidateQuality(candidate, reasons, pageTarget);
  }

  // Explicit detail goals should extract the single page entity, not TOC/related/section lists.
  // Mark multi-item lists unusable so ranking falls through to type=detail (or quality retry).
  if (pageTarget === 'detail' && isListLikeCandidate(candidate) && candidate.itemCount >= 2) {
    reasons.push('list candidate rejected for detail goal');
    return { usable: false, reasons };
  }

  const fieldCount = candidate.fields.filter((field) => field.samples.some((sample) => String(sample ?? '').trim())).length;
  const sampleRowCount = candidate.sampleRows.length;
  const warningCount = candidate.diagnostics?.warnings.length ?? 0;
  const visualCoverage = candidate.diagnostics?.visualCoverage ?? candidate.layout?.visualCoverage ?? 1;
  const titleValues = candidateTitleLikeTextValues(candidate);
  const hrefs = candidateHrefValues(candidate);
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const contentStrong = sampleRowCount >= 3
    && fieldCount >= 2
    && candidate.confidence >= 0.5
    && (
      candidateHasRecordLikeSignals(candidate)
      || longTitleRate >= 0.35
      || (candidate.itemCount >= 6 && hrefs.length >= 3)
    );

  if (candidate.confidence < 0.45) reasons.push('low confidence');
  if (fieldCount < 2) reasons.push('fewer than 2 filled fields');
  if (sampleRowCount < 2) reasons.push('fewer than 2 sample rows');
  // Dense news/product grids often report low visualCoverage while still having
  // strong title/href rows. Only treat coverage as a hard fail when content is weak.
  if (visualCoverage < 0.08 && (!contentStrong || visualCoverage < 0.02)) {
    reasons.push('low visual coverage');
  }
  if (warningCount >= 3 && !contentStrong) reasons.push('too many diagnostics warnings');

  if (candidateLooksLikePaginationControls(candidate)) reasons.push('looks like pagination controls');
  if (candidateIsLegalBoilerplate(candidate)) reasons.push('legal boilerplate');
  if (candidateIsCookieConsent(candidate)) reasons.push('cookie consent');
  if (candidateLooksLikeWikiSectionEditList(candidate)) reasons.push('looks like wiki section edit controls');
  if (candidateLooksLikeNavigationList(candidate)) reasons.push('looks like navigation/menu list');
  if (candidateLooksLikeFooterOrNavigation(candidate)) reasons.push('looks like footer/navigation');

  if (candidateLooksLikeLinkGridNavigation(candidate, titleValues, hrefs)) {
    reasons.push('looks like link-grid navigation');
  }
  if (candidateLooksLikeTaxonomyFilterList(candidate)) reasons.push('looks like taxonomy/filter list');
  if (candidateLooksLikeLocalSeoLinks(candidate, titleValues, hrefs)) reasons.push('looks like local SEO links');

  if (goal && goalAsksForRecordContent(goal) && !candidateHasRecordLikeSignals(candidate) && candidateLooksLikeNavigationList(candidate)) {
    reasons.push('goal asks for records but candidate looks like navigation');
  }

  return { usable: reasons.length === 0, reasons };
}

function assessDetailCandidateQuality(
  candidate: DetectedCandidate,
  baseReasons: string[],
  pageTarget: PageTarget
): PrimaryCandidateQuality {
  const reasons = [...baseReasons];
  const fieldCount = candidate.fields.filter((field) => field.samples.some((sample) => String(sample ?? '').trim())).length;
  const contentField = candidate.fields.find((field) => /^(?:content|body|正文|内容|描述|description|summary|摘要|introduction|介绍)$/i.test(field.name));
  const contentLen = contentField
    ? String(contentField.samples[0] ?? '').replace(/\s+/g, ' ').trim().length
    : 0;
  const titleField = candidate.fields.find((field) => /^(?:title|标题|name|名称)$/i.test(field.name));
  const titleLen = titleField
    ? String(titleField.samples[0] ?? '').replace(/\s+/g, ' ').trim().length
    : 0;
  const hasSemantic = Boolean(titleField || contentField
    || candidate.fields.some((field) => /author|作者|time|date|日期|price|价格|image|图片/i.test(field.name)));

  if (candidate.confidence < 0.35) reasons.push('low confidence');
  if (fieldCount < 2) reasons.push('fewer than 2 filled fields');
  // Detail pages often have title + content only; require some substance.
  if (!hasSemantic && fieldCount < 3) reasons.push('detail fields lack semantic signals');
  if (titleLen > 0 && titleLen < 4 && contentLen < 80) reasons.push('detail title/content too short');
  if (contentField && contentLen > 0 && contentLen < 40 && pageTarget === 'detail') {
    reasons.push('detail content too short');
  }
  if (candidateIsLegalBoilerplate(candidate)) reasons.push('legal boilerplate');
  if (candidateIsCookieConsent(candidate)) reasons.push('cookie consent');

  return { usable: reasons.length === 0, reasons };
}

export function candidateLooksLikeNavigationList(candidate: DetectedCandidate): boolean {
  if (candidate.type === 'form' || candidate.type === 'detail') return false;
  if (candidate.layout && ['header', 'nav', 'footer', 'ad'].includes(candidate.layout.role)) return true;

  const titleValues = candidateTitleLikeTextValues(candidate);
  const hrefs = candidateHrefValues(candidate);
  if (!titleValues.length && !hrefs.length) return false;

  const shortTitleRate = titleValues.length
    ? titleValues.filter((value) => {
      const normalized = normalizeSampleValue(value);
      return normalized.length > 0 && (normalized.length <= 18 || isLabelOnlySample(value));
    }).length / titleValues.length
    : 0;
  const navHrefRate = hrefs.length
    ? hrefs.filter((value) => isLikelyNavigationHrefValue(value)).length / hrefs.length
    : 0;
  const navTextRate = titleValues.length
    ? titleValues.filter((value) => isLikelyNavigationLabel(value)).length / titleValues.length
    : 0;
  const fieldCount = candidate.fields.length;
  const hasDate = candidateHasDateSignal(candidate);
  const hasPrice = candidate.fields.some((field) => /price|价格|金额|薪资|salary|rating|评分/i.test(field.name)
    || field.samples.some((sample) => /(?:¥|￥|\$|€|£)\s?\d|\d+\.\d{2}\b|\d+\s?(?:元|万|USD|CNY)/i.test(String(sample ?? ''))));
  const hasRecordMetadata = candidateHasRecordMetadataSignal(candidate);
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const shallow = fieldCount <= 3 && !hasDate && !hasPrice && !hasRecordMetadata && longTitleRate < 0.25;

  if (navHrefRate >= 0.55 && shortTitleRate >= 0.6 && shallow) return true;
  if (navTextRate >= 0.45 && shortTitleRate >= 0.7 && shallow) return true;
  if (candidate.type === 'link_collection' && shortTitleRate >= 0.75 && !hasDate && longTitleRate < 0.2) return true;
  if (shallow && candidate.itemCount >= 6 && shortTitleRate >= 0.8 && navHrefRate >= 0.35) return true;
  return false;
}

function candidateIsLegalBoilerplate(candidate: Pick<DetectedCandidate, 'sampleRows' | 'fields' | 'reasons' | 'layout' | 'type'>): boolean {
  if (candidate.layout?.role === 'footer' && candidate.layout.boilerplatePenalty >= 0.55) return true;
  if (candidate.reasons.some((reason) => /footer\/legal boilerplate/i.test(reason))) return true;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!values.length) return false;

  // Long article/product bodies often mention "copyright" or "privacy" as subject matter
  // (e.g. Wikipedia "Web scraping"). Only treat short, footer-like samples as legal chrome.
  // Previously any sample matching isLegalBoilerplateText killed the whole candidate.
  if (candidate.type === 'detail') {
    const contentValues = candidate.fields
      .filter((field) => /^(?:content|body|正文|内容|描述|description|summary|摘要|introduction|介绍)$/i.test(field.name))
      .flatMap((field) => field.samples)
      .map((value) => String(value ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const longest = [...contentValues, ...values].sort((a, b) => b.length - a.length)[0] ?? '';
    if (longest.length >= 200) {
      // Keep only if the body itself is almost entirely a legal blurb.
      return sampleLooksLikeStandaloneLegalBlurb(longest);
    }
  }

  // Short ICP/备案/© footer tokens are high-precision chrome signals for list modules.
  if (values.some((value) => sampleLooksLikeStandaloneLegalBlurb(value) && isStrongLegalBoilerplateText(value))) {
    return true;
  }
  const legalHits = values.filter((value) => isLegalBoilerplateText(value));
  if (!legalHits.length) return false;
  // List rows: only drop when most non-empty samples are short legal blurbs, not when one
  // title happens to contain the word "copyright".
  const shortLegal = legalHits.filter((value) => sampleLooksLikeStandaloneLegalBlurb(value));
  if (shortLegal.length >= Math.max(2, Math.ceil(values.length * 0.5))) return true;
  if (values.length <= 2 && shortLegal.length === values.length) return true;
  return values.every((value) => isLegalBoilerplateText(value) && value.length < 280);
}

/** True when the sample is a short privacy/terms/copyright footer line, not long prose. */
function sampleLooksLikeStandaloneLegalBlurb(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || !isLegalBoilerplateText(normalized)) return false;
  if (normalized.length <= 220) return true;
  // Longer text: require legal phrases to dominate (footer dump), not a single in-article mention.
  const legalTokens = (normalized.match(/\b(?:privacy\s+policy|terms\s+of\s+(?:use|service)|all\s+rights\s+reserved|copyright|©|icp|备案|用户协议|隐私政策|使用条款)\b/gi) ?? []).length;
  const words = normalized.split(/\s+/).filter(Boolean).length;
  return legalTokens >= 2 && legalTokens / Math.max(1, words) >= 0.08 && normalized.length < 900;
}

function candidateIsCookieConsent(candidate: Pick<DetectedCandidate, 'sampleRows' | 'fields' | 'reasons' | 'layout' | 'type'>): boolean {
  if (candidate.type === 'form' || candidate.type === 'detail') return false;
  const reasonText = candidate.reasons.join(' ');
  if (/cookie|consent|privacy preference|cmp|onetrust|cookiebot|didomi|usercentrics/i.test(reasonText)) return true;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!values.length) return false;
  const cookieValues = values.filter(isCookieConsentText);
  if (cookieValues.length >= 2) return true;
  const combined = values.join(' ');
  return isCookieConsentText(combined) && combined.length >= 24;
}

export function candidateLooksLikePaginationControls(candidate: Pick<DetectedCandidate, 'sampleRows' | 'fields' | 'reasons' | 'type' | 'xpath' | 'itemXPath' | 'itemCount'>): boolean {
  if (candidate.type === 'form' || candidate.type === 'detail') return false;
  if (candidate.itemCount < 2 || candidate.fields.length > 4) return false;
  const structural = [
    candidate.xpath,
    candidate.itemXPath,
    candidate.reasons.join(' '),
    ...candidate.fields.flatMap((field) => [field.name, field.xpath, field.relativeXPath ?? '', field.selector])
  ].join(' ');
  const hasPagerStructure = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(structural);
  if (!hasPagerStructure) return false;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (values.length < 2) return false;
  const pageTokenCount = values.filter((value) => /^(?:\d{1,5}|next|prev|previous|>|›|»|→|<|‹|«|←|下一页|上一页|下页|上页)$/i.test(value)).length;
  const pageUrlCount = values.filter(isPaginationUrlValue).length;
  const shortValueCount = values.filter((value) => value.length <= 48).length;
  const paginationValueRate = (pageTokenCount + pageUrlCount) / values.length;
  const shortValueRate = shortValueCount / values.length;
  const pairedPageLinks = pageTokenCount >= 2 && pageUrlCount >= 2;
  return paginationValueRate >= 0.55 && (shortValueRate >= 0.7 || pairedPageLinks);
}

function isPaginationUrlValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Array.from(parsed.searchParams.keys()).some((key) => /^(?:page|p|page_num|pagenum|paged|offset|start)$/i.test(key))
      || /\/page\/\d+(?:[/?#]|$)/i.test(parsed.pathname);
  } catch {
    return /(?:[?&](?:page|p|page_num|pagenum|paged|offset|start)=\d+|\/page\/\d+(?:[/?#]|$))/i.test(value);
  }
}

function candidatesLikelySameDataset(left: DetectedCandidate, right: DetectedCandidate): boolean {
  if (left.type === 'form' || right.type === 'form' || left.type === 'detail' || right.type === 'detail') return false;
  if (left.id === right.id) return true;
  const leftItems = normalizeXPathForOverlap(left.itemXPath || left.xpath);
  const rightItems = normalizeXPathForOverlap(right.itemXPath || right.xpath);
  if (leftItems && rightItems && (leftItems === rightItems || leftItems.startsWith(`${rightItems}/`) || rightItems.startsWith(`${leftItems}/`))) {
    return true;
  }

  const urlOverlap = jaccard(sampleValuesForCandidate(left, ['url']), sampleValuesForCandidate(right, ['url']));
  if (urlOverlap >= 0.5) return true;
  const imageOverlap = jaccard(sampleValuesForCandidate(left, ['image']), sampleValuesForCandidate(right, ['image']));
  if (imageOverlap >= 0.5) return true;

  const textOverlap = jaccard(
    normalizedSampleTexts(left).filter((value) => value.length >= 8),
    normalizedSampleTexts(right).filter((value) => value.length >= 8)
  );
  return textOverlap >= 0.55 && fieldNameOverlap(left, right) >= 0.5;
}

function candidateDedupScore(candidate: DetectedCandidate): number {
  const fieldNames = new Set(candidate.fields.map((field) => field.name));
  const semanticFields = Array.from(fieldNames)
    .filter((name) => /^(?:title|url|image|date|author|likes|summary|标题|标题链接|链接|图片|日期|时间|作者|摘要|描述|价格|评分|数量)$|href|link/i.test(name))
    .length;
  const refinedBonus = candidate.reasons.some((reason) => /Fields refined/i.test(reason)) ? 0.18 : 0;
  const typeBonus = candidate.type === 'repeated_card' ? 0.08 : candidate.type === 'search_results' ? 0.04 : 0;
  const layout = candidate.layout;
  const layoutBonus = layout
    ? layout.mainScore * 0.16 - layout.sidebarPenalty * 0.12 - layout.boilerplatePenalty * 0.12 + (layout.role === 'main' ? 0.08 : 0)
    : 0;
  return candidate.confidence
    + semanticFields * 0.08
    + Math.min(0.18, candidate.itemCount / 80)
    + refinedBonus
    + typeBonus
    + layoutBonus;
}

function normalizeXPathForOverlap(xpath: string | undefined): string {
  return (xpath || '').replace(/\[\d+\]/g, '').replace(/\/+$/g, '');
}

function sampleValuesForCandidate(candidate: DetectedCandidate, names: string[]): string[] {
  const wanted = new Set(names);
  return candidate.sampleRows
    .flatMap((row) => Object.entries(row).filter(([key]) => wanted.has(key)).map(([, value]) => normalizeSampleValue(value)))
    .filter(Boolean);
}

function normalizedSampleTexts(candidate: DetectedCandidate): string[] {
  return candidate.sampleRows
    .flatMap((row) => Object.values(row))
    .map(normalizeSampleValue)
    .filter(Boolean);
}

function normalizeSampleValue(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[?#].*$/g, '')
    .trim()
    .toLowerCase();
}

function fieldNameOverlap(left: DetectedCandidate, right: DetectedCandidate): number {
  const leftNames = left.fields.map((field) => field.name);
  const rightNames = right.fields.map((field) => field.name);
  return jaccard(leftNames, rightNames);
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function candidateRankingScore(candidate: DetectedCandidate): number {
  // When goalScore is present it stores the pure goal score (without layout boost)
  // so we always add the current layoutRankingBoost, which reflects the latest
  // candidate.layout set by applyLayoutScores.
  const base = candidate.goalScore !== undefined
    ? candidate.goalScore + layoutRankingBoost(candidate)
    : candidate.confidence + layoutRankingBoost(candidate);
  return base + candidateDataQualityBoost(candidate);
}

function candidateDataQualityBoost(candidate: DetectedCandidate): number {
  // Detail entities: reward semantic title/content substance; do not require multi-row list signals.
  if (candidate.type === 'detail') {
    return detailCandidateDataQualityBoost(candidate);
  }
  const fields = candidate.fields;
  const sampleValues = [
    ...fields.flatMap((field) => field.samples),
    ...candidate.sampleRows.flatMap((row) => Object.values(row))
  ].map(normalizeSampleValue).filter(Boolean);
  const titleValues = candidateTitleLikeTextValues(candidate);
  const hasUsableTitle = titleValues.some((sample) => !isLabelOnlySample(sample) && normalizeSampleValue(sample).length >= 4);
  const hasHref = fields.some((field) => field.kind === 'href' && field.samples.some(Boolean));
  const hrefs = candidateHrefValues(candidate);
  const taxonomyHrefRate = hrefs.length ? hrefs.filter(isTaxonomyHrefValue).length / hrefs.length : 0;
  const recordHrefRate = hrefs.length ? hrefs.filter(isLikelyRecordHrefValue).length / hrefs.length : 0;
  const hasSummary = fields.some((field) => /摘要|描述|summary|description|snippet/i.test(field.name) && field.samples.some((sample) => normalizeSampleValue(sample).length >= 30));
  const hasDate = candidateHasDateSignal(candidate);
  const hasRecordMetadata = candidateHasRecordMetadataSignal(candidate);
  const hasBracketedMetadata = candidateHasBracketedMetadata(candidate);
  const looksLikeLinkGridNavigation = candidateLooksLikeLinkGridNavigation(candidate, titleValues, hrefs);
  const businessRecordLike = candidateLooksLikeBusinessRecords(candidate);
  const localSeoLinks = candidateLooksLikeLocalSeoLinks(candidate, titleValues, hrefs);
  const relatedSidebar = candidateLooksLikeRelatedOrSidebarList(candidate);
  const nonEmptyCells = candidate.sampleRows.flatMap((row) => Object.values(row)).filter((value) => normalizeSampleValue(value)).length;
  const totalCells = Math.max(1, candidate.sampleRows.length * Math.max(1, fields.length));
  const fillRate = nonEmptyCells / totalCells;
  const firstRowValues = Object.values(candidate.sampleRows[0] ?? {});
  const firstRowFillRate = firstRowValues.filter((value) => normalizeSampleValue(value)).length / Math.max(1, fields.length);
  const labelRatio = sampleValues.length
    ? sampleValues.filter(isLabelOnlySample).length / sampleValues.length
    : 1;
  const smartFullColRate = protectedSmartFullColRate(candidate);
  const taxonomyLike = candidateLooksLikeTaxonomyFilterList(candidate);
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const shortTitleRate = titleValues.length
    ? titleValues.filter((value) => normalizeSampleValue(value).length <= 12 || isLabelOnlySample(value)).length / titleValues.length
    : 1;
  const shallowLinkList = fields.length <= 2 && hasHref && candidate.itemCount >= 8 && shortTitleRate >= 0.7;
  let boost = 0;
  if (hasUsableTitle && hasHref) boost += 0.12;
  if (hasSummary) boost += 0.06;
  if (hasDate) boost += 0.08;
  if (longTitleRate >= 0.45 && hasHref) boost += 0.08;
  if (recordHrefRate >= 0.5 && longTitleRate >= 0.35) boost += 0.06;
  if (hasRecordMetadata && fields.length >= 4) boost += 0.05;
  if (businessRecordLike) boost += 0.16;
  if (hasBracketedMetadata && hasDate && hasHref) boost += 0.04;
  if (fields.length >= 3) boost += 0.04;
  if (fillRate >= 0.7) boost += 0.03;
  if (smartFullColRate !== undefined) boost += Math.max(-0.08, Math.min(0.08, (smartFullColRate - 0.55) * 0.2));
  if (fields.some((field) => /reference|citation|referencetext|cs1format|脚注|引用/i.test(field.name))) boost -= 0.14;
  if (taxonomyLike) boost -= 0.55;
  if (localSeoLinks) boost -= 0.34;
  if (relatedSidebar) boost -= 0.22;
  if (taxonomyHrefRate >= 0.7 && longTitleRate < 0.35) boost -= 0.18;
  if (looksLikeLinkGridNavigation) boost -= 0.5;
  if (shallowLinkList && !hasDate && longTitleRate < 0.25) boost -= 0.28;
  if (shortTitleRate >= 0.85 && !hasDate && fields.length <= 3) boost -= 0.16;
  if (candidateLooksLikeFooterOrNavigation(candidate)) boost -= 0.2;
  if (fields.some((field) => field.name.length > 80)) boost -= 0.08;
  if (firstRowFillRate < 0.35 && fields.length >= 6) boost -= 0.08;
  if (fields.length <= 2 && !hasHref) boost -= 0.18;
  if (labelRatio >= 0.55 && !hasHref) boost -= 0.16;
  if (candidate.type === 'repeated_card' && fields.length <= 2 && candidate.itemCount >= 40 && !hasHref) boost -= 0.08;
  if (candidate.type === 'link_collection' && !hasDate) boost -= 0.12;
  return Math.max(-0.75, Math.min(0.35, boost));
}

function detailCandidateDataQualityBoost(candidate: DetectedCandidate): number {
  const fields = candidate.fields;
  const title = fields.find((field) => /^(?:title|标题|name|名称)$/i.test(field.name));
  const content = fields.find((field) => /^(?:content|body|正文|内容|描述|description|summary|摘要|introduction|介绍)$/i.test(field.name));
  const titleLen = String(title?.samples[0] ?? '').replace(/\s+/g, ' ').trim().length;
  const contentLen = String(content?.samples[0] ?? '').replace(/\s+/g, ' ').trim().length;
  const hasAuthor = fields.some((field) => /author|作者/i.test(field.name) && field.samples.some(Boolean));
  const hasTime = fields.some((field) => /time|date|日期|时间/i.test(field.name) && field.samples.some(Boolean));
  const hasPrice = fields.some((field) => /price|价格/i.test(field.name) && field.samples.some(Boolean));
  const hasImage = fields.some((field) => field.kind === 'src' && field.samples.some(Boolean));
  let boost = 0.08;
  if (titleLen >= 8) boost += 0.1;
  if (contentLen >= 120) boost += 0.14;
  if (contentLen >= 400) boost += 0.06;
  if (hasAuthor) boost += 0.04;
  if (hasTime) boost += 0.04;
  if (hasPrice) boost += 0.05;
  if (hasImage) boost += 0.03;
  if (fields.length >= 3) boost += 0.04;
  if (titleLen > 0 && titleLen < 4) boost -= 0.1;
  if (content && contentLen < 40) boost -= 0.12;
  return Math.max(-0.4, Math.min(0.35, boost));
}

function candidateTitleLikeTextValues(candidate: DetectedCandidate): string[] {
  const preferred = candidate.fields.filter((field) => field.kind === 'text' && /^(?:title\d*|标题\d*|名称\d*|name\d*|描述\d*|summary\d*|摘要\d*)$/i.test(field.name));
  const fallback = candidate.fields.filter((field) => field.kind === 'text');
  return (preferred.length ? preferred : fallback)
    .flatMap((field) => field.samples)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function candidateHrefValues(candidate: DetectedCandidate): string[] {
  return candidate.fields
    .filter((field) => field.kind === 'href')
    .flatMap((field) => field.samples)
    .map(normalizeHrefValue)
    .filter(Boolean);
}

function candidateHasDateSignal(candidate: DetectedCandidate): boolean {
  return candidate.fields
    .filter((field) => field.kind === 'text')
    .some((field) => /date|time|日期|时间|发布|更新|posted|published/i.test(field.name)
      || field.samples.some(looksLikeDateValue));
}

function candidateHasRecordMetadataSignal(candidate: DetectedCandidate): boolean {
  return candidate.fields
    .filter((field) => field.kind === 'text')
    .some((field) => /地区|区域|省份|城市|位置|地点|类型|分类|状态|价格|金额|公司|商家|企业|地址|作者|来源|日期|时间|date|time|location|type|category|status|price|author|source|business|company|address/i.test(field.name)
      || field.samples.some((sample) => isBracketedMetadataSample(sample) || looksLikeDateValue(sample)));
}

function goalAsksForBusinessRecords(goal: string): boolean {
  return /商家|商户|店铺|门店|企业|公司|机构|黄页|地址|电话|联系|business|businesses|company|companies|merchant|listing|listings|address|phone|contact/i.test(goal);
}

function candidateLooksLikeBusinessRecords(candidate: DetectedCandidate): boolean {
  const identity = [
    candidate.title,
    candidate.selector,
    candidate.xpath,
    candidate.itemSelector ?? '',
    candidate.itemXPath ?? '',
    candidate.reasons.join(' '),
    ...candidate.fields.flatMap((field) => [field.name, field.selector, field.xpath, field.relativeXPath ?? '', ...field.samples.slice(0, 3)])
  ].join(' ');
  const fieldNames = candidate.fields.map((field) => field.name).join(' ');
  const hasName = /business_name|商家|商户|店铺|企业|公司|名称|name|company|business/i.test(fieldNames);
  const hasUrl = /detail_url|详情链接|标题链接|url|href|link/i.test(fieldNames) && candidate.fields.some((field) => field.kind === 'href' && field.samples.some(Boolean));
  const hasAddress = /address|地址|location|位置|地点/i.test(fieldNames)
    || candidate.fields.some((field) => field.samples.some(looksLikeAddressValue));
  const hasContact = /phone|tel|telephone|电话|联系|fax|传真/i.test(fieldNames)
    || candidate.fields.some((field) => field.samples.some((sample) => /(?:tel:|\+?\d[\d\s()./-]{5,}\d)/i.test(sample)));
  const semantic = /LocalBusiness|Organization|business-card|business\/local listing|semantic business|gyresultrecord|listing|merchant|company/i.test(identity);
  return Boolean(hasName && hasUrl && (hasAddress || hasContact || semantic));
}

function looksLikeAddressValue(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\b\d{4,6}\b/.test(normalized) && /(?:str\.?|straße|street|st\.|road|rd\.|avenue|ave\.|gasse|platz|weg|lane|ln\.|地址|路|街|号|栋)/i.test(normalized);
}

function candidateLooksLikeLocalSeoLinks(candidate: DetectedCandidate, titleValues: string[], hrefs: string[]): boolean {
  if (candidate.itemCount < 3 || candidate.itemCount > 24) return false;
  if (candidate.fields.length > 3 || !hrefs.length) return false;
  if (candidateLooksLikeBusinessRecords(candidate)) return false;
  const identity = [
    candidate.title,
    candidate.selector,
    candidate.xpath,
    candidate.itemSelector ?? '',
    candidate.itemXPath ?? '',
    candidate.reasons.join(' '),
    ...candidate.fields.flatMap((field) => [field.name, field.selector, field.xpath, field.relativeXPath ?? ''])
  ].join(' ');
  const seoStructure = /(toplocalit|localit|nearby|neighbour|city|cities|stadt|orte|region|breadcrumb|seo|resultlistseo|附近|周边|城市)/i.test(identity);
  const shortTitleRate = titleValues.length
    ? titleValues.filter((value) => {
      const normalized = normalizeSampleValue(value);
      return normalized.length >= 2 && normalized.length <= 36 && !/[.!?。！？]/.test(normalized);
    }).length / titleValues.length
    : 0;
  const localityHrefRate = hrefs.filter(isLikelyLocalityHrefValue).length / hrefs.length;
  return shortTitleRate >= 0.75 && (seoStructure || localityHrefRate >= 0.65);
}

function isLikelyLocalityHrefValue(value: string): boolean {
  if (!value || /^(?:javascript:|mailto:|tel:|#)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname;
    return /\/(?:deutschland|germany|places?|locations?|localit(?:y|ies)|city|cities|region|nearby)(?:\/|$)/i.test(path)
      || /\/[a-z-]+\/[a-z-]+\/[a-z-]+\/?$/i.test(path) && !looksLikeRecordPath(path);
  } catch {
    return /\/(?:deutschland|germany|places?|locations?|localit(?:y|ies)|city|cities|region|nearby)(?:\/|$)/i.test(value);
  }
}

function candidateHasBracketedMetadata(candidate: DetectedCandidate): boolean {
  const textValues = candidate.fields
    .filter((field) => field.kind === 'text')
    .flatMap((field) => field.samples);
  return textValues.filter(isBracketedMetadataSample).length >= 2;
}

function candidateLooksLikeLinkGridNavigation(candidate: DetectedCandidate, titleValues: string[], hrefs: string[]): boolean {
  if (candidate.itemCount > 10) return false;
  if (candidate.fields.length < 6 || hrefs.length < 6) return false;
  if (candidateHasDateSignal(candidate)) return false;
  const textValues = candidate.fields
    .filter((field) => field.kind === 'text')
    .flatMap((field) => field.samples)
    .map(normalizeSampleValue)
    .filter(Boolean);
  if (textValues.length < 6) return false;
  const shortTextRate = textValues.filter((value) => value.length <= 14 || isLabelOnlySample(value)).length / textValues.length;
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const taxonomyOrServiceHrefRate = hrefs.filter((value) => isTaxonomyHrefValue(value) || isLikelyServiceNavigationHrefValue(value)).length / hrefs.length;
  const hrefFieldRate = candidate.fields.filter((field) => field.kind === 'href').length / candidate.fields.length;
  return shortTextRate >= 0.75
    && longTitleRate < 0.25
    && hrefFieldRate >= 0.35
    && taxonomyOrServiceHrefRate >= 0.55;
}

function isLikelyRecordTitleSample(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  if (!normalized || isLabelOnlySample(value)) return false;
  if (looksLikeDateValue(value) || isBracketedMetadataSample(value)) return false;
  return normalized.length >= 14 || /[a-z0-9][a-z0-9 ,:|()[\]/.-]{18,}/i.test(normalized);
}

function isLikelyRecordHrefValue(value: string): boolean {
  if (!value || isTaxonomyHrefValue(value) || isPaginationUrlValue(value)) return false;
  if (/^(?:javascript:|mailto:|tel:|#)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return looksLikeRecordPath(parsed.pathname);
  } catch {
    return looksLikeRecordPath(value);
  }
}

function isLikelyServiceNavigationHrefValue(value: string): boolean {
  if (!value) return false;
  if (/^(?:javascript:|mailto:|tel:|#)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname;
    return /\/(?:ground|user|work|help|about|service|member|channel|city)(?:[/?#-]|$)/i.test(path)
      || (path === '/' && parsed.searchParams.has('ucode'));
  } catch {
    return /\/(?:ground|user|work|help|about|service|member|channel|city)(?:[/?#-]|$)|^#$/i.test(value);
  }
}

function looksLikeRecordPath(path: string): boolean {
  return /(?:detail|details|item|product|article|news|post|job|jobs|markinfo|notice|tender|bid|info|view)(?:[/?#-]|$)/i.test(path)
    || /\/\d{3,}(?:[/?#.]|$)/.test(path)
    || /\/[^/?#]*\d{3,}[^/?#]*\.html(?:[?#]|$)?/i.test(path)
    || /\/[a-z0-9-]*\d{3,}[a-z0-9-]*\/?$/i.test(path);
}

function looksLikeDateValue(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  return /\b(?:19|20)\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?(?:日)?\b/.test(normalized)
    || /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|june|jul|july|aug|sep|sept|oct|nov|dec)[a-z]*\s+(?:19|20)\d{2}\b/i.test(normalized)
    || /\b(?:jan|feb|mar|apr|may|jun|june|jul|july|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+(?:19|20)\d{2}\b/i.test(normalized);
}

function isBracketedMetadataSample(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  return /^[\[【(（]\s*[^()[\]【】（）]{1,12}\s*[\]】)）]$/.test(normalized);
}

function candidateLooksLikeFooterOrNavigation(candidate: DetectedCandidate): boolean {
  if (candidate.layout && ['footer', 'header', 'nav', 'ad'].includes(candidate.layout.role)) return true;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map(normalizeSampleValue).filter(Boolean);
  if (!values.length) return false;
  const navTerms = values.filter((value) => /^(about|blog|home|login|sign in|sign up|privacy|terms|contact|careers|community|guides|tutorials|glossary|learn|tools|web technologies|html|css|javascript|首页|登录|注册|关于|博客|隐私|条款|联系)$/.test(value)).length;
  const shortRate = values.filter((value) => value.length <= 24).length / values.length;
  return navTerms / values.length >= 0.45 && shortRate >= 0.75;
}

function candidateLooksLikeTaxonomyFilterList(candidate: DetectedCandidate): boolean {
  if (candidate.itemCount < 8) return false;
  const hrefs = candidateHrefValues(candidate);
  if (hrefs.length < 2) return false;
  if (hrefs.every(isTaxonomyHrefValue)) return true;
  const primaryHref = candidate.fields.find((field) => field.kind === 'href' && /^(?:url|链接|标题链接|title_?link|href)$/i.test(field.name))
    ?? candidate.fields.find((field) => field.kind === 'href');
  const primaryHrefValues = (primaryHref?.samples ?? []).map(normalizeHrefValue).filter(Boolean);
  if (primaryHrefValues.length < 2 || !primaryHrefValues.every(isTaxonomyHrefValue)) return false;
  const title = candidate.fields.find((field) => field.kind === 'text' && /^(?:title|标题)$/.test(field.name));
  const titleValues = (title?.samples ?? []).map(normalizeSampleValue).filter(Boolean);
  const shortFacetTitles = titleValues.length >= 2
    && titleValues.every((value) => value.length <= 48 && !/[.!?。！？]/.test(value));
  const noPrimaryRecordHref = hrefs
    .filter((value) => !primaryHrefValues.includes(value))
    .filter((value) => !isTaxonomyHrefValue(value))
    .length === 0;
  return shortFacetTitles && noPrimaryRecordHref;
}

function isTaxonomyHrefValue(value: string): boolean {
  return /(?:[?&](?:type|category|categoryid|cate|cateid|cat|catid|tag|topic|filter|industry|batch|class|classid|area|province|city|region|district|zone|trade|sector|field|kwtype)=|\/(?:type|category|categories|cate|cat|tag|tags|topics?|filters?|industr(?:y|ies)|batches|class|classid|city|cities|area|province|region|district|zone|trade|sector|fields?)(?:[/?#-]|$)|\/info\/lists\/classid(?:[/?#]|$)|\/search(?:\.html)?\?[^#]*(?:cate|cateid|catid|classid|industry|area|province|city|region|activeName)=)/i.test(value);
}

function normalizeHrefValue(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function protectedSmartFullColRate(candidate: DetectedCandidate): number | undefined {
  const reason = candidate.reasons.find((item) => /fullColRate=/i.test(item));
  const value = reason?.match(/fullColRate=([0-9.]+)/i)?.[1];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLabelOnlySample(value: string): boolean {
  const normalized = normalizeSampleValue(value).replace(/[:：]+$/g, '');
  if (!normalized) return true;
  return /^(authors?|submitted|comments?|abstract|capital|votes?|answers?|views?|asked|modified|updated|tags?|关键词|作者|提交|评论|摘要|首都|首页|登录|注册|关于|联系|更多|全部|全部分类|分类|类型|地区|行业|城市|招标采购|前期项目|结果公告|vip项目|招标热点|行业招标|城市子站|热门|推荐|帮助中心|客服中心)$/i.test(normalized)
    || (normalized.length <= 24 && /[:：]$/.test(String(value).trim()));
}

export function layoutRankingBoost(candidate: Pick<DetectedCandidate, 'layout' | 'type'>): number {
  const layout = candidate.layout;
  if (!layout) return 0;
  let boost = layout.score * 0.18 + layout.mainScore * 0.1 - layout.sidebarPenalty * 0.18 - layout.boilerplatePenalty * 0.18;
  if (layout.role === 'main') boost += 0.1;
  if (layout.role === 'sidebar') boost -= 0.08;
  if (layout.role === 'nav' || layout.role === 'header' || layout.role === 'footer' || layout.role === 'ad') boost -= 0.16;
  if (candidate.type === 'link_collection' && layout.role !== 'main') boost -= 0.08;
  return boost;
}

function goalTokens(goal: string): string[] {
  return goal.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 20);
}

function goalAsksForRecordContent(goal: string): boolean {
  return /商品|产品|列表|结果|文章|新闻|标题|价格|评分|评论|店铺|商家|详情|product|item|list|result|article|news|title|price|rating|review|shop|store|detail/i.test(goal)
    || goalAsksForBusinessRecords(goal);
}

/** True when goal emphasizes a single-page entity (article body, product page, store profile, etc.). */
export function goalAsksForDetailContent(goal: string): boolean {
  return /详情页|详情|正文|文章内容|博客|博文|帖子|产品页|商品页|商品详情|介绍|简介|主内容|当前页|本页|单页|实体|店铺信息|商家信息|公司信息|个人主页|仓库信息|项目信息|detail\s*page|article\s*body|blog\s*post|product\s*page|main\s*content|introduction|description\s*page|review\s*page|single\s*(?:page|entity|item)|this\s*page|current\s*page/i.test(goal)
    // Chinese short goals like "提取正文" / "采详情"
    || /(?:提取|采集|抓取|预览).{0,8}(?:正文|详情|内容|介绍)/i.test(goal)
    || /(?:title|标题).{0,12}(?:author|作者|content|正文|body|评分|地址|电话)/i.test(goal)
    || /(?:评分|地址|电话|rating|address|phone).{0,12}(?:评分|地址|电话|rating|address|phone)/i.test(goal);
}

/** True when goal clearly wants multi-item list/feed extraction. */
export function goalAsksForListContent(goal: string): boolean {
  if (goalPrefersSingleEntity(goal)) return false;
  return /列表|多条|批量|feed|卡片列表|搜索结果|结果列表|商品列表|文章列表|新闻列表|招聘列表|list\s*of|search\s*results?|listings?|cards?|grid|catalog|results?\s*page|scrape\s*(?:all|every|many)/i.test(goal)
    || /(?:采集|抓取|提取|预览).{0,6}(?:列表|结果|商品|新闻|文章|职位|商家)/i.test(goal);
}

function goalPrefersSingleEntity(goal: string): boolean {
  return /详情页|正文|文章内容|博客|博文|产品页|商品页|商品详情|主内容|当前页|本页|单页|店铺信息|商家信息|detail\s*page|article\s*body|blog\s*post|product\s*page|main\s*content|this\s*page|current\s*page|single\s*(?:page|entity|item)/i.test(goal);
}

function isListLikeCandidate(candidate: DetectedCandidate): boolean {
  return candidate.type === 'table'
    || candidate.type === 'repeated_card'
    || candidate.type === 'search_results'
    || candidate.type === 'link_collection'
    || (candidate.itemCount >= 3 && candidate.type !== 'detail' && candidate.type !== 'form');
}

/**
 * Related articles, "you may also like", sidebar recommendation modules, etc.
 * These often win ranking on detail pages because they look like clean title+url lists.
 */
export function candidateLooksLikeRelatedOrSidebarList(candidate: DetectedCandidate): boolean {
  if (candidate.type === 'detail' || candidate.type === 'form') return false;
  const role = candidate.layout?.role;
  if (role === 'sidebar') return true;
  if ((candidate.layout?.sidebarPenalty ?? 0) >= 0.4 && role !== 'main') return true;

  // Wikipedia/MediaWiki section chrome: repeated "edit" / action=edit rows are not the article entity.
  if (candidateLooksLikeWikiSectionEditList(candidate)) return true;

  const identity = [
    candidate.title,
    candidate.selector,
    candidate.xpath,
    candidate.itemSelector ?? '',
    candidate.itemXPath ?? '',
    candidate.reasons.join(' '),
    ...candidate.fields.flatMap((field) => [field.name, field.selector, field.xpath])
  ].join(' ');

  if (/(?:related|recommend|recommendation|you\s*may\s*also|more\s*from|more\s*stories|popular|trending|sidebar|aside|widget|similar|also\s*read|read\s*next|up\s*next|sponsored|广告|推荐|相关|猜你喜欢|热门|更多文章|更多阅读|侧边|周边|附近)/i.test(identity)) {
    // Only treat as related-module when it is multi-item (not the main article).
    if (candidate.itemCount >= 2) return true;
  }

  // Compact multi-item title+url blocks with few fields often are "related posts".
  if (
    role !== 'main'
    && candidate.itemCount >= 3
    && candidate.itemCount <= 12
    && candidate.fields.length <= 3
    && !candidateHasDateSignal(candidate)
    && !candidateHasRecordMetadataSignal(candidate)
  ) {
    const titleValues = candidateTitleLikeTextValues(candidate);
    const hrefs = candidateHrefValues(candidate);
    if (titleValues.length >= 2 && hrefs.length >= 2) {
      const longTitleRate = titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length;
      // Related posts often have decent titles; main feeds tend to be denser or have dates.
      if (longTitleRate >= 0.35 && candidate.fields.length <= 2) return true;
    }
  }

  return false;
}

/** MediaWiki section edit affordances (title "edit", action=edit&section=N). */
export function candidateLooksLikeWikiSectionEditList(candidate: DetectedCandidate): boolean {
  if (candidate.type === 'detail' || candidate.type === 'form') return false;
  if (candidate.itemCount < 2) return false;
  const titleValues = candidateTitleLikeTextValues(candidate);
  const hrefs = candidateHrefValues(candidate);
  if (!titleValues.length && !hrefs.length) return false;
  const editTitleRate = titleValues.length
    ? titleValues.filter((value) => /^(?:edit|\[edit\]|编辑|編輯)$/i.test(normalizeSampleValue(value))).length / titleValues.length
    : 0;
  const editHrefRate = hrefs.length
    ? hrefs.filter((value) => /[?&]action=edit\b|(?:[?&]section=\d+)|\/w\/index\.php\?[^#]*action=edit/i.test(value)).length / hrefs.length
    : 0;
  if (editTitleRate >= 0.5 && candidate.itemCount >= 2) return true;
  if (editHrefRate >= 0.5 && candidate.itemCount >= 2) return true;
  if (editTitleRate >= 0.3 && editHrefRate >= 0.3) return true;
  return false;
}

function candidateHasRecordLikeSignals(candidate: DetectedCandidate): boolean {
  if (candidateHasDateSignal(candidate) || candidateHasRecordMetadataSignal(candidate)) return true;
  if (candidateLooksLikeBusinessRecords(candidate)) return true;
  const titleValues = candidateTitleLikeTextValues(candidate);
  const hrefs = candidateHrefValues(candidate);
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const recordHrefRate = hrefs.length
    ? hrefs.filter(isLikelyRecordHrefValue).length / hrefs.length
    : 0;
  const hasPrice = candidate.fields.some((field) => /price|价格|金额|薪资|salary/i.test(field.name)
    || field.samples.some((sample) => /(?:¥|￥|\$|€|£)\s?\d|\d+\.\d{2}\b/.test(String(sample ?? ''))));
  return longTitleRate >= 0.35 || recordHrefRate >= 0.4 || hasPrice;
}

function isLikelyNavigationHrefValue(value: string): boolean {
  if (!value || /^(?:javascript:|mailto:|tel:|#)/i.test(value)) return true;
  if (isTaxonomyHrefValue(value) || isLikelyServiceNavigationHrefValue(value)) return true;
  if (isLikelyRecordHrefValue(value)) return false;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname || '/';
    const search = parsed.search || '';
    if (/ref_?[=_]nav|nav_cs|nav-link|nav_link|nav_menu|ic=nav/i.test(`${path}${search}`)) return true;
    if (path === '/' || path === '') return true;
    // Shallow site sections without record-like path tokens.
    const segments = path.split('/').filter(Boolean);
    if (segments.length <= 1 && !/\d{3,}/.test(path)) return true;
    if (segments.length <= 2 && /(?:shop|stores?|deals?|bestsellers?|best-sellers|new-releases|gift-cards?|customer|help|account|cart|orders?|registry|prime|music|video|kindle|books?|fashion|home|grocery|electronics|toys|beauty|sports|automotive|industrial)/i.test(segments.join('/'))) {
      return true;
    }
    return false;
  } catch {
    return /ref_?[=_]nav|nav_cs|nav-link|\/(?:best-?sellers|new-releases|gift-cards?)(?:[/?#]|$)/i.test(value);
  }
}

function isLikelyNavigationLabel(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  if (!normalized) return true;
  if (isLabelOnlySample(value)) return true;
  return /^(?:home|about|blog|login|sign in|sign up|register|cart|account|orders?|help|support|contact|privacy|terms|careers|sell|gift cards?|best sellers?|new arrivals?|new releases?|today'?s deals?|customer service|registry|prime|amazon haul|health ai|browse|categories?|menu|more|see all|shop all|首页|登录|注册|购物车|订单|帮助|客服|关于|分类|更多|全部|热门|推荐|榜单|新品|优惠|会员)$/i.test(normalized)
    || (normalized.length <= 16 && !/\d{2,}/.test(normalized) && !/[.!?。！？]/.test(normalized));
}
