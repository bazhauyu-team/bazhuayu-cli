import type { Browser, Page } from 'puppeteer-core';
import type {
  ManualOverlayAction,
  ManualOverlayOptions,
  ManualOverlaySelection,
  SearchSubmitButton,
  SuppressedRuntimeConsole
} from './page-detector-shared.js';
import { delay } from './page-detector-utils.js';

const manualOverlayHintKeys = new Set<string>();

export function writeManualOverlayHintOnce(runtimeConsole: SuppressedRuntimeConsole, page: Page | undefined, key: string, message: string): void {
  void page;
  const scopedKey = key;
  if (manualOverlayHintKeys.has(scopedKey)) return;
  manualOverlayHintKeys.add(scopedKey);
  runtimeConsole.writeStderr(message);
}

export async function runLiveSelectMenu<T extends string>(options: {
  write: (value: string) => void;
  title: () => string;
  readState: () => Promise<void>;
  choices: () => Array<{ title: string; value: T }>;
}): Promise<T> {
  const input = process.stdin;
  const wasRaw = input.isRaw;
  let selectedIndex = 0;
  let lineCount = 0;
  let stopped = false;
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  let rendering = false;
  let lastRendered = '';

  const clear = () => {
    if (!lineCount) return;
    options.write(`\x1b[${lineCount}A`);
    for (let index = 0; index < lineCount; index += 1) {
      options.write('\x1b[2K');
      if (index < lineCount - 1) options.write('\x1b[1B');
    }
    options.write(`\x1b[${Math.max(0, lineCount - 1)}A\r`);
  };

  const render = async () => {
    if (stopped || rendering) return;
    rendering = true;
    try {
      await options.readState().catch(() => undefined);
      const choices = options.choices();
      if (selectedIndex >= choices.length) selectedIndex = Math.max(0, choices.length - 1);
      const lines = [
        ...options.title().split('\n'),
        ...choices.map((choice, index) => `${index === selectedIndex ? '›' : ' '} ${choice.title}`)
      ];
      const rendered = lines.join('\n');
      if (rendered === lastRendered) return;
      clear();
      options.write(`${rendered}\n`);
      lineCount = lines.length;
      lastRendered = rendered;
    } finally {
      rendering = false;
    }
  };

  const cleanup = () => {
    stopped = true;
    clearInterval(interval);
    input.off('data', onData);
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
    clear();
  };

  const onData = (chunk: Buffer) => {
    const value = chunk.toString('utf8');
    const choices = options.choices();
    if (value === '\u0003') {
      cleanup();
      rejectValue?.(new Error('用户取消了手动检测'));
      return;
    }
    if (value === '\u001b[A') {
      selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
      void render();
      return;
    }
    if (value === '\u001b[B') {
      selectedIndex = (selectedIndex + 1) % choices.length;
      void render();
      return;
    }
    if (value === '\r' || value === '\n') {
      const selected = choices[selectedIndex];
      if (!selected) return;
      cleanup();
      resolveValue?.(selected.value);
      return;
    }
  };

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.on('data', onData);
  const interval = setInterval(() => {
    void render();
  }, 700);
  await render();
  return new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
}

