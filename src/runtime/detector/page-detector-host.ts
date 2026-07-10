import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { BridgeHub } from '../bridge-hub.js';
import type { ChromeResolveStatus } from '../chrome-progress.js';
import { hasLinuxDisplayEnvironment, startVirtualDisplayIfNeeded, type VirtualDisplayHandle } from '../virtual-display.js';
import type { DetectOptions } from './types.js';
import type {
  DetectorExtensionBridge,
  ExtensionCommandResponse,
  ExtensionDetectorHostStartHooks
} from './page-detector-shared.js';
import { defaultUserAgent, delay, safeHost } from './page-detector-utils.js';

const require = createRequire(import.meta.url);
const puppeteer = require('rebrowser-puppeteer-core') as typeof import('puppeteer-core');
const EngineModule = require('@octopus/engine') as {
  resolveChrome: (options?: { onStatus?: (status: ChromeResolveStatus) => void }) => Promise<{ executablePath: string }>;
};

const DETECTOR_PARKING_URL = [
  'data:text/html,',
  encodeURIComponent([
    '<!doctype html>',
    '<html><head><title>Octopus Detector</title></head>',
    '<body style="margin:0">',
    '<div style="height:200000px"></div>',
    '</body></html>'
  ].join(''))
].join('');

export class ExtensionDetectorHost {
  private constructor(
    private readonly browserInstance: Browser,
    private readonly runtimeExtensionPath: string | undefined,
    private readonly bridgeHub: BridgeHub,
    private readonly extensionBridge: DetectorExtensionBridge,
    public page: Page,
    private tabId: number,
    private readonly virtualDisplay: VirtualDisplayHandle
  ) {}

  static async start(options: DetectOptions, hooks: ExtensionDetectorHostStartHooks = {}): Promise<ExtensionDetectorHost> {
    assertDetectDisplayAvailable(options);
    const virtualDisplay = await startVirtualDisplayForDetection(options);
    const runId = `detect_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const bridgeHub = new BridgeHub();
    const extensionBridge = await bridgeHub.createSessionBridge(runId) as DetectorExtensionBridge;
    let browser: Browser | undefined;
    let runtimeExtensionPath: string | undefined;

    try {
      const chromePath = options.chromePath ?? (await EngineModule.resolveChrome({ onStatus: options.onChromeStatus })).executablePath;
      runtimeExtensionPath = await prepareDetectorRuntimeExtension(runId, extensionBridge);
      browser = await launchDetectorBrowser(chromePath, runtimeExtensionPath);
      await bridgeHub.waitForSessionConnected(runId, Math.min(options.timeoutMs, 30_000));
      const page = await openDetectorTargetPage(browser, options.url, options.timeoutMs, hooks.onTargetPageReady);
      const tabId = await waitForTabId(extensionBridge, page, options.timeoutMs);
      await readyCheck(extensionBridge, tabId, Math.min(options.timeoutMs, 15_000)).catch(() => undefined);
      return new ExtensionDetectorHost(browser, runtimeExtensionPath, bridgeHub, extensionBridge, page, tabId, virtualDisplay);
    } catch (error) {
      await browser?.close().catch(() => undefined);
      if (runtimeExtensionPath) await rm(runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
      bridgeHub.close();
      await virtualDisplay.close();
      throw error;
    }
  }

  async refreshTabId(): Promise<number> {
    this.tabId = await waitForTabId(this.extensionBridge, this.page, 10_000);
    return this.tabId;
  }

  async usePage(page: Page): Promise<void> {
    this.page = page;
    await this.refreshTabId();
  }

  browser(): Browser | undefined {
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
    const browserProcess = this.browserInstance.process?.() as ChildProcess | null | undefined;
    silenceBrowserProcess(browserProcess);
    try {
      await this.browserInstance.close();
    } catch {
      // best-effort cleanup
    }
    await waitForBrowserProcessExit(browserProcess, 1500);
    this.bridgeHub.close();
    if (this.runtimeExtensionPath) await rm(this.runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
    await this.virtualDisplay.close();
  }
}

export function assertDetectDisplayAvailable(options: DetectOptions): void {
  if (process.platform !== 'linux' || (!options.manual && !options.interactive)) return;
  if (hasLinuxDisplayEnvironment()) return;
  throw new Error('Linux 手动检测需要可见浏览器环境，但当前没有 X server 或 WAYLAND_DISPLAY。请在桌面会话中运行，或用 xvfb-run/VNC 提供可见显示；非手动检测会自动使用 Xvfb。');
}

export async function startVirtualDisplayForDetection(options: DetectOptions): Promise<VirtualDisplayHandle> {
  if (options.manual || options.interactive) {
    return {
      enabled: false,
      async close() {}
    };
  }
  return startVirtualDisplayIfNeeded();
}

export async function prepareDetectorRuntimeExtension(runId: string, extensionBridge: DetectorExtensionBridge): Promise<string> {
  const engineDist = dirname(require.resolve('@octopus/engine'));
  const templatePath = join(engineDist, 'extension');
  const runtimePath = join(tmpdir(), 'octopus-engine-extension', `${runId}-${Date.now()}`);
  await mkdir(dirname(runtimePath), { recursive: true });
  await cp(templatePath, runtimePath, { recursive: true });
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
      `--user-agent=${defaultUserAgent()}`,
      `--load-extension=${runtimeExtensionPath}`,
      `--disable-extensions-except=${runtimeExtensionPath}`,
      '--no-first-run',
      '--disable-default-apps'
    ]
  }) as Promise<Browser>;
}

export function silenceBrowserProcess(child: ChildProcess | null | undefined): void {
  child?.stdout?.unpipe(process.stdout);
  child?.stderr?.unpipe(process.stderr);
  child?.stdout?.removeAllListeners('data');
  child?.stderr?.removeAllListeners('data');
}

export async function waitForBrowserProcessExit(child: ChildProcess | null | undefined, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs)
  ]);
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

export async function openDetectorTargetPage(browser: Browser, url: string, timeoutMs: number, onPageReady?: (page: Page) => void): Promise<Page> {
  const page = await waitForDetectorPage(browser, DETECTOR_PARKING_URL, Math.min(timeoutMs, 5000));
  onPageReady?.(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
