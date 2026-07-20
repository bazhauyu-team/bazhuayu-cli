import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedPagination } from './types.js';
import type { ScrollProbeSummary } from './page-detector-shared.js';
import { delay, truncateText, xpathStringLiteral } from './page-detector-utils.js';

export function formatSelectedPagination(key: string | undefined, options: DetectedPagination[]): string {
  if (!key) return '单页采集';
  const option = options.find((item) => paginationKey(item) === key);
  if (!option) return key;
  const label = option.type === 'load_more' ? '加载更多' : option.type === 'scroll' ? '滚动加载' : '下一页';
  const mode = option.revealByScroll ? '，先滚动揭露' : '';
  const text = option.text ? ` "${truncateText(option.text, 28)}"` : '';
  return `${label}${mode}${text}，置信度 ${Math.round(option.confidence * 100)}%`;
}

export async function capturePaginationDiagnostics(page: Page): Promise<Array<{ tag: string; text: string; className: string; role: string; ariaLabel: string; title: string; xpath: string; rect: { top: number; left: number; width: number; height: number } }>> {
  return page.evaluate(() => {
    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === tag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const pattern = /(加载|更多|查看更多|更多结果|展开|下一页|next|more|load|show)/i;
    return Array.from(document.querySelectorAll('a,button,input,[role="button"],[onclick],div,span,li'))
      .filter(visible)
      .filter((element) => {
        const html = element as HTMLElement;
        const combined = [
          text(element),
          html.id,
          html.className,
          html.getAttribute('role'),
          html.getAttribute('aria-label'),
          html.getAttribute('title'),
          html.getAttribute('data-type'),
          html.getAttribute('data-name')
        ].join(' ');
        return pattern.test(combined);
      })
      .map((element) => {
        const html = element as HTMLElement;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.localName,
          text: text(element).slice(0, 80),
          className: String(html.className || '').slice(0, 120),
          role: html.getAttribute('role') || '',
          ariaLabel: html.getAttribute('aria-label') || '',
          title: html.getAttribute('title') || '',
          xpath: xpath(element),
          rect: {
            top: Math.round(rect.top + window.scrollY),
            left: Math.round(rect.left + window.scrollX),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .slice(-30);
  });
}

export async function preparePaginationDetectionViewport(page: Page, candidates: DetectedCandidate[]): Promise<(() => Promise<void>) | undefined> {
  const targets = candidates.map((candidate) => candidate.itemXPath || candidate.xpath).filter(Boolean);
  if (!targets.length) return undefined;
  const originalY = await page.evaluate(() => window.scrollY).catch(() => undefined);
  const scrollTargets = await page.evaluate((xpaths) => {
    function evaluateXPath(path: string): Element[] {
      try {
        const result = document.evaluate(path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const output: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) output.push(node);
        }
        return output;
      } catch {
        return [];
      }
    }
    const elements = xpaths.flatMap((xpath) => evaluateXPath(xpath)).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const pageBottom = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0
    ) - window.innerHeight;
    const targets: number[] = [];
    const bottom = Math.max(...elements.slice(0, 120).map((element) => element.getBoundingClientRect().bottom + window.scrollY));
    if (Number.isFinite(bottom)) targets.push(Math.max(0, Math.min(bottom - window.innerHeight * 0.45, pageBottom)));
    targets.push(Math.max(0, pageBottom - window.innerHeight * 0.15));
    return Array.from(new Set(targets.map((value) => Math.round(value)))).filter((value) => Math.abs(value - window.scrollY) >= 80);
  }, targets).catch(() => [] as number[]);
  if (!scrollTargets.length) return undefined;
  for (const targetY of scrollTargets.slice(0, 2)) {
    await page.evaluate((y) => window.scrollTo(0, y), targetY).catch(() => undefined);
    await delay(550);
  }
  return async () => {
    if (typeof originalY === 'number') {
      await page.evaluate((y) => window.scrollTo(0, y), originalY).catch(() => undefined);
    }
  };
}

export async function detectInteractivePaginationOptions(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination[]> {
  const selected = candidates.map((candidate) => ({
    id: candidate.id,
    xpath: candidate.xpath,
    itemXPath: candidate.itemXPath || candidate.xpath,
    type: candidate.type,
    itemCount: candidate.itemCount,
    pagination: candidate.pagination
  }));
  const detected = await page.evaluate((items) => {
    type PageOption = {
      type: 'next_page' | 'load_more' | 'scroll';
      xpath: string;
      text: string;
      confidence: number;
      isAjax: boolean;
      scope: 'near_list' | 'global';
      revealByScroll?: boolean;
      reasons: string[];
    };
    type ItemInfo = {
      id: string;
      xpath: string;
      itemXPath: string;
      type: string;
      itemCount: number;
    };
    const nextTextPattern = /^(下一页|下页|后一页|后页|next|>|›|»|→)$/i;
    const prevTextPattern = /^(上一页|上页|前一页|前页|prev|previous|<|‹|«|←)$/i;
    const loadMorePattern = /(加载更多|查看更多|显示更多|点击加载|load more|show more|see more)/i;
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const nextAttrPattern = /(next|pager-next|page-next|pagination-next|nextpage|btn-next|arrow-right)/i;
    const prevAttrPattern = /(prev|previous|pager-prev|page-prev|pagination-prev|btn-prev|arrow-left|left|disabled)/i;
    const pagerSelector = '[class*="pagination" i],[class*="pager" i],[class*="paginator" i],[class*="pagebar" i],[class*="page-nav" i],[class*="pages" i],[class*="el-pagination" i],[class*="ant-pagination" i],[class*="ivu-page" i],nav,ul,ol';
    const scanSelector = [
      'a',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[onclick]',
      '[class*="load" i]',
      '[class*="more" i]',
      '[aria-label*="more" i]',
      '[aria-label*="更多" i]',
      '[title*="more" i]',
      '[title*="更多" i]',
      'span',
      'div',
      'li'
    ].join(',');

    function text(element: Element | null): string {
      if (!element) return '';
      if (element instanceof HTMLInputElement) return (element.value || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('role'),
        html.getAttribute('rel'),
        html.getAttribute('aria-label'),
        html.getAttribute('title'),
        ...html.getAttributeNames().filter((name) => /^data-/i.test(name)).map((name) => html.getAttribute(name) || '')
      ].join(' ');
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function documentRect(element: Element): DOMRect {
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      return new DOMRect(rect.left + scrollX, rect.top + scrollY, rect.width, rect.height);
    }

    function xpath(element: Element): string {
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
    }

    function xpathLiteral(value: string): string {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat('${value.split("'").join(`',"'",'`)}')`;
    }

    function lowerXPath(expression: string): string {
      return `translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    }

    function safeNextPredicate(): string {
      const classExpr = lowerXPath('concat(" ", normalize-space(@class), " ")');
      const ariaExpr = lowerXPath('@aria-disabled');
      const textExpr = lowerXPath('normalize-space(.)');
      return [
        `not(contains(${classExpr}, " disabled "))`,
        `not(contains(${classExpr}, " prev "))`,
        `not(contains(${classExpr}, " previous "))`,
        `not(${ariaExpr}="true")`,
        `not(contains(${textExpr}, "没有更多"))`,
        `not(contains(${textExpr}, "暂无更多"))`,
        `not(contains(${textExpr}, "已到底"))`,
        `not(contains(${textExpr}, "到底了"))`,
        `not(contains(${textExpr}, "加载完毕"))`,
        `not(contains(${textExpr}, "no more"))`,
        `not(contains(${textExpr}, "all loaded"))`,
        `not(contains(${textExpr}, "end of"))`
      ].join(' and ');
    }

    function activeLoadMoreTextPredicate(): string {
      const textExpr = lowerXPath('normalize-space(.)');
      const positive = [
        `contains(${textExpr}, "加载更多")`,
        `contains(${textExpr}, "查看更多")`,
        `contains(${textExpr}, "显示更多")`,
        `contains(${textExpr}, "点击加载")`,
        `contains(${textExpr}, "load more")`,
        `contains(${textExpr}, "show more")`,
        `contains(${textExpr}, "see more")`
      ].join(' or ');
      const negative = [
        `not(contains(${textExpr}, "see more information"))`,
        `not(contains(${textExpr}, "more information about"))`,
        `not(contains(${textExpr}, "details about"))`,
        `not(contains(${textExpr}, "view details"))`,
        `not(contains(${textExpr}, "查看详情"))`,
        `not(contains(${textExpr}, "详细信息"))`
      ].join(' and ');
      return `(${positive}) and ${negative}`;
    }

    function loadMoreRecordExpanderText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalized) return false;
      return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:view|show)\s+details?\b/i.test(normalized)
        || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
    }

    function reliableLoadMoreText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 72 || loadMoreRecordExpanderText(normalized)) return false;
      return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(normalized);
    }

    function loadMoreState(element: Element): { active: boolean; hasText: boolean; end: boolean } {
      const value = text(element);
      const attrs = attrText(element);
      const combined = `${value} ${attrs}`;
      const hasText = reliableLoadMoreText(value);
      const hasAttr = /loadmore|load-more/i.test(attrs);
      const end = loadMoreEndPattern.test(combined);
      return { active: !end && !loadMoreRecordExpanderText(value) && (hasText || hasAttr), hasText, end };
    }

    function stablePaginationXPath(element: Element, type: 'next_page' | 'load_more', fallback: string): string {
      const tag = element.localName.toLowerCase();
      const value = text(element);
      const html = element as HTMLElement;
      const predicates: string[] = [];
      const safe = safeNextPredicate();
      const attrMatches = type === 'load_more'
        ? (raw: string) => /loadmore|load-more|more/i.test(raw)
        : (raw: string) => nextAttrPattern.test(raw) && !prevAttrPattern.test(raw);
      const textMatches = type === 'load_more'
        ? (raw: string) => reliableLoadMoreText(raw)
        : (raw: string) => nextTextPattern.test(raw) && !prevTextPattern.test(raw);
      const push = (predicate: string) => {
        const full = type === 'load_more'
          ? `${predicate} and (${activeLoadMoreTextPredicate()}) and ${safe}`
          : `${predicate} and ${safe}`;
        if (!predicates.includes(full)) predicates.push(full);
      };

      if (html.id && attrMatches(html.id)) push(`@id=${xpathLiteral(html.id)}`);
      for (const name of ['rel', 'aria-label', 'title', 'alt', 'value']) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      for (const token of Array.from(html.classList || [])) {
        if (attrMatches(token)) push(`contains(concat(" ", normalize-space(@class), " "), ${xpathLiteral(` ${token} `)})`);
      }
      for (const name of html.getAttributeNames().filter((item) => /^data-/i.test(item))) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      if (type === 'load_more' && reliableLoadMoreText(value)) {
        const textExpr = lowerXPath('normalize-space(.)');
        const positiveTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'load more', 'show more', 'see more'];
        push(`(${positiveTexts.map((item) => `contains(${textExpr}, ${xpathLiteral(item.toLowerCase())})`).join(' or ')})`);
      } else if (value && textMatches(value)) {
        push(`normalize-space(.)=${xpathLiteral(value)}`);
      }

      const section = element.closest(pagerSelector) || pagerGroupFor(element);
      const candidates: string[] = [];
      if (section) {
        const sectionXPath = xpath(section);
        candidates.push(...predicates.map((predicate) => `${sectionXPath}//${tag}[${predicate}]`));
      }
      candidates.push(...predicates.map((predicate) => `//${tag}[${predicate}]`));

      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.length === 1 && matches[0] === element) return candidate;
      }
      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.includes(element)) return candidate;
      }
      return fallback;
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
      try {
        const result = document.evaluate(normalized, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const output: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) output.push(node);
        }
        return output;
      } catch {
        return [];
      }
    }

    function firstClickable(element: Element): Element {
      if (/^(a|button|input)$/i.test(element.localName)) return element;
      return element.querySelector('a,button,input[type="button"],input[type="submit"]') || element;
    }

    function numericValue(element: Element): number | null {
      const value = text(element).match(/^\d{1,5}$/)?.[0];
      return value ? Number(value) : null;
    }

    function numericDescendants(element: Element): Element[] {
      return Array.from(element.querySelectorAll('a,button,input[type="button"],input[type="submit"],span,li,div'))
        .filter(visible)
        .filter((item) => numericValue(item) !== null);
    }

    function explicitPagerContext(element: Element): boolean {
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const attrs = attrText(current);
        if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs)) return true;
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) return true;
      }
      return false;
    }

    function horizontalFilterOrCarousel(element: Element, listRect: DOMRect | undefined): boolean {
      if (explicitPagerContext(element)) return false;
      const value = text(element);
      const box = documentRect(element);
      const arrowOnly = value === '' || /^[›»>→]$/.test(value);
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const html = current as HTMLElement;
        const attrsAndText = `${attrText(current)} ${(html.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260)}`;
        const horizontalScrollable = Number(html.scrollWidth || 0) > Number(html.clientWidth || box.width || 0) + 24;
        const filterLike = /(filter|filters|筛选|过滤|排序|sort|分类|category|categories|tag|tags|标签|tab|tabs|chip|chips|carousel|swiper|slider|横向|频道|导航|menu|dropdown|select|selector|员工人数|盈利情况|学生|行业|地区|公司|融资|规模|综合|最新|最热|推荐)/i.test(attrsAndText);
        if ((horizontalScrollable || filterLike) && arrowOnly) return true;
      }
      if (!listRect) return false;
      const aboveListEnd = box.bottom < listRect.bottom - Math.max(160, listRect.height * 0.18);
      return arrowOnly && aboveListEnd && /(arrow-right|right|next)/i.test(attrText(element));
    }

    function isAjax(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      const onclick = element.getAttribute('onclick') || element.getAttribute('onClick') || '';
      const attrs = attrText(element);
      return Boolean(onclick) || !href || href === '#' || href === '/' || /^javascript:/i.test(href) || /ajax|loadmore|load-more/i.test(attrs) || element.localName !== 'a';
    }

    function listRectFor(item: { xpath: string; itemXPath: string }): DOMRect | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 100);
      const roots = elements.length ? elements : evaluateXPath(item.xpath).filter(visible).slice(0, 1);
      if (!roots.length) return undefined;
      const rects = roots.map((element) => documentRect(element));
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    }

    function insideListItem(element: Element, item: ItemInfo): boolean {
      if (!item.itemXPath) return false;
      return evaluateXPath(item.itemXPath).slice(0, 160).some((row) => row === element || row.contains(element));
    }

    function commonListContainer(item: { xpath: string; itemXPath: string }): Element | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 100);
      if (elements.length >= 2) {
        let current: Element | null = elements[0].parentElement;
        while (current && current !== document.body) {
          if (elements.every((element) => current?.contains(element))) return current;
          current = current.parentElement;
        }
      }
      return evaluateXPath(item.xpath).find(visible) || elements[0];
    }

    function nearList(element: Element, rect?: DOMRect): boolean {
      if (!rect) return true;
      const box = documentRect(element);
      const below = box.top >= rect.top + Math.min(80, rect.height * 0.2);
      const close = box.top <= rect.bottom + Math.max(520, window.innerHeight * 0.9);
      const horizontal = box.right >= rect.left - 120 && box.left <= rect.right + 120;
      return below && close && horizontal;
    }

    function scrollRevealNeeded(item: ItemInfo | undefined, rect: DOMRect | undefined): boolean {
      if (!item || !rect) return false;
      const pageHeight = Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
      const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const longPage = pageHeight > viewportHeight * 1.8;
      const listLike = item.type === 'repeated_card' || item.type === 'search_results';
      const enoughItems = item.itemCount >= 12;
      const currentY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      const reachesViewportBottom = rect.bottom > currentY + viewportHeight * 0.55;
      return longPage && listLike && enoughItems && reachesViewportBottom;
    }

    function baseScore(element: Element, rect: DOMRect | undefined, scope: 'near_list' | 'global'): number {
      const box = documentRect(element);
      const viewportBox = element.getBoundingClientRect();
      let score = scope === 'near_list' ? 0.48 : 0.36;
      if (rect && box.top >= rect.bottom - 80 && box.top <= rect.bottom + Math.max(520, window.innerHeight * 0.9)) score += 0.18;
      if (element.closest(pagerSelector)) score += 0.12;
      if (viewportBox.top > window.innerHeight * 0.45 || viewportBox.top > 300) score += 0.06;
      return score;
    }

    function isPageSection(element: Element, listRect: DOMRect | undefined): boolean {
      if (!visible(element)) return false;
      const box = documentRect(element);
      if (listRect) {
        const withinBottomBand = box.top >= listRect.bottom - Math.max(120, listRect.height * 0.05)
          && box.top <= listRect.bottom + Math.max(720, window.innerHeight * 1.05);
        const compactPagerNearList = box.top >= listRect.top + Math.min(80, listRect.height * 0.2)
          && box.top <= listRect.bottom + Math.max(320, window.innerHeight * 0.45)
          && box.height <= 96;
        if (!withinBottomBand && !compactPagerNearList) return false;
      }
      const attrs = attrText(element);
      const numbers = numericDescendants(element);
      const sectionText = text(element);
      const hasPageAttr = /(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs);
      const hasPagerShape = numbers.length >= 2 && sectionText.length < 160;
      return hasPageAttr || hasPagerShape;
    }

    function findPageSectionInSubtree(element: Element, listRect: DOMRect | undefined, recursive = true): Element | undefined {
      for (const child of Array.from(element.children)) {
        if (child.nodeName.toLowerCase() === 'svg') continue;
        if (isPageSection(child, listRect)) return child;
        if (recursive) {
          const found = findPageSectionInSubtree(child, listRect, true);
          if (found) return found;
        }
      }
      return undefined;
    }

    function findNearPageSections(listContainer: Element | undefined, listRect: DOMRect | undefined): Element[] {
      if (!listContainer) return [];
      const output: Element[] = [];
      const push = (element: Element | undefined) => {
        if (element && !output.includes(element)) output.push(element);
      };

      const children = Array.from(listContainer.children);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.nodeName.toLowerCase() === 'svg') continue;
        if (isPageSection(child, listRect)) push(child);
        push(findPageSectionInSubtree(child, listRect, children.length - index < 3));
        if (output.length) return output;
      }

      let current: Element | null = listContainer;
      for (let level = 0; current && current.parentElement && current.parentElement !== document.body && level < 7; level += 1) {
        let sibling = current.nextElementSibling;
        while (sibling) {
          if (sibling.nodeName.toLowerCase() !== 'svg') {
            if (isPageSection(sibling, listRect)) push(sibling);
            const html = sibling as HTMLElement;
            const textLength = (html.innerText || sibling.textContent || '').trim().length;
            const htmlLength = html.innerHTML.length;
            if (!output.length && ((htmlLength > 10 && htmlLength < 2400) || textLength < 160)) {
              push(findPageSectionInSubtree(sibling, listRect, true));
            }
            if (output.length) return output;
          }
          sibling = sibling.nextElementSibling;
        }

        const currentText = ((current as HTMLElement).innerText || current.textContent || '').trim();
        const parentText = ((current.parentElement as HTMLElement).innerText || current.parentElement.textContent || '').trim();
        if (parentText.length - currentText.length > 700) break;
        current = current.parentElement;
      }
      return output;
    }

    function findBottomPagerSections(item: ItemInfo, listRect: DOMRect | undefined): Element[] {
      if (!listRect) return [];
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 160);
      const roots = [commonListContainer(item), evaluateXPath(item.xpath).find(visible), ...rows.map((row) => row.parentElement)]
        .filter((element): element is Element => Boolean(element));
      const output: Element[] = [];
      const push = (element: Element | undefined) => {
        if (element && !output.includes(element)) output.push(element);
      };
      const belowList = (element: Element): boolean => {
        const box = documentRect(element);
        return box.top >= listRect.top + Math.min(80, listRect.height * 0.2)
          && box.top <= listRect.bottom + Math.max(760, window.innerHeight * 1.15)
          && box.right >= listRect.left - 180
          && box.left <= listRect.right + 180;
      };

      for (const root of roots) {
        let current: Element | null = root;
        for (let level = 0; current && current !== document.body && level < 7; level += 1, current = current.parentElement) {
          const siblings = Array.from(current.parentElement?.children ?? []);
          const startIndex = siblings.indexOf(current) + 1;
          for (const sibling of siblings.slice(Math.max(0, startIndex), startIndex + 8)) {
            if (!(sibling instanceof Element) || !belowList(sibling)) continue;
            if (isPageSection(sibling, listRect)) push(sibling);
            push(findPageSectionInSubtree(sibling, listRect, true));
          }
        }
      }

      const candidates = Array.from(document.querySelectorAll('nav,ul,ol,div,span'))
        .filter((element): element is Element => element instanceof Element)
        .filter((element) => belowList(element))
        .filter((element) => isPageSection(element, listRect));
      for (const element of candidates) push(element);
      return output;
    }

    function optionFor(element: Element, type: 'next_page' | 'load_more', rect: DOMRect | undefined, scope: 'near_list' | 'global', reason: string, item?: ItemInfo): PageOption | null {
      const clickable = firstClickable(element);
      const value = text(clickable) || text(element);
      const attrs = `${attrText(element)} ${attrText(clickable)}`;
      if (prevTextPattern.test(value) || prevAttrPattern.test(attrs)) return null;
      let confidence = baseScore(clickable, rect, scope);
      const reasons = [reason];
      if (type === 'next_page') {
        const explicitNextText = nextTextPattern.test(value);
        const explicitNextAttr = nextAttrPattern.test(attrs);
        const inPager = Boolean(clickable.closest(pagerSelector)) || explicitPagerContext(clickable) || explicitPagerContext(element);
        if (horizontalFilterOrCarousel(clickable, rect) || horizontalFilterOrCarousel(element, rect)) return null;
        if (!explicitNextText && explicitNextAttr && !inPager && !explicitPagerContext(clickable)) confidence -= 0.24;
        if (!explicitNextText && explicitNextAttr && value.length > 20 && !inPager) return null;
        if (!explicitNextText && !explicitNextAttr && value.length > 20) return null;
        if (explicitNextText) confidence += 0.28;
        if (explicitNextAttr) confidence += 0.2;
        if (inPager) {
          confidence += 0.08;
          reasons.push('pager section context');
        }
      } else {
        const state = loadMoreState(element);
        if (!state.active) return null;
        if (state.hasText) confidence += 0.34;
        else confidence += 0.12;
      }
      if (value.length > 40) confidence -= 0.2;
      if (confidence < 0.5) return null;
      return {
        type,
        xpath: stablePaginationXPath(clickable, type, xpath(clickable)),
        text: value || clickable.getAttribute('aria-label') || clickable.getAttribute('title') || '',
        confidence: Math.min(0.98, confidence),
        isAjax: type === 'load_more' || isAjax(clickable),
        scope,
        ...(type === 'load_more' && scrollRevealNeeded(item, rect) ? { revealByScroll: true } : {}),
        reasons
      };
    }

    function pageButtonLike(element: Element): boolean {
      const value = text(element);
      const attrs = attrText(element);
      const box = element.getBoundingClientRect();
      if (numericValue(element) !== null) return true;
      if (nextTextPattern.test(value) || prevTextPattern.test(value)) return true;
      if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs)) return true;
      if (nextAttrPattern.test(attrs) && explicitPagerContext(element)) return true;
      if (value === '' && box.width <= 96 && box.height <= 72) return true;
      if (/^[›»>→]$/.test(value)) return true;
      return value.length > 0 && value.length <= 8 && box.width <= 120 && box.height <= 80;
    }

    function pagerArrowOptions(elements: Element[], rect: DOMRect | undefined, scope: 'near_list' | 'global', sourceItem?: ItemInfo): PageOption[] {
      const sections = new Map<Element, Element[]>();
      for (const element of elements) {
        if (numericValue(element) === null) continue;
        const section = pagerGroupFor(element);
        if (!section) continue;
        sections.set(section, [...(sections.get(section) ?? []), element]);
      }
      const output: PageOption[] = [];
      for (const [section, nums] of sections) {
        if (nums.length < 2) continue;
        const orderedNums = nums
          .map((element) => ({ element, rect: documentRect(element) }))
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        const lastNum = orderedNums[orderedNums.length - 1];
        const centerY = lastNum.rect.top + lastNum.rect.height / 2;
        const candidates = Array.from(section.querySelectorAll(scanSelector))
          .filter(visible)
          .map((element) => ({ element, clickable: firstClickable(element), rect: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => {
            if (!pageButtonLike(item.element) && !pageButtonLike(item.clickable)) return false;
            if (numericValue(item.element) !== null) return false;
            if (prevTextPattern.test(item.value) || prevAttrPattern.test(item.attrs)) return false;
            if (item.value === '...' || item.value === '…') return false;
            const sameLine = Math.abs((item.rect.top + item.rect.height / 2) - centerY) < Math.max(24, lastNum.rect.height);
            const afterNumbers = item.rect.left >= lastNum.rect.right - 4;
            return sameLine && afterNumbers;
          })
          .sort((a, b) => a.rect.left - b.rect.left);
        const arrow = candidates.find((item) => nextTextPattern.test(item.value) || nextAttrPattern.test(`${item.attrs} ${attrText(item.clickable)}`));
        if (!arrow) continue;
        const option = optionFor(arrow.clickable, 'next_page', rect, scope, 'pager arrow after numeric pages', sourceItem);
        if (option) output.push({ ...option, confidence: Math.max(option.confidence, 0.82) });
      }
      return output;
    }

    function pagerGroupFor(element: Element): Element | undefined {
      let current: Element | null = element.parentElement;
      let best: Element | undefined;
      for (let level = 0; current && current !== document.body && level < 5; level += 1) {
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) {
          best = current;
        }
        if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrText(current))) {
          best = current;
          break;
        }
        current = current.parentElement;
      }
      return best || element.parentElement || undefined;
    }

    function scan(item: ItemInfo | undefined, rect: DOMRect | undefined, scope: 'near_list' | 'global'): PageOption[] {
      const elements = Array.from(document.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((element) => item ? !insideListItem(element, item) : true)
        .filter((element) => nearList(element, rect));
      const output: PageOption[] = [];
      for (const element of elements) {
        const value = text(element);
        const attrs = attrText(element);
        if (loadMoreState(element).active) {
          const option = optionFor(element, 'load_more', rect, scope, 'load-more text or attributes', item);
          if (option) output.push(option);
        }
        if (nextTextPattern.test(value) || (nextAttrPattern.test(attrs) && value.length <= 20)) {
          const option = optionFor(element, 'next_page', rect, scope, 'next-page text or attributes', item);
          if (option) output.push(option);
        }
      }
      output.push(...pagerArrowOptions(elements, rect, scope, item));
      return output;
    }

    function paginationEvidenceWeight(option: PageOption): number {
      const reasons = option.reasons.join(' ');
      return (/pager arrow after numeric pages/i.test(reasons) ? 0.06 : 0)
        + (/numeric pager sequence/i.test(reasons) ? 0.04 : 0)
        + (/pager section context/i.test(reasons) ? 0.02 : 0);
    }

    const output: PageOption[] = [];
    for (const item of items) {
      const rect = listRectFor(item);
      output.push(...scan(item, rect, 'near_list'));
      const listContainer = commonListContainer(item);
      for (const section of [...findNearPageSections(listContainer, rect), ...findBottomPagerSections(item, rect)]) {
        const sectionElements = Array.from(section.querySelectorAll('a,button,input[type="button"],input[type="submit"],span,div,li'))
          .filter(visible)
          .filter((element) => pageButtonLike(element) || pageButtonLike(firstClickable(element)));
        output.push(...pagerArrowOptions(sectionElements, rect, 'near_list', item));
        const lastButton = sectionElements
          .map((element) => ({ element, box: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => numericValue(item.element) === null)
          .filter((item) => !prevTextPattern.test(item.value) && !prevAttrPattern.test(item.attrs))
          .filter((item) => item.value !== '...' && item.value !== '…')
          .sort((a, b) => b.box.left - a.box.left)[0];
        if (lastButton) {
          const option = optionFor(lastButton.element, 'next_page', rect, 'near_list', 'last button in near pager section', item);
          if (option) output.push({ ...option, confidence: Math.max(option.confidence, 0.78) });
        }
      }
    }
    const globalOptions = scan(undefined, undefined, 'global');
    output.push(...globalOptions.filter((option) => option.type === 'load_more' || /pager|numeric/i.test(option.reasons.join(' '))));
    if (!output.length) output.push(...globalOptions);
    return output
      .sort((a, b) => (b.confidence + paginationEvidenceWeight(b)) - (a.confidence + paginationEvidenceWeight(a)))
      .filter((option, index, array) => array.findIndex((item) => item.xpath === option.xpath) === index)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
  }, selected) as DetectedPagination[];

  const existing = selected
    .map((item) => item.pagination && !scrollProbeRulesOutScroll(item, scrollProbe) ? item.pagination : undefined)
    .filter((pagination): pagination is DetectedPagination => Boolean(pagination));
  const probeDetected = Object.values(scrollProbePaginationForCandidates(candidates, scrollProbe));
  return [...detected, ...existing, ...probeDetected]
    .filter(isPlausiblePaginationOption)
    .filter((pagination, index, array) => {
      const key = paginationKey(pagination);
      return pagination.type === 'scroll' || array.findIndex((item) => paginationKey(item) === key) === index;
    })
    .sort(comparePaginationOptions);
}

