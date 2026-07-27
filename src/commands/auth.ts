import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { API_BASE_URL_ENV, ApiRequestError, fetchAccountBalance, fetchAccountInfo, validateApiKey } from '../runtime/api-client.js';
import {
  ACCESS_TOKEN_ENV,
  API_KEY_ENV,
  maskAccessToken,
  maskApiKey,
  normalizeApiKey,
  removeApiKey,
  resolveAuth,
  saveApiKey,
  saveOAuthToken
} from '../runtime/auth.js';
import { buildEndSessionUrl, resolveOAuthConfig, runOAuthLogin } from '../runtime/oauth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export const API_KEYS_URL = 'https://www.bazhuayu.com/console/account-center/api-keys';

const ACCOUNT_LEVEL_NAMES = new Map<number, string>([
  [1, '免费版'],
  [2, '专业版'],
  [3, '旗舰版'],
  [4, '私有云'],
  [31, '旗舰+'],
  [110, '个人版'],
  [120, '团队版'],
  [130, '企业版'],
  [140, '企业成员']
]);

export async function authCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'login') {
    return authLogin(args);
  }

  if (subcommand === 'status') {
    return authStatus(args);
  }

  if (subcommand === 'info') {
    return authInfo(args);
  }

  if (subcommand === 'logout') {
    return authLogout(args);
  }

  return printUsageError(json, '错误: auth 子命令无效', '用法: bazhuayu auth <login|status|info|logout> [--json]');
}

export async function ensureAuthenticated(json: boolean): Promise<number> {
  const auth = await resolveAuth();
  if (auth.authenticated) return EXIT_OK;

  return printAuthRequired(json);
}

export function printAuthRequired(json: boolean): number {
  const message = [
    'Authentication required.',
    'Run "bazhuayu auth login" and choose OAuth or API key.',
    `API keys can be created at ${API_KEYS_URL}.`,
    `For CI, set ${API_KEY_ENV} or ${ACCESS_TOKEN_ENV}.`
  ].join(' ');
  if (json) {
    printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
  } else {
    console.error('认证失败: 需要登录后才能继续。');
    console.error('');
    console.error('然后运行:');
    console.error('  bazhuayu auth login');
    console.error('');
    console.error(`CI / 脚本环境可以设置 ${API_KEY_ENV} 或 ${ACCESS_TOKEN_ENV}。`);
  }
  return EXIT_OPERATION_FAILED;
}

async function authLogin(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const readFromStdin = hasFlag(args, '--stdin');
  const providedApiKey = normalizeApiKey(firstPositionalArg(args, ['--api-base-url']) ?? '');
  const method = await resolveLoginMethod(args, json, readFromStdin, Boolean(providedApiKey));
  if (method === 'oauth') {
    return authLoginOAuth(args);
  }
  return authLoginApiKey(args, json, readFromStdin, providedApiKey);
}