export async function showManualOverlay(page: Page, options: ManualOverlayOptions): Promise<void> {
  await page.evaluate((payload) => {
    type ManualOverlayAction = string;
    type ManualOverlayChoice = {
      title: string;
      value: ManualOverlayAction;
      description?: string;
      primary?: boolean;
    };
    type ManualOverlayState = {
      action?: ManualOverlayAction;
      selectedXPath?: string;
      selectedText?: string;
    };
    const w = window as typeof window & {
      __octopusManualOverlayState?: ManualOverlayState;
      __octopusManualOverlayCleanup?: () => void;
      __octopusManualOverlayRenderCleanup?: () => void;
      __octopusManualOverlayPosition?: { left: number; top: number };
      __octopusManualOverlayIgnoreClickUntil?: number;
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
    const byXPath = (path: string): Element | null => {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    };
    const textOf = (element: Element): string => (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const attrsOf = (element: Element): string => [
      element.localName,
      String((element as HTMLElement).id || ''),
      String((element as HTMLElement).className || ''),
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || ''
    ].join(' ');
    const childAttrsOf = (element: Element): string => Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
      .map((child) => attrsOf(child))
      .join(' ');
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const rightSideControl = (input: Element, button: Element): boolean => {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(52, inputRect.height * 0.8);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 180 && buttonRect.left <= inputRect.right + 240;
      const insideInputRight = buttonRect.right <= inputRect.right + 80 && buttonRect.left >= inputRect.left + inputRect.width * 0.42;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    };
    const inputElements = (payload.inputXPaths || []).map(byXPath).filter((element): element is Element => Boolean(element));
    const targetFor = (element: Element): Element => {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const candidate = current;
        const attrs = attrsOf(candidate);
        const style = window.getComputedStyle(candidate as HTMLElement);
        const rect = candidate.getBoundingClientRect();
        const compact = rect.width >= 8 && rect.height >= 8 && rect.width <= 180 && rect.height <= 180;
        const tapTarget = rect.width >= 24 && rect.height >= 24 && rect.width <= 120 && rect.height <= 120;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const tooBroad = rect.width > 320 || rect.height > 220;
        const semantic = /search|query|submit|button|btn|搜索|查询/i.test(`${attrs} ${textOf(candidate)} ${childAttrsOf(candidate)}`);
        const icon = /icon|suffix|append|magnif|glass|lens|svg|path|use/i.test(`${candidate.localName} ${attrs} ${childAttrsOf(candidate)}`);
        const nearInput = inputElements.some((input) => rightSideControl(input, candidate));
        let score = 0;
        if (/^(button|input)$/i.test(candidate.tagName)) score += 3.5;
        if (/^a$/i.test(candidate.tagName)) score += 1.2;
        if (candidate.getAttribute('role') === 'button') score += 3;
        if (candidate.getAttribute('onclick') || candidate.getAttribute('tabindex')) score += 2;
        if (style.cursor === 'pointer') score += 2.4;
        if (semantic) score += 1.6;
        if (icon) score += 0.8;
        if (nearInput) score += 1.4;
        if (tapTarget && nearInput) score += 1.2;
        if (candidate !== element && candidate.contains(element) && compact) score += 0.65;
        if (tinyGlyph) score -= 1.8;
        if (compact) score += 0.6;
        else if (tooBroad) score -= 1.8;
        if (!visible(candidate)) score = 0;
        if (score >= 1.2) candidates.push({ element: candidate, score: score - depth * 0.04 });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    };

    const previousSelectedXPath = payload.selectedXPath;
    const previousSelectedText = payload.selectedText;
    const previousState = w.__octopusManualOverlayState || {};
    w.__octopusManualOverlayRenderCleanup?.();
    w.__octopusManualOverlayState = {
      ...(previousState.selectedXPath ? { selectedXPath: previousState.selectedXPath } : {}),
      ...(previousState.selectedText ? { selectedText: previousState.selectedText } : {}),
      ...(previousSelectedXPath ? { selectedXPath: previousSelectedXPath } : {}),
      ...(previousSelectedText ? { selectedText: previousSelectedText } : {})
    };

    const existingHost = document.querySelector('[data-octopus-manual-overlay="true"]');
    const host = existingHost instanceof HTMLElement ? existingHost : document.createElement('div');
    host.setAttribute('data-octopus-manual-overlay', 'true');
    const savedPosition = w.__octopusManualOverlayPosition;
    if (!existingHost) {
      Object.assign(host.style, {
        position: 'fixed',
        left: `${Math.max(8, Math.min(window.innerWidth - 80, savedPosition?.left ?? 16))}px`,
        top: `${Math.max(8, Math.min(window.innerHeight - 80, savedPosition?.top ?? 96))}px`,
        zIndex: '2147483647',
        width: 'min(420px, calc(100vw - 32px))',
        pointerEvents: 'auto'
      });
    } else {
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'auto';
    }
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        box-sizing: border-box;
        width: 100%;
        color: #e5e2e1;
        background: rgba(19, 19, 19, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        overflow: hidden;
      }
      .header {
        padding: 16px 16px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        cursor: move;
        user-select: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .title {
        margin: 0;
        color: #e5e2e1;
        font-weight: 700;
        font-size: 13px;
        line-height: 1.2;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .active-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: 'JetBrains Mono', Courier, monospace;
        font-size: 9px;
        color: #4edea3;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        margin-top: 2px;
      }
      .pulse-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #4edea3;
        box-shadow: 0 0 0 0 rgba(78, 222, 163, 0.4);
        animation: pulse-dot 2s infinite;
      }
      @keyframes pulse-dot {
        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(78, 222, 163, 0.7); }
        70% { transform: scale(1); box-shadow: 0 0 0 5px rgba(78, 222, 163, 0); }
        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(78, 222, 163, 0); }
      }
      .message {
        margin-top: 6px;
        color: #c2c6d6;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
      }
      .status {
        margin: 12px 16px 0;
        padding: 10px 12px;
        color: #c2c6d6;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        word-break: break-all;
        font-family: 'JetBrains Mono', Courier, monospace;
        font-size: 11px;
        line-height: 1.4;
      }
      .status.processing {
        color: #adc6ff;
        background: rgba(173, 198, 255, 0.08);
        border-color: rgba(173, 198, 255, 0.2);
      }
      .status.processing::after {
        content: "_";
        animation: blink 1s step-end infinite;
      }
      @keyframes blink {
        from, to { color: transparent; }
        50% { color: inherit; }
      }
      .actions {
        display: grid;
        gap: 8px;
        padding: 12px 16px 16px;
      }
      button {
        appearance: none;
        box-sizing: border-box;
        width: 100%;
        min-height: 38px;
        padding: 10px 14px;
        border-radius: 8px;
        font: inherit;
        text-align: left;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
      }
      button:active:not(:disabled) {
        transform: scale(0.98);
      }
      button:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      button.primary {
        color: #002e6a;
        background: #adc6ff;
        border: 1px solid #adc6ff;
        font-weight: 600;
        text-align: center;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(173, 198, 255, 0.15);
      }
      button.primary:hover:not(:disabled) {
        background: #c2d6ff;
        border-color: #c2d6ff;
      }
      button.secondary {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        color: #e5e2e1;
      }
      button.secondary:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.12);
      }
      button.danger {
        color: #ffb4ab;
        background: rgba(255, 180, 171, 0.08);
        border: 1px solid rgba(255, 180, 171, 0.2);
      }
      button.danger:hover:not(:disabled) {
        background: rgba(255, 180, 171, 0.14);
        border-color: rgba(255, 180, 171, 0.3);
      }
      button.loading {
        text-align: center;
        align-items: center;
        justify-content: center;
      }
      .desc {
        display: block;
        color: #c2c6d6;
        font-size: 11px;
        line-height: 1.3;
        word-break: break-all;
        opacity: 0.6;
      }
      button.primary .desc {
        color: #002e6a;
        opacity: 0.8;
      }
      .mark {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        border: 2px dashed #adc6ff;
        background: rgba(173, 198, 255, 0.08);
        border-radius: 6px;
        transition: all 0.2s ease;
      }
      .mark.selected {
        border: 2px solid #4edea3;
        background: rgba(78, 222, 163, 0.12);
        box-shadow: 0 0 12px rgba(78, 222, 163, 0.25);
      }
      .progress-mode {
        position: relative;
      }
      /* Scanning Laser Line */
      .progress-mode::before {
        content: '';
        position: absolute;
        top: 0;
        left: -50%;
        width: 50%;
        height: 2px;
        background: linear-gradient(90deg, transparent, #4edea3, #adc6ff, transparent);
        animation: laser-sweep 2s infinite linear;
        z-index: 10;
      }
      @keyframes laser-sweep {
        0% { left: -50%; }
        100% { left: 100%; }
      }

      /* HUD Spinner */
      .loader-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px 16px 28px;
        position: relative;
        background: rgba(255, 255, 255, 0.01);
      }
      .hud-ring {
        width: 52px;
        height: 52px;
        border: 2px solid rgba(173, 198, 255, 0.1);
        border-top: 2px solid #adc6ff;
        border-bottom: 2px solid #4edea3;
        border-radius: 50%;
        animation: spin-clockwise 1.2s infinite linear;
        position: relative;
      }
      .hud-ring::before {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        right: 3px;
        bottom: 3px;
        border: 1px dashed rgba(78, 222, 163, 0.25);
        border-radius: 50%;
        animation: spin-counter-clockwise 4s infinite linear;
      }
      .hud-core {
        position: absolute;
        width: 14px;
        height: 14px;
        background: #adc6ff;
        border-radius: 50%;
        box-shadow: 0 0 10px #adc6ff;
        animation: pulse-core 1.5s infinite ease-in-out;
      }
      @keyframes spin-clockwise {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes spin-counter-clockwise {
        0% { transform: rotate(360deg); }
        100% { transform: rotate(0deg); }
      }
      @keyframes pulse-core {
        0%, 100% { transform: scale(0.85); opacity: 0.5; box-shadow: 0 0 6px #adc6ff; background: #adc6ff; }
        50% { transform: scale(1.15); opacity: 1; box-shadow: 0 0 16px #adc6ff, 0 0 24px #4edea3; background: #4edea3; }
      }
      button.loading {
        text-align: center;
        align-items: center;
        justify-content: center;
        background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.04) 75%);
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite linear;
        color: #adc6ff;
        border-color: rgba(173, 198, 255, 0.3);
      }
      button.loading::before {
        content: '';
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(173, 198, 255, 0.2);
        border-top-color: #adc6ff;
        border-radius: 50%;
        animation: spin-clockwise 0.8s infinite linear;
        margin-bottom: 4px;
      }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const header = document.createElement('div');
    header.className = 'header';
    header.title = '拖动移动悬浮框';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = payload.title;
    header.appendChild(title);

    const badge = document.createElement('div');
    badge.className = 'active-badge';
    const dot = document.createElement('span');
    dot.className = 'pulse-dot';
    const badgeText = document.createElement('span');
    badgeText.textContent = 'Active Process';
    badge.appendChild(dot);
    badge.appendChild(badgeText);
    header.appendChild(badge);

    if (payload.message) {
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = payload.message;
      header.appendChild(message);
    }
    panel.appendChild(header);
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = payload.status || '';
    if (payload.status) panel.appendChild(status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const choices = payload.choices as ManualOverlayChoice[];
    if (choices.length === 0) {
      panel.classList.add('progress-mode');
    }
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = choice.primary ? 'primary' : choice.value === 'cancel' ? 'danger' : 'secondary';
      button.textContent = choice.title;
      if (choice.description) {
        const desc = document.createElement('span');
        desc.className = 'desc';
        desc.textContent = choice.description;
        button.appendChild(desc);
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        panel.classList.add('progress-mode');
        actions.querySelectorAll('button').forEach((item) => {
          item.disabled = true;
          item.classList.remove('primary', 'secondary', 'danger');
          item.classList.add('secondary');
        });
        button.classList.add('loading');
        button.textContent = choice.value === 'cancel' ? '正在取消...' : '处理中...';
        if (!status.isConnected) panel.insertBefore(status, actions);
        status.className = 'status processing';
        status.textContent = choice.value === 'cancel' ? '正在取消检测，请稍候。' : '已收到操作，正在处理，请稍候。';
        w.__octopusManualOverlayState = {
          ...(w.__octopusManualOverlayState || {}),
          action: choice.value
        };
      });
      actions.appendChild(button);
    }
    if (choices.length === 0) {
      const loaderContainer = document.createElement('div');
      loaderContainer.className = 'loader-container';
      const hudRing = document.createElement('div');
      hudRing.className = 'hud-ring';
      const hudCore = document.createElement('div');
      hudCore.className = 'hud-core';
      loaderContainer.appendChild(hudRing);
      loaderContainer.appendChild(hudCore);
      panel.appendChild(loaderContainer);
    } else {
      panel.appendChild(actions);
    }
    root.replaceChildren(style, panel);
    if (!host.isConnected) document.body.appendChild(host);

    let dragStart: { x: number; y: number; left: number; top: number } | undefined;
    const clampPosition = (left: number, top: number) => {
      const rect = host.getBoundingClientRect();
      return {
        left: Math.max(8, Math.min(window.innerWidth - Math.min(80, rect.width), left)),
        top: Math.max(8, Math.min(window.innerHeight - Math.min(48, rect.height), top))
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragStart) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const next = clampPosition(dragStart.left + event.clientX - dragStart.x, dragStart.top + event.clientY - dragStart.y);
      host.style.left = `${next.left}px`;
      host.style.top = `${next.top}px`;
      w.__octopusManualOverlayPosition = next;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragStart) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        w.__octopusManualOverlayIgnoreClickUntil = Date.now() + 350;
      }
      dragStart = undefined;
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
    };
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const rect = host.getBoundingClientRect();
      dragStart = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
    });

    const markers: HTMLElement[] = [];
    const addMarker = (path: string, selected = false) => {
      const element = byXPath(path);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const marker = document.createElement('div');
      marker.className = selected ? 'mark selected' : 'mark';
      Object.assign(marker.style, {
        left: `${Math.max(0, rect.left - 3)}px`,
        top: `${Math.max(0, rect.top - 3)}px`,
        width: `${Math.max(8, rect.width + 6)}px`,
        height: `${Math.max(8, rect.height + 6)}px`
      });
      document.body.appendChild(marker);
      markers.push(marker);
    };
    for (const path of payload.highlightXPaths || []) addMarker(path, false);
    if (previousSelectedXPath) addMarker(previousSelectedXPath, true);

    const onClick = (event: MouseEvent) => {
      const path = event.composedPath();
      if (Date.now() < (w.__octopusManualOverlayIgnoreClickUntil || 0)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (payload.mode !== 'pick-search-submit') return;
      const raw = event.target instanceof Element ? event.target : undefined;
      if (!raw || path.includes(host)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFor(raw);
      const selectedXPath = xpath(target);
      w.__octopusManualOverlayState = {
        ...(w.__octopusManualOverlayState || {}),
        selectedXPath,
        selectedText: textOf(target)
      };
      markers.forEach((marker) => marker.remove());
      markers.length = 0;
      addMarker(selectedXPath, true);
    };
    document.addEventListener('click', onClick, true);

    w.__octopusManualOverlayRenderCleanup = () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      markers.forEach((marker) => marker.remove());
      delete w.__octopusManualOverlayRenderCleanup;
    };
    w.__octopusManualOverlayCleanup = () => {
      w.__octopusManualOverlayRenderCleanup?.();
      host.remove();
      delete w.__octopusManualOverlayCleanup;
    };
  }, options);
}

