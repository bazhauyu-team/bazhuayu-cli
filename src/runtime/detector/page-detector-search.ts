import type { Page } from 'puppeteer-core';
import type { ExtensionCommandResponse, SearchInputCandidate, SearchSubmitButton, SearchSubmitInputRef } from './page-detector-shared.js';
import { delay, truncateText } from './page-detector-utils.js';

/** Minimal host surface used by search submit helpers (avoids importing the full detector host). */
export interface SearchDetectorHost {
  page: Page;
  browser(): { pages(): Promise<Page[]> } | undefined;
  command(command: Record<string, unknown>): Promise<ExtensionCommandResponse>;
}

export async function findInputXPath(page: Page, name: string): Promise<string> {
  const candidates = await findSearchInputCandidates(page, name);
  return candidates[0]?.xpath ?? '';
}

export async function searchInputNeedsDomEntry(page: Page, xpath: string): Promise<boolean> {
  return page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue;
    if (!(element instanceof HTMLElement)) return false;
    return !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement);
  }, xpath);
}

export async function setSearchInputValueByDom(page: Page, xpath: string, value: string): Promise<boolean> {
  return page.evaluate((input) => {
    const result = document.evaluate(input.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue;
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = input.value;
    } else {
      element.textContent = input.value;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    return true;
  }, { xpath, value });
}

export async function findSearchInputCandidates(page: Page, name: string): Promise<SearchInputCandidate[]> {
  return page.evaluate((inputName) => {
    type Candidate = {
      xpath: string;
      name: string;
      type: string;
      placeholder: string;
      value: string;
      formAction: string;
      buttonXPath?: string;
      buttonText?: string;
      score: number;
      reasons: string[];
    };
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
    function stringAttr(value: unknown): string {
      return String(value || '');
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element | null | undefined): string {
      if (!element) return '';
      return ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent) || '').trim();
    }
    function attrsOf(element: Element): string {
      return [
        element.tagName,
        stringAttr((element as HTMLElement).id),
        stringAttr((element as HTMLElement).className),
        element.getAttribute('name') || '',
        element.getAttribute('data-name') || '',
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || '',
        element.getAttribute('href') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('data-placeholder') || '',
        element.getAttribute('contenteditable') || ''
      ].join(' ');
    }
    function childAttrsOf(element: Element): string {
      return Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
        .map((child) => attrsOf(child))
        .join(' ');
    }
    function ancestorAttrsOf(element: Element, maxDepth = 5): string {
      const parts: string[] = [];
      let current = element.parentElement;
      for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
        parts.push(attrsOf(current));
      }
      return parts.join(' ');
    }
    function inputNameOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.name || ''
        : element.getAttribute('name') || element.getAttribute('data-name') || '';
    }
    function inputTypeOf(element: Element): string {
      if (element instanceof HTMLTextAreaElement) return 'textarea';
      if (element instanceof HTMLInputElement) return element.type || 'text';
      const role = element.getAttribute('role') || '';
      if (/^(textbox|searchbox)$/i.test(role)) return role.toLowerCase();
      if (/^(true|plaintext-only)$/i.test(element.getAttribute('contenteditable') || '')) return 'contenteditable';
      return element.tagName.toLowerCase();
    }
    function placeholderOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.placeholder || ''
        : element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || element.getAttribute('aria-label') || element.getAttribute('title') || '';
    }
    function valueOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value || '' : textOf(element);
    }
    function editableLike(element: Element): boolean {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
      const role = element.getAttribute('role') || '';
      return /^(textbox|searchbox)$/i.test(role) || /^(true|plaintext-only)$/i.test(element.getAttribute('contenteditable') || '');
    }
    function allowedEditable(element: Element): boolean {
      if (element instanceof HTMLTextAreaElement) return true;
      if (element instanceof HTMLInputElement) {
        const type = (element.type || 'text').toLowerCase();
        return /^(search|text|url|email|tel|number)$/i.test(type);
      }
      return editableLike(element);
    }
    function searchSemantic(text: string): boolean {
      return /搜索|搜一搜|搜一下|查询|检索|关键词|关键字|找内容|Search|search|query|keyword|searchbox/i.test(text);
    }
    function weakSearchSemantic(text: string): boolean {
      return searchSemantic(text) || /探索|发现|输入.*问题|ask|find/i.test(text);
    }
    function badInputSemantic(text: string): boolean {
      return /登录|登陆|注册|手机号|手机号码|验证码|密码|邮箱|评论|留言|回复|发布|正文|描述|手机号|phone|mobile|password|captcha|verify|verification|comment|reply|message|editor|compose|subscribe|email/i.test(text);
    }
    function insideLoginOrVerificationOverlay(element: Element): boolean {
      let current: Element | null = element.parentElement;
      for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        const value = `${attrs} ${textOf(current)}`.replace(/\s+/g, ' ').slice(0, 1000);
        const modalLike = /dialog|modal|popup|pop|mask|overlay|login|signin|passport|auth|登录|登陆|注册/i.test(attrs)
          || current.getAttribute('aria-modal') === 'true'
          || current.getAttribute('role') === 'dialog';
        const style = window.getComputedStyle(current as HTMLElement);
        const rect = current.getBoundingClientRect();
        const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
        const centered = rect.left < viewportWidth * 0.76 && rect.right > viewportWidth * 0.24 && rect.top < viewportHeight * 0.78 && rect.bottom > viewportHeight * 0.14;
        const bodyStyle = (document.body as HTMLElement | null)?.style;
        const documentStyle = (document.documentElement as HTMLElement | null)?.style;
        const scrollLocked = bodyStyle?.overflow === 'hidden' || documentStyle?.overflow === 'hidden';
        const overlayEvidence = modalLike
          || style.position === 'fixed'
          || style.position === 'sticky'
          || Number.parseInt(style.zIndex || '0', 10) >= 10
          || scrollLocked;
        const loginLike = /登录|登陆|注册|手机号|手机号码|验证码|密码|微信|扫码|phone|mobile|captcha|verify|verification|password|login|sign in|register/i.test(value);
        if (overlayEvidence && centered && modalLike && loginLike) return true;
      }
      return false;
    }
    function searchInputLike(element: Element): boolean {
      if (!allowedEditable(element)) return false;
      if (insideLoginOrVerificationOverlay(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 10) return false;
      const attrs = `${attrsOf(element)} ${ancestorAttrsOf(element, 4)}`;
      const hasSearchSemantic = weakSearchSemantic(attrs);
      if (rect.height > 260 && !hasSearchSemantic) return false;
      if (rect.width < 90 && !hasSearchSemantic) return false;
      const placeholder = placeholderOf(element);
      const ownText = textOf(element);
      const semantic = weakSearchSemantic(`${attrs} ${placeholder} ${ownText}`);
      return editableLike(element) || semantic;
    }
    function isContentLink(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      if (contentDetailUrlLike(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="suggest" i],[class*="recommend" i]');
      if (!container) return false;
      const attrs = attrsOf(container);
      return !/search|toolbar|header|form|submit|button/i.test(attrs);
    }
    function contentDetailUrlLike(value: string): boolean {
      if (!value) return false;
      try {
        const path = new URL(value, location.href).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function searchScope(input: Element): ParentNode {
      const form = input.closest('form');
      if (form) return form;
      let fallback: Element | null = null;
      let current: Element | null = input.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|so-box|search-box|searchbar/i.test(attrs)) return current;
        if (!fallback && /input|textbox|textarea|输入/i.test(attrs)) fallback = current;
      }
      return fallback || input.parentElement || document;
    }
    function distance(left: Element, right: Element): number {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      return Math.hypot(ax - bx, ay - by);
    }
    function rightSideControl(input: Element, button: Element): boolean {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 120 && rect.height <= 120;
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function negativeSubmitControl(element: Element): boolean {
      const value = `${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`;
      return /(清除|清空|关闭|取消|删除|移除|重置|close|clear|cancel|remove|delete|reset|times|cross)/i.test(value)
        && !searchSemantic(value);
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      const attrs = attrsOf(element);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search-(?:button|btn|submit)|search_button|icon|suffix|append/i.test(attrs);
    }
    function submitTarget(input: Element, element: Element): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        if (!visible(current) || isContentLink(current)) continue;
        const rect = current.getBoundingClientRect();
        const explicitClickable = /^(button|input|a)$/i.test(current.tagName)
          || current.getAttribute('role') === 'button'
          || Boolean((current as HTMLElement).onclick)
          || Boolean(current.getAttribute('tabindex'))
          || window.getComputedStyle(current as HTMLElement).cursor === 'pointer';
        const ownsSearchInput = current !== element && Boolean(current.querySelector('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'));
        if (ownsSearchInput && (rect.width > 220 || rect.height > 180) && !explicitClickable) continue;
        if (negativeSubmitControl(current)) continue;
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(current.tagName);
        const nativeButton = /^(button|input)$/i.test(current.tagName) || current.getAttribute('role') === 'button';
        const semantic = searchSemantic(`${attrsOf(current)} ${textOf(current)} ${childAttrsOf(current)}`);
        const nearInput = rightSideControl(input, current);
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(current)) score += 2;
        if (semantic) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(current)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: current, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function scoreButton(input: Element, button: Element | null): { score: number; reasons: string[] } {
      if (!button || !visible(button)) return { score: 0, reasons: [] };
      if (isContentLink(button)) return { score: 0, reasons: [] };
      if (negativeSubmitControl(button)) return { score: 0, reasons: [] };
      const value = textOf(button);
      const attrs = `${attrsOf(button)} ${childAttrsOf(button)}`;
      const searchLike = /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(`${value} ${attrs}`);
      const nativeButton = /^(button|input)$/i.test(button.tagName) || button.getAttribute('role') === 'button';
      const nearInputIcon = rightSideControl(input, button) && compactControl(button) && (iconLike(button) || clickableLike(button));
      if (!nativeButton && !searchLike && !nearInputIcon) return { score: 0, reasons: [] };
      const reasons: string[] = ['visible submit control nearby'];
      let score = nativeButton ? 0.2 : 0.1;
      if (searchLike) {
        score += 0.55;
        reasons.push('submit text is search-like');
      }
      const dist = distance(input, button);
      if (dist < 260) {
        score += 0.25;
        reasons.push('submit control is near input');
      } else if (dist > 800) {
        score -= 0.25;
        reasons.push('submit control is far from input');
      }
      if (nearInputIcon) {
        score += 0.55;
        reasons.push('icon-like control is aligned with input');
      }
      return { score, reasons };
    }
    const escapedName = CSS.escape(inputName);
    const targetNameSelectors = [
      `input[name="${escapedName}"]`,
      `textarea[name="${escapedName}"]`,
      `[role="textbox"][name="${escapedName}"]`,
      `[role="searchbox"][name="${escapedName}"]`,
      `[contenteditable="true"][name="${escapedName}"]`,
      `[contenteditable="plaintext-only"][name="${escapedName}"]`,
      `[data-name="${escapedName}"]`
    ];
    const broadSelectors = [
      'input',
      'textarea',
      '[role="textbox"]',
      '[role="searchbox"]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]'
    ];
    const seen = new Set<Element>();
    const elements = [...targetNameSelectors, ...broadSelectors]
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => {
        if (seen.has(element) || !visible(element)) return false;
        seen.add(element);
        return searchInputLike(element);
      });
    return elements.map((input): Candidate => {
      const form = input.closest('form');
      const buttonSelector = 'button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span';
      const buttonSeen = new Set<Element>();
      const scopedButtons = [
        ...Array.from(searchScope(input).querySelectorAll(buttonSelector)),
        ...Array.from(document.querySelectorAll(buttonSelector)).filter((element) => distance(input, element) < 560 || rightSideControl(input, element))
      ]
        .map((button) => submitTarget(input, button))
        .filter((element) => {
          if (buttonSeen.has(element) || element === input || !visible(element)) return false;
          buttonSeen.add(element);
          return true;
        });
      const nearestButton = scopedButtons
        .map((button) => ({ button, distance: distance(input, button), buttonScore: scoreButton(input, button) }))
        .filter((item) => item.buttonScore.score > 0)
        .sort((a, b) => (b.buttonScore.score - a.buttonScore.score) || (a.distance - b.distance))[0];
      const inputNameValue = inputNameOf(input);
      const inputTypeValue = inputTypeOf(input);
      const placeholder = placeholderOf(input);
      const attrText = `${inputNameValue} ${stringAttr((input as HTMLElement).id)} ${inputTypeValue} ${placeholder} ${input.getAttribute('aria-label') || ''} ${input.getAttribute('title') || ''} ${stringAttr((input as HTMLElement).className)} ${input.getAttribute('data-placeholder') || ''}`;
      const ancestorText = ancestorAttrsOf(input, 5);
      const reasons: string[] = [];
      let score = 0;
      if (inputNameValue === inputName) {
        score += 1.2;
        reasons.push('exact input name match');
      }
      if (inputTypeValue === 'search' || inputTypeValue === 'searchbox') {
        score += 0.95;
        reasons.push('input type/role is search');
      }
      if (input instanceof HTMLTextAreaElement) {
        score += 0.25;
        reasons.push('textarea can accept search text');
      }
      if (editableLike(input) && !(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
        score += 0.55;
        reasons.push('custom editable textbox');
      }
      if (searchSemantic(attrText)) {
        score += 0.8;
        reasons.push('input attributes are search-like');
      }
      if (!searchSemantic(attrText) && weakSearchSemantic(attrText)) {
        score += 0.35;
        reasons.push('input attributes weakly suggest search');
      }
      if (/^(q|wd|s|query|keyword|keywords|key|search|search_text)$/i.test(inputNameValue)) {
        score += 0.55;
        reasons.push('input name is common search parameter');
      }
      if (/search|query|keyword|搜索|查询/i.test(inputNameValue)) {
        score += 0.55;
        reasons.push('input name contains search terms');
      }
      if (searchSemantic(ancestorText)) {
        score += 0.45;
        reasons.push('ancestor container is search-like');
      }
      if (form?.action && /search|query|s\?|wd=|keyword/i.test(form.action)) {
        score += 0.35;
        reasons.push('form action is search-like');
      }
      if (nearestButton) {
        score += nearestButton.buttonScore.score;
        reasons.push(...nearestButton.buttonScore.reasons);
      }
      const rect = input.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.75) {
        score += 0.15;
        reasons.push('input is in first viewport');
      }
      if (rect.width >= 120 && rect.height >= 16 && rect.height <= 180) {
        score += 0.2;
        reasons.push('input has search-box-like dimensions');
      }
      const negativeText = `${attrText} ${ancestorText}`;
      const hasStrongSearchSignal = searchSemantic(`${attrText} ${ancestorText}`);
      if (badInputSemantic(negativeText) && !hasStrongSearchSignal) {
        score -= 1.1;
        reasons.push('input looks like login/comment/composer field');
      }
      if (input instanceof HTMLTextAreaElement && rect.height > 180 && !hasStrongSearchSignal) {
        score -= 0.5;
        reasons.push('large textarea without search semantics');
      }
      return {
        xpath: xpath(input),
        name: inputNameValue,
        type: inputTypeValue,
        placeholder,
        value: valueOf(input),
        formAction: form instanceof HTMLFormElement ? form.action : '',
        ...(nearestButton?.button ? { buttonXPath: xpath(nearestButton.button), buttonText: textOf(nearestButton.button) || undefined } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }).filter((candidate) => candidate.score >= 1.05)
      .sort((a, b) => b.score - a.score);
  }, name);
}