async function authLoginApiKey(args: string[], json: boolean, readFromStdin: boolean, providedApiKey: string): Promise<number> {
  const shouldOpen = shouldOpenApiKeyPage(args, json, readFromStdin, Boolean(providedApiKey));

  try {
    if (!providedApiKey && !readFromStdin && !json) {
      printLoginInstructions(shouldOpen);
    }
    if (shouldOpen) {
      await openUrl(API_KEYS_URL);
    }
    const apiKey = providedApiKey
      ? providedApiKey
      : readFromStdin
        ? await readApiKeyFromStdin()
        : await readSecretFromTty('Paste API key: ');
    const validation = await validateApiKey({ apiKey, baseUrl: valueAfter(args, '--api-base-url') });
    const credentials = await saveApiKey(apiKey);
    const status = {
      authenticated: true,
      source: 'file',
      method: 'apiKey',
      keyPreview: maskApiKey(credentials.apiKey ?? apiKey),
      credentialsFile: join(homedir(), '.octopus', 'credentials.json'),
      ...verifiedAccountFields(validation)
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`API key verified and saved: ${status.keyPreview}`);
      console.log(`API: ${status.apiBaseUrl}`);
      if (status.currentAccountLevel !== undefined) {
        console.log(`Account plan: ${formatAccountLevel(status.currentAccountLevel, status.currentAccountLevelName)}`);
      }
      if (status.accountBalance !== undefined) {
        console.log(`Account balance: ${status.accountBalance}`);
      }
      console.log(`Credentials: ${status.credentialsFile}`);
      console.log('');
      console.log('Next:');
      console.log('  bazhuayu task list');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_LOGIN_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else {
      console.error(`登录失败: ${message}`);
      console.error('API key 未保存。');
      if (code === 'AUTH_INVALID') {
        console.error('');
        console.error('请检查:');
        console.error('  1. 是否复制了完整 API key');
        console.error(`  2. API key 是否来自当前 API 环境，或检查 ${API_BASE_URL_ENV} / env status`);
        console.error(`  3. 可重新创建 API key: ${API_KEYS_URL}`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function authLoginOAuth(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const shouldOpen = !hasFlag(args, '--no-open');
  try {
    const config = resolveOAuthConfig();
    if (!json) {
      console.log('Opening browser for OAuth login.');
      console.log('');
    }
    const result = await runOAuthLogin({
      config,
      openBrowser: async (url) => {
        process.stderr.write(`Open this URL to log in:\n${url}\n`);
        if (shouldOpen) await openUrl(url);
      }
    });
    const credentials = await saveOAuthToken(result.token);
    const status = {
      authenticated: true,
      source: 'file',
      method: 'oauth',
      tokenPreview: maskAccessToken(result.token.accessToken),
      expiresAt: result.token.expiresAtMs ? new Date(result.token.expiresAtMs).toISOString() : undefined,
      credentialsFile: join(homedir(), '.octopus', 'credentials.json')
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`OAuth token saved: ${status.tokenPreview}`);
      console.log(`Credentials: ${status.credentialsFile}`);
      console.log('');
      console.log('Next:');
      console.log('  bazhuayu task list');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'OAUTH_LOGIN_FAILED', message);
    else {
      console.error(`OAuth 登录失败: ${message}`);
      console.error('Token 未保存。');
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function resolveLoginMethod(args: string[], json: boolean, readFromStdin: boolean, hasProvidedApiKey: boolean): Promise<'oauth' | 'apiKey'> {
  if (hasFlag(args, '--oauth')) return 'oauth';
  if (hasFlag(args, '--api-key')) return 'apiKey';
  if (readFromStdin || hasProvidedApiKey || json) return 'apiKey';
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'apiKey';
  const response = await prompts({
    type: 'select',
    name: 'method',
    message: 'Choose login method',
    choices: [
      { title: 'OAuth login (opens browser)', value: 'oauth' },
      { title: 'API key', value: 'apiKey' }
    ],
    initial: 0
  });
  return response.method === 'apiKey' ? 'apiKey' : 'oauth';
}

function printLoginInstructions(willOpenBrowser: boolean): void {
  console.log('Octopus 需要使用八爪鱼 API key 验证账号并访问任务。');
  console.log('');
  if (willOpenBrowser) {
    console.log('Opening API key page:');
  } else {
    console.log('Create API key:');
  }
  console.log(`  ${API_KEYS_URL}`);
  console.log('');
  if (willOpenBrowser) {
    console.log('If the browser did not open, copy the URL above.');
  }
  console.log('Create an API key in the browser, then paste it here.');
  console.log('The key will be verified before it is saved locally.');
  console.log('');
}

function shouldOpenApiKeyPage(args: string[], json: boolean, readFromStdin: boolean, hasProvidedApiKey: boolean): boolean {
  if (json || readFromStdin || hasProvidedApiKey || hasFlag(args, '--no-open')) return false;
  if (process.env.CI === 'true') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function openUrl(url: string): Promise<void> {
  const target = process.platform === 'win32'
    ? await createWindowsUrlLauncherFile(url)
    : url;
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', target]
    : [target];

  return new Promise((resolveOpen) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => resolveOpen());
    child.unref();
    resolveOpen();
  });
}

export async function createWindowsUrlLauncherFile(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-oauth-'));
  const filePath = join(dir, 'login.html');
  await writeFile(filePath, renderUrlLauncherPage(url), 'utf8');
  return filePath;
}

function renderUrlLauncherPage(url: string): string {
  const escapedUrl = escapeHtmlAttribute(url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${escapedUrl}">
  <title>Octopus OAuth Login</title>
  <script>location.replace(${JSON.stringify(url)});</script>
</head>
<body>
  <p>Opening OAuth login...</p>
  <p><a href="${escapedUrl}">Continue to login</a></p>
</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function authStatus(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    if (json) {
      return printAuthRequired(true);
    }
    console.log('Not authenticated');
    console.log('Run: bazhuayu auth login');
    return EXIT_OPERATION_FAILED;
  }

  try {
    const validation = auth.apiKey
      ? await validateApiKey({
          apiKey: auth.apiKey,
          baseUrl: valueAfter(args, '--api-base-url')
        })
      : await validateCredential(auth.credential, valueAfter(args, '--api-base-url'));
    const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = auth;
    const result = {
      ...status,
      ...verifiedAccountFields(validation)
    };

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    console.log(`Authenticated: yes (${status.source})`);
    console.log(`Method: ${status.method}`);
    console.log(`Verified: yes`);
    console.log(`API: ${validation.baseUrl}`);
    if (result.currentAccountLevel !== undefined) {
      console.log(`Account plan: ${formatAccountLevel(result.currentAccountLevel, result.currentAccountLevelName)}`);
    }
    if (result.accountBalance !== undefined) {
      console.log(`Account balance: ${result.accountBalance}`);
    }
    if (status.method === 'oauth') {
      console.log(`Access token: ${status.tokenPreview}`);
    } else {
      console.log(`API key: ${status.keyPreview}`);
    }
    if (status.source === 'env') {
      console.log(`Source: ${status.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV}`);
    } else {
      console.log(`Credentials: ${status.credentialsFile}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_STATUS_FAILED';
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`认证失败: ${message}`);
      if (code === 'AUTH_INVALID') {
        console.error(`可重新登录: bazhuayu auth login`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function authInfo(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    return printAuthRequired(json);
  }

  try {
    const validation = auth.apiKey
      ? await validateApiKey({
          apiKey: auth.apiKey,
          baseUrl: valueAfter(args, '--api-base-url')
        })
      : await validateCredential(auth.credential, valueAfter(args, '--api-base-url'));
    const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = auth;
    const result = {
      ...status,
      ...verifiedAccountFields(validation),
      account: validation.account
    };

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    printAccountInfo(result);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_INFO_FAILED';
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`获取账号信息失败: ${message}`);
      if (code === 'AUTH_INVALID') {
        console.error(`可重新登录: bazhuayu auth login`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function authLogout(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const before = await resolveAuth();
  const logoutUrl = before.method === 'oauth'
    ? buildEndSessionUrl(resolveOAuthConfig(), before.oauth)
    : undefined;
  const removed = await removeApiKey();
  const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = await resolveAuth();
  const result = { removed, logoutUrl, ...status };

  if (json) {
    printEnvelope(true, result);
    return EXIT_OK;
  }

  console.log(removed ? 'Stored credentials removed' : 'No stored credentials found');
  if (logoutUrl) console.log(`Identity logout: ${logoutUrl}`);
  if (status.authenticated && status.source === 'env') {
    console.log(`${status.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV} is still set and will continue to be used for this shell.`);
  }
  return EXIT_OK;
}

async function validateCredential(credential: NonNullable<Awaited<ReturnType<typeof resolveAuth>>['credential']>, baseUrl?: string) {
  const account = await fetchAccountInfo({ auth: credential, baseUrl });
  const balance = await fetchAccountBalance({ auth: credential, baseUrl }).catch(() => undefined);
  return {
    ok: true as const,
    baseUrl: account.baseUrl,
    endpoint: account.endpoint,
    account: account.data,
    balance
  };
}

function accountLevelName(level: unknown): string | undefined {
  return typeof level === 'number' ? ACCOUNT_LEVEL_NAMES.get(level) : undefined;
}

function formatAccountLevel(level: number, name: string | undefined): string {
  return name ?? String(level);
}

function verifiedAccountFields(validation: Awaited<ReturnType<typeof validateApiKey>>) {
  return {
    verified: true,
    apiBaseUrl: validation.baseUrl,
    currentAccountLevel: validation.account.currentAccountLevel,
    currentAccountLevelName: accountLevelName(validation.account.currentAccountLevel),
    accountBalance: validation.balance?.totalBalance ?? validation.balance?.balance ?? validation.account.accountBalance
  };
}

function printAccountInfo(result: ReturnType<typeof verifiedAccountFields> & {
  authenticated: boolean;
  source: string;
  method: string;
  keyPreview?: string;
  tokenPreview?: string;
  expiresAt?: string;
  credentialsFile: string;
  account: Record<string, unknown>;
}): void {
  console.log(`Authenticated: yes (${result.source})`);
  console.log(`Method: ${result.method}`);
  const userName = stringField(result.account.userName);
  const email = stringField(result.account.email);
  const mobile = stringField(result.account.mobile);
  const userId = stringField(result.account.userId);
  if (userName) console.log(`User name: ${userName}`);
  if (email) console.log(`Email: ${email}`);
  if (mobile) console.log(`Mobile: ${mobile}`);
  if (userId) console.log(`User ID: ${userId}`);
  if (result.currentAccountLevel !== undefined) {
    console.log(`Account plan: ${formatAccountLevel(result.currentAccountLevel, result.currentAccountLevelName)}`);
  }
  if (result.accountBalance !== undefined) {
    console.log(`Account balance: ${result.accountBalance}`);
  }
  const effectiveDate = stringField(result.account.effectiveDate);
  if (effectiveDate) console.log(`Effective date: ${effectiveDate}`);
  if (result.method === 'oauth') {
    console.log(`Access token: ${result.tokenPreview}`);
  } else {
    console.log(`API key: ${result.keyPreview}`);
  }
  if (result.source === 'env') console.log(`Source: ${result.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV}`);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readApiKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('使用 --stdin 时请通过管道传入 API key');
  }

  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  const apiKey = value.trim();
  if (!apiKey) throw new Error('API key 不能为空');
  return apiKey;
}

function readSecretFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.reject(new Error('当前不是交互式终端；请使用 --stdin'));
  }

  return new Promise((resolveSecret, rejectSecret) => {
    let value = '';
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.off('data', handleData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
    };

    const finish = () => {
      cleanup();
      const apiKey = value.trim();
      apiKey ? resolveSecret(apiKey) : rejectSecret(new Error('API key 不能为空'));
    };

    const handleData = (chunk: Buffer) => {
      const input = chunk.toString('utf8');
      for (const char of input) {
        if (char === '\u0003') {
          cleanup();
          rejectSecret(new Error('已取消'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') {
          value += char;
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', handleData);
  });
}