export async function readManualOverlaySelection(page: Page): Promise<ManualOverlaySelection | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusManualOverlayState?: {
        action?: ManualOverlayAction;
        selectedXPath?: string;
        selectedText?: string;
      };
    };
    const state = w.__octopusManualOverlayState;
    if (!state) return undefined;
    return {
      ...(state.action ? { action: state.action } : {}),
      ...(state.selectedXPath ? { selectedXPath: state.selectedXPath } : {}),
      ...(state.selectedText ? { selectedText: state.selectedText } : {})
    };
  }).catch(() => undefined);
}

/** True when the manual overlay host node is still attached to the page DOM. */
export async function hasManualOverlayHost(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  return page.evaluate(() => Boolean(document.querySelector('[data-octopus-manual-overlay="true"]')))
    .catch(() => false);
}

export function isInjectableBrowserPageUrl(url: string | undefined): boolean {
  if (!url) return false;
  const value = url.trim().toLowerCase();
  if (!value || value === 'about:blank') return false;
  if (value.startsWith('chrome://') || value.startsWith('chrome-error://') || value.startsWith('chrome-extension://')) return false;
  if (value.startsWith('devtools://') || value.startsWith('edge://') || value.startsWith('about:')) return false;
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('file://');
}

export async function clearManualOverlayAction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusManualOverlayState?: { action?: ManualOverlayAction; selectedXPath?: string; selectedText?: string } };
    if (w.__octopusManualOverlayState) delete w.__octopusManualOverlayState.action;
  }).catch(() => undefined);
}

