import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { BridgeHub } from '../bridge-hub.js';
import {
  startBootstrapPageServer,
  type BootstrapPageServer
} from '../bootstrap-page.js';
import type { ChromeResolveStatus } from '../chrome-progress.js';
import {
  prepareUserBrowserForRun,
  type UserBrowserLaunchPlan
} from '../user-browser.js';
import { hasLinuxDisplayEnvironment, startVirtualDisplayIfNeeded, type VirtualDisplayHandle } from '../virtual-display.js';
import { createExtensionBackedBrowser, createExtensionBackedPage } from './extension-backed-page.js';
import type { DetectOptions } from './types.js';
import type {
  DetectorExtensionBridge,
  ExtensionCommandResponse,
  ExtensionDetectorHostStartHooks
} from './page-detector-shared.js';
import { defaultUserAgent, delay, safeHost } from './page-detector-utils.js';

const require = createRequire(import.meta.url);
const puppeteer = require('rebrowser-puppeteer-core') as typeof import('puppeteer-core');
const EngineModule = require('@octopus/browser-runtime') as {
  resolveChrome: (options?: { onStatus?: (status: ChromeResolveStatus) => void }) => Promise<{ executablePath: string }>;
  ChromeProcess: new () => ChromeProcessLike;
};

const activeIndependentBrowserProcesses = new Set<ChildProcess>();

interface ChromeProcessLike {
  launch(options: {
    executablePath: string;
    userDataDir?: string;
    profileDirectory?: string;
    startupUrls?: string[];
    headless?: boolean;
    debuggerPort?: number;
    localBrowserMode?: boolean;
  }): Promise<ChildProcess>;
  process?: ChildProcess;
  canCloseLaunchedProcess(): boolean;
  close(): void;
}

interface DetectorHostModeState {
  mode: 'independent' | 'user';
  chromeProcess?: ChromeProcessLike;
  sessionWindowId?: number;
  connectedBrowser?: Browser;
  /** When true, page/browser are extension-backed shims (no puppeteer CDP). */
  extensionBacked?: boolean;
  /** Shared mutable tab id for extension-backed pages (host + page closures). */
  tabRef?: { tabId: number };
  /** Local friendly splash page used for extension session registration. */
  bootstrapPage?: BootstrapPageServer;
}

export class ExtensionDetectorHost {
  // Constructor is module-private by convention; use ExtensionDetectorHost.start().
  // Kept non-private so same-file factory helpers can construct instances under TS private rules.
  constructor(
    private readonly browserInstance: Browser,
    private readonly runtimeExtensionPath: string | undefined,
    private readonly bridgeHub: BridgeHub,
    private readonly extensionBridge: DetectorExtensionBridge,
    public page: Page,
    private tabId: number,
    private readonly virtualDisplay: VirtualDisplayHandle,
    private readonly modeState: DetectorHostModeState
  ) {
    if (modeState.tabRef) modeState.tabRef.tabId = tabId;
  }

  static async start(options: DetectOptions, hooks: ExtensionDetectorHostStartHooks = {}): Promise<ExtensionDetectorHost> {
    assertDetectDisplayAvailable(options);
    const browserMode = options.browserMode ?? 'independent';
    if (browserMode === 'user') {
      return startUserBrowserDetectorHost(options, hooks);
    }
    return startIndependentDetectorHost(options, hooks);
  }

  private setTabId(tabId: number): void {
    this.tabId = tabId;
    if (this.modeState.tabRef) this.modeState.tabRef.tabId = tabId;
  }

  async refreshTabId(): Promise<number> {
    const tabId = await waitForTabId(this.extensionBridge, this.page, 10_000);
    this.setTabId(tabId);
    return tabId;
  }

  async usePage(page: Page): Promise<void> {
    this.page = page;
    await this.refreshTabId();
    const windowId = this.extensionBridge.getTabWindowId?.(this.tabId)
      ?? this.extensionBridge.getBootstrapWindowId?.();
    if (typeof windowId === 'number') {
      this.modeState.sessionWindowId = windowId;
    }
  }

  browser(): Browser | undefined {
    if (this.modeState.mode !== 'user') return this.browserInstance;
    if (this.modeState.extensionBacked) {
      const tabRef = this.modeState.tabRef ?? { tabId: this.tabId };
      this.modeState.tabRef = tabRef;
      return createExtensionBackedBrowser(
        this.extensionBridge,
        () => tabRef.tabId,
        (tabId) => {
          this.setTabId(tabId);
        },
        30_000,
        this.page
      );
    }
    return this.browserInstance;
  }