export async function installPaginationOverlay(page: Page, paginations: DetectedPagination[]): Promise<void> {
  const overlayPaginations = paginations.map((pagination) => ({
    key: paginationKey(pagination),
    type: pagination.type,
    xpath: pagination.xpath,
    text: pagination.text,
    confidence: pagination.confidence
  }));
  await page.evaluate((items) => {
    const w = window as typeof window & {
      __octopusPaginationSelection?: string;
      __octopusPaginationClearSelection?: () => void;
      __octopusPaginationCleanup?: () => void;
    };
    w.__octopusPaginationCleanup?.();
    document.getElementById('octopus-pagination-overlay-root')?.remove();
    w.__octopusPaginationSelection = undefined;

    const root = document.createElement('div');
    root.id = 'octopus-pagination-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'visible';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483600';
    document.documentElement.appendChild(root);

    const highlighted: HTMLElement[] = [];
    const labelEntries: Array<{ element: Element; label: HTMLElement; key: string }> = [];
    const byElement = new WeakMap<Element, string>();
    let selectedKey = items[0]?.key || '';

    function evaluateXPath(xpath: string): Element[] {
      if (!xpath) return [];
      try {
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const output: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) output.push(node);
        }
        return output;
      } catch {
        return [];
      }
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function labelFor(type: string): string {
      if (type === 'next_page') return 'PAGE';
      if (type === 'load_more') return 'MORE';
      if (type === 'scroll') return 'SCROLL';
      return 'PAGE';
    }

    function syncStyles(): void {
      highlighted.forEach((element) => {
        const key = byElement.get(element);
        const selected = key === selectedKey;
        element.style.outline = `${selected ? 5 : 3}px solid #f97316`;
        element.style.outlineOffset = '-2px';
        element.style.backgroundColor = selected ? 'rgba(249,115,22,.28)' : 'rgba(249,115,22,.14)';
        element.style.boxShadow = selected ? '0 0 0 2px rgba(249,115,22,.45)' : '';
      });
      labelEntries.forEach(({ label, key }) => {
        const selected = key === selectedKey;
        label.style.transform = selected ? 'scale(1.08)' : '';
        label.style.filter = selected ? 'saturate(1.35)' : '';
      });
      w.__octopusPaginationSelection = selectedKey || undefined;
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        label.style.display = offscreen ? 'none' : '';
        label.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, rect.left))}px`;
        label.style.top = `${Math.max(0, Math.min(window.innerHeight - 22, rect.top - 24))}px`;
      });
    }

    function drawBox(element: Element, key: string, labelText: string): void {
      const html = element as HTMLElement;
      html.dataset.octopusPaginationOutline = html.style.outline;
      html.dataset.octopusPaginationOutlineOffset = html.style.outlineOffset;
      html.dataset.octopusPaginationBackground = html.style.backgroundColor;
      html.dataset.octopusPaginationBoxShadow = html.style.boxShadow;
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      byElement.set(element, key);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 24)}px`;
      label.style.background = '#f97316';
      label.style.color = '#fff';
      label.style.font = '700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '4px 7px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,.2)';
      root.appendChild(label);
      labelEntries.push({ element, label, key });
    }

    items.forEach((item, index) => {
      if (item.type === 'scroll') {
        const scrollTarget = document.scrollingElement || document.documentElement;
        drawBox(scrollTarget, item.key, `${labelFor(item.type)} ${index + 1}`);
        return;
      }
      const element = evaluateXPath(item.xpath).find(visible);
      if (!element) return;
      drawBox(element, item.key, `${labelFor(item.type)} ${index + 1}`);
    });
    syncStyles();
    positionLabels();

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const key = byElement.get(target);
      if (!key) return;
      selectedKey = key;
      syncStyles();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusPaginationClearSelection = () => {
      selectedKey = '';
      syncStyles();
    };
    w.__octopusPaginationCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusPaginationOutline || '';
        element.style.outlineOffset = element.dataset.octopusPaginationOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusPaginationBackground || '';
        element.style.boxShadow = element.dataset.octopusPaginationBoxShadow || '';
        element.style.cursor = '';
        delete element.dataset.octopusPaginationOutline;
        delete element.dataset.octopusPaginationOutlineOffset;
        delete element.dataset.octopusPaginationBackground;
        delete element.dataset.octopusPaginationBoxShadow;
      });
      root.remove();
      delete w.__octopusPaginationSelection;
      delete w.__octopusPaginationClearSelection;
      delete w.__octopusPaginationCleanup;
    };
  }, overlayPaginations);
}

