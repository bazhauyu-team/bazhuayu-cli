import type { Page } from 'puppeteer-core';

export type PageAccessIssueKind = 'access_denied' | 'security_challenge' | 'service_error';

export interface PageAccessIssue {
  kind: PageAccessIssueKind;
  title: string;
  snippet: string;
  reasons: string[];
}

interface PageAccessSnapshot {
  title: string;
  bodyText: string;
  mainTextLength: number;
  articleTextLength: number;
  paragraphCount: number;
  linkCount: number;
  hasChallengeElement: boolean;
}

export class DetectionPageAccessError extends Error {
  readonly code = 'DETECT_PAGE_BLOCKED';

  constructor(readonly details: PageAccessIssue) {
    const label = details.kind === 'security_challenge'
      ? '安全验证页'
      : details.kind === 'service_error'
        ? '服务错误页'
        : '访问受限页';
    const evidence = details.title || details.snippet;
    super(`目标页面当前是${label}${evidence ? `（${evidence}）` : ''}，不能据此生成采集任务。请先解决访问限制或更换可直接访问的 URL。`);
    this.name = 'DetectionPageAccessError';
  }
}

export async function detectPageAccessIssue(page: Page): Promise<PageAccessIssue | undefined> {
  const snapshot = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const textLength = (element: Element | null) => normalize(element?.textContent).length;
    const challengeSelectors = [
      'iframe[src*="captcha" i]',
      'iframe[title*="challenge" i]',
      'input[name*="captcha" i]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      '[id*="challenge" i]',
      '[class*="challenge" i]',
      '[data-sitekey]'
    ];
    const body = document.body || document.documentElement;
    return {
      title: normalize(document.title),
      bodyText: normalize((body as HTMLElement | null)?.innerText || body?.textContent).slice(0, 8_000),
      mainTextLength: textLength(document.querySelector('main,[role="main"]')),
      articleTextLength: textLength(document.querySelector('article')),
      paragraphCount: document.querySelectorAll('p').length,
      linkCount: document.querySelectorAll('a[href]').length,
      hasChallengeElement: Boolean(document.querySelector(challengeSelectors.join(',')))
    } satisfies PageAccessSnapshot;
  });
  return classifyPageAccessSnapshot(snapshot);
}

export function classifyPageAccessSnapshot(snapshot: PageAccessSnapshot): PageAccessIssue | undefined {
  const title = normalizeText(snapshot.title);
  const body = normalizeText(snapshot.bodyText);
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const substantialContent = snapshot.mainTextLength >= 800
    || snapshot.articleTextLength >= 600
    || snapshot.paragraphCount >= 5 && body.length >= 1_200
    || snapshot.linkCount >= 12 && body.length >= 1_500;

  const exactAccessTitle = /^(?:(?:error\s*)?(?:403|429|451)\s*(?:[-:|]\s*)?(?:forbidden|access denied|too many requests|unavailable for legal reasons|geo[- ]?block(?:ed)?)|access denied|request blocked|forbidden|geo[- ]?block(?:ed)?|region unavailable)[.!\s]*$/i;
  const exactChallengeTitle = /^(?:human verification|security check|robot check|verify (?:that )?you are (?:a )?human|are you (?:a )?robot|just a moment)(?:[.!…\s]*)$/i;
  const exactClientErrorTitle = /^(?:(?:error\s*)?(?:400|404|405|406|408|410|412|415)(?:\s*(?:[-:|]\s*)?(?:bad request|not found|method not allowed|not allowed|request timeout|gone|precondition failed|unsupported media type))?)[.!\s]*$/i;
  const exactServiceTitle = /^(?:(?:error\s*)?(?:500|502|503|504)\s*(?:[-:|]\s*)?(?:internal server error|bad gateway|service unavailable|gateway timeout)|service unavailable|bad gateway|gateway timeout)[.!\s]*$/i;
  const accessBody = /(?:^|\b)(?:403\s*(?:forbidden|[-:]\s*(?:access denied|geo[- ]?block(?:ed)?))|access (?:to (?:this|the) (?:page|site) )?(?:is )?denied|request (?:was )?blocked|not available in your (?:country|region)|unavailable in your (?:country|region)|geo[- ]?block(?:ed)?|访问被拒绝|禁止访问|地区限制|您所在的地区(?:无法|不能))/i;
  const loginGateBody = /(?:\b(?:sign|log) in (?:to|or)\b|\bcontinue with (?:phone|google|apple|facebook|email)\b|\bemail or username\b|\b(?:login|sign[- ]?in) required\b|\byou must (?:sign|log) in\b|请(?:先)?登录|登录后(?:才能|方可))/i;
  const challengeBody = /(?:human verification|verify (?:that )?you are (?:a )?human|complete (?:the|this) (?:security|verification) check|security check before continuing|checking your browser|are you (?:a )?robot|not a bot|robot check|unusual traffic|automated (?:queries|requests)|(?:complete|solve|enter)(?:\s+the|\s+this)?\s+captcha|captcha.{0,80}(?:challenge|required|verify|continue)|人机验证|安全验证|验证您是真人|(?:请输入|完成|通过).{0,20}验证码|验证码.{0,30}(?:继续|验证|必填))/i;
  const serviceBody = /(?:^|\b)(?:(?:error\s*)?(?:400|404|405|406|408|410|412|415)\b(?:\s+(?:bad request|not found|method not allowed|not allowed|request timeout|gone|precondition failed|unsupported media type))?|500\s+internal server error|502\s+bad gateway|503\s+service unavailable|504\s+gateway timeout|temporarily unavailable|varnish cache server|doesn['’]?t work properly without javascript enabled|please enable javascript (?:to continue|in your browser)|javascript (?:is )?(?:disabled|required).{0,80}(?:continue|view|use)|服务暂时不可用)/i;

  let kind: PageAccessIssueKind | undefined;
  const reasons: string[] = [];
  if (exactAccessTitle.test(titleLower)) {
    kind = 'access_denied';
    reasons.push('page title identifies an access restriction');
  } else if (exactChallengeTitle.test(titleLower)) {
    kind = 'security_challenge';
    reasons.push('page title identifies a human/security challenge');
  } else if (exactClientErrorTitle.test(titleLower) || exactServiceTitle.test(titleLower)) {
    kind = 'service_error';
    reasons.push('page title identifies an HTTP or server error');
  } else if (!substantialContent && accessBody.test(bodyLower.slice(0, 3_000))) {
    kind = 'access_denied';
    reasons.push('short page body identifies an access restriction');
  } else if (!substantialContent && loginGateBody.test(bodyLower.slice(0, 3_000))) {
    kind = 'access_denied';
    reasons.push('short page body is an authentication gate');
  } else if (!substantialContent && challengeBody.test(bodyLower.slice(0, 3_000))) {
    kind = 'security_challenge';
    reasons.push('short page body identifies a human/security challenge');
  } else if (!substantialContent && serviceBody.test(bodyLower.slice(0, 2_000))) {
    kind = 'service_error';
    reasons.push('short page body identifies a server error');
  }
  if (!kind) return undefined;
  if (snapshot.hasChallengeElement) reasons.push('challenge-specific DOM element found');
  if (!substantialContent) reasons.push('no substantial main/article content found');

  return {
    kind,
    title,
    snippet: body.slice(0, 240),
    reasons
  };
}

export const classifyPageAccessSnapshotForTesting = classifyPageAccessSnapshot;
export const detectPageAccessIssueForTesting = detectPageAccessIssue;

function normalizeText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
