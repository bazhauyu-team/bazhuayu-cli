import type { Page } from 'puppeteer-core';
import type { ScrollProbeSnapshot, ScrollProbeSummary } from './page-detector-shared.js';
import { delay } from './page-detector-utils.js';

export async function autoScroll(page: Page, scrolls: number): Promise<ScrollProbeSummary> {
  const maxScrolls = Math.max(0, scrolls);
  const snapshots: ScrollProbeSnapshot[] = [];
  let previous: ScrollProbeSnapshot | undefined;
  let stableCount = 0;
  const initial = await captureScrollProbeSnapshot(page).catch(() => undefined);
  if (initial) snapshots.push(initial);
  for (let index = 0; index < maxScrolls; index += 1) {
    await scrollPageByViewport(page).catch(() => undefined);
    await delay(350);
    const snapshot = await captureScrollProbeSnapshot(page).catch(() => undefined);
    if (!snapshot) continue;
    snapshots.push(snapshot);
    if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
      process.stderr.write(`[detect-debug] scroll probe ${index + 1}/${maxScrolls}: ${JSON.stringify(snapshot)}\n`);
    }
    if (snapshot.hasActiveLoadMore) {
      stableCount = 0;
      previous = snapshot;
      continue;
    }
    if (previous && scrollProbeStable(previous, snapshot)) stableCount += 1;
    else stableCount = 0;
    previous = snapshot;
    if (snapshot.atBottom || stableCount >= 2) break;
  }
  await scrollPageToTop(page).catch(() => undefined);
  const summary = summarizeScrollProbe(snapshots);
  if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
    process.stderr.write(`[detect-debug] scroll probe summary: ${JSON.stringify({ ...summary, snapshots: summary.snapshots.length })}\n`);
  }
  return summary;
}

export async function scrollPageByViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const viewport = window.innerHeight || document.documentElement.clientHeight || 800;
    const current = window.scrollY || root.scrollTop || 0;
    window.scrollTo({ top: current + Math.max(240, Math.floor(viewport * 0.86)), left: 0, behavior: 'instant' });
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
  const grewArticleLikeCount = first ? Math.max(0, maxArticleLikeCount - first.articleLikeCount) : 0;
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
    grewArticleLikeCount,
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
    const loadMorePattern = /(加载更多|查看更多|显示更多|点击加载|load more|show more|see more|loadmore|load-more)/i;
    const activeLoadMoreElements = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"],[role="button"],[onclick],[class*="load" i],[class*="more" i],span,div'))
      .filter(visible)
      .filter((element) => {
        const combined = `${text(element)} ${attrText(element)}`;
        return loadMorePattern.test(combined) && !loadMoreEndPattern.test(combined);
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
    const articleLikeCount = Array.from(document.querySelectorAll('article,li,tr,[class*="result" i],[class*="item" i],[class*="article" i],[class*="card" i],[class*="blog" i]'))
      .filter(visible)
      .filter((element) => text(element).length >= 24).length;
    const bodyTextLength = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
    return {
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      viewportHeight,
      pageHeight,
      contentHeight: bodyTextLength,
      articleLikeCount,
      activeLoadMoreCount,
      activeLoadMoreTexts,
      activeLoadMoreXPaths,
      hasActiveLoadMore: activeLoadMoreCount > 0,
      atBottom: (window.scrollY || document.documentElement.scrollTop || 0) + viewportHeight >= pageHeight - 32
    };
  });
}

export function scrollProbeStable(previous: ScrollProbeSnapshot, next: ScrollProbeSnapshot): boolean {
  const pageHeightStable = Math.abs(next.pageHeight - previous.pageHeight) < 80;
  const contentStable = Math.abs(next.contentHeight - previous.contentHeight) < 120;
  const itemStable = Math.abs(next.articleLikeCount - previous.articleLikeCount) <= 1;
  const stuck = Math.abs(next.scrollY - previous.scrollY) < 20;
  return (pageHeightStable && contentStable && itemStable) || stuck;
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

