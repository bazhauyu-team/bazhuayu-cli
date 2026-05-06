import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { API_BASE_URL_ENV, ApiRequestError, validateApiKey } from '../runtime/api-client.js';
import { API_KEY_ENV, maskApiKey, removeApiKey, resolveAuth, saveApiKey } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export const API_KEYS_URL = 'https://www.bazhuayu.com/console/account-center/api-keys';

export async function authCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'login') {
    return authLogin(args);
  }

  if (subcommand === 'status') {
    return authStatus(args);
  }

  if (subcommand === 'logout') {
    return authLogout(args);
  }

  return printUsageError(json, '错误: auth 子命令无效', '用法: octo-engine auth <login|status|logout> [--json]');
}

export async function ensureAuthenticated(json: boolean): Promise<number> {
  const auth = await resolveAuth();
  if (auth.authenticated) return EXIT_OK;

  return printAuthRequired(json);
}

export function printAuthRequired(json: boolean): number {
  const message = [
    'API key required.',
    `Create one at ${API_KEYS_URL}, then run "octo-engine auth login".`,
    `For CI, set ${API_KEY_ENV}.`
  ].join(' ');
  if (json) {
    printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
  } else {
    console.error('认证失败: 需要 API key 才能继续。');
    console.error('');
    console.error('获取 API key:');
    console.error(`  ${API_KEYS_URL}`);
    console.error('');
    console.error('然后运行:');
    console.error('  octo-engine auth login');
    console.error('');
    console.error(`CI / 脚本环境可以设置 ${API_KEY_ENV}。`);
  }
  return EXIT_OPERATION_FAILED;
}

async function authLogin(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const readFromStdin = hasFlag(args, '--stdin');
  const shouldOpen = shouldOpenApiKeyPage(args, json, readFromStdin);

  try {
    if (!readFromStdin && !json) {
      printLoginInstructions(shouldOpen);
    }
    if (shouldOpen) {
      await openUrl(API_KEYS_URL);
    }
    const apiKey = readFromStdin
      ? await readApiKeyFromStdin()
      : await readSecretFromTty('Paste API key: ');
    const validation = await validateApiKey({ apiKey, baseUrl: valueAfter(args, '--api-base-url') });
    const credentials = await saveApiKey(apiKey);
    const status = {
      authenticated: true,
      source: 'file',
      keyPreview: maskApiKey(credentials.apiKey),
      credentialsFile: join(homedir(), '.octo-engine', 'credentials.json'),
      verified: true,
      apiBaseUrl: validation.baseUrl
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`API key verified and saved: ${status.keyPreview}`);
      console.log(`API: ${status.apiBaseUrl}`);
      console.log(`Credentials: ${status.credentialsFile}`);
      console.log('');
      console.log('Next:');
      console.log('  octo-engine task list');
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

function printLoginInstructions(willOpenBrowser: boolean): void {
  console.log('Octo Engine 需要使用八爪鱼 API key 验证账号并访问任务。');
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

function shouldOpenApiKeyPage(args: string[], json: boolean, readFromStdin: boolean): boolean {
  if (json || readFromStdin || hasFlag(args, '--no-open')) return false;
  if (process.env.CI === 'true') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];

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

async function authStatus(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const { apiKey: _apiKey, ...status } = await resolveAuth();

  if (json) {
    printEnvelope(true, status);
    return EXIT_OK;
  }

  if (!status.authenticated) {
    console.log('Not authenticated');
    console.log('Run: octo-engine auth login');
    return EXIT_OK;
  }

  console.log(`Authenticated: yes (${status.source})`);
  console.log(`API key: ${status.keyPreview}`);
  if (status.source === 'env') {
    console.log(`Source: ${API_KEY_ENV}`);
  } else {
    console.log(`Credentials: ${status.credentialsFile}`);
  }
  return EXIT_OK;
}

async function authLogout(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const removed = await removeApiKey();
  const { apiKey: _apiKey, ...status } = await resolveAuth();
  const result = { removed, ...status };

  if (json) {
    printEnvelope(true, result);
    return EXIT_OK;
  }

  console.log(removed ? 'Stored API key removed' : 'No stored API key found');
  if (status.authenticated && status.source === 'env') {
    console.log(`${API_KEY_ENV} is still set and will continue to be used for this shell.`);
  }
  return EXIT_OK;
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
