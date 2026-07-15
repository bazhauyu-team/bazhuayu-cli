import prompts from 'prompts';
import type { Page } from 'puppeteer-core';
import { saveBrowserSession, sessionOriginForUrl } from '../browser-session.js';
import type { DetectOptions } from './types.js';
import type {
  LoginInterventionResult,
  ManualStartDecision,
  SuppressedRuntimeConsole
} from './page-detector-shared.js';
import {
  clearManualOverlayAction,
  hasManualOverlayHost,
  isInjectableBrowserPageUrl,
  readManualOverlaySelection,
  removeManualOverlay,
  removeManualOverlaysFromBrowser,
  runLiveSelectMenu,
  showManualOverlay,
  waitForManualOverlayAction,
  writeManualOverlayHintOnce
} from './page-detector-overlay.js';
import {
  detectPageObstructions,
  dismissPageObstructions,
  popupTypeLabel
} from './page-detector-popup.js';
import { cookieMatchesHost, delay, hostFromUrl } from './page-detector-utils.js';
import { waitForPageSettled } from './page-detector-scroll.js';
import {
  adoptBestPageAfterLogin,
  detectLoginLikePage,
  pageHasSubstantialSearchOrContent,
  type PageAdoptionHost
} from './page-detector-page-scoring.js';

export function mergeLoginIntervention(a: LoginInterventionResult, b: LoginInterventionResult): LoginInterventionResult {
  const popupDismissals = [...(a.popupDismissals ?? []), ...(b.popupDismissals ?? [])];
  return {
    handled: a.handled || b.handled,
    allowSessionSave: a.allowSessionSave && b.allowSessionSave,
    ...(popupDismissals.length ? { popupDismissals } : {}),
    ...(a.ignoreFuturePrompts || b.ignoreFuturePrompts ? { ignoreFuturePrompts: true } : {})
  };
}

export class DetectionLoginRequiredError extends Error {
  readonly code = 'LOGIN_SESSION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'DetectionLoginRequiredError';
  }
}

export async function chooseSaveSessionInteractively(runtimeConsole: SuppressedRuntimeConsole): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  try {
    const action = await runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => '是否保存当前站点登录会话，供后续采集任务自动使用？',
      readState: async () => undefined,
      choices: () => [
        { title: '保存登录会话，并把会话引用写入生成的任务文件', value: 'save' },
        { title: '不保存，仅本次检测使用', value: 'skip' }
      ]
    });
    return action === 'save';
  } finally {
    runtimeConsole.suppress();
  }
}

export async function chooseSaveSessionInBrowser(page: Page, runtimeConsole: SuppressedRuntimeConsole): Promise<boolean> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'save-session', '\n请在浏览器悬浮框中确认是否保存登录会话。\n');
  try {
    await showManualOverlay(page, {
      title: '保存登录会话',
      message: '是否保存当前站点登录会话，供后续采集任务自动使用？',
      choices: [
        { title: '保存登录会话', value: 'save-session', primary: true },
        { title: '不保存', value: 'skip-session' }
      ]
    });
    const selection = await waitForManualOverlayAction(page);
    await clearManualOverlayAction(page);
    return selection?.action === 'save-session';
  } finally {
    await removeManualOverlay(page).catch(() => undefined);
  }
}