  async command(command: Record<string, unknown>): Promise<ExtensionCommandResponse> {
    const response = await this.extensionBridge.sendActionCommand({
      ...command,
      tabId: await this.refreshTabId()
    });
    if (!response.success) {
      throw new Error(response.error || `${command.action} command failed`);
    }
    return response;
  }

  async close(): Promise<void> {
    if (this.modeState.mode === 'user') {
      await closeUserBrowserDetectorHost(this.extensionBridge, this.tabId, this.modeState);
      this.bridgeHub.close();
      await this.modeState.bootstrapPage?.close().catch(() => undefined);
      await this.virtualDisplay.close();
      return;
    }

    const browserProcess = this.browserInstance.process?.() as ChildProcess | null | undefined;
    silenceBrowserProcess(browserProcess);
    try {
      await this.browserInstance.close();
    } catch {
      // best-effort cleanup
    }
    await terminateBrowserProcess(browserProcess);
    if (browserProcess) activeIndependentBrowserProcesses.delete(browserProcess);
    this.bridgeHub.close();
    if (this.runtimeExtensionPath) await rm(this.runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
    await this.modeState.bootstrapPage?.close().catch(() => undefined);
    await this.virtualDisplay.close();
  }
}

async function startIndependentDetectorHost(
  options: DetectOptions,
  hooks: ExtensionDetectorHostStartHooks
): Promise<ExtensionDetectorHost> {
  const virtualDisplay = await startVirtualDisplayForDetection(options);
  const runId = `detect_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const bridgeHub = new BridgeHub();
  const extensionBridge = await bridgeHub.createSessionBridge(runId) as DetectorExtensionBridge;
  let browser: Browser | undefined;
  let runtimeExtensionPath: string | undefined;
  let bootstrapPage: BootstrapPageServer | undefined;

  try {
    const chromePath = options.chromePath ?? (await EngineModule.resolveChrome({ onStatus: options.onChromeStatus })).executablePath;
    runtimeExtensionPath = await prepareDetectorRuntimeExtension(runId, extensionBridge);
    bootstrapPage = await startBootstrapPageServer({ mode: 'detect', label: options.url });
    browser = await launchDetectorBrowser(chromePath, runtimeExtensionPath);
    trackDetectorBrowserProcess(browser.process?.() as ChildProcess | null | undefined);
    // browser-runtime extension reads sessionId/wsUrl from the page URL, not runtime-config.json.
    // Open a friendly local bootstrap page first so the extension can register before target navigation.
    const page = await openDetectorBootstrapPage(
      browser,
      extensionBridge.runtimeConfig,
      Math.min(options.timeoutMs, 30_000),
      hooks.onTargetPageReady,
      bootstrapPage.origin
    );
    await bridgeHub.waitForSessionConnected(runId, Math.min(options.timeoutMs, 30_000));
    await navigateDetectorTarget(page, options.url, options.timeoutMs);
    const tabId = await waitForTabId(extensionBridge, page, options.timeoutMs);
    await readyCheck(extensionBridge, tabId, Math.min(options.timeoutMs, 15_000)).catch(() => undefined);
    return new ExtensionDetectorHost(
      browser,
      runtimeExtensionPath,
      bridgeHub,
      extensionBridge,
      page,
      tabId,
      virtualDisplay,
      { mode: 'independent', bootstrapPage }
    );
  } catch (error) {
    const browserProcess = browser?.process?.() as ChildProcess | null | undefined;
    silenceBrowserProcess(browserProcess);
    await browser?.close().catch(() => undefined);
    await terminateBrowserProcess(browserProcess);
    if (browserProcess) activeIndependentBrowserProcesses.delete(browserProcess);
    if (runtimeExtensionPath) await rm(runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
    await bootstrapPage?.close().catch(() => undefined);
    bridgeHub.close();
    await virtualDisplay.close();
    throw error;
  }
}

async function startUserBrowserDetectorHost(
  options: DetectOptions,
  hooks: ExtensionDetectorHostStartHooks
): Promise<ExtensionDetectorHost> {
  // User browser mode reuses the real desktop profile + permanently installed extension.
  // Matches browser-runtime localBrowserMode: open a new session window; do NOT require
  // closing an already-running Chrome, and do NOT depend on --remote-debugging-port.
  const virtualDisplay: VirtualDisplayHandle = {
    enabled: false,
    async close() {}
  };
  const runId = `detect_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const bridgeHub = new BridgeHub();
  const extensionBridge = await bridgeHub.createSessionBridge(runId) as DetectorExtensionBridge;
  let chromeProcess: ChromeProcessLike | undefined;
  let bootstrapPage: BootstrapPageServer | undefined;
  const tabRef = { tabId: -1 };

  try {
    const launchPlan = await prepareUserBrowserForRun({
      browserId: options.browserId,
      profileName: options.browserProfile,
      chromePath: options.chromePath,
      forceClose: options.forceCloseBrowser
    });
    options.onChromeStatus?.({ state: 'resolved', progress: 100 });

    bootstrapPage = await startBootstrapPageServer({ mode: 'detect', label: options.url });
    const bootstrapUrl = buildDetectorBootstrapUrl(extensionBridge.runtimeConfig, bootstrapPage.origin);
    chromeProcess = new EngineModule.ChromeProcess();
    await chromeProcess.launch({
      executablePath: launchPlan.chromePath,
      userDataDir: launchPlan.userDataDirectory,
      profileDirectory: launchPlan.profileName,
      startupUrls: [bootstrapUrl],
      headless: false,
      localBrowserMode: true
    });

    await bridgeHub.waitForSessionConnected(runId, Math.min(options.timeoutMs, 45_000));
    tabRef.tabId = await waitForUserBrowserTabId(extensionBridge, Math.min(options.timeoutMs, 30_000));
    const page = createExtensionBackedPage(
      extensionBridge,
      () => tabRef.tabId,
      (nextTabId) => {
        tabRef.tabId = nextTabId;
      }
    );
    hooks.onTargetPageReady?.(page);
    await navigateDetectorTarget(page, options.url, options.timeoutMs);
    // After navigation the same tab should still be registered; refresh if URL mapping changed.
    tabRef.tabId = await waitForTabId(extensionBridge, page, Math.min(options.timeoutMs, 15_000)).catch(() => tabRef.tabId);
    await readyCheck(extensionBridge, tabRef.tabId, Math.min(options.timeoutMs, 15_000)).catch(() => undefined);
    const sessionWindowId = extensionBridge.getTabWindowId?.(tabRef.tabId)
      ?? extensionBridge.getBootstrapWindowId?.();
    const browser = createExtensionBackedBrowser(
      extensionBridge,
      () => tabRef.tabId,
      (nextTabId) => {
        tabRef.tabId = nextTabId;
      },
      30_000,
      page
    );

    return new ExtensionDetectorHost(
      browser,
      undefined,
      bridgeHub,
      extensionBridge,
      page,
      tabRef.tabId,
      virtualDisplay,
      {
        mode: 'user',
        chromeProcess,
        sessionWindowId: typeof sessionWindowId === 'number' ? sessionWindowId : undefined,
        extensionBacked: true,
        tabRef,
        bootstrapPage
      }
    );
  } catch (error) {
    // Only kill a process we actually own (Chrome was not already running).
    if (chromeProcess?.canCloseLaunchedProcess()) {
      chromeProcess.close();
    }
    await bootstrapPage?.close().catch(() => undefined);
    bridgeHub.close();
    await virtualDisplay.close();
    throw error;
  }
}

async function navigateDetectorTarget(page: Page, url: string, timeoutMs: number): Promise<void> {
  const initialUrl = page.url();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return;
  } catch (error) {
    if (!isNavigationTimeout(error)) throw error;
    await delay(250);
    const currentUrl = page.url();
    const usable = /^https?:\/\//i.test(currentUrl)
      && currentUrl !== initialUrl
      && await page.evaluate(() => {
        const body = document.body;
        if (!body) return false;
        const textLength = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim().length;
        const elementCount = body.querySelectorAll('*').length;
        const linkCount = body.querySelectorAll('a[href]').length;
        const imageCount = body.querySelectorAll('img[src]').length;
        return textLength >= 80 || elementCount >= 20 || linkCount >= 2 || imageCount >= 3;
      }).catch(() => false);
    if (!usable) throw error;
  }
}

function isNavigationTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || /navigation(?:\s+timeout|[^.]*timed?\s*out)|Navigation timeout of \d+ ms exceeded/i.test(error.message);
}

export async function navigateDetectorTargetForTesting(page: Page, url: string, timeoutMs: number): Promise<void> {
  return navigateDetectorTarget(page, url, timeoutMs);
}

async function closeUserBrowserDetectorHost(
  extensionBridge: DetectorExtensionBridge,
  tabId: number,
  modeState: DetectorHostModeState
): Promise<void> {
  let sessionWindowClosed = false;
  try {
    const response = await extensionBridge.sendActionCommand({
      action: 'close-session-window',
      tabId,
      timeoutMs: 5_000,
      payload: {}
    });
    sessionWindowClosed = Boolean(response.success);
  } catch {
    // best-effort; may fall back to process close below
  }

  // Prefer leaving the user browser running after closing only the session window.
  // canCloseLaunchedProcess is typically false when Chrome was already running (handoff).
  if (!sessionWindowClosed && modeState.chromeProcess?.canCloseLaunchedProcess()) {
    modeState.chromeProcess.close();
  }
}

async function waitForUserBrowserTabId(
  extensionBridge: DetectorExtensionBridge,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bootstrapTabId = extensionBridge.getBootstrapTabId?.();
    if (typeof bootstrapTabId === 'number') return bootstrapTabId;
    const anyTabId = extensionBridge.getAnyTabId?.();
    if (typeof anyTabId === 'number') return anyTabId;
    await delay(200);
  }
  throw new Error(
    'User browser extension did not register a session tab. '
    + 'Confirm the Octopus extension is enabled in Chrome (chrome://extensions/), then retry.'
  );
}

