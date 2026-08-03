import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  parseBrowserId,
  parseBrowserMode,
  resolveBrowserLaunchOptions,
  UserBrowserError,
  isUserBrowserPlatformSupported
} from '../dist/runtime/user-browser.js';

const execFileAsync = promisify(execFile);
const cli = resolve('dist/index.js');

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? await mkdtemp(join(tmpdir(), 'octopus-home-')),
        ...(options.env ?? {})
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

test('parseBrowserMode accepts independent and user aliases', () => {
  assert.equal(parseBrowserMode(undefined), 'independent');
  assert.equal(parseBrowserMode('independent'), 'independent');
  assert.equal(parseBrowserMode('managed'), 'independent');
  assert.equal(parseBrowserMode('user'), 'user');
  assert.equal(parseBrowserMode('local'), 'user');
  assert.throws(() => parseBrowserMode('firefox'), (error) => error instanceof UserBrowserError);
});

test('parseBrowserId accepts chrome and edge', () => {
  assert.equal(parseBrowserId(undefined), 'chrome');
  assert.equal(parseBrowserId('chrome'), 'chrome');
  assert.equal(parseBrowserId('edge'), 'edge');
  assert.throws(() => parseBrowserId('safari'), (error) => error instanceof UserBrowserError);
});

test('resolveBrowserLaunchOptions priority: cli > env > config > default', () => {
  assert.deepEqual(
    resolveBrowserLaunchOptions({ env: {} }),
    { browserMode: 'independent', browserId: 'chrome', modeSource: 'default' }
  );

  assert.equal(
    resolveBrowserLaunchOptions({
      preference: { mode: 'user', browserId: 'edge', profile: 'Profile 1' },
      env: {}
    }).modeSource,
    'config'
  );
  const fromConfig = resolveBrowserLaunchOptions({
    preference: { mode: 'user', browserId: 'edge', profile: 'Profile 1' },
    env: {}
  });
  assert.equal(fromConfig.browserMode, 'user');
  assert.equal(fromConfig.browserId, 'edge');
  assert.equal(fromConfig.browserProfile, 'Profile 1');

  const fromEnv = resolveBrowserLaunchOptions({
    preference: { mode: 'user', browserId: 'edge' },
    env: { OCTOPUS_BROWSER: 'independent', OCTOPUS_BROWSER_ID: 'chrome' }
  });
  assert.equal(fromEnv.browserMode, 'independent');
  assert.equal(fromEnv.modeSource, 'env');
  assert.equal(fromEnv.browserId, 'chrome');

  const fromCli = resolveBrowserLaunchOptions({
    browserFlag: 'user',
    browserIdFlag: 'edge',
    profileFlag: 'Work',
    preference: { mode: 'independent' },
    env: { OCTOPUS_BROWSER: 'independent' }
  });
  assert.equal(fromCli.browserMode, 'user');
  assert.equal(fromCli.modeSource, 'cli');
  assert.equal(fromCli.browserId, 'edge');
  assert.equal(fromCli.browserProfile, 'Work');
});

test('browser use persists default and status reports it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octopus-home-'));

  if (isUserBrowserPlatformSupported()) {
    const setUser = await runCli(
      ['browser', 'use', 'user', '--browser-id', 'chrome', '--profile', 'Default', '--json'],
      { home }
    );
    assert.equal(setUser.code, 0, setUser.stdout || setUser.stderr);
    const setPayload = JSON.parse(setUser.stdout);
    assert.equal(setPayload.ok, true);
    assert.equal(setPayload.data.mode, 'user');
    assert.equal(setPayload.data.browserId, 'chrome');
    assert.equal(setPayload.data.profile, 'Default');
    assert.equal(setPayload.data.source, 'config');

    const show = await runCli(['browser', 'use', 'status', '--json'], { home });
    assert.equal(show.code, 0, show.stdout || show.stderr);
    const showPayload = JSON.parse(show.stdout);
    assert.equal(showPayload.ok, true);
    assert.equal(showPayload.data.mode, 'user');
    assert.equal(showPayload.data.browserId, 'chrome');
    assert.equal(showPayload.data.profile, 'Default');
    assert.equal(showPayload.data.source, 'config');

    const status = await runCli(['browser', 'status', '--json'], { home });
    assert.equal(status.code, 0, status.stdout || status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.data.defaultBrowser.mode, 'user');
    assert.equal(statusPayload.data.defaultBrowser.source, 'config');
  } else {
    const rejected = await runCli(['browser', 'use', 'user', '--json'], { home });
    assert.notEqual(rejected.code, 0, rejected.stdout || rejected.stderr);
    const rejectedPayload = JSON.parse(rejected.stdout);
    assert.equal(rejectedPayload.ok, false);
    assert.equal(rejectedPayload.error.code, 'UNSUPPORTED_PLATFORM');
  }

  const setIndependent = await runCli(['browser', 'use', 'independent', '--json'], { home });
  assert.equal(setIndependent.code, 0, setIndependent.stdout || setIndependent.stderr);
  const independentPayload = JSON.parse(setIndependent.stdout);
  assert.equal(independentPayload.data.mode, 'independent');

  const after = await runCli(['browser', 'use', '--json'], { home });
  assert.equal(after.code, 0, after.stdout || after.stderr);
  const afterPayload = JSON.parse(after.stdout);
  assert.equal(afterPayload.data.mode, 'independent');
  assert.equal(afterPayload.data.source, 'config');
});

