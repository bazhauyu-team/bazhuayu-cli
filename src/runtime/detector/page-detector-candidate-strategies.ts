import type { Page } from 'puppeteer-core';
import { detectDeptaListGroups, type DeptaListGroup } from './depta/browser-detector.js';
import { isFooterLikeSelector, isLegalBoilerplateText, isStrongLegalBoilerplateText, isWeakBoilerplateText } from './candidate-boilerplate.js';
import type { DetectedField, DetectedFieldDiagnostics } from './types.js';
import type { RawCandidate } from './page-detector-shared.js';
import { appendRelativeXPath, normalizeFieldName, rowToSample, scoreCandidate } from './page-detector-utils.js';
import { findSearchInputCandidates } from './page-detector-search.js';

export async function detectDetails(page: Page): Promise<RawCandidate[]> {
  const detail = await page.evaluate(() => {
    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
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
    function selector(element: Element): string {
      if ((element as HTMLElement).id) return `#${CSS.escape((element as HTMLElement).id)}`;
      return element.tagName.toLowerCase();
    }
    function styleTextLike(value: string): boolean {
      const cssTokenCount = (value.match(/--weui-|data_color_scheme|rgba?\(|#[0-9a-f]{3,8}\b|ACTIVE-|BG-|FG-/gi) ?? []).length;
      return cssTokenCount >= 8 || /--weui-[\s\S]{80,}/i.test(value) || /\.data_color_scheme_dark\{/i.test(value);
    }
    function fieldDiagnostics(element: Element) {
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
    function contentScore(element: Element): number {
      const tag = element.tagName.toLowerCase();
      if (/^(script|style|noscript|nav|footer|header|aside|button|input|select|textarea)$/i.test(tag)) return -Infinity;
      const value = text(element);
      if (value.length < 120 || value.length > 20000 || styleTextLike(value)) return -Infinity;
      const rect = element.getBoundingClientRect();
      const paragraphs = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20);
      const linkText = Array.from(element.querySelectorAll('a')).map((item) => text(item)).join(' ');
      const linkDensity = linkText.length / Math.max(1, value.length);
      if (linkDensity > 0.35) return -Infinity;
      const sentenceMarks = (value.match(/[。！？!?；;，,]/g) ?? []).length;
      const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / Math.max(1, window.innerWidth);
      let score = 0;
      score += Math.min(5, value.length / 500);
      score += Math.min(4, paragraphs.length);
      score += Math.min(2, sentenceMarks * 0.12);
      score -= centerPenalty;
      if (element.querySelector('h1,h2,h3')) score -= 0.9;
      return score;
    }
    function contentRoot(base: Element): Element | null {
      const candidates = [base, ...Array.from(base.querySelectorAll('article,main,section,div,[class*="article" i],[class*="content" i],[id*="article" i],[id*="content" i]'))]
        .filter((element, index, array) => array.indexOf(element) === index)
        .map((element) => ({ element, score: contentScore(element) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.element ?? null;
    }
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    const bodyRoot = contentRoot(root) || root;
    const title = document.querySelector('h1') || root.querySelector('h1,h2');
    const time = root.querySelector('time,[datetime],[class*="date" i],[class*="time" i]');
    const author = root.querySelector('[class*="author" i],[rel="author"]');
    const paragraphs = Array.from(bodyRoot.querySelectorAll('p')).map((p) => text(p)).filter((value) => value.length > 20);
    const contentValue = text(bodyRoot) || paragraphs.join(' ');
    const price = root.querySelector('[class*="price" i],[data-price]');
    const image = root.querySelector('img') as HTMLImageElement | null;
    return {
      rootSelector: selector(root),
      rootXPath: xpath(root),
      fields: {
        title: title ? { value: text(title), xpath: xpath(title), selector: selector(title) } : null,
        time: time ? { value: text(time) || (time as HTMLElement).getAttribute('datetime') || '', xpath: xpath(time), selector: selector(time) } : null,
        author: author ? { value: text(author), xpath: xpath(author), selector: selector(author) } : null,
        price: price ? { value: text(price) || (price as HTMLElement).getAttribute('data-price') || '', xpath: xpath(price), selector: selector(price) } : null,
        content: contentValue ? { value: contentValue, xpath: xpath(bodyRoot), selector: selector(bodyRoot), diagnostics: fieldDiagnostics(bodyRoot) } : null,
        image: image?.src ? { value: image.src, xpath: xpath(image), selector: selector(image) } : null
      }
    };
  });
  const fields: DetectedField[] = [];
  for (const [name, value] of Object.entries(detail.fields)) {
    if (!value?.value) continue;
    fields.push({
      name,
      kind: name === 'image' ? 'src' : 'text',
      selector: value.selector,
      xpath: value.xpath,
      relativeSelector: value.selector,
      relativeXPath: value.xpath,
      ...(name === 'content' && 'diagnostics' in value && value.diagnostics ? { diagnostics: value.diagnostics as DetectedFieldDiagnostics } : {}),
      ...(name === 'content' ? { operations: contentCleanupOperations() } : {}),
      samples: [value.value].filter(Boolean)
    });
  }
  const meaningful = fields.filter((field) => field.name !== 'image');
  if (meaningful.length < 2) return [];
  return [{
    type: 'detail',
    selector: detail.rootSelector,
    xpath: detail.rootXPath,
    itemSelector: detail.rootSelector,
    itemXPath: detail.rootXPath,
    itemCount: 1,
    fields,
    sampleRows: [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))],
    reasons: ['Single detail page with semantic fields'],
    confidence: scoreCandidate({ itemCount: 1, fieldCount: fields.length, semantic: fields.some((field) => field.name === 'title') ? 1 : 0, penalty: 0.05 })
  }];
}

export async function detectTables(page: Page): Promise<RawCandidate[]> {
  const tableInfos = await page.evaluate(() => {
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
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
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        if (html.id && !/[^\w-]/.test(html.id)) {
          parts.unshift(`#${CSS.escape(html.id)}`);
          break;
        }
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    return Array.from(document.querySelectorAll('table')).slice(0, 10).filter(visible).map((element) => {
      const rows = Array.from(element.querySelectorAll('tr'));
      const headerCells = Array.from(rows[0]?.querySelectorAll('th,td') ?? []);
      const headers = headerCells.map((cell, i) => (cell.textContent || '').trim() || `column_${i + 1}`);
      const dataRows = rows.slice(headerCells.length ? 1 : 0).map((row) => Array.from(row.querySelectorAll('td,th')).map((cell) => (cell.textContent || '').trim()));
      return { headers, dataRows: dataRows.filter((row) => row.some(Boolean)).slice(0, 5), xpath: xpath(element), selector: selector(element) };
    });
  });
  const candidates: RawCandidate[] = [];
  for (const info of tableInfos) {
    if (info.dataRows.length < 2 || info.headers.length < 2) continue;
    const fields: DetectedField[] = info.headers.slice(0, 12).map((header, fieldIndex) => ({
      name: normalizeFieldName(header, `column_${fieldIndex + 1}`),
      kind: 'text',
      selector: `tr td:nth-child(${fieldIndex + 1})`,
      xpath: `${info.xpath}//tr/td[${fieldIndex + 1}]`,
      relativeSelector: `td:nth-child(${fieldIndex + 1})`,
      relativeXPath: `./td[${fieldIndex + 1}]`,
      samples: info.dataRows.map((row) => row[fieldIndex] ?? '').filter(Boolean).slice(0, 3)
    }));
    candidates.push({
      type: 'table',
      selector: info.selector,
      xpath: info.xpath,
      itemSelector: `${info.selector} tr`,
      itemXPath: `${info.xpath}//tr[td]`,
      itemCount: info.dataRows.length,
      fields,
      sampleRows: info.dataRows.slice(0, 3).map((row) => rowToSample(fields, row)),
      reasons: ['HTML table with repeated rows'],
      confidence: scoreCandidate({ itemCount: info.dataRows.length, fieldCount: fields.length, semantic: 1, penalty: 0 })
    });
  }
  return candidates;
}

export async function detectRepeatedCards(page: Page): Promise<RawCandidate[]> {
  const raw = await page.evaluate(() => {
    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS']);
    const elements = Array.from(document.querySelectorAll('body, main, article, section, div, ul, ol'));
    function visible(element: Element): boolean {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = window.getComputedStyle(html);
      return rect.width > 40 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${current.tagName.toLowerCase()}[${index || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        const id = html.id && !/[^\w-]/.test(html.id) ? `#${html.id}` : '';
        if (id) {
          parts.unshift(id);
          break;
        }
        const cls = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${cls}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    function signature(element: Element): string {
      return Array.from(element.children)
        .filter((child) => !ignored.has(child.tagName))
        .slice(0, 8)
        .map((child) => {
          const hasLink = child.querySelector('a') || child.tagName === 'A' ? 'a' : '';
          const hasImg = child.querySelector('img') || child.tagName === 'IMG' ? 'img' : '';
          return `${child.tagName.toLowerCase()}${hasLink}${hasImg}`;
        })
        .join('|');
    }
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return elements
      .filter((parent) => visible(parent))
      .flatMap((parent) => {
        const groups = new Map<string, Element[]>();
        for (const child of Array.from(parent.children)) {
          if (ignored.has(child.tagName) || !visible(child)) continue;
          const childText = text(child);
          if (childText.length < 8) continue;
          const sig = signature(child);
          if (!sig) continue;
          const key = `${child.tagName}:${sig}`;
          groups.set(key, [...(groups.get(key) ?? []), child]);
        }
        return Array.from(groups.values())
          .filter((items) => items.length >= 3)
          .map((items) => ({
            parentSelector: selector(parent),
            parentXPath: xpath(parent),
            itemSelector: selector(items[0]),
            itemXPath: xpath(items[0]).replace(/\[\d+\]$/, ''),
            itemCount: items.length,
            rows: items.slice(0, 5).map((item) => {
              const links = Array.from(item.querySelectorAll('a')).map((link) => ({
                text: text(link).slice(0, 160),
                href: (link as HTMLAnchorElement).href
              })).filter((link) => link.text || link.href).slice(0, 4);
              const images = Array.from(item.querySelectorAll('img')).map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src).filter(Boolean).slice(0, 2);
              const chunks = Array.from(item.querySelectorAll('h1,h2,h3,h4,p,span,div')).map((node) => text(node)).filter((value, index, arr) => value.length >= 3 && arr.indexOf(value) === index).slice(0, 6);
              return { text: text(item).slice(0, 500), links, images, chunks };
            })
          }));
      });
  });

  return raw
    .map((item) => repeatedCardCandidate(item))
    .filter((candidate): candidate is RawCandidate => Boolean(candidate));
}

export async function detectSearchResultBlocks(page: Page): Promise<RawCandidate[]> {
  const groups = await page.evaluate(() => {
    type ResultRow = {
      element: Element;
      title: string;
      href: string;
      summary: string;
      category: string;
      text: string;
      titlePath: string;
      summaryPath: string;
      categoryPath: string;
    };
    type ResultGroup = {
      parentSelector: string;
      parentXPath: string;
      itemSelector: string;
      itemXPath: string;
      itemCount: number;
      titlePath: string;
      summaryPath: string;
      categoryPath: string;
      rows: Array<{
        title: string;
        href: string;
        summary: string;
        category: string;
        text: string;
      }>;
      boilerplateLike: boolean;
      shadowHost: boolean;
      reasons: string[];
    };
    type SearchRoot = { root: Element | ShadowRoot; host: Element | null };

    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE']);
    const mainRoots = Array.from(document.querySelectorAll('main,[role="main"],#main,#content,[class*="content" i],[class*="results" i],[class*="search" i]'));
    const rootElements = mainRoots.length ? mainRoots : Array.from(document.querySelectorAll('body'));
    const roots: SearchRoot[] = rootElements.map((root) => ({ root, host: null }));
    const seenShadowRoots = new Set<ShadowRoot>();
    function addShadowRoots(root: Element | ShadowRoot): void {
      const elements = [
        ...(root instanceof Element ? [root] : []),
        ...Array.from(root.querySelectorAll('*'))
      ];
      for (const element of elements) {
        const shadow = (element as HTMLElement).shadowRoot;
        if (!shadow || seenShadowRoots.has(shadow)) continue;
        seenShadowRoots.add(shadow);
        roots.push({ root: shadow, host: element });
        addShadowRoots(shadow);
      }
    }
    for (const root of rootElements) addShadowRoots(root);

    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function directText(element: Element): string {
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 24 && rect.height > 12 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function shadowHostFor(element: Element): Element | null {
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        if (html.id && !/[^\w-]/.test(html.id)) {
          parts.unshift(`#${CSS.escape(html.id)}`);
          break;
        }
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    }
    function attrs(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || ''
      ].join(' ');
    }
    function candidateAttrs(element: Element): string {
      const values: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 3; depth += 1) {
        values.push(attrs(current));
        current = current.parentElement;
      }
      const shadowHost = shadowHostFor(element);
      if (shadowHost) {
        values.push(attrs(shadowHost));
        if (shadowHost.parentElement) values.push(attrs(shadowHost.parentElement));
      }
      return values.join(' ');
    }
    function boilerplateLike(element: Element): boolean {
      const value = `${candidateAttrs(element)} ${text(element).slice(0, 500)}`;
      return Boolean(element.closest('header,footer,nav,aside,[role="banner"],[role="contentinfo"],[role="navigation"],[role="complementary"]'))
        || Boolean(shadowHostFor(element)?.closest('header,footer,nav,aside,[role="banner"],[role="contentinfo"],[role="navigation"],[role="complementary"]'))
        || /(header|footer|contentinfo|copyright|privacy|terms|login|signin|signup|nav|menu|sidebar|aside|advert|banner|sponsor|cookie|newsletter|备案|隐私|条款|登录|注册)/i.test(value);
    }
    function similarKey(element: Element): string {
      const html = element as HTMLElement;
      const classes = Array.from(html.classList)
        .filter((item) => !/\d{2,}/.test(item))
        .slice(0, 3)
        .sort()
        .join('.');
      const role = html.getAttribute('role') || '';
      const marked = /(result|search|item|entry|card|list|document|record|hit|article)/i.test(`${element.localName} ${classes} ${role}`) ? 'marked' : '';
      return [element.tagName.toLowerCase(), classes, role, marked].join('|');
    }
    function relativePath(from: Element, to: Element): string {
      if (from === to) return '.';
      const parts: string[] = [];
      let current: Element | null = to;
      while (current && current !== from) {
        const parentElement: Element | null = current.parentElement;
        if (!parentElement) return '.';
        const same = Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName);
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return current === from ? `./${parts.join('/')}` : '.';
    }
    function firstTextElement(row: Element, selectors: string[]): Element | null {
      for (const selectorValue of selectors) {
        const match = Array.from(row.querySelectorAll(selectorValue))
          .filter((element) => visible(element))
          .find((element) => {
            const value = text(element);
            return value.length >= 24 && value.length <= 500;
          });
        if (match) return match;
      }
      return null;
    }
    function summaryFor(row: Element, title: string): { value: string; path: string } {
      const summaryElement = firstTextElement(row, [
        '[class*="description" i]',
        '[class*="summary" i]',
        '[class*="snippet" i]',
        '[class*="excerpt" i]',
        '[class*="intro" i]',
        'p',
        'dd'
      ]);
      if (summaryElement) {
        const value = text(summaryElement);
        if (value && value !== title) return { value: value.slice(0, 500), path: relativePath(row, summaryElement) };
      }
      const chunks = Array.from(row.querySelectorAll('p,dd,span,div'))
        .filter((element) => visible(element))
        .map((element) => ({ element, value: text(element) }))
        .filter((item, index, arr) => item.value.length >= 24 && item.value !== title && arr.findIndex((other) => other.value === item.value) === index)
        .sort((a, b) => Math.abs(a.value.length - 160) - Math.abs(b.value.length - 160));
      if (chunks[0]) return { value: chunks[0].value.slice(0, 500), path: relativePath(row, chunks[0].element) };
      const value = text(row).replace(title, '').trim();
      return { value: value.slice(0, 500), path: '.' };
    }
    function categoryFor(row: Element, title: string, summary: string): { value: string; path: string } {
      const categoryElement = Array.from(row.querySelectorAll('[class*="breadcrumb" i],[class*="category" i],[class*="type" i],[class*="section" i],small'))
        .filter((element) => visible(element))
        .find((element) => {
          const value = text(element);
          return value.length >= 2 && value.length <= 120 && value !== title && value !== summary;
        });
      if (categoryElement) return { value: text(categoryElement).slice(0, 160), path: relativePath(row, categoryElement) };
      const shortChunk = Array.from(row.querySelectorAll('span,small,div'))
        .filter((element) => visible(element))
        .map((element) => ({ element, value: directText(element) || text(element) }))
        .find((item) => item.value.length >= 2 && item.value.length <= 80 && item.value !== title && item.value !== summary && /[>/|·•-]/.test(item.value));
      return shortChunk ? { value: shortChunk.value.slice(0, 160), path: relativePath(row, shortChunk.element) } : { value: '', path: '' };
    }
    function titleLinkFor(row: Element): HTMLAnchorElement | null {
      const links = Array.from(row.querySelectorAll('a')).filter(visible) as HTMLAnchorElement[];
      const scored = links
        .map((link, index) => {
          const value = text(link);
          const href = link.href || link.getAttribute('href') || '';
          if (!href || value.length < 3 || value.length > 220) return null;
          const html = link as HTMLElement;
          const attrValue = attrs(link);
          let score = 0;
          if (/^(?:H1|H2|H3|H4)$/i.test(link.parentElement?.tagName || '')) score += 0.35;
          if (link.querySelector('h1,h2,h3,h4')) score += 0.35;
          if (/(title|heading|result|entry|document|article|name)/i.test(attrValue)) score += 0.28;
          if (value.length >= 8 && value.length <= 120) score += 0.22;
          if (/\/(docs?|articles?|posts?|questions?|crates?|packages?|plugins?|title|jobs?|wiki|api)\b/i.test(href)) score += 0.18;
          if (html.closest('nav,header,footer')) score -= 0.55;
          score -= index * 0.03;
          return { link, score };
        })
        .filter((item): item is { link: HTMLAnchorElement; score: number } => Boolean(item))
        .sort((a, b) => b.score - a.score);
      return scored[0]?.link ?? null;
    }
    function asRow(element: Element): ResultRow | null {
      if (ignored.has(element.tagName) || !visible(element) || boilerplateLike(element)) return null;
      const value = text(element);
      if (value.length < 36 || value.length > 1800) return null;
      const directResultChildren = Array.from(element.children)
        .filter((child) => !ignored.has(child.tagName) && visible(child) && Boolean(child.querySelector('a')) && text(child).length >= 36)
        .length;
      if (directResultChildren >= 2) return null;
      const titleLink = titleLinkFor(element);
      if (!titleLink) return null;
      const title = text(titleLink).slice(0, 220);
      const href = titleLink.href || titleLink.getAttribute('href') || '';
      if (!title || !href) return null;
      const summary = summaryFor(element, title);
      if (summary.value.length < 24 && value.replace(title, '').trim().length < 24) return null;
      const category = categoryFor(element, title, summary.value);
      return {
        element,
        title,
        href,
        summary: summary.value,
        category: category.value,
        text: value.slice(0, 800),
        titlePath: relativePath(element, titleLink),
        summaryPath: summary.path,
        categoryPath: category.path
      };
    }
    function commonItemXPath(rows: ResultRow[]): string {
      if (!rows.length) return '';
      const shadowHost = shadowHostFor(rows[0].element);
      if (shadowHost && rows.every((row) => shadowHostFor(row.element) === shadowHost)) return xpath(shadowHost);
      const parent = rows[0].element.parentElement;
      if (!parent || !rows.every((row) => row.element.parentElement === parent)) return xpath(rows[0].element);
      const tag = rows[0].element.tagName.toLowerCase();
      if (rows.every((row) => row.element.tagName.toLowerCase() === tag)) return `${xpath(parent)}/${tag}`;
      return xpath(rows[0].element).replace(/\[\d+\]$/, '');
    }
    function buildGroup(parent: Element, rows: ResultRow[], reasons: string[]): ResultGroup | null {
      const uniqueTitles = new Set(rows.map((row) => row.title.toLowerCase()));
      const uniqueHrefs = new Set(rows.map((row) => row.href.replace(/[?#].*$/g, '').toLowerCase()));
      if (rows.length < 2 || uniqueTitles.size < Math.min(2, rows.length) || uniqueHrefs.size < Math.min(2, rows.length)) return null;
      const withSummary = rows.filter((row) => row.summary.length >= 24).length;
      if (withSummary < Math.min(2, rows.length)) return null;
      const sample = rows.slice(0, 5);
      const first = sample[0];
      const shadowHost = shadowHostFor(first.element);
      const allSameShadowHost = shadowHost && rows.every((row) => shadowHostFor(row.element) === shadowHost);
      const anchor = allSameShadowHost ? shadowHost : parent;
      return {
        parentSelector: selector(anchor),
        parentXPath: xpath(anchor),
        itemSelector: allSameShadowHost ? selector(shadowHost) : selector(first.element),
        itemXPath: commonItemXPath(rows),
        itemCount: rows.length,
        titlePath: allSameShadowHost ? '.' : first.titlePath || './/a[1]',
        summaryPath: allSameShadowHost ? '.' : first.summaryPath || '.',
        categoryPath: allSameShadowHost ? '' : first.categoryPath || '',
        rows: sample.map((row) => ({
          title: row.title,
          href: row.href,
          summary: row.summary,
          category: row.category,
          text: row.text
        })),
        boilerplateLike: boilerplateLike(parent) || (allSameShadowHost ? boilerplateLike(shadowHost) : false) || rows.some((row) => boilerplateLike(row.element)),
        shadowHost: Boolean(allSameShadowHost),
        reasons: [...reasons, ...(allSameShadowHost ? ['Open Shadow DOM search-result blocks'] : [])]
      };
    }

    const rowCandidates = new Map<Element, ResultRow>();
    for (const scope of roots) {
      if (scope.host && !visible(scope.host)) continue;
      if (!scope.host && scope.root instanceof Element && !visible(scope.root)) continue;
      const descendants = Array.from(scope.root.querySelectorAll('article,li,dd,[role="article"],[role="listitem"],[class*="result" i],[class*="search-result" i],[class*="document" i],[class*="entry" i],[class*="item" i]'));
      for (const element of descendants) {
        const row = asRow(element);
        if (!row) continue;
        const nested = Array.from(rowCandidates.values()).some((existing) => row.element.contains(existing.element));
        if (nested) {
          for (const [key, existing] of Array.from(rowCandidates.entries())) {
            if (row.element.contains(existing.element) && text(row.element).length <= text(existing.element).length + 80) {
              rowCandidates.delete(key);
            }
          }
        }
        if (!Array.from(rowCandidates.values()).some((existing) => existing.element.contains(row.element))) {
          rowCandidates.set(element, row);
        }
      }
    }

    const byParent = new Map<Element, ResultRow[]>();
    for (const row of rowCandidates.values()) {
      const parent = row.element.parentElement || shadowHostFor(row.element);
      if (!parent) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
    }

    const output: ResultGroup[] = [];
    for (const [parent, rows] of byParent.entries()) {
      const buckets = new Map<string, ResultRow[]>();
      for (const row of rows) {
        const key = similarKey(row.element);
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      for (const bucketRows of buckets.values()) {
        const group = buildGroup(parent, bucketRows, ['Repeated search-result blocks with title links and summaries']);
        if (group) output.push(group);
      }
    }

    return output
      .sort((a, b) => b.itemCount - a.itemCount)
      .slice(0, 12);
  });

  return groups.map((group) => searchResultBlockCandidate(group));
}

export async function detectSemanticBusinessCards(page: Page): Promise<RawCandidate[]> {
  const groups = await page.evaluate(() => {
    type BusinessRow = {
      element: Element;
      name: string;
      href: string;
      category: string;
      address: string;
      image: string;
      namePath: string;
      categoryPath: string;
      addressPath: string;
      imagePath: string;
      semanticScore: number;
    };
    type BusinessGroup = {
      parentSelector: string;
      parentXPath: string;
      itemSelector: string;
      itemXPath: string;
      itemCount: number;
      namePath: string;
      categoryPath: string;
      addressPath: string;
      imagePath: string;
      rows: Array<{
        name: string;
        href: string;
        category: string;
        address: string;
        image: string;
      }>;
      reasons: string[];
    };

    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE']);

    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 24 && rect.height > 12 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        if (html.id && !/[^\w-]/.test(html.id)) {
          parts.unshift(`#${CSS.escape(html.id)}`);
          break;
        }
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    }
    function attrs(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('itemtype') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('data-seourl') || '',
        html.getAttribute('title') || ''
      ].join(' ');
    }
    function stableClassTokens(element: Element): string[] {
      const html = element as HTMLElement;
      if (typeof html.className !== 'string') return [];
      return html.className
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token) => /^[A-Za-z_-][\w-]*$/.test(token))
        .filter((token) => !/\d{3,}/.test(token))
        .filter((token) => !/^(?:active|selected|current|first|last|odd|even|hover|focus|show|hide|open|closed|row|col|container)$/i.test(token));
    }
    function commonClassTokens(rows: BusinessRow[]): string[] {
      if (!rows.length) return [];
      const [first, ...rest] = rows.map((row) => new Set(stableClassTokens(row.element)));
      return Array.from(first)
        .filter((token) => rest.every((tokens) => tokens.has(token)))
        .slice(0, 3);
    }
    function classXPathPredicate(token: string): string {
      return `[contains(concat(" ", normalize-space(@class), " "), " ${token} ")]`;
    }
    function classSelectorSuffix(tokens: string[]): string {
      return tokens.map((token) => `.${CSS.escape(token)}`).join('');
    }
    function boilerplateLike(element: Element): boolean {
      const value = `${attrs(element)} ${text(element).slice(0, 400)}`;
      return Boolean(element.closest('header,footer,nav,aside,[role="banner"],[role="contentinfo"],[role="navigation"],[role="complementary"]'))
        || /(footer|contentinfo|copyright|privacy|terms|login|signin|signup|nav|menu|sidebar|aside|advert|banner|sponsor|cookie|newsletter|breadcrumb|toplocalit|seo|附近|城市|orte in der nähe)/i.test(value);
    }
    function relativePath(from: Element, to: Element): string {
      if (from === to) return '.';
      const parts: string[] = [];
      let current: Element | null = to;
      while (current && current !== from) {
        const parentElement: Element | null = current.parentElement;
        if (!parentElement) return '.';
        const same = Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName);
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return current === from ? `./${parts.join('/')}` : '.';
    }
    function fieldElement(row: Element, selectors: string[], maxLength: number): Element | null {
      for (const selectorValue of selectors) {
        const match = Array.from(row.querySelectorAll(selectorValue))
          .filter((element) => visible(element))
          .find((element) => {
            const value = text(element);
            return value.length >= 2 && value.length <= maxLength;
          });
        if (match) return match;
      }
      return null;
    }
    function nameLinkFor(row: Element): HTMLAnchorElement | null {
      const preferred = fieldElement(row, [
        '[itemprop="name"] a',
        'h1 a',
        'h2 a',
        'h3 a',
        'h4 a',
        '[class*="name" i] a',
        '[class*="title" i] a',
        '[class*="locname" i] a'
      ], 220);
      if (preferred?.tagName === 'A') return preferred as HTMLAnchorElement;
      const preferredLink: Element | null = preferred ? preferred.querySelector('a') : null;
      if (preferredLink?.tagName === 'A') return preferredLink as HTMLAnchorElement;
      const links = Array.from(row.querySelectorAll('a')).filter(visible) as HTMLAnchorElement[];
      return links
        .map((link, index) => {
          const value = text(link);
          const href = link.href || link.getAttribute('href') || '';
          if (!href || value.length < 2 || value.length > 220) return null;
          const identity = `${attrs(link)} ${attrs(link.parentElement ?? link)} ${href}`;
          let score = 0;
          if (/name|title|locname|company|business|detail|home|record|result/i.test(identity)) score += 0.42;
          if (/^(?:H1|H2|H3|H4)$/i.test(link.parentElement?.tagName || '')) score += 0.34;
          if (/\/(?:home|detail|details|firma|company|business|branchenbuch)\//i.test(href) || /\.html(?:[?#]|$)/i.test(href)) score += 0.22;
          if (value.length >= 4 && value.length <= 80) score += 0.12;
          score -= index * 0.03;
          return { link, score };
        })
        .filter((item): item is { link: HTMLAnchorElement; score: number } => Boolean(item))
        .sort((a, b) => b.score - a.score)[0]?.link ?? null;
    }
    function categoryFor(row: Element, name: string): { value: string; path: string } {
      const element = fieldElement(row, [
        '[itemprop="category"]',
        '[class*="categor" i]',
        '[class*="branche" i]',
        '[class*="industry" i]',
        '[class*="tag" i]'
      ], 140);
      const value = element ? text(element) : '';
      return value && value !== name ? { value: value.slice(0, 160), path: relativePath(row, element!) } : { value: '', path: '' };
    }
    function addressFor(row: Element, name: string): { value: string; path: string } {
      const element = fieldElement(row, [
        '[itemprop="address"]',
        '[class*="address" i]',
        '[class*="adresse" i]',
        '[class*="postal" i]',
        '[class*="street" i]',
        '[class*="location" i]'
      ], 220);
      const value = element ? text(element) : '';
      return value && value !== name ? { value: value.slice(0, 240), path: relativePath(row, element!) } : { value: '', path: '' };
    }
    function imageFor(row: Element): { value: string; path: string } {
      const element = Array.from(row.querySelectorAll('img'))
        .filter(visible)
        .find((image) => {
          const src = (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src || image.getAttribute('src') || '';
          return Boolean(src);
        });
      if (!element) return { value: '', path: '' };
      const src = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || element.getAttribute('src') || '';
      return { value: src, path: relativePath(row, element) };
    }
    function hasOwnBusinessCardIdentity(element: Element): boolean {
      const html = element as HTMLElement;
      const classTokens = typeof html.className === 'string' ? html.className.split(/\s+/).filter(Boolean) : [];
      const identity = attrs(element);
      return /LocalBusiness|HomeAndConstructionBusiness|Organization/i.test(identity)
        || classTokens.some((token) => /^(?:gyresultrecord|business-card|company-card|merchant-card|listing-card|resultrecord)$/i.test(token));
    }
    function descendantBusinessCardCount(element: Element): number {
      const selectorValue = [
        '[itemscope][itemtype*="LocalBusiness"]',
        '[itemscope][itemtype*="Organization"]',
        '[itemscope][itemtype*="HomeAndConstructionBusiness"]',
        '[class~="gyresultrecord"]',
        '[class*="business-card" i]',
        '[class*="company-card" i]',
        '[class*="merchant-card" i]',
        '[class*="listing-card" i]'
      ].join(',');
      return Array.from(element.querySelectorAll(selectorValue))
        .filter((child) => !ignored.has(child.tagName) && visible(child))
        .filter((child) => {
          const value = text(child);
          return value.length >= 12 && value.length <= 1800 && Boolean(nameLinkFor(child));
        })
        .length;
    }
    function candidateElements(): Element[] {
      const selectorValue = [
        '[itemscope][itemtype*="LocalBusiness"]',
        '[itemscope][itemtype*="Organization"]',
        '[itemscope][itemtype*="HomeAndConstructionBusiness"]',
        'article',
        '[class*="result" i]',
        '[class*="record" i]',
        '[class*="listing" i]',
        '[class*="business" i]',
        '[class*="company" i]',
        '[class*="merchant" i]'
      ].join(',');
      return Array.from(document.querySelectorAll(selectorValue))
        .filter((element) => !ignored.has(element.tagName) && visible(element));
    }
    function rowFrom(element: Element): BusinessRow | null {
      if (boilerplateLike(element)) return null;
      const value = text(element);
      if (value.length < 12 || value.length > 1800) return null;
      if (!hasOwnBusinessCardIdentity(element) && descendantBusinessCardCount(element) >= 2) return null;
      const directBusinessChildren = Array.from(element.children)
        .filter((child) => !ignored.has(child.tagName) && visible(child) && child.querySelector('a') && text(child).length >= 12)
        .filter((child) => /LocalBusiness|Organization|result|record|listing|business|company|merchant/i.test(attrs(child)))
        .length;
      if (directBusinessChildren >= 2) return null;
      const nameLink = nameLinkFor(element);
      if (!nameLink) return null;
      const name = text(nameLink).slice(0, 220);
      const href = nameLink.href || nameLink.getAttribute('href') || '';
      if (!name || !href) return null;
      const category = categoryFor(element, name);
      const address = addressFor(element, name);
      const image = imageFor(element);
      const identity = attrs(element);
      const semanticScore = [
        /LocalBusiness|HomeAndConstructionBusiness|Organization/i.test(identity) ? 0.5 : 0,
        /result|record|listing|business|company|merchant|gyresultrecord/i.test(identity) ? 0.25 : 0,
        address.value ? 0.2 : 0,
        category.value ? 0.14 : 0,
        image.value ? 0.06 : 0
      ].reduce((sum, item) => sum + item, 0);
      if (semanticScore < 0.35 && !address.value) return null;
      return {
        element,
        name,
        href,
        category: category.value,
        address: address.value,
        image: image.value,
        namePath: relativePath(element, nameLink),
        categoryPath: category.path,
        addressPath: address.path,
        imagePath: image.path,
        semanticScore
      };
    }
    function commonItemXPath(rows: BusinessRow[]): string {
      const parent = rows[0]?.element.parentElement;
      if (!parent || !rows.every((row) => row.element.parentElement === parent)) return xpath(rows[0].element);
      const tag = rows[0].element.tagName.toLowerCase();
      if (rows.every((row) => row.element.tagName.toLowerCase() === tag)) {
        const commonClasses = commonClassTokens(rows);
        if (commonClasses.length) return `${xpath(parent)}/${tag}${commonClasses.map(classXPathPredicate).join('')}`;
        const sameTagChildren = Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === tag);
        if (sameTagChildren.length === rows.length) return `${xpath(parent)}/${tag}`;
      }
      return xpath(rows[0].element).replace(/\[\d+\]$/, '');
    }
    function commonItemSelector(rows: BusinessRow[]): string {
      const first = rows[0];
      const parent = first?.element.parentElement;
      if (!first || !parent || !rows.every((row) => row.element.parentElement === parent)) return selector(first.element);
      const tag = first.element.tagName.toLowerCase();
      if (rows.every((row) => row.element.tagName.toLowerCase() === tag)) {
        const commonClasses = commonClassTokens(rows);
        if (commonClasses.length) return `${selector(parent)} > ${tag}${classSelectorSuffix(commonClasses)}`;
        const sameTagChildren = Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === tag);
        if (sameTagChildren.length === rows.length) return `${selector(parent)} > ${tag}`;
      }
      return selector(first.element);
    }
    function similarKey(row: BusinessRow): string {
      const html = row.element as HTMLElement;
      const classes = Array.from(html.classList)
        .filter((item) => !/\d{2,}/.test(item))
        .slice(0, 3)
        .sort()
        .join('.');
      const itemtype = html.getAttribute('itemtype') || '';
      return [row.element.tagName.toLowerCase(), classes, itemtype].join('|');
    }
    const rowsByElement = new Map<Element, BusinessRow>();
    for (const element of candidateElements()) {
      const row = rowFrom(element);
      if (!row) continue;
      const existingParent = Array.from(rowsByElement.values()).find((existing) => existing.element.contains(row.element));
      if (existingParent) continue;
      for (const [key, existing] of Array.from(rowsByElement.entries())) {
        if (row.element.contains(existing.element)) rowsByElement.delete(key);
      }
      rowsByElement.set(element, row);
    }

    const byParent = new Map<Element, BusinessRow[]>();
    for (const row of rowsByElement.values()) {
      const parent = row.element.parentElement;
      if (!parent) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
    }

    const groups: BusinessGroup[] = [];
    for (const [parent, rows] of byParent.entries()) {
      const buckets = new Map<string, BusinessRow[]>();
      for (const row of rows) {
        const key = similarKey(row);
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      for (const bucketRows of buckets.values()) {
        if (bucketRows.length < 2) continue;
        const uniqueNames = new Set(bucketRows.map((row) => row.name.toLowerCase()));
        const uniqueHrefs = new Set(bucketRows.map((row) => row.href.replace(/[?#].*$/g, '').toLowerCase()));
        if (uniqueNames.size < Math.min(2, bucketRows.length) || uniqueHrefs.size < Math.min(2, bucketRows.length)) continue;
        const scored = bucketRows.reduce((sum, row) => sum + row.semanticScore, 0) / bucketRows.length;
        const first = bucketRows[0];
        groups.push({
          parentSelector: selector(parent),
          parentXPath: xpath(parent),
          itemSelector: commonItemSelector(bucketRows),
          itemXPath: commonItemXPath(bucketRows),
          itemCount: bucketRows.length,
          namePath: first.namePath || './/a[1]',
          categoryPath: first.categoryPath,
          addressPath: first.addressPath,
          imagePath: first.imagePath,
          rows: bucketRows.slice(0, 5).map((row) => ({
            name: row.name,
            href: row.href,
            category: row.category,
            address: row.address,
            image: row.image
          })),
          reasons: [
            'Semantic business/local listing cards',
            ...(scored >= 0.5 ? ['schema.org LocalBusiness/Organization or business-card semantics'] : []),
            ...(bucketRows.some((row) => row.address) ? ['business address field detected'] : []),
            ...(bucketRows.some((row) => row.category) ? ['business category field detected'] : [])
          ]
        });
      }
    }
    return groups
      .sort((a, b) => b.itemCount - a.itemCount)
      .slice(0, 10);
  });

  return groups.map((group) => semanticBusinessCandidate(group));
}

export async function detectInteractiveElementGroups(page: Page): Promise<RawCandidate[]> {
  const groups = await page.evaluate(() => {
    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'PATH']);
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 12 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
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
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        if (html.id && !/[^\w-]/.test(html.id)) {
          parts.unshift(`#${CSS.escape(html.id)}`);
          break;
        }
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    function shape(element: Element): string {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const classes = Array.from(html.classList).filter((item) => !/\d{2,}/.test(item)).slice(0, 3).sort().join('.');
      const role = html.getAttribute('role') || '';
      const hasLink = element.querySelector('a') || element.tagName === 'A' ? 'a' : '';
      const hasImg = element.querySelector('img') || element.tagName === 'IMG' ? 'img' : '';
      const childTags = Array.from(element.children).filter((child) => !ignored.has(child.tagName)).slice(0, 5).map((child) => child.tagName.toLowerCase()).join(',');
      const widthBucket = Math.round(rect.width / 40);
      const heightBucket = Math.round(rect.height / 12);
      return [element.tagName, classes, role, hasLink, hasImg, childTags, widthBucket, heightBucket].join('|');
    }
    function itemXPath(first: Element): string {
      return xpath(first).replace(/\[\d+\]$/, '');
    }

    const containers = Array.from(document.querySelectorAll('body, main, article, section, div, ul, ol, nav'));
    const output: Array<{
      parentSelector: string;
      parentXPath: string;
      itemSelector: string;
      itemXPath: string;
      itemCount: number;
      samples: string[];
      hrefSamples: string[];
    }> = [];
    for (const parent of containers) {
      if (!visible(parent)) continue;
      const buckets = new Map<string, Element[]>();
      for (const child of Array.from(parent.children)) {
        if (ignored.has(child.tagName) || !visible(child)) continue;
        const value = text(child);
        if (value.length < 2 || value.length > 220) continue;
        const key = shape(child);
        buckets.set(key, [...(buckets.get(key) ?? []), child]);
      }
      for (const items of buckets.values()) {
        if (items.length < 3) continue;
        const samples = items.map((item) => text(item)).filter(Boolean).slice(0, 5);
        const uniqueSamples = new Set(samples);
        if (uniqueSamples.size < Math.min(3, samples.length)) continue;
        const hrefSamples = items
          .map((item) => {
            const link = item.matches('a') ? item as HTMLAnchorElement : item.querySelector('a') as HTMLAnchorElement | null;
            return link?.href || '';
          })
          .filter(Boolean)
          .slice(0, 5);
        output.push({
          parentSelector: selector(parent),
          parentXPath: xpath(parent),
          itemSelector: selector(items[0]),
          itemXPath: itemXPath(items[0]),
          itemCount: items.length,
          samples,
          hrefSamples
        });
      }
    }
    return output;
  });

  return groups.map((group) => {
    const fields: DetectedField[] = [{
      name: 'text',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: group.samples.slice(0, 3)
    }];
    if (group.hrefSamples.length >= 2) {
      fields.push({
        name: 'url',
        kind: 'href',
        selector: `${group.itemSelector} a`,
        xpath: `${group.itemXPath}//a[1]`,
        relativeSelector: 'a',
        relativeXPath: './a[1]',
        samples: group.hrefSamples.slice(0, 3)
      });
    }
    return {
      type: fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
      selector: group.parentSelector,
      xpath: group.parentXPath,
      itemSelector: group.itemSelector,
      itemXPath: group.itemXPath,
      itemCount: group.itemCount,
      fields,
      sampleRows: group.samples.slice(0, 3).map((sample, index) => ({
        text: sample,
        ...(group.hrefSamples[index] ? { url: group.hrefSamples[index] } : {})
      })),
      reasons: ['Interactive similar element group'],
      confidence: scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic: fields.some((field) => field.name === 'url') ? 1 : 0, penalty: 0.08 })
    } satisfies RawCandidate;
  });
}

export async function detectDeptaCandidates(page: Page): Promise<RawCandidate[]> {
  const groups = await detectDeptaListGroups(page);
  return groups
    .map((group) => deptaCandidate(group))
    .filter((candidate): candidate is RawCandidate => Boolean(candidate));
}

export async function detectSearchResultBlocksForTesting(page: Page): Promise<RawCandidate[]> {
  return detectSearchResultBlocks(page);
}

export async function detectSemanticBusinessCardsForTesting(page: Page): Promise<RawCandidate[]> {
  return detectSemanticBusinessCards(page);
}

function deptaCandidate(group: DeptaListGroup): RawCandidate | null {
  const fields: DetectedField[] = [];
  const titleSamples = group.rowSamples
    .map((row) => row.chunks.find((chunk) => chunk.length >= 2 && chunk !== row.text) || row.text)
    .filter(Boolean)
    .slice(0, 3);
  if (titleSamples.length) {
    fields.push({
      name: group.rowSamples.some((row) => row.href) ? 'title' : 'text',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: titleSamples
    });
  }
  const hrefSamples = group.rowSamples.map((row) => row.href).filter(Boolean).slice(0, 3);
  if (hrefSamples.length >= 2) {
    fields.push({
      name: 'url',
      kind: 'href',
      selector: `${group.itemSelector} a`,
      xpath: `${group.itemXPath}//a[1]`,
      relativeSelector: 'a',
      relativeXPath: './a[1]',
      samples: hrefSamples
    });
  }
  const imageSamples = group.rowSamples.map((row) => row.image).filter(Boolean).slice(0, 3);
  if (imageSamples.length >= 2) {
    fields.push({
      name: 'image',
      kind: 'src',
      selector: `${group.itemSelector} img`,
      xpath: `${group.itemXPath}//img[1]`,
      relativeSelector: 'img',
      relativeXPath: './img[1]',
      samples: imageSamples
    });
  }
  const summarySamples = group.rowSamples
    .map((row) => row.chunks.find((chunk) => chunk.length > 12 && !titleSamples.includes(chunk)) || '')
    .filter(Boolean)
    .slice(0, 3);
  if (summarySamples.length >= 2) {
    fields.push({
      name: 'summary',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: summarySamples
    });
  }
  if (!fields.length) return null;
  const legalBoilerplate = group.rowSamples.some((row) => isLegalBoilerplateText([row.text, ...row.chunks].join(' ')));
  if (legalBoilerplate) return null;
  const semantic = (fields.some((field) => field.name === 'title') ? 1 : 0)
    + (fields.some((field) => field.name === 'url') ? 1 : 0)
    + (fields.some((field) => field.name === 'image') ? 0.5 : 0);
  const weakBoilerplate = group.navigationLike
    || isFooterLikeSelector(group.parentSelector)
    || group.rowSamples.some((row) => isWeakBoilerplateText([row.text, ...row.chunks].join(' ')));
  const penalty = (group.navigationLike ? 0.22 : 0) + (weakBoilerplate ? 0.34 : 0);
  return {
    type: fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
    selector: group.parentSelector,
    xpath: group.parentXPath,
    itemSelector: group.itemSelector,
    itemXPath: group.itemXPath,
    itemCount: group.itemCount,
    fields,
    sampleRows: group.rowSamples.slice(0, 3).map((row) => {
      const record: Record<string, string> = {};
      for (const field of fields) {
        if (field.name === 'title' || field.name === 'text') record[field.name] = row.chunks[0] || row.text;
        else if (field.name === 'url') record[field.name] = row.href;
        else if (field.name === 'image') record[field.name] = row.image;
        else record[field.name] = row.chunks.find((chunk) => chunk.length > 12) || row.text;
      }
      return record;
    }),
    reasons: [
      ...group.reasons,
      `${group.itemCount} repeated records found by visual DOM tree`,
      ...(group.navigationLike ? ['Likely navigation/header group'] : []),
      ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: Math.max(
      0.1,
      Math.min(0.98, scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic, penalty }) + group.score * 0.08)
    )
  };
}

function repeatedCardCandidate(item: {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  rows: Array<{ text: string; links: Array<{ text: string; href: string }>; images: string[]; chunks: string[] }>;
}): RawCandidate | null {
  const fields: DetectedField[] = [];
  const firstLinkSamples = item.rows.map((row) => row.links[0]?.text).filter(Boolean);
  if (firstLinkSamples.length) {
    fields.push({
      name: 'title',
      kind: 'text',
      selector: `${item.itemSelector} a`,
      xpath: `${item.itemXPath}//a[1]`,
      relativeSelector: 'a',
      relativeXPath: './a[1]',
      samples: firstLinkSamples.slice(0, 3)
    });
    const hrefSamples = item.rows.map((row) => row.links[0]?.href).filter(Boolean);
    if (hrefSamples.length) {
      fields.push({
        name: 'url',
        kind: 'href',
        selector: `${item.itemSelector} a`,
        xpath: `${item.itemXPath}//a[1]`,
        relativeSelector: 'a',
        relativeXPath: './a[1]',
        samples: hrefSamples.slice(0, 3)
      });
    }
  }
  const imageSamples = item.rows.map((row) => row.images[0]).filter(Boolean);
  if (imageSamples.length) {
    fields.push({
      name: 'image',
      kind: 'src',
      selector: `${item.itemSelector} img`,
      xpath: `${item.itemXPath}//img[1]`,
      relativeSelector: 'img',
      relativeXPath: './img[1]',
      samples: imageSamples.slice(0, 3)
    });
  }
  const chunkSamples = item.rows.map((row) => row.chunks.find((chunk) => chunk !== row.links[0]?.text && chunk.length > 12)).filter(Boolean) as string[];
  if (chunkSamples.length) {
    fields.push({
      name: 'summary',
      kind: 'text',
      selector: item.itemSelector,
      xpath: item.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: chunkSamples.slice(0, 3)
    });
  }
  if (fields.length < 2) return null;
  const semantic = (fields.some((field) => field.name === 'title') ? 1 : 0) + (fields.some((field) => field.name === 'url') ? 1 : 0);
  const textLooksSearch = item.rows.some((row) => row.links.length > 0 && row.text.length > 30);
  const legalBoilerplate = item.rows.some((row) => isLegalBoilerplateText(row.text));
  if (legalBoilerplate) return null;
  const weakBoilerplate = item.rows.some((row) => isWeakBoilerplateText(row.text)) || isFooterLikeSelector(item.parentSelector);
  const boilerplatePenalty = weakBoilerplate ? 0.46 : 0;
  return {
    type: textLooksSearch && fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
    selector: item.parentSelector,
    xpath: item.parentXPath,
    itemSelector: item.itemSelector,
    itemXPath: item.itemXPath,
    itemCount: item.itemCount,
    fields,
    sampleRows: item.rows.slice(0, 3).map((row) => {
      const record: Record<string, string> = {};
      for (const field of fields) {
        if (field.name === 'title') record[field.name] = row.links[0]?.text ?? '';
        else if (field.name === 'url') record[field.name] = row.links[0]?.href ?? '';
        else if (field.name === 'image') record[field.name] = row.images[0] ?? '';
        else record[field.name] = row.chunks.find((chunk) => chunk !== row.links[0]?.text && chunk.length > 12) ?? row.text;
      }
      return record;
    }),
    reasons: [
      'Sibling elements share the same DOM shape',
      `${item.itemCount} repeated items found`,
      ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: scoreCandidate({ itemCount: item.itemCount, fieldCount: fields.length, semantic, penalty: boilerplatePenalty })
  };
}

function searchResultBlockCandidate(group: {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  titlePath: string;
  summaryPath: string;
  categoryPath: string;
  rows: Array<{ title: string; href: string; summary: string; category: string; text: string }>;
  boilerplateLike: boolean;
  shadowHost?: boolean;
  reasons: string[];
}): RawCandidate {
  const titleRelativeXPath = group.shadowHost ? '.' : group.titlePath || './/a[1]';
  const summaryRelativeXPath = group.shadowHost ? '.' : group.summaryPath || '.';
  const titleXPath = appendRelativeXPath(group.itemXPath, titleRelativeXPath);
  const summaryXPath = appendRelativeXPath(group.itemXPath, summaryRelativeXPath);
  const categoryXPath = !group.shadowHost && group.categoryPath ? appendRelativeXPath(group.itemXPath, group.categoryPath) : '';
  const fields: DetectedField[] = [
    {
      name: 'title',
      kind: 'text',
      selector: `${group.itemSelector} a`,
      xpath: titleXPath,
      relativeSelector: 'a',
      relativeXPath: titleRelativeXPath,
      samples: group.rows.map((row) => row.title).filter(Boolean).slice(0, 3)
    },
    {
      name: 'url',
      kind: 'href',
      selector: `${group.itemSelector} a`,
      xpath: titleXPath,
      relativeSelector: 'a',
      relativeXPath: titleRelativeXPath,
      samples: group.rows.map((row) => row.href).filter(Boolean).slice(0, 3)
    },
    {
      name: 'summary',
      kind: 'text',
      selector: group.itemSelector,
      xpath: summaryXPath,
      relativeSelector: '',
      relativeXPath: summaryRelativeXPath,
      samples: group.rows.map((row) => row.summary).filter(Boolean).slice(0, 3)
    }
  ];
  const categorySamples = group.rows.map((row) => row.category).filter(Boolean);
  if (categoryXPath && categorySamples.length >= 2) {
    fields.push({
      name: 'category',
      kind: 'text',
      selector: group.itemSelector,
      xpath: categoryXPath,
      relativeSelector: '',
      relativeXPath: group.categoryPath,
      samples: categorySamples.slice(0, 3)
    });
  }
  const semantic = 2.4 + (categorySamples.length >= 2 ? 0.3 : 0);
  const penalty = group.boilerplateLike ? 0.5 : 0;
  return {
    type: 'search_results',
    selector: group.parentSelector,
    xpath: group.parentXPath,
    itemSelector: group.itemSelector,
    itemXPath: group.itemXPath,
    itemCount: group.itemCount,
    fields,
    sampleRows: group.rows.slice(0, 3).map((row) => ({
      title: row.title,
      url: row.href,
      summary: row.summary,
      ...(row.category ? { category: row.category } : {})
    })),
    reasons: [
      ...group.reasons,
      `${group.itemCount} repeated search-result records found`,
      ...(group.boilerplateLike ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic, penalty })
  };
}

function semanticBusinessCandidate(group: {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  namePath: string;
  categoryPath: string;
  addressPath: string;
  imagePath: string;
  rows: Array<{ name: string; href: string; category: string; address: string; image: string }>;
  reasons: string[];
}): RawCandidate {
  const nameXPath = appendRelativeXPath(group.itemXPath, group.namePath || './/a[1]');
  const fields: DetectedField[] = [
    {
      name: 'business_name',
      kind: 'text',
      selector: `${group.itemSelector} a`,
      xpath: nameXPath,
      relativeSelector: 'a',
      relativeXPath: group.namePath || './/a[1]',
      samples: group.rows.map((row) => row.name).filter(Boolean).slice(0, 3)
    },
    {
      name: 'detail_url',
      kind: 'href',
      selector: `${group.itemSelector} a`,
      xpath: nameXPath,
      relativeSelector: 'a',
      relativeXPath: group.namePath || './/a[1]',
      samples: group.rows.map((row) => row.href).filter(Boolean).slice(0, 3)
    }
  ];
  const categorySamples = group.rows.map((row) => row.category).filter(Boolean);
  if (group.categoryPath && categorySamples.length >= 2) {
    fields.push({
      name: 'category',
      kind: 'text',
      selector: group.itemSelector,
      xpath: appendRelativeXPath(group.itemXPath, group.categoryPath),
      relativeSelector: '',
      relativeXPath: group.categoryPath,
      samples: categorySamples.slice(0, 3)
    });
  }
  const addressSamples = group.rows.map((row) => row.address).filter(Boolean);
  if (group.addressPath && addressSamples.length >= 2) {
    fields.push({
      name: 'address',
      kind: 'text',
      selector: group.itemSelector,
      xpath: appendRelativeXPath(group.itemXPath, group.addressPath),
      relativeSelector: '',
      relativeXPath: group.addressPath,
      samples: addressSamples.slice(0, 3)
    });
  }
  const imageSamples = group.rows.map((row) => row.image).filter(Boolean);
  if (group.imagePath && imageSamples.length >= 2) {
    fields.push({
      name: 'logo_url',
      kind: 'src',
      selector: `${group.itemSelector} img`,
      xpath: appendRelativeXPath(group.itemXPath, group.imagePath),
      relativeSelector: 'img',
      relativeXPath: group.imagePath,
      samples: imageSamples.slice(0, 3)
    });
  }

  const semantic = 2.6
    + (categorySamples.length >= 2 ? 0.35 : 0)
    + (addressSamples.length >= 2 ? 0.45 : 0)
    + (imageSamples.length >= 2 ? 0.12 : 0);
  return {
    type: 'search_results',
    selector: group.parentSelector,
    xpath: group.parentXPath,
    itemSelector: group.itemSelector,
    itemXPath: group.itemXPath,
    itemCount: group.itemCount,
    fields,
    sampleRows: group.rows.slice(0, 3).map((row) => ({
      business_name: row.name,
      detail_url: row.href,
      ...(row.category ? { category: row.category } : {}),
      ...(row.address ? { address: row.address } : {}),
      ...(row.image ? { logo_url: row.image } : {})
    })),
    reasons: [
      ...group.reasons,
      `${group.itemCount} semantic business records found`
    ],
    confidence: scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic, penalty: 0 })
  };
}

export async function detectForms(page: Page): Promise<RawCandidate[]> {
  const forms = await findSearchInputCandidates(page, 'query');
  return forms
    .filter((form) => form.name || form.placeholder || form.buttonText || form.formAction)
    .slice(0, 8)
    .map((form, index) => ({
      type: 'form',
      selector: `input[name="${form.name || 'query'}"]`,
      xpath: form.xpath,
      itemCount: 1,
      fields: [{
        name: 'query',
        kind: 'value',
        selector: 'input',
        xpath: form.xpath,
        samples: [form.placeholder || form.name || form.buttonText || form.formAction].filter(Boolean)
      }],
      sampleRows: [{ input: form.placeholder || form.name, action: form.formAction, submit: form.buttonText || '' }],
      reasons: ['Search or input form detected; provide input before extracting results', ...form.reasons],
      confidence: Math.max(0.45, Math.min(0.92, 0.35 + form.score * 0.18 - index * 0.02))
    } satisfies RawCandidate));
}

export async function detectLinkCollections(page: Page): Promise<RawCandidate[]> {
  const collections = await page.evaluate(() => {
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
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
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function commonXPath(paths: string[]): string {
      if (!paths.length) return '';
      const split = paths.map((path) => path.split('/').filter(Boolean));
      const output: string[] = [];
      for (let index = 0; index < Math.min(...split.map((parts) => parts.length)); index += 1) {
        const tag = split[0][index].replace(/\[\d+\]$/, '');
        if (!split.every((parts) => parts[index].replace(/\[\d+\]$/, '') === tag)) break;
        output.push(split.every((parts) => parts[index] === split[0][index]) ? split[0][index] : tag);
      }
      return output.length ? `/${output.join('/')}` : '';
    }
    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || ''
      ].join(' ');
    }
    function navigationLike(element: Element, links: Array<{ text: string; href: string }>): boolean {
      if (element.closest('nav,header')) return true;
      const rect = element.getBoundingClientRect();
      const shortTextRate = links.filter((link) => link.text.length <= 8).length / Math.max(1, links.length);
      const navTextRate = links.filter((link) => /^(新闻|网页|贴吧|知道|图片|视频|地图|文库|更多|设置|登录|注册|首页|分类|导航|about|home|login|news|images|video|more)$/i.test(link.text)).length / Math.max(1, links.length);
      return (rect.top < 180 && rect.height < 180 && shortTextRate > 0.7) || navTextRate > 0.45;
    }
    function footerLike(element: Element): boolean {
      if (element.closest('footer,[role="contentinfo"]')) return true;
      const value = `${attrText(element)} ${text(element).slice(0, 500)}`;
      return /(footer|contentinfo|copyright|beian|icp|备案|公网安备|营业执照|增值电信|隐私政策|用户协议)/i.test(value);
    }
    return Array.from(document.querySelectorAll('main,article,section,ul,ol,div,footer'))
      .map((element, index) => {
        const linkElements = Array.from(element.querySelectorAll(':scope > a, :scope > li > a')).filter(visible) as HTMLAnchorElement[];
        const links = linkElements.map((link) => ({
          text: text(link).slice(0, 120),
          href: (link as HTMLAnchorElement).href
        })).filter((link) => link.text && link.href).slice(0, 20);
        const itemXPath = commonXPath(linkElements.map(xpath));
        return { index, links, parentXPath: xpath(element), itemXPath, navigationLike: navigationLike(element, links), footerLike: footerLike(element) };
      })
      .filter((item) => item.links.length >= 5)
      .sort((a, b) => Number(a.navigationLike) - Number(b.navigationLike))
      .slice(0, 8);
  });
  const output: RawCandidate[] = [];
  for (const [index, item] of collections.entries()) {
    const type = item.navigationLike ? 'link_collection' : 'search_results';
    const legalLinks = item.links.filter((link) => isLegalBoilerplateText(link.text));
    const strongLegalBoilerplate = legalLinks.some((link) => isStrongLegalBoilerplateText(link.text));
    const legalRate = legalLinks.length / Math.max(1, item.links.length);
    if (strongLegalBoilerplate || (item.footerLike && legalLinks.length) || legalRate >= 0.35) continue;
    const links = item.links.filter((link) => !isLegalBoilerplateText(link.text));
    if (links.length < 5) continue;
    const weakBoilerplate = item.footerLike || item.navigationLike || item.links.some((link) => isWeakBoilerplateText(link.text));
    const penalty = (item.navigationLike ? 0.28 : 0) + (weakBoilerplate ? 0.46 : 0) + index * 0.02;
    output.push({
      type,
      selector: `link-collection-${item.index}`,
      xpath: item.parentXPath,
      itemSelector: 'a',
      itemXPath: item.itemXPath || `${item.parentXPath}//a`,
      itemCount: links.length,
      fields: [
        { name: 'text', kind: 'text', selector: 'a', xpath: item.itemXPath || `${item.parentXPath}//a`, relativeSelector: '', relativeXPath: '.', samples: links.map((link) => link.text).slice(0, 3) },
        { name: 'url', kind: 'href', selector: 'a', xpath: item.itemXPath || `${item.parentXPath}//a`, relativeSelector: '', relativeXPath: '.', samples: links.map((link) => link.href).slice(0, 3) }
      ],
      sampleRows: links.slice(0, 3).map((link) => ({ text: link.text, url: link.href })),
      reasons: [
        'Several adjacent links detected',
        ...(item.navigationLike ? ['Likely navigation/header group'] : []),
        ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
      ],
      confidence: scoreCandidate({ itemCount: links.length, fieldCount: 2, semantic: item.navigationLike ? 0.3 : 1.2, penalty })
    });
  }
  return output;
}

export function contentCleanupOperations(): DetectedField['operations'] {
  return [
    { type: 'regex_replace', params: ['\\.data_color_scheme_dark\\{[\\s\\S]*$', ''] },
    { type: 'regex_replace', params: ['--weui-[\\s\\S]*$', ''] },
    { type: 'trim', params: ['0'] }
  ];
}