export async function readPaginationOverlaySelection(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationSelection?: string };
    return w.__octopusPaginationSelection;
  });
}

export async function clearPaginationOverlaySelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationClearSelection?: () => void };
    w.__octopusPaginationClearSelection?.();
  });
}

export async function removePaginationOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationCleanup?: () => void };
    w.__octopusPaginationCleanup?.();
  });
}

export function paginationKey(pagination: DetectedPagination): string {
  return `${pagination.type}:${pagination.xpath || pagination.text}`;
}

export async function detectPaginationForCandidatesForTesting(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  return detectPaginationForCandidates(page, candidates, scrollProbe);
}

export function sanitizeCandidatePaginationByLayoutForTesting(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return sanitizeCandidatePaginationByLayout(candidates);
}

export async function detectInteractivePaginationOptionsForTesting(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination[]> {
  return detectInteractivePaginationOptions(page, candidates, scrollProbe);
}

export function isPlausiblePaginationOptionForTesting(pagination: DetectedPagination): boolean {
  return isPlausiblePaginationOption(pagination);
}

export function preferredPaginationForTesting(existing: DetectedPagination | undefined, detected: DetectedPagination | undefined): DetectedPagination | undefined {
  return preferredPagination(existing, detected);
}

export async function detectPaginationForCandidates(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      type: candidate.type,
      itemCount: candidate.itemCount
    }));
  if (!input.length) return candidates;
  const paginationById = await page.evaluate((items) => {
    type PageCandidate = {
      type: 'next_page' | 'load_more' | 'scroll';
      xpath: string;
      text: string;
      confidence: number;
      isAjax: boolean;
      scope: 'near_list' | 'global';
      revealByScroll?: boolean;
      reasons: string[];
    };
    type ItemInfo = {
      id: string;
      xpath: string;
      itemXPath: string;
      type: string;
      itemCount: number;
    };
    const nextTexts = ['下一页', '下页', '后一页', '后页', 'Next', 'next', '>', '›', '»', '→'];
    const prevTextPattern = /^(上一页|上页|前一页|前页|prev|previous|<|‹|«|←)$/i;
    const loadMoreTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'Load more', 'Show more', 'See more'];
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const nextClassPattern = /(next|pager-next|page-next|pagination-next|nextpage|btn-next|arrow-right)/i;
    const pagerClassPattern = /(pager|pagination|page-nav|pagebar|pages|paginator|el-pagination|ant-pagination|ivu-page)/i;
    const activeClassPattern = /(active|current|selected|on|cur|is-active|disabled)/i;
    const excludedClassPattern = /(prev|previous|disabled|ellipsis|more-prev|jump-prev)/i;
    const scanSelector = [
      'a',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[onclick]',
      '[class*="load" i]',
      '[class*="more" i]',
      '[aria-label*="more" i]',
      '[aria-label*="更多" i]',
      '[title*="more" i]',
      '[title*="更多" i]',
      'span',
      'div',
      'li'
    ].join(',');

    function text(element: Element | null): string {
      if (!element) return '';
      if (element instanceof HTMLInputElement) return (element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('rel'),
        html.getAttribute('aria-label'),
        html.getAttribute('title'),
        ...html.getAttributeNames().filter((name) => /^data-/i.test(name)).map((name) => html.getAttribute(name) || '')
      ].join(' ');
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function documentRect(element: Element): DOMRect {
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      return new DOMRect(rect.left + scrollX, rect.top + scrollY, rect.width, rect.height);
    }

    function xpath(element: Element): string {
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
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
      try {
        const result = document.evaluate(normalized, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const output: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) output.push(node);
        }
        return output;
      } catch {
        return [];
      }
    }

    function isAjax(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      const onclick = element.getAttribute('onclick') || element.getAttribute('onClick') || '';
      const combined = `${attrText(element)} ${onclick}`;
      return Boolean(onclick)
        || !href
        || href === '#'
        || href === '/'
        || /^javascript:/i.test(href)
        || /ajax|load-more|loadmore|fetch|api/i.test(combined)
        || !/^(a)$/i.test(element.localName);
    }

    function firstClickable(element: Element): Element {
      if (/^(a|button|input)$/i.test(element.localName)) return element;
      const child = element.querySelector('a,button,input[type="button"],input[type="submit"]');
      return child || element;
    }

    function numericValue(element: Element): number | null {
      const value = text(element).match(/^\d{1,5}$/)?.[0];
      return value ? Number(value) : null;
    }

    function numericDescendants(element: Element): Element[] {
      return Array.from(element.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((item) => numericValue(item) !== null);
    }

    function explicitPagerContext(element: Element): boolean {
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        if (pagerClassPattern.test(attrText(current))) return true;
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) return true;
      }
      return false;
    }

    function horizontalFilterOrCarousel(element: Element, listRect?: DOMRect): boolean {
      if (explicitPagerContext(element)) return false;
      const value = text(element);
      const rect = documentRect(element);
      const arrowOnly = value === '' || /^[›»>→]$/.test(value);
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const html = current as HTMLElement;
        const attrsAndText = `${attrText(current)} ${(html.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260)}`;
        const horizontalScrollable = Number(html.scrollWidth || 0) > Number(html.clientWidth || rect.width || 0) + 24;
        const filterLike = /(filter|filters|筛选|过滤|排序|sort|分类|category|categories|tag|tags|标签|tab|tabs|chip|chips|carousel|swiper|slider|频道|导航|menu|dropdown|select|selector|员工人数|盈利情况|学生|行业|地区|公司|融资|规模|综合|最新|最热|推荐)/i.test(attrsAndText);
        if ((horizontalScrollable || filterLike) && arrowOnly) return true;
      }
      if (!listRect) return false;
      const aboveListEnd = rect.bottom < listRect.bottom - Math.max(160, listRect.height * 0.18);
      return arrowOnly && aboveListEnd && /(arrow-right|right|next)/i.test(attrText(element));
    }

    function xpathLiteral(value: string): string {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat('${value.split("'").join(`',"'",'`)}')`;
    }

    function lowerXPath(expression: string): string {
      return `translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    }

    function safeNextPredicate(): string {
      const classExpr = lowerXPath('concat(" ", normalize-space(@class), " ")');
      const ariaExpr = lowerXPath('@aria-disabled');
      const textExpr = lowerXPath('normalize-space(.)');
      return [
        `not(contains(${classExpr}, " disabled "))`,
        `not(contains(${classExpr}, " prev "))`,
        `not(contains(${classExpr}, " previous "))`,
        `not(${ariaExpr}="true")`,
        `not(contains(${textExpr}, "没有更多"))`,
        `not(contains(${textExpr}, "暂无更多"))`,
        `not(contains(${textExpr}, "已到底"))`,
        `not(contains(${textExpr}, "到底了"))`,
        `not(contains(${textExpr}, "加载完毕"))`,
        `not(contains(${textExpr}, "no more"))`,
        `not(contains(${textExpr}, "all loaded"))`,
        `not(contains(${textExpr}, "end of"))`
      ].join(' and ');
    }

    function activeLoadMoreTextPredicate(): string {
      const textExpr = lowerXPath('normalize-space(.)');
      const positive = [
        `contains(${textExpr}, "加载更多")`,
        `contains(${textExpr}, "查看更多")`,
        `contains(${textExpr}, "显示更多")`,
        `contains(${textExpr}, "点击加载")`,
        `contains(${textExpr}, "load more")`,
        `contains(${textExpr}, "show more")`,
        `contains(${textExpr}, "see more")`
      ].join(' or ');
      const negative = [
        `not(contains(${textExpr}, "see more information"))`,
        `not(contains(${textExpr}, "more information about"))`,
        `not(contains(${textExpr}, "details about"))`,
        `not(contains(${textExpr}, "view details"))`,
        `not(contains(${textExpr}, "查看详情"))`,
        `not(contains(${textExpr}, "详细信息"))`
      ].join(' and ');
      return `(${positive}) and ${negative}`;
    }

    function loadMoreRecordExpanderText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalized) return false;
      return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:view|show)\s+details?\b/i.test(normalized)
        || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
    }

    function reliableLoadMoreText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 72 || loadMoreRecordExpanderText(normalized)) return false;
      return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(normalized);
    }

    function loadMoreState(element: Element): { active: boolean; hasText: boolean; end: boolean } {
      const value = text(element);
      const attrs = attrText(element);
      const combined = `${value} ${attrs}`;
      const hasText = reliableLoadMoreText(value);
      const hasAttr = /loadmore|load-more/i.test(attrs);
      const end = loadMoreEndPattern.test(combined);
      return { active: !end && !loadMoreRecordExpanderText(value) && (hasText || hasAttr), hasText, end };
    }

    function pagerGroupForStableXPath(element: Element): Element | undefined {
      let current: Element | null = element.parentElement;
      let best: Element | undefined;
      for (let level = 0; current && current !== document.body && level < 5; level += 1) {
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) best = current;
        if (pagerClassPattern.test(attrText(current))) {
          best = current;
          break;
        }
        current = current.parentElement;
      }
      return best || element.parentElement || undefined;
    }

    function stablePaginationXPath(element: Element, type: 'next_page' | 'load_more', fallback: string): string {
      const tag = element.localName.toLowerCase();
      const value = text(element);
      const html = element as HTMLElement;
      const predicates: string[] = [];
      const safe = safeNextPredicate();
      const attrMatches = type === 'load_more'
        ? (raw: string) => /loadmore|load-more|more/i.test(raw)
        : (raw: string) => nextClassPattern.test(raw) && !excludedClassPattern.test(raw);
      const textMatches = type === 'load_more'
        ? (raw: string) => reliableLoadMoreText(raw) || /loadmore|load-more/i.test(raw)
        : (raw: string) => nextTexts.some((item) => raw === item || raw.toLowerCase() === item.toLowerCase()) && !prevTextPattern.test(raw);
      const push = (predicate: string) => {
        const full = type === 'load_more'
          ? `${predicate} and (${activeLoadMoreTextPredicate()}) and ${safe}`
          : `${predicate} and ${safe}`;
        if (!predicates.includes(full)) predicates.push(full);
      };

      if (html.id && attrMatches(html.id)) push(`@id=${xpathLiteral(html.id)}`);
      for (const name of ['rel', 'aria-label', 'title', 'alt', 'value']) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      for (const token of Array.from(html.classList || [])) {
        if (attrMatches(token)) push(`contains(concat(" ", normalize-space(@class), " "), ${xpathLiteral(` ${token} `)})`);
      }
      for (const name of html.getAttributeNames().filter((item) => /^data-/i.test(item))) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      if (type === 'load_more' && reliableLoadMoreText(value)) {
        const textExpr = lowerXPath('normalize-space(.)');
        const positiveTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'load more', 'show more', 'see more'];
        push(`(${positiveTexts.map((item) => `contains(${textExpr}, ${xpathLiteral(item.toLowerCase())})`).join(' or ')})`);
      } else if (value && textMatches(value)) {
        push(`normalize-space(.)=${xpathLiteral(value)}`);
      }

      const section = element.closest('[class*="pagination" i],[class*="pager" i],nav,ul,ol') || pagerGroupForStableXPath(element);
      const candidates: string[] = [];
      if (section) {
        const sectionXPath = xpath(section);
        candidates.push(...predicates.map((predicate) => `${sectionXPath}//${tag}[${predicate}]`));
      }
      candidates.push(...predicates.map((predicate) => `//${tag}[${predicate}]`));

      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.length === 1 && matches[0] === element) return candidate;
      }
      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.includes(element)) return candidate;
      }
      return fallback;
    }

    function samePagerGroup(elements: Element[]): Element[][] {
      const map = new Map<Element, Element[]>();
      for (const element of elements) {
        const parent = element.parentElement || element;
        const section = element.closest('[class*="pagination" i],[class*="pager" i],nav,ul,ol') || parent;
        map.set(section, [...(map.get(section) ?? []), element]);
      }
      return Array.from(map.values());
    }

    function scoreButton(element: Element, kind: 'next_page' | 'load_more', listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): number {
      const rect = documentRect(element);
      const viewportRect = element.getBoundingClientRect();
      const value = text(element);
      const attrs = attrText(element);
      if (kind === 'next_page' && horizontalFilterOrCarousel(element, listRect)) return 0;
      let score = scope === 'near_list' ? 0.42 : 0.32;
      if (kind === 'next_page') {
        if (nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase())) score += 0.34;
        if (nextClassPattern.test(attrs)) score += 0.2;
        if (!nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase()) && nextClassPattern.test(attrs) && !explicitPagerContext(element)) score -= 0.24;
        if (element.closest('[class*="pagination" i],[class*="pager" i],nav[aria-label*="pagination" i]')) score += 0.12;
        else if (explicitPagerContext(element)) score += 0.1;
      } else {
        const state = loadMoreState(element);
        if (!state.active) return 0;
        if (state.hasText) score += 0.34;
        else score += 0.08;
        if (/(load-more|loadmore)/i.test(attrs)) score += 0.16;
      }
      if (listRect) {
        const below = rect.top >= listRect.top + Math.min(80, listRect.height * 0.25);
        const close = rect.top <= listRect.bottom + Math.max(260, window.innerHeight * 0.7);
        const overlap = rect.right >= listRect.left && rect.left <= listRect.right;
        if (below && close) score += 0.18;
        if (overlap) score += 0.08;
      } else if (viewportRect.top > window.innerHeight * 0.5 || viewportRect.top > 320) {
        score += 0.08;
      }
      if (prevTextPattern.test(value) || excludedClassPattern.test(attrs)) score -= 0.45;
      if (value.length > 40) score -= 0.2;
      if (element.closest('header,footer')) score -= 0.16;
      return Math.max(0, Math.min(0.98, score));
    }

    function findNumericNext(elements: Element[], listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): PageCandidate | null {
      for (const group of samePagerGroup(elements)) {
        const nums = group
          .map((element) => ({ element, num: numericValue(element), cls: attrText(element), rect: documentRect(element) }))
          .filter((item): item is { element: Element; num: number; cls: string; rect: DOMRect } => item.num !== null)
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top || a.num - b.num);
        if (nums.length < 2) continue;
        let activeIndex = nums.findIndex((item) => activeClassPattern.test(item.cls) || item.element.getAttribute('aria-current') === 'page');
        if (activeIndex === -1 && nums[0]?.num === 1) activeIndex = 0;
        if (activeIndex < 0 || activeIndex >= nums.length - 1) continue;
        const lastNumRect = nums[nums.length - 1].rect;
        const centerY = lastNumRect.top + lastNumRect.height / 2;
        const arrow = group
          .map((element) => ({ element, clickable: firstClickable(element), rect: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => numericValue(item.element) === null)
          .filter((item) => !prevTextPattern.test(item.value) && !excludedClassPattern.test(item.attrs))
          .filter((item) => item.value !== '...' && item.value !== '…')
          .filter((item) => Math.abs((item.rect.top + item.rect.height / 2) - centerY) < Math.max(24, lastNumRect.height))
          .filter((item) => item.rect.left >= lastNumRect.right - 4)
          .sort((a, b) => a.rect.left - b.rect.left)
          .find((item) => nextTexts.some((value) => item.value === value || item.value.toLowerCase() === value.toLowerCase()) || nextClassPattern.test(`${item.attrs} ${attrText(item.clickable)}`));
        const target = arrow ? firstClickable(arrow.clickable) : firstClickable(nums[activeIndex + 1].element);
        const confidence = scoreButton(target, 'next_page', listRect, scope) + 0.08;
        if (confidence < 0.5) continue;
        return {
          type: 'next_page',
          xpath: stablePaginationXPath(target, 'next_page', xpath(target)),
          text: text(target),
          confidence: Math.min(0.98, arrow ? Math.max(confidence, 0.84) : confidence),
          isAjax: isAjax(target),
          scope,
          reasons: arrow ? ['pager arrow after numeric pages', 'numeric pager sequence'] : ['numeric pager sequence']
        };
      }
      return null;
    }

    function insideListItem(element: Element, item: ItemInfo): boolean {
      if (!item.itemXPath) return false;
      return evaluateXPath(item.itemXPath).slice(0, 160).some((row) => row === element || row.contains(element));
    }

    function findButtons(item?: ItemInfo, listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): PageCandidate[] {
      const elements = Array.from(document.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((element) => item ? !insideListItem(element, item) : true)
        .filter((element) => {
          if (!listRect) return true;
          const rect = documentRect(element);
          const belowListStart = rect.top >= listRect.top + Math.min(80, listRect.height * 0.2);
          const notTooFar = rect.top <= listRect.bottom + Math.max(360, window.innerHeight);
          const horizontalNear = rect.right >= listRect.left - 80 && rect.left <= listRect.right + 80;
          return belowListStart && notTooFar && horizontalNear;
        });
      const output: PageCandidate[] = [];
      for (const element of elements) {
        const value = text(element);
        const attrs = attrText(element);
        const clickable = firstClickable(element);
        if (loadMoreState(element).active) {
          const confidence = scoreButton(clickable, 'load_more', listRect, scope);
          if (confidence >= 0.52) {
            output.push({
              type: 'load_more',
              xpath: stablePaginationXPath(clickable, 'load_more', xpath(clickable)),
              text: value,
              confidence,
              isAjax: true,
              scope,
              reasons: ['load-more text or attributes']
            });
          }
          continue;
        }
        if ((nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase()) || nextClassPattern.test(attrs)) && !horizontalFilterOrCarousel(clickable, listRect)) {
          const confidence = scoreButton(clickable, 'next_page', listRect, scope);
          if (confidence >= 0.5) {
            output.push({
              type: 'next_page',
              xpath: stablePaginationXPath(clickable, 'next_page', xpath(clickable)),
              text: value || clickable.getAttribute('aria-label') || clickable.getAttribute('title') || '',
              confidence,
              isAjax: isAjax(clickable),
              scope,
              reasons: ['next-page text or attributes']
            });
          }
        }
      }
      const numeric = findNumericNext(elements, listRect, scope);
      if (numeric) output.push(numeric);
      return output;
    }

    function listRectFor(item: { xpath: string; itemXPath: string }): DOMRect | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 80);
      if (!elements.length) {
        const root = evaluateXPath(item.xpath).find(visible);
        return root?.getBoundingClientRect();
      }
      const rects = elements.map((element) => documentRect(element));
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    }

    function choose(candidates: PageCandidate[]): PageCandidate | undefined {
      const evidenceWeight = (value: PageCandidate) => {
        const reasons = value.reasons.join(' ');
        return (/pager arrow after numeric pages/i.test(reasons) ? 0.06 : 0)
          + (/numeric pager sequence/i.test(reasons) ? 0.04 : 0)
          + (/pager section context/i.test(reasons) ? 0.02 : 0);
      };
      return candidates
        .sort((a, b) => (b.confidence + evidenceWeight(b)) - (a.confidence + evidenceWeight(a)))
        .filter((candidate, index, array) => array.findIndex((item) => item.xpath === candidate.xpath) === index)
        .sort((a, b) => {
          const typeWeight = (value: PageCandidate) => value.type === 'load_more' ? 0.03 : 0;
          return (b.confidence + typeWeight(b) + evidenceWeight(b)) - (a.confidence + typeWeight(a) + evidenceWeight(a));
        })[0];
    }

    const globalButtons = (item?: ItemInfo) => findButtons(item, undefined, 'global')
      .filter((candidate) => candidate.confidence >= 0.58 || pagerClassPattern.test(candidate.xpath));
    const result: Record<string, PageCandidate> = {};
    for (const item of items) {
      const rect = listRectFor(item);
      const local = rect ? findButtons(item, rect, 'near_list') : [];
      const selected = choose([...local, ...globalButtons(item)]);
      if (selected) result[item.id] = selected;
    }
    return result;
  }, input) as Record<string, DetectedPagination>;

  const fallbackPaginationById = await detectCandidateScopedPaginationFallbacks(
    page,
    candidates.filter((candidate) => !paginationById[candidate.id] || !isPlausiblePaginationOption(paginationById[candidate.id])),
    scrollProbe
  );
  const probePaginationById = scrollProbePaginationForCandidates(candidates, scrollProbe);
  return candidates.map((candidate) => {
    const existingPagination = candidate.pagination && !scrollProbeRulesOutScroll(candidate, scrollProbe)
      ? candidate.pagination
      : undefined;
    const paginationSources: Array<DetectedPagination | undefined> = [
      existingPagination,
      paginationAllowedForCandidate(candidate, paginationById[candidate.id]) ? paginationById[candidate.id] : undefined,
      fallbackPaginationById[candidate.id],
      probePaginationById[candidate.id]
    ];
    const pagination = paginationSources
      .filter((item): item is DetectedPagination => item ? isPlausiblePaginationOption(item) : false)
      .reduce<DetectedPagination | undefined>((selected, item) => preferredPagination(selected, item), undefined);
    const { pagination: _discardedPagination, ...candidateWithoutPagination } = candidate;
    return {
      ...candidateWithoutPagination,
      ...(pagination ? { pagination } : {})
    };
  });
}