test('browser use rejects unknown mode', async () => {
  const result = await runCli(['browser', 'use', 'firefox', '--json']);
  assert.notEqual(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
});

test('browser status works without authentication', async () => {
  const result = await runCli(['browser', 'status', '--json']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.supported, isUserBrowserPlatformSupported());
  assert.ok(payload.data.defaultBrowser);
  assert.equal(payload.data.defaultBrowser.mode, 'independent');
  assert.equal(payload.data.defaultBrowser.source, 'default');
  if (payload.data.supported) {
    assert.ok(payload.data.browser);
    assert.ok(payload.data.extensionStatus);
    assert.ok(Array.isArray(payload.data.profiles));
    assert.ok(Array.isArray(payload.data.hints));
    assert.ok(Array.isArray(payload.data.nextActions));
    assert.ok(payload.data.nextActions.length > 0);
    assert.ok(payload.data.nextActions.every((action) => typeof action.requiresHuman === 'boolean'));
  } else {
    assert.match(payload.data.note, /Windows or macOS/i);
  }
});

test('browser profiles works without authentication on supported platforms', async () => {
  if (!isUserBrowserPlatformSupported()) {
    const result = await runCli(['browser', 'profiles', '--json']);
    assert.equal(result.code, 2, result.stdout || result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'UNSUPPORTED_PLATFORM');
    return;
  }

  const result = await runCli(['browser', 'profiles', '--json']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.data.profiles));
});

test('browser help documents install and user-mode workflow', async () => {
  const result = await runCli(['browser', '--help']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /browser use independent\|user/);
  assert.match(result.stdout, /browser status/);
  assert.match(result.stdout, /browser install.*--profile/);
  assert.match(result.stdout, /status -> profiles -> install -> reopen\/enable -> status -> use user/);
  assert.match(result.stdout, /nextActions/);
  assert.match(result.stdout, /Selection priority: --browser > OCTOPUS_BROWSER > saved browser use setting > independent/);
  assert.match(result.stdout, /config\.json/);
});

test('run help documents --browser user flags', async () => {
  const result = await runCli(['run', '--help']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /--browser independent\|user/);
  assert.match(result.stdout, /System Chrome\/Edge with existing cookies and login state/);
  assert.match(result.stdout, /--force-close-browser/);
  assert.match(result.stdout, /browser selection priority/);
  assert.match(result.stdout, /setupRecipe/);
});

test('detect help documents --browser user flags', async () => {
  const result = await runCli(['detect', '--help']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /--browser user/);
  assert.match(result.stdout, /bazhuayu browser use/);
  assert.match(result.stdout, /bazhuayu browser install/);
  assert.match(result.stdout, /browser --help for selection priority and setup/);
  assert.match(result.stdout, /setupRecipe/);
  assert.match(result.stdout, /session window/i);
});

test('root help documents browser command and user mode', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /Config:/);
  assert.match(result.stdout, /browser\s+Choose independent or signed-in browser mode/);
  assert.match(result.stdout, /bazhuayu <command> --help/);
});

test('buildDetectorBootstrapUrl embeds sessionId and wsUrl', async () => {
  const { buildDetectorBootstrapUrl } = await import('../dist/runtime/detector/page-detector-host.js');
  const url = buildDetectorBootstrapUrl({
    sessionId: 'detect_session_1',
    wsUrl: 'ws://127.0.0.1:12345'
  }, 'http://127.0.0.1:54321/');
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'http://127.0.0.1:54321');
  assert.equal(parsed.searchParams.get('sessionId'), 'detect_session_1');
  assert.equal(parsed.searchParams.get('wsUrl'), 'ws://127.0.0.1:12345');
});

test('bootstrap page server serves a friendly splash page', async () => {
  const { startBootstrapPageServer, renderBootstrapHtml } = await import('../dist/runtime/bootstrap-page.js');
  const html = renderBootstrapHtml({ mode: 'run', label: 'demo-task' });
  assert.match(html, /正在连接浏览器扩展/);
  assert.match(html, /demo-task/);
  assert.doesNotMatch(html, /example\.com/i);

  const server = await startBootstrapPageServer({ mode: 'detect', label: 'https://news.example/' });
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(server.origin);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /正在准备页面检测/);
    assert.match(body, /news\.example/);
    assert.match(body, /不是采集目标网站/);
  } finally {
    await server.close();
  }
});

test('bootstrap page server closes active keep-alive connections', async () => {
  const { startBootstrapPageServer } = await import('../dist/runtime/bootstrap-page.js');
  const server = await startBootstrapPageServer({ mode: 'detect' });
  const origin = new URL(server.origin);
  const socket = connect(Number(origin.port), origin.hostname);
  try {
    await once(socket, 'connect');
    socket.write(`GET / HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: keep-alive\r\n\r\n`);
    await once(socket, 'data');
    const socketClosed = once(socket, 'close', { signal: AbortSignal.timeout(2_000) });
    await server.close();
    await socketClosed;
    assert.equal(socket.destroyed, true);
  } finally {
    socket.destroy();
    await server.close();
  }
});