export function assertDetectDisplayAvailable(options: DetectOptions): void {
  if (options.browserMode === 'user') {
    if (process.platform === 'linux') {
      throw new Error('User browser detect mode is not supported on Linux. Use the default independent Chrome mode instead.');
    }
    return;
  }
  if (process.platform !== 'linux' || (!options.manual && !options.interactive)) return;
  if (hasLinuxDisplayEnvironment()) return;
  throw new Error('Linux 手动检测需要可见浏览器环境，但当前没有 X server 或 WAYLAND_DISPLAY。请在桌面会话中运行，或用 xvfb-run/VNC 提供可见显示；非手动检测会自动使用 Xvfb。');
}

export async function startVirtualDisplayForDetection(options: DetectOptions): Promise<VirtualDisplayHandle> {
  if (options.browserMode === 'user' || options.manual || options.interactive) {
    return {
      enabled: false,
      async close() {}
    };
  }
  return startVirtualDisplayIfNeeded();
}

export function buildDetectorBootstrapUrl(
  runtimeConfig: { sessionId: string; wsUrl: string },
  origin: string
): string {
  const url = new URL(origin);
  url.searchParams.set('sessionId', runtimeConfig.sessionId);
  url.searchParams.set('wsUrl', runtimeConfig.wsUrl);
  return url.toString();
}

export async function prepareDetectorRuntimeExtension(runId: string, extensionBridge: DetectorExtensionBridge): Promise<string> {
  const runtimeRoot = dirname(require.resolve('@octopus/browser-runtime'));
  const templatePath = join(runtimeRoot, 'extension');
  const runtimePath = join(tmpdir(), 'octopus-browser-runtime-extension', `${runId}-${Date.now()}`);
  await mkdir(dirname(runtimePath), { recursive: true });
  await cp(templatePath, runtimePath, { recursive: true });
  // Kept for diagnostics; browser-runtime extension registers via page URL query params.
  await writeFile(join(runtimePath, 'runtime-config.json'), `${JSON.stringify(extensionBridge.runtimeConfig, null, 2)}\n`, 'utf8');
  return runtimePath;
}

