import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { authCommand, createWindowsUrlLauncherFile } from '../dist/commands/auth.js';
import { cloudCommand, cloudHistory } from '../dist/commands/cloud.js';
import { ApiRequestError, fetchAccountInfo, validateApiKey } from '../dist/runtime/api-client.js';
import { DEFAULT_OAUTH_REDIRECT_URI, exchangeCodeForToken, runOAuthLogin } from '../dist/runtime/oauth.js';
import { localDataExportCommand, runTask, setEngineHostFactoryForTesting } from '../dist/commands/run.js';
import { EngineHost } from '../dist/runtime/engine-host.js';
import { BillingRuntimeError } from '../dist/runtime/run-services.js';
import { formatTaskListLine } from '../dist/commands/task.js';
import { TaskDefinitionProvider } from '../dist/runtime/task-definition-provider.js';

const execFileAsync = promisify(execFile);
const cli = resolve('dist/index.js');

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? await mkdtemp(join(tmpdir(), 'octopus-home-')),
        ...(options.apiKey ? { OCTOPUS_API_KEY: options.apiKey } : {}),
        ...(options.apiBaseUrl ? { OCTOPUS_API_BASE_URL: options.apiBaseUrl } : {})
      },
      timeout: options.timeout ?? 20_000
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

async function runCliWithStdin(args, input, options = {}) {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? '',
        ...(options.apiBaseUrl ? { OCTOPUS_API_BASE_URL: options.apiBaseUrl } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function assertJsonEnvelope(result) {
  assert.doesNotThrow(() => parseJson(result.stdout), result.stdout || result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
}

function formatCliResult(result, args = []) {
  const command = args.length ? ` args=${args.join(' ')}` : '';
  return `${command} code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`;
}

function assertJsonFailure(result, code, exitCode = 1, args = []) {
  assert.equal(result.code, exitCode, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload;
}

function assertJsonSuccess(result, args = []) {
  assert.equal(result.code, 0, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  return payload;
}

test('functional commands require API key even for local task files', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ]);
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'AUTH_REQUIRED');
  assert.match(payload.error.message, /bazhuayu\.com\/console\/account-center\/api-keys/);
  assert.match(payload.error.message, /octopus auth login/);
});

test('capabilities is available before authentication and documents API key contract', async () => {
  const result = await runCli(['capabilities', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.authentication.requiredForUse, true);
  assert.equal(payload.data.authentication.loginVerifiesKeyBeforeSaving, true);
  assert.equal(payload.data.authentication.env, 'OCTOPUS_API_KEY');
  assert.ok(payload.data.authentication.diagnosticCommandsWithoutAuth.includes('capabilities'));
  assert.ok(payload.data.commands.find((item) => item.command === 'run <taskId>')?.authRequired);
  assert.equal(payload.data.machineContract.stable, true);
  assert.equal(payload.data.machineContract.json.usageErrorsUseEnvelope, true);
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_INVALID'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CAPTCHA_BALANCE_NOT_ENOUGH'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CLOUD_BALANCE_NOT_ENOUGH'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CLOUD_PROXY_BALANCE_NOT_ENOUGH'));
  assert.equal(payload.data.machineContract.json.commonErrorCodes.includes('LOCAL_RUN_LIMIT_EXCEEDED'), false);
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('warning'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('billing.warning'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('billing.error'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('captcha'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('proxy'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('run.failed'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('run.stopped'));
  assert.equal(payload.data.machineContract.lifecycle.daemonRequired, false);
  assert.equal(payload.data.machineContract.lifecycle.accountLocalRunLimit, false);
  assert.equal(payload.data.machineContract.lifecycle.localRunResourceWarning.code, 'LOCAL_RUN_RESOURCE_WARNING');
  assert.equal(payload.data.machineContract.lifecycle.localRunResourceWarning.blocking, false);
  assert.ok(payload.data.machineContract.lifecycle.cleanupCommands.includes('local cleanup'));
  const schemas = payload.data.machineContract.schemas;
  assert.deepEqual(Object.keys(schemas).sort(), [
    'capabilities',
    'detachedBootstrap',
    'jsonEnvelope',
    'runEvent'
  ]);
  for (const schemaPath of Object.values(schemas)) {
    const schema = JSON.parse(await readFile(resolve(schemaPath), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/octopus\.local\/schemas\//);
  }
});

test('auth login verifies API key before saving', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-invalid-'));
  const result = await runCliWithStdin(
    ['auth', 'login', '--stdin', '--json', '--api-base-url', 'http://127.0.0.1:9'],
    'bad-key\n',
    { home }
  );
  assertJsonFailure(result, 'AUTH_LOGIN_FAILED');
  await assert.rejects(access(join(home, '.octopus', 'credentials.json')));
});

test('auth status fails when no API key is configured', async () => {
  const result = await runCli(['auth', 'status', '--json']);
  const payload = assertJsonFailure(result, 'AUTH_REQUIRED');
  assert.match(payload.error.message, /octopus auth login/);
});

test('auth status fails when configured API key is invalid', async () => {
  const result = await runCli(['auth', 'status', '--json'], {
    apiKey: 'bad-key',
    apiBaseUrl: 'http://127.0.0.1:9'
  });
  assertJsonFailure(result, 'AUTH_STATUS_FAILED');
});

test('auth status verifies configured API key before reporting success', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'test-key';
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers['x-api-key'], 'test-key');
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_status',
        email: 'status@example.com',
        currentAccountLevel: 120,
        accountBalance: 88.5
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('status', ['--json']);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.authenticated, true);
    assert.equal(payload.data.source, 'env');
    assert.equal(payload.data.verified, true);
    assert.equal(payload.data.apiBaseUrl, 'https://example.invalid');
    assert.equal(payload.data.currentAccountLevel, 120);
    assert.equal(payload.data.currentAccountLevelName, '团队版');
    assert.equal(payload.data.accountBalance, 88.5);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('auth status verifies configured OAuth access token before reporting success', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalAccessToken = process.env.OCTOPUS_ACCESS_TOKEN;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_ACCESS_TOKEN = 'access-token-123';
  delete process.env.OCTOPUS_API_KEY;
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers.Authorization, 'Bearer access-token-123');
    assert.equal(init?.headers['x-api-key'], undefined);
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_oauth',
        email: 'oauth@example.com',
        currentAccountLevel: 130,
        accountBalance: 12
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('status', ['--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.authenticated, true);
    assert.equal(payload.data.source, 'env');
    assert.equal(payload.data.method, 'oauth');
    assert.equal(payload.data.verified, true);
    assert.equal(payload.data.currentAccountLevel, 130);
    assert.equal(payload.data.currentAccountLevelName, '企业版');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalAccessToken === undefined) delete process.env.OCTOPUS_ACCESS_TOKEN;
    else process.env.OCTOPUS_ACCESS_TOKEN = originalAccessToken;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('auth login accepts API key as a positional argument', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-arg-'));
  const originalHome = process.env.HOME;
  const seen = [];
  const lines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  process.env.HOME = home;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_arg',
        email: 'arg@example.com',
        currentAccountLevel: 120,
        accountBalance: 12.3
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const code = await authCommand('login', [
      'arg-key-123',
      '--json',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'arg-key-123');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.data.currentAccountLevel, 120);
    assert.equal(payload.data.currentAccountLevelName, '团队版');
    assert.equal(payload.data.accountBalance, 12.3);
    const credentials = JSON.parse(await readFile(join(home, '.octopus', 'credentials.json'), 'utf8'));
    assert.equal(credentials.apiKey, 'arg-key-123');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth login prints readable account plan in text output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-plan-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines = [];
  process.env.HOME = home;
  globalThis.fetch = async () => new Response(JSON.stringify({
    isSuccess: true,
    data: {
      userId: 'u_plan',
      email: 'plan@example.com',
      currentAccountLevel: 120,
      accountBalance: 66
    }
  }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' }
  });
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('login', [
      'plan-key-123',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Account plan: 团队版/);
    assert.match(lines.join('\n'), /Account balance: 66/);
    assert.doesNotMatch(lines.join('\n'), /Account plan: 团队版 \(120\)/);
    assert.doesNotMatch(lines.join('\n'), /Current account level: 120/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth login falls back to user balances endpoint when account has no balance field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-balance-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.HOME = home;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/account/getAccount') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          userId: 'u_balance',
          email: 'balance@example.com',
          currentAccountLevel: 120
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          balance: 7.5,
          totalBalance: 18.75
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('login', [
      'balance-key-123',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.deepEqual(seen, ['/api/account/getAccount', '/api/user/balances']);
    assert.match(lines.join('\n'), /Account balance: 18\.75/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth info shows current account details', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'info-key';
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers['x-api-key'], 'info-key');
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_info',
        email: 'info@example.com',
        userName: 'Info User',
        currentAccountLevel: 120,
        accountBalance: 99.9,
        effectiveDate: '2026-12-31T00:00:00Z'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('info', []);
    assert.equal(code, 0);
    const output = lines.join('\n');
    assert.match(output, /User name: Info User/);
    assert.match(output, /Email: info@example\.com/);
    assert.match(output, /Account plan: 团队版/);
    assert.match(output, /Account balance: 99\.9/);
    assert.doesNotMatch(output, /团队版 \(120\)/);
    assert.doesNotMatch(output, /Verified:/);
    assert.doesNotMatch(output, /API: https:\/\/example\.invalid/);
    assert.doesNotMatch(output, /Credentials:/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('invalid API key maps to friendly auth error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'unauthorized',
    error_Description: 'An error occurred during API Key verification.'
  }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' }
  });
  try {
    await assert.rejects(
      validateApiKey({ apiKey: 'bad-key', baseUrl: 'https://example.invalid' }),
      (error) => {
        assert.equal(error instanceof ApiRequestError, true);
        assert.equal(error.code, 'AUTH_INVALID');
        assert.equal(error.status, 401);
        assert.match(error.message, /Authentication is invalid/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account info uses electron getAccount endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_1',
        email: 'user@example.com',
        userName: 'Example User',
        type: 2,
        currentAccountLevel: 2,
        effectiveDate: '2026-12-31T00:00:00Z'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchAccountInfo({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(result.endpoint, '/api/account/getAccount');
    assert.equal(result.data.userId, 'u_1');
    assert.equal(result.data.email, 'user@example.com');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'test-key');
    assert.equal(seen[0].headers['x-client-id'], 'cli');
    assert.match(seen[0].headers['x-client-version'], /^\d+\.\d+\.\d+/);
    assert.equal(seen[0].headers['x-client'], undefined);
    assert.equal(seen[0].headers['x-client-verison'], undefined);

    const validation = await validateApiKey({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(validation.endpoint, '/api/account/getAccount');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account info accepts OAuth bearer credential', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_bearer',
        email: 'bearer@example.com'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchAccountInfo({
      auth: { type: 'bearer', value: 'oauth-token' },
      baseUrl: 'https://example.invalid'
    });
    assert.equal(result.data.userId, 'u_bearer');
    assert.equal(seen[0].headers.Authorization, 'Bearer oauth-token');
    assert.equal(seen[0].headers['x-api-key'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OAuth authorization code exchange maps token response', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: String(init.body), headers: init.headers });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      token_type: 'Bearer',
      scope: 'openid profile offline_access',
      expires_in: 3600
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  const token = await exchangeCodeForToken('code-123', {
    authority: 'https://identity.example',
    clientId: 'bazhuayu-cli',
    clientSecret: '*',
    redirectUri: 'http://localhost:18784/login-callback',
    scope: 'openid profile offline_access'
  }, fetchImpl);
  assert.equal(seen[0].url, 'https://identity.example/connect/token');
  assert.match(seen[0].body, /grant_type=authorization_code/);
  assert.match(seen[0].body, /client_id=bazhuayu-cli/);
  assert.match(seen[0].body, /client_secret=*/);
  assert.match(seen[0].body, /code=code-123/);
  assert.equal(token.accessToken, 'access-token');
  assert.equal(token.refreshToken, 'refresh-token');
  assert.equal(token.idToken, 'id-token');
  assert.ok(token.expiresAtMs > Date.now());
});

test('OAuth token exchange treats Bazhuayu expires_in as milliseconds', async () => {
  const now = Date.now();
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 86_400_000
  }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' }
  });
  const token = await exchangeCodeForToken('code-ms', {
    authority: 'https://identity.example',
    clientId: 'bazhuayu-cli',
    clientSecret: '*',
    redirectUri: 'http://localhost:18784/login-callback',
    scope: 'openid profile offline_access'
  }, fetchImpl);
  assert.ok(token.expiresAtMs >= now + 86_399_000);
  assert.ok(token.expiresAtMs <= now + 86_401_000);
});

test('Windows OAuth URL launcher stores the complete long URL in a local HTML file', async () => {
  const longState = 'state-'.padEnd(9000, 'x');
  const longUrl = `https://identity.example/connect/authorize?client_id=bazhuayu-cli&redirect_uri=http%3A%2F%2Flocalhost%3A18784%2Flogin-callback&state=${longState}`;
  const filePath = await createWindowsUrlLauncherFile(longUrl);
  const html = await readFile(filePath, 'utf8');
  assert.match(filePath, /login\.html$/);
  assert.ok(filePath.length < longUrl.length);
  assert.match(html, /location\.replace/);
  assert.ok(html.includes(JSON.stringify(longUrl)));
  assert.ok(html.includes('client_id=bazhuayu-cli&amp;redirect_uri='));
  assert.ok(html.includes(longState));
});

test('OAuth login falls back to the next registered callback port', async (context) => {
  const blocker = createServer((_request, response) => response.end('busy'));
  const blocked = await new Promise((resolveListen) => {
    blocker.once('error', rejectListen);
    function rejectListen(error) {
      resolveListen(error);
    }
    blocker.listen(18784, '127.0.0.1', () => resolveListen(null));
  });
  if (blocked) {
    context.skip(`local listen unavailable: ${blocked.code ?? blocked.message}`);
    return;
  }
  const seen = [];
  try {
    const resultPromise = runOAuthLogin({
      config: {
        authority: 'https://identity.example',
        clientId: 'bazhuayu-cli',
        clientSecret: '*',
        redirectUri: DEFAULT_OAUTH_REDIRECT_URI,
        scope: 'openid profile offline_access'
      },
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        seen.push({ authorizeUrl: url, redirectUri });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', 'code-456');
        callback.searchParams.set('state', parsed.searchParams.get('state'));
        const response = await fetch(callback);
        await response.text();
      },
      fetchImpl: async (url, init) => {
        seen.push({ tokenUrl: String(url), body: String(init.body) });
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600
        }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    const result = await resultPromise;
    assert.equal(seen[0].redirectUri, 'http://localhost:18785/login-callback');
    assert.match(seen[1].body, /redirect_uri=http%3A%2F%2Flocalhost%3A18785%2Flogin-callback/);
    assert.equal(result.config.redirectUri, 'http://localhost:18785/login-callback');
    assert.equal(result.token.accessToken, 'access-token');
  } finally {
    await new Promise((resolveClose) => blocker.close(resolveClose));
  }
});

test('remote task not found suggests a nearby listed task id', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  process.env.OCTOPUS_API_KEY = 'dummy';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/task/getTask') {
      return new Response(JSON.stringify({ isSuccess: true, data: null }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/searchTaskListV3') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          total: 1,
          currentTotal: 1,
          dataList: [{
            taskId: '2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef',
            taskName: '博客园 - 开发者的网上家园'
          }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      new TaskDefinitionProvider().getTask('2dca8f7d-c689-c5dd-a0d4-6eaabf8f73ef'),
      (error) => {
        assert.match(error.message, /你是不是想运行/);
        assert.match(error.message, /6aeabf8f73ef/);
        assert.match(error.message, /octopus run 2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud history enriches lots with exportable unique row counts', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  process.env.OCTOPUS_API_KEY = 'dummy';
  const lines = [];
  const seen = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/progress/task/task-cloud-history') {
      return new Response(JSON.stringify({
        data: [{
          lot: 'lot_1',
          status: 4,
          startTime: '2026-04-15T15:18:44+08:00',
          dataCnt: 14,
          extCnt: 14
        }],
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/taskData/task-cloud-history/lot/lot_1/exportData') {
      return new Response(JSON.stringify({
        data: {
          offset: 1,
          total: 12,
          restTotal: 11,
          duplicate: 2,
          files: [{ fileBody: '' }]
        },
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => {
    lines.push(String(line));
  };

  try {
    const code = await cloudHistory(['task-cloud-history', '--api-base-url', 'https://example.invalid']);
    assert.equal(code, 0);
    assert.ok(seen.includes('/api/progress/task/task-cloud-history'));
    assert.ok(seen.includes('/api/taskData/task-cloud-history/lot/lot_1/exportData'));
    assert.match(lines.join('\n'), /rows=14  uniqueRows=12  duplicateRows=2/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud start maps balance and proxy failures to stable json errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'dummy';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const taskId = parsed.searchParams.get('taskId');
    const status = taskId === 'cloud-balance-low' ? 12 : taskId === 'cloud-proxy-low' ? 8 : 1;
    return new Response(JSON.stringify({
      isSuccess: true,
      data: status
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => {
    lines.push(String(line));
  };

  try {
    const balanceCode = await cloudCommand('start', [
      'cloud-balance-low',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    const proxyCode = await cloudCommand('start', [
      'cloud-proxy-low',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    assert.equal(balanceCode, 1);
    assert.equal(proxyCode, 1);
    const payloads = lines.map((line) => parseJson(line));
    assert.equal(payloads[0].ok, false);
    assert.equal(payloads[0].error.code, 'CLOUD_BALANCE_NOT_ENOUGH');
    assert.match(payloads[0].error.message, /云采集余额不足/);
    assert.equal(payloads[1].ok, false);
    assert.equal(payloads[1].error.code, 'CLOUD_PROXY_BALANCE_NOT_ENOUGH');
    assert.match(payloads[1].error.message, /代理 IP 余额不足/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('root and run help clearly state authentication requirement', async () => {
  const root = await runCli(['--help']);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /OAuth or API key credentials are required for all functional commands/);
  assert.match(root.stdout, /bazhuayu\.com\/console\/account-center\/api-keys/);

  const auth = await runCli(['auth', '--help']);
  assert.equal(auth.code, 0);
  assert.match(auth.stdout, /Interactive login lets you choose OAuth or API key/);
  assert.match(auth.stdout, /--oauth/);
  assert.match(auth.stdout, /--no-open/);

  const run = await runCli(['run', '--help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Requires configured credentials/);
  assert.match(run.stdout, /run only starts local collection/);
  assert.match(run.stdout, /data export <taskId> --lot-id <lotId>/);
});

test('usage failures honor --json envelopes', async () => {
  const run = await runCli(['run', '--json'], { apiKey: 'dummy' });
  const runPayload = assertJsonFailure(run, 'USAGE_ERROR');
  assert.match(runPayload.error.message, /缺少 taskId/);

  const unknown = await runCli(['nope', '--json']);
  assertJsonFailure(unknown, 'UNKNOWN_COMMAND');
});

test('agent-facing commands expose json envelopes for key contract paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-contract-'));
  const output = join(root, 'runs');
  const apiKey = 'dummy';

  const successCases = [
    ['env', 'status', '--json'],
    ['doctor', '--chrome-path', process.execPath, '--json'],
    ['local', 'cleanup', '--json'],
    ['local', 'status', 'missing-task', '--json'],
    ['local', 'history', 'missing-task', '--output', output, '--json'],
    ['data', 'history', 'missing-task', '--source', 'local', '--output', output, '--json'],
    ['runs', 'list', '--output', output, '--json'],
    ['runs', 'cleanup', '--output', output, '--json']
  ];
  for (const args of successCases) {
    assertJsonSuccess(await runCli(args, { apiKey }), args);
  }

  const failureCases = [
    { args: ['task', 'inspect', '--task-file', 'examples/minimal-task.json', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'pause', 'task-1', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'status', '--api-base-url', 'http://127.0.0.1:9', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'status', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'stop', 'missing-task', '--json'], code: 'LOCAL_RUN_CONTROL_FAILED' },
    { args: ['local', 'export', 'missing-task', '--output', output, '--json'], code: 'LOCAL_LOT_NOT_FOUND' },
    { args: ['data', 'history', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', 'missing-task', '--source', 'local', '--format', 'bad', '--json'], code: 'UNSUPPORTED_EXPORT_FORMAT' },
    { args: ['runs', 'status', '--output', output, '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'status', 'missing-run', '--output', output, '--json'], code: 'RUN_NOT_FOUND' },
    { args: ['runs', 'logs', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'data', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['run', 'export', 'missing-task', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', 'missing-run', '--file', join(root, 'result.csv'), '--format', 'bad', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', '--output', output, '--file', join(root, 'result.csv'), '--json'], code: 'USAGE_ERROR' }
  ];
  for (const item of failureCases) {
    assertJsonFailure(await runCli(item.args, { apiKey }), item.code, 1, item.args);
  }
});

test('cleanup commands remove orphaned local control state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-cleanup-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const activeDir = join(home, '.octopus', 'active-local');
  const runDir = join(output, 'run_stale');
  await mkdir(activeDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const staleState = {
    runId: 'run_stale',
    lotId: 'lot_stale',
    taskId: 'stale-task',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: new Date().toISOString()
  };
  const activeFile = join(activeDir, 'stale-task.json');
  const controlFile = join(runDir, 'control.json');
  const metaFile = join(runDir, 'meta.json');
  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');

  const localStatus = await runCli(['local', 'status', 'stale-task', '--json'], { apiKey: 'dummy', home });
  const statusPayload = assertJsonSuccess(localStatus);
  assert.equal(statusPayload.data.status, 'not_running');
  assert.equal(statusPayload.data.active, false);
  assert.equal(statusPayload.data.currentRun, null);
  assert.equal(statusPayload.data.cleanedStaleState, true);
  assert.equal(statusPayload.data.lastRun.status, 'stopped');
  assert.equal(statusPayload.data.lastRun.total, 2);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));
  const preserved = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(preserved.status, 'stopped');
  assert.equal(preserved.total, 2);

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);

  const runsCleanup = await runCli(['runs', 'cleanup', '--output', output, '--json'], { apiKey: 'dummy', home });
  const runsPayload = assertJsonSuccess(runsCleanup);
  assert.equal(runsPayload.data.checked, 1);
  assert.equal(runsPayload.data.removed, 1);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  const localCleanup = await runCli(['local', 'cleanup', '--json'], { apiKey: 'dummy', home });
  const localPayload = assertJsonSuccess(localCleanup);
  assert.equal(localPayload.data.checked, 1);
  assert.equal(localPayload.data.removed, 1);
  await assert.rejects(access(activeFile));
});

test('local status reports idle with last run summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-local-status-last-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_status_last_20260429010101');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_status_last_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'status-last-task',
    taskName: 'Status Last Task',
    status: 'stopped',
    total: 2,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);

  const jsonResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output,
    '--json'
  ], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(jsonResult);
  assert.equal(payload.data.status, 'not_running');
  assert.equal(payload.data.active, false);
  assert.equal(payload.data.currentRun, null);
  assert.equal(payload.data.lastRun.status, 'stopped');
  assert.equal(payload.data.lastRun.lotId, 'lot_20260429010101');

  const humanResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output
  ], { apiKey: 'dummy' });
  assert.equal(humanResult.code, 0, formatCliResult(humanResult));
  assert.match(humanResult.stdout, /status-last-task  idle/);
  assert.match(humanResult.stdout, /Last run: stopped  rows=2  lot=lot_20260429010101/);
});

test('local status reports starting for live detached bootstrap before control channel is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-local-status-detach-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const bootstrapDir = join(output, '.detach_detach-starting-task_20260429010101');
  await mkdir(bootstrapDir, { recursive: true });
  await writeFile(join(bootstrapDir, 'bootstrap.json'), `${JSON.stringify({
    taskId: 'detach-starting-task',
    pid: process.pid,
    status: 'starting',
    stdout: join(bootstrapDir, 'stdout.log'),
    stderr: join(bootstrapDir, 'stderr.log'),
    updatedAt: '2026-04-29T01:01:01.000Z'
  }, null, 2)}\n`);

  const jsonResult = await runCli([
    'local',
    'status',
    'detach-starting-task',
    '--output',
    output,
    '--json'
  ], { apiKey: 'dummy', home });
  const payload = assertJsonSuccess(jsonResult);
  assert.equal(payload.data.status, 'starting');
  assert.equal(payload.data.active, true);
  assert.equal(payload.data.detached, true);
  assert.equal(payload.data.pid, process.pid);
  assert.equal(payload.data.bootstrapDir, bootstrapDir);

  const humanResult = await runCli([
    'local',
    'status',
    'detach-starting-task',
    '--output',
    output
  ], { apiKey: 'dummy', home });
  assert.equal(humanResult.code, 0, formatCliResult(humanResult));
  assert.match(humanResult.stdout, /detach-starting-task  starting/);
  assert.match(humanResult.stdout, /Bootstrap:/);
});

test('local history reports row count from rows artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-history-rows-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_task_rows_20260429010101');
  const staleRunDir = join(output, 'run_task_rows_20260429010202');
  await mkdir(runDir, { recursive: true });
  await mkdir(staleRunDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'task-rows',
    taskName: 'Rows Task',
    status: 'stopped',
    total: 0,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');
  await writeFile(join(staleRunDir, 'control.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010202',
    lotId: 'lot_20260429010202',
    taskId: 'task-rows',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: '2026-04-29T01:02:02.000Z'
  }, null, 2)}\n`);
  await writeFile(join(staleRunDir, 'rows.jsonl'), '{"a":3}\n{"a":4}\n{"a":5}\n');

  const result = await runCli(['data', 'history', 'task-rows', '--source', 'local', '--output', output, '--json'], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(result);
  assert.equal(payload.data.length, 2);
  assert.equal(payload.data[0].lotId, 'lot_20260429010202');
  assert.equal(payload.data[0].status, 'stopped');
  assert.equal(payload.data[0].total, 3);
  assert.equal(payload.data[1].total, 2);
});

test('minimal example validates with API key', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ], { apiKey: 'dummy' });
  assert.equal(result.code, 0);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.actionCount, 1);
  assert.deepEqual(payload.data.actionTypes, ['NavigateAction']);
});

test('run rejects --format and points users to data export', async () => {
  const result = await runCli(['run', 'minimal', '--format', 'csv', '--json'], { apiKey: 'dummy' });
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'RUN_FORMAT_UNSUPPORTED');
  assert.match(payload.error.message, /data export --format/);

  const jsonl = await runCli(['run', 'minimal', '--format', 'csv', '--jsonl'], { apiKey: 'dummy' });
  assert.equal(jsonl.code, 1);
  assert.equal(jsonl.stdout.trim().split('\n').length, 1);
  const jsonlPayload = parseJson(jsonl.stdout);
  assert.equal(jsonlPayload.ok, false);
  assert.equal(jsonlPayload.error.code, 'RUN_FORMAT_UNSUPPORTED');
});

test('run validates max rows as a positive integer', async () => {
  const result = await runCli(['run', 'minimal', '--max-rows', '0', '--json'], { apiKey: 'dummy' });
  assertJsonFailure(result, 'RUN_MAX_ROWS_INVALID');
  assert.match(parseJson(result.stdout).error.message, /--max-rows/);
});

test('run preflight blocks paid template when balance is below charging granularity', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-paid-template-task-'));
  const taskFile = join(dir, 'paid-template-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'paid-template-low-balance',
    taskName: 'Paid Template Low Balance',
    isTemplate: true,
    workFlowType: 10,
    template: {
      permission: { allowCrossAccountLevelPricing: true },
      prices: { standard: 1 },
      pricePerData: 1
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/templatecharging/user/canStartTemplateTask/paid-template-low-balance') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          canUse: true,
          balance: 0,
          balanceLowThreshold: 20,
          chargingGranularity: 1
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const code = await runTask('paid-template-low-balance', ['--task-file', taskFile, '--json']);
    assert.equal(code, 2);
    const payload = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((item) => item?.ok === false);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'TEMPLATE_BALANCE_NOT_ENOUGH');
    assert.match(payload.error.message, /付费模板余额不足/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight skips template billing for non-template task files', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 500,
      statusText: 'Server Error',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('preflight-ok', {
      taskFile: 'examples/minimal-task.json',
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    assert.equal(seen.includes('/api/templatecharging/user/canStartTemplateTask/minimal'), false);
    const templateWarning = result.jsonl.find((item) => item?.code === 'TEMPLATE_BALANCE_LOW');
    assert.equal(templateWarning, undefined);
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight emits jsonl warning for low paid template balance', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-paid-template-warning-'));
  const taskFile = join(dir, 'paid-template-warning.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'paid-template-warning',
    taskName: 'Paid Template Warning',
    isTemplate: true,
    workFlowType: 10,
    template: {
      permission: { allowCrossAccountLevelPricing: true },
      prices: { standard: 1 },
      pricePerData: 1
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/templatecharging/user/canStartTemplateTask/paid-template-warning') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          canUse: true,
          balance: 5,
          balanceLowThreshold: 20,
          chargingGranularity: 1
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('paid-template-warning', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.event === 'billing.warning');
    assert.equal(warning?.code, 'TEMPLATE_BALANCE_LOW');
    assert.equal(warning?.balance, 5);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'TEMPLATE_BALANCE_LOW'));
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight ignores stored strong proxy settings when switch IP is disabled', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-proxy-task-'));
  const taskFile = join(dir, 'proxy-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'proxy-low-balance',
    taskName: 'Proxy Low Balance',
    brokerSettings: {
      ipProxySettings: {
        ipProxyFromType: 1
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 3, totalBalance: 3 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('proxy-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    assert.equal(seen.includes('/api/user/balances'), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight warns for strong proxy balance risk without blocking startup', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-proxy-task-'));
  const taskFile = join(dir, 'proxy-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'proxy-low-balance',
    taskName: 'Proxy Low Balance',
    xml: minimalTask.xml.replace('EnableSwitchIp="false"', 'EnableSwitchIp="true"').replace('IPType="None"', 'IPType="0"'),
    brokerSettings: {
      ipProxySettings: {
        ipProxyFromType: 1
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 3, totalBalance: 3 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('proxy-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.code === 'PROXY_BALANCE_LOW');
    assert.equal(warning?.severity, 'warning');
    assert.match(warning?.message, /优质代理 IP 余额较低/);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'PROXY_BALANCE_LOW'));
    assert.equal(seen.includes('/api/HttpProxy/Balance'), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight warns for captcha balance risk without blocking startup', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-captcha-task-'));
  const taskFile = join(dir, 'captcha-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'captcha-low-balance',
    taskName: 'Captcha Low Balance',
    brokerSettings: {
      captchaSettings: {
        isAutoCloudflare: true
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 2, totalBalance: 2 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/Captcha/GetCaptchaRemain') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: 0
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('captcha-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.event === 'billing.warning');
    assert.equal(warning?.code, 'CAPTCHA_BALANCE_LOW');
    assert.equal(warning?.balance, 2);
    assert.equal(warning?.captchaRemain, 0);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'CAPTCHA_BALANCE_LOW'));
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('billing runtime errors expose stable codes and readable messages', () => {
  const captcha = new BillingRuntimeError('CAPTCHA_BALANCE_NOT_ENOUGH', '验证码余额不足，请充值后重试。', 3);
  const proxy = new BillingRuntimeError('PROXY_BALANCE_NOT_ENOUGH', '代理 IP 余额不足，请充值后重试。', 4);
  assert.equal(captcha.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(captcha.status, 3);
  assert.match(captcha.message, /验证码余额不足/);
  assert.equal(proxy.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(proxy.status, 4);
  assert.match(proxy.message, /代理 IP 余额不足/);
});

test('runtime billing service failures are reported as events without forcing run stop', async () => {
  const result = await runWithFakeRuntimeEvent('captcha-no-balance');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);

  const captchaFailed = result.jsonl.find((item) => item.event === 'captcha' && item.phase === 'failed');
  assert.equal(captchaFailed?.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(captchaFailed?.status, 3);
  const billingError = result.jsonl.find((item) => item.event === 'billing.error');
  assert.equal(billingError?.capability, 'captcha');
  assert.equal(billingError?.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(billingError?.status, 3);
  assert.ok(result.events.some((item) => item.event === 'billing.error' && item.code === 'CAPTCHA_BALANCE_NOT_ENOUGH'));
  assert.ok(result.events.some((item) => item.event === 'run.stopped'));
});

test('runtime proxy billing failures are reported as events without forcing run stop', async () => {
  const result = await runWithFakeRuntimeEvent('proxy-no-balance');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);

  const proxyFailed = result.jsonl.find((item) => item.event === 'proxy' && item.phase === 'failed');
  assert.equal(proxyFailed?.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(proxyFailed?.status, 4);
  const billingError = result.jsonl.find((item) => item.event === 'billing.error');
  assert.equal(billingError?.capability, 'proxy');
  assert.equal(billingError?.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(billingError?.status, 4);
  assert.ok(result.events.some((item) => item.event === 'billing.error' && item.code === 'PROXY_BALANCE_NOT_ENOUGH'));
});

test('runtime captcha success is resolved and returned to the workflow', async () => {
  const result = await runWithFakeRuntimeEvent('captcha-success');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);
  assert.deepEqual(result.captchaTokens, [{ captchaType: 0, token: 'captcha-token' }]);

  const captchaResolved = result.jsonl.find((item) => item.event === 'captcha' && item.phase === 'resolved');
  assert.equal(captchaResolved?.numericCaptchaType, 0);
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
  assert.ok(result.events.some((item) => item.event === 'captcha' && item.phase === 'resolved'));
});

test('runtime proxy success is resolved and returned to the workflow', async () => {
  const result = await runWithFakeRuntimeEvent('proxy-success');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);
  assert.equal(result.sentProxy.length, 1);
  assert.equal(result.sentProxy[0].proxyIp.ip, '127.0.0.1');
  assert.equal(result.sentProxy[0].proxyIp.port, 8080);

  assert.ok(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'resolved' && item.hasProxy === true));
  assert.ok(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'sent' && item.hasProxy === true));
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
  assert.ok(result.events.some((item) => item.event === 'proxy' && item.phase === 'sent'));
});

test('local run records engine download events in artifacts and summary', async () => {
  const result = await runWithFakeRuntimeEvent('download-runtime', {
    downloadEvents: [
      {
        url: 'https://example.com/file.webp',
        filePath: '/tmp/octopus-downloads/task/字段1/file.webp',
        fileSize: 1234,
        status: 'downloading',
        fieldName: '字段1',
        rowUuid: 'row-1'
      },
      {
        url: 'https://example.com/file.webp',
        filePath: '/tmp/octopus-downloads/task/字段1/file.webp',
        fileSize: 1234,
        status: 'success',
        fieldName: '字段1',
        rowUuid: 'row-1'
      },
      {
        url: 'https://example.com/file-2.webp',
        filePath: '/tmp/octopus-downloads/task/字段2/file-2.webp',
        fileSize: 5678,
        status: 'downloading',
        fieldName: '字段2',
        rowUuid: 'row-2'
      },
      {
        url: 'https://example.com/file-2.webp',
        filePath: '/tmp/octopus-downloads/task/字段2/file-2.webp',
        fileSize: 5678,
        status: 'success',
        fieldName: '字段2',
        rowUuid: 'row-2'
      }
    ]
  });
  assert.equal(result.code, 0);
  assert.ok(result.events.find((event) => event.event === 'download.succeeded'));
  const stopped = result.events.find((event) => event.event === 'run.stopped');
  assert.equal(stopped.downloads.total, 2);
  assert.equal(stopped.downloads.succeeded, 2);
  assert.equal(stopped.downloads.outputDir, '/tmp/octopus-downloads/task');
  assert.equal(result.downloads.length, 4);
});

test('run completion prints a copyable local data export command', () => {
  assert.equal(
    localDataExportCommand({ taskId: 'task-1', lotId: '1778123456789' }),
    'octopus data export task-1 --source local --lot-id 1778123456789'
  );
});

test('task list text output hides internal workflow metadata', () => {
  const line = formatTaskListLine({
    taskId: 'task-1',
    taskName: 'Demo Task',
    status: 1,
    workflowType: 1,
    workFlowType: 1
  });
  assert.equal(line, '  task-1  Demo Task');
  assert.doesNotMatch(line, /workflow=/);
  assert.doesNotMatch(line, /status=/);
});

test('detached startup failure writes bootstrap artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-detach-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const taskFile = join(root, 'invalid-task.json');
  await writeFile(taskFile, JSON.stringify({
    taskId: 'invalid-detach',
    taskName: 'Invalid Detach',
    xml: '<Root />',
    xoml: '<?xml version="1.0"?><definitions><process id="p" isExecutable="true" /></definitions>',
    fieldNames: []
  }));

  const result = await runCli([
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ], { apiKey: 'dummy', apiBaseUrl: 'http://127.0.0.1:9', home, timeout: 20_000 });

  assert.equal(result.code, 2, formatCliResult(result, [
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ]));
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DETACHED_RUN_FAILED');

  const bootstrapDir = payload.error.message.match(/bootstrap=(.+)$/)?.[1];
  assert.ok(bootstrapDir, payload.error.message);
  const bootstrap = JSON.parse(await readFile(join(bootstrapDir, 'bootstrap.json'), 'utf8'));
  assert.equal(bootstrap.status, 'failed');
  assert.match(bootstrap.error, /actionType|Nothing to execute|缺少可执行/);
  assert.equal(bootstrap.taskId, 'invalid-detach');
});

async function runWithFakeRuntimeEvent(scenario, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const root = await mkdtemp(join(tmpdir(), `octopus-${scenario}-`));
  const output = join(root, 'runs');
  let taskFile = options.taskFile;
  if (!taskFile) {
    taskFile = join(root, 'task.json');
    const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
    await writeFile(taskFile, JSON.stringify({
      ...minimalTask,
      taskId: scenario,
      taskName: scenario,
      ...(scenario === 'proxy-no-balance' || scenario === 'proxy-success'
        ? {
            brokerSettings: {
              ipProxySettings: {
                ipProxyFromType: 1
              }
            }
          }
        : {})
    }));
  }
  process.env.OCTOPUS_API_KEY = 'runtime-key';

  let workflowInstance;
  const workflowEvents = {
    ExtraData: 'extraData',
    Log: 'log',
    Stopped: 'stopped',
    Captcha: 'captcha',
    GetProxy: 'getProxy',
    DownloadFile: 'downloadFile',
    CollectProxyLog: 'collectProxyLog'
  };
  class FakeWorkflow extends EventEmitter {
    stopCalls = 0;
    stopTaskCalls = 0;
    sentProxy = [];
    captchaTokens = [];

    constructor() {
      super();
      workflowInstance = this;
    }

    async start() {
      setImmediate(() => {
        if (options.rowData) {
          this.emit(workflowEvents.ExtraData, {
            data: {
              total: 1,
              rowData: options.rowData
            }
          });
        }
        for (const event of options.downloadEvents ?? []) {
          this.emit(workflowEvents.DownloadFile, { data: event });
        }
        if (scenario === 'captcha-no-balance' || scenario === 'captcha-success') {
          this.emit(workflowEvents.Captcha, {
            data: [{
              captchaType: 'image',
              image: 'base64-image',
              url: 'https://example.com'
            }]
          });
        } else if (scenario === 'proxy-no-balance' || scenario === 'proxy-success') {
          this.emit(workflowEvents.GetProxy, {});
        }
        setTimeout(() => {
          this.emit(workflowEvents.Stopped, { data: { status: 'completed' } });
        }, 20);
      });
    }

    capthcaToken(payload) {
      this.captchaTokens.push(payload);
    }

    sendProxy(payload) {
      this.sentProxy.push(payload);
    }

    stop() {
      this.stopCalls += 1;
    }

    stopTask() {
      this.stopTaskCalls += 1;
    }

    pauseTask() {}
    resumeTask() {}
    close() {}
  }

  const fakeEngine = {
    default: FakeWorkflow,
    WorkflowEvents: workflowEvents,
    resolveChrome: async () => ({ executablePath: process.execPath })
  };
  const fakeBridgeFactory = () => new FakeBridgeHub();

  globalThis.fetch = options.fetch ?? (async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/Captcha/DoCaptchaV2') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          status: scenario === 'captcha-success' ? 1 : 3,
          captcha: scenario === 'captcha-success' ? 'captcha-token' : ''
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/HttpProxy') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: scenario === 'proxy-success'
          ? {
              status: 0,
              ip: '127.0.0.1',
              port: 8080,
              protocol: 1
            }
          : {
              status: 4
            }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  });
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  setEngineHostFactoryForTesting(() => new EngineHost(fakeEngine, fakeBridgeFactory));

  try {
    const code = await runTask(scenario, [
      '--task-file',
      taskFile,
      '--output',
      output,
      '--jsonl',
      '--timeout-ms',
      '2000'
    ]);
    const jsonl = lines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const stopped = jsonl.find((item) => item.event === 'run.stopped');
    const eventsPath = join(stopped.outputDir, 'events.jsonl');
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const downloadsPath = join(stopped.outputDir, 'downloads.jsonl');
    let downloads = [];
    try {
      downloads = (await readFile(downloadsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    const rowsPath = join(stopped.outputDir, 'rows.jsonl');
    let rows = [];
    try {
      rows = (await readFile(rowsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    return {
      code,
      jsonl,
      events,
      downloads,
      rows,
      workflowStopCalls: workflowInstance?.stopCalls ?? 0,
      workflowStopTaskCalls: workflowInstance?.stopTaskCalls ?? 0,
      sentProxy: workflowInstance?.sentProxy ?? [],
      captchaTokens: workflowInstance?.captchaTokens ?? []
    };
  } finally {
    setEngineHostFactoryForTesting(undefined);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
}

class FakeBridgeHub extends EventEmitter {
  async createSessionBridge() {
    return {};
  }

  async waitForSessionConnected() {}

  close() {}
}