export async function waitForManualContinue(page: Page, targetUrl: string, runtimeConsole: SuppressedRuntimeConsole): Promise<ManualStartDecision> {
  while (true) {
    runtimeConsole.restore();
    const currentUrl = page.url();
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\n已打开目标页面: ${targetUrl}\n`);
      runtimeConsole.writeStderr(`当前页面: ${currentUrl}\n`);
      runtimeConsole.writeStderr('如果网站跳转到登录页，请在浏览器中完成登录。看到要采集的数据后按 Enter 开始检测...\n');
      await runtimeConsole.question('');
      runtimeConsole.suppress();
      return { dismissPopups: false, allowSessionSave: true };
    }

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: [
        `已打开目标页面: ${targetUrl}`,
        currentUrl !== targetUrl ? `当前页面: ${currentUrl}` : '',
        '如果网站跳转到登录页，请在浏览器中完成登录；登录后没有自动返回时可重新打开目标页。'
      ].filter(Boolean).join('\n'),
      choices: [
        { title: '我已登录并看到要采集的数据，开始检测', value: 'detect-logged-in' },
        { title: '当前页面不需要登录，开始检测', value: 'detect-public' },
        { title: '重新打开目标页面', value: 'reload-target' },
        { title: '尝试关闭登录弹窗，不登录继续检测', value: 'dismiss-popups' },
        { title: '取消', value: 'cancel' }
      ],
      initial: 0
    });
    runtimeConsole.suppress();

    if (response.action === 'reload-target') {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitForPageSettled(page, 1000);
      continue;
    }
    if (response.action === 'dismiss-popups') return { dismissPopups: true, allowSessionSave: false };
    if (response.action === 'detect-public') return { dismissPopups: false, allowSessionSave: false };
    if (response.action === 'detect-logged-in') return { dismissPopups: false, allowSessionSave: true };
    throw new Error('用户取消了手动检测');
  }
}

export async function saveSessionForPage(page: Page, sessionName: string, targetUrl: string) {
  const origin = sessionOriginForUrl(targetUrl);
  const hosts = Array.from(new Set([
    new URL(origin).hostname,
    hostFromUrl(page.url())
  ].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase())));
  const cookies = await page.browserContext().cookies().catch(() => []);
  const scoped = cookies.filter((cookie) => hosts.some((host) => cookieMatchesHost(cookie.domain, host)));
  return saveBrowserSession({
    name: sessionName,
    origin,
    hosts,
    cookies: scoped
  });
}

export async function handleLoginInterventionIfNeeded(host: PageAdoptionHost, options: DetectOptions, runtimeConsole: SuppressedRuntimeConsole, reason: string): Promise<LoginInterventionResult> {
  let page = host.page;
  const obstruction = (await detectPageObstructions(page).catch(() => []))
    .find((item) => item.type === 'login' || item.type === 'captcha' || item.type === 'paywall');
  const hasSubstantialContent = await pageHasSubstantialSearchOrContent(page).catch(() => false);
  if (obstruction?.type === 'paywall' && obstruction.closeXPath && obstruction.canHide) {
    return { handled: false, allowSessionSave: true };
  }
  const obstructionText = `${obstruction?.popupText || ''} ${obstruction?.closeText || ''} ${obstruction?.reasons.join(' ') || ''}`;
  const blocksWithVerification = Boolean(obstruction && /(验证|验证码|手机号|手机号码|获取验证码|人机|captcha|verification|verify|phone|mobile)/i.test(obstructionText));
  if (!obstruction && hasSubstantialContent) {
    return { handled: false, allowSessionSave: true };
  }
  if (obstruction?.type === 'login' && hasSubstantialContent && obstruction.confidence < 0.82 && !blocksWithVerification) {
    return { handled: false, allowSessionSave: true };
  }
  const loginPage = obstruction ? undefined : await detectLoginLikePage(page).catch(() => undefined);
  if (!obstruction && !loginPage) return { handled: false, allowSessionSave: true };

  const message = loginPage
    ? `${reason}：当前页面像登录页（${loginPage.reason}）。`
    : `${reason}：检测到${popupTypeLabel(obstruction?.type)}弹窗。`;
  const interactive = shouldPromptForLoginIntervention(options);
  if (!interactive) {
    throw new DetectionLoginRequiredError(`${message} 请用 --manual 打开页面完成登录，并建议加 --save-session 保存会话后再自动检测。`);
  }

  runtimeConsole.restore();
  try {
    const searchTriggeredLogin = /搜索|重放/.test(reason);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\n${message}\n请在打开的浏览器中完成登录/验证，看到可搜索或可采集页面后按 Enter 继续...\n`);
      await runtimeConsole.question('');
      runtimeConsole.suppress();
      await adoptBestPageAfterLogin(host, options).catch(() => undefined);
      page = host.page;
      await waitForPageSettled(page, options.waitMs);
      return { handled: true, allowSessionSave: true };
    }
    const initialAction: 'continue' | 'continue-without-login' = searchTriggeredLogin || !(obstruction?.type === 'login' && hasSubstantialContent)
      ? 'continue'
      : 'continue-without-login';
    const action = await chooseLoginInterventionInBrowser(host, message, initialAction, runtimeConsole)
      .catch(async () => {
        const response = await prompts({
          type: 'select',
          name: 'action',
          message: [
            message,
            '请在浏览器中完成登录/验证，登录后回到这里继续。'
          ].join('\n'),
          choices: [
            { title: '当前不需要登录，继续检测', value: 'continue-without-login' },
            { title: '我已完成登录/验证，继续检测', value: 'continue' },
            { title: '取消', value: 'cancel' }
          ],
          initial: initialAction === 'continue' ? 1 : 0
        });
        return response.action || 'cancel';
      });
    if (action === 'cancel' || !action) throw new Error('用户取消了登录后的检测');
    if (action === 'continue') {
      await adoptBestPageAfterLogin(host, options).catch(() => undefined);
      page = host.page;
    }
    const popupDismissals = action === 'continue-without-login' && obstruction?.type === 'login'
      ? await dismissPageObstructions(page, { includeLogin: true }).catch(() => [])
      : [];
    if (popupDismissals.length) {
      await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    await waitForPageSettled(page, options.waitMs);
    return {
      handled: action === 'continue',
      allowSessionSave: action === 'continue',
      ...(popupDismissals.length ? { popupDismissals } : {}),
      ...(action === 'continue-without-login' ? { ignoreFuturePrompts: true } : {})
    };
  } finally {
    await removeManualOverlaysFromBrowser(host.browser()).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

export function shouldPromptForLoginIntervention(options: DetectOptions): boolean {
  return options.manual || options.interactive;
}

export async function chooseLoginInterventionInBrowser(
  host: PageAdoptionHost,
  message: string,
  initialAction: 'continue' | 'continue-without-login',
  runtimeConsole: SuppressedRuntimeConsole
): Promise<'continue' | 'continue-without-login' | 'cancel'> {
  writeManualOverlayHintOnce(runtimeConsole, host.page, 'login', '\n请在浏览器悬浮框中确认登录/验证状态。\n');
  writeManualOverlayHintOnce(
    runtimeConsole,
    host.page,
    'login-keyboard',
    '提示: 登录后页面刷新若悬浮框消失，CLI 会自动重新注入；也可在终端按 c=已登录继续 / n=不需要登录 / q=取消\n'
  );
  const overlayOptions = {
    title: '登录/验证确认',
    message: [
      message,
      initialAction === 'continue-without-login'
        ? '如果这只是普通登录弹窗，不影响当前页面内容，可以直接继续；本次检测后续将不再因同类弹窗打断。'
        : '点击继续后会重新选择最合适的页面并检查页面内容。',
      '登录跳转后若悬浮框暂时消失，请稍等自动恢复；也可直接回终端按 c / n / q。'
    ].join('\n'),
    choices: [
      { title: '已登录/验证，继续', value: 'continue', primary: initialAction === 'continue' },
      { title: '不需要登录，继续', value: 'continue-without-login', primary: initialAction === 'continue-without-login' },
      { title: '取消检测', value: 'cancel' }
    ]
  } satisfies Parameters<typeof showManualOverlay>[1];
  const browser = host.browser();
  /** Tracks last URL where overlay host was confirmed present. */
  const injectedUrls = new WeakMap<Page, string>();
  const startedAt = Date.now();
  let everInjected = false;
  let lastMissingHostHintAt = 0;
  let keyboardAction: 'continue' | 'continue-without-login' | 'cancel' | undefined;
  const stdin = process.stdin;
  const canUseKeyboard = Boolean(stdin.isTTY);
  const wasRaw = canUseKeyboard ? stdin.isRaw : false;
  const onStdinData = (chunk: Buffer | string) => {
    const value = String(chunk).toLowerCase();
    if (value === 'c' || value === '\r' || value === '\n') {
      keyboardAction = 'continue';
      return;
    }
    if (value === 'n') {
      keyboardAction = 'continue-without-login';
      return;
    }
    if (value === 'q' || value === '\u0003') {
      keyboardAction = 'cancel';
    }
  };
  if (canUseKeyboard) {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onStdinData);
  }
  try {
    while (true) {
      if (keyboardAction) return keyboardAction;

      let injectedAny = false;
      let hostPresentAny = false;
      const pages = browser
        ? (await browser.pages().catch(() => [host.page])).filter((page) => !page.isClosed())
        : [host.page].filter((page) => !page.isClosed());
      for (const candidatePage of pages) {
        if (candidatePage.isClosed()) continue;
        const selection = await readManualOverlaySelection(candidatePage).catch(() => undefined);
        if (selection?.action) {
          await clearManualOverlayAction(candidatePage).catch(() => undefined);
          if (candidatePage !== host.page && !candidatePage.isClosed()) await host.usePage(candidatePage).catch(() => undefined);
          if (selection.action === 'continue' || selection.action === 'continue-without-login') return selection.action;
          return 'cancel';
        }

        const currentUrl = candidatePage.url();
        if (!isInjectableBrowserPageUrl(currentUrl)) continue;

        // Prefer live DOM host presence over URL/window state. Login redirects and
        // SPA replacements wipe the overlay node even when the URL string is stable.
        const hostPresent = await hasManualOverlayHost(candidatePage);
        if (hostPresent) {
          hostPresentAny = true;
          injectedUrls.set(candidatePage, currentUrl);
          everInjected = true;
          continue;
        }

        const injected = await showManualOverlay(candidatePage, overlayOptions)
          .then(async () => hasManualOverlayHost(candidatePage))
          .catch(() => false);
        if (injected) {
          injectedUrls.set(candidatePage, currentUrl);
          injectedAny = true;
          hostPresentAny = true;
          everInjected = true;
        } else {
          injectedUrls.delete(candidatePage);
        }
      }

      if (!hostPresentAny && everInjected && Date.now() - lastMissingHostHintAt > 4000) {
        runtimeConsole.writeStderr('\n登录后页面已更新，正在重新注入悬浮框… 也可在终端按 c=已登录继续 / n=不需要登录 / q=取消\n');
        lastMissingHostHintAt = Date.now();
      }

      if (!everInjected && !injectedAny && Date.now() - startedAt > 2500) {
        throw new Error('manual login overlay injection failed');
      }
      await delay(150);
    }
  } finally {
    if (canUseKeyboard) {
      stdin.off('data', onStdinData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    }
  }
}

export function shouldPromptForLoginInterventionForTesting(options: DetectOptions): boolean {
  return shouldPromptForLoginIntervention(options);
}
