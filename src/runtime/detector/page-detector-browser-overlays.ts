import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedFieldDiagnostics, DetectedPagination } from './types.js';
import { detectDetails } from './page-detector-candidate-strategies.js';
import { paginationKey } from './page-detector-pagination.js';

export async function installCandidateOverlay(page: Page, candidates: DetectedCandidate[], paginations: DetectedPagination[] = []): Promise<void> {
  const overlayCandidates = candidates
    .filter((candidate) => candidate.type === 'table' || candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection')
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      itemXPath: candidate.itemXPath || candidate.xpath,
      xpath: candidate.xpath,
      itemCount: candidate.itemCount,
      layoutRole: candidate.layout?.role ?? 'unknown',
      layoutScore: candidate.layout?.score ?? 0,
      mainScore: candidate.layout?.mainScore ?? 0,
      sidebarPenalty: candidate.layout?.sidebarPenalty ?? 0,
      navigationLike: candidate.reasons.some((reason) => /navigation|header/i.test(reason)),
      fields: candidate.fields
        .filter((field) => field.kind === 'text' || field.kind === 'href' || field.kind === 'src')
        .map((field) => ({
          name: field.name,
          kind: field.kind,
          xpath: field.xpath,
          relativeXPath: field.relativeXPath || ''
        }))
    }));
  const overlayPaginations = paginations.map((pagination) => ({
    key: paginationKey(pagination),
    type: pagination.type,
    xpath: pagination.xpath,
    text: pagination.text,
    confidence: pagination.confidence
  }));
  await page.evaluate(({ items, paginationItems }) => {
    const w = window as typeof window & {
      __octopusDetectionSelection?: string;
      __octopusDetectionSelections?: string[];
      __octopusDetectionClearSelection?: () => void;
      __octopusDetectionCleanup?: () => void;
    };
    w.__octopusDetectionCleanup?.();
    document.getElementById('octopus-detection-overlay-root')?.remove();
    w.__octopusDetectionSelection = undefined;
    w.__octopusDetectionSelections = [];

    const palette = [
      '#009f4d',
      '#2563eb',
      '#d97706',
      '#dc2626',
      '#7c3aed',
      '#0891b2',
      '#db2777',
      '#4b5563'
    ];
    const root = document.createElement('div');
    root.id = 'octopus-detection-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'visible';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483600';
    document.documentElement.appendChild(root);

    const labels: HTMLElement[] = [];
    const highlighted: HTMLElement[] = [];
    const fieldHighlighted: HTMLElement[] = [];
    const paginationPreviewElements: HTMLElement[] = [];
    const byElement = new WeakMap<Element, string>();
    const previewByElement = new WeakSet<Element>();
    const selectedIds = new Set<string>();
    const labelEntries: Array<{ element: Element; label: HTMLElement }> = [];

    function evaluateXPath(xpath: string): Element[] {
      if (!xpath) return [];
      const normalized = xpath.includes('[*]') ? xpath.replace(/\[\*\]/g, '') : xpath;
      const result = document.evaluate(normalized, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const output: Element[] = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const node = result.snapshotItem(index);
        if (node instanceof Element) output.push(node);
      }
      return output;
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function drawBox(element: Element, candidateId: string, labelText: string, color: string, emphasis: 'primary' | 'secondary'): void {
      const html = element as HTMLElement;
      const originalOutline = html.style.outline;
      const originalOutlineOffset = html.style.outlineOffset;
      const originalBackground = html.style.backgroundColor;
      html.dataset.octopusDetectionOutline = originalOutline;
      html.dataset.octopusDetectionOutlineOffset = originalOutlineOffset;
      html.dataset.octopusDetectionBackground = originalBackground;
      html.dataset.octopusDetectionColor = color;
      html.dataset.octopusDetectionEmphasis = emphasis;
      html.style.outline = `${emphasis === 'primary' ? 3 : 2}px ${emphasis === 'primary' ? 'solid' : 'dashed'} ${color}`;
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = emphasis === 'primary' ? `${color}16` : `${color}08`;
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      byElement.set(element, candidateId);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 22)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '3px 6px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.opacity = emphasis === 'primary' ? '1' : '.72';
      label.style.boxShadow = emphasis === 'primary' ? '0 2px 8px rgba(0,0,0,.18)' : '0 1px 5px rgba(0,0,0,.14)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function elementText(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function ownText(element: Element | null): string {
      if (!element) return '';
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        html.className || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('rel') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('data-testid') || '',
        html.getAttribute('data-test') || '',
        html.getAttribute('data-qa') || '',
        html.getAttribute('data-role') || ''
      ].join(' ');
    }

    function hasVisibleImage(element: Element): boolean {
      return Array.from(element.querySelectorAll('img')).some(visible);
    }

    function textFieldValue(element: Element): string {
      const own = ownText(element);
      if (own) return own;
      const tag = element.tagName.toLowerCase();
      const value = elementText(element);
      if (/^(a|h1|h2|h3|h4|p|span|time|em|i|strong|b)$/i.test(tag)) return value;
      if (element.children.length <= 1 && !hasVisibleImage(element)) return value;
      return '';
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function isEngagementCount(value: string): boolean {
      const compact = value.replace(/\s+/g, '');
      if (!compact || compact.length > 24 || !/\d/.test(compact)) return false;
      if (dateMatch(compact)) return false;
      return /^(赞|喜欢|收藏|评论|转发|like|likes|save|saves|comment|comments|share|shares)?[:：]?[♡♥❤👍]?\d+(?:[.,]\d+)?(?:万|千|亿|w|k|m)?\+?(赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?$/i.test(compact);
    }

    type EngagementKind = 'comments' | 'favorites' | 'shares' | 'likes' | 'metric';

    function engagementCountValue(element: Element): string {
      const values = [ownText(element), textFieldValue(element), elementText(element)];
      return values.find((value) => isEngagementCount(value)) || '';
    }

    function engagementCountLeaves(root: Element): Element[] {
      return Array.from(root.querySelectorAll('span,em,i,b,strong,a,button,div'))
        .filter(visible)
        .filter((element) => Boolean(engagementCountValue(element)))
        .filter((element) => !Array.from(element.querySelectorAll('span,em,i,b,strong,a,button,div'))
          .some((child) => child !== element && visible(child) && Boolean(engagementCountValue(child))));
    }

    function nearestSiblings(element: Element, direction: 'previous' | 'next', limit = 3): Element[] {
      const output: Element[] = [];
      let current = direction === 'previous' ? element.previousElementSibling : element.nextElementSibling;
      while (current && output.length < limit) {
        output.push(current);
        current = direction === 'previous' ? current.previousElementSibling : current.nextElementSibling;
      }
      return output;
    }

    function visualArea(element: Element): number {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function localEngagementWrapper(element: Element, row: Element): Element | null {
      let current = element.parentElement;
      const rowArea = Math.max(1, visualArea(row));
      while (current && current !== row) {
        const countLeaves = engagementCountLeaves(current);
        if (countLeaves.length > 1) return null;
        if (countLeaves.length === 1 && countLeaves[0] === element) {
          const areaRatio = visualArea(current) / rowArea;
          if (areaRatio <= 0.25 || current.children.length <= 5 || /comment|reply|discuss|like|heart|collect|favorite|fav|star|share|forward|repost|retweet|interact|action|metric|count/i.test(elementIdentity(current))) return current;
        }
        current = current.parentElement;
      }
      return null;
    }

    function engagementSemanticText(element: Element, row: Element): string {
      const parent = element.parentElement;
      const wrapper = localEngagementWrapper(element, row);
      const localElements = [
        ...nearestSiblings(element, 'previous'),
        ...nearestSiblings(element, 'next', 1),
        ...(wrapper ? [wrapper] : []),
        ...(parent && engagementCountLeaves(parent).length <= 1 ? [parent] : [])
      ].filter((item): item is Element => Boolean(item && item !== row));
      const attr = (target: Element | null | undefined): string => {
        if (!target) return '';
        const item = target as HTMLElement;
        return [
          target.localName,
          item.id || '',
          typeof item.className === 'string' ? item.className : '',
          item.getAttribute('role') || '',
          item.getAttribute('aria-label') || '',
          item.getAttribute('title') || '',
          item.getAttribute('alt') || '',
          item.getAttribute('href') || '',
          item.getAttribute('xlink:href') || '',
          item.getAttribute('data-testid') || '',
          item.getAttribute('data-test') || '',
          item.getAttribute('data-qa') || '',
          item.getAttribute('data-role') || '',
          item.getAttribute('use') || '',
          target.textContent || ''
        ].join(' ');
      };
      return [
        attr(element),
        wrapper ? attr(wrapper) : '',
        parent && engagementCountLeaves(parent).length <= 1 ? attr(parent) : '',
        ...localElements.map(attr),
        ...localElements.flatMap((item) => Array.from(item.querySelectorAll('svg,use,i,span[class],em[class]')).map(attr))
      ].join(' ');
    }

    function engagementKind(element: Element, row: Element): EngagementKind {
      const value = `${engagementSemanticText(element, row)} ${engagementCountValue(element)}`.toLowerCase();
      if (/(comment|comments|reply|replies|discuss|discussion|bubble|message|chat|评论|评|留言|回复)/i.test(value)) return 'comments';
      if (/(share|shares|forward|repost|retweet|transmit|arrow|send|转发|分享|转|转推|↗|↪|➜|➤|⤴|⤵)/i.test(value)) return 'shares';
      if (/(collect|collection|favorite|favourite|favorites|favourites|fav|star|bookmark|save|saves|收藏|星标|书签|☆|★)/i.test(value)) return 'favorites';
      if (/(like|likes|heart|thumb|vote|upvote|赞|喜欢|点赞|♥|❤|♡|👍)/i.test(value)) return 'likes';
      return 'metric';
    }

    function findEngagementElement(row: Element, fieldName: string): Element | null {
      const wanted = fieldName === 'comments' || fieldName === 'favorites' || fieldName === 'shares' || fieldName === 'likes' ? fieldName : '';
      const candidates = Array.from(row.querySelectorAll('[class*="comment" i],[class*="reply" i],[class*="discuss" i],[class*="like" i],[class*="heart" i],[class*="collect" i],[class*="favorite" i],[class*="count" i],[class*="interact" i],[class*="engage" i],[class*="share" i],[class*="forward" i],[class*="repost" i],span,em,i,b,strong,div'))
        .filter(visible)
        .map((element) => {
          const value = engagementCountValue(element);
          const rect = element.getBoundingClientRect();
          const kind = engagementKind(element, row);
          const descendantCountLeaves = engagementCountLeaves(element).filter((child) => child !== element);
          const directCount = isEngagementCount(ownText(element));
          return { element, value, rect, kind, directCount, descendantCountLeaves };
        })
        .filter((item) => item.value && (item.directCount || item.descendantCountLeaves.length === 0))
        .filter((item) => !wanted || item.kind === wanted || item.kind === 'metric')
        .sort((a, b) => {
          const aExact = wanted && a.kind === wanted ? 1 : 0;
          const bExact = wanted && b.kind === wanted ? 1 : 0;
          if (aExact !== bExact) return bExact - aExact;
          return a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.value.length - b.value.length || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
      return candidates[0]?.element || null;
    }

    function findAuthorElement(row: Element): Element | null {
      const rowRect = row.getBoundingClientRect();
      const candidates = Array.from(row.querySelectorAll('[class*="author" i],[class*="byline" i],[class*="user" i],[class*="nick" i],[class*="name" i],[class*="creator" i],[class*="owner" i],[class*="profile" i],[class*="avatar" i],[rel="author"],[itemprop*="author" i],a,span,p,div'))
        .filter(visible)
        .map((element) => {
          const value = textFieldValue(element);
          const rect = element.getBoundingClientRect();
          const identity = elementIdentity(element);
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar/i.test(identity);
          const nearBottom = rect.top > rowRect.top + rowRect.height * 0.35;
          const hasProfileLink = Boolean(element.closest('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]') || element.querySelector('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]'));
          return { element, value, rect, semantic, nearBottom, hasProfileLink };
        })
        .filter((item) => item.value.length >= 2 && item.value.length <= 60 && !isEngagementCount(item.value) && !dateMatch(item.value))
        .sort((a, b) => {
          const aScore = (a.semantic ? 1 : 0) + (a.hasProfileLink ? 0.45 : 0) + (a.nearBottom ? 0.25 : 0) - Math.max(0, a.value.length - 24) / 100;
          const bScore = (b.semantic ? 1 : 0) + (b.hasProfileLink ? 0.45 : 0) + (b.nearBottom ? 0.25 : 0) - Math.max(0, b.value.length - 24) / 100;
          return bScore - aScore || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
      return candidates[0]?.element || null;
    }

    function findDateElement(row: Element): Element | null {
      return [row, ...Array.from(row.querySelectorAll('time,[datetime],[class*="date" i],[class*="time" i],span,p,div,em,i,b,strong'))]
        .filter(visible)
        .map((element) => ({ element, value: elementText(element), rect: element.getBoundingClientRect() }))
        .filter((item) => item.value.length > 0 && item.value.length <= 90 && Boolean(dateMatch(item.value)))
        .sort((a, b) => {
          const aSemantic = /time|date/i.test(`${a.element.id} ${(a.element as HTMLElement).className} ${(a.element as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
          const bSemantic = /time|date/i.test(`${b.element.id} ${(b.element as HTMLElement).className} ${(b.element as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
          if (aSemantic !== bSemantic) return aSemantic - bSemantic;
          return a.value.length - b.value.length || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        })[0]?.element || null;
    }

    function normalizedFieldName(name: string): string {
      return name.toLowerCase().replace(/\s+/g, '');
    }

    function relativeXPathForRow(xpath: string): string {
      if (!xpath) return '';
      if (xpath === '.') return '.';
      if (xpath.startsWith('./') || xpath.startsWith('.//')) return xpath;
      if (xpath.startsWith('/descendant-or-self::')) return xpath.slice(1);
      if (xpath.startsWith('//')) return `.//${xpath.slice(2)}`;
      if (xpath.startsWith('/')) return `.${xpath}`;
      return xpath;
    }

    function fallbackFieldElement(row: Element, field: { name: string; kind: string }): Element | null {
      const name = normalizedFieldName(field.name);
      if (name === 'image' || name === '图片' || field.kind === 'src') {
        return Array.from(row.querySelectorAll('img'))
          .filter(visible)
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            const aArea = aRect.width * aRect.height;
            const bArea = bRect.width * bRect.height;
            return bArea - aArea;
          })[0] || null;
      }
      if (name === 'date' || name === '日期' || name === '时间') return findDateElement(row);
      if (/^(comments|favorites|shares|likes|metric_\d+|like_count|engagement)$/.test(field.name)) return findEngagementElement(row, field.name);
      if (name === 'author' || name === 'user' || name === 'nickname' || name === '作者' || name === '用户' || name === '昵称') return findAuthorElement(row);
      if (name === 'url' || name === 'link' || name.includes('链接') || field.kind === 'href') {
        return Array.from(row.querySelectorAll('a')).filter(visible).find((element) => (element as HTMLAnchorElement).href) || null;
      }
      if (name === 'title' || name === '标题' || name.includes('标题')) {
        return Array.from(row.querySelectorAll('h1,h2,h3,h4,a,[class*="title" i],p,span,div'))
          .filter(visible)
          .map((element) => ({ element, value: elementText(element), rect: element.getBoundingClientRect() }))
          .filter((item) => item.value.length >= 2 && item.value.length <= 220 && !dateMatch(item.value))
          .sort((a, b) => {
            const tagWeight = (element: Element) => /^(h1|h2|h3|h4|a)$/i.test(element.tagName) ? 0 : 1;
            if (tagWeight(a.element) !== tagWeight(b.element)) return tagWeight(a.element) - tagWeight(b.element);
            return b.rect.width - a.rect.width;
          })[0]?.element || null;
      }
      if (name === 'summary' || name === '摘要' || name.includes('摘要') || name === '简介' || name === '描述') {
        return Array.from(row.querySelectorAll('p,span,div'))
          .filter(visible)
          .map((element) => ({ element, value: textFieldValue(element), rect: element.getBoundingClientRect() }))
          .filter((item) => {
            if (hasVisibleImage(item.element)) return false;
            return item.value.length > 20 && item.value.length < 300 && !isEngagementCount(item.value);
          })
          .sort((a, b) => {
            const aOwn = ownText(a.element) ? 0 : 1;
            const bOwn = ownText(b.element) ? 0 : 1;
            if (aOwn !== bOwn) return aOwn - bOwn;
            return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
          })[0]?.element || null;
      }
      return null;
    }

    function fieldElement(row: Element, field: { name: string; kind: string; xpath: string; relativeXPath: string }): Element | null {
      let element: Element | null = null;
      if (field.relativeXPath) {
        try {
          const result = document.evaluate(relativeXPathForRow(field.relativeXPath), row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (result.singleNodeValue instanceof Element) element = result.singleNodeValue;
        } catch {
          element = null;
        }
      }
      if (!element && field.xpath) {
        element = evaluateXPath(field.xpath).find(visible) || null;
      }
      if (!element || element === row || !row.contains(element) || !visible(element)) {
        element = fallbackFieldElement(row, field);
      }
      if (!element || element === row || !row.contains(element) || !visible(element)) return null;
      return element;
    }

    function drawFieldBox(element: Element, labelText: string, color: string): void {
      const html = element as HTMLElement;
      if (!html.dataset.octopusDetectionFieldOutline) {
        html.dataset.octopusDetectionFieldOutline = html.style.outline;
        html.dataset.octopusDetectionFieldOutlineOffset = html.style.outlineOffset;
        html.dataset.octopusDetectionFieldBackground = html.style.backgroundColor;
      }
      html.style.outline = `2px solid ${color}`;
      html.style.outlineOffset = '-1px';
      html.style.backgroundColor = `${color}12`;
      fieldHighlighted.push(html);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 18)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 11px/1.1 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '2px 5px';
      label.style.borderRadius = '3px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 1px 6px rgba(0,0,0,.18)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function drawPaginationPreview(element: Element, labelText: string): void {
      const html = element as HTMLElement;
      const originalOutline = html.style.outline;
      const originalOutlineOffset = html.style.outlineOffset;
      const originalBackground = html.style.backgroundColor;
      const originalBoxShadow = html.style.boxShadow;
      html.dataset.octopusDetectionOutline = originalOutline;
      html.dataset.octopusDetectionOutlineOffset = originalOutlineOffset;
      html.dataset.octopusDetectionBackground = originalBackground;
      html.dataset.octopusDetectionBoxShadow = originalBoxShadow;
      html.style.outline = '3px solid #f97316';
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = 'rgba(249,115,22,.14)';
      html.style.boxShadow = '0 0 0 1px rgba(249,115,22,.35)';
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      paginationPreviewElements.push(html);
      previewByElement.add(element);

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
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        label.style.display = offscreen ? 'none' : '';
        label.style.left = `${Math.max(0, Math.min(window.innerWidth - 40, rect.left))}px`;
        label.style.top = `${Math.max(0, Math.min(window.innerHeight - 20, rect.top - 22))}px`;
      });
    }

    function syncSelectionStyles(): void {
      highlighted.forEach((element) => {
        const candidateId = byElement.get(element);
        const selected = candidateId ? selectedIds.has(candidateId) : false;
        const color = element.dataset.octopusDetectionColor || '#2563eb';
        const emphasis = element.dataset.octopusDetectionEmphasis === 'secondary' ? 'secondary' : 'primary';
        element.style.outline = `${selected ? 5 : emphasis === 'primary' ? 3 : 2}px ${selected || emphasis === 'primary' ? 'solid' : 'dashed'} ${color}`;
        element.style.outlineOffset = '-2px';
        element.style.backgroundColor = selected ? `${color}33` : emphasis === 'primary' ? `${color}16` : `${color}08`;
        element.style.boxShadow = selected ? `0 0 0 2px ${color}55` : '';
        element.style.opacity = '';
      });
      labels.forEach((label) => {
        const related = labelEntries.find((entry) => entry.label === label);
        const candidateId = related ? byElement.get(related.element) : undefined;
        const selected = candidateId ? selectedIds.has(candidateId) : false;
        label.style.transform = selected ? 'scale(1.08)' : '';
        label.style.filter = selected ? 'saturate(1.35)' : '';
      });
      w.__octopusDetectionSelection = Array.from(selectedIds)[0];
      w.__octopusDetectionSelections = Array.from(selectedIds);
    }

    const prepared = items
      .map((candidate) => {
        const elements = evaluateXPath(candidate.itemXPath || candidate.xpath)
          .filter(visible)
          .slice(0, 80);
        if (!elements.length) return null;
        const rects = elements.map((element) => element.getBoundingClientRect());
        const top = Math.min(...rects.map((rect) => rect.top));
        const height = Math.max(...rects.map((rect) => rect.bottom)) - top;
        const width = Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left));
        const sampleText = elements.slice(0, 8).map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const shortTextRate = sampleText.filter((value) => value.length <= 8).length / Math.max(1, sampleText.length);
        const navPenalty = candidate.navigationLike || (top < 180 && height < 160 && shortTextRate > 0.75) ? 1 : 0;
        const primaryLike = candidate.layoutRole === 'main' || candidate.mainScore >= 0.62 || (candidate.layoutScore >= 0.52 && candidate.sidebarPenalty < 0.35);
        return { candidate, elements, top, area: Math.max(1, width * height), navPenalty, primaryLike };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const primarySource = prepared.filter((item) => item.primaryLike && item.navPenalty === 0);
    const secondarySource = prepared.filter((item) => !primarySource.includes(item));
    const orderedPrimary = (primarySource.length ? primarySource : prepared.filter((item) => item.navPenalty === 0))
      .sort((a, b) => {
        if (a.navPenalty !== b.navPenalty) return a.navPenalty - b.navPenalty;
        if (Math.abs(b.candidate.mainScore - a.candidate.mainScore) > 0.08) return b.candidate.mainScore - a.candidate.mainScore;
        if (Math.abs(a.top - b.top) > 80) return a.top - b.top;
        return b.area - a.area;
      })
      .slice(0, 10);
    const orderedSecondary = secondarySource
      .sort((a, b) => {
        if (a.navPenalty !== b.navPenalty) return a.navPenalty - b.navPenalty;
        return b.candidate.layoutScore - a.candidate.layoutScore || b.area - a.area;
      })
      .slice(0, 6);
    const drawable = [
      ...orderedPrimary.map((item) => ({ ...item, emphasis: 'primary' as const })),
      ...orderedSecondary.map((item) => ({ ...item, emphasis: 'secondary' as const }))
    ];

    let visibleGroupIndex = 0;
    drawable.forEach(({ candidate, elements, emphasis }, candidateIndex) => {
      const color = palette[candidateIndex % palette.length];
      visibleGroupIndex += 1;
      const label = `G${visibleGroupIndex}`;
      elements.slice(0, emphasis === 'primary' ? 80 : 24).forEach((element) => drawBox(element, candidate.id, label, color, emphasis));
      if (emphasis === 'secondary') return;
      const fieldColor = '#0f766e';
      elements.forEach((element) => {
        const groupedFields = new Map<Element, string[]>();
        candidate.fields.slice(0, 8).forEach((field) => {
          const fieldTarget = fieldElement(element, field);
          if (!fieldTarget) return;
          groupedFields.set(fieldTarget, [...(groupedFields.get(fieldTarget) ?? []), field.name]);
        });
        groupedFields.forEach((names, fieldTarget) => {
          drawFieldBox(fieldTarget, Array.from(new Set(names)).join('+'), fieldColor);
        });
      });
    });
    paginationItems.forEach((item, index) => {
      if (!item.xpath) return;
      const element = evaluateXPath(item.xpath).find(visible);
      if (!element) return;
      drawPaginationPreview(element, item.type === 'load_more' ? `MORE ${index + 1}` : `PAGE ${index + 1}`);
    });
    positionLabels();

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const previewTarget = path.find((item): item is Element => item instanceof Element && previewByElement.has(item));
      if (previewTarget) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      const target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const selectedId = byElement.get(target);
      if (!selectedId) return;
      if (selectedIds.has(selectedId)) selectedIds.delete(selectedId);
      else selectedIds.add(selectedId);
      syncSelectionStyles();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusDetectionClearSelection = () => {
      selectedIds.clear();
      syncSelectionStyles();
    };
    w.__octopusDetectionCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetectionOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetectionOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetectionBackground || '';
        element.style.boxShadow = element.dataset.octopusDetectionBoxShadow || '';
        element.style.cursor = '';
        element.style.opacity = '';
        delete element.dataset.octopusDetectionOutline;
        delete element.dataset.octopusDetectionOutlineOffset;
        delete element.dataset.octopusDetectionBackground;
        delete element.dataset.octopusDetectionBoxShadow;
        delete element.dataset.octopusDetectionColor;
        delete element.dataset.octopusDetectionEmphasis;
      });
      fieldHighlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetectionFieldOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetectionFieldOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetectionFieldBackground || '';
        delete element.dataset.octopusDetectionFieldOutline;
        delete element.dataset.octopusDetectionFieldOutlineOffset;
        delete element.dataset.octopusDetectionFieldBackground;
      });
      root.remove();
      delete w.__octopusDetectionClearSelection;
      delete w.__octopusDetectionCleanup;
      delete w.__octopusDetectionSelections;
    };
  }, { items: overlayCandidates, paginationItems: overlayPaginations });
}

