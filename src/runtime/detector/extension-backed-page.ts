import { writeFile } from 'node:fs/promises';
import type { Browser, Page } from 'puppeteer-core';
import type { DetectorExtensionBridge, ExtensionCommandResponse } from './page-detector-shared.js';

/**
 * Minimal Page/Browser surface for detect in --browser user mode.
 *
 * browser-runtime localBrowserMode drives the real Chrome/Edge profile via the
 * permanently installed extension bridge. Detect must not rely on
 * --remote-debugging-port / puppeteer.connect, because when Chrome is already
 * running the second process only hands off to the singleton and does not expose CDP.
 */
export function createExtensionBackedPage(
  extensionBridge: DetectorExtensionBridge,
  getTabId: () => number,
  setTabId?: (tabId: number) => void
): Page {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let closed = false;
  let defaultTimeout = 30_000;

  const page = {
    setDefaultTimeout(timeout: number) {
      defaultTimeout = timeout;
    },

    isClosed() {
      return closed;
    },

    url() {
      return extensionBridge.getTabUrl?.(getTabId()) ?? '';
    },

    async title() {
      return await evaluateOnPage(extensionBridge, getTabId, defaultTimeout, () => document.title);
    },

    async goto(url: string, options?: { waitUntil?: string; timeout?: number }) {
      const response = await extensionBridge.sendActionCommand({
        action: 'navigate',
        tabId: getTabId(),
        timeoutMs: options?.timeout ?? defaultTimeout,
        payload: { url }
      });
      assertSuccess(response, 'navigate');
      return null;
    },

    async evaluate<T>(pageFunction: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T> {
      return await evaluateOnPage(extensionBridge, getTabId, defaultTimeout, pageFunction, ...args);
    },

    async waitForFunction(
      pageFunction: string | ((...args: unknown[]) => unknown),
      options?: { timeout?: number; polling?: number },
      ...args: unknown[]
    ) {
      const timeout = options?.timeout ?? defaultTimeout;
      const polling = options?.polling ?? 200;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await evaluateOnPage(extensionBridge, getTabId, Math.min(timeout, 5_000), pageFunction, ...args);
        if (value) return { jsonValue: async () => value };
        await delay(polling);
      }
      throw new Error(`waitForFunction timed out after ${timeout}ms`);
    },

    async screenshot(options: { path?: string; fullPage?: boolean; type?: string; encoding?: string } = {}) {
      const response = await extensionBridge.sendActionCommand({
        action: 'screenshot',
        tabId: getTabId(),
        timeoutMs: defaultTimeout,
        payload: {
          format: options.type === 'jpeg' ? 'jpeg' : 'png',
          encoding: 'base64',
          fullPage: options.fullPage === true
        }
      });
      assertSuccess(response, 'screenshot');
      const data = firstArtifactBase64(response);
      if (!data) throw new Error('screenshot returned no image data');
      if (options.path) {
        await writeFile(options.path, Buffer.from(data, 'base64'));
        return Buffer.from(data, 'base64');
      }
      if (options.encoding === 'base64') return data;
      return Buffer.from(data, 'base64');
    },

    async bringToFront() {
      // Extension commands already target the session tab; no-op is enough for detect.
    },

    keyboard: {
      async press(key: string) {
        const response = await extensionBridge.sendActionCommand({
          action: 'keyboard',
          tabId: getTabId(),
          timeoutMs: defaultTimeout,
          payload: { type: 'keyDown', key }
        });
        assertSuccess(response, 'keyboard.press');
      },
      async type(text: string) {
        const response = await extensionBridge.sendActionCommand({
          action: 'keyboard',
          tabId: getTabId(),
          timeoutMs: defaultTimeout,
          payload: { type: 'char', text }
        });
        assertSuccess(response, 'keyboard.type');
      },
      async down() {},
      async up() {}
    },

    mouse: {
      async click(x: number, y: number) {
        const response = await extensionBridge.sendActionCommand({
          action: 'mouse',
          tabId: getTabId(),
          timeoutMs: defaultTimeout,
          payload: { type: 'mousePressed', x, y, button: 'left' }
        });
        assertSuccess(response, 'mouse.click');
        await extensionBridge.sendActionCommand({
          action: 'mouse',
          tabId: getTabId(),
          timeoutMs: defaultTimeout,
          payload: { type: 'mouseReleased', x, y, button: 'left' }
        });
      },
      async move() {},
      async down() {},
      async up() {},
      async wheel() {}
    },

    mainFrame() {
      return {
        isolatedRealm() {
          return {
            evaluate: async <TArg, TResult>(
              pageFunction: (arg: TArg) => TResult | Promise<TResult>,
              arg: TArg
            ): Promise<TResult> => evaluateOnPage(extensionBridge, getTabId, defaultTimeout, pageFunction as never, arg)
          };
        },
        async evaluate<T>(pageFunction: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T> {
          return evaluateOnPage(extensionBridge, getTabId, defaultTimeout, pageFunction, ...args);
        }
      };
    },

    browser() {
      return createExtensionBackedBrowser(extensionBridge, getTabId, setTabId, defaultTimeout, page as unknown as Page);
    },

    async createCDPSession() {
      throw new Error('CDP is not available in user-browser detect mode; use extension bridge commands instead.');
    },

    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return page;
    },

    off(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
      return page;
    },

    removeListener(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
      return page;
    },

    once(event: string, handler: (...args: unknown[]) => void) {
      const wrap = (...args: unknown[]) => {
        page.off(event, wrap);
        handler(...args);
      };
      return page.on(event, wrap);
    },

    async close() {
      closed = true;
      try {
        await extensionBridge.sendActionCommand({
          action: 'close-tab',
          tabId: getTabId(),
          timeoutMs: 5_000,
          payload: {}
        });
      } catch {
        // best-effort
      }
    }
  };

  return page as unknown as Page;
}

