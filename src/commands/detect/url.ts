export class DetectUrlError extends Error {
  readonly code = 'DETECT_URL_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DetectUrlError';
  }
}

export function normalizeDetectUrl(raw: string): string {
  const input = raw.trim();
  if (!input) throw new DetectUrlError('URL 不能为空。');

  const schemeMatch = input.match(/^[a-z][a-z0-9+.-]*:/i);
  const bareHostWithPort = Boolean(schemeMatch && /^\d+(?:[/?#]|$)/.test(input.slice(schemeMatch[0].length)));
  let candidate = input;
  if (input.startsWith('//')) {
    candidate = `https:${input}`;
  } else if (!schemeMatch || bareHostWithPort) {
    if (/^[./?#]/.test(input)) {
      throw new DetectUrlError('URL 必须包含主机名，不能使用相对路径。');
    }
    const authority = input.split(/[/?#]/, 1)[0];
    if (!authority.includes('.') && !/^localhost(?::\d+)?$/i.test(authority) && !authority.startsWith('[')) {
      throw new DetectUrlError('裸 URL 必须是域名、IP 地址或 localhost；也可以显式传入 http:// 或 https://。');
    }
    candidate = `https://${input}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new DetectUrlError(`URL 格式无效: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DetectUrlError(`不支持的 URL 协议: ${parsed.protocol || '(none)'}；仅支持 http 和 https。`);
  }
  if (!parsed.hostname) throw new DetectUrlError('URL 缺少主机名。');
  if (parsed.username || parsed.password) {
    throw new DetectUrlError('URL 不能包含用户名或密码。');
  }
  return parsed.href;
}
