import type { Browser, Page } from 'puppeteer-core';
import type { DetectOptions } from './types.js';
import type { NewPageWatcher } from './page-detector-shared.js';
import { delay } from './page-detector-utils.js';
import { waitForPageSettled } from './page-detector-scroll.js';
import { pageHasSearchLoginGate } from './page-detector-search.js';

/** Minimal host surface needed for multi-tab page adoption. */
export interface PageAdoptionHost {
  page: Page;
  browser(): Browser | undefined;
  usePage(page: Page): Promise<void>;
}

export async function adoptBestPageAfterLogin(host: PageAdoptionHost, options: DetectOptions): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  await delay(500);
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (!pages.length) return;
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    index,
    score: await scorePostLoginPage(page, options, index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === -Infinity) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

export async function scorePostLoginPage(page: Page, options: DetectOptions, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="login" i],[class*="passport" i],[class*="mask" i]')).some(visible);
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const searchInput = Array.from(document.querySelectorAll('input[type="search"],input[name="q"],input[name="wd"],input[name*="search" i],input[type="text"],textarea')).some(visible);
    const keyword = input.keyword.toLowerCase();
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1200)}`);
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 3;
    } catch {}
    if (!/login|signin|passport|sso|auth/i.test(url)) score += 1.4;
    else score -= 4;
    if (keyword && `${url} ${title} ${text}`.toLowerCase().includes(keyword)) score += 2;
    if (searchUrlLike) score += 3.2;
    if (resultSemantic) score += 2.2;
    if (resultBlocks.length >= 2) score += 2.5;
    if (searchInput) score += 1;
    if (input.keyword && exactEntryUrl) score -= 7;
    if (input.keyword && !searchUrlLike && !resultSemantic && contentDetailUrlLike(url)) score -= 8;
    if (loginInput || modal && /登录|登陆|注册|验证码|手机号|微信登录|扫码|login|sign in|register|verification/i.test(text)) score -= 5;
    score += input.index / Math.max(1, input.total) * 0.25;
    return score;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, {
    url: options.url,
    keyword: Object.values(options.input ?? {})[0] ?? '',
    index,
    total
  });
}

export async function adoptBestPageForSearchInput(host: PageAdoptionHost, options: DetectOptions): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (pages.length <= 1) return;
  await Promise.all(pages.map((page) => waitForPageSettled(page, Math.min(options.waitMs, 800)).catch(() => undefined)));
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    score: await scoreSearchInputPage(page, options, index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 1.2) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

export async function scoreSearchInputPage(page: Page, options: DetectOptions, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const editable = Array.from(document.querySelectorAll('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'))
      .filter(visible);
    const searchLikeInput = editable.some((element) => {
      const attrs = [
        element.localName,
        (element as HTMLElement).id,
        (element as HTMLElement).className,
        element.getAttribute('name') || '',
        element.getAttribute('type') || '',
        element.getAttribute('role') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('data-placeholder') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ');
      return /搜索|搜|查询|关键词|search|query|keyword|searchbox/i.test(attrs);
    });
    const loginInput = editable.some((element) => /password|tel|phone|mobile|code|验证码|手机|密码|login|signin/i.test([
      element.getAttribute('type') || '',
      element.getAttribute('name') || '',
      element.getAttribute('placeholder') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ')));
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
    const url = location.href;
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 1.2;
    } catch {}
    if (searchLikeInput) score += 2.2;
    else if (editable.length) score += 0.4;
    if (/搜索|查询|Search|search/i.test(text)) score += 0.4;
    if (/login|signin|passport|sso|auth/i.test(url) || loginInput) score -= 3.5;
    score += input.index / Math.max(1, input.total) * 0.15;
    return score;
  }, {
    url: options.url,
    index,
    total
  });
}

export async function adoptBestPageAfterSearch(host: PageAdoptionHost, options: DetectOptions, beforePages: Set<Page>): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  await delay(500);
  const deadline = Date.now() + Math.min(options.timeoutMs, 8000);
  let pages: Page[] = [];
  while (Date.now() < deadline) {
    pages = (await browser.pages()).filter((page) => !page.isClosed());
    if (pages.some((page) => !beforePages.has(page))) break;
    if (await pageLooksLikeSearchResult(host.page, options).catch(() => false)) break;
    await delay(250);
  }
  if (!pages.length) pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (!pages.length) return;
  await Promise.all(pages.map((page) => waitForPageSettled(page, Math.min(options.waitMs, 1200)).catch(() => undefined)));
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    score: await scoreSearchResultPage(page, options, !beforePages.has(page), index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 2.5) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

export async function scoreSearchResultPage(page: Page, options: DetectOptions, isNewPage: boolean, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4);
    const searchInput = Array.from(document.querySelectorAll('input[type="search"],input[name="q"],input[name="wd"],input[name*="search" i],input[type="text"],textarea')).some(visible);
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const keyword = input.keyword.toLowerCase();
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1200)}`);
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 2;
    } catch {}
    if (input.isNewPage) score += 1.5;
    if (keyword && `${url} ${title} ${text}`.toLowerCase().includes(keyword)) score += 2.4;
    if (searchUrlLike) score += 3.2;
    if (resultSemantic) score += 2.2;
    if (resultBlocks.length >= 2) score += 2.2;
    if (links.length >= 2) score += 0.8;
    if (searchInput && resultBlocks.length < 2) score -= 0.5;
    if (input.keyword && exactEntryUrl) score -= 7;
    if (input.keyword && !searchUrlLike && !resultSemantic && contentDetailUrlLike(url)) score -= 8;
    if (/login|signin|passport|sso|auth/i.test(url) || loginInput) score -= 5;
    score += input.index / Math.max(1, input.total) * 0.2;
    return score;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, {
    url: options.url,
    keyword: Object.values(options.input ?? {})[0] ?? '',
    isNewPage,
    index,
    total
  });
}