export function searchInputCandidateLabel(candidate: SearchInputCandidate): string {
  const parts = [
    `score=${candidate.score}`,
    candidate.name ? `name=${candidate.name}` : '',
    candidate.type ? `type=${candidate.type}` : '',
    candidate.placeholder ? `placeholder=${truncateText(candidate.placeholder, 30)}` : '',
    candidate.buttonText ? `button=${truncateText(candidate.buttonText, 20)}` : ''
  ].filter(Boolean);
  return parts.join('  ');
}

export async function pageHasSearchLoginGate(page: Page): Promise<boolean> {
  const snapshot = await searchSubmitSnapshot(page).catch(() => undefined);
  return Boolean(snapshot?.hasLoginGate);
}

export async function searchSubmitSnapshot(page: Page): Promise<{
  url: string;
  readyState: string;
  textLength: number;
  hasLoginGate: boolean;
  hasResultContent: boolean;
}> {
  return page.evaluate(() => {
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 40 && rect.height > 30 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="login" i],[class*="passport" i],[class*="mask" i]')).some(visible);
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const hasLoginGate = Boolean((modal || loginInput) && /登录|登陆|注册|验证|验证码|手机号|手机号码|微信登录|扫码|人机|login|sign in|register|verification|verify|captcha/i.test(text));
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40)
      .slice(0, 8);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4)
      .slice(0, 8);
    return {
      url: location.href,
      readyState: document.readyState,
      textLength: text.length,
      hasLoginGate,
      hasResultContent: text.length >= 600 && resultBlocks.length >= 2 && links.length >= 2
    };
  });
}