export async function removeManualOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __octopusManualOverlayCleanup?: () => void;
      __octopusManualOverlayRenderCleanup?: () => void;
      __octopusManualOverlayState?: unknown;
    };
    w.__octopusManualOverlayCleanup?.();
    delete w.__octopusManualOverlayRenderCleanup;
    delete w.__octopusManualOverlayState;
  }).catch(() => undefined);
}

export async function removeManualOverlaysFromBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  const pages = await browser.pages().catch(() => []);
  await Promise.all(pages.filter((page) => !page.isClosed()).map((page) => removeManualOverlay(page).catch(() => undefined)));
}

export async function waitForManualOverlayAction(page: Page, timeoutMs = 0): Promise<ManualOverlaySelection | undefined> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    if (page.isClosed()) return undefined;
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state;
    await delay(150);
  }
  return undefined;
}

export async function showManualOverlayForTesting(page: Page, options: Parameters<typeof showManualOverlay>[1]): Promise<void> {
  await showManualOverlay(page, options);
}

export async function readManualOverlaySelectionForTesting(page: Page): Promise<ManualOverlaySelection | undefined> {
  return readManualOverlaySelection(page);
}

export async function hasManualOverlayHostForTesting(page: Page): Promise<boolean> {
  return hasManualOverlayHost(page);
}