export function createExtensionBackedBrowser(
  extensionBridge: DetectorExtensionBridge,
  getTabId: () => number,
  setTabId?: (tabId: number) => void,
  defaultTimeout = 30_000,
  primaryPage?: Page
): Browser {
  // Keep a stable primary page instance so Set/identity checks in detect remain valid.
  const mainPage = primaryPage ?? createExtensionBackedPage(extensionBridge, getTabId, setTabId);
  const extraPages: Page[] = [];

  const browser = {
    async pages() {
      // Session is scoped to detect tabs only; never enumerate the whole user browser.
      return [mainPage, ...extraPages.filter((page) => !page.isClosed())];
    },

    async newPage() {
      const response = await extensionBridge.sendActionCommand({
        action: 'open-tab',
        tabId: getTabId(),
        timeoutMs: defaultTimeout,
        payload: { url: 'about:blank' }
      });
      assertSuccess(response, 'open-tab');
      const data = (response as { data?: { tabId?: number } }).data;
      const newTabId = typeof data?.tabId === 'number' ? data.tabId : getTabId();
      const page = createExtensionBackedPage(
        extensionBridge,
        () => newTabId,
        setTabId
      );
      extraPages.push(page);
      return page;
    },

    targets() {
      return [];
    },

    process() {
      return null;
    },

    async close() {},
    disconnect() {},

    on() {
      return browser;
    },
    off() {
      return browser;
    },
    removeListener() {
      return browser;
    }
  };

  return browser as unknown as Browser;
}

async function evaluateOnPage<T>(
  extensionBridge: DetectorExtensionBridge,
  getTabId: () => number,
  timeoutMs: number,
  pageFunction: string | ((...args: unknown[]) => T | Promise<T>),
  ...args: unknown[]
): Promise<T> {
  const js = serializePageFunction(pageFunction, args);
  const response = await extensionBridge.sendActionCommand({
    action: 'execute-script',
    tabId: getTabId(),
    timeoutMs,
    payload: { js }
  });
  assertSuccess(response, 'execute-script');
  return (response as { data?: T }).data as T;
}

/**
 * Extension execute-script evaluates: page.evaluate(`(() => (${js}))()`).
 * So `js` must be an expression whose value is the evaluate result (often an IIFE).
 */
function serializePageFunction(
  pageFunction: string | ((...args: unknown[]) => unknown),
  args: unknown[]
): string {
  if (typeof pageFunction === 'string') {
    if (!args.length) return pageFunction;
    return `(${pageFunction}).apply(null, ${JSON.stringify(args)})`;
  }
  if (!args.length) return `(${pageFunction.toString()})()`;
  return `(${pageFunction.toString()}).apply(null, ${JSON.stringify(args)})`;
}

function assertSuccess(response: ExtensionCommandResponse, action: string): void {
  if (!response.success) {
    throw new Error(response.error || `${action} command failed`);
  }
}

function firstArtifactBase64(response: ExtensionCommandResponse): string | undefined {
  if (!response.success) return undefined;
  const artifacts = (response as { artifacts?: Array<{ data?: string }> }).artifacts;
  const data = artifacts?.[0]?.data;
  return typeof data === 'string' ? data : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