export function paginationAllowedForCandidate(candidate: DetectedCandidate, pagination: DetectedPagination | undefined): boolean {
  if (!pagination) return false;
  if (pagination.scope !== 'global') return true;
  if (pagination.type === 'scroll') return candidateEligibleForGlobalScrollPagination(candidate);
  return candidateEligibleForGlobalControlPagination(candidate);
}

export function sanitizeCandidatePaginationByLayout(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates.map((candidate) => {
    if (!candidate.pagination || paginationAllowedForCandidate(candidate, candidate.pagination)) return candidate;
    const { pagination: _discardedPagination, ...withoutPagination } = candidate;
    return withoutPagination;
  });
}

export async function detectCandidateScopedPaginationFallbacks(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<Record<string, DetectedPagination>> {
  const result: Record<string, DetectedPagination> = {};
  for (const candidate of candidates) {
    if (candidate.type === 'detail' || candidate.type === 'form') continue;
    const options = await detectInteractivePaginationOptions(page, [candidate], scrollProbe).catch(() => []);
    const selected = options.find(isCandidateScopedPaginationFallback);
    if (selected) {
      result[candidate.id] = {
        ...selected,
        reasons: selected.reasons.some((reason) => /candidate-scoped fallback/i.test(reason))
          ? selected.reasons
          : [...selected.reasons, 'candidate-scoped fallback pagination scan']
      };
    }
  }
  return result;
}

export function isCandidateScopedPaginationFallback(pagination: DetectedPagination): boolean {
  return pagination.scope === 'near_list'
    && pagination.type !== 'scroll'
    && pagination.confidence >= 0.72
    && isPlausiblePaginationOption(pagination);
}

export function candidateEligibleForGlobalControlPagination(candidate: DetectedCandidate): boolean {
  if (candidate.itemCount < 8) return false;
  const role = candidate.layout?.role;
  if (role && role !== 'main' && role !== 'unknown') return false;
  if (candidate.layout) {
    if (candidate.layout.sidebarPenalty >= 0.28 || candidate.layout.boilerplatePenalty >= 0.34) return false;
    if (candidate.layout.visualCoverage < 0.12 && candidate.itemCount < 20) return false;
  }
  return candidateHasRecordSignal(candidate) || candidate.itemCount >= 20;
}

export function scrollProbeRulesOutScroll(candidate: Pick<DetectedCandidate, 'itemCount' | 'pagination'>, scrollProbe?: ScrollProbeSummary): boolean {
  if (candidate.pagination?.type !== 'scroll' || !scrollProbe) return false;
  if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) return false;
  if (scrollProbeLooksLikeStaticLargeList(candidate, scrollProbe)) return true;
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  if (grewArticleLikeCount >= 2) return false;
  if (!scrollProbe.reachedBottom) return false;
  return !scrollProbe.sawGrowth || (grewArticleLikeCount === 0 && candidate.itemCount <= 20);
}

