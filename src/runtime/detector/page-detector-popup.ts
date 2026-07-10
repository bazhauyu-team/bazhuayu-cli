import type { Page } from 'puppeteer-core';
import type { DetectedPopupDismissal } from './types.js';
import type { SuppressedRuntimeConsole } from './page-detector-shared.js';
import {
  clearManualOverlayAction,
  removeManualOverlay,
  showManualOverlay,
  waitForManualOverlayAction,
  writeManualOverlayHintOnce
} from './page-detector-overlay.js';
import { delay, truncateText } from './page-detector-utils.js';

export function popupTypeLabel(type: DetectedPopupDismissal['type'] | undefined): string {
  if (type === 'login') return '登录';
  if (type === 'captcha') return '验证码';
  if (type === 'paywall') return '付费/权限';
  return '登录/验证';
}

export async function dismissPageObstructions(page: Page, options: { includeLogin?: boolean } = {}): Promise<DetectedPopupDismissal[]> {
  const results: DetectedPopupDismissal[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const detected = await detectPageObstructions(page);
    const item = detected[0];
    if (!item) break;
    if ((item.type === 'login' && !options.includeLogin) || item.type === 'captcha' || item.type === 'paywall' && !item.closeXPath) break;
    if (item.closeXPath) {
      const clicked = await clickXPath(page, item.closeXPath).catch(() => false);
      if (clicked) {
        const removed = await waitForPopupRemoved(page, item.popupXPath, 900).catch(() => false);
        if (removed) {
          results.push({
            type: item.type,
            action: 'click',
            xpath: item.closeXPath,
            text: item.closeText || item.popupText,
            confidence: item.confidence,
            removed: true,
            reasons: item.reasons
          });
          continue;
        }
      }
    }
    if (item.type === 'login' || item.type === 'paywall') break;
    await page.keyboard.press('Escape').catch(() => undefined);
    await delay(200);
    const escaped = await page.evaluate((popupXPath) => {
      const result = document.evaluate(popupXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue instanceof HTMLElement ? result.singleNodeValue : null;
      if (!element) return true;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    }, item.popupXPath).catch(() => false);
    if (escaped) {
      results.push({
        type: item.type,
        action: 'escape',
        xpath: item.popupXPath,
        text: item.popupText,
        confidence: item.confidence,
        removed: true,
        reasons: item.reasons
      });
      continue;
    }
    if (!item.canHide) break;
    const hidden = await page.evaluate((popupXPath) => {
      const result = document.evaluate(popupXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue instanceof HTMLElement ? result.singleNodeValue : null;
      if (!element) return false;
      element.dataset.octopusPopupHidden = 'true';
      element.style.setProperty('display', 'none', 'important');
      if (document.body) document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      return true;
    }, item.popupXPath).catch(() => false);
    if (!hidden) break;
    results.push({
      type: item.type,
      action: 'hide',
      xpath: item.popupXPath,
      text: item.popupText,
      confidence: item.confidence,
      removed: true,
      reasons: item.reasons
    });
    await delay(200);
  }
  return results;
}

export async function waitForPopupRemoved(page: Page, popupXPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (await popupIsRemoved(page, popupXPath).catch(() => false)) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return popupIsRemoved(page, popupXPath).catch(() => false);
}

export async function popupIsRemoved(page: Page, popupXPath: string): Promise<boolean> {
  return page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue instanceof HTMLElement || result.singleNodeValue instanceof SVGElement
      ? result.singleNodeValue
      : null;
    if (!element) return true;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
  }, popupXPath);
}

