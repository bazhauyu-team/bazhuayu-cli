import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { API_BASE_URL_ENV, ApiRequestError, validateApiKey } from '../runtime/api-client.js';
import { API_KEY_ENV, maskApiKey, removeApiKey, resolveAuth, saveApiKey } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

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
  const message = `API key required. Run "octo-engine auth login" or set ${API_KEY_ENV}.`;
  if (json) {
    printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
  } else {
    console.error(`认证失败: ${message}`);
  }
  return EXIT_OPERATION_FAILED;
}

async function authLogin(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const readFromStdin = hasFlag(args, '--stdin');

  try {
    const apiKey = readFromStdin
      ? await readApiKeyFromStdin()
      : await readSecretFromTty('Enter API key: ');
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
        console.error(`请确认 API key 是否正确，或检查 ${API_BASE_URL_ENV} / env status。`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
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