export function watchNewPage(browser: Browser | undefined, beforePages: Set<Page>, timeoutMs: number): NewPageWatcher {
  if (!browser) return Promise.resolve(undefined);
  let cancelWatcher: (() => void) | undefined;
  const watcher = new Promise<Page | undefined>((resolve) => {
    let settled = false;
    const finish = (page: Page | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off('targetcreated', onTargetCreated);
      resolve(page);
    };
    const timer = setTimeout(() => finish(undefined), Math.max(1000, timeoutMs));
    const onTargetCreated = async (target: { type?: () => string; page(): Promise<Page | null> }) => {
      if (settled) return;
      if (typeof target.type === 'function' && target.type() !== 'page') return;
      const page = await target.page?.().catch?.(() => undefined) ?? await target.page?.();
      if (!page || beforePages.has(page) || page.isClosed()) return;
      finish(page);
    };
    cancelWatcher = () => finish(undefined);
    browser.on('targetcreated', onTargetCreated);
  }) as NewPageWatcher;
  watcher.cancel = () => cancelWatcher?.();
  return watcher;
}

export async function adoptNewSearchPage(host: PageAdoptionHost, options: DetectOptions, newPagePromise: NewPageWatcher): Promise<void> {
  if (await pageLooksLikeSearchResult(host.page, options).catch(() => false) || await pageHasSearchLoginGate(host.page).catch(() => false)) {
    newPagePromise.cancel?.();
    return;
  }
  const quickTimeout = Math.max(350, Math.min(1200, options.waitMs));
  const page = await Promise.race([
    newPagePromise,
    delay(quickTimeout).then(() => undefined)
  ]);
  if (!page) newPagePromise.cancel?.();
  if (!page || page.isClosed()) return;
  await waitForPageSettled(page, Math.min(options.waitMs, 1500)).catch(() => undefined);
  const url = page.url();
  if (!url || /^about:blank$/i.test(url) || /^chrome-extension:/i.test(url)) return;
  const score = await scoreSearchResultPage(page, options, true, 0, 1).catch(() => -Infinity);
  if (score < 1.5) return;
  await host.usePage(page);
}

export async function pageLooksLikeSearchResult(page: Page, options: DetectOptions): Promise<boolean> {
  const keyword = Object.values(options.input ?? {})[0] ?? '';
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const keyword = input.keyword.toLowerCase();
    const keywordMatches = !keyword || `${url} ${title} ${text}`.toLowerCase().includes(keyword);
    if (!keywordMatches || resultBlocks.length < 2) return false;
    if (!keyword) return true;
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1600)}`);
    const resultClassBlocks = resultBlocks.filter((element) => {
      const attrs = [
        element.localName,
        (element as HTMLElement).id,
        (element as HTMLElement).className,
        element.getAttribute('role') || ''
      ].join(' ');
      return /search|result|query|list/i.test(attrs);
    });
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    if (exactEntryUrl && !resultSemantic && !searchUrlLike) return false;
    if (contentDetailUrlLike(url) && !searchUrlLike && !resultSemantic) return false;
    return searchUrlLike || resultSemantic || resultClassBlocks.length >= 2;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, { keyword, url: options.url }).catch(() => false);
}

export async function pageHasSubstantialSearchOrContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const contentBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4);
    return text.length >= 1200 && contentBlocks.length >= 3 && links.length >= 3;
  });
}

export async function detectLoginLikePage(page: Page): Promise<{ reason: string } | undefined> {
  return page.evaluate(() => {
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const url = location.href;
    const title = document.title || '';
    function visible(element: Element | null): boolean {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
    const phone = Array.from(document.querySelectorAll('input[type="tel"],input[name*="phone" i],input[name*="mobile" i]')).find(visible);
    const code = Array.from(document.querySelectorAll('input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="验证"]')).find(visible);
    const dataCandidates = document.querySelectorAll('article,main,section,table,ul,ol,[class*="list" i],[class*="result" i],[class*="content" i]');
    const links = Array.from(document.querySelectorAll('a')).filter((item) => (item.textContent || '').trim().length > 4);
    const hasSubstantialContent = text.length > 900 || dataCandidates.length >= 3 || links.length >= 8;
    if (/login|signin|passport|sso/i.test(url)) return { reason: 'url contains login/auth path' };
    if (!hasSubstantialContent && password) return { reason: 'visible password input found' };
    if (!hasSubstantialContent && phone && /登录|登陆|验证码|手机号|注册|login|sign in|verification/i.test(text)) return { reason: 'visible phone/code login form found' };
    if (!hasSubstantialContent && code && /登录|登陆|验证码|手机号|注册|login|sign in|verification/i.test(text)) return { reason: 'visible verification code input found' };
    if (!hasSubstantialContent && /登录|登陆|注册|手机号登录|扫码登录|微信登录|账号密码|sign in|log in|register/i.test(`${title} ${text}`) && text.length < 1200) {
      return { reason: 'login semantic text dominates page' };
    }
    return undefined;
  });
}

export async function scoreSearchResultPageForTesting(page: Page, options: DetectOptions, isNewPage = false, index = 0, total = 1): Promise<number> {
  return scoreSearchResultPage(page, options, isNewPage, index, total);
}

export async function pageLooksLikeSearchResultForTesting(page: Page, options: DetectOptions): Promise<boolean> {
  return pageLooksLikeSearchResult(page, options);
}
