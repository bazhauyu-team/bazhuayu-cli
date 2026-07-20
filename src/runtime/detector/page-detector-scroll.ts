import type { Page } from 'puppeteer-core';
import type { ScrollProbeSnapshot, ScrollProbeSummary } from './page-detector-shared.js';
import { delay } from './page-detector-utils.js';

export async function autoScroll(page: Page, scrolls: number): Promise<ScrollProbeSummary> {
  const maxScrolls = Math.max(0, scrolls);
  const snapshots: ScrollProbeSnapshot[] = [];
  let previous: ScrollProbeSnapshot | undefined;
  let stableCount = 0;
  let loadingProbeCount = 0;
  let didScroll = false;
  const initial = await captureScrollProbeSnapshot(page).catch(() => undefined);
  if (initial) snapshots.push(initial);
  for (let index = 0; index < maxScrolls; index += 1) {
    const scrolled = await scrollPageForPaginationProbe(page).catch(() => false);
    if (!scrolled) break;
    didScroll = true;
    await delay(250);
    let snapshot = await captureScrollProbeSnapshot(page).catch(() => undefined);
    if (!snapshot) continue;
    const observedLoading = snapshot.hasLoadingIndicator === true;
    if (snapshot.hasLoadingIndicator) {
      snapshot = await waitForScrollLoadSettled(page, snapshot, 1_800);
    }
    if (observedLoading) loadingProbeCount += 1;
    snapshots.push(snapshot);
    if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
      process.stderr.write(`[detect-debug] scroll probe ${index + 1}/${maxScrolls}: ${JSON.stringify(snapshot)}\n`);
    }
    if ((summarizeScrollProbe(snapshots).grewArticleLikeCount ?? 0) >= 2) break;
    if (snapshot.hasActiveLoadMore || loadingProbeCount >= 2) break;
    if (snapshot.hasLoadingIndicator) {
      stableCount = 0;
      previous = snapshot;
      continue;
    }
    if (previous && scrollProbeStable(previous, snapshot)) stableCount += 1;
    else stableCount = 0;
    previous = snapshot;
    if (stableCount >= 3) break;
  }
  if (didScroll) await scrollPageToTop(page).catch(() => undefined);
  const summary = summarizeScrollProbe(snapshots);
  if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
    process.stderr.write(`[detect-debug] scroll probe summary: ${JSON.stringify({ ...summary, snapshots: summary.snapshots.length })}\n`);
  }
  return summary;
}

export async function scrollPageForPaginationProbe(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const viewport = window.innerHeight || document.documentElement.clientHeight || 800;
    const current = window.scrollY || root.scrollTop || 0;
    const bottom = Math.max(0, root.scrollHeight - Math.floor(viewport * 0.25));
    if (bottom <= current + 1) return false;
    window.scrollTo({
      top: Math.max(current + Math.floor(viewport * 2.5), bottom),
      left: 0,
      behavior: 'instant'
    });
    return true;
  });
}

export async function scrollPageToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  });
}


export function summarizeScrollProbe(snapshots: ScrollProbeSnapshot[]): ScrollProbeSummary {
  const first = snapshots[0];
  const maxArticleLikeCount = snapshots.reduce((max, item) => Math.max(max, item.articleLikeCount), 0);
  const maxContentHeight = snapshots.reduce((max, item) => Math.max(max, item.contentHeight), 0);
  const maxPageHeight = snapshots.reduce((max, item) => Math.max(max, item.pageHeight), 0);
  const sawActiveLoadMore = snapshots.some((item) => item.hasActiveLoadMore);
  const firstArticleLikeKeys = new Set(first?.articleLikeKeys ?? []);
  const discoveredArticleLikeKeys = new Set(snapshots.flatMap((item) => item.articleLikeKeys ?? []));
  const grewArticleLikeKeyCount = first
    ? [...discoveredArticleLikeKeys].filter((key) => !firstArticleLikeKeys.has(key)).length
    : 0;
  const grewArticleLikeCount = first
    ? Math.max(0, maxArticleLikeCount - first.articleLikeCount, grewArticleLikeKeyCount)
    : 0;
  const grewContentHeight = first ? Math.max(0, maxContentHeight - first.contentHeight) : 0;
  const grewPageHeight = first ? Math.max(0, maxPageHeight - first.pageHeight) : 0;
  const sawGrowth = grewArticleLikeCount >= 2 || grewContentHeight >= 600 || grewPageHeight >= 240;
  const reachedBottom = snapshots.some((item) => item.atBottom);
  const bestActiveLoadMoreText = snapshots
    .flatMap((item) => item.activeLoadMoreTexts)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  const bestActiveLoadMoreXPath = snapshots
    .flatMap((item) => item.activeLoadMoreXPaths)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return {
    snapshots,
    sawActiveLoadMore,
    sawGrowth,
    maxArticleLikeCount,
    maxContentHeight,
    maxPageHeight,
    discoveredArticleLikeCount: discoveredArticleLikeKeys.size,
    grewArticleLikeCount,
    grewArticleLikeKeyCount,
    grewContentHeight,
    grewPageHeight,
    reachedBottom,
    ...(bestActiveLoadMoreText ? { bestActiveLoadMoreText } : {}),
    ...(bestActiveLoadMoreXPath ? { bestActiveLoadMoreXPath } : {})
  };
}