export function scrollProbePaginationForCandidates(candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Record<string, DetectedPagination> {
  if (!scrollProbe) return {};
  const result: Record<string, DetectedPagination> = {};
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  const grewContentHeight = scrollProbe.grewContentHeight ?? 0;
  const grewPageHeight = scrollProbe.grewPageHeight ?? 0;
  const sawListItemGrowth = grewArticleLikeCount >= 2;
  for (const candidate of candidates) {
    if (candidate.type === 'detail' || candidate.type === 'form') continue;
    if (!candidateEligibleForGlobalScrollPagination(candidate)) continue;
    const listLike = candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection';
    const enoughItems = candidate.itemCount >= 4 || scrollProbe.maxArticleLikeCount >= 8;
    if (!listLike || !enoughItems) continue;
    if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) {
      const text = scrollProbe.bestActiveLoadMoreText || 'Load more';
      const confidence = Math.min(
        0.9,
        0.62
          + (scrollProbe.sawGrowth ? 0.1 : 0)
          + Math.min(0.08, grewArticleLikeCount / 100)
          + (scrollProbe.bestActiveLoadMoreXPath ? 0.04 : 0)
      );
      result[candidate.id] = {
        type: 'load_more',
        xpath: scrollProbeLoadMoreXPath(scrollProbe),
        text,
        confidence,
        isAjax: true,
        scope: 'global',
        revealByScroll: true,
        reasons: [
          'load-more observed during detection scroll probe',
          ...(scrollProbe.sawGrowth ? ['content grew during detection scroll probe'] : [])
        ]
      };
      continue;
    }
    if (scrollProbeLooksLikeStaticLargeList(candidate, scrollProbe)) continue;
    if (!sawListItemGrowth) continue;
    const confidence = Math.min(
      0.86,
      0.56
        + Math.min(0.18, grewArticleLikeCount / 40)
        + Math.min(0.08, grewPageHeight / 3000)
        + Math.min(0.06, grewContentHeight / 9000)
        + (scrollProbe.reachedBottom ? 0.02 : 0)
    );
    result[candidate.id] = {
      type: 'scroll',
      xpath: '',
      text: 'Scroll page',
      confidence,
      isAjax: true,
      scope: 'global',
      reasons: [
        'list-like records grew during detection scroll probe',
        `scroll probe discovered ${grewArticleLikeCount} additional list-like items`,
        ...(grewContentHeight ? [`scroll probe increased content text by ${grewContentHeight} chars`] : []),
        ...(grewPageHeight ? [`scroll probe increased page height by ${grewPageHeight}px`] : [])
      ]
    };
  }
  return result;
}