export async function clickSubmit(
  host: SearchDetectorHost,
  submitText: string | undefined,
  timeoutMs: number,
  inputs: SearchSubmitInputRef[] = [],
  preferredButtons: SearchSubmitButton[] = []
): Promise<SearchSubmitButton | undefined> {
  const button = await resolveSearchSubmitButton(host.page, {
    submitText,
    inputs,
    preferredButtons
  });
  debugSearchSubmitDecision('resolved', button);
  if (!button?.xpath) return undefined;

  const domEffectBaseline = await captureSearchSubmitEffectBaseline(host).catch(() => undefined);
  const domSubmitted = await submitSearchByDom(host.page, button.xpath, inputs.map((input) => input.xpath)).catch(() => false);
  const domHadEffect = domSubmitted && await waitForSearchSubmitEffect(host, domEffectBaseline, 900).catch(() => false);
  debugSearchSubmitDecision('dom-click', button, { domSubmitted, domHadEffect });
  if (domHadEffect) return button;

  debugSearchSubmitDecision('real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

export async function clickRecordedSearchSubmit(
  host: SearchDetectorHost,
  button: SearchSubmitButton,
  timeoutMs: number,
  inputs: SearchSubmitInputRef[] = []
): Promise<SearchSubmitButton | undefined> {
  if (!button.xpath) return undefined;
  debugSearchSubmitDecision('manual-recorded-click', button);
  const domEffectBaseline = await captureSearchSubmitEffectBaseline(host).catch(() => undefined);
  const domSubmitted = await submitSearchByDom(host.page, button.xpath, inputs.map((input) => input.xpath), { allowRecorded: true }).catch(() => false);
  const domHadEffect = domSubmitted && await waitForSearchSubmitEffect(host, domEffectBaseline, 900).catch(() => false);
  debugSearchSubmitDecision('manual-recorded-dom-click', button, { domSubmitted, domHadEffect });
  if (domHadEffect) return button;
  debugSearchSubmitDecision('manual-recorded-real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

export function debugSearchSubmitDecision(label: string, button: SearchSubmitButton | undefined, extra: Record<string, unknown> = {}): void {
  if (process.env.OCTOPARSE_TRACKING_DEBUG !== '1') return;
  process.stderr.write(`[detect-debug] search submit ${label}: ${JSON.stringify({ button, ...extra })}\n`);
}

export async function captureSearchSubmitEffectBaseline(host: SearchDetectorHost): Promise<{
  url: string;
  textLength: number;
  pageCount: number;
  hasLoginGate: boolean;
  hasResultContent: boolean;
}> {
  const snapshot = await searchSubmitSnapshot(host.page).catch(() => undefined);
  const pages = await host.browser()?.pages().catch(() => []) ?? [];
  return {
    url: snapshot?.url || host.page.url(),
    textLength: snapshot?.textLength ?? -1,
    pageCount: pages.filter((page) => !page.isClosed()).length,
    hasLoginGate: snapshot?.hasLoginGate ?? false,
    hasResultContent: snapshot?.hasResultContent ?? false
  };
}

export async function waitForSearchSubmitEffect(
  host: SearchDetectorHost,
  baseline: { url: string; textLength: number; pageCount: number; hasLoginGate: boolean; hasResultContent: boolean } | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!baseline) return false;
  const deadline = Date.now() + Math.max(200, timeoutMs);
  while (Date.now() < deadline) {
    const pages = await host.browser()?.pages().catch(() => []) ?? [];
    if (pages.filter((page) => !page.isClosed()).length > baseline.pageCount) return true;
    const snapshot = await searchSubmitSnapshot(host.page).catch(() => undefined);
    if (snapshot) {
      if (snapshot.url !== baseline.url) return true;
      if (!baseline.hasLoginGate && snapshot.hasLoginGate) return true;
      if (!baseline.hasResultContent && snapshot.hasResultContent) return true;
      if (baseline.textLength >= 0 && Math.abs(snapshot.textLength - baseline.textLength) > 180) return true;
    }
    await delay(100);
  }
  return false;
}

export async function clickSearchSubmitByGeometry(host: SearchDetectorHost, inputXPath: string, timeoutMs: number): Promise<SearchSubmitButton | undefined> {
  const button = await resolveSearchSubmitButtonByGeometry(host.page, inputXPath).catch(() => undefined);
  debugSearchSubmitDecision('geometry-resolved', button);
  if (!button?.xpath) return undefined;
  debugSearchSubmitDecision('geometry-real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

export async function resolveSearchSubmitButtonByGeometry(page: Page, inputXPath: string): Promise<SearchSubmitButton | undefined> {
  return page.evaluate((path) => {
    type Candidate = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
    function byXPath(xpathValue: string): Element | null {
      const result = document.evaluate(xpathValue, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
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
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element): string {
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }
    function attrsOf(element: Element): string {
      return [
        element.localName,
        String((element as HTMLElement).id || ''),
        String((element as HTMLElement).className || ''),
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || ''
      ].join(' ');
    }
    function contentLike(element: Element): boolean {
      if (/^(textarea|input)$/i.test(element.tagName)) return true;
      const href = element.getAttribute('href') || '';
      if (/\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="recommend" i]');
      return Boolean(container && !/search|query|keyword|toolbar|header|form|input|submit|button|icon/i.test(attrsOf(container)));
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search|icon|suffix|append/i.test(attrsOf(element));
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${Array.from(element.querySelectorAll('svg,path,use,i,span')).map(attrsOf).join(' ')}`);
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function submitTarget(inputElement: Element, element: Element): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const candidate = current;
        if (!visible(candidate) || contentLike(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const nativeButton = /^(button|input)$/i.test(candidate.tagName) || candidate.getAttribute('role') === 'button';
        const semantic = /搜索|查询|搜一下|搜一搜|Search|search|query|submit/i.test(`${textOf(candidate)} ${attrsOf(candidate)}`);
        const nearInput = rightSideControl(inputElement, candidate);
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(candidate)) score += 2;
        if (semantic) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(candidate)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function searchScope(inputElement: Element): Element {
      let current: Element | null = inputElement.parentElement;
      let fallback: Element = inputElement.parentElement || document.body || document.documentElement;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|input|textarea/i.test(attrs)) return current;
        fallback = current;
      }
      return fallback;
    }
    function scoreCandidate(inputElement: Element, candidate: Element): Candidate | undefined {
      if (candidate === inputElement || !visible(candidate) || contentLike(candidate)) return undefined;
      const inputRect = inputElement.getBoundingClientRect();
      const rect = candidate.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2));
      const aligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.75);
      const rightEdgeAligned = rect.left >= inputRect.right - 160 && rect.left <= inputRect.right + 220;
      const insideInputRight = rect.right <= inputRect.right + 60 && rect.left >= inputRect.left + inputRect.width * 0.45;
      const compact = rect.width >= 10 && rect.height >= 10 && rect.width <= 150 && rect.height <= 150;
      if (!aligned || !compact || (!rightEdgeAligned && !insideInputRight)) return undefined;
      const attrs = attrsOf(candidate);
      const searchLike = /搜索|查询|搜一下|搜一搜|Search|search|query|submit/i.test(`${textOf(candidate)} ${attrs}`);
      const clickable = clickableLike(candidate);
      const icon = iconLike(candidate);
      if (!searchLike && !clickable && !icon) return undefined;
      let score = 0.8;
      const reasons = ['geometry fallback near search input'];
      if (searchLike) {
        score += 0.5;
        reasons.push('candidate has search semantics');
      }
      if (clickable) {
        score += 0.35;
        reasons.push('candidate looks clickable');
      }
      if (icon) {
        score += 0.35;
        reasons.push('candidate looks icon-like');
      }
      score -= Math.min(0.4, verticalCenterDistance / 200);
      return {
        xpath: xpath(candidate),
        ...(textOf(candidate) ? { text: textOf(candidate) } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }
    const inputElement = byXPath(path);
    if (!inputElement) return undefined;
    const scope = searchScope(inputElement);
    const rawCandidates = Array.from(scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],svg,path,use,i,div,span,[class*="icon" i],[class*="button" i],[class*="btn" i],[class*="search" i],[class*="submit" i]'));
    const scored = rawCandidates
      .map((candidate) => scoreCandidate(inputElement, submitTarget(inputElement, candidate)))
      .filter((candidate): candidate is Candidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score);
    return scored[0];
  }, inputXPath);
}

export async function resolveSearchSubmitButton(page: Page, options: {
  submitText?: string;
  inputs: SearchSubmitInputRef[];
  preferredButtons: SearchSubmitButton[];
}): Promise<SearchSubmitButton | undefined> {
  return page.evaluate((input) => {
    type Button = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
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
    function byXPath(path: string): Element | null {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
    }
    function visible(element: Element | null): element is Element {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element | null | undefined): string {
      if (!element) return '';
      return (element instanceof HTMLInputElement
        ? element.value || element.getAttribute('aria-label') || element.getAttribute('title') || ''
        : element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }
    function stringAttr(value: unknown): string {
      return String(value || '');
    }
    function attrsOf(element: Element): string {
      return [
        element.localName,
        stringAttr((element as HTMLElement).id),
        stringAttr((element as HTMLElement).className),
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || '',
        element.getAttribute('href') || '',
        element.getAttribute('name') || '',
        element.getAttribute('data-name') || ''
      ].join(' ');
    }
    function childAttrsOf(element: Element): string {
      return Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
        .map((child) => attrsOf(child))
        .join(' ');
    }
    function distance(left: Element, right: Element): number {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      return Math.hypot(ax - bx, ay - by);
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 120 && rect.height <= 120;
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function negativeSubmitControl(element: Element): boolean {
      const value = `${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`;
      return /(清除|清空|关闭|取消|删除|移除|重置|close|clear|cancel|remove|delete|reset|times|cross)/i.test(value)
        && !isSearchLike(element);
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      const attrs = attrsOf(element);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search-(?:button|btn|submit)|search_button|icon|suffix|append/i.test(attrs);
    }
    function submitTarget(element: Element, inputs: Element[]): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const candidate = current;
        if (!visible(candidate) || isContentLink(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        const explicitClickable = /^(button|input|a)$/i.test(candidate.tagName)
          || candidate.getAttribute('role') === 'button'
          || Boolean((candidate as HTMLElement).onclick)
          || Boolean(candidate.getAttribute('tabindex'))
          || window.getComputedStyle(candidate as HTMLElement).cursor === 'pointer';
        const ownsSearchInput = Boolean(candidate.querySelector('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'));
        if (ownsSearchInput && (rect.width > 220 || rect.height > 180) && !explicitClickable) continue;
        if (negativeSubmitControl(candidate)) continue;
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const nativeButton = isNativeButton(candidate);
        const searchLike = isSearchLike(candidate);
        const nearInput = inputs.some((inputElement) => rightSideControl(inputElement, candidate));
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(candidate)) score += 2;
        if (searchLike) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(candidate)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function isSearchLike(element: Element): boolean {
      return /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(`${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function isNativeButton(element: Element): boolean {
      return /^(button|input)$/i.test(element.tagName) || element.getAttribute('role') === 'button';
    }
    function isContentLink(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      if (contentDetailUrlLike(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="suggest" i],[class*="recommend" i]');
      if (!container) return false;
      return !/search|toolbar|header|form|submit|button/i.test(attrsOf(container));
    }
    function contentDetailUrlLike(value: string): boolean {
      if (!value) return false;
      try {
        const path = new URL(value, location.href).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function searchScope(inputElement: Element | null): ParentNode {
      if (!inputElement) return document;
      const form = inputElement.closest('form');
      if (form) return form;
      let current: Element | null = inputElement.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|input|so-box|search-box|searchbar/i.test(attrsOf(current))) return current;
      }
      return inputElement.parentElement || document;
    }
    function inputByName(name: string): Element | null {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"');
      return document.querySelector(`input[name="${escaped}"],textarea[name="${escaped}"]`);
    }
    function inputRefs(): Element[] {
      const seen = new Set<Element>();
      const refs: Element[] = [];
      for (const item of input.inputs) {
        const element = byXPath(item.xpath) || inputByName(item.name);
        if (!element || seen.has(element)) continue;
        seen.add(element);
        refs.push(element);
      }
      return refs;
    }
    function scoreButton(button: Element, inputs: Element[]): Button | undefined {
      if (!visible(button) || isContentLink(button)) return undefined;
      if (negativeSubmitControl(button)) return undefined;
      const nativeButton = isNativeButton(button);
      const searchLike = isSearchLike(button);
      const nearInputIcon = inputs.some((inputElement) => rightSideControl(inputElement, button) && compactControl(button) && (iconLike(button) || clickableLike(button)));
      if (!nativeButton && !searchLike && !nearInputIcon) return undefined;
      const reasons: string[] = ['visible submit control'];
      let score = nativeButton ? 0.35 : 0;
      if (searchLike) {
        score += 0.65;
        reasons.push('search-like submit label');
      }
      if (input.submitText && textOf(button).includes(input.submitText)) {
        score += 0.9;
        reasons.push('matches requested submit text');
      }
      for (const inputElement of inputs) {
        const dist = distance(inputElement, button);
        if (dist < 220) {
          score += 0.45;
          reasons.push('near search input');
          break;
        }
        if (dist < 420) {
          score += 0.22;
          reasons.push('same search area as input');
          break;
        }
      }
      if (nearInputIcon) {
        score += 0.7;
        reasons.push('icon-like control is aligned with input');
      }
      if (button.closest('form')) {
        score += 0.2;
        reasons.push('inside form');
      }
      return {
        xpath: xpath(button),
        ...(textOf(button) ? { text: textOf(button) } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }

    const inputs = inputRefs();
    const candidates: Button[] = [];
    const preferred = input.preferredButtons
      .map((button) => byXPath(button.xpath))
      .filter((element): element is Element => Boolean(element));
    for (const button of preferred) {
      const scored = scoreButton(submitTarget(button, inputs), inputs);
      if (scored) candidates.push({ ...scored, score: scored.score + 0.8, reasons: [...scored.reasons, 'manual/preferred submit'] });
    }
    const scopes = inputs.length ? inputs.map(searchScope) : [document];
    for (const scope of scopes) {
      const buttons = Array.from(scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span'))
        .map((button) => submitTarget(button, inputs));
      for (const button of buttons) {
        const scored = scoreButton(button, inputs);
        if (scored) candidates.push(scored);
      }
    }
    if (inputs.length) {
      const globalButtons = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[class*="suffix" i],[class*="append" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span'))
        .filter((button) => inputs.some((inputElement) => distance(inputElement, button) < 560 || rightSideControl(inputElement, button)))
        .map((button) => submitTarget(button, inputs));
      for (const button of globalButtons) {
        const scored = scoreButton(button, inputs);
        if (scored) candidates.push({ ...scored, score: scored.score + 0.12, reasons: [...scored.reasons, 'global nearby submit candidate'] });
      }
    }
    if (!candidates.length && input.submitText) {
      const fallback = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a'))
        .map((button) => scoreButton(button, inputs))
        .filter((button): button is Button => Boolean(button))
        .filter((button) => (button.text || '').includes(input.submitText || ''));
      candidates.push(...fallback);
    }
    const unique = new Map<string, Button>();
    for (const candidate of candidates) {
      const existing = unique.get(candidate.xpath);
      if (!existing || candidate.score > existing.score) unique.set(candidate.xpath, candidate);
    }
    return Array.from(unique.values()).sort((a, b) => b.score - a.score)[0];
  }, options).catch(() => undefined);
}

export async function submitSearchByDom(page: Page, buttonXPath: string, inputXPaths: string[] = [], options: { allowRecorded?: boolean } = {}): Promise<boolean> {
  return page.evaluate((payload) => {
    function byXPath(path: string): Element | null {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
    }
    const rawElement = byXPath(payload.buttonXPath);
    if (!rawElement) return false;
    const inputElements = payload.inputXPaths.map(byXPath).filter((item): item is Element => Boolean(item));
    const element = clickTargetForSearchSubmit(rawElement, inputElements);
    if (!(element instanceof HTMLElement)) return false;
    const attrs = [
      element.localName,
      element.id,
      element.className,
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || '',
      element.getAttribute('href') || '',
      element.textContent || ''
    ].join(' ');
    const searchLike = /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(attrs);
    const nearInputIcon = inputElements.some((inputElement) => rightSideControl(inputElement, element) && compactControl(element));
    if (!payload.options.allowRecorded && !searchLike && !nearInputIcon) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const form = element.closest('form');
    if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function' && !/^(button)$/i.test(element.getAttribute('type') || '')) {
      form.requestSubmit(element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : undefined);
    }
    return true;
    function clickTargetForSearchSubmit(target: Element, inputs: Element[]): Element {
      let current: Element | null = target;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const candidate = current;
        const rect = candidate.getBoundingClientRect();
        const attrs = [
          candidate.localName,
          (candidate as HTMLElement).id || '',
          (candidate as HTMLElement).className || '',
          candidate.getAttribute('role') || '',
          candidate.getAttribute('aria-label') || '',
          candidate.getAttribute('title') || ''
        ].join(' ');
        const compact = rect.width >= 12 && rect.height >= 12 && rect.width <= 180 && rect.height <= 180;
        const clickable = /^(button|a|input)$/i.test(candidate.tagName)
          || candidate.getAttribute('role') === 'button'
          || Boolean((candidate as HTMLElement).onclick)
          || Boolean(candidate.getAttribute('tabindex'))
          || /btn|button|submit|search|icon|suffix|append/i.test(attrs);
        const nearInput = inputs.some((inputElement) => rightSideControl(inputElement, candidate));
        let score = 0;
        if (candidate instanceof HTMLElement) score += 0.4;
        if (clickable) score += 1.2;
        if (compact) score += 0.6;
        if (nearInput) score += 0.5;
        score -= depth * 0.05;
        if (score >= 0.7) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.element || target;
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(control: Element): boolean {
      const rect = control.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 140 && rect.height <= 140;
    }
  }, { buttonXPath, inputXPaths, options });
}

export async function findSearchInputCandidatesForTesting(page: Page, name: string): Promise<SearchInputCandidate[]> {
  return findSearchInputCandidates(page, name);
}

export async function resolveSearchSubmitButtonForTesting(page: Page, options: {
  submitText?: string;
  inputs: SearchSubmitInputRef[];
  preferredButtons?: SearchSubmitButton[];
}): Promise<SearchSubmitButton | undefined> {
  return resolveSearchSubmitButton(page, {
    submitText: options.submitText,
    inputs: options.inputs,
    preferredButtons: options.preferredButtons ?? []
  });
}

export async function resolveSearchSubmitButtonByGeometryForTesting(page: Page, inputXPath: string): Promise<SearchSubmitButton | undefined> {
  return resolveSearchSubmitButtonByGeometry(page, inputXPath);
}