export async function captureScrollProbeSnapshot(page: Page): Promise<ScrollProbeSnapshot> {
  return page.evaluate(() => {
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const pageHeight = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement.clientHeight || 0
    );
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (element: Element): string => {
      if (element instanceof HTMLInputElement) return (element.value || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    };
    const attrText = (element: Element): string => {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('type') || ''
      ].join(' ');
    };
    const xpath = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    };
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const reliableLoadMoreText = (value: string): boolean => /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies|news|repositories|packages|issues|photos|videos))?)$/i.test(value.replace(/\s+/g, ' ').trim());
    const loadMoreAttribute = (value: string): boolean => /(?:^|[\s_-])load-?more(?:$|[\s_-])/i.test(value);
    const activeLoadMoreElements = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"],[role="button"],[onclick],[class*="load-more" i],[class*="loadmore" i]'))
      .filter(visible)
      .filter((element) => {
        const value = text(element);
        const attrs = attrText(element);
        const combined = `${value} ${attrs}`;
        const explicitAttribute = loadMoreAttribute(attrs);
        if (element.closest('[role="article"],[data-pagelet^="FeedUnit_"]')) return false;
        return (reliableLoadMoreText(value) || explicitAttribute) && !loadMoreEndPattern.test(combined);
      });
    const activeLoadMoreCount = activeLoadMoreElements.length;
    const activeLoadMoreTexts = activeLoadMoreElements
      .map((element) => text(element) || attrText(element))
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 3);
    const activeLoadMoreXPaths = activeLoadMoreElements
      .map((element) => xpath(element))
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 3);
    const feedUnits = Array.from(document.querySelectorAll('[role="feed"] [data-pagelet^="FeedUnit_"]'))
      .filter(visible)
      .filter((element) => text(element).length >= 24)
      .filter((element) => !element.parentElement?.closest('[data-pagelet^="FeedUnit_"]'));
    const genericArticleLike = Array.from(document.querySelectorAll('article,[role="article"],li,tr,[class*="result" i],[class*="item" i],[class*="article" i],[class*="card" i],[class*="blog" i]'))
      .filter(visible)
      .filter((element) => text(element).length >= 24)
      .filter((element) => !element.closest('[data-pagelet^="FeedUnit_"]'));
    const articleLikeElements = [...feedUnits, ...genericArticleLike]
      .filter((element, index, values) => values.indexOf(element) === index);
    const anonymousKey = (value: string): string => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    };
    const stableUrl = (value: string): string => {
      try {
        const parsed = new URL(value, document.baseURI || window.location.href);
        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/g, '');
      } catch {
        return value.replace(/[?#].*$/g, '').replace(/\/+$/g, '');
      }
    };
    const articleLikeKeys = articleLikeElements
      .map((element) => {
        const links = Array.from(element.querySelectorAll('a[href]'))
          .map((item) => item.getAttribute('href') || '')
          .filter(Boolean)
          .map(stableUrl)
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 3);
        const media = Array.from(element.querySelectorAll('img[src],video[src]'))
          .map((item) => item.getAttribute('src') || item.getAttribute('alt') || '')
          .filter(Boolean)
          .map(stableUrl)
          .slice(0, 2);
        const fallbackText = text(element).slice(0, 160).replace(/\b\d[\d.,]*\b/g, '#');
        return anonymousKey([
          element.tagName.toLowerCase(),
          links.join('|'),
          media.join('|'),
          links.length || media.length ? '' : fallbackText
        ].join('::'));
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 240);
    const articleLikeCount = articleLikeElements.length;
    const hasLoadingIndicator = Array.from(document.querySelectorAll([
      'progress',
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[aria-label*="loading" i]',
      '[class*="spinner" i]',
      '[class*="loader" i]',
      '[class*="loading" i]'
    ].join(','))).some(visible);
    const bodyTextLength = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
    return {
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      viewportHeight,
      pageHeight,
      contentHeight: bodyTextLength,
      articleLikeCount,
      articleLikeKeys,
      hasLoadingIndicator,
      activeLoadMoreCount,
      activeLoadMoreTexts,
      activeLoadMoreXPaths,
      hasActiveLoadMore: activeLoadMoreCount > 0,
      atBottom: (window.scrollY || document.documentElement.scrollTop || 0) + viewportHeight >= pageHeight - 32
    };
  });
}