export function candidateEligibleForGlobalScrollPagination(candidate: DetectedCandidate): boolean {
  const hasRecordSignal = candidateHasRecordSignal(candidate);
  const minimumItems = hasRecordSignal && candidate.confidence >= 0.72 ? 4 : 8;
  if (candidate.itemCount < minimumItems) return false;
  const role = candidate.layout?.role;
  if (role && role !== 'main' && role !== 'unknown') return false;
  if (candidate.layout) {
    if (candidate.layout.sidebarPenalty >= 0.28 || candidate.layout.boilerplatePenalty >= 0.34) return false;
    if (candidate.layout.visualCoverage < 0.12 && candidate.itemCount < 20) return false;
  }
  return hasRecordSignal || candidate.itemCount >= 20;
}

export function candidateHasRecordSignal(candidate: DetectedCandidate): boolean {
  const fieldNames = candidate.fields.map((field) => field.name).join(' ');
  return /title|标题|url|链接|image|图片|date|time|时间|summary|description|描述|价格|price|company|公司|位置|location|author|作者|标签|tag/i.test(fieldNames);
}

export function scrollProbeLooksLikeStaticLargeList(candidate: Pick<DetectedCandidate, 'itemCount'>, scrollProbe: ScrollProbeSummary): boolean {
  if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) return false;
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  if (candidate.itemCount < 180 || grewArticleLikeCount < 2) return false;
  if (grewArticleLikeCount > candidate.itemCount && scrollProbe.maxArticleLikeCount > candidate.itemCount * 2.5) return true;
  const largestObservedCount = Math.max(candidate.itemCount, scrollProbe.maxArticleLikeCount || 0);
  const growthRatio = grewArticleLikeCount / Math.max(1, largestObservedCount);
  const likelyReachedCompleteList = scrollProbe.reachedBottom === true || candidate.itemCount >= 200;
  return likelyReachedCompleteList && growthRatio < 0.5;
}

