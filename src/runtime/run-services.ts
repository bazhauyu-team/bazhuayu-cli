import { ApiRequestError, resolveApiBaseUrl } from './api-client.js';
import { resolveAuth } from './auth.js';
import type { CaptchaRequest, ProxyResponse, TaskDefinition } from '../types.js';

const CAPTCHA_SUCCESS = 1;
const PROXY_OK = 0;

export type CaptchaAnswer =
  | { token: string }
  | { distance: number; status: number; isAvailable: boolean }
  | { clickArea: string[]; status: number; isAvailable: boolean };

export async function solveCaptcha(request: CaptchaRequest, task: TaskDefinition, lotId: string): Promise<CaptchaAnswer | undefined> {
  const type = numericCaptchaType(request.captchaType);
  if (type === undefined) {
    throw new Error(`unsupported captcha type: ${String(request.captchaType ?? 'unknown')}`);
  }

  if (type === 64 || type === 128) {
    const image = stringValue(request.image ?? recordValue(request.data, 'image'));
    if (!image) throw new Error('slider captcha request is missing image');
    const result = await postCaptcha('/api/Captcha/ImageCaptcha', {
      TaskId: task.taskId,
      ImageBase64: image,
      CaptchaType: 64,
      LotNo: lotId
    });
    return {
      distance: Number(result.captcha) || 0,
      status: result.status,
      isAvailable: true
    };
  }

  if (type === 65) {
    const image = stringValue(request.image ?? recordValue(request.data, 'image'));
    if (!image) throw new Error('click captcha request is missing image');
    const result = await postCaptcha('/api/Captcha/DoCaptchaV2', {
      TaskId: task.taskId,
      Img1: image,
      Img2: stringValue(request.image2 ?? recordValue(request.data, 'image2')),
      CaptchaType: 65,
      LotNo: lotId
    });
    return {
      clickArea: splitClickArea(result.captcha),
      status: result.status,
      isAvailable: true
    };
  }

  const token = await solveTokenCaptcha(type, request, task, lotId);
  return token === undefined ? undefined : { token };
}

export async function resolveProxy(task: TaskDefinition, lotId: string, webPageUrl?: string): Promise<ProxyResponse | undefined> {
  const settings = getRecord(getRecord(task.brokerSettings)?.ipProxySettings);
  const fromType = numberValue(settings?.ipProxyFromType);
  if (fromType === 1) {
    const proxies = arrayValue(getRecord(settings?.customIpProxySettings)?.proxies);
    const proxy = parseCustomProxy(stringValue(proxies[0]));
    return proxy ? { proxyIp: proxy } : undefined;
  }

  const areaId = numberValue(getRecord(settings?.strongIpProxySettings)?.areaId) ?? -1;
  const result = await apiRequest({
    endpoint: '/api/HttpProxy',
    method: 'GET',
    query: {
      taskId: task.taskId,
      count: '1',
      LotNo: lotId,
      areaId: String(areaId),
      consumptionType: '1',
      ...(webPageUrl ? { url: webPageUrl } : {})
    }
  });

  const data = getRecord(getRecord(result)?.data);
  if (!data) throw new Error('proxy response is missing data');
  const status = numberValue(data.status) ?? PROXY_OK;
  if (status !== PROXY_OK) {
    throw new Error(`proxy service returned status ${status}`);
  }

  const ip = stringValue(data.ip);
  const port = numberValue(data.port);
  if (!ip || !port) throw new Error('proxy response is missing ip or port');
  return {
    proxyIp: {
      ip,
      port,
      account: stringValue(data.account) || undefined,
      password: stringValue(data.password) || undefined,
      protocol: numberValue(data.protocol)
    }
  };
}

export async function collectProxyLog(proxyInfo: unknown): Promise<void> {
  const payload = getRecord(proxyInfo);
  if (!payload) return;
  await apiRequest({
    endpoint: '/api/HttpProxy/CollectProxyLog',
    method: 'POST',
    body: payload
  });
}