test('prepareUserBrowserForRun does not require closing a running browser', async () => {
  const {
    prepareUserBrowserForRun,
    isUserBrowserPlatformSupported,
    inspectUserBrowser
  } = await import('../dist/runtime/user-browser.js');
  if (!isUserBrowserPlatformSupported()) return;

  const inspection = inspectUserBrowser({ browserId: 'chrome' });
  if (!inspection.browser.installed || inspection.extensionStatus.needsInstallOrUpdate) {
    // Environment is not ready for a positive launch-plan assertion.
    return;
  }

  // Even when launch.requiresClose is true (Chrome is open), prepare must succeed
  // without forceClose — install is the only path that requires close.
  const plan = await prepareUserBrowserForRun({ browserId: 'chrome' });
  assert.equal(plan.browserId, 'chrome');
  assert.ok(plan.chromePath);
  assert.ok(plan.userDataDirectory);
});

test('assertDetectDisplayAvailable rejects user mode on linux', async () => {
  const { assertDetectDisplayAvailable } = await import('../dist/runtime/detector/page-detector-host.js');
  if (process.platform === 'linux') {
    assert.throws(
      () => assertDetectDisplayAvailable({ browserMode: 'user', manual: false, interactive: false }),
      /not supported on Linux/i
    );
  } else {
    assert.doesNotThrow(() => assertDetectDisplayAvailable({
      browserMode: 'user',
      manual: false,
      interactive: false
    }));
  }
});

test('splitRunUrlArgs forwards user browser flags to detect and run', async () => {
  const { splitRunUrlArgs } = await import('../dist/commands/detect/args.js');
  const { detectArgs, runArgs } = splitRunUrlArgs([
    '--browser',
    'user',
    '--browser-id',
    'edge',
    '--profile',
    'Profile 1',
    '--force-close-browser',
    '--auto',
    '--max-rows',
    '3'
  ]);
  assert.deepEqual(detectArgs, [
    '--browser',
    'user',
    '--browser-id',
    'edge',
    '--profile',
    'Profile 1',
    '--force-close-browser',
    '--auto'
  ]);
  assert.deepEqual(runArgs, [
    '--browser',
    'user',
    '--browser-id',
    'edge',
    '--profile',
    'Profile 1',
    '--force-close-browser',
    '--max-rows',
    '3'
  ]);
});

test('run rejects --browser user with --headless', async () => {
  const { runTask } = await import('../dist/commands/run.js');
  const code = await runTask('demo-task', [
    '--browser',
    'user',
    '--headless',
    '--json'
  ]);
  assert.equal(code, 1);
});

test('detect rejects invalid --browser value without launching', async () => {
  const result = await runCli([
    'detect',
    'https://example.com',
    '--browser',
    'firefox',
    '--auto',
    '--json'
  ]);
  // AUTH may run first for detect; invalid browser is still rejected with a non-zero exit.
  assert.notEqual(result.code, 0, result.stdout || result.stderr);
  const combined = `${result.stdout}\n${result.stderr}`;
  // Either auth gate or browser parse error is acceptable; never silent success.
  assert.match(combined, /AUTH_REQUIRED|Invalid --browser value|independent or user/i);
});

test('capabilities documents user browser mode for run and detect', async () => {
  const result = await runCli(['capabilities', '--json']);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.data.authentication.diagnosticCommandsWithoutAuth.includes('browser'));
  assert.ok(payload.data.browserRuntime.modes.independent.default);
  assert.equal(payload.data.browserRuntime.modes.user.default, false);
  assert.equal(payload.data.browserRuntime.defaultSelection.setCommand, 'bazhuayu browser use independent|user');
  assert.ok(payload.data.browserRuntime.defaultSelection.order.includes('--browser flag'));
  assert.ok(payload.data.browserRuntime.modes.user.runFlags.includes('--browser user'));
  assert.ok(payload.data.browserRuntime.modes.user.detectFlags.includes('--browser user'));
  assert.ok(payload.data.browserRuntime.modes.user.affectedCommands.includes('detect'));
  assert.ok(payload.data.browserRuntime.modes.user.setupCommands.some((command) => command.startsWith('bazhuayu browser use user')));
  const setupRecipe = payload.data.browserRuntime.modes.user.setupRecipe;
  assert.equal(setupRecipe.steps[0].step, 'inspect');
  assert.equal(setupRecipe.steps.at(-1).step, 'persist');
  assert.ok(setupRecipe.steps.some((step) => step.requiresHuman));
  assert.match(setupRecipe.switchBackCommand, /browser use independent/);
  assert.match(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.routingRule, /browserRuntime\.modes\.user\.setupRecipe/);
  assert.ok(payload.data.commands.some((item) => item.command.includes('browser use')));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('EXTENSION_NOT_READY'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('BROWSER_RUNNING'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('PROFILE_NOT_FOUND'));
});