export async function launchDetectorBrowser(chromePath: string, runtimeExtensionPath: string): Promise<Browser> {
  return puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    defaultViewport: null,
    dumpio: false,
    ignoreDefaultArgs: ['--enable-automation', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationControlled',
      '--allow-running-insecure-content',
      '--disable-features=IsolateOrigins,HttpsFirstBalancedModeAutoEnable,NetworkService,Translate,AcceptCHFrame,MediaRouter,OptimizationHints,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes,HttpsUpgrades',
      '--enable-features=SharedArrayBuffer,TabFreeze,TabDiscarding',
      '--prerender-from-omnibox=disabled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--silent-debugger-extension-api',
      '--window-size=1920,1200',
      '--js-flags=--expose-gc',
      '--disk-cache-size=524288000',
      '--aggressive-cache-discard',
      // Avoid macOS Keychain prompts for Chrome for Testing automation profiles.
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-agent=${defaultUserAgent()}`,
      `--load-extension=${runtimeExtensionPath}`,
      `--disable-extensions-except=${runtimeExtensionPath}`,
      '--no-first-run',
      '--disable-default-apps'
    ]
  }) as Promise<Browser>;
}

export function trackDetectorBrowserProcess(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  activeIndependentBrowserProcesses.add(child);
  child.once('exit', () => activeIndependentBrowserProcesses.delete(child));
}

export function terminateActiveDetectorBrowserProcesses(): void {
  for (const child of activeIndependentBrowserProcesses) {
    activeIndependentBrowserProcesses.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      // Best-effort synchronous cleanup during process termination.
    }
  }
}

export function silenceBrowserProcess(child: ChildProcess | null | undefined): void {
  child?.stdout?.unpipe(process.stdout);
  child?.stderr?.unpipe(process.stderr);
  child?.stdout?.removeAllListeners('data');
  child?.stderr?.removeAllListeners('data');
}

export async function waitForBrowserProcessExit(child: ChildProcess | null | undefined, timeoutMs: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false)
  ]);
}

export async function terminateBrowserProcess(
  child: ChildProcess | null | undefined,
  gracefulTimeoutMs = 1500,
  terminateTimeoutMs = 1000
): Promise<void> {
  if (!child || await waitForBrowserProcessExit(child, gracefulTimeoutMs)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Continue to the hard-kill fallback below.
  }
  if (await waitForBrowserProcessExit(child, terminateTimeoutMs)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Best-effort cleanup; the process may have exited between checks.
  }
  await waitForBrowserProcessExit(child, 500);
}

export async function waitForDetectorPage(browser: Browser, url: string, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const targetHost = safeHost(url);
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const exact = pages.find((page) => page.url() === url);
    if (exact) return exact;
    const sameHost = pages.find((page) => safeHost(page.url()) === targetHost && !/^about:blank/i.test(page.url()));
    if (sameHost) return sameHost;
    const nonBlank = pages.find((page) => !/^about:blank/i.test(page.url()));
    if (nonBlank && !targetHost) return nonBlank;
    await delay(200);
  }
  const pages = await browser.pages();
  return pages[0] ?? await browser.newPage();
}

export async function openDetectorBootstrapPage(
  browser: Browser,
  runtimeConfig: { sessionId: string; wsUrl: string },
  timeoutMs: number,
  onPageReady?: (page: Page) => void,
  origin?: string
): Promise<Page> {
  const pages = await browser.pages();
  const page = pages[0] ?? await browser.newPage();
  onPageReady?.(page);
  if (!origin) {
    throw new Error('Detector bootstrap origin is required');
  }
  const bootstrapUrl = buildDetectorBootstrapUrl(runtimeConfig, origin);
  await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return page;
}

export async function waitForTabId(extensionBridge: DetectorExtensionBridge, page: Page, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = [page.url(), page.url().replace(/\/$/, '')];
    for (const url of candidates) {
      const tabId = extensionBridge.resolveTabId(url);
      if (tabId !== undefined) return tabId;
    }
    const bootstrapTabId = extensionBridge.getBootstrapTabId?.();
    if (typeof bootstrapTabId === 'number') return bootstrapTabId;
    const anyTabId = extensionBridge.getAnyTabId?.();
    if (typeof anyTabId === 'number') return anyTabId;
    await delay(200);
  }
  throw new Error(`extension tab was not registered for ${page.url()}`);
}

export async function readyCheck(extensionBridge: DetectorExtensionBridge, tabId: number, timeoutMs: number): Promise<void> {
  const response = await extensionBridge.sendActionCommand({
    action: 'ready-check',
    tabId,
    frame: { isIframe: false },
    timeoutMs,
    payload: { mode: 'base-load' }
  });
  if (!response.success) throw new Error(response.error);
}

// Keep type-only export surface stable for callers that may want launch plan diagnostics later.
export type { UserBrowserLaunchPlan };