export async function detectPageObstructions(page: Page): Promise<Array<{
  popupXPath: string;
  popupText: string;
  type: DetectedPopupDismissal['type'];
  confidence: number;
  closeXPath?: string;
  closeText?: string;
  reasons: string[];
  canHide: boolean;
}>> {
  const detected = await page.evaluate(() => {
    type PopupType = DetectedPopupDismissal['type'];
    type Candidate = {
      popupXPath: string;
      popupText: string;
      type: PopupType;
      confidence: number;
      closeXPath?: string;
      closeText?: string;
      reasons: string[];
      canHide: boolean;
    };
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const viewportArea = viewportWidth * viewportHeight;
    const closeTextPattern = /^(×|x|X|关闭|关 闭|取消|跳过|暂不|稍后|以后再说|我知道了|知道了|不登录|先逛逛|close|skip|not now|later|maybe later)$/i;
    const unsafeTextPattern = /(登录|登陆|注册|手机号|验证码|获取验证码|同意|授权|支付|购买|开通|login|sign in|sign up|register|verify|submit|continue|agree)/i;
    const loginPattern = /(登录|登陆|注册|手机号|验证码|扫码|二维码|微信|账号|密码|login|sign in|sign up|register|phone|verification|qr|account|password|auth)/i;
    const cookiePattern = /(cookie|cookies|隐私|privacy|同意使用|接受全部|accept all)/i;
    const adPattern = /(广告|推广|赞助|下载.?app|打开.?app|advert|sponsor|promotion|install app)/i;
    const captchaPattern = /(验证码|滑块|captcha|验证你是真人|人机验证)/i;
    const paywallPattern = /(付费|会员|订阅|开通|阅读全文|继续阅读|paywall|subscribe|premium)/i;

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('data-testid') || ''
      ].join(' ');
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        const same = parent ? Array.from(parent.children).filter((item) => item.tagName === current?.tagName) : [];
        parts.unshift(`${tag}[${same.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return `/${parts.join('/')}`;
    }

    function popupType(value: string): PopupType {
      if (loginPattern.test(value)) return 'login';
      if (captchaPattern.test(value)) return 'captcha';
      if (cookiePattern.test(value)) return 'cookie';
      if (paywallPattern.test(value)) return 'paywall';
      if (adPattern.test(value)) return 'ad';
      return 'unknown';
    }

    function zIndexOf(element: Element): number {
      const raw = window.getComputedStyle(element as HTMLElement).zIndex;
      const parsed = Number.parseInt(raw || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function topHitRate(element: Element): number {
      const points = [
        [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
        [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]
      ];
      let hits = 0;
      for (const [xRatio, yRatio] of points) {
        const top = document.elementFromPoint(viewportWidth * xRatio, viewportHeight * yRatio);
        if (top && (top === element || element.contains(top))) hits += 1;
      }
      return hits / points.length;
    }

    function closeScore(element: Element, popup: Element): number {
      const value = [
        text(element),
        attrText(element)
      ].join(' ').trim();
      const rect = element.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const topRightCompact = rect.width <= 80
        && rect.height <= 80
        && rect.left >= popupRect.right - 140
        && rect.top <= popupRect.top + 140;
      const iconOnlyClose = topRightCompact && (value === '' || /^(svg|path|g|i|span|div)\b/i.test(value) || Boolean(element.querySelector?.('svg,path,use,i')));
      let score = 0;
      if (closeTextPattern.test(value)) score += 0.55;
      if (/(close|dismiss|cancel|skip|关闭|取消|跳过|不登录|稍后|later)/i.test(value)) score += 0.28;
      if (/^(button|a)$/i.test(element.localName) || (element as HTMLElement).onclick || element.getAttribute('role') === 'button') score += 0.12;
      if (rect.width <= 72 && rect.height <= 72) score += 0.1;
      if (topRightCompact) score += 0.22;
      if (iconOnlyClose) score += 0.16;
      if (unsafeTextPattern.test(value) && !/(关闭|取消|跳过|不登录|稍后|not now|close|skip|later)/i.test(value)) score -= 0.7;
      if (rect.width < 8 || rect.height < 8) score -= 0.2;
      return score;
    }

    function closeClickTarget(element: Element, popup: Element): Element {
      let current: Element | null = element;
      for (let depth = 0; current && current !== popup && depth < 5; depth += 1, current = current.parentElement) {
        const value = `${text(current)} ${attrText(current)}`.trim();
        const rect = current.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const compactTopRight = rect.width <= 96
          && rect.height <= 96
          && rect.left >= popupRect.right - 160
          && rect.top <= popupRect.top + 160;
        const explicitClose = /(close|dismiss|cancel|skip|关闭|取消|跳过|不登录|稍后|later)/i.test(value);
        const clickable = /^(button|a)$/i.test(current.localName)
          || (current as HTMLElement).onclick
          || current.getAttribute('role') === 'button';
        if (explicitClose || clickable && compactTopRight) return current;
      }
      return element;
    }

    function findCloseButton(popup: Element): { element: Element; score: number; text: string } | undefined {
      const selectors = [
        '[aria-label],[title],[role="button"]',
        'button,a,input[type="button"],input[type="submit"]',
        '[class*="close" i],[class*="cancel" i],[class*="dismiss" i],[class*="skip" i]',
        'svg,path,span,div'
      ].join(',');
      return Array.from(popup.querySelectorAll(selectors))
        .filter((element) => element instanceof HTMLElement || element instanceof SVGElement)
        .filter(visible)
        .map((element) => {
          const target = closeClickTarget(element, popup);
          return {
            element: target,
            score: Math.max(closeScore(element, popup), closeScore(target, popup)),
            text: text(target) || text(element) || (target as HTMLElement).getAttribute?.('aria-label') || (target as HTMLElement).getAttribute?.('title') || (element as HTMLElement).getAttribute?.('aria-label') || (element as HTMLElement).getAttribute?.('title') || ''
          };
        })
        .filter((item) => item.score >= 0.35)
        .sort((a, b) => b.score - a.score)[0];
    }

    const root = document.body || document.documentElement;
    if (!root) return [];
    const raw = Array.from(root.querySelectorAll('*'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const areaRatio = Math.min(rect.width, viewportWidth) * Math.min(rect.height, viewportHeight) / viewportArea;
        const attrs = attrText(element);
        const bodyText = text(element).slice(0, 500);
        const value = `${attrs} ${bodyText}`;
        const fixedLike = style.position === 'fixed' || style.position === 'sticky';
        const zIndex = zIndexOf(element);
        const centered = rect.left < viewportWidth * 0.72 && rect.right > viewportWidth * 0.28 && rect.top < viewportHeight * 0.75 && rect.bottom > viewportHeight * 0.18;
        const modalAttrSemantic = /(dialog|modal|popup|pop|mask|overlay|login|signin|auth)/i.test(attrs) || element.getAttribute('aria-modal') === 'true' || element.getAttribute('role') === 'dialog';
        const contentSemantic = loginPattern.test(bodyText) || cookiePattern.test(bodyText) || adPattern.test(bodyText) || captchaPattern.test(bodyText) || paywallPattern.test(bodyText);
        const semantic = modalAttrSemantic || contentSemantic;
        const hitRate = fixedLike || semantic || zIndex >= 10 ? topHitRate(element) : 0;
        const scrollLocked = document.body?.style.overflow === 'hidden' || document.documentElement.style.overflow === 'hidden';
        const hasLoginInput = typeof element.querySelector === 'function'
          ? Boolean(element.querySelector('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]'))
          : false;
        const hasOverlayEvidence = fixedLike || zIndex >= 10 || modalAttrSemantic || scrollLocked;
        const hasObstructionEvidence = hasOverlayEvidence && (hitRate >= 0.35 || centered || areaRatio >= 0.12 || scrollLocked);
        const type = popupType(value);
        const explicitModalAttrSemantic = /(dialog|modal|popup|pop|mask|overlay|signin|auth)/i.test(attrs) || element.getAttribute('aria-modal') === 'true' || element.getAttribute('role') === 'dialog';
        const loginContainerAttrSemantic = /(login|passport)/i.test(attrs);
        const strongLoginObstruction = type !== 'login'
          || hasLoginInput
          || explicitModalAttrSemantic && (centered || hitRate >= 0.25 || areaRatio >= 0.08)
          || loginContainerAttrSemantic && (fixedLike || zIndex >= 10) && centered && areaRatio >= 0.04
          || scrollLocked && (centered || areaRatio >= 0.12)
          || fixedLike && centered && areaRatio >= 0.08;
        let confidence = 0;
        const reasons: string[] = [];
        if (fixedLike) {
          confidence += 0.18;
          reasons.push('fixed/sticky positioning');
        }
        if (zIndex >= 10) {
          confidence += 0.14;
          reasons.push('elevated z-index');
        }
        if (areaRatio >= 0.18) {
          confidence += Math.min(0.24, areaRatio * 0.3);
          reasons.push('large viewport coverage');
        }
        if (centered) {
          confidence += 0.18;
          reasons.push('center viewport overlap');
        }
        if (semantic) {
          confidence += 0.22;
          reasons.push('modal/login semantic text or attributes');
        }
        if (hasLoginInput) {
          confidence += 0.2;
          reasons.push('login input found');
        }
        if (hitRate >= 0.35) {
          confidence += 0.18;
          reasons.push('topmost element at viewport sample points');
        }
        if (scrollLocked) {
          confidence += 0.08;
          reasons.push('page scroll locked');
        }
        if (!hasObstructionEvidence) confidence = 0;
        if (!strongLoginObstruction) confidence = 0;
        return { element, rect, confidence, reasons, value, type, areaRatio };
      })
      .filter((item) => item.confidence >= 0.52)
      .sort((a, b) => b.confidence - a.confidence || b.areaRatio - a.areaRatio);

    const output: Candidate[] = [];
    const used = new Set<Element>();
    for (const item of raw) {
      if (used.has(item.element)) continue;
      if (raw.some((other) => other !== item && other.element.contains(item.element) && other.confidence >= item.confidence + 0.08)) continue;
      const close = findCloseButton(item.element);
      if (item.type === 'unknown' && !close) continue;
      output.push({
        popupXPath: xpath(item.element),
        popupText: text(item.element).slice(0, 180),
        type: item.type,
        confidence: Number(Math.min(0.98, item.confidence).toFixed(2)),
        ...(close ? { closeXPath: xpath(close.element), closeText: close.text.slice(0, 60) } : {}),
        reasons: item.reasons,
        canHide: item.type !== 'captcha' && item.type !== 'unknown' && (item.type !== 'paywall' || Boolean(close))
      });
      used.add(item.element);
      if (output.length >= 3) break;
    }
    return output;
  });
  return detected;
}

export async function clickXPath(page: Page, xpath: string): Promise<boolean> {
  return await page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    if (!element) return false;
    let target: Element | null = element;
    for (let depth = 0; target && depth < 5; depth += 1, target = target.parentElement) {
      const html = target as HTMLElement;
      const attrs = [
        target.localName,
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        target.getAttribute('role') || '',
        target.getAttribute('aria-label') || '',
        target.getAttribute('title') || ''
      ].join(' ');
      if (/^(button|a)$/i.test(target.localName) || html.onclick || target.getAttribute('role') === 'button' || /close|cancel|dismiss|skip|button|btn|关闭|取消|跳过/i.test(attrs)) {
        break;
      }
    }
    target ||= element;
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    if (typeof target.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      target.dispatchEvent(new PointerEventCtor('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new PointerEventCtor('pointerup', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
    }
    if (typeof (target as HTMLElement).click === 'function') {
      (target as HTMLElement).click();
    } else if (typeof target.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      target.dispatchEvent(new MouseEvent('click', eventInit));
    } else {
      return false;
    }
    return true;
  }, xpath);
}

export function dedupePopupDismissals(items: DetectedPopupDismissal[]): DetectedPopupDismissal[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.action}:${item.type}:${item.xpath ?? ''}:${item.text ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function confirmManualPopupDismissal(page: Page, runtimeConsole: SuppressedRuntimeConsole, promptedKeys = new Set<string>()): Promise<DetectedPopupDismissal[]> {
  const item = (await detectPageObstructions(page).catch(() => []))
    .find((candidate) => candidate.closeXPath && candidate.canHide && candidate.type !== 'captcha');
  if (!item?.closeXPath) return [];
  const promptKey = `${item.type}:${item.popupXPath}:${item.closeXPath}`;
  if (promptedKeys.has(promptKey)) return [];
  promptedKeys.add(promptKey);

  writeManualOverlayHintOnce(runtimeConsole, page, 'popup-dismissal', '\n检测到页面弹窗，请在浏览器悬浮框中确认处理方式。\n');
  await showManualOverlay(page, {
    title: '检测到页面弹窗',
    message: [
      `识别类型: ${popupTypeLabel(item.type)}`,
      item.popupText ? `内容: ${truncateText(item.popupText, 90)}` : '',
      item.closeText ? `关闭按钮: ${truncateText(item.closeText, 40)}` : '',
      '如果这是登录、验证或需要保留的权限提示，请不要关闭。'
    ].filter(Boolean).join('\n'),
    status: item.closeText || item.closeXPath,
    selectedXPath: item.closeXPath,
    selectedText: item.closeText,
    choices: [
      {
        title: '不关闭，继续检测',
        value: 'keep',
        primary: true,
        description: '不会写入关闭动作；适合登录、验证、权限或不确定的弹窗。'
      },
      {
        title: '关闭，并写入任务',
        value: 'dismiss',
        description: '会点击关闭按钮；适合广告、订阅或不影响登录的提示。'
      },
      { title: '取消手动检测', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page).catch(() => undefined);
  await removeManualOverlay(page).catch(() => undefined);
  if (selection?.action === 'cancel') throw new Error('用户取消了手动检测');
  if (selection?.action !== 'dismiss') return [];

  const clicked = await clickXPath(page, item.closeXPath).catch(() => false);
  if (!clicked) return [];
  const removed = await waitForPopupRemoved(page, item.popupXPath, 900).catch(() => false);
  if (!removed) return [];
  return [{
    type: item.type,
    action: 'click',
    xpath: item.closeXPath,
    text: item.closeText || item.popupText,
    confidence: item.confidence,
    removed: true,
    confirmedByUser: true,
    reasons: [...item.reasons, 'confirmed by manual popup prompt']
  }];
}

export async function detectPageObstructionsForTesting(page: Page): Promise<Array<{
  popupXPath: string;
  popupText: string;
  type: DetectedPopupDismissal['type'];
  confidence: number;
  closeXPath?: string;
  closeText?: string;
  reasons: string[];
  canHide: boolean;
}>> {
  return detectPageObstructions(page);
}

export async function dismissPageObstructionsForTesting(page: Page, options: { includeLogin?: boolean } = {}): Promise<DetectedPopupDismissal[]> {
  return dismissPageObstructions(page, options);
}

export async function confirmManualPopupDismissalForTesting(page: Page, runtimeConsole: SuppressedRuntimeConsole, promptedKeys?: Set<string>): Promise<DetectedPopupDismissal[]> {
  return confirmManualPopupDismissal(page, runtimeConsole, promptedKeys);
}