export function isInjectableBrowserPageUrlForTesting(url: string | undefined): boolean {
  return isInjectableBrowserPageUrl(url);
}

export function resetManualOverlayHintKeysForTesting(): void {
  manualOverlayHintKeys.clear();
}

export function writeManualOverlayHintOnceForTesting(runtimeConsole: SuppressedRuntimeConsole, page: Page | undefined, key: string, message: string): void {
  writeManualOverlayHintOnce(runtimeConsole, page, key, message);
}

export async function installSearchSubmitPickerOverlay(page: Page, inputXPaths: string[] = []): Promise<void> {
  await page.evaluate((knownInputXPaths) => {
    type SearchSubmitSelection = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
    const w = window as typeof window & {
      __octopusSearchSubmitSelection?: SearchSubmitSelection;
      __octopusSearchSubmitCleanup?: () => void;
    };
    w.__octopusSearchSubmitCleanup?.();
    w.__octopusSearchSubmitSelection = undefined;

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
    const byXPath = (path: string): Element | null => {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    };
    const textOf = (element: Element): string => (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const attrsOf = (element: Element): string => [
      element.localName,
      String((element as HTMLElement).id || ''),
      String((element as HTMLElement).className || ''),
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || ''
    ].join(' ');
    const childAttrsOf = (element: Element): string => Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
      .map((child) => attrsOf(child))
      .join(' ');
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const rightSideControl = (input: Element, button: Element): boolean => {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(52, inputRect.height * 0.8);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 180 && buttonRect.left <= inputRect.right + 240;
      const insideInputRight = buttonRect.right <= inputRect.right + 80 && buttonRect.left >= inputRect.left + inputRect.width * 0.42;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    };
    const inputElements = knownInputXPaths.map(byXPath).filter((element): element is Element => Boolean(element));
    const targetFor = (element: Element): Element => {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const candidate = current;
        const attrs = attrsOf(candidate);
        const style = window.getComputedStyle(candidate as HTMLElement);
        const rect = candidate.getBoundingClientRect();
        const compact = rect.width >= 8 && rect.height >= 8 && rect.width <= 180 && rect.height <= 180;
        const tapTarget = rect.width >= 24 && rect.height >= 24 && rect.width <= 120 && rect.height <= 120;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const tooBroad = rect.width > 320 || rect.height > 220;
        const semantic = /search|query|submit|button|btn|搜索|查询/i.test(`${attrs} ${textOf(candidate)} ${childAttrsOf(candidate)}`);
        const icon = /icon|suffix|append|magnif|glass|lens|svg|path|use/i.test(`${candidate.localName} ${attrs} ${childAttrsOf(candidate)}`);
        const nearInput = inputElements.some((input) => rightSideControl(input, candidate));
        let score = 0;
        if (/^(button|input)$/i.test(candidate.tagName)) score += 3.5;
        if (/^a$/i.test(candidate.tagName)) score += 1.2;
        if (candidate.getAttribute('role') === 'button') score += 3;
        if (candidate.getAttribute('onclick') || candidate.getAttribute('tabindex')) score += 2;
        if (style.cursor === 'pointer') score += 2.4;
        if (semantic) score += 1.6;
        if (icon) score += 0.8;
        if (nearInput) score += 1.4;
        if (tapTarget && nearInput) score += 1.2;
        if (candidate !== element && candidate.contains(element) && compact) score += 0.65;
        if (tinyGlyph) score -= 1.8;
        if (compact) score += 0.6;
        else if (tooBroad) score -= 1.8;
        if (!visible(candidate)) score = 0;
        if (score >= 1.2) candidates.push({ element: candidate, score: score - depth * 0.04 });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        const aArea = aRect.width * aRect.height;
        const bArea = bRect.width * bRect.height;
        return (b.score - a.score) || (bArea - aArea);
      });
      return candidates[0]?.element || element;
    };

    const banner = document.createElement('div');
    banner.textContent = '点击搜索按钮以记录任务动作；本次点击会被拦截，不会立即跳转。';
    Object.assign(banner.style, {
      position: 'fixed',
      left: '16px',
      right: '16px',
      top: '16px',
      zIndex: '2147483600',
      padding: '10px 12px',
      color: '#111827',
      background: '#fde68a',
      border: '1px solid #f59e0b',
      borderRadius: '6px',
      font: '13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.18)',
      pointerEvents: 'none'
    });
    document.body.appendChild(banner);

    const marker = document.createElement('div');
    Object.assign(marker.style, {
      position: 'fixed',
      zIndex: '2147483599',
      pointerEvents: 'none',
      border: '2px solid #f97316',
      background: 'rgba(249,115,22,.12)',
      borderRadius: '4px',
      display: 'none'
    });
    document.body.appendChild(marker);

    const onClick = (event: MouseEvent) => {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const raw = event.target instanceof Element ? event.target : undefined;
      if (!raw || raw === banner || raw === marker) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFor(raw);
      const rect = target.getBoundingClientRect();
      Object.assign(marker.style, {
        display: 'block',
        left: `${Math.max(0, rect.left - 3)}px`,
        top: `${Math.max(0, rect.top - 3)}px`,
        width: `${Math.max(8, rect.width + 6)}px`,
        height: `${Math.max(8, rect.height + 6)}px`
      });
      w.__octopusSearchSubmitSelection = {
        xpath: xpath(target),
        ...(textOf(target) ? { text: textOf(target) } : {}),
        score: 2,
        reasons: ['manual picked search submit']
      };
    };
    document.addEventListener('click', onClick, true);
    w.__octopusSearchSubmitCleanup = () => {
      document.removeEventListener('click', onClick, true);
      banner.remove();
      marker.remove();
      delete w.__octopusSearchSubmitSelection;
      delete w.__octopusSearchSubmitCleanup;
    };
  }, inputXPaths);
}

export async function readSearchSubmitPickerSelection(page: Page): Promise<SearchSubmitButton | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusSearchSubmitSelection?: {
        xpath: string;
        text?: string;
        score: number;
        reasons: string[];
      };
    };
    return w.__octopusSearchSubmitSelection;
  });
}

export async function removeSearchSubmitPickerOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusSearchSubmitCleanup?: () => void };
    w.__octopusSearchSubmitCleanup?.();
  });
}