export function scrollProbeStable(previous: ScrollProbeSnapshot, next: ScrollProbeSnapshot): boolean {
  if (previous.hasLoadingIndicator || next.hasLoadingIndicator) return false;
  const pageHeightStable = Math.abs(next.pageHeight - previous.pageHeight) < 80;
  const contentStable = Math.abs(next.contentHeight - previous.contentHeight) < 120;
  const previousKeys = new Set(previous.articleLikeKeys ?? []);
  const newKeyCount = (next.articleLikeKeys ?? []).filter((key) => !previousKeys.has(key)).length;
  const itemStable = Math.abs(next.articleLikeCount - previous.articleLikeCount) <= 1 && newKeyCount <= 1;
  return pageHeightStable && contentStable && itemStable;
}

async function waitForScrollLoadSettled(
  page: Page,
  baseline: ScrollProbeSnapshot,
  timeoutMs: number
): Promise<ScrollProbeSnapshot> {
  const deadline = Date.now() + timeoutMs;
  const baselineKeys = new Set(baseline.articleLikeKeys ?? []);
  let latest = baseline;
  while (Date.now() < deadline) {
    await delay(250);
    const snapshot = await captureScrollProbeSnapshot(page).catch(() => undefined);
    if (!snapshot) continue;
    latest = snapshot;
    const discoveredNewRecord = (snapshot.articleLikeKeys ?? []).some((key) => !baselineKeys.has(key));
    const documentGrew = snapshot.pageHeight >= baseline.pageHeight + 80
      || snapshot.contentHeight >= baseline.contentHeight + 120;
    if (discoveredNewRecord || documentGrew || !snapshot.hasLoadingIndicator) return snapshot;
  }
  return latest;
}

export async function waitForPageSettled(page: Page, waitMs: number): Promise<void> {
  await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', { timeout: waitMs }).catch(() => undefined);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await waitForLoadingPlaceholders(page, Math.max(1200, Math.min(5000, waitMs * 3))).catch(() => undefined);
}

export async function waitForLoadingPlaceholders(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  const hasLoading = await page.evaluate(() => {
    const text = ((document.body as HTMLElement | null)?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    return /\bloading\b|loading search results|加载中|正在加载|请稍候|please wait/i.test(text);
  }).catch(() => false);
  if (!hasLoading) return;
  await page.waitForFunction(() => {
    function text(element: Element | null | undefined): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const bodyText = text(document.body);
    const stillLoading = /\bloading\b|loading search results|加载中|正在加载|请稍候|please wait/i.test(bodyText);
    const likelyRows = Array.from(document.querySelectorAll('main article,main li,main [class*="result" i],main [class*="crate" i],main [class*="package" i],[role="main"] article,[role="main"] li,[role="main"] [class*="result" i]'))
      .filter(visible)
      .filter((element) => {
        const value = text(element);
        return value.length >= 24 && Boolean(element.querySelector('a'));
      });
    return !stillLoading || likelyRows.length >= 2;
  }, { timeout: timeoutMs, polling: 250 }).catch(() => undefined);
}