async function solveTokenCaptcha(type: number, request: CaptchaRequest, task: TaskDefinition, lotId: string): Promise<string | undefined> {
  if (type === 0 || type === 1) {
    const image = stringValue(request.image ?? recordValue(request.data, 'image'));
    if (!image) throw new Error('image captcha request is missing image');
    const result = await postCaptcha('/api/Captcha/DoCaptchaV2', {
      TaskId: task.taskId,
      Img1: image,
      CaptchaType: 15,
      ExtraContent: request.url ? domainUrl(request.url) : '',
      LotNo: lotId
    });
    return result.captcha;
  }

  if (type === 3 || type === 100) {
    const key = stringValue(request.key ?? recordValue(request.data, 'key'));
    const url = stringValue(request.url ?? recordValue(request.data, 'url'));
    if (!key || !url) throw new Error('reCAPTCHA request is missing key or url');
    const result = await postCaptcha('/api/Captcha/ReCaptcha', {
      CaptchaType: type,
      webSiteKey: key,
      WebUrl: url,
      TaskId: task.taskId
    });
    return result.captcha;
  }

  if (type === 63 || type === 102) {
    const key = stringValue(request.key ?? recordValue(request.data, 'key'));
    const url = stringValue(request.url ?? recordValue(request.data, 'url'));
    if (!key || !url) throw new Error('reCAPTCHA v3 request is missing key or url');
    const result = await postCaptcha('/api/Captcha/ReCaptchaV3', {
      websiteKey: key,
      websiteUrl: url,
      taskId: task.taskId,
      pageAction: stringValue(request.action ?? recordValue(request.data, 'action')) || 'verify'
    });
    return result.captcha;
  }

  if (type === 4 || type === 101) {
    const key = stringValue(request.key ?? recordValue(request.data, 'key'));
    const url = stringValue(request.url ?? recordValue(request.data, 'url'));
    if (!key || !url) throw new Error('hCaptcha request is missing key or url');
    const result = await postCaptcha('/api/Captcha/HReCaptcha', {
      CaptchaType: type,
      webSiteKey: key,
      WebUrl: url,
      TaskId: task.taskId
    });
    return result.captcha;
  }

  if (type === 999) {
    const data = getRecord(request.data);
    const result = await postCaptcha('/api/captcha/decodeTurnstileProxylessCaptcha', {
      taskId: task.taskId,
      websiteUrl: stringValue(recordValue(data, 'pageurl') ?? request.url),
      websiteKey: stringValue(recordValue(data, 'sitekey') ?? request.key),
      pageAction: stringValue(recordValue(data, 'action') ?? request.action) || 'managed',
      userAgent: stringValue(recordValue(data, 'userAgent')),
      pageData: stringValue(recordValue(data, 'pagedata')),
      data: stringValue(recordValue(data, 'data')),
      captchaType: 67,
      cloudflareTaskType: 'token',
      lotno: lotId
    });
    return result.captcha;
  }

  return undefined;
}

async function postCaptcha(endpoint: string, body: Record<string, unknown>): Promise<{ status: number; captcha: string }> {
  const result = await apiRequest({ endpoint, method: 'POST', body });
  const data = getRecord(getRecord(result)?.data);
  const status = numberValue(data?.status) ?? 0;
  if (status !== CAPTCHA_SUCCESS) {
    throw new Error(`captcha service returned status ${status}`);
  }
  return {
    status,
    captcha: stringValue(data?.captcha)
  };
}

async function apiRequest(options: {
  endpoint: string;
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<unknown> {
  const auth = await resolveAuth();
  if (!auth.apiKey) throw new ApiRequestError('API key required. Run "octo-engine auth login".', 'AUTH_REQUIRED');
  const baseUrl = await resolveApiBaseUrl();
  const url = new URL(options.endpoint, `${baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: options.method,
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
      'Content-Type': 'application/json',
      'x-client-id': 'Octopus',
      'x-client-verison': 'octo-engine-cli',
      'x-api-key': auth.apiKey
    },
    body: options.method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ApiRequestError(`API request failed: HTTP ${response.status} ${response.statusText} (${baseUrl}${options.endpoint})`, 'HTTP_ERROR', response.status, text);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new ApiRequestError('API response is not valid JSON', 'INVALID_JSON', response.status, text);
  }
}

function numericCaptchaType(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  switch (value) {
    case 'image':
      return 0;
    case 'slider':
      return 64;
    case 'click':
      return 65;
    case 'recaptcha-v2':
      return 3;
    case 'recaptcha-v2-callback':
      return 100;
    case 'recaptcha-v3':
      return 63;
    case 'recaptcha-v3-callback':
      return 102;
    case 'hcaptcha':
      return 4;
    case 'hcaptcha-callback':
      return 101;
    case 'cloudflare':
      return 999;
    default:
      return undefined;
  }
}

function parseCustomProxy(value: string): ProxyResponse['proxyIp'] | undefined {
  const [ip, portRaw, account, password] = value.split(':');
  const port = Number(portRaw);
  if (!ip || !Number.isFinite(port)) return undefined;
  return {
    ip,
    port,
    ...(account ? { account } : {}),
    ...(password ? { password } : {})
  };
}

function splitClickArea(value: string): string[] {
  return value ? value.split('|').filter(Boolean) : [];
}

function domainUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordValue(value: unknown, key: string): unknown {
  return getRecord(value)?.[key];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
