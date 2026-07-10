import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedField } from './types.js';

export async function refineCandidateFields(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
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

  const refinedById = await page.evaluate((items) => {
    type FieldInfo = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      xpath: string;
      relativeSelector?: string;
      relativeXPath?: string;
      operations?: Array<{ type: 'trim' | 'regex_match' | 'regex_replace'; params: string[] }>;
      samples: string[];
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function directText(element: Element | null): string {
      if (!element) return '';
      const parts = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '');
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function readableText(element: Element | null): string {
      return directText(element) || text(element);
    }

    function hasVisibleImage(element: Element): boolean {
      return Array.from(element.querySelectorAll('img')).some(visible);
    }

    function textFieldValue(element: Element): string {
      const own = directText(element);
      if (own) return own;
      const tag = element.tagName.toLowerCase();
      const value = text(element);
      if (/^(a|h1|h2|h3|h4|p|span|time|em|i|strong|b)$/i.test(tag)) return value;
      if (element.children.length <= 1 && !hasVisibleImage(element)) return value;
      return '';
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
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

    function generalRelativeXPath(row: Element, element: Element): string {
      const absoluteRow = xpath(row);
      const absoluteElement = xpath(element);
      if (absoluteElement.startsWith(absoluteRow)) {
        const relative = absoluteElement.slice(absoluteRow.length).replace(/^\/?/, './');
        return relative === './' ? '.' : relative;
      }
      return '.';
    }

    function absoluteFieldXPath(rowXPath: string, relativeXPath: string): string {
      if (relativeXPath.includes('|')) {
        return relativeXPath
          .split(/\s*\|\s*/)
          .map((part) => absoluteFieldXPath(rowXPath, part.trim()))
          .filter(Boolean)
          .join(' | ');
      }
      if (relativeXPath === '.') return rowXPath;
      return `${rowXPath}${relativeXPath.replace(/^\./, '')}`;
    }

    function compactRelativeXPath(row: Element, element: Element): string {
      if (element === row) return '.';
      const semanticPath = semanticRelativeXPath(row, element);
      if (semanticPath) return semanticPath;
      const exactPath = generalRelativeXPath(row, element);
      if (exactPath !== '.') return exactPath;
      const tag = element.tagName.toLowerCase();
      const sameTag = Array.from(row.querySelectorAll(tag)).filter(visible);
      const index = sameTag.indexOf(element);
      if (index >= 0) return `.//${tag}[${index + 1}]`;
      return '.';
    }

    function semanticRelativeXPath(row: Element, element: Element): string {
      const tag = element.tagName.toLowerCase();
      const attrNames = ['data-testid', 'data-test', 'data-qa', 'data-role', 'aria-label', 'rel', 'itemprop'];
      for (const attr of attrNames) {
        const value = element.getAttribute(attr);
        if (!value || value.length > 80) continue;
        const candidate = `.//${tag}[@${attr}=${xpathLiteral(value)}]`;
        if (uniqueRelativeMatch(row, element, candidate)) return candidate;
      }
      const classAttr = (element as HTMLElement).className || '';
      if (typeof classAttr === 'string') {
        const tokens = classAttr
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => /^[A-Za-z][\w-]{2,}$/.test(token))
          .filter((token) => !/^(active|selected|visible|hidden|show|open|current|disabled|loaded)$/i.test(token))
          .sort((a, b) => semanticTokenScore(b) - semanticTokenScore(a) || a.length - b.length);
        for (const token of tokens.slice(0, 4)) {
          const candidate = `.//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(` ${token} `)})]`;
          if (uniqueRelativeMatch(row, element, candidate)) return candidate;
        }
      }
      return '';
    }

    function semanticTokenScore(token: string): number {
      if (/title|name|author|byline|user|nick|creator|owner|profile|member|like|count|heart|collect|favorite|image|img|cover|thumb|avatar|date|time|desc|summary|content/i.test(token)) return 2;
      if (/text|info|meta|footer|body|header|caption/i.test(token)) return 1;
      return 0;
    }

    function uniqueRelativeMatch(row: Element, element: Element, relativeXPath: string): boolean {
      try {
        const result = document.evaluate(relativeXPath, row, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === element;
      } catch {
        return false;
      }
    }

    function xpathLiteral(value: string): string {
      if (!value.includes('"')) return `"${value}"`;
      if (!value.includes("'")) return `'${value}'`;
      return `concat(${value.split('"').map((part) => `"${part}"`).join(', \'"\', ')})`;
    }

    function textNodeRelativeXPath(row: Element, value: string): string {
      const matching = Array.from(row.querySelectorAll('*'))
        .filter(visible)
        .find((element) => directText(element) === value || readableText(element) === value);
      if (matching) return compactRelativeXPath(row, matching);
      return `.//*[normalize-space(text())=${xpathLiteral(value)}]`;
    }

    function fieldKey(name: string, kind: string, relativeXPath: string): string {
      return `${name}:${kind}:${relativeXPath}`;
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.className || '',
        html.id || '',
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

    function isButtonText(value: string): boolean {
      return /^(查看|更多|点击|回复|提交|确定|取消|登录|注册|搜索|分享|收藏|加入|上一页|下一页|next|prev|more|view|read more)$/i.test(value.trim());
    }

    function isNumericLike(value: string): boolean {
      const compact = value.replace(/[0-9\s.,:/\-年月日￥¥$元円€()（）]/g, '');
      return compact.length < 3 && /[0-9]/.test(value);
    }

    function isEngagementCount(value: string): boolean {
      const compact = value.replace(/\s+/g, '');
      if (!compact || compact.length > 24 || !/\d/.test(compact)) return false;
      if (dateMatch(compact)) return false;
      return /^(赞|喜欢|收藏|评论|转发|like|likes|save|saves|comment|comments|share|shares)?[:：]?[♡♥❤👍]?\d+(?:[.,]\d+)?(?:万|千|亿|w|k|m)?\+?(赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?$/i.test(compact);
    }

    function stripTrailingEngagement(value: string): string {
      return value.replace(new RegExp(authorEngagementSuffixPatternSource, 'i'), '').replace(/\s+/g, ' ').trim();
    }

    function stripDateFromAuthor(value: string): string {
      const date = dateMatch(value);
      if (!date) return value.replace(/\s+/g, ' ').trim();
      return value.replace(date, '').replace(/[|｜·•,，:：-]+$/g, '').replace(/\s+/g, ' ').trim();
    }

    function isAuthorText(value: string): boolean {
      const compact = value.trim();
      if (compact.length < 2 || compact.length > 60) return false;
      if (isButtonText(compact) || isEngagementCount(compact) || dateMatch(compact)) return false;
      if (/^https?:\/\//i.test(compact)) return false;
      return true;
    }

    function visualArea(element: Element): number {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function largestImageRect(row: Element): DOMRect | null {
      const images = Array.from(row.querySelectorAll('img'))
        .filter(visible)
        .map((image) => image.getBoundingClientRect())
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      return images[0] || null;
    }

    function overlapRatio(rect: DOMRect, other: DOMRect): number {
      const left = Math.max(rect.left, other.left);
      const right = Math.min(rect.right, other.right);
      const top = Math.max(rect.top, other.top);
      const bottom = Math.min(rect.bottom, other.bottom);
      if (right <= left || bottom <= top) return 0;
      return ((right - left) * (bottom - top)) / Math.max(1, rect.width * rect.height);
    }

    function overlapsMainImage(row: Element, rect: DOMRect, minRatio = 0.35): boolean {
      const imageRect = largestImageRect(row);
      if (!imageRect) return false;
      const rowRect = row.getBoundingClientRect();
      if ((imageRect.width * imageRect.height) / Math.max(1, rowRect.width * rowRect.height) < 0.18) return false;
      return overlapRatio(rect, imageRect) >= minRatio;
    }

    function fieldValue(row: Element, relativeXPath: string, kind: 'text' | 'href' | 'src'): string {
      const target = relativeXPath && relativeXPath !== '.'
        ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      const element = target instanceof Element ? target : null;
      if (!element) return '';
      if (kind === 'href') return (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      if (kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      return textFieldValue(element) || readableText(element);
    }

    function fieldElement(row: Element, relativeXPath: string): Element | null {
      const target = relativeXPath && relativeXPath !== '.'
        ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      return target instanceof Element ? target : null;
    }

    function fieldRect(row: Element, relativeXPath: string): DOMRect | null {
      return fieldElement(row, relativeXPath)?.getBoundingClientRect() || null;
    }

    function applyOperations(value: string, operations?: FieldInfo['operations']): string {
      let output = value;
      for (const operation of operations || []) {
        if (operation.type === 'trim') output = output.trim();
        else if (operation.type === 'regex_match') output = output.match(new RegExp(operation.params[0] || ''))?.[0] || '';
        else if (operation.type === 'regex_replace') output = output.replace(new RegExp(operation.params[0] || '', 'g'), operation.params[1] || '');
      }
      return output;
    }

    function sampleValue(row: Element, field: FieldInfo): string {
      return applyOperations(fieldValue(row, field.relativeXPath || '.', field.kind), field.operations);
    }

    function makeField(
      name: string,
      kind: 'text' | 'href' | 'src',
      selector: string,
      rowXPath: string,
      relativeXPath: string,
      rows: Element[]
    ): FieldInfo | null {
      const values = rows.map((row) => fieldValue(row, relativeXPath, kind)).filter(Boolean);
      const minSamples = rows.length >= 3 ? 2 : 1;
      if (values.length < minSamples) return null;
      return {
        name,
        kind,
        selector,
        xpath: absoluteFieldXPath(rowXPath, relativeXPath),
        relativeSelector: selector,
        relativeXPath,
        samples: values.slice(0, 3)
      };
    }

    function uniqueRate(values: string[]): number {
      const filled = values.filter(Boolean);
      if (!filled.length) return 0;
      return new Set(filled).size / filled.length;
    }

    function normalizedComparableText(value: string): string {
      return value.replace(/\s+/g, '').replace(/[|｜·•,，.。:：;；!?！？'"“”‘’()[\]（）【】]/g, '').toLowerCase();
    }

    function samplesDuplicate(left: string[], right: string[]): boolean {
      const pairs = left
        .map((value, index) => [normalizedComparableText(value), normalizedComparableText(right[index] || '')] as const)
        .filter(([a, b]) => a && b);
      if (!pairs.length) return false;
      const duplicateCount = pairs.filter(([a, b]) => a === b || a.includes(b) && b.length >= 6 || b.includes(a) && a.length >= 6).length;
      return duplicateCount / pairs.length >= 0.8;
    }

    function bestByScore<T>(items: T[], score: (item: T) => number): T | undefined {
      return items.map((item) => ({ item, score: score(item) })).sort((a, b) => b.score - a.score)[0]?.item;
    }

    function textFieldQuality(name: string, values: string[]): boolean {
      const filled = values.filter(Boolean);
      if (!filled.length) return false;
      if (name === 'author') {
        return filled.some((value) => {
          const authorText = stripTrailingEngagement(value);
          const withoutDate = stripDateFromAuthor(authorText || value);
          return authorText !== value && isAuthorText(authorText) || withoutDate !== value && isAuthorText(withoutDate) || isAuthorText(value);
        }) && !filled.every((value) => isEngagementCount(value));
      }
      if (isEngagementFieldName(name)) return filled.every((value) => isEngagementCount(value));
      if (name === 'title') return filled.some((value) => value.length >= 2 && value.length <= 220 && !isEngagementCount(value) && !dateMatch(value));
      if (name === 'summary') return filled.some((value) => value.length > 12 && value.length < 300 && !isEngagementCount(value));
      return true;
    }

    function fieldLayoutQuality(name: string, row: Element, field: FieldInfo): boolean {
      const rect = fieldRect(row, field.relativeXPath || '.');
      if (!rect) return false;
      const rowRect = row.getBoundingClientRect();
      const value = field.samples.find(Boolean) || '';
      const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
      const areaRatio = (rect.width * rect.height) / Math.max(1, rowRect.width * rowRect.height);
      if (name === 'title') {
        if (isEngagementCount(value)) return false;
        if (areaRatio > 0.45 && hasVisibleImage(fieldElement(row, field.relativeXPath || '.') || row)) return false;
        if (overlapsMainImage(row, rect)) return false;
        return y < 1.02;
      }
      if (name === 'author') return y > 0.35 && y < 1.02 && areaRatio < 0.35;
      if (isEngagementFieldName(name)) return y > 0.35 && y < 1.02 && areaRatio < 0.25;
      if (name === 'summary') return areaRatio < 0.45;
      return true;
    }

    function scanColumnFields(first: Element, rows: Element[], rowXPath: string): FieldInfo[] {
      type Column = {
        kind: 'text' | 'href' | 'src';
        element: Element;
        relativeXPath: string;
        selector: string;
        values: string[];
        fillRate: number;
      };
      const allElements = [first, ...Array.from(first.querySelectorAll('*'))].filter(visible);
      const columns: Column[] = [];
      const seen = new Set<string>();
      const addColumn = (element: Element, kind: Column['kind']) => {
        const relativeXPath = element === first ? '.' : compactRelativeXPath(first, element);
        const key = `${kind}:${relativeXPath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const values = rows.map((row) => fieldValue(row, relativeXPath, kind));
        const fillRate = values.filter(Boolean).length / Math.max(1, rows.length);
        if (fillRate < (rows.length >= 3 ? 0.45 : 0.5)) return;
        columns.push({ kind, element, relativeXPath, selector: element.tagName.toLowerCase(), values, fillRate });
      };

      for (const element of allElements) {
        const tag = element.tagName.toLowerCase();
        if (/^(script|style|noscript|svg|button|input|select|textarea)$/.test(tag)) continue;
        if (tag === 'img') {
          const image = element as HTMLImageElement;
          const src = image.currentSrc || image.src;
          if (src && (image.naturalWidth >= 20 || image.width >= 20) && (image.naturalHeight >= 20 || image.height >= 20)) addColumn(element, 'src');
        }
        if (tag === 'a' && (element as HTMLAnchorElement).href && !(element as HTMLAnchorElement).href.includes('#')) {
          addColumn(element, 'href');
        }
        const value = textFieldValue(element);
        if (!value || value.length > 300 || isButtonText(value)) continue;
        addColumn(element, 'text');
      }

      const fields: FieldInfo[] = [];
      const image = bestByScore(
        columns.filter((column) => column.kind === 'src'),
        (column) => {
          const rect = column.element.getBoundingClientRect();
          const identity = elementIdentity(column.element);
          const avatarPenalty = /avatar|head|user|author|profile|logo|icon/i.test(identity) || Math.abs(rect.width - rect.height) < 8 && rect.width <= 80 ? 0.75 : 0;
          return column.fillRate + Math.min(0.7, visualArea(column.element) / Math.max(1, visualArea(first))) - avatarPenalty;
        }
      );
      const dateColumns = columns.filter((column) => column.kind === 'text' && column.values.some((value) => Boolean(dateMatch(value))) && column.values.filter(Boolean).every((value) => value.length <= 90));
      const preferredDateColumns = dateColumns.some((column) => column.relativeXPath !== '.') ? dateColumns.filter((column) => column.relativeXPath !== '.') : dateColumns;
      const date = bestByScore(
        preferredDateColumns,
        (column) => column.fillRate + (/time|date/i.test(elementIdentity(column.element)) ? 0.4 : 0) - Math.max(0, (column.values[0] || '').length - 30) / 100
      );
      const title = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const sampleValue = column.values.find(Boolean) || '';
          if (sampleValue.length < 3 || sampleValue.length > 220) return false;
          if (dateMatch(sampleValue) || isNumericLike(sampleValue) || isEngagementCount(sampleValue) || isButtonText(sampleValue)) return false;
          return uniqueRate(column.values) >= 0.55;
        }),
        (column) => {
          const tag = column.element.tagName.toLowerCase();
          const semantic = /^(h1|h2|h3|h4|a)$/.test(tag) ? 0.55 : /title|tit/i.test(elementIdentity(column.element)) ? 0.45 : 0;
          const rect = column.element.getBoundingClientRect();
          const rowRect = first.getBoundingClientRect();
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          const yScore = y > 0.2 && y < 0.82 ? 0.25 : -0.25;
          const lengthScore = Math.min(0.25, (column.values.find(Boolean) || '').length / 180);
          return column.fillRate + semantic + lengthScore + yScore + Math.min(0.2, rect.width / 900);
        }
      );
      const url = title
        ? bestByScore(
          columns.filter((column) => column.kind === 'href' && (column.relativeXPath === title.relativeXPath || column.element === title.element || column.element.contains(title.element) || title.element.contains(column.element))),
          (column) => column.fillRate + 0.5
        ) || bestByScore(columns.filter((column) => column.kind === 'href'), (column) => column.fillRate)
        : bestByScore(columns.filter((column) => column.kind === 'href'), (column) => column.fillRate);
      const summary = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (title && column.relativeXPath === title.relativeXPath) return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const value = column.values.find(Boolean) || '';
          return value.length > 12 && value.length < 300 && !dateMatch(value) && !isButtonText(value);
        }),
        (column) => column.fillRate + Math.min(0.25, (column.values.find(Boolean) || '').length / 260)
      );
      const author = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (title && column.relativeXPath === title.relativeXPath) return false;
          if (summary && column.relativeXPath === summary.relativeXPath) return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const value = column.values.find(Boolean) || '';
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(column.element));
          const profileLink = hasProfileLink(column.element);
          const authorValue = stripTrailingEngagement(value);
          const looksLikeAuthor = isAuthorText(value) || (authorValue !== value && isAuthorText(authorValue));
          return looksLikeAuthor && (semantic || profileLink || (authorValue || value).length <= 32 && uniqueRate(column.values) >= 0.55);
        }),
        (column) => {
          const rect = column.element.getBoundingClientRect();
          const rowRect = first.getBoundingClientRect();
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(column.element)) ? 0.75 : 0;
          const profileLink = hasProfileLink(column.element) ? 0.45 : 0;
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          const bottomScore = y > 0.55 ? 0.45 : y > 0.35 ? 0.25 : -0.35;
          return column.fillRate + semantic + profileLink + bottomScore - Math.max(0, stripTrailingEngagement(column.values.find(Boolean) || '').length - 24) / 100;
        }
      );
      const pushColumn = (name: string, column: Column | undefined) => {
        if (!column) return;
        const field = makeField(name, column.kind, column.selector, rowXPath, column.relativeXPath, rows);
        if (!field) return;
        if (field.kind === 'text' && !textFieldQuality(name, field.samples)) return;
        const operation = name === 'date' && column.kind === 'text' && column.values.some((value) => value !== dateMatch(value))
          ? { operations: [{ type: 'regex_match' as const, params: [datePatternSource] }] }
          : name === 'author' && column.kind === 'text' && field.samples.some((value) => {
            const stripped = stripTrailingEngagement(value);
            return stripped !== value && isAuthorText(stripped);
          })
            ? { operations: [{ type: 'regex_replace' as const, params: [authorEngagementSuffixPatternSource, ''] }, { type: 'trim' as const, params: ['0'] }] }
          : {};
        fields.push({ ...field, ...operation });
      };
      pushColumn('title', title);
      pushColumn('url', url);
      pushColumn('image', image);
      pushColumn('date', date);
      pushColumn('summary', summary);
      pushColumn('author', author);
      return fields;
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';
    const authorEngagementSuffixPatternSource = '\\s*(?:[♡♥❤👍]\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?(?:万|千|亿|w|k|m)\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?))\\s*$';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function hasProfileLink(element: Element): boolean {
      return Boolean(
        element.closest('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]')
        || element.querySelector('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]')
      );
    }

    function findDateElement(row: Element): Element | null {
      const candidates = Array.from(row.querySelectorAll('time,[datetime],[class*="date" i],[class*="time" i],span,p,div,em,i,b,strong'))
        .filter(visible)
        .filter((element) => {
          const value = readableText(element);
          return value.length <= 90 && Boolean(dateMatch(value));
        });
      return candidates.sort((a, b) => {
        const aSemantic = /time|date/i.test(`${a.id} ${(a as HTMLElement).className} ${(a as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
        const bSemantic = /time|date/i.test(`${b.id} ${(b as HTMLElement).className} ${(b as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
        if (aSemantic !== bSemantic) return aSemantic - bSemantic;
        return readableText(a).length - readableText(b).length;
      })[0] || null;
    }

    function findDateText(row: Element): string {
      return dateMatch(text(row));
    }

    function findTitleElement(row: Element, dateElement: Element | null): Element | null {
      const rowRect = row.getBoundingClientRect();
      const link = Array.from(row.querySelectorAll('a')).filter(visible).find((element) => {
        const value = textFieldValue(element) || readableText(element);
        const rect = element.getBoundingClientRect();
        const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
        return value.length >= 2 && value.length <= 220 && y < 1.02 && !overlapsMainImage(row, rect) && element !== dateElement && !element.contains(dateElement) && !isEngagementCount(value);
      });
      if (link) return link;
      const candidates = Array.from(row.querySelectorAll('h1,h2,h3,h4,[class*="title" i],a,p,span,div'))
        .filter(visible)
        .filter((element) => element !== dateElement && !element.contains(dateElement))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          return { element, value: textFieldValue(element) || readableText(element), rect, y };
        })
        .filter((item) => item.value.length >= 4 && item.value.length <= 220)
        .filter((item) => !/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(item.value))
        .filter((item) => !isEngagementCount(item.value))
        .filter((item) => item.y < 1.02 && !overlapsMainImage(row, item.rect))
        .sort((a, b) => {
          const tagWeight = (element: Element) => /^(h1|h2|h3|h4|a)$/i.test(element.tagName) ? 0 : 1;
          if (tagWeight(a.element) !== tagWeight(b.element)) return tagWeight(a.element) - tagWeight(b.element);
          return b.rect.width - a.rect.width;
        });
      return candidates[0]?.element || null;
    }

    function findMainImageElement(row: Element): HTMLImageElement | null {
      return Array.from(row.querySelectorAll('img'))
        .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement && visible(element))
        .filter((image) => {
          const src = image.currentSrc || image.src;
          return Boolean(src) && (image.naturalWidth >= 20 || image.width >= 20) && (image.naturalHeight >= 20 || image.height >= 20);
        })
        .sort((a, b) => {
          const score = (image: HTMLImageElement) => {
            const rect = image.getBoundingClientRect();
            const identity = elementIdentity(image);
            const avatarPenalty = /avatar|head|user|author|profile|logo|icon/i.test(identity) || Math.abs(rect.width - rect.height) < 8 && rect.width <= 80 ? 0.8 : 0;
            return Math.min(1.2, visualArea(image) / Math.max(1, visualArea(row))) - avatarPenalty;
          };
          return score(b) - score(a);
        })[0] || null;
    }

    function findAuthorElement(row: Element, titleElement: Element | null, dateElement: Element | null): Element | null {
      const rowRect = row.getBoundingClientRect();
      return Array.from(row.querySelectorAll('[class*="author" i],[class*="byline" i],[class*="user" i],[class*="nick" i],[class*="name" i],[class*="creator" i],[class*="owner" i],[class*="profile" i],[class*="avatar" i],[rel="author"],[itemprop*="author" i],a,span,p,div'))
        .filter(visible)
        .filter((element) => element !== titleElement && element !== dateElement && !element.contains(titleElement) && !element.contains(dateElement))
        .map((element) => {
          const value = textFieldValue(element) || readableText(element);
          const rect = element.getBoundingClientRect();
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(element));
          const profileLink = hasProfileLink(element);
          const nearBottom = rect.top > rowRect.top + rowRect.height * 0.35;
          const authorValue = stripTrailingEngagement(value);
          const scoreText = authorValue || value;
          const score = (semantic ? 1 : 0) + (profileLink ? 0.45 : 0) + (nearBottom ? 0.2 : 0) - Math.max(0, scoreText.length - 24) / 100;
          return { element, value, authorValue, score, area: rect.width * rect.height };
        })
        .filter((item) => isAuthorText(item.value) || item.authorValue !== item.value && isAuthorText(item.authorValue))
        .sort((a, b) => b.score - a.score || a.area - b.area)[0]?.element || null;
    }

    type EngagementKind = 'comments' | 'favorites' | 'shares' | 'likes' | 'metric';

    function isEngagementFieldName(name: string): boolean {
      return /^(comments|favorites|shares|likes|metric_\d+)$/.test(name);
    }

    function engagementCountValue(element: Element): string {
      const values = [directText(element), textFieldValue(element), readableText(element)];
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

    function localEngagementWrapper(element: Element, row: Element): Element | null {
      let current = element.parentElement;
      const rowArea = Math.max(1, visualArea(row));
      while (current && current !== row) {
        const countLeaves = engagementCountLeaves(current);
        if (countLeaves.length > 1) return null;
        if (countLeaves.length === 1 && countLeaves[0] === element) {
          const areaRatio = visualArea(current) / rowArea;
          if (areaRatio <= 0.25 || current.children.length <= 5 || /comment|reply|discuss|like|heart|collect|favorite|fav|star|share|forward|repost|retweet|interact|action|metric|count/i.test(elementIdentity(current))) {
            return current;
          }
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
      const iconElements = [
        ...Array.from(element.querySelectorAll('svg,use,i,span[class],em[class]')),
        ...localElements,
        ...localElements.flatMap((item) => Array.from(item.querySelectorAll('svg,use,i,span[class],em[class]')))
      ].filter((item): item is Element => Boolean(item));
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
        ...iconElements.map(attr)
      ].join(' ');
    }

    function engagementKind(element: Element, row: Element): EngagementKind {
      const value = `${engagementSemanticText(element, row)} ${textFieldValue(element) || readableText(element)}`.toLowerCase();
      if (/(comment|comments|reply|replies|discuss|discussion|bubble|message|chat|评论|评|留言|回复)/i.test(value)) return 'comments';
      if (/(share|shares|forward|repost|retweet|transmit|arrow|send|转发|分享|转|转推)/i.test(value)) return 'shares';
      if (/(collect|collection|favorite|favourite|favorites|favourites|fav|star|bookmark|save|saves|收藏|星标|书签)/i.test(value)) return 'favorites';
      if (/(like|likes|heart|thumb|vote|upvote|赞|喜欢|点赞|♥|❤|♡|👍)/i.test(value)) return 'likes';
      if (/☆|★/.test(value)) return 'favorites';
      if (/↗|↪|➜|➤|⤴|⤵/.test(value)) return 'shares';
      return 'metric';
    }

    function engagementNameFor(element: Element, row: Element, index: number, total: number): string {
      const kind = engagementKind(element, row);
      if (kind !== 'metric') return kind;
      if (total >= 3) return ['comments', 'favorites', 'shares'][index] || `metric_${index + 1}`;
      return `metric_${index + 1}`;
    }

    function engagementRelativeXPath(row: Element, element: Element): string {
      const structural = generalRelativeXPath(row, element);
      return structural && structural !== '.' ? structural : compactRelativeXPath(row, element);
    }

    function findEngagementElements(row: Element, titleElement: Element | null, dateElement: Element | null): Array<{ element: Element; name: string; relativeXPath: string }> {
      const candidates = Array.from(row.querySelectorAll('[class*="comment" i],[class*="reply" i],[class*="discuss" i],[class*="like" i],[class*="heart" i],[class*="collect" i],[class*="favorite" i],[class*="count" i],[class*="interact" i],[class*="engage" i],[class*="share" i],[class*="forward" i],[class*="repost" i],span,em,i,b,strong,div'))
        .filter(visible)
        .filter((element) => element !== titleElement && element !== dateElement && !element.contains(titleElement) && !element.contains(dateElement))
        .map((element) => {
          const value = engagementCountValue(element);
          const kind = engagementKind(element, row);
          const semantic = kind !== 'metric' || /count|interact|engage|vote|赞|喜欢|收藏|评论|转发|分享/i.test(elementIdentity(element));
          const rect = element.getBoundingClientRect();
          const descendantCountLeaves = engagementCountLeaves(element).filter((child) => child !== element);
          const directCount = isEngagementCount(directText(element));
          return { element, value, kind, semantic, area: visualArea(element), left: rect.left, top: rect.top, descendantCountLeaves, directCount };
        })
        .filter((item) => item.value && (item.directCount || item.descendantCountLeaves.length === 0))
        .sort((a, b) => {
          if (a.semantic !== b.semantic) return a.semantic ? -1 : 1;
          return a.top - b.top || a.left - b.left || a.value.length - b.value.length || a.area - b.area;
        })
        .slice(0, 4)
        .sort((a, b) => a.top - b.top || a.left - b.left);
      return candidates.map((item, index) => ({ element: item.element, name: engagementNameFor(item.element, row, index, candidates.length), relativeXPath: engagementRelativeXPath(row, item.element) }));
    }

    function engagementPathTarget(row: Element, relativeXPath: string): Element | null {
      try {
        const target = document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return target instanceof Element ? target : null;
      } catch {
        return null;
      }
    }

    function engagementPathSupports(name: string, row: Element, relativeXPath: string): boolean {
      const element = engagementPathTarget(row, relativeXPath);
      if (!element || !visible(element)) return false;
      const value = engagementCountValue(element) || textFieldValue(element) || readableText(element);
      if (!isEngagementCount(value)) return false;
      const kind = engagementKind(element, row);
      return kind === name || kind === 'metric';
    }

    function buildEngagementRelativeXPath(name: string, rows: Element[], rawPaths: string[]): string {
      const paths = Array.from(new Set(rawPaths.filter(Boolean)));
      const uncovered = new Set(rows.map((_, index) => index));
      const selected: string[] = [];
      while (uncovered.size && selected.length < 5) {
        const best = paths
          .filter((path) => !selected.includes(path))
          .map((path) => ({
            path,
            covered: Array.from(uncovered).filter((index) => engagementPathSupports(name, rows[index], path))
          }))
          .filter((item) => item.covered.length)
          .sort((a, b) => b.covered.length - a.covered.length || a.path.length - b.path.length)[0];
        if (!best) break;
        selected.push(best.path);
        best.covered.forEach((index) => uncovered.delete(index));
      }
      return selected.length ? selected.join(' | ') : paths[0] || '';
    }

    function findSummaryElement(row: Element, titleElement: Element | null, dateElement: Element | null, authorElement: Element | null, engagementElements: Element[]): Element | null {
      return Array.from(row.querySelectorAll('p,span,div'))
        .filter(visible)
        .filter((element) => ![titleElement, dateElement, authorElement, ...engagementElements].some((used) => used && (element === used || element.contains(used))))
        .map((element) => ({ element, value: textFieldValue(element), area: visualArea(element), own: Boolean(directText(element)) }))
        .filter((item) => item.value.length > 20 && item.value.length < 260 && !dateMatch(item.value) && !isEngagementCount(item.value) && !hasVisibleImage(item.element))
        .sort((a, b) => {
          if (a.own !== b.own) return a.own ? -1 : 1;
          return a.area - b.area;
        })[0]?.element || null;
    }

    function sample(row: Element, field: FieldInfo): string {
      const target = field.relativeXPath && field.relativeXPath !== '.'
        ? document.evaluate(field.relativeXPath.replace(/^\.\//, './'), row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      const element = target instanceof Element ? target : null;
      if (!element) return '';
      if (field.kind === 'href') return (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      if (field.kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      return textFieldValue(element) || readableText(element);
    }

    const output: Record<string, { fields: FieldInfo[]; sampleRows: Record<string, string>[] }> = {};
    for (const item of items) {
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 6);
      if (!rows.length) continue;
      const rowXPath = item.itemXPath;
      const first = rows[0];
      const fields: FieldInfo[] = [];
      const seen = new Set<string>();
      const push = (field: FieldInfo) => {
        if (fields.some((item) => item.name === field.name && item.kind === field.kind)) return;
        const key = fieldKey(field.name, field.kind, field.relativeXPath || '.');
        if (seen.has(key)) return;
        if (!field.samples.some(Boolean)) return;
        seen.add(key);
        fields.push(field);
      };

      scanColumnFields(first, rows, rowXPath).forEach(push);

      const image = findMainImageElement(first);
      if (image) {
        const relativeXPath = compactRelativeXPath(first, image);
        push({
          name: 'image',
          kind: 'src',
          selector: 'img',
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: 'img',
          relativeXPath,
          samples: rows.map((row) => {
            const img = document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            return img instanceof HTMLImageElement ? img.currentSrc || img.src : '';
          }).filter(Boolean).slice(0, 3)
        });
      }

      const dateElement = findDateElement(first);
      const titleElement = findTitleElement(first, dateElement);
      if (titleElement) {
        const relativeXPath = compactRelativeXPath(first, titleElement);
        push({
          name: 'title',
          kind: 'text',
          selector: titleElement.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: titleElement.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: 'title', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality('title', [value])).slice(0, 3)
        });
        const linkElement = titleElement.matches('a') ? titleElement : titleElement.closest('a') || titleElement.querySelector('a');
        if (linkElement instanceof HTMLAnchorElement) {
          const linkRelativeXPath = compactRelativeXPath(first, linkElement);
          push({
            name: 'url',
            kind: 'href',
            selector: 'a',
            xpath: absoluteFieldXPath(rowXPath, linkRelativeXPath),
            relativeSelector: 'a',
            relativeXPath: linkRelativeXPath,
            samples: rows.map((row) => sample(row, { name: 'url', kind: 'href', selector: '', xpath: '', relativeXPath: linkRelativeXPath, samples: [] })).filter(Boolean).slice(0, 3)
          });
        }
      }

      const authorElement = findAuthorElement(first, titleElement, dateElement);
      if (authorElement) {
        const relativeXPath = compactRelativeXPath(first, authorElement);
        const authorSamples = rows
          .map((row) => sample(row, { name: 'author', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] }))
          .filter((value) => textFieldQuality('author', [value]))
          .slice(0, 3);
        push({
          name: 'author',
          kind: 'text',
          selector: authorElement.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: authorElement.tagName.toLowerCase(),
          relativeXPath,
          operations: authorSamples.some((value) => {
            const stripped = stripDateFromAuthor(stripTrailingEngagement(value));
            return stripped !== value && isAuthorText(stripped);
          })
            ? [{ type: 'regex_replace', params: [authorEngagementSuffixPatternSource, ''] }, { type: 'regex_replace', params: [datePatternSource, ''] }, { type: 'trim', params: ['0'] }]
            : undefined,
          samples: authorSamples
        });
      }

      const engagementByName = new Map<string, Array<{ element: Element; relativeXPath: string }>>();
      rows.forEach((row, rowIndex) => {
        const rowTitleElement = rowIndex === 0 ? titleElement : fieldElement(row, compactRelativeXPath(first, titleElement || first));
        const rowDateElement = rowIndex === 0 ? dateElement : dateElement ? fieldElement(row, compactRelativeXPath(first, dateElement)) : null;
        for (const engagement of findEngagementElements(row, rowTitleElement, rowDateElement)) {
          engagementByName.set(engagement.name, [...(engagementByName.get(engagement.name) ?? []), { element: engagement.element, relativeXPath: engagement.relativeXPath }]);
        }
      });
      const engagementFields = Array.from(engagementByName.entries())
        .filter(([name]) => name === 'comments' || name === 'favorites' || name === 'shares' || name === 'likes' || /^metric_\d+$/.test(name))
        .map(([name, entries]) => {
          const firstEntry = entries.find((entry) => first.contains(entry.element)) || entries[0];
          const relativeXPath = buildEngagementRelativeXPath(name, rows, entries.map((entry) => entry.relativeXPath));
          return firstEntry && relativeXPath ? { element: firstEntry.element, name, relativeXPath } : null;
        })
        .filter((item): item is { element: Element; name: string; relativeXPath: string } => Boolean(item))
        .sort((a, b) => {
          const order = (name: string) => ['comments', 'favorites', 'shares', 'likes'].indexOf(name);
          const aOrder = order(a.name);
          const bOrder = order(b.name);
          return (aOrder === -1 ? 99 : aOrder) - (bOrder === -1 ? 99 : bOrder);
        });
      for (const engagement of engagementFields) {
        const relativeXPath = engagement.relativeXPath;
        push({
          name: engagement.name,
          kind: 'text',
          selector: engagement.element.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: engagement.element.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: engagement.name, kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality(engagement.name, [value])).slice(0, 3)
        });
      }

      const dateText = findDateText(first);
      if (dateElement || dateText) {
        const relativeXPath = dateElement ? compactRelativeXPath(first, dateElement) : textNodeRelativeXPath(first, dateText);
        push({
          name: 'date',
          kind: 'text',
          selector: dateElement ? dateElement.tagName.toLowerCase() : 'text',
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: dateElement ? dateElement.tagName.toLowerCase() : 'text',
          relativeXPath,
          operations: rows.some((row) => sample(row, { name: 'date', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] }) !== findDateText(row))
            ? [{ type: 'regex_match', params: [datePatternSource] }]
            : undefined,
          samples: rows.map((row) => {
            const extracted = sample(row, { name: 'date', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] });
            return findDateText({ textContent: extracted } as Element) || findDateText(row);
          }).filter(Boolean).slice(0, 3)
        });
      }

      const summary = findSummaryElement(first, titleElement, dateElement, authorElement, engagementFields.map((item) => item.element));
      if (summary) {
        const relativeXPath = compactRelativeXPath(first, summary);
        push({
          name: 'summary',
          kind: 'text',
          selector: summary.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: summary.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: 'summary', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality('summary', [value])).slice(0, 3)
        });
      }

      if (fields.length < 2) continue;
      const usefulRefinedFields = fields.filter((field) => {
        if (field.kind !== 'text') return true;
        if (!textFieldQuality(field.name, field.samples)) return false;
        if (!fieldLayoutQuality(field.name, first, field)) return false;
        if ((field.name === 'title' || field.name === 'summary') && (field.relativeXPath || '.') === '.') return false;
        return true;
      });
      const titleField = usefulRefinedFields.find((field) => field.name === 'title' && field.kind === 'text');
      const nonDuplicateFields = usefulRefinedFields.filter((field) => {
        if (field.name !== 'summary' || !titleField) return true;
        return !samplesDuplicate(field.samples, titleField.samples);
      });
      const usedEngagementSamples = new Set<string>();
      const usedTextPaths = new Map<string, FieldInfo>();
      const cleanFields = nonDuplicateFields.filter((field) => {
        if (field.kind !== 'text') return true;
        if (isEngagementFieldName(field.name)) {
          const sampleKey = field.samples.map((value) => normalizedComparableText(value)).join('|');
          if (usedEngagementSamples.has(sampleKey)) return false;
          usedEngagementSamples.add(sampleKey);
        }
        const path = field.relativeXPath || '.';
        const existing = usedTextPaths.get(path);
        if (!existing) {
          usedTextPaths.set(path, field);
          return true;
        }
        if (isEngagementFieldName(existing.name)) return false;
        if (isEngagementFieldName(field.name)) {
          usedTextPaths.set(path, field);
          return true;
        }
        return false;
      }).filter((field) => usedTextPaths.get(field.relativeXPath || '.') === field || field.kind !== 'text');
      if (cleanFields.length < 2) continue;
      const sampleRows = rows.slice(0, 3).map((row) => {
        const record: Record<string, string> = {};
        for (const field of cleanFields) record[field.name] = sampleValue(row, field);
        return record;
      });
      output[item.id] = { fields: cleanFields, sampleRows };
    }
    return output;
  }, input) as Record<string, { fields: DetectedField[]; sampleRows: Record<string, string>[] }>;

  return candidates.map((candidate) => {
    const refined = refinedById[candidate.id];
    if (!refined || refined.fields.length < 2) return candidate;
    const originalByName = new Map(candidate.fields.map((field) => [`${field.name}:${field.kind}`, field]));
    const refinedHasPreciseTextFields = refined.fields.some((field) => field.kind === 'text' && (field.relativeXPath || '.') !== '.');
    const mergedFields = [
      ...refined.fields,
      ...candidate.fields.filter((field) => {
        if (refined.fields.some((item) => item.name === field.name && item.kind === field.kind)) return false;
        if (refinedHasPreciseTextFields && field.kind === 'text' && (field.relativeXPath || '.') === '.') return false;
        return true;
      })
    ];
    const originalSemanticCount = ['title:text', 'url:href', 'image:src', 'date:text', 'author:text', 'likes:text']
      .filter((key) => originalByName.has(key)).length;
    const refinedSemanticCount = ['title:text', 'url:href', 'image:src', 'date:text', 'author:text', 'likes:text']
      .filter((key) => refined.fields.some((field) => `${field.name}:${field.kind}` === key)).length;
    const shouldUseRefined = refinedSemanticCount >= originalSemanticCount
      || refined.fields.some((field) => !originalByName.has(`${field.name}:${field.kind}`));
    if (!shouldUseRefined) return candidate;
    return {
      ...candidate,
      fields: mergedFields,
      sampleRows: refined.sampleRows,
      reasons: [...candidate.reasons, 'Fields refined from repeated item structure']
    };
  });
}

export async function augmentAdjacentMetadataFields(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      sampleRowCount: Math.max(3, Math.min(8, candidate.sampleRows.length || 3)),
      fields: candidate.fields.map((field) => ({ name: field.name, kind: field.kind }))
    }));
  if (!input.length) return candidates;

  const augmentedById = await page.evaluate((items) => {
    type FieldInfo = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      xpath: string;
      relativeSelector?: string;
      relativeXPath?: string;
      operations?: Array<{ type: 'trim' | 'regex_match' | 'regex_replace'; params: string[] }>;
      samples: string[];
    };

    type CandidateInput = {
      id: string;
      xpath: string;
      itemXPath: string;
      sampleRowCount: number;
      fields: Array<{ name: string; kind: string }>;
    };

    type MetadataEntry = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      relativeSelector?: string;
      relativeXPath: string;
      operations?: FieldInfo['operations'];
    };

    type MetadataPair = {
      row: Element;
      metadata: Element;
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function directText(element: Element | null): string {
      if (!element) return '';
      const parts = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '');
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function readableText(element: Element | null): string {
      return directText(element) || text(element);
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      try {
        const result = document.evaluate(path.replace(/\[\*\]/g, ''), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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

    function absoluteFieldXPath(rowXPath: string, relativeXPath: string): string {
      if (relativeXPath.includes('|')) {
        return relativeXPath
          .split(/\s*\|\s*/)
          .map((part) => absoluteFieldXPath(rowXPath, part.trim()))
          .filter(Boolean)
          .join(' | ');
      }
      if (relativeXPath === '.') return rowXPath;
      return `${rowXPath}${relativeXPath.replace(/^\./, '')}`;
    }

    function applyOperations(value: string, operations?: FieldInfo['operations']): string {
      let output = value;
      for (const operation of operations || []) {
        try {
          if (operation.type === 'trim') output = output.trim();
          else if (operation.type === 'regex_match') output = output.match(new RegExp(operation.params[0] || '', 'i'))?.[0] || '';
          else if (operation.type === 'regex_replace') output = output.replace(new RegExp(operation.params[0] || '', 'gi'), operation.params[1] || '');
        } catch {
          return output;
        }
      }
      return output;
    }

    function fieldValue(row: Element, relativeXPath: string, kind: 'text' | 'href' | 'src', operations?: FieldInfo['operations']): string {
      let element: Element | null = null;
      try {
        const target = relativeXPath && relativeXPath !== '.'
          ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : row;
        element = target instanceof Element ? target : null;
      } catch {
        element = null;
      }
      if (!element) return '';
      let value = '';
      if (kind === 'href') value = (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      else if (kind === 'src') value = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      else value = readableText(element);
      return applyOperations(value, operations).replace(/\s+/g, ' ').trim();
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('rel') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('href') || '',
        html.getAttribute('data-testid') || '',
        html.getAttribute('data-test') || '',
        html.getAttribute('data-qa') || '',
        html.getAttribute('data-role') || ''
      ].join(' ');
    }

    function relativePathWithin(root: Element, target: Element): string {
      if (root === target) return '';
      const parts: string[] = [];
      let current: Element | null = target;
      while (current && current !== root) {
        const parent: Element | null = current.parentElement;
        if (!parent) return '';
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((item): item is Element => item instanceof Element && item.tagName === current?.tagName);
        parts.unshift(`${tag}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return current === root && parts.length ? `/${parts.join('/')}` : '';
    }

    function relativePathFromRowToMetadataTarget(row: Element, metadata: Element, target: Element): string {
      const parent = row.parentElement;
      if (!parent || metadata.parentElement !== parent) return '';
      const siblings = Array.from(parent.children);
      const rowIndex = siblings.indexOf(row);
      const metadataIndex = siblings.indexOf(metadata);
      if (rowIndex < 0 || metadataIndex <= rowIndex) return '';
      const offset = metadataIndex - rowIndex;
      const suffix = relativePathWithin(metadata, target);
      return `./following-sibling::*[${offset}]${suffix}`;
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';
    const scorePatternSource = '\\b\\d[\\d,.]*(?:\\s*[kKmM])?\\s*(?:points?|votes?|upvotes?|likes?|score|票|赞)\\b';
    const commentPatternSource = '\\b(?:\\d[\\d,.]*(?:\\s*[kKmM])?\\s*(?:comments?|replies?|answers?|讨论|评论|回复)|discuss)\\b';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function scoreMatch(value: string): string {
      return value.match(new RegExp(scorePatternSource, 'i'))?.[0] || '';
    }

    function commentMatch(value: string): string {
      return value.match(new RegExp(commentPatternSource, 'i'))?.[0] || '';
    }

    function isScoreValue(value: string): boolean {
      return Boolean(scoreMatch(value));
    }

    function isCommentValue(value: string): boolean {
      return Boolean(commentMatch(value));
    }

    function cleanAuthorText(value: string): string {
      const normalized = value.replace(/\s+/g, ' ').trim();
      const byMatch = normalized.match(/\bby\s+([^\s|·•,，]+(?:\s+[^\s|·•,，]+){0,2})/i);
      if (byMatch?.[1]) return byMatch[1].trim();
      return normalized
        .replace(/^(?:by|author|user|作者|用户)[:：]?\s*/i, '')
        .replace(new RegExp(scorePatternSource, 'gi'), '')
        .replace(new RegExp(commentPatternSource, 'gi'), '')
        .replace(new RegExp(datePatternSource, 'gi'), '')
        .replace(/\b(?:hide|reply|share|save|举报)\b/gi, '')
        .replace(/[|｜·•,，:：-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isAuthorText(value: string): boolean {
      const clean = cleanAuthorText(value);
      if (clean.length < 2 || clean.length > 60) return false;
      if (dateMatch(clean) || scoreMatch(clean) || commentMatch(clean)) return false;
      if (/^(?:hide|reply|share|save|more|next|previous|login|submit|discuss)$/i.test(clean)) return false;
      if (/^https?:\/\//i.test(clean)) return false;
      return /[\p{L}\p{N}_-]/u.test(clean);
    }

    function candidateValue(element: Element): string {
      return readableText(element).replace(/\s+/g, ' ').trim();
    }

    function allVisibleElements(root: Element): Element[] {
      return [root, ...Array.from(root.querySelectorAll('*'))].filter(visible);
    }

    function bestTextElement(root: Element, accept: (value: string, element: Element) => boolean, score: (value: string, element: Element) => number): Element | null {
      return allVisibleElements(root)
        .map((element) => ({ element, value: candidateValue(element) }))
        .filter((item) => item.value && item.value.length <= 260 && accept(item.value, item.element))
        .sort((a, b) => score(b.value, b.element) - score(a.value, a.element) || a.value.length - b.value.length)[0]?.element || null;
    }

    function findScoreElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(scoreMatch(value)),
        (value, element) => {
          const exact = scoreMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /score|point|vote|like|upvote|票|赞/i.test(elementIdentity(element)) ? 0.5 : 0;
          return exact + semantic - Math.max(0, value.length - 40) / 100;
        }
      );
    }

    function findCommentElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(commentMatch(value)),
        (value, element) => {
          const exact = commentMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /comment|reply|discuss|answer|bubble|message|chat|评论|回复|讨论/i.test(elementIdentity(element)) ? 0.7 : 0;
          return exact + semantic - Math.max(0, value.length - 50) / 120;
        }
      );
    }

    function findDateElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(dateMatch(value)),
        (value, element) => {
          const exact = dateMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /date|time|age|posted|publish|created|updated|时间|日期/i.test(elementIdentity(element)) ? 0.6 : 0;
          return exact + semantic - Math.max(0, value.length - 40) / 100;
        }
      );
    }

    function findAuthorElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value, element) => {
          if (!isAuthorText(value)) return false;
          const identity = elementIdentity(element);
          return /author|byline|user|nick|profile|member|hnuser|作者|用户/i.test(identity)
            || /(?:^|\s)by\s+\S/i.test(text(metadata))
            || /^a$/i.test(element.tagName) && /user|author|profile|member/i.test((element as HTMLAnchorElement).href || identity);
        },
        (value, element) => {
          const identity = elementIdentity(element);
          const semantic = /author|byline|user|nick|profile|member|hnuser|作者|用户/i.test(identity) ? 0.9 : 0;
          const link = /^a$/i.test(element.tagName) ? 0.3 : 0;
          const clean = cleanAuthorText(value);
          return semantic + link - Math.max(0, clean.length - 24) / 80;
        }
      );
    }

    function metadataScore(row: Element, metadata: Element): number {
      const value = text(metadata);
      if (!value || value.length > 320) return -Infinity;
      const rowRect = row.getBoundingClientRect();
      const rect = metadata.getBoundingClientRect();
      if (rect.top < rowRect.top - 4) return -Infinity;
      if (rect.top > rowRect.bottom + Math.max(180, rowRect.height * 2.5)) return -Infinity;
      let score = 0;
      if (/(^|\s)by\s+\S|author|byline|user|profile|member|作者|用户/i.test(`${value} ${elementIdentity(metadata)}`)) score += 0.35;
      if (dateMatch(value)) score += 0.25;
      if (scoreMatch(value)) score += 0.22;
      if (commentMatch(value)) score += 0.22;
      if (/meta|subtext|byline|footer|details|stats|score|comment|reply|info|secondary/i.test(elementIdentity(metadata))) score += 0.2;
      if (rect.height <= Math.max(80, rowRect.height * 2.5)) score += 0.1;
      return score;
    }

    function findAdjacentMetadataRow(row: Element, selectedRows: Set<Element>): Element | null {
      const parent = row.parentElement;
      if (!parent) return null;
      const siblings = Array.from(parent.children);
      const rowIndex = siblings.indexOf(row);
      if (rowIndex < 0) return null;
      for (let index = rowIndex + 1; index < siblings.length && index <= rowIndex + 3; index += 1) {
        const sibling = siblings[index];
        if (!(sibling instanceof Element) || !visible(sibling)) continue;
        if (selectedRows.has(sibling)) return null;
        if (!text(sibling)) continue;
        const score = metadataScore(row, sibling);
        if (score >= 0.55) return sibling;
      }
      return null;
    }

    function entryFor(row: Element, metadata: Element, name: string, element: Element | null, operations?: FieldInfo['operations']): MetadataEntry | null {
      if (!element) return null;
      const relativeXPath = relativePathFromRowToMetadataTarget(row, metadata, element);
      if (!relativeXPath) return null;
      return {
        name,
        kind: 'text',
        selector: element.tagName.toLowerCase(),
        relativeSelector: element.tagName.toLowerCase(),
        relativeXPath,
        operations
      };
    }

    function metadataEntriesForPair(pair: MetadataPair): MetadataEntry[] {
      const entries = [
        entryFor(pair.row, pair.metadata, 'score', findScoreElement(pair.metadata), [{ type: 'regex_match', params: [scorePatternSource] }]),
        entryFor(pair.row, pair.metadata, 'author', findAuthorElement(pair.metadata)),
        entryFor(pair.row, pair.metadata, 'date', findDateElement(pair.metadata), [{ type: 'regex_match', params: [datePatternSource] }]),
        entryFor(pair.row, pair.metadata, 'comments', findCommentElement(pair.metadata), [{ type: 'regex_match', params: [commentPatternSource] }])
      ];
      return entries.filter((entry): entry is MetadataEntry => Boolean(entry));
    }

    function supportsField(name: string, value: string): boolean {
      if (!value) return false;
      if (name === 'score') return isScoreValue(value);
      if (name === 'comments') return isCommentValue(value);
      if (name === 'date') return Boolean(dateMatch(value));
      if (name === 'author') return isAuthorText(value);
      return Boolean(value);
    }

    function pathSupportsField(name: string, pair: MetadataPair, path: string, operations?: FieldInfo['operations']): boolean {
      return supportsField(name, fieldValue(pair.row, path, 'text', operations));
    }

    function buildRelativeXPath(name: string, pairs: MetadataPair[], entries: MetadataEntry[]): string {
      const paths = Array.from(new Set(entries.map((entry) => entry.relativeXPath).filter(Boolean)));
      const uncovered = new Set(pairs.map((_, index) => index));
      const selected: string[] = [];
      while (uncovered.size && selected.length < 4) {
        const best = paths
          .filter((path) => !selected.includes(path))
          .map((path) => {
            const operations = entries.find((entry) => entry.relativeXPath === path)?.operations;
            return {
              path,
              covered: Array.from(uncovered).filter((index) => pathSupportsField(name, pairs[index], path, operations))
            };
          })
          .filter((item) => item.covered.length)
          .sort((a, b) => b.covered.length - a.covered.length || a.path.length - b.path.length)[0];
        if (!best) break;
        selected.push(best.path);
        best.covered.forEach((index) => uncovered.delete(index));
      }
      return selected.length ? selected.join(' | ') : paths[0] || '';
    }

    function existingFieldHasName(item: CandidateInput, names: string[]): boolean {
      return item.fields.some((field) => names.some((name) => field.name.toLowerCase() === name.toLowerCase()));
    }

    function shouldSkipName(item: CandidateInput, name: string): boolean {
      if (name === 'author') return existingFieldHasName(item, ['author', '作者', 'user', '用户']);
      if (name === 'date') return existingFieldHasName(item, ['date', 'time', '时间', '日期']);
      if (name === 'comments') return existingFieldHasName(item, ['comments', 'comment', '评论', '回复', '讨论']);
      if (name === 'score') return existingFieldHasName(item, ['score', 'points', 'votes', 'likes', '票数', '评分', '赞']);
      return existingFieldHasName(item, [name]);
    }

    const result: Record<string, { fields: FieldInfo[]; sampleRows: Record<string, string>[] }> = {};
    for (const item of items as CandidateInput[]) {
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 8);
      if (rows.length < 3) continue;
      const selectedRows = new Set<Element>(rows);
      const pairs = rows
        .map((row) => ({ row, metadata: findAdjacentMetadataRow(row, selectedRows) }))
        .filter((pair): pair is MetadataPair => Boolean(pair.metadata));
      if (pairs.length < Math.max(2, Math.ceil(rows.length * 0.5))) continue;

      const entries = pairs.flatMap(metadataEntriesForPair);
      const outputFields: FieldInfo[] = [];
      for (const name of ['score', 'author', 'date', 'comments']) {
        if (shouldSkipName(item, name)) continue;
        const nameEntries = entries.filter((entry) => entry.name === name);
        if (!nameEntries.length) continue;
        const relativeXPath = buildRelativeXPath(name, pairs, nameEntries);
        if (!relativeXPath) continue;
        const template = nameEntries.find((entry) => relativeXPath.includes(entry.relativeXPath)) || nameEntries[0];
        const samples = pairs
          .map((pair) => fieldValue(pair.row, relativeXPath, 'text', template.operations))
          .filter((value) => supportsField(name, value))
          .slice(0, 3);
        const minSamples = pairs.length >= 3 ? 2 : 1;
        if (samples.length < minSamples) continue;
        outputFields.push({
          name,
          kind: 'text',
          selector: template.selector,
          xpath: absoluteFieldXPath(item.itemXPath, relativeXPath),
          relativeSelector: template.relativeSelector,
          relativeXPath,
          ...(template.operations ? { operations: template.operations } : {}),
          samples
        });
      }
      if (!outputFields.length) continue;
      const pairByRow = new Map<Element, MetadataPair>(pairs.map((pair) => [pair.row, pair]));
      const sampleLimit = Math.max(1, Math.min(rows.length, item.sampleRowCount || 3));
      const sampleRows = rows.slice(0, sampleLimit).map((rowElement) => {
        const pair = pairByRow.get(rowElement);
        const row: Record<string, string> = {};
        if (!pair) return row;
        for (const field of outputFields) {
          const value = fieldValue(pair.row, field.relativeXPath || '.', field.kind, field.operations);
          if (supportsField(field.name, value)) row[field.name] = value;
        }
        return row;
      });
      result[item.id] = { fields: outputFields, sampleRows };
    }
    return result;
  }, input) as Record<string, { fields: DetectedField[]; sampleRows: Record<string, string>[] }>;

  return candidates.map((candidate) => {
    const augmented = augmentedById[candidate.id];
    if (!augmented?.fields.length) return candidate;
    const existing = new Set(candidate.fields.map((field) => `${field.name.toLowerCase()}:${field.kind}`));
    const fields = [
      ...candidate.fields,
      ...augmented.fields.filter((field) => !existing.has(`${field.name.toLowerCase()}:${field.kind}`))
    ];
    const sampleRows = candidate.sampleRows.length
      ? candidate.sampleRows.map((row, index) => ({ ...row, ...(augmented.sampleRows[index] ?? {}) }))
      : augmented.sampleRows;
    return {
      ...candidate,
      fields,
      sampleRows,
      reasons: candidate.reasons.some((reason) => /adjacent metadata/i.test(reason))
        ? candidate.reasons
        : [...candidate.reasons, 'Fields augmented from adjacent metadata rows']
    };
  });
}

export async function refineCandidateFieldsForTesting(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  return refineCandidateFields(page, candidates);
}

export async function augmentAdjacentMetadataFieldsForTesting(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  return augmentAdjacentMetadataFields(page, candidates);
}