export async function readOverlaySelection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusDetectionSelections?: string[]; __octopusDetectionSelection?: string };
    if (Array.isArray(w.__octopusDetectionSelections)) return w.__octopusDetectionSelections;
    return w.__octopusDetectionSelection ? [w.__octopusDetectionSelection] : [];
  });
}

export async function installDetailFieldOverlay(page: Page): Promise<void> {
  // Align manual detail suggestions with detectDetails() (same pipeline as auto detail recognition).
  const detected = await detectDetails(page).catch(() => []);
  const suggestedFields = (detected[0]?.fields ?? [])
    .filter((field) => field.xpath && field.samples.some((sample) => String(sample ?? '').trim()))
    .map((field) => ({
      suggestedName: field.name,
      kind: (field.kind === 'href' || field.kind === 'src' ? field.kind : 'text') as 'text' | 'href' | 'src',
      xpath: field.xpath,
      selector: field.selector,
      sample: String(field.samples[0] ?? ''),
      ...(field.diagnostics ? { diagnostics: field.diagnostics } : {})
    }));

  await page.evaluate((suggestedItems) => {
    type SelectedField = {
      id: string;
      suggestedName: string;
      kind: 'text' | 'href' | 'src';
      xpath: string;
      selector: string;
      sample: string;
      diagnostics?: {
        matchCount: number;
        textLength: number;
        paragraphCount: number;
        hasStyleNoise: boolean;
        warnings: string[];
      };
    };
    type SuggestedItem = {
      suggestedName: string;
      kind: 'text' | 'href' | 'src';
      xpath: string;
      selector: string;
      sample: string;
      diagnostics?: SelectedField['diagnostics'];
    };
    const w = window as typeof window & {
      __octopusDetailFieldSelections?: string[];
      __octopusDetailFieldObjects?: SelectedField[];
      __octopusDetailFieldClearSelection?: () => void;
      __octopusDetailFieldCleanup?: () => void;
    };
    w.__octopusDetailFieldCleanup?.();
    document.getElementById('octopus-detail-field-overlay-root')?.remove();
    w.__octopusDetailFieldSelections = [];
    w.__octopusDetailFieldObjects = [];

    const root = document.createElement('div');
    root.id = 'octopus-detail-field-overlay-root';
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
    const labels: HTMLElement[] = [];
    const labelEntries: Array<{ element: Element; label: HTMLElement }> = [];
    const byElement = new WeakMap<Element, SelectedField>();
    const selected = new Map<string, SelectedField>();
    const palette: Record<string, string> = {
      title: '#2563eb',
      time: '#7c3aed',
      author: '#0f766e',
      content: '#dc2626',
      image: '#d97706',
      price: '#0891b2',
      link: '#0891b2',
      field: '#4b5563'
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function elementIdentity(element: Element | null): string {
      if (!element) return '';
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('rel') || '',
        element.getAttribute('itemprop') || ''
      ].join(' ');
    }

    function nearestIdentity(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      let depth = 0;
      while (current && depth < 4) {
        parts.push(elementIdentity(current));
        current = current.parentElement;
        depth += 1;
      }
      return parts.join(' ');
    }

    function boilerplateLike(element: Element): boolean {
      const tag = element.tagName.toLowerCase();
      if (/^(script|style|noscript|svg|button|input|select|textarea|nav|footer|header|aside)$/i.test(tag)) return true;
      const identity = nearestIdentity(element);
      if (/(^|\b)(ad|ads|advert|advertise|banner|sponsor|推广|广告)(\b|$)/i.test(identity)) return true;
      if (/(sidebar|side-bar|rightbar|recommend|related|hot|rank|popular|精选|推荐|热门|排行|应用|下载|客户端)/i.test(identity)) return true;
      if (/(toolbar|tool-bar|share|forward|comment|reply|collect|favorite|like|interaction|operate|action|qrcode|qr-code|登录|关注)/i.test(identity)) return true;
      const style = window.getComputedStyle(element);
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      return false;
    }

    function styleTextLike(value: string): boolean {
      if (!value) return false;
      const cssTokenCount = (value.match(/--weui-|data_color_scheme|rgba?\(|#[0-9a-f]{3,8}\b|ACTIVE-|BG-|FG-/gi) ?? []).length;
      return cssTokenCount >= 8 || /--weui-[\s\S]{80,}/i.test(value) || /\.data_color_scheme_dark\{/i.test(value);
    }

    function isChromeNoiseElement(element: Element): boolean {
      const html = element as HTMLElement;
      const attrs = `${html.id || ''} ${typeof html.className === 'string' ? html.className : ''} ${html.getAttribute('role') || ''}`;
      if (/(?:mw-editsection|editsection|navbox|vertical-navbox|catlinks|toc|toctitle|mw-jump|vector-toc|noprint|mw-indicators|siteNotice|sistersitebox)/i.test(attrs)) return true;
      if (element.closest('.mw-editsection, .navbox, .catlinks, #toc, .toc, .vector-toc, .mw-jump-link, footer, [role="contentinfo"], nav, [role="navigation"]')) return true;
      return false;
    }

    function cleanProseText(value: string): string {
      return value
        .replace(/\[\s*edit\s*\]/gi, ' ')
        .replace(/\bedit\s*$/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Keep content scoring aligned with detectDetails() (post detail-page recognition upgrade).
    function contentScore(element: Element): number {
      const tag = element.tagName.toLowerCase();
      if (/^(script|style|noscript|nav|footer|header|aside|button|input|select|textarea)$/i.test(tag)) return -Infinity;
      const idClass = `${(element as HTMLElement).id || ''} ${(element as HTMLElement).className || ''}`;
      if (/(?:related|recommend|sidebar|comment|footer|nav|menu|toc|table-of-contents)/i.test(idClass) && !/(?:article|content|mw-content|post|entry|markdown-body)/i.test(idClass)) {
        return -Infinity;
      }
      if (!visible(element) || boilerplateLike(element)) return -Infinity;
      const value = text(element);
      if (styleTextLike(value)) return -Infinity;
      if (value.length < 120 || value.length > 120000) return -Infinity;
      const rect = element.getBoundingClientRect();
      const paragraphs = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20);
      const linkText = Array.from(element.querySelectorAll('a')).map((item) => text(item)).join(' ');
      const linkDensity = linkText.length / Math.max(1, value.length);
      if (linkDensity > 0.72 && paragraphs.length < 3) return -Infinity;
      const sentenceMarks = (value.match(/[。！？!?；;，,]/g) ?? []).length;
      const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / Math.max(1, window.innerWidth);
      let score = 0;
      score += Math.min(6, value.length / 500);
      score += Math.min(5, paragraphs.length * 0.7);
      score += Math.min(2, sentenceMarks * 0.08);
      score -= centerPenalty;
      score -= Math.max(0, linkDensity - 0.25) * 2.2;
      if (/^(article|main)$/i.test(tag) || /(?:article|content|mw-content|post|entry|markdown-body)/i.test(idClass)) score += 1.4;
      if (element.querySelector('h1,h2,h3')) score += 0.35;
      return score;
    }

    function contentRoot(base: Element): Element | null {
      const selectors = [
        'article',
        'main',
        '#mw-content-text',
        '#content',
        '[role="main"]',
        '.markdown-body',
        '.post-content',
        '.entry-content',
        '.article-content',
        'section',
        'div[class*="article" i]',
        'div[class*="content" i]',
        'div[id*="article" i]',
        'div[id*="content" i]'
      ];
      const extra = selectors.flatMap((sel) => Array.from(base.querySelectorAll(sel)));
      const candidates = [base, ...extra]
        .filter((element, index, array) => array.indexOf(element) === index)
        .map((element) => ({ element, score: contentScore(element) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.element ?? null;
    }

    function pickTitle(): Element | null {
      const preferred = document.querySelector(
        '#firstHeading, strong[itemprop="name"] a, [itemprop="name"] a, #repository-container-header strong a, h1.gh-header-title, .js-issue-title, article h1, .post-title, .entry-title'
      );
      if (preferred && text(preferred).length >= 2) {
        const value = text(preferred);
        if (!/search code|repositories, users|sign in|log in|provide feedback|menu|navigation/i.test(value)) {
          return preferred;
        }
      }
      const candidates = Array.from(document.querySelectorAll('h1, [class*="title" i] h1, #firstHeading, .gh-header-title, .js-issue-title'))
        .filter((element) => {
          const value = text(element);
          if (!value || value.length < 3 || value.length > 220) return false;
          if (/search code|repositories, users|sign in|log in|provide feedback|menu|navigation/i.test(value)) return false;
          return true;
        })
        .map((element) => {
          const value = text(element);
          const rect = element.getBoundingClientRect();
          let score = Math.min(40, value.length);
          if (element.tagName.toLowerCase() === 'h1') score += 12;
          if (element.id === 'firstHeading' || /title|headline|post-title|entry-title|itemprop="name"/i.test(`${element.id} ${(element as HTMLElement).className || ''}`)) score += 10;
          if (rect.top >= 0 && rect.top < window.innerHeight * 0.7) score += 6;
          return { element, score };
        })
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.element ?? document.querySelector('h1') ?? null;
    }

    function pickImage(scope: Element): HTMLImageElement | null {
      const images = Array.from(scope.querySelectorAll('img')) as HTMLImageElement[];
      const ranked = images
        .map((img) => {
          const src = img.currentSrc || img.src || '';
          if (!src || /data:image\/svg|sprite|icon|avatar|badge|logo|pixel|1x1|spacer/i.test(src)) return null;
          if (/badge\.svg|actions\/workflows|shields\.io|gravatar/i.test(src)) return null;
          const rect = img.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          if (area > 0 && area < 80 * 80) return null;
          return { img, area: area || 1, top: rect.top };
        })
        .filter(Boolean)
        .sort((a, b) => (b!.area - a!.area) || (a!.top - b!.top));
      return ranked[0]?.img ?? null;
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        const currentTag = current.tagName;
        const siblings: Element[] = parent ? Array.from(parent.children).filter((item): item is Element => item instanceof Element && item.tagName === currentTag) : [];
        parts.unshift(`${tag}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return `/${parts.join('/')}`;
    }

    function selector(element: Element): string {
      const html = element as HTMLElement;
      try {
        if (html.id) return `#${CSS.escape(html.id)}`;
      } catch {
        if (html.id) return `#${String(html.id).replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`;
      }
      const cls = typeof html.className === 'string'
        ? html.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => `.${CSS.escape(part)}`).join('')
        : '';
      return `${element.tagName.toLowerCase()}${cls}`;
    }

    function fieldKind(element: Element): 'text' | 'href' | 'src' {
      if (element instanceof HTMLImageElement) return 'src';
      if (element instanceof HTMLAnchorElement) return 'href';
      return 'text';
    }

    function sampleValue(element: Element, kind: 'text' | 'href' | 'src'): string {
      if (kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      if (kind === 'href') return (element as HTMLAnchorElement).href || '';
      return text(element);
    }

    function fieldDiagnostics(element: Element): SelectedField['diagnostics'] {
      const value = text(element);
      const paragraphCount = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20).length;
      const warnings: string[] = [];
      if (value.length < 300) warnings.push('content text looks short');
      if (paragraphCount <= 1) warnings.push('content has too few paragraphs');
      if (styleTextLike(value)) warnings.push('text contains CSS/style noise');
      return {
        matchCount: 1,
        textLength: value.length,
        paragraphCount,
        hasStyleNoise: styleTextLike(value),
        warnings
      };
    }

    function suggestedName(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const identity = [
        tag,
        (element as HTMLElement).id || '',
        typeof (element as HTMLElement).className === 'string' ? (element as HTMLElement).className : '',
        element.getAttribute('rel') || '',
        element.getAttribute('itemprop') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ');
      const value = text(element);
      if (element instanceof HTMLImageElement) return 'image';
      if (/^(h1|h2|h3)$/i.test(tag) || /title|headline/i.test(identity)) return 'title';
      if (value.length > 80 || element.querySelectorAll('p').length >= 2) return 'content';
      if ((/time|date|publish|pubtime|datetime|时间|日期/i.test(identity) || /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(value)) && value.length <= 90) return 'time';
      if (/author|byline|writer|source|media|account|name|user|nick|作者|来源|账号|媒体/i.test(identity) && value.length <= 80) return 'author';
      if (element instanceof HTMLAnchorElement) return 'link';
      if (/article|content|body|main|detail|正文|内容/i.test(identity) || tag === 'article') return 'content';
      return 'field';
    }

    function resolveXPath(path: string): Element | null {
      if (!path) return null;
      try {
        const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
        const result = document.evaluate(normalized, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
      } catch {
        return null;
      }
    }

    function makeFieldFromSuggested(element: Element, item: SuggestedItem): SelectedField {
      return {
        id: item.xpath || xpath(element),
        suggestedName: item.suggestedName || suggestedName(element),
        kind: item.kind || fieldKind(element),
        xpath: item.xpath || xpath(element),
        selector: item.selector || selector(element),
        sample: item.sample || sampleValue(element, item.kind || fieldKind(element)),
        ...(item.diagnostics
          ? { diagnostics: item.diagnostics }
          : (item.suggestedName === 'content' ? { diagnostics: fieldDiagnostics(element) } : {}))
      };
    }

    function makeField(element: Element): SelectedField {
      const name = suggestedName(element);
      const kind = fieldKind(element);
      const itemXpath = xpath(element);
      return {
        id: itemXpath,
        suggestedName: name,
        kind,
        xpath: itemXpath,
        selector: selector(element),
        sample: sampleValue(element, kind),
        ...(name === 'content' ? { diagnostics: fieldDiagnostics(element) } : {})
      };
    }

    function drawField(element: Element, field: SelectedField): void {
      const html = element as HTMLElement;
      if (byElement.has(element)) return;
      byElement.set(element, field);
      html.dataset.octopusDetailOutline = html.style.outline;
      html.dataset.octopusDetailOutlineOffset = html.style.outlineOffset;
      html.dataset.octopusDetailBackground = html.style.backgroundColor;
      html.dataset.octopusDetailBoxShadow = html.style.boxShadow;
      const color = palette[field.suggestedName] || palette.field;
      html.dataset.octopusDetailColor = color;
      html.style.outline = `2px solid ${color}`;
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = `${color}12`;
      html.style.cursor = 'crosshair';
      highlighted.push(html);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = field.suggestedName;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 22)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '3px 6px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,.18)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function draw(element: Element): void {
      drawField(element, makeField(element));
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        label.style.left = `${Math.max(0, rect.left)}px`;
        label.style.top = `${Math.max(0, rect.top - 22)}px`;
      });
    }

    function fallbackCandidateElements(): Element[] {
      // Mirror detectDetails preferred root / bodyRoot / field picks when precomputed suggestions miss.
      const preferredRoot = document.querySelector('#mw-content-text .mw-parser-output')
        || document.querySelector('#mw-content-text')
        || document.querySelector('#readme .markdown-body, #readme, [data-testid="readme"] .markdown-body, article .markdown-body, .markdown-body')
        || document.querySelector('article')
        || document.querySelector('main, [role="main"], #content')
        || document.body;
      const preferredText = text(preferredRoot);
      const preferredParagraphs = Array.from(preferredRoot.querySelectorAll('p'))
        .filter((item) => !isChromeNoiseElement(item) && cleanProseText(text(item)).length >= 40);
      const bodyRoot = (preferredText.length >= 280 && preferredParagraphs.length >= 1)
        ? preferredRoot
        : (contentRoot(preferredRoot) || preferredRoot);
      const title = pickTitle()
        || document.querySelector('#firstHeading')
        || document.querySelector('strong[itemprop="name"] a, [itemprop="name"] a')
        || preferredRoot.querySelector('h1,h2');
      const time = preferredRoot.querySelector('time,[datetime],[class*="date" i],[class*="time" i]');
      const author = preferredRoot.querySelector('[class*="author" i],[rel="author"], .byline, [itemprop="author"]');
      const image = pickImage(bodyRoot) || pickImage(preferredRoot);
      const contentOk = cleanProseText(text(bodyRoot)).length >= 80;
      return [title, time, author, contentOk ? bodyRoot : null, image]
        .filter((element): element is Element => Boolean(element))
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter(visible);
    }

    // Primary: draw fields from detectDetails() so manual matches auto detail recognition.
    for (const item of suggestedItems as SuggestedItem[]) {
      const element = resolveXPath(item.xpath);
      if (!element || !visible(element)) continue;
      drawField(element, makeFieldFromSuggested(element, item));
    }

    // Fallback / fill-in: if detectDetails returned nothing usable, or content/title missing, use aligned DOM picks.
    if (!highlighted.length) {
      fallbackCandidateElements().forEach(draw);
    } else {
      const names = new Set(Array.from(highlighted).map((el) => byElement.get(el)?.suggestedName).filter(Boolean));
      if (!names.has('content') || !names.has('title')) {
        for (const element of fallbackCandidateElements()) {
          const name = suggestedName(element);
          if (names.has(name)) continue;
          if (name === 'content' || name === 'title' || name === 'time' || name === 'author' || name === 'image') {
            draw(element);
            names.add(name);
          }
        }
      }
    }

    positionLabels();

    function sync(): void {
      highlighted.forEach((element) => {
        const field = byElement.get(element);
        const isSelected = field ? selected.has(field.id) : false;
        const color = element.dataset.octopusDetailColor || palette.field;
        element.style.outline = `${isSelected ? 5 : 2}px solid ${color}`;
        element.style.backgroundColor = isSelected ? `${color}33` : `${color}12`;
        element.style.boxShadow = isSelected ? `0 0 0 2px ${color}55` : '';
      });
      w.__octopusDetailFieldSelections = Array.from(selected.values()).map((field) => `detail_${field.suggestedName}`);
      w.__octopusDetailFieldObjects = Array.from(selected.values());
    }

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      let target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      let field = target ? byElement.get(target) : undefined;
      // Freeform pick: allow clicking non-suggested in-page elements during manual confirm.
      if (!field) {
        const free = path.find((item): item is Element =>
          item instanceof Element
          && item !== document.documentElement
          && item !== document.body
          && visible(item)
          && !boilerplateLike(item)
          && !(item instanceof HTMLElement && item.id === 'octopus-detail-field-overlay-root')
        );
        if (!free) return;
        if (!byElement.has(free)) draw(free);
        target = free;
        field = byElement.get(free);
      }
      if (!target || !field) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (selected.has(field.id)) selected.delete(field.id);
      else selected.set(field.id, field);
      sync();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusDetailFieldClearSelection = () => {
      selected.clear();
      sync();
    };
    w.__octopusDetailFieldCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetailOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetailOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetailBackground || '';
        element.style.boxShadow = element.dataset.octopusDetailBoxShadow || '';
        element.style.cursor = '';
        delete element.dataset.octopusDetailOutline;
        delete element.dataset.octopusDetailOutlineOffset;
        delete element.dataset.octopusDetailBackground;
        delete element.dataset.octopusDetailBoxShadow;
        delete element.dataset.octopusDetailColor;
      });
      labels.forEach((label) => label.remove());
      root.remove();
      w.__octopusDetailFieldSelections = [];
      w.__octopusDetailFieldObjects = [];
      delete w.__octopusDetailFieldClearSelection;
      delete w.__octopusDetailFieldCleanup;
    };
  }, suggestedFields);
}

export async function readDetailFieldSelection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldSelections?: string[] };
    return Array.isArray(w.__octopusDetailFieldSelections) ? w.__octopusDetailFieldSelections : [];
  });
}

export async function readDetailFieldObjects(page: Page): Promise<Array<{
  suggestedName: string;
  kind: 'text' | 'href' | 'src';
  xpath: string;
  selector: string;
  sample: string;
  diagnostics?: DetectedFieldDiagnostics;
}>> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusDetailFieldObjects?: Array<{
        suggestedName: string;
        kind: 'text' | 'href' | 'src';
        xpath: string;
        selector: string;
        sample: string;
        diagnostics?: DetectedFieldDiagnostics;
      }>;
    };
    return Array.isArray(w.__octopusDetailFieldObjects) ? w.__octopusDetailFieldObjects : [];
  });
}

export async function clearDetailFieldSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldClearSelection?: () => void };
    w.__octopusDetailFieldClearSelection?.();
  });
}

export async function removeDetailFieldOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldCleanup?: () => void };
    w.__octopusDetailFieldCleanup?.();
  });
}

export async function removeCandidateOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetectionCleanup?: () => void };
    w.__octopusDetectionCleanup?.();
  });
}
