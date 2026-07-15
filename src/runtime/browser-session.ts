import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeFileName } from './naming.js';

export interface BrowserSessionReference {
  name: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  kind: 'cookie';
  compatibility: 'cookies-only';
  hosts?: string[];
}

export interface BrowserSessionRecord extends BrowserSessionReference {
  cookies: BrowserSessionCookie[];
}

export interface BrowserSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface CookieHeaderBuildResult {
  header: string;
  used: number;
  skipped: Array<{ name: string; reason: string }>;
}

export function defaultSessionNameForUrl(url: string): string {
  try {
    return new URL(url).hostname || 'site';
  } catch {
    return 'site';
  }
}

export function sessionOriginForUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export function browserSessionPath(name: string): string {
  return join(browserSessionDir(), `${safeFileName(name)}.json`);
}

export async function saveBrowserSession(options: {
  name: string;
  origin: string;
  cookies: BrowserSessionCookie[];
  hosts?: string[];
}): Promise<BrowserSessionReference> {
  const cookies = sanitizeSessionCookies(options.cookies);
  const now = new Date().toISOString();
  const record: BrowserSessionRecord = {
    name: options.name,
    origin: options.origin,
    savedAt: now,
    cookieCount: cookies.length,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(options.hosts?.length ? { hosts: Array.from(new Set(options.hosts.map((host) => host.toLowerCase()))) } : {}),
    cookies
  };
  const dir = browserSessionDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const target = browserSessionPath(options.name);
  const temp = join(dir, `.${safeFileName(options.name)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
  return sessionReference(record);
}

export async function loadBrowserSession(name: string): Promise<BrowserSessionRecord> {
  const parsed = JSON.parse(await readFile(browserSessionPath(name), 'utf8')) as Partial<BrowserSessionRecord>;
  if (!parsed.name || !parsed.origin || !Array.isArray(parsed.cookies)) {
    throw new Error(`浏览器会话无效: ${name}`);
  }
  const cookies = sanitizeSessionCookies(parsed.cookies as BrowserSessionCookie[]);
  return {
    name: parsed.name,
    origin: parsed.origin,
    savedAt: parsed.savedAt || '',
    cookieCount: cookies.length,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(Array.isArray(parsed.hosts) ? { hosts: parsed.hosts.filter((host): host is string => typeof host === 'string') } : {}),
    cookies
  };
}

export function sessionReference(record: BrowserSessionRecord): BrowserSessionReference {
  return {
    name: record.name,
    origin: record.origin,
    savedAt: record.savedAt,
    cookieCount: record.cookieCount,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(record.hosts?.length ? { hosts: record.hosts } : {})
  };
}

/**
 * Build a Cookie request header for the proprietary engine's globalCookie path.
 *
 * The engine parses `name=value; name2=value2` and calls CDP setCookies with only
 * name/value/domain/path — it never sets `secure`. Chrome rejects cookies whose
 * names start with `__Secure-` / `__Host-` unless Secure is true, which aborts the
 * entire setCookies batch and makes Navigate fail with "Invalid cookie fields".
 *
 * Also skip values that break Cookie-header splitting (`;`, control chars).
 */
export function buildCookieHeaderFromSession(record: Pick<BrowserSessionRecord, 'cookies'>): CookieHeaderBuildResult {
  const usedParts: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const cookie of record.cookies) {
    const name = typeof cookie?.name === 'string' ? cookie.name.trim() : '';
    if (!name) {
      skipped.push({ name: String(cookie?.name ?? ''), reason: 'empty-name' });
      continue;
    }
    if (name.startsWith('__Secure-') || name.startsWith('__Host-')) {
      // Engine parseCookies cannot set the Secure flag required by these prefixes.
      skipped.push({ name, reason: 'secure-prefix-requires-flag' });
      continue;
    }
    if (typeof cookie.value !== 'string' && typeof cookie.value !== 'number' && typeof cookie.value !== 'boolean') {
      skipped.push({ name, reason: 'missing-value' });
      continue;
    }
    let value = normalizeCookieValue(String(cookie.value));
    if (!isCookieHeaderSafeValue(value)) {
      // Keep auth-ish cookies even with awkward JSON values by percent-encoding
      // only the characters that break Cookie header / CDP parsing.
      const encoded = encodeCookieHeaderValue(value);
      if (!isCookieHeaderSafeValue(encoded)) {
        skipped.push({ name, reason: 'unsafe-value' });
        continue;
      }
      value = encoded;
    }
    usedParts.push(`${name}=${value}`);
  }
  return {
    header: usedParts.join('; '),
    used: usedParts.length,
    skipped
  };
}

export function cookieHeaderFromSession(record: Pick<BrowserSessionRecord, 'cookies'>): string {
  return buildCookieHeaderFromSession(record).header;
}

export function sanitizeSessionCookies(cookies: BrowserSessionCookie[]): BrowserSessionCookie[] {
  const nowSec = Date.now() / 1000;
  const cleaned: BrowserSessionCookie[] = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue;
    const name = typeof cookie.name === 'string' ? cookie.name.trim() : '';
    if (!name || cookie.value === undefined || cookie.value === null) continue;
    if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSec) continue;
    const value = normalizeCookieValue(String(cookie.value));
    const next: BrowserSessionCookie = {
      name,
      value,
      ...(cookie.domain ? { domain: String(cookie.domain) } : {}),
      ...(cookie.path ? { path: String(cookie.path) } : { path: '/' }),
      ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
      ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
      ...(cookie.sameSite ? { sameSite: normalizeSameSite(cookie.sameSite, Boolean(cookie.secure)) } : {})
    };
    // Chrome rejects SameSite=None without Secure.
    if (next.sameSite === 'None' && !next.secure) {
      next.secure = true;
    }
    // __Secure- / __Host- cookies must be Secure.
    if ((name.startsWith('__Secure-') || name.startsWith('__Host-')) && !next.secure) {
      next.secure = true;
    }
    cleaned.push(next);
  }
  return cleaned;
}

export function normalizeCookieValue(value: string): string {
  let next = value;
  // Puppeteer/CDP often returns Set-Cookie quoted values with surrounding quotes.
  if (next.length >= 2 && next.startsWith('"') && next.endsWith('"')) {
    next = next.slice(1, -1);
  }
  return next;
}

function normalizeSameSite(value: string, _secure: boolean): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return 'None';
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'strict') return 'Strict';
  return value;
}

function isCookieHeaderSafeValue(value: string): boolean {
  if (!value) return true;
  // Cookie header octet rules are looser in browsers, but CDP setCookies is picky:
  // reject ASCII controls and bare separators that break name=value; parsing.
  if (/[\x00-\x1F\x7F]/.test(value)) return false;
  if (value.includes(';')) return false;
  return true;
}

function encodeCookieHeaderValue(value: string): string {
  // Encode only characters that break Cookie header splitting / CDP validation.
  return value.replace(/[\x00-\x1F\x7F;]/g, (char) => {
    const code = char.charCodeAt(0);
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function browserSessionDir(): string {
  return join(homedir(), '.octopus', 'browser-sessions');
}