export function scrollProbeHasReliableActiveLoadMore(scrollProbe: ScrollProbeSummary): boolean {
  if (!scrollProbe.sawActiveLoadMore) return false;
  const text = scrollProbe.bestActiveLoadMoreText?.replace(/\s+/g, ' ').trim() || '';
  if (!text) return Boolean(scrollProbe.bestActiveLoadMoreXPath);
  if (text.length > 48) return false;
  return /^(加载更多|查看更多|查看更多内容|查看更多结果|显示更多|显示更多内容|显示更多结果|点击加载|点击加载更多|load more|load more results|show more|show more results|see more)$/i.test(text);
}

export function scrollProbeLoadMoreXPath(scrollProbe: ScrollProbeSummary): string {
  const text = scrollProbe.bestActiveLoadMoreText?.replace(/\s+/g, ' ').trim();
  const matchedText = text?.match(/加载更多|查看更多|显示更多|点击加载|load more|show more|see more/i)?.[0];
  if (matchedText) {
    const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    return `//*[(${loadMoreTagOrRoleXPath()}) and contains(${lowerText}, ${xpathStringLiteral(matchedText.toLowerCase())}) and ${loadMoreEndTextExclusionForDetectorXPath()}]`;
  }
  return scrollProbe.bestActiveLoadMoreXPath || genericLoadMoreDetectorXPath();
}

export function genericLoadMoreDetectorXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const classExpr = `translate(concat(" ", normalize-space(@class), " "), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const roleExpr = `translate(@role, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const positive = [
    `contains(${lowerText}, "加载更多")`,
    `contains(${lowerText}, "查看更多")`,
    `contains(${lowerText}, "显示更多")`,
    `contains(${lowerText}, "点击加载")`,
    `contains(${lowerText}, "load more")`,
    `contains(${lowerText}, "show more")`,
    `contains(${lowerText}, "see more")`,
    `contains(${classExpr}, " load-more ")`,
    `contains(${classExpr}, " loadmore ")`,
    `${roleExpr}="button" and (contains(${lowerText}, "more") or contains(${lowerText}, "更多"))`
  ].join(' or ');
  return `//*[(${loadMoreTagOrRoleXPath()}) and (${positive}) and ${loadMoreEndTextExclusionForDetectorXPath()}]`;
}

export function loadMoreTagOrRoleXPath(): string {
  return 'self::a or self::button or self::div or self::span or self::li or @onclick or @role';
}

export function loadMoreEndTextExclusionForDetectorXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  return [
    `not(contains(${lowerText}, "没有更多"))`,
    `not(contains(${lowerText}, "暂无更多"))`,
    `not(contains(${lowerText}, "已到底"))`,
    `not(contains(${lowerText}, "到底了"))`,
    `not(contains(${lowerText}, "加载完毕"))`,
    `not(contains(${lowerText}, "no more"))`,
    `not(contains(${lowerText}, "all loaded"))`,
    `not(contains(${lowerText}, "end of"))`,
    `not(contains(${lowerText}, "see more information"))`,
    `not(contains(${lowerText}, "more information about"))`,
    `not(contains(${lowerText}, "details about"))`,
    `not(contains(${lowerText}, "view details"))`,
    `not(contains(${lowerText}, "查看详情"))`,
    `not(contains(${lowerText}, "详细信息"))`
  ].join(' and ');
}

export function preferredPagination(existing: DetectedPagination | undefined, detected: DetectedPagination | undefined): DetectedPagination | undefined {
  if (!existing) return detected;
  if (!detected) return existing;
  const merged = mergePaginationSignals(existing, detected);
  let selected: DetectedPagination;
  if (existing.type === 'next_page' && detected.type === 'scroll' && !reliableNextPagination(existing)) selected = detected;
  else if (existing.type === 'scroll' && detected.type === 'next_page' && !reliableNextPagination(detected)) selected = existing;
  else if (existing.type !== 'scroll' && detected.type === 'scroll') selected = existing;
  else if (existing.type === 'load_more' && detected.type !== 'load_more') selected = existing;
  else if (detected.type !== 'scroll' && existing.type === 'scroll') selected = detected;
  else selected = comparePaginationOptions(existing, detected) <= 0 ? existing : detected;
  return merged(selected);
}

export function reliableNextPagination(pagination: DetectedPagination): boolean {
  if (pagination.type !== 'next_page') return false;
  const text = (pagination.text || '').trim();
  const xpath = pagination.xpath || '';
  const reasons = pagination.reasons.join(' ');
  const pagerLike = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)
    || /numeric pager|pager sequence|pager section|pager arrow/i.test(reasons);
  if (/^(下一页|下页|后一页|后页|next)$/i.test(text)) return true;
  if (/^(>|›|»|→)$/i.test(text)) return pagerLike;
  if (/(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)) return true;
  if (/(pager-next|page-next|pagination-next|nextpage|btn-next)/i.test(xpath)) return true;
  if (/numeric pager|pager sequence|pager section/i.test(reasons) && /^\d{1,5}$/.test(text)) return true;
  return pagination.confidence >= 0.86 && !/(arrow-right|right|carousel|filter|筛选|分类|category|tag|tab|chip|swiper|slider)/i.test(`${xpath} ${reasons}`);
}

export function mergePaginationSignals(a: DetectedPagination, b: DetectedPagination): (selected: DetectedPagination) => DetectedPagination {
  const revealByScroll = a.revealByScroll || b.revealByScroll || a.type === 'scroll' && b.type === 'load_more' || b.type === 'scroll' && a.type === 'load_more';
  return (selected) => revealByScroll && selected.type === 'load_more'
    ? {
      ...selected,
      revealByScroll: true,
      reasons: selected.reasons.some((reason) => /scroll/i.test(reason))
        ? selected.reasons
        : [...selected.reasons, 'load-more may be revealed after scrolling']
    }
    : selected;
}

export function isPlausiblePaginationOption(pagination: DetectedPagination): boolean {
  if (pagination.type === 'load_more') return reliableLoadMorePagination(pagination);
  if (pagination.type !== 'next_page') return true;
  const text = (pagination.text || '').trim();
  const xpath = pagination.xpath || '';
  const reasons = pagination.reasons.join(' ');
  const pagerLike = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)
    || /numeric pager|pager sequence|pager section|pager arrow/i.test(reasons);
  if (/^(下一页|下页|后一页|后页|next)$/i.test(text)) return true;
  if (/^(>|›|»|→)$/i.test(text)) return pagerLike;
  if (/(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)) return true;
  if (/(pager-next|page-next|pagination-next|nextpage|btn-next)/i.test(xpath)) return true;
  if (/(^|[^a-z])next([^a-z]|$)/i.test(xpath) && !/(arrow-right|right)/i.test(xpath)) return true;
  if (/numeric pager|pager sequence|pager section/i.test(reasons) && /^\d{1,5}$/.test(text)) return true;
  return false;
}

export function reliableLoadMorePagination(pagination: DetectedPagination): boolean {
  if (pagination.type !== 'load_more') return false;
  const text = (pagination.text || '').replace(/\s+/g, ' ').trim();
  const evidence = `${pagination.xpath || ''} ${pagination.reasons.join(' ')}`;
  if (loadMoreRecordExpanderText(text)) return false;
  if (/(?:loadmore|load-more|load_more)/i.test(evidence)) return true;
  if (!text || text.length > 72) return false;
  return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(text);
}

export function loadMoreRecordExpanderText(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
    || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
    || /^(?:view|show)\s+details?\b/i.test(normalized)
    || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
}

export function comparePaginationOptions(a: DetectedPagination, b: DetectedPagination): number {
  const typeWeight = (pagination: DetectedPagination) => {
    if (pagination.type === 'load_more') return 0.26;
    if (pagination.type === 'next_page') return reliableNextPagination(pagination) ? 0.28 : -0.16;
    if (pagination.type === 'scroll') return 0.04;
    return 0;
  };
  const sourceWeight = (pagination: DetectedPagination) => {
    const reasons = pagination.reasons.join(' ');
    return /protected SmartProxy|SmartProxy/i.test(reasons) ? 0.08 : 0;
  };
  return (b.confidence + typeWeight(b) + sourceWeight(b)) - (a.confidence + typeWeight(a) + sourceWeight(a));
}
