import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserMode, UserBrowserId } from './user-browser.js';

export interface BrowserPreferenceConfig {
  /** Default browser for run/detect when --browser is omitted. */
  mode?: BrowserMode;
  /** Target browser for user mode. */
  browserId?: UserBrowserId;
  /** Chromium profile directory name for user mode. */
  profile?: string;
}

export interface CliConfig {
  apiBaseUrl?: string;
  apiEnv?: 'prod' | string;
  /** Persistent default browser preference for run/detect. */
  browser?: BrowserPreferenceConfig;
  updatedAt?: string;
}

export function configFilePath(): string {
  return join(homedir(), '.octopus', 'config.json');
}

export async function readCliConfig(): Promise<CliConfig> {
  const filePath = configFilePath();
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : undefined,
      apiEnv: typeof parsed.apiEnv === 'string' ? parsed.apiEnv : undefined,
      browser: normalizeBrowserPreference(parsed.browser),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
    };
  } catch {
    return {};
  }
}

export async function saveCliConfig(config: CliConfig): Promise<CliConfig> {
  const filePath = configFilePath();
  const existing = await readCliConfig();
  const next: CliConfig = {
    ...existing,
    ...config,
    // Nested browser is replaced when provided (callers pass the full preference object).
    browser: config.browser !== undefined
      ? normalizeBrowserPreference(config.browser)
      : existing.browser,
    updatedAt: new Date().toISOString()
  };

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return next;
}

export async function saveBrowserPreference(preference: BrowserPreferenceConfig): Promise<CliConfig> {
  // Always write a complete browser preference snapshot.
  if (preference.mode === 'independent') {
    return saveCliConfig({ browser: { mode: 'independent' } });
  }
  if (preference.mode === 'user') {
    return saveCliConfig({
      browser: {
        mode: 'user',
        browserId: preference.browserId ?? 'chrome',
        ...(preference.profile ? { profile: preference.profile } : {})
      }
    });
  }
  return saveCliConfig({ browser: preference });
}

function normalizeBrowserPreference(value: unknown): BrowserPreferenceConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === 'user' || raw.mode === 'independent' ? raw.mode : undefined;
  const browserId = raw.browserId === 'chrome' || raw.browserId === 'edge' ? raw.browserId : undefined;
  const profile = typeof raw.profile === 'string' && raw.profile.trim() ? raw.profile.trim() : undefined;
  if (!mode && !browserId && !profile) return undefined;
  return {
    ...(mode ? { mode } : {}),
    ...(browserId ? { browserId } : {}),
    ...(profile ? { profile } : {})
  };
}

export async function removeCliConfig(): Promise<boolean> {
  const filePath = configFilePath();
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}
